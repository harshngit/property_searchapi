-- Module 50 - Document Template Engine (sec. 36).
-- Every transaction document is a blank master template with named
-- variables ({{seller_name}}, {{sale_consideration}} ...). To produce a
-- document the user is asked only for that template's variables; what the
-- deal already knows arrives pre-filled, and figures such as stamp duty and
-- amount-in-words compute themselves.
--   document_templates           one row per document type (add one = no code change)
--   document_template_versions   the text; an edit makes a new version, old ones are kept
--   template_variables           the variables of a template (label, type, validation, help)
--   generated_documents          every generation: who, when, which deal, which version, the values

CREATE TABLE document_templates (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key     VARCHAR(60) NOT NULL UNIQUE,
    name             VARCHAR(160) NOT NULL,
    category         VARCHAR(30) NOT NULL DEFAULT 'sale',
    description      VARCHAR(400),
    -- staff: A R staff only; professional: staff + brokers / builders; all: also the customer on the deal
    audience         VARCHAR(14) NOT NULL DEFAULT 'professional' CHECK (audience IN ('staff', 'professional', 'all')),
    -- sale / lease / other: which stamp-duty rule applies when the template computes one
    duty_transaction VARCHAR(20) NOT NULL DEFAULT 'sale',
    status           VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
    current_version  INTEGER NOT NULL DEFAULT 0,
    sort_order       SMALLINT NOT NULL DEFAULT 0,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_template_versions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id   UUID NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    body          TEXT NOT NULL,
    -- State-specific clauses: [{ "stateCode": "KA", "body": "..." }]; rendered where {{state_clauses}} appears.
    state_blocks  JSONB NOT NULL DEFAULT '[]',
    change_note   VARCHAR(300),
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
);

CREATE OR REPLACE FUNCTION trigger_template_versions_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'document_template_versions is immutable: an edit must create a new version';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER template_versions_immutable
BEFORE UPDATE ON document_template_versions
FOR EACH ROW EXECUTE FUNCTION trigger_template_versions_immutable();

CREATE TABLE template_variables (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id   UUID NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
    name          VARCHAR(60) NOT NULL,
    label         VARCHAR(160) NOT NULL,
    field_type    VARCHAR(14) NOT NULL DEFAULT 'text' CHECK (field_type IN ('text', 'longtext', 'number', 'currency', 'date', 'dropdown', 'party_picker', 'computed')),
    options       JSONB NOT NULL DEFAULT '[]',
    -- { "min": 0, "max": 100, "maxLength": 200, "pattern": "^[A-Z]{5}\\d{4}[A-Z]$", "patternMessage": "..." }
    validation    JSONB NOT NULL DEFAULT '{}',
    is_required   BOOLEAN NOT NULL DEFAULT true,
    help_text     VARCHAR(300),
    -- Where a known value comes from: deal.buyer_name, deal.seller_name, property.address, deal.value ...
    prefill       VARCHAR(40),
    -- For computed: { "kind": "amount_in_words", "of": "sale_consideration" } | stamp_duty | registration_fee | today
    computed      JSONB,
    -- Asked only for these states (Khata in KA, Patta in TN ...); empty = everywhere.
    state_codes   JSONB NOT NULL DEFAULT '[]',
    sort_order    SMALLINT NOT NULL DEFAULT 0,
    UNIQUE (template_id, name)
);

CREATE SEQUENCE generated_document_seq START 1;

CREATE TABLE generated_documents (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_number   VARCHAR(24) NOT NULL UNIQUE,
    template_id       UUID NOT NULL REFERENCES document_templates(id) ON DELETE RESTRICT,
    template_version  INTEGER NOT NULL,
    deal_id           UUID REFERENCES deals(id) ON DELETE SET NULL,
    property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,
    state_code        VARCHAR(10),
    "values"          JSONB NOT NULL DEFAULT '{}',
    is_blank          BOOLEAN NOT NULL DEFAULT false,
    -- The DRAFT watermark stays until the assigned RM / DM marks the advocate's review complete.
    advocate_reviewed_at TIMESTAMPTZ,
    advocate_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    repository_document_id UUID,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_generated_documents_deal ON generated_documents(deal_id);
CREATE INDEX idx_generated_documents_creator ON generated_documents(created_by, created_at DESC);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('templates.enabled', 'true', 'templates', 'Module 50 - document template engine'),
  ('templates.draft_disclaimer', '"Working draft for the client''s chosen advocate to review, stamp, and register before execution."', 'templates', 'Printed on every generated document (sec. 36.4)'),
  ('templates.facilitation_note', '"A R Buildwel facilitates the transaction and does not act as legal counsel to any party."', 'templates', 'Printed under the disclaimer')
ON CONFLICT (config_key) DO NOTHING;
