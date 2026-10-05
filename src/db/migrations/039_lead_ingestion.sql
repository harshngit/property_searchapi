-- =====================================================================
-- Migration: 039_lead_ingestion.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 2 "External Lead Ingestion into CRM - All Sources":
--              - lead_sources            admin-managed source catalogue
--                                        (tag, auth type, normaliser, sync
--                                        mode push / pull / push+pull, poll
--                                        interval) - new sources are rows,
--                                        not code
--              - lead_source_connections a tenant's (or A R master's)
--                                        activation of a source: encrypted
--                                        credentials, webhook key, pull
--                                        cursor, failure tracking
--              - lead_ingestion_inbox    every inbound payload (webhook,
--                                        pull, email, Telegram) before it
--                                        becomes a lead: raw archive, parse
--                                        result + confidence, dedupe result,
--                                        manual review queue
--              - lead_source_history     append-only: every source a lead
--                                        arrived from (dedupe keeps them all)
--              - leads.source_tag        immutable once assigned
--              - telegram_bot_sessions   Telegram parallel channel
-- DB       : PostgreSQL
-- =====================================================================

ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'telegram';
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'portal';
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'social_ad';
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'email';

ALTER TABLE leads
    ADD COLUMN source_tag        VARCHAR(60),
    ADD COLUMN ingestion_mode    VARCHAR(10),
    ADD COLUMN external_lead_id  VARCHAR(120);

UPDATE leads SET source_tag = CASE source::text
    WHEN 'website' THEN 'Website-Inquiry'
    WHEN 'whatsapp' THEN 'WhatsApp-Requirement'
    WHEN 'manual' THEN 'Manual-Entry'
    WHEN 'opportunity' THEN 'Opportunity-Interest'
    ELSE 'Campaign' END
WHERE source_tag IS NULL;

CREATE INDEX idx_leads_source_tag ON leads(source_tag);

-- Source tags are immutable once assigned (sec. 2 Lead Deduplication).
CREATE OR REPLACE FUNCTION trigger_lead_source_tag_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.source_tag IS NOT NULL AND NEW.source_tag IS DISTINCT FROM OLD.source_tag THEN
    RAISE EXCEPTION 'leads.source_tag is immutable once assigned';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_source_tag_immutable
BEFORE UPDATE OF source_tag ON leads
FOR EACH ROW EXECUTE FUNCTION trigger_lead_source_tag_immutable();

