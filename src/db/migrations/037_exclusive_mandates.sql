-- =====================================================================
-- Migration: 037_exclusive_mandates.sql
-- Project  : PropertySerch.com
-- Purpose  : Module 46 - Exclusive Mandate (core, build before launch):
--              - fee_consents   OTP-verified professional fee consent, one
--                               per posted listing / requirement, immutable
--                               (user, IP, timestamp, mobile last 4) - the
--                               source of the Consent Record PDF
--              - mandates       one per listing / requirement; type, locked
--                               1% fee rate, AES-256-GCM encrypted price
--                               range (never in properties / requirements),
--                               lifecycle (pending_rep_ack -> active ->
--                               expired / breached / cancelled), renewals,
--                               benefit delivery statuses
--              - mandate_events append-only log: rep acknowledgement,
--                               renewals (with the pipeline stage), breach,
--                               every decrypted price-range access
--            properties.min_acceptable_price (a plain-text seller minimum)
--            is removed - the price range lives only in mandates.
-- DB       : PostgreSQL
-- =====================================================================

ALTER TYPE otp_purpose ADD VALUE IF NOT EXISTS 'fee_consent';

-- ---------------------------------------------------------------------
-- fee_consents - Step 1 of the consent block (Screens 4 / 5). The OTP is
-- verified first; the row is then consumed by exactly one listing or
-- requirement. Rows are never updated except to record that consumption.
-- ---------------------------------------------------------------------
CREATE TABLE fee_consents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    kind                VARCHAR(15) NOT NULL CHECK (kind IN ('listing', 'requirement')),
    consent_version     VARCHAR(20) NOT NULL,
    fee_rate_percent    NUMERIC(5, 2) NOT NULL DEFAULT 1.00 CHECK (fee_rate_percent = 1.00),
    mobile_last4        VARCHAR(4),
    token_hash          VARCHAR(64) NOT NULL UNIQUE,
    token_expires_at    TIMESTAMPTZ NOT NULL,
    ip_address          VARCHAR(64),
    user_agent          VARCHAR(500),
    otp_verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fee_consents_user ON fee_consents(user_id);

-- Only the one-time consumption (used_at) may change; everything else is
-- the legal record and stays as written. Deletes are rejected.
CREATE OR REPLACE FUNCTION trigger_fee_consents_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fee_consents is immutable: DELETE is not permitted';
  END IF;
  IF OLD.used_at IS NOT NULL
     OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind OR NEW.consent_version <> OLD.consent_version
     OR NEW.fee_rate_percent <> OLD.fee_rate_percent OR NEW.otp_verified_at <> OLD.otp_verified_at
     OR NEW.token_hash <> OLD.token_hash OR NEW.ip_address IS DISTINCT FROM OLD.ip_address THEN
    RAISE EXCEPTION 'fee_consents is immutable: only a single use may be recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fee_consents_immutable
BEFORE UPDATE OR DELETE ON fee_consents
FOR EACH ROW EXECUTE FUNCTION trigger_fee_consents_immutable();

