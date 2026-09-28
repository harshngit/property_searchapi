-- =====================================================================
-- Migration: 023_customer_portal.sql
-- Project  : PropertySerch.com
-- Purpose  : Customer portal - the website "Lite Dashboard" for buyers,
--            tenants, sellers and owners (Annexure A sec. 13.1 / 13.2A,
--            Screens 2-6 and 12, sec. 33.1 / 33.1A).
--              - portal roles + onboarding on the customer record
--              - permanent referral code per user + immutable referral tree
--              - requirements (Post Requirement) with Hot/Warm/Cold tag
--              - saved searches with match alerts
--              - self-posted listings: fee consent + mandate type, renewal
--              - rentals: leases, monthly rent tracker (record-only - rent
--                is paid directly between the parties, off-platform),
--                maintenance requests
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- Portal roles. One login (role `customer`) can act as any mix of buyer,
-- tenant, seller and owner; the dashboard shows the sections for each.
-- ---------------------------------------------------------------------
ALTER TABLE customers
    ADD COLUMN portal_roles VARCHAR(20)[] NOT NULL DEFAULT '{}',
    ADD COLUMN onboarded_at TIMESTAMPTZ,
    ADD CONSTRAINT chk_customers_portal_roles
        CHECK (portal_roles <@ ARRAY['buyer', 'tenant', 'seller', 'owner']::VARCHAR(20)[]);

ALTER TABLE customer_preferences
    ADD COLUMN urgency VARCHAR(20)
        CHECK (urgency IS NULL OR urgency IN ('immediate', '30_days', 'flexible'));

-- ---------------------------------------------------------------------
-- Referral codes (sec. 33.1): [CATEGORY:2]-[BODY:5], uppercase, body from
-- A-Z / 2-9 without O, 0, I, 1, L. Permanent - never changes once issued.
-- ---------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN referral_code VARCHAR(8) UNIQUE
        CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z]{2}-[A-HJKMNP-Z2-9]{5}$');

CREATE OR REPLACE FUNCTION trigger_referral_code_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.referral_code IS NOT NULL AND NEW.referral_code IS DISTINCT FROM OLD.referral_code THEN
    RAISE EXCEPTION 'referral_code is permanent and cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_referral_code_immutable
BEFORE UPDATE OF referral_code ON users
FOR EACH ROW EXECUTE FUNCTION trigger_referral_code_immutable();

-- Who referred whom (sec. 33.1A). First touch only (one row per referred
-- user), append-only. referrer_id NULL + code OG-00001 = organic / direct.
-- No commission logic reads this in Phase 1.
CREATE TABLE referral_tree (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id     UUID REFERENCES users(id) ON DELETE RESTRICT,
    referred_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    referral_code   VARCHAR(8) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_referral_not_self CHECK (referrer_id IS NULL OR referrer_id <> referred_id)
);

CREATE INDEX idx_referral_tree_referrer ON referral_tree(referrer_id);

CREATE OR REPLACE FUNCTION trigger_reject_referral_tree_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'referral_tree is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER referral_tree_append_only
BEFORE UPDATE OR DELETE ON referral_tree
FOR EACH ROW EXECUTE FUNCTION trigger_reject_referral_tree_mutation();

-- ---------------------------------------------------------------------
-- Requirements (Screen 5 - Post Requirement)
-- ---------------------------------------------------------------------
CREATE TYPE requirement_urgency AS ENUM ('immediate', '30_days', 'flexible');
CREATE TYPE requirement_temperature AS ENUM ('hot', 'warm', 'cold');
CREATE TYPE requirement_status AS ENUM ('active', 'paused', 'fulfilled', 'closed');

CREATE TABLE requirements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    purpose             VARCHAR(10) NOT NULL CHECK (purpose IN ('buy', 'rent')),
    property_type       property_type,
    city                VARCHAR(100) NOT NULL,
    localities          JSONB NOT NULL DEFAULT '[]'::jsonb,
    budget_min          NUMERIC(15, 2),
    budget_max          NUMERIC(15, 2),
    area_min_sqft       NUMERIC(10, 2),
    area_max_sqft       NUMERIC(10, 2),
    bedrooms            SMALLINT,
    urgency             requirement_urgency NOT NULL DEFAULT 'flexible',
    temperature         requirement_temperature NOT NULL DEFAULT 'cold',
    status              requirement_status NOT NULL DEFAULT 'active',
    notes               TEXT,
    mandate_type        VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (mandate_type IN ('standard', 'exclusive')),
    fee_consent_at      TIMESTAMPTZ NOT NULL,
    lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_requirements_budget CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)
);

CREATE INDEX idx_requirements_customer ON requirements(customer_id);
CREATE INDEX idx_requirements_active   ON requirements(status, city);

CREATE TRIGGER trg_requirements_updated_at
BEFORE UPDATE ON requirements
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- Saved searches (buyer / tenant dashboard) - alerts when a new listing
-- matching the filters goes live.
-- ---------------------------------------------------------------------
CREATE TABLE saved_searches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name                VARCHAR(120) NOT NULL,
    filters             JSONB NOT NULL DEFAULT '{}'::jsonb,
    alerts_enabled      BOOLEAN NOT NULL DEFAULT true,
    last_alerted_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_saved_searches_customer ON saved_searches(customer_id);

