-- AI orchestration and the AI credit wallet.
--   ai_activities   every AI task the platform runs, with the model it goes to:
--                   simple work on the cheaper OpenAI model, important work
--                   (contracts, legal / due-diligence documents) on Claude. The
--                   Super Admin changes the model, the credit price and whether
--                   the user pays, without code.
--   ai_wallets      one per user. 1 credit = Rs 1. A user-paid AI action needs
--                   enough credits; when they run out, buy a pack again.
--   ai_credit_ledger every credit movement, append-only.
--   ai_credit_packs  what can be bought (price before GST, credits, bonus).
--   ai_credit_purchases a pack purchase (Razorpay, or recorded by an admin).
--   ai_runs         every AI call: model, tokens, actual cost, credits charged.

CREATE TABLE IF NOT EXISTS ai_activities (
    activity_key  VARCHAR(60) PRIMARY KEY,
    label         VARCHAR(150) NOT NULL,
    description   VARCHAR(400),
    tier          VARCHAR(10) NOT NULL CHECK (tier IN ('simple', 'important')),
    provider      VARCHAR(10) NOT NULL CHECK (provider IN ('openai', 'claude')),
    model         VARCHAR(60) NOT NULL,
    fallback_provider VARCHAR(10) CHECK (fallback_provider IS NULL OR fallback_provider IN ('openai', 'claude')),
    fallback_model    VARCHAR(60),
    effort        VARCHAR(10) NOT NULL DEFAULT 'low' CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
    max_output_tokens INT NOT NULL DEFAULT 1024 CHECK (max_output_tokens BETWEEN 50 AND 64000),
    credits       INT NOT NULL DEFAULT 0 CHECK (credits >= 0),
    -- 'user': the person who asked pays in credits (staff never pay);
    -- 'platform': background work A R Buildwel absorbs (fraud filters, parsing).
    payer         VARCHAR(10) NOT NULL DEFAULT 'platform' CHECK (payer IN ('user', 'platform')),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_wallets (
    user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance            INT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_purchased INT NOT NULL DEFAULT 0,
    lifetime_spent     INT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_credit_packs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(80) NOT NULL,
    price_inr     NUMERIC(10,2) NOT NULL CHECK (price_inr > 0),
    credits       INT NOT NULL CHECK (credits > 0),
    bonus_credits INT NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    sort_order    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS ai_credit_receipt_seq;
CREATE TABLE IF NOT EXISTS ai_credit_purchases (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_number   VARCHAR(30) NOT NULL UNIQUE,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id          UUID REFERENCES ai_credit_packs(id) ON DELETE SET NULL,
    pack_name        VARCHAR(80) NOT NULL,
    credits          INT NOT NULL CHECK (credits > 0),
    amount_inr       NUMERIC(10,2) NOT NULL,
    gst_percent      NUMERIC(5,2) NOT NULL,
    gst_inr          NUMERIC(10,2) NOT NULL,
    total_inr        NUMERIC(10,2) NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
    gateway          VARCHAR(12) NOT NULL DEFAULT 'razorpay' CHECK (gateway IN ('razorpay', 'manual')),
    gateway_order_id VARCHAR(60),
    gateway_payment_id VARCHAR(60),
    reference        VARCHAR(120),
    recorded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_credit_purchases_user ON ai_credit_purchases (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_runs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_key   VARCHAR(60) NOT NULL,
    user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    payer          VARCHAR(10) NOT NULL,
    provider       VARCHAR(10),
    model          VARCHAR(60),
    status         VARCHAR(10) NOT NULL CHECK (status IN ('ok', 'failed', 'refused')),
    fallback_used  BOOLEAN NOT NULL DEFAULT false,
    input_tokens   INT NOT NULL DEFAULT 0,
    output_tokens  INT NOT NULL DEFAULT 0,
    cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
    credits_charged INT NOT NULL DEFAULT 0,
    latency_ms     INT,
    entity_type    VARCHAR(40),
    entity_id      VARCHAR(80),
    error          VARCHAR(300),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_user ON ai_runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_credit_ledger (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          VARCHAR(10) NOT NULL CHECK (kind IN ('purchase', 'spend', 'refund', 'grant', 'adjust')),
    credits       INT NOT NULL,
    balance_after INT NOT NULL,
    activity_key  VARCHAR(60),
    run_id        UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    purchase_id   UUID REFERENCES ai_credit_purchases(id) ON DELETE SET NULL,
    note          VARCHAR(300),
    actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ai_credit_ledger_user ON ai_credit_ledger (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION ai_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the AI credit ledger is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_ai_credit_ledger_append_only ON ai_credit_ledger;
CREATE TRIGGER trg_ai_credit_ledger_append_only BEFORE UPDATE OR DELETE ON ai_credit_ledger FOR EACH ROW EXECUTE FUNCTION ai_ledger_append_only();

-- Model prices (USD per 1M tokens) used to record the actual cost of each call.
INSERT INTO app_config (config_key, value, category, description) VALUES
  ('ai.model_prices', '{"gpt-6-luna": {"input": 0.10, "output": 0.50}, "gpt-5-nano": {"input": 0.05, "output": 0.40}, "gpt-6.1-sol": {"input": 2.00, "output": 10.00}, "claude-opus-5-5": {"input": 4.00, "output": 20.00}, "claude-sonnet-5-5": {"input": 2.00, "output": 10.00}, "claude-haiku-5-5": {"input": 0.10, "output": 0.50}}'::jsonb, 'ai', 'USD per 1M input / output tokens, to record what each AI call actually cost'),
  ('ai.credit_gst_percent', '18'::jsonb, 'ai', 'GST added to AI credit pack prices'),
  ('ai.enabled', 'true'::jsonb, 'ai', 'Switch every AI feature on or off')
ON CONFLICT (config_key) DO NOTHING;

-- Seeded only when there are no packs yet (packs have no natural key).
INSERT INTO ai_credit_packs (name, price_inr, credits, bonus_credits, sort_order)
SELECT v.* FROM (VALUES
  ('Starter', 500, 500, 0, 1),
  ('Professional', 1000, 1000, 100, 2),
  ('Business', 5000, 5000, 1000, 3)
) AS v(name, price_inr, credits, bonus_credits, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM ai_credit_packs);

-- The catalogue. Simple work -> OpenAI gpt-6-luna; important work -> Claude Opus 5.5.
-- Each falls back to the other provider if its own fails.
INSERT INTO ai_activities (activity_key, label, description, tier, provider, model, fallback_provider, fallback_model, effort, max_output_tokens, credits, payer) VALUES
  ('lead_insight',        'Lead qualification summary',      'Budget, location, intent and a short summary from the lead''s notes', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 1024, 2, 'user'),
  ('email_lead_parse',    'Email lead parsing',              'Reads portal / inbox emails into a lead', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 600, 0, 'platform'),
  ('review_screen',       'Fake-review filter',              'Screens new reviews for fake or abusive content', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 300, 0, 'platform'),
  ('image_contact_scan',  'Contact details in photos',       'Finds phone numbers / emails in listing photos', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 300, 0, 'platform'),
  ('image_origin_check',  'Screenshot / map-image check',    'Field-partner photo check', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 200, 0, 'platform'),
  ('field_fraud_review',  'Field-task fraud second opinion', 'Reviews the fraud signals on a field task', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 400, 0, 'platform'),
  ('scan_transcribe',     'Scanned document reading',        'Transcribes scanned notices and documents', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 8000, 0, 'platform'),
  ('notice_extract',      'Auction / legal notice extraction', 'Pulls structured fields from crawled notices', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 1024, 0, 'platform'),
  ('translation',         'Hindi / regional translation',    'Translates interface text', 'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 16000, 0, 'platform'),
  ('document_analysis',   'Due-diligence document analysis', 'Classifies a property document and flags legal risks', 'important', 'claude', 'claude-opus-5-5', 'openai', 'gpt-6.1-sol', 'medium', 2000, 0, 'platform'),
  ('agreement_review',    'AI agreement review',             'Reviews a drafted agreement for missing clauses, risks and inconsistencies', 'important', 'claude', 'claude-opus-5-5', 'openai', 'gpt-6.1-sol', 'high', 6000, 49, 'user')
ON CONFLICT (activity_key) DO NOTHING;

-- AI reviews of generated agreements (the paid "agreement_review" activity), kept per document.
CREATE TABLE IF NOT EXISTS generated_document_ai_reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID NOT NULL REFERENCES generated_documents(id) ON DELETE CASCADE,
    run_id       UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    focus        VARCHAR(300),
    review       JSONB NOT NULL,
    model        VARCHAR(60),
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_generated_document_ai_reviews_doc ON generated_document_ai_reviews (document_id, created_at DESC);
