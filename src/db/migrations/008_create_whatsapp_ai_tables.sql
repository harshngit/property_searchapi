-- =====================================================================
-- Migration: 008_create_whatsapp_ai_tables.sql
-- Project  : PropertySerch.com
-- Purpose  : WhatsApp Integration, AI Lead Qualification, and Property
--            Matching module (whatsapp_conversations, ai_lead_insights,
--            property_match_results)
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE whatsapp_direction AS ENUM (
    'inbound',
    'outbound'
);

CREATE TYPE whatsapp_message_type AS ENUM (
    'template',
    'text',
    'media'
);

CREATE TYPE whatsapp_status AS ENUM (
    'sent',
    'delivered',
    'read',
    'failed'
);

CREATE TYPE ai_score_level AS ENUM (
    'hot',
    'warm',
    'cold'
);

-- ---------------------------------------------------------------------
-- TABLE: whatsapp_conversations
-- One row per inbound/outbound WhatsApp message. lead_id/customer_id are
-- nullable (not marked NOT NULL in the spec) because an inbound webhook
-- message can arrive from a phone number that doesn't match any known
-- lead/customer yet - it's still logged, just unlinked.
-- ---------------------------------------------------------------------
CREATE TABLE whatsapp_conversations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,
    lead_id             UUID REFERENCES leads(id) ON DELETE CASCADE,
    customer_id         UUID REFERENCES customers(id) ON DELETE CASCADE,

    phone_number        VARCHAR(20) NOT NULL,
    direction            whatsapp_direction NOT NULL,
    message_type         whatsapp_message_type NOT NULL DEFAULT 'text',
    template_name        VARCHAR(100),
    message_body          TEXT,
    provider_message_id   VARCHAR(150),
    status                whatsapp_status NOT NULL DEFAULT 'sent',

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_whatsapp_conversations_lead_id            ON whatsapp_conversations(lead_id);
CREATE INDEX idx_whatsapp_conversations_tenant_id          ON whatsapp_conversations(tenant_id);
CREATE INDEX idx_whatsapp_conversations_customer_id        ON whatsapp_conversations(customer_id);
CREATE INDEX idx_whatsapp_conversations_phone_number       ON whatsapp_conversations(phone_number);
CREATE INDEX idx_whatsapp_conversations_provider_message_id ON whatsapp_conversations(provider_message_id);

-- ---------------------------------------------------------------------
-- TABLE: ai_lead_insights
-- Append-only, like lead_activity_log/deal_stage_history elsewhere in this
-- schema: every extraction/scoring run inserts a new row rather than
-- upserting, so history is preserved. "Latest" is read via
-- ORDER BY created_at DESC LIMIT 1.
-- ---------------------------------------------------------------------
CREATE TABLE ai_lead_insights (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id               UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

    extracted_budget_min  NUMERIC(14, 2),
    extracted_budget_max  NUMERIC(14, 2),
    extracted_location    VARCHAR(150),
    extracted_property_type VARCHAR(50),
    extracted_intent      VARCHAR(100),
    extracted_timeline    VARCHAR(100),
    summary               TEXT,
    score                 ai_score_level,
    confidence            NUMERIC(5, 2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    raw_response           JSONB NOT NULL DEFAULT '{}',

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_lead_insights_lead_id ON ai_lead_insights(lead_id);

-- ---------------------------------------------------------------------
-- TABLE: property_match_results
-- customer_id is always populated (every match run is for a customer,
-- whether reached directly or via a lead). lead_id is populated only
-- when the run came from GET /api/matching/recommendations/:leadId.
-- Append-only like ai_lead_insights; POST /api/matching/rerun explicitly
-- deletes old rows for the customer before inserting fresh ones instead
-- of relying on a unique constraint + upsert.
-- ---------------------------------------------------------------------
CREATE TABLE property_match_results (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id          UUID REFERENCES leads(id) ON DELETE CASCADE,
    customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    property_id      UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,

    relevance_score  NUMERIC(5, 2) NOT NULL CHECK (relevance_score >= 0 AND relevance_score <= 100),
    matched_reasons  JSONB NOT NULL DEFAULT '{}',

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_property_match_results_lead_id     ON property_match_results(lead_id);
CREATE INDEX idx_property_match_results_customer_id ON property_match_results(customer_id);
CREATE INDEX idx_property_match_results_property_id ON property_match_results(property_id);
