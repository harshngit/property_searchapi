-- =====================================================================
-- Migration: 035_due_diligence_disputes.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 5 sub-systems:
--              - Document Repository (Module 20): documents linked to
--                properties and deals, the contract document types, role
--                visibility (owner / broker / buyer / admin) and AI
--                classification + risk flags per document;
--              - Due Diligence Engine (Module 21): per-listing checklist
--                with missing-document detection, title chain, encumbrance,
--                possession risk and NRI considerations;
--              - Dispute Resolution System: cases, evidence, an append-only
--                timeline and a 48 h admin SLA;
--              - Sec. 9.6 client / lead conflict resolution.
-- DB       : PostgreSQL
-- =====================================================================

ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'sale_deed';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'agreement_to_sell';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'id_proof';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'tax_receipt';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'encumbrance_certificate';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'title_document';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'allotment_letter';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'occupancy_certificate';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'completion_certificate';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'approved_plan';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'mutation_record';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'society_noc';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'bank_noc';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'power_of_attorney';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'possession_letter';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'rent_agreement';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'utility_bill';
ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'rera_certificate';

ALTER TABLE documents
    ADD COLUMN property_id     UUID REFERENCES properties(id) ON DELETE CASCADE,
    ADD COLUMN visible_to      JSONB NOT NULL DEFAULT '["owner", "broker", "admin"]'::jsonb,
    ADD COLUMN ai_type         VARCHAR(40),
    ADD COLUMN ai_confidence   SMALLINT,
    ADD COLUMN ai_summary      TEXT,
    ADD COLUMN ai_extracted    JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN ai_flags        JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN ai_method       VARCHAR(12),
    ADD COLUMN ai_checked_at   TIMESTAMPTZ;

CREATE INDEX idx_documents_property_id ON documents(property_id);

-- Module 21 due-diligence snapshot per listing (recomputed on every
-- document change; staff can add title-chain links / encumbrance notes).
CREATE TABLE property_due_diligence (
    property_id         UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
    status              VARCHAR(12) NOT NULL DEFAULT 'not_started'
                        CHECK (status IN ('not_started', 'in_progress', 'complete', 'issues')),
    checklist           JSONB NOT NULL DEFAULT '[]'::jsonb,
    missing             JSONB NOT NULL DEFAULT '[]'::jsonb,
    title_chain         JSONB NOT NULL DEFAULT '[]'::jsonb,
    title_years         NUMERIC(5, 1),
    title_gaps          JSONB NOT NULL DEFAULT '[]'::jsonb,
    encumbrance         JSONB NOT NULL DEFAULT '{}'::jsonb,
    possession_risk     VARCHAR(10),
    possession_reasons  JSONB NOT NULL DEFAULT '[]'::jsonb,
    risk_flags          JSONB NOT NULL DEFAULT '[]'::jsonb,
    nri                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    manual_title_links  JSONB NOT NULL DEFAULT '[]'::jsonb,
    staff_notes         TEXT,
    reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMPTZ,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dispute Resolution System.
CREATE SEQUENCE dispute_number_seq;

CREATE TABLE disputes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_number         VARCHAR(20) NOT NULL UNIQUE,
    type                VARCHAR(30) NOT NULL CHECK (type IN (
                          'broker_dispute', 'duplicate_listing', 'fake_claim', 'institutional_data_access',
                          'lead_conflict', 'commission', 'review', 'other')),
    title               VARCHAR(200) NOT NULL,
    description         TEXT NOT NULL,
    raised_by           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    against_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    property_id         UUID REFERENCES properties(id) ON DELETE SET NULL,
    deal_id             UUID REFERENCES deals(id) ON DELETE SET NULL,
    lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
    lead_conflict_id    UUID,
    status              VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'under_review', 'awaiting_info', 'resolved', 'dismissed', 'closed')),
    priority            VARCHAR(10) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    assigned_to         UUID REFERENCES users(id) ON DELETE SET NULL,
    sla_due_at          TIMESTAMPTZ NOT NULL,
    escalated_at        TIMESTAMPTZ,
    resolution          TEXT,
    outcome             JSONB NOT NULL DEFAULT '{}'::jsonb,
    in_favour_of        UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_disputes_status ON disputes(status, sla_due_at);
CREATE INDEX idx_disputes_against ON disputes(against_user_id, status);
CREATE INDEX idx_disputes_raised_by ON disputes(raised_by);