-- ---------------------------------------------------------------------
-- lead_sources
-- ---------------------------------------------------------------------
CREATE TABLE lead_sources (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key              VARCHAR(40) NOT NULL UNIQUE,
    source_name             VARCHAR(100) NOT NULL,
    source_tag              VARCHAR(60) NOT NULL UNIQUE,
    channel                 VARCHAR(20) NOT NULL CHECK (channel IN ('web', 'messaging', 'social_ad', 'portal', 'email', 'manual')),
    webhook_path            VARCHAR(200),
    auth_type               VARCHAR(20) NOT NULL DEFAULT 'WEBHOOK_SECRET' CHECK (auth_type IN ('API_KEY', 'OAUTH', 'WEBHOOK_SECRET', 'NONE')),
    normaliser_module       VARCHAR(30) NOT NULL,
    lead_source_enum        VARCHAR(20) NOT NULL DEFAULT 'campaign',
    sync_mode               VARCHAR(10) NOT NULL DEFAULT 'push+pull' CHECK (sync_mode IN ('push', 'pull', 'push+pull')),
    supports_pull           BOOLEAN NOT NULL DEFAULT false,
    poll_interval_minutes   SMALLINT NOT NULL DEFAULT 30 CHECK (poll_interval_minutes BETWEEN 5 AND 1440),
    field_mapping           JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active               BOOLEAN NOT NULL DEFAULT true,
    phase                   SMALLINT NOT NULL DEFAULT 1,
    tenant_config_required  BOOLEAN NOT NULL DEFAULT true,
    tenant_config_label     VARCHAR(150),
    built_in                BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_lead_sources_updated_at
BEFORE UPDATE ON lead_sources
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE FUNCTION trigger_lead_source_row_tag_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_tag <> OLD.source_tag OR NEW.source_key <> OLD.source_key THEN
    RAISE EXCEPTION 'lead_sources.source_tag and source_key are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_sources_tag_immutable
BEFORE UPDATE ON lead_sources
FOR EACH ROW EXECUTE FUNCTION trigger_lead_source_row_tag_immutable();

INSERT INTO lead_sources (source_key, source_name, source_tag, channel, webhook_path, auth_type, normaliser_module, lead_source_enum, sync_mode, supports_pull, tenant_config_required, tenant_config_label, built_in, field_mapping) VALUES
  ('website',            'Website form inquiries',     'Website-Inquiry',          'web',       '/api/leads/public-inquiry',  'NONE',           'form',      'website',   'push',      false, false, NULL, true, '{}'),
  ('whatsapp_listing',   'WhatsApp listing inquiries', 'WhatsApp-Listing-Inquiry', 'messaging', '/api/whatsapp/webhook',      'WEBHOOK_SECRET', 'whatsapp',  'whatsapp',  'push',      false, false, NULL, true, '{}'),
  ('whatsapp_requirement','WhatsApp buyer requirements','WhatsApp-Requirement',    'messaging', '/api/whatsapp/webhook',      'WEBHOOK_SECRET', 'whatsapp',  'whatsapp',  'push',      false, false, NULL, true, '{}'),
  ('manual',             'Broker manual entries',      'Manual-Entry',             'manual',    NULL,                         'NONE',           'manual',    'manual',    'push',      false, false, NULL, true, '{}'),
  ('telegram_listing',   'Telegram listing inquiries', 'Telegram-Listing-Inquiry', 'messaging', '/api/telegram/webhook',      'WEBHOOK_SECRET', 'telegram',  'telegram',  'push',      false, false, NULL, true, '{}'),
  ('telegram_requirement','Telegram buyer requirements','Telegram-Requirement',    'messaging', '/api/telegram/webhook',      'WEBHOOK_SECRET', 'telegram',  'telegram',  'push',      false, false, NULL, true, '{}'),
  ('facebook',           'Facebook Lead Ads',          'Facebook-Lead-Ad',         'social_ad', '/api/leads/ingest/facebook', 'OAUTH',          'meta',      'social_ad', 'push+pull', true,  true, 'Connect your Facebook page (page access token + app secret)', true, '{}'),
  ('instagram',          'Instagram Lead Ads',         'Instagram-Lead-Ad',        'social_ad', '/api/leads/ingest/instagram','OAUTH',          'meta',      'social_ad', 'push+pull', true,  true, 'Connect the Facebook page linked to your Instagram account', true, '{}'),
  ('google',             'Google Ads Lead Forms',      'Google-Lead-Form',         'social_ad', '/api/leads/ingest/google',   'OAUTH',          'google',    'social_ad', 'push+pull', true,  true, 'Paste the webhook key into Google Ads; add Google Ads API access for pull', true, '{}'),
  ('99acres',            '99acres',                    'Portal-99acres',           'portal',    '/api/leads/ingest/99acres',  'API_KEY',        'portal',    'portal',    'push+pull', true,  true, 'Enter your 99acres API key / lead pull URL', true, '{}'),
  ('magicbricks',        'MagicBricks',                'Portal-MagicBricks',       'portal',    '/api/leads/ingest/magicbricks','API_KEY',      'portal',    'portal',    'push+pull', true,  true, 'Enter your MagicBricks API key / lead pull URL', true, '{}'),
  ('housing',            'Housing.com',                'Portal-Housing',           'portal',    '/api/leads/ingest/housing',  'API_KEY',        'portal',    'portal',    'push+pull', true,  true, 'Enter your Housing.com API key / lead pull URL', true, '{}'),
  ('justdial',           'JustDial',                   'Portal-JustDial',          'portal',    '/api/leads/ingest/justdial', 'API_KEY',        'portal',    'portal',    'push',      true,  true, 'Give JustDial your webhook URL', true,
     '{"name": ["name", "custname", "caller_name"], "phone": ["mobile", "phone", "custmobile", "caller_mobile"], "email": ["email", "custemail"], "city": ["city"], "locality": ["area", "locality"], "message": ["category", "requirement", "remarks"], "externalId": ["leadid", "lead_id"]}'),
  ('sulekha',            'Sulekha',                    'Portal-Sulekha',           'portal',    '/api/leads/ingest/sulekha',  'API_KEY',        'portal',    'portal',    'push',      true,  true, 'Give Sulekha your webhook URL', true, '{}'),
  ('portal_email',       'Portal lead emails',         'Portal-Email',             'email',     '/api/leads/ingest/email',    'WEBHOOK_SECRET', 'email',     'portal',    'push',      false, false, 'Give the portal your dedicated lead mailbox', true, '{}'),
  ('linkedin',           'LinkedIn Lead Gen Forms',    'LinkedIn-Lead-Gen',        'social_ad', '/api/leads/ingest/linkedin', 'API_KEY',        'generic',   'social_ad', 'push+pull', true,  true, 'Enter a webhook key / pull URL for LinkedIn lead sync', false, '{}');

-- ---------------------------------------------------------------------
-- lead_source_connections - tenant_id NULL = A R Buildwel master org.
-- ---------------------------------------------------------------------
CREATE TABLE lead_source_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id               UUID NOT NULL REFERENCES lead_sources(id) ON DELETE CASCADE,
    tenant_id               UUID REFERENCES tenants(id) ON DELETE CASCADE,
    webhook_key             VARCHAR(64) NOT NULL UNIQUE,
    credentials_enc         TEXT,
    status                  VARCHAR(15) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
    pull_cursor             TIMESTAMPTZ,
    last_push_at            TIMESTAMPTZ,
    last_pull_at            TIMESTAMPTZ,
    last_error              TEXT,
    consecutive_failures    SMALLINT NOT NULL DEFAULT 0,
    failure_alerted_at      TIMESTAMPTZ,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_lead_source_connection ON lead_source_connections (source_id, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TRIGGER trg_lead_source_connections_updated_at
BEFORE UPDATE ON lead_source_connections
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- lead_ingestion_inbox
-- ---------------------------------------------------------------------
CREATE TABLE lead_ingestion_inbox (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID REFERENCES tenants(id) ON DELETE SET NULL,
    source_key              VARCHAR(40) NOT NULL,
    connection_id           UUID REFERENCES lead_source_connections(id) ON DELETE SET NULL,
    external_lead_id        VARCHAR(120),
    ingestion_method        VARCHAR(15) NOT NULL CHECK (ingestion_method IN ('email_parser', 'webhook', 'api', 'form_post', 'pull', 'bot')),
    raw_payload_ref         VARCHAR(300),
    raw_payload             TEXT,
    parse_status            VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (parse_status IN ('pending', 'parsing', 'parsed', 'parse_failed', 'duplicate_detected', 'lead_created', 'rejected')),
    parse_confidence        NUMERIC(5, 2),
    parse_error             TEXT,
    parsed_name             VARCHAR(150),
    parsed_phone_enc        TEXT,
    parsed_phone_masked     VARCHAR(20),
    parsed_email            VARCHAR(150),
    parsed_city             VARCHAR(100),
    parsed_locality         VARCHAR(150),
    parsed_budget           BIGINT,
    parsed_property_type    VARCHAR(40),
    parsed_purpose          VARCHAR(10),
    parsed_message          TEXT,
    parsed_property_id      UUID REFERENCES properties(id) ON DELETE SET NULL,
    parsed_by_ai            BOOLEAN NOT NULL DEFAULT false,
    dedup_result            VARCHAR(25) CHECK (dedup_result IS NULL OR dedup_result IN ('unique', 'duplicate_same_org', 'duplicate_cross_org', 'duplicate_external_id')),
    created_lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
    assigned_rep_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at            TIMESTAMPTZ
);

CREATE INDEX idx_ingestion_inbox_status ON lead_ingestion_inbox(parse_status, created_at);
CREATE INDEX idx_ingestion_inbox_tenant ON lead_ingestion_inbox(tenant_id, created_at);
-- Idempotency: the same external lead delivered twice (push + pull, or a retry) is processed once.
CREATE UNIQUE INDEX uq_ingestion_external ON lead_ingestion_inbox (source_key, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), external_lead_id)
    WHERE external_lead_id IS NOT NULL AND parse_status <> 'duplicate_detected';

-- ---------------------------------------------------------------------
-- lead_source_history - append-only
-- ---------------------------------------------------------------------
CREATE TABLE lead_source_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    source_tag          VARCHAR(60) NOT NULL,
    ingestion_mode      VARCHAR(10),
    external_lead_id    VARCHAR(120),
    inbox_id            UUID REFERENCES lead_ingestion_inbox(id) ON DELETE SET NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_lead_source_history_lead ON lead_source_history(lead_id, received_at);

CREATE OR REPLACE FUNCTION trigger_reject_source_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM leads WHERE id = OLD.lead_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.inbox_id IS NULL AND OLD.inbox_id IS NOT NULL
     AND NEW.source_tag = OLD.source_tag AND NEW.lead_id = OLD.lead_id THEN
    RETURN NEW; -- ON DELETE SET NULL from the inbox
  END IF;
  RAISE EXCEPTION 'lead_source_history is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_source_history_append_only
BEFORE UPDATE OR DELETE ON lead_source_history
FOR EACH ROW EXECUTE FUNCTION trigger_reject_source_history_mutation();

INSERT INTO lead_source_history (lead_id, source_tag, ingestion_mode, received_at)
SELECT id, source_tag, 'legacy', created_at FROM leads WHERE source_tag IS NOT NULL;

-- ---------------------------------------------------------------------
-- Every lead, from any path, gets a source tag and its first history row
-- (no lead ever enters without source attribution).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_lead_default_source_tag()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_tag IS NULL THEN
    NEW.source_tag := CASE NEW.source::text
      WHEN 'website' THEN 'Website-Inquiry'
      WHEN 'whatsapp' THEN 'WhatsApp-Requirement'
      WHEN 'telegram' THEN 'Telegram-Requirement'
      WHEN 'manual' THEN 'Manual-Entry'
      WHEN 'opportunity' THEN 'Opportunity-Interest'
      WHEN 'portal' THEN 'Portal-Email'
      ELSE 'Campaign' END;
  END IF;
  IF NEW.ingestion_mode IS NULL THEN
    NEW.ingestion_mode := CASE NEW.source::text WHEN 'manual' THEN 'manual' WHEN 'website' THEN 'form' ELSE 'push' END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_default_source_tag
BEFORE INSERT ON leads
FOR EACH ROW EXECUTE FUNCTION trigger_lead_default_source_tag();

CREATE OR REPLACE FUNCTION trigger_lead_first_source_history()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO lead_source_history (lead_id, source_tag, ingestion_mode, external_lead_id)
  VALUES (NEW.id, NEW.source_tag, NEW.ingestion_mode, NEW.external_lead_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_first_source_history
AFTER INSERT ON leads
FOR EACH ROW EXECUTE FUNCTION trigger_lead_first_source_history();

-- ---------------------------------------------------------------------
-- Telegram bot sessions (parallel channel, sec. 25.5.3)
-- ---------------------------------------------------------------------
CREATE TABLE telegram_bot_sessions (
    chat_id         BIGINT PRIMARY KEY,
    current_step    VARCHAR(30) NOT NULL,
    answers         JSONB NOT NULL DEFAULT '{}'::jsonb,
    property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
    status          VARCHAR(15) NOT NULL DEFAULT 'in_progress',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('ingestion.confidence_threshold', '70', 'ingestion', 'Parse confidence (0-100) below which an inbound lead waits in the manual review queue.'),
  ('ingestion.pull_failure_alert_after', '3', 'ingestion', 'Consecutive pull failures after which Super Admin and the org admin are alerted.'),
  ('ingestion.email_domain', '"leads.propertyserch.com"', 'ingestion', 'Domain of the per-org lead mailboxes: lead-<org-slug>@<domain> (lead-arb@ for A R Buildwel).'),
  ('ingestion.email_sender_sources', '{"99acres.com": "99acres", "magicbricks.com": "magicbricks", "housing.com": "housing", "justdial.com": "justdial", "sulekha.com": "sulekha"}', 'ingestion', 'Sender domain -> source for leads parsed from portal emails.'),
  ('ingestion.google_ads_api_version', '"v18"', 'ingestion', 'Google Ads API version used for Lead Form pull reconciliation.'),
  ('ingestion.meta_graph_version', '"v21.0"', 'ingestion', 'Meta Graph API version used to fetch / pull Lead Ads.')
ON CONFLICT (config_key) DO NOTHING;
