-- =====================================================================
-- Migration: 006_create_deal_document_tables.sql
-- Project  : PropertySerch.com
-- Purpose  : Deal Pipeline and Document Management module (deals,
--            deal_stage_history, site_visits, documents)
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE deal_stage AS ENUM (
    'inquiry',
    'site_visit',
    'negotiation',
    'booking',
    'documentation',
    'payment',
    'closed_won',
    'closed_lost',
    'on_hold'
);

CREATE TYPE site_visit_status AS ENUM (
    'scheduled',
    'completed',
    'cancelled',
    'no_show'
);

CREATE TYPE document_category AS ENUM (
    'kyc',
    'agreement',
    'payment_receipt',
    'noc',
    'other'
);

-- ---------------------------------------------------------------------
-- TABLE: deals
-- No created_by column by design - broker_id is the single ownership
-- field (the assigned broker manages/owns the deal).
-- ---------------------------------------------------------------------
CREATE TABLE deals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,
    lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
    customer_id         UUID NOT NULL REFERENCES customers(id),
    property_id         UUID REFERENCES properties(id) ON DELETE SET NULL,
    unit_id             UUID REFERENCES units(id) ON DELETE SET NULL,
    broker_id           UUID NOT NULL REFERENCES users(id),

    stage               deal_stage NOT NULL DEFAULT 'inquiry',
    deal_value          NUMERIC(14, 2) CHECK (deal_value IS NULL OR deal_value >= 0),
    commission_amount   NUMERIC(14, 2) CHECK (commission_amount IS NULL OR commission_amount >= 0),
    commission_percent  NUMERIC(5, 2) CHECK (commission_percent IS NULL OR commission_percent >= 0),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at           TIMESTAMPTZ
);

CREATE INDEX idx_deals_stage       ON deals(stage);
CREATE INDEX idx_deals_broker_id   ON deals(broker_id);
CREATE INDEX idx_deals_tenant_id   ON deals(tenant_id);
CREATE INDEX idx_deals_customer_id ON deals(customer_id);

CREATE TRIGGER set_updated_at_deals
BEFORE UPDATE ON deals
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: deal_stage_history
-- Append-only audit trail. from_stage is NULL for the entry logged at
-- deal creation. Written exclusively by the service layer's single
-- stage-change function, in the same transaction as the stage update.
-- ---------------------------------------------------------------------
CREATE TABLE deal_stage_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    from_stage      deal_stage,
    to_stage        deal_stage NOT NULL,
    changed_by      UUID REFERENCES users(id),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deal_stage_history_deal_id ON deal_stage_history(deal_id);

-- ---------------------------------------------------------------------
-- TABLE: site_visits
-- ---------------------------------------------------------------------
CREATE TABLE site_visits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id             UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    scheduled_at        TIMESTAMPTZ NOT NULL,
    actual_visit_at     TIMESTAMPTZ,
    status              site_visit_status NOT NULL DEFAULT 'scheduled',
    notes               TEXT,
    created_by          UUID REFERENCES users(id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_site_visits_deal_id ON site_visits(deal_id);

CREATE TRIGGER set_updated_at_site_visits
BEFORE UPDATE ON site_visits
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: documents
-- General-purpose, deal-aware document store with a review workflow.
-- Distinct from the simpler customer_documents table added in
-- 004_create_lead_customer_tables.sql (which stays as-is for the
-- Customer 360 module) - this one adds tenant scoping, file_name, and
-- reviewer bookkeeping. Reuses the document_status enum from 004.
-- ---------------------------------------------------------------------
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
    customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
    deal_id         UUID REFERENCES deals(id) ON DELETE CASCADE,

    document_type   document_category NOT NULL DEFAULT 'other',
    document_url    VARCHAR(500) NOT NULL,
    file_name       VARCHAR(255),
    uploaded_by     UUID NOT NULL REFERENCES users(id),

    status          document_status NOT NULL DEFAULT 'pending',
    reviewed_by     UUID REFERENCES users(id),
    review_notes    TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_deal_id     ON documents(deal_id);
CREATE INDEX idx_documents_customer_id ON documents(customer_id);
CREATE INDEX idx_documents_status      ON documents(status);

CREATE TRIGGER set_updated_at_documents
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