-- ---------------------------------------------------------------------
-- mandates (shared table). Price columns hold "v1:iv:tag:ciphertext"
-- AES-256-GCM strings (utils/crypto) of the INR amount - never plain.
-- ---------------------------------------------------------------------
CREATE TABLE mandates (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mandate_number              VARCHAR(30) NOT NULL UNIQUE,
    mandate_type                VARCHAR(20) NOT NULL
        CHECK (mandate_type IN ('seller_exclusive', 'buyer_exclusive', 'seller_standard', 'buyer_standard')),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    customer_id                 UUID REFERENCES customers(id) ON DELETE SET NULL,
    listing_id                  UUID REFERENCES properties(id) ON DELETE SET NULL,
    requirement_id              UUID REFERENCES requirements(id) ON DELETE SET NULL,
    fee_consent_id              UUID REFERENCES fee_consents(id) ON DELETE RESTRICT,
    professional_fee_rate_percent NUMERIC(5, 2) NOT NULL DEFAULT 1.00 CHECK (professional_fee_rate_percent = 1.00),
    gst_type                    VARCHAR(10) NOT NULL DEFAULT 'GST' CHECK (gst_type IN ('GST', 'IGST')),
    seller_min_price_enc        TEXT,
    seller_max_price_enc        TEXT,
    buyer_min_budget_enc        TEXT,
    buyer_max_budget_enc        TEXT,
    assigned_rep_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    mandate_start_date          DATE,
    mandate_end_date            DATE,
    renewal_count               SMALLINT NOT NULL DEFAULT 0,
    expiry_warnings_sent        JSONB NOT NULL DEFAULT '[]'::jsonb,
    valuation_status            VARCHAR(20) NOT NULL DEFAULT 'not_requested'
        CHECK (valuation_status IN ('not_requested', 'requested', 'in_progress', 'completed', 'report_uploaded')),
    due_diligence_status        VARCHAR(20) NOT NULL DEFAULT 'not_requested'
        CHECK (due_diligence_status IN ('not_requested', 'in_progress', 'completed', 'report_uploaded')),
    deed_writer_waiver_status   VARCHAR(20) NOT NULL DEFAULT 'not_applicable'
        CHECK (deed_writer_waiver_status IN ('not_applicable', 'active', 'utilised')),
    valuation_document_id       UUID REFERENCES documents(id) ON DELETE SET NULL,
    due_diligence_document_id   UUID REFERENCES documents(id) ON DELETE SET NULL,
    benefit_due_dates           JSONB NOT NULL DEFAULT '{}'::jsonb,
    status                      VARCHAR(20) NOT NULL DEFAULT 'pending_rep_ack'
        CHECK (status IN ('pending_rep_ack', 'active', 'expired', 'breached', 'cancelled')),
    status_reason               TEXT,
    acknowledged_at             TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_mandates_target CHECK (
        (mandate_type IN ('seller_exclusive', 'seller_standard') AND listing_id IS NOT NULL AND requirement_id IS NULL)
     OR (mandate_type IN ('buyer_exclusive', 'buyer_standard') AND requirement_id IS NOT NULL AND listing_id IS NULL)
     OR (listing_id IS NULL AND requirement_id IS NULL)),
    CONSTRAINT chk_mandates_price_fields CHECK (
        (mandate_type = 'seller_exclusive' OR (seller_min_price_enc IS NULL AND seller_max_price_enc IS NULL))
    AND (mandate_type = 'buyer_exclusive'  OR (buyer_min_budget_enc IS NULL AND buyer_max_budget_enc IS NULL)))
);

CREATE INDEX idx_mandates_listing     ON mandates(listing_id);
CREATE INDEX idx_mandates_requirement ON mandates(requirement_id);
CREATE INDEX idx_mandates_user        ON mandates(user_id);
CREATE INDEX idx_mandates_status_end  ON mandates(status, mandate_end_date);
CREATE INDEX idx_mandates_rep         ON mandates(assigned_rep_id);

CREATE TRIGGER trg_mandates_updated_at
BEFORE UPDATE ON mandates
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE SEQUENCE mandate_number_seq;

-- ---------------------------------------------------------------------
-- mandate_events - append-only (same database-level guard as audit_logs).
-- kind: created, acknowledged, activated, assigned, renewed, renewal_refused,
--       expiry_warning, expired, breached, cancelled, benefit_updated,
--       price_range_viewed, summary_downloaded, consent_downloaded
-- ---------------------------------------------------------------------
CREATE TABLE mandate_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mandate_id      UUID NOT NULL REFERENCES mandates(id) ON DELETE RESTRICT,
    kind            VARCHAR(30) NOT NULL,
    actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    pipeline_stage  VARCHAR(30),
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mandate_events_mandate ON mandate_events(mandate_id, created_at);

CREATE OR REPLACE FUNCTION trigger_reject_mandate_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'mandate_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mandate_events_append_only
BEFORE UPDATE OR DELETE ON mandate_events
FOR EACH ROW EXECUTE FUNCTION trigger_reject_mandate_event_mutation();

