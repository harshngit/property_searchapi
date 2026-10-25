-- Engine 1: free-text property and requirement posting over WhatsApp and
-- Telegram (one shared channel adapter).
--   chat_intake_log          every free-text message the bots read: the intent
--                            found (buy / rent / sell / rent out / institutional)
--                            by the rules (no AI cost), and where it went.
--   chat_listing_submissions a property posted in a chat (text + photos), parsed
--                            into listing fields and checked for duplicates. It is
--                            NOT published until A R Buildwel staff approve it
--                            (human approval workflow); institutional sale posts
--                            are approved into the institutional desk (Engine 7).

CREATE SEQUENCE IF NOT EXISTS chat_listing_seq;

CREATE TABLE IF NOT EXISTS chat_listing_submissions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference        VARCHAR(20) NOT NULL UNIQUE,
    tenant_id        UUID REFERENCES tenants(id) ON DELETE SET NULL,
    channel          VARCHAR(10) NOT NULL CHECK (channel IN ('whatsapp', 'telegram')),
    contact_phone    VARCHAR(15),
    wa_user_id       VARCHAR(100),
    telegram_chat_id BIGINT,
    contact_name     VARCHAR(150),
    customer_id      UUID REFERENCES customers(id) ON DELETE SET NULL,
    intent           VARCHAR(20) NOT NULL CHECK (intent IN ('sell', 'rent_out', 'institutional_sale')),
    raw_text         TEXT NOT NULL,
    parsed           JSONB NOT NULL DEFAULT '{}'::jsonb,
    parsed_by        VARCHAR(10) NOT NULL DEFAULT 'rules' CHECK (parsed_by IN ('rules', 'ai')),
    confidence       SMALLINT NOT NULL DEFAULT 0,
    -- [{ path, mimetype }] stored objects; photos showing contact details are dropped on arrival.
    photos           JSONB NOT NULL DEFAULT '[]'::jsonb,
    photos_rejected  SMALLINT NOT NULL DEFAULT 0,
    -- [{ propertyId, title, reason, similarity }] possible duplicates of existing listings.
    duplicates       JSONB NOT NULL DEFAULT '[]'::jsonb,
    status           VARCHAR(20) NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'rejected')),
    property_id      UUID REFERENCES properties(id) ON DELETE SET NULL,
    reviewed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at      TIMESTAMPTZ,
    review_note      VARCHAR(500),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_listing_status ON chat_listing_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_listing_wa ON chat_listing_submissions (wa_user_id, created_at DESC) WHERE wa_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_listing_tg ON chat_listing_submissions (telegram_chat_id, created_at DESC) WHERE telegram_chat_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_intake_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel       VARCHAR(10) NOT NULL CHECK (channel IN ('whatsapp', 'telegram')),
    contact       VARCHAR(100),
    text          TEXT,
    photo_count   SMALLINT NOT NULL DEFAULT 0,
    intent        VARCHAR(20) NOT NULL,
    method        VARCHAR(10) NOT NULL CHECK (method IN ('rules', 'ai', 'none')),
    confidence    SMALLINT NOT NULL DEFAULT 0,
    -- listing | requirement | photo | needs_phone | ignored
    routed_to     VARCHAR(20) NOT NULL,
    submission_id UUID REFERENCES chat_listing_submissions(id) ON DELETE SET NULL,
    inbox_id      UUID,
    lead_id       UUID REFERENCES leads(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_intake_log_created ON chat_intake_log (created_at DESC);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('chat_intake.enabled', 'true'::jsonb, 'messaging', 'Read free-text property and requirement posts on WhatsApp and Telegram'),
  ('chat_intake.photo_window_minutes', '60'::jsonb, 'messaging', 'Photos sent within this many minutes are added to the poster''s latest listing')
ON CONFLICT (config_key) DO NOTHING;
