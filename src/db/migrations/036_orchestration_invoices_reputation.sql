-- =====================================================================
-- Migration: 036_orchestration_invoices_reputation.sql
-- Project  : PropertySerch.com
-- Purpose  : Module 40 Transaction Orchestration - stage requirements
--            (dependency enforcement), auto-advance, SLA per stage with
--            delay alerts, deal health score; professional-fee invoices
--            (Instalment 1 at ATS execution, Instalment 2 at Sale Deed
--            execution, single invoice on lease execution) with GST / IGST,
--            net-7 due dates and overdue alerts.
--            Module 44 Reputation Graph - broker network edges (co-broking,
--            routing, shares, closed deals together, vouches) and a bounded
--            network adjustment to the trust score.
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE deals
    ADD COLUMN stage_entered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN sla_alerted_stage         VARCHAR(20),
    ADD COLUMN health_score              SMALLINT,
    ADD COLUMN health_band               VARCHAR(10) CHECK (health_band IS NULL OR health_band IN ('healthy', 'at_risk', 'critical')),
    ADD COLUMN health_factors            JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN health_computed_at        TIMESTAMPTZ,
    ADD COLUMN ats_execution_date        DATE,
    ADD COLUMN sale_deed_execution_date  DATE,
    ADD COLUMN lease_execution_date      DATE,
    ADD COLUMN instalment_1_invoice_id   UUID,
    ADD COLUMN instalment_2_invoice_id   UUID,
    ADD COLUMN lease_invoice_id          UUID;

-- Existing deals: stage timer starts at their last stage change.
UPDATE deals d SET stage_entered_at = COALESCE(
  (SELECT MAX(h.created_at) FROM deal_stage_history h WHERE h.deal_id = d.id), d.created_at);

CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number      VARCHAR(30) NOT NULL UNIQUE,
    deal_id             UUID NOT NULL REFERENCES deals(id) ON DELETE RESTRICT,
    kind                VARCHAR(15) NOT NULL CHECK (kind IN ('instalment_1', 'instalment_2', 'lease')),
    party               VARCHAR(10) NOT NULL CHECK (party IN ('buyer', 'seller', 'tenant', 'landlord')),
    liable_customer_id  UUID REFERENCES customers(id) ON DELETE SET NULL,
    liable_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    liable_name         VARCHAR(150),
    gross_value         NUMERIC(16, 2) NOT NULL,
    fee_rate_percent    NUMERIC(5, 2) NOT NULL CHECK (fee_rate_percent >= 1.00),
    instalment_percent  NUMERIC(5, 2) NOT NULL,
    fee_amount          NUMERIC(14, 2) NOT NULL,
    gst_type            VARCHAR(10) NOT NULL CHECK (gst_type IN ('cgst_sgst', 'igst')),
    cgst_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,
    sgst_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,
    igst_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total_amount        NUMERIC(14, 2) NOT NULL,
    gstin               VARCHAR(20) NOT NULL,
    note                TEXT,
    trigger_date        DATE NOT NULL,
    issue_date          DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date            DATE NOT NULL,
    status              VARCHAR(12) NOT NULL DEFAULT 'invoiced' CHECK (status IN ('invoiced', 'paid', 'overdue', 'waived')),
    paid_at             TIMESTAMPTZ,
    payment_reference   VARCHAR(120),
    recorded_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    overdue_alerted_at  TIMESTAMPTZ,
    sent_channels       JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_invoice_deal_kind_party UNIQUE (deal_id, kind, party)
);

CREATE INDEX idx_invoices_status ON invoices(status, due_date);

-- Orchestration log (append-only): auto-advances, blocks, overrides, SLA alerts, invoices.
CREATE TABLE orchestration_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id     UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('auto_advance', 'blocked', 'override', 'sla_alert', 'invoice', 'invoice_overdue', 'milestone')),
    from_stage  VARCHAR(20),
    to_stage    VARCHAR(20),
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orchestration_events_deal ON orchestration_events(deal_id, created_at);