-- ---------------------------------------------------------------------
-- Existing posts: every listing / requirement that recorded fee consent
-- gets a mandate record so "no listing without mandate status" holds.
-- Exclusive ones start at pending_rep_ack (no price range on file - the
-- rep collects it on acknowledgement); the plain seller minimum is dropped.
-- ---------------------------------------------------------------------
INSERT INTO mandates (mandate_number, mandate_type, user_id, customer_id, listing_id, status)
SELECT 'MND-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('mandate_number_seq')::text, 5, '0'),
       CASE WHEN p.mandate_type = 'exclusive' THEN 'seller_exclusive' ELSE 'seller_standard' END,
       p.created_by, c.id, p.id,
       CASE WHEN p.mandate_type = 'exclusive' THEN 'pending_rep_ack' ELSE 'active' END
FROM properties p
LEFT JOIN customers c ON c.user_id = p.created_by
WHERE p.fee_consent_at IS NOT NULL AND p.created_by IS NOT NULL;

INSERT INTO mandates (mandate_number, mandate_type, user_id, customer_id, requirement_id, status)
SELECT 'MND-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('mandate_number_seq')::text, 5, '0'),
       CASE WHEN r.mandate_type = 'exclusive' THEN 'buyer_exclusive' ELSE 'buyer_standard' END,
       COALESCE(c.user_id, r.created_by), r.customer_id, r.id,
       CASE WHEN r.mandate_type = 'exclusive' THEN 'pending_rep_ack' ELSE 'active' END
FROM requirements r
JOIN customers c ON c.id = r.customer_id
WHERE COALESCE(c.user_id, r.created_by) IS NOT NULL;

-- Exclusive placement / Priority Buyer only while a mandate is ACTIVE.
UPDATE properties SET mandate_type = 'standard' WHERE mandate_type = 'exclusive';
UPDATE requirements SET mandate_type = 'standard' WHERE mandate_type = 'exclusive';

ALTER TABLE properties DROP COLUMN IF EXISTS min_acceptable_price;

-- ---------------------------------------------------------------------
-- Configuration (admin-editable; legal review recommended before change)
-- ---------------------------------------------------------------------
INSERT INTO app_config (config_key, value, category, description) VALUES
  ('mandate.seller_days', '180', 'mandate', 'Module 46 - Exclusive Mandate period for sellers (days).'),
  ('mandate.buyer_days', '90', 'mandate', 'Module 46 - Exclusive Mandate period for buyers (days).'),
  ('mandate.renewal_cap', '2', 'mandate', 'Consecutive renewals by the assigned RM/DM before Super Admin approval is required.'),
  ('mandate.expiry_warning_days', '[30, 7, 1]', 'mandate', 'Days before mandate end on which expiry reminders go out.'),
  ('mandate.response_sla_hours', '{"exclusive": 2, "standard": 24}', 'mandate', 'Inquiry response SLA (hours) for mandated vs standard listings and buyers.'),
  ('mandate.benefit_sla', '{"rep_initiate_hours": 24, "valuation_working_days": 10, "due_diligence_working_days": 15}', 'mandate', 'Benefit delivery SLAs.'),
  ('mandate.consent_version', '"2026-07"', 'mandate', 'Version label of the professional fee consent text accepted by users.'),
  ('mandate.consent_token_minutes', '30', 'mandate', 'Minutes a verified fee consent stays usable to submit the listing / requirement.'),
  ('mandate.fee_consent_text', '"A R Buildwel professional fee: 1% + GST/IGST of the sale / purchase price, payable in two parts - 50% + tax at Agreement to Sell execution and the remaining 50% + tax at Sale Deed execution. For rentals: one month''s gross rent + GST/IGST at agreement execution. The professional fee is the same for Exclusive Mandate and Standard engagement; Exclusive Mandate benefits are service-based."', 'mandate', 'Professional fee consent text shown before the OTP (Screens 4 / 5).')
ON CONFLICT (config_key) DO NOTHING;
