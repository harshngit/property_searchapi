-- Refunds of unused AI credits now return the money, not only record it.
--
--   Paid online   the refund is sent through Razorpay (POST /payments/:id/refund)
--                 when the admin refunds; the refund.processed / refund.failed
--                 webhook moves it to processed / failed.
--   Bank / UPI    the refund waits for finance to send it back by bank / UPI;
--                 they record the transfer reference and it is processed.
--
--   refund_status  NULL (no refund), processing, processed, failed, manual_pending

ALTER TABLE ai_credit_purchases
  ADD COLUMN IF NOT EXISTS refund_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS refund_gateway_id VARCHAR(60),
  ADD COLUMN IF NOT EXISTS refund_reference VARCHAR(120),
  ADD COLUMN IF NOT EXISTS refund_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_error VARCHAR(300);

ALTER TABLE ai_credit_purchases DROP CONSTRAINT IF EXISTS ai_credit_purchases_refund_status_check;
ALTER TABLE ai_credit_purchases ADD CONSTRAINT ai_credit_purchases_refund_status_check
  CHECK (refund_status IS NULL OR refund_status IN ('processing', 'processed', 'failed', 'manual_pending'));

-- Refunds recorded before this migration were returned by hand.
UPDATE ai_credit_purchases SET refund_status = 'manual_pending' WHERE status = 'refunded' AND refund_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_credit_purchases_refund_gateway ON ai_credit_purchases (refund_gateway_id) WHERE refund_gateway_id IS NOT NULL;
