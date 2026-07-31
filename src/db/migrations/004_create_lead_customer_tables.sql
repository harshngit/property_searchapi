-- =====================================================================
-- Migration: 004_create_lead_customer_tables.sql
-- Project  : PropertySerch.com
-- Purpose  : Lead Management and Customer 360 module (leads, lead_notes,
--            lead_activity_log, customers, customer_preferences,
--            customer_documents)
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE lead_source AS ENUM (
    'website',
    'whatsapp',
    'manual',
    'campaign'
);

CREATE TYPE lead_status AS ENUM (
    'new',
    'contacted',
    'qualified',
    'hot',
    'warm',
    'cold',
    'won',
    'lost'
);

CREATE TYPE document_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);

-- ---------------------------------------------------------------------
-- TABLE: customers
-- CRM-style contact record. May optionally link to a platform `users`
-- account (user_id), but a customer record can also exist standalone
-- (e.g. captured from a public inquiry before any account exists).
-- ---------------------------------------------------------------------
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
    created_by      UUID REFERENCES users(id),

    full_name       VARCHAR(150) NOT NULL,
    email           VARCHAR(150),
    mobile          VARCHAR(20),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_customers_email_or_mobile CHECK (email IS NOT NULL OR mobile IS NOT NULL)
);

CREATE INDEX idx_customers_tenant_id ON customers(tenant_id);
CREATE INDEX idx_customers_user_id   ON customers(user_id);
CREATE INDEX idx_customers_email     ON customers(email);
CREATE INDEX idx_customers_mobile    ON customers(mobile);

CREATE TRIGGER set_updated_at_customers
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: customer_preferences
-- One row per customer (search/budget preferences captured by sales staff)
-- ---------------------------------------------------------------------
CREATE TABLE customer_preferences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,

    budget_min          NUMERIC(14, 2) CHECK (budget_min IS NULL OR budget_min >= 0),
    budget_max          NUMERIC(14, 2) CHECK (budget_max IS NULL OR budget_max >= 0),
    preferred_locations JSONB NOT NULL DEFAULT '[]',
    property_type       property_type,
    transaction_type    transaction_type,
    bedrooms            SMALLINT CHECK (bedrooms IS NULL OR bedrooms >= 0),
    notes               TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at_customer_preferences
BEFORE UPDATE ON customer_preferences
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: customer_documents
-- deal_id is left as a plain UUID (no FK) - the Deal Pipeline module,
-- which will own the `deals` table, has not been built yet.
-- ---------------------------------------------------------------------
CREATE TABLE customer_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    deal_id         UUID,

    document_url    VARCHAR(500) NOT NULL,
    document_type   VARCHAR(100),
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    status          document_status NOT NULL DEFAULT 'pending',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_documents_customer_id ON customer_documents(customer_id);
CREATE INDEX idx_customer_documents_status      ON customer_documents(status);

-- ---------------------------------------------------------------------
-- TABLE: leads
-- ---------------------------------------------------------------------
CREATE TABLE leads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
    created_by      UUID REFERENCES users(id),

    source          lead_source NOT NULL DEFAULT 'manual',
    property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    assigned_to     UUID REFERENCES users(id),
    status          lead_status NOT NULL DEFAULT 'new',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_status      ON leads(status);
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_tenant_id   ON leads(tenant_id);
CREATE INDEX idx_leads_customer_id ON leads(customer_id);
CREATE INDEX idx_leads_property_id ON leads(property_id);
CREATE INDEX idx_leads_source      ON leads(source);
CREATE INDEX idx_leads_created_at  ON leads(created_at);

CREATE TRIGGER set_updated_at_leads
BEFORE UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: lead_notes
-- ---------------------------------------------------------------------
CREATE TABLE lead_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    note            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_notes_lead_id ON lead_notes(lead_id);

-- ---------------------------------------------------------------------
-- TABLE: lead_activity_log
-- Append-only audit trail. Rows are written exclusively by the service
-- layer (never left to controllers) whenever a lead is created, its
-- status changes, or it is (re)assigned.
-- ---------------------------------------------------------------------
CREATE TABLE lead_activity_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id),
    action          VARCHAR(100) NOT NULL,
    details         JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_activity_log_lead_id ON lead_activity_log(lead_id);