-- ---------------------------------------------------------------------
-- Self-posted listings (Screen 4): professional fee consent + mandate type
-- are required before a listing is accepted (sec. 13 mandate rules), and
-- a listing stays live for `listing_validity_days` from approval / renewal.
-- ---------------------------------------------------------------------
ALTER TABLE properties
    ADD COLUMN fee_consent_at     TIMESTAMPTZ,
    ADD COLUMN mandate_type       VARCHAR(20) CHECK (mandate_type IS NULL OR mandate_type IN ('standard', 'exclusive')),
    ADD COLUMN listing_renewed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Rentals: owner / landlord <-> tenant
-- ---------------------------------------------------------------------
CREATE TYPE lease_status AS ENUM ('active', 'notice', 'ended');

CREATE TABLE leases (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id          UUID REFERENCES properties(id) ON DELETE SET NULL,
    property_label       VARCHAR(255) NOT NULL,
    owner_customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    tenant_customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    monthly_rent         NUMERIC(12, 2) NOT NULL CHECK (monthly_rent > 0),
    security_deposit     NUMERIC(12, 2) CHECK (security_deposit IS NULL OR security_deposit >= 0),
    rent_due_day         SMALLINT NOT NULL DEFAULT 5 CHECK (rent_due_day BETWEEN 1 AND 28),
    start_date           DATE NOT NULL,
    end_date             DATE,
    status               lease_status NOT NULL DEFAULT 'active',
    tenant_confirmed_at  TIMESTAMPTZ,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_leases_parties CHECK (owner_customer_id <> tenant_customer_id),
    CONSTRAINT chk_leases_dates CHECK (end_date IS NULL OR end_date > start_date)
);

CREATE INDEX idx_leases_owner  ON leases(owner_customer_id);
CREATE INDEX idx_leases_tenant ON leases(tenant_customer_id);

CREATE TRIGGER trg_leases_updated_at
BEFORE UPDATE ON leases
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- One row per lease per month. The tenant reports a payment (UPI / bank
-- reference), the owner confirms it. The platform never holds the money.
CREATE TYPE rent_payment_status AS ENUM ('due', 'reported', 'confirmed', 'disputed');

CREATE TABLE rent_payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id        UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    period_month    DATE NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
    amount          NUMERIC(12, 2) NOT NULL,
    status          rent_payment_status NOT NULL DEFAULT 'due',
    paid_on         DATE,
    payment_mode    VARCHAR(30),
    reference       VARCHAR(100),
    note            TEXT,
    reported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    reported_at     TIMESTAMPTZ,
    confirmed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_rent_payments_period UNIQUE (lease_id, period_month)
);

CREATE TRIGGER trg_rent_payments_updated_at
BEFORE UPDATE ON rent_payments
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TYPE maintenance_status AS ENUM ('open', 'in_progress', 'resolved', 'closed');

CREATE TABLE maintenance_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id        UUID NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    raised_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    category        VARCHAR(40) NOT NULL DEFAULT 'other',
    title           VARCHAR(200) NOT NULL,
    description     TEXT,
    priority        VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status          maintenance_status NOT NULL DEFAULT 'open',
    owner_note      TEXT,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_maintenance_requests_lease ON maintenance_requests(lease_id);

CREATE TRIGGER trg_maintenance_requests_updated_at
BEFORE UPDATE ON maintenance_requests
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- Admin-configurable portal settings (everything configurable, sec. 31)
-- ---------------------------------------------------------------------
INSERT INTO app_config (config_key, value, category, description) VALUES
  ('requirement_temperature_by_urgency', '{"immediate": "hot", "30_days": "warm", "flexible": "cold"}', 'portal',
   'Auto Hot/Warm/Cold tag for a posted requirement, by urgency (Screen 5).'),
  ('hot_match_threshold', '80', 'portal',
   'Match score (0-100) at or above which a match is tagged Hot Match (Screen 6).'),
  ('listing_validity_days', '90', 'portal',
   'Days a self-posted listing stays live after approval or renewal before it needs renewing.'),
  ('listing_renewal_reminder_days', '7', 'portal',
   'Days before expiry that a listing shows the renewal reminder.'),
  ('full_crm_deal_threshold', '5', 'portal',
   'Closed deals after which a user moves from the Lite Dashboard to Full CRM (sec. 13.2A).'),
  ('full_crm_referral_threshold', '15', 'portal',
   'Referred sign-ups after which a user moves from the Lite Dashboard to Full CRM (sec. 13.2A).'),
  ('referral_share_message', '"Join PropertySerch.com - India''s Real Estate Transaction Operating System - using my code [CODE]."', 'portal',
   'Pre-drafted WhatsApp share message for a user''s referral code (sec. 33.1A). [CODE] is replaced with the code.')
ON CONFLICT (config_key) DO NOTHING;
