-- AI credit wallet additions (client, 25 Oct 2026):
--   ai_credit_lots       where each credit came from and when it expires. A
--                        spend uses the credits that expire first. Validity per
--                        kind (purchase / grant / referral) follows the Terms &
--                        Conditions and is admin-set; expired credits leave the
--                        wallet with an 'expire' ledger line.
--   ai_topup_requests    a bank transfer / UPI payment the user reports with its
--                        reference; credited when an admin approves it.
--   ai_referral_rewards  credits earned for introducing people: when they join,
--                        a share of what they spend on AI, and when their deal
--                        closes. One reward per person / deal.
--   Purchases get a GST tax invoice number when paid (downloadable PDF), and
--   may be refunded for their unused credits within the T&C window.

-- Ledger kinds: + referral, expire, refund_out (unused purchased credits refunded).
ALTER TABLE ai_credit_ledger DROP CONSTRAINT IF EXISTS ai_credit_ledger_kind_check;
ALTER TABLE ai_credit_ledger ADD CONSTRAINT ai_credit_ledger_kind_check
  CHECK (kind IN ('purchase', 'spend', 'refund', 'grant', 'adjust', 'referral', 'expire', 'refund_out'));

CREATE TABLE IF NOT EXISTS ai_credit_lots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        VARCHAR(12) NOT NULL CHECK (kind IN ('purchase', 'grant', 'referral', 'refund', 'opening')),
    credits     INT NOT NULL CHECK (credits > 0),
    remaining   INT NOT NULL CHECK (remaining >= 0),
    expires_at  TIMESTAMPTZ,
    purchase_id UUID REFERENCES ai_credit_purchases(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (remaining <= credits)
);
CREATE INDEX IF NOT EXISTS idx_ai_credit_lots_open ON ai_credit_lots (user_id, expires_at NULLS LAST, created_at) WHERE remaining > 0;
CREATE INDEX IF NOT EXISTS idx_ai_credit_lots_expiry ON ai_credit_lots (expires_at) WHERE remaining > 0 AND expires_at IS NOT NULL;

-- Credits already in wallets become one opening lot that never expires.
INSERT INTO ai_credit_lots (user_id, kind, credits, remaining)
SELECT w.user_id, 'opening', w.balance, w.balance FROM ai_wallets w
WHERE w.balance > 0 AND NOT EXISTS (SELECT 1 FROM ai_credit_lots l WHERE l.user_id = w.user_id);

-- GST tax invoice on every paid purchase, and refunds of unused credits.
CREATE SEQUENCE IF NOT EXISTS ai_credit_invoice_seq;
ALTER TABLE ai_credit_purchases
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(30) UNIQUE,
  ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gstin VARCHAR(20),
  ADD COLUMN IF NOT EXISTS buyer_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS buyer_gstin VARCHAR(20),
  ADD COLUMN IF NOT EXISTS refunded_credits INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_inr NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_note VARCHAR(300);
ALTER TABLE ai_credit_purchases DROP CONSTRAINT IF EXISTS ai_credit_purchases_status_check;
ALTER TABLE ai_credit_purchases ADD CONSTRAINT ai_credit_purchases_status_check CHECK (status IN ('created', 'paid', 'failed', 'refunded'));
ALTER TABLE ai_credit_purchases DROP CONSTRAINT IF EXISTS ai_credit_purchases_gateway_check;
ALTER TABLE ai_credit_purchases ADD CONSTRAINT ai_credit_purchases_gateway_check CHECK (gateway IN ('razorpay', 'manual', 'bank', 'upi'));

-- Invoices for purchases already paid.
UPDATE ai_credit_purchases p SET invoice_number = 'AIC-INV-' || to_char(COALESCE(p.paid_at, p.created_at), 'YYYY') || '-' || lpad(nextval('ai_credit_invoice_seq')::text, 6, '0'),
  invoiced_at = COALESCE(p.paid_at, p.created_at), gstin = '07DERPR1574G2ZY'
WHERE p.status = 'paid' AND p.invoice_number IS NULL;

CREATE TABLE IF NOT EXISTS ai_topup_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id      UUID NOT NULL REFERENCES ai_credit_packs(id) ON DELETE RESTRICT,
    method       VARCHAR(6) NOT NULL CHECK (method IN ('bank', 'upi')),
    reference    VARCHAR(60) NOT NULL,
    amount_inr   NUMERIC(10,2) NOT NULL,
    paid_on      DATE,
    note         VARCHAR(300),
    status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    purchase_id  UUID REFERENCES ai_credit_purchases(id) ON DELETE SET NULL,
    decided_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at   TIMESTAMPTZ,
    decision_note VARCHAR(300),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_topup_reference ON ai_topup_requests (method, upper(reference)) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS idx_ai_topup_status ON ai_topup_requests (status, created_at);

CREATE TABLE IF NOT EXISTS ai_referral_rewards (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         VARCHAR(12) NOT NULL CHECK (kind IN ('join', 'usage', 'deal_closed')),
    deal_id      UUID REFERENCES deals(id) ON DELETE SET NULL,
    credits      INT NOT NULL CHECK (credits > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_referral_join ON ai_referral_rewards (referred_id) WHERE kind = 'join';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_referral_deal ON ai_referral_rewards (referred_id, deal_id) WHERE kind = 'deal_closed';
CREATE INDEX IF NOT EXISTS idx_ai_referral_referrer ON ai_referral_rewards (referrer_id, created_at DESC);

-- Fractions of a credit earned from an introduced person's usage, carried until whole.
ALTER TABLE ai_wallets ADD COLUMN IF NOT EXISTS referral_accrued NUMERIC(10,2) NOT NULL DEFAULT 0;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('ai.referral_rewards', '{"join": 25, "usagePercent": 5, "dealClosed": 250}'::jsonb, 'ai',
   'AI credits for introducing people: when they join, a % of the AI credits they spend, and when their deal closes'),
  ('ai.credit_validity_days', '{"purchase": null, "grant": 90, "referral": 180}'::jsonb, 'ai',
   'Days before credits of each kind expire (null = never) - per the Terms & Conditions'),
  ('ai.purchase_refund_days', '7'::jsonb, 'ai',
   'Days after purchase within which unused purchased credits may be refunded (null = no refunds) - per the Terms & Conditions'),
  ('ai.usd_inr_rate', '85'::jsonb, 'ai', 'Rupees per US dollar, to show the AI API cost in rupees against the credits charged'),
  ('ai.payment_details', '{"bank": "Account name, number, IFSC - set by the admin", "upi": "UPI id - set by the admin"}'::jsonb, 'ai',
   'Bank account and UPI id shown to users who pay for credits by transfer')
ON CONFLICT (config_key) DO NOTHING;