CREATE TRIGGER set_updated_at_disputes
BEFORE UPDATE ON disputes
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Append-only case timeline (legal-grade: no edits, no deletes).
CREATE TABLE dispute_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id      UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
    actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    kind            VARCHAR(20) NOT NULL CHECK (kind IN ('created', 'comment', 'evidence', 'status', 'assignment', 'resolution', 'system')),
    body            TEXT,
    attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
    visibility      VARCHAR(10) NOT NULL DEFAULT 'parties' CHECK (visibility IN ('parties', 'internal')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dispute_events_dispute ON dispute_events(dispute_id, created_at);

CREATE OR REPLACE FUNCTION trigger_reject_dispute_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'dispute_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dispute_events_append_only
BEFORE UPDATE OR DELETE ON dispute_events
FOR EACH ROW EXECUTE FUNCTION trigger_reject_dispute_event_mutation();

-- Sec. 9.6 - the same buyer in two brokers' CRMs.
CREATE TABLE lead_conflicts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_key           VARCHAR(20) NOT NULL,
    first_lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    later_lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    first_broker_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    later_broker_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'routing_requested', 'resolved', 'escalated')),
    resolution          VARCHAR(30) CHECK (resolution IS NULL OR resolution IN ('mandate_routing', 'different_property', 'transferred', 'admin_decided', 'routing_declined')),
    resolution_detail   JSONB NOT NULL DEFAULT '{}'::jsonb,
    dispute_id          UUID REFERENCES disputes(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_lead_conflict UNIQUE (first_lead_id, later_lead_id)
);

CREATE INDEX idx_lead_conflicts_brokers ON lead_conflicts(later_broker_id, first_broker_id, status);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('dd.checklists',
   '{"sale": [
       {"type": "title_document", "label": "Title document / previous sale deed", "required": true},
       {"type": "sale_deed", "label": "Current owner''s sale deed / conveyance", "required": true},
       {"type": "encumbrance_certificate", "label": "Encumbrance certificate (13-30 years)", "required": true},
       {"type": "tax_receipt", "label": "Latest property tax receipt", "required": true},
       {"type": "id_proof", "label": "Owner ID proof (PAN / Aadhaar)", "required": true},
       {"type": "mutation_record", "label": "Mutation / khata record", "required": false},
       {"type": "approved_plan", "label": "Sanctioned building plan", "required": false},
       {"type": "society_noc", "label": "Society / RWA NOC", "required": false},
       {"type": "utility_bill", "label": "Recent utility bill", "required": false}],
     "sale_under_construction": [
       {"type": "allotment_letter", "label": "Builder allotment letter", "required": true},
       {"type": "agreement_to_sell", "label": "Builder-buyer agreement", "required": true},
       {"type": "rera_certificate", "label": "RERA registration of the project", "required": true},
       {"type": "approved_plan", "label": "Sanctioned plan", "required": true},
       {"type": "payment_receipt", "label": "Payment receipts to date", "required": true},
       {"type": "id_proof", "label": "Allottee ID proof", "required": true}],
     "sale_ready_extra": [
       {"type": "occupancy_certificate", "label": "Occupancy certificate", "required": true},
       {"type": "completion_certificate", "label": "Completion certificate", "required": false}],
     "plot_extra": [
       {"type": "mutation_record", "label": "Mutation / land records", "required": true}],
     "loan_extra": [
       {"type": "bank_noc", "label": "Bank NOC / loan closure letter", "required": true}],
     "rent": [
       {"type": "id_proof", "label": "Owner ID proof", "required": true},
       {"type": "tax_receipt", "label": "Latest property tax receipt", "required": true},
       {"type": "rent_agreement", "label": "Draft rent / lease agreement", "required": false},
       {"type": "society_noc", "label": "Society NOC for letting", "required": false}],
     "nri_extra": [
       {"type": "power_of_attorney", "label": "Registered + attested power of attorney (if owner abroad)", "required": false}]}',
   'due_diligence', 'Module 21 document checklists by transaction; required items missing are flagged automatically.'),
  ('dd.title_chain_years', '30', 'due_diligence',
   'Years of title history a complete chain should cover (Legally Verified needs at least 3).'),
  ('dd.risk_keywords',
   '{"encumbrance": ["mortgage", "hypothecation", "charge created", "lien", "loan outstanding", "equitable mortgage"],
     "litigation": ["lis pendens", "suit no", "o.s. no", "writ petition", "stay order", "injunction", "court of", "decree", "attachment"],
     "compliance": ["unauthorised", "unauthorized", "demolition", "encroachment", "notice under section", "sealed"],
     "possession": ["tenant", "occupied by", "possession not", "symbolic possession", "vacate"]}',
   'due_diligence', 'Phrases that raise document risk flags (rule-based layer; the AI layer runs on top).'),
  ('dd.ai_enabled', 'true', 'due_diligence',
   'AI document classification + risk flagging (needs ANTHROPIC_API_KEY; rule-based classification always runs).'),
  ('disputes.sla_hours', '48', 'disputes',
   'Sec. 9.6 - admin resolution target for every dispute.'),
  ('lead_conflicts.lookback_days', '90', 'disputes',
   'Sec. 9.6 - a lead for the same phone within this many days in another broker''s CRM is a conflict.')
ON CONFLICT (config_key) DO NOTHING;
