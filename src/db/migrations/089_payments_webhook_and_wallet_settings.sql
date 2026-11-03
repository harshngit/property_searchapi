-- Payments: the Razorpay webhook, payment screenshots on bank / UPI top-ups
-- and structured bank / UPI details for the AI credit wallet.
--
--   razorpay_webhook_events  every webhook Razorpay sends (by its event id),
--        so a retried event is applied once. The webhook settles AI credit
--        purchases, ad invoices and franchise invoices even when the browser
--        closed before Checkout's own confirmation reached us.
--   ai_topup_requests        an optional screenshot of the payment.
--   ai.payment_details       placeholder text -> fields the admin fills in
--        (Settings -> AI settings -> Payments and credit rules).

CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
    event_id    VARCHAR(80) PRIMARY KEY,
    event       VARCHAR(60) NOT NULL,
    order_id    VARCHAR(60),
    payment_id  VARCHAR(60),
    amount_paise BIGINT,
    outcome     VARCHAR(40) NOT NULL,
    detail      VARCHAR(300),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_razorpay_webhook_order ON razorpay_webhook_events (order_id);

ALTER TABLE ai_topup_requests
  ADD COLUMN IF NOT EXISTS screenshot_path VARCHAR(300),
  ADD COLUMN IF NOT EXISTS screenshot_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS screenshot_type VARCHAR(40);

UPDATE app_config SET value = '{"bank": {"accountName": "", "accountNumber": "", "ifsc": "", "bankName": "", "branch": ""}, "upi": {"id": "", "name": ""}, "note": ""}'::jsonb
WHERE config_key = 'ai.payment_details' AND jsonb_typeof(value -> 'bank') = 'string';