CREATE OR REPLACE FUNCTION trigger_reject_orchestration_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'orchestration_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orchestration_events_append_only
BEFORE UPDATE OR DELETE ON orchestration_events
FOR EACH ROW EXECUTE FUNCTION trigger_reject_orchestration_event_mutation();

-- Module 44 - explicit broker-to-broker vouches.
CREATE TABLE broker_vouches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vouchee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note        TEXT,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_no_self_vouch CHECK (voucher_id <> vouchee_id)
);

CREATE UNIQUE INDEX uq_broker_vouch_live ON broker_vouches(voucher_id, vouchee_id) WHERE revoked_at IS NULL;

CREATE TABLE reputation_scores (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    network_score   NUMERIC(5, 2),
    confidence      NUMERIC(4, 3) NOT NULL DEFAULT 0,
    adjustment      NUMERIC(5, 2) NOT NULL DEFAULT 0,
    neighbours      INTEGER NOT NULL DEFAULT 0,
    weighted_degree NUMERIC(8, 2) NOT NULL DEFAULT 0,
    excluded        JSONB NOT NULL DEFAULT '[]'::jsonb,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_config (config_key, value, category, description, is_statutory) VALUES
  ('orchestration.stage_sla_days', '{"inquiry": 2, "site_visit": 5, "negotiation": 7, "booking": 5, "documentation": 15, "payment": 30}', 'orchestration',
   'Module 40 - expected days in each deal stage; beyond it the broker and admins get a delay alert.', false),
  ('orchestration.auto_advance', 'true', 'orchestration',
   'Module 40 - move a deal to the next stage automatically as soon as that stage''s requirements are met.', false),
  ('orchestration.require_invoices_paid_to_close', 'true', 'orchestration',
   'Deal not marked fully closed until both professional-fee instalments (or the lease invoice) are paid.', false),
  ('invoice.fee_rate_percent', '1.00', 'invoice',
   'Professional fee rate (percent of gross transaction value). Locked at 1.00 minimum - invoices below 1% are refused.', true),
  ('invoice.instalment_split', '{"instalment_1": 50, "instalment_2": 50}', 'invoice',
   'Share of the professional fee billed at ATS execution (Instalment 1) and at Sale Deed execution (Instalment 2).', false),
  ('invoice.gst', '{"cgst": 9, "sgst": 9, "igst": 18}', 'invoice',
   'Statutory GST on the professional fee: CGST + SGST for residents, IGST for NRI / OCI.', true),
  ('invoice.gstin', '"07DERPR1574G2ZY"', 'invoice',
   'A R Buildwel GSTIN printed on every invoice.', true),
  ('invoice.due_days', '7', 'invoice',
   'Payment due N days from invoice date; overdue alert on day N+1.', false),
  ('invoice.parties', '["buyer"]', 'invoice',
   'Who is invoiced on a sale: buyer and / or seller (a seller invoice is raised only when the seller is a platform customer).', false),
  ('invoice.sale_deed_note', '"Execution of the Sale Deed and its registration at the Sub-Registrar Office are one and the same act. All stamp duty, registration charges, and related expenses are borne exclusively by the purchaser."', 'invoice',
   'Note printed on Instalment 2 invoices.', false),
  ('reputation.max_adjustment', '5', 'reputation',
   'Module 44 - most points the broker network can add to / take off a trust score.', false),
  ('reputation.edge_weights', '{"closed_deal": 3, "co_listing": 1, "routing": 1, "share": 0.5, "vouch": 1}', 'reputation',
   'Interaction weights - completed deals together count far more than volume of light interactions.', false),
  ('reputation.min_tenure_days', '30', 'reputation',
   'Accounts younger than this do not lend network trust (anti-gaming).', false),
  ('reputation.vouch_limit', '10', 'reputation',
   'Live vouches one broker can give.', false),
  ('reputation.vouch_min_trust', '60', 'reputation',
   'Minimum trust score to vouch for another broker.', false)
ON CONFLICT (config_key) DO NOTHING;
