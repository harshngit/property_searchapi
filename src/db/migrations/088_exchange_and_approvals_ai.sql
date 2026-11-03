-- Two optional, user-paid Serchi buttons (Phase 1, client decisions of 25 Oct 2026).
-- Both sit beside the rule-based output and never replace it: the result is
-- stored in its own column and shown as a separate, disclaimed panel.
--
--   #14  exchange_estimate_adjust      - an AI condition adjustment to the
--        Exchange "indicative estimate" (OpenAI, the cheaper model). The
--        platform / staff estimate stays as it is; the AI figure is clamped
--        to +/- exchange.ai_adjust_max_percent and is never a valuation.
--   #15  institutional_approvals_review - an AI read of the declared approvals
--        and the approval documents in the data room for an institutional
--        listing (Claude). A CA and legal counsel must verify every point.

INSERT INTO ai_activities (activity_key, label, description, tier, provider, model, fallback_provider, fallback_model, effort, max_output_tokens, credits, payer, is_active, disclaimer) VALUES
  ('exchange_estimate_adjust', 'Exchange estimate - AI condition check',
   'Reads the old property''s age, floor, furnishing, amenities and description and suggests a small adjustment to the indicative estimate',
   'simple', 'openai', 'gpt-6-luna', 'claude', 'claude-haiku-5-5', 'low', 600, 3, 'user', true,
   'AI-assisted indicative estimate only. It is not a valuation. Get an independent valuation before transacting.'),
  ('institutional_approvals_review', 'Institutional approvals - AI review',
   'Reads the declared approvals and the approval documents in the data room, and lists approvals that look missing, expired or inconsistent',
   'important', 'claude', 'claude-opus-5-5', 'openai', 'gpt-6.1-sol', 'medium', 2500, 30, 'user', true,
   'AI working review only. Not legal, tax or financial advice. A chartered accountant (CA) and legal counsel must verify every approval before any decision.')
ON CONFLICT (activity_key) DO NOTHING;

ALTER TABLE exchange_requests ADD COLUMN IF NOT EXISTS ai_estimate_review JSONB;
ALTER TABLE institutional_listings ADD COLUMN IF NOT EXISTS ai_approvals_review JSONB;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('exchange.ai_adjust_max_percent', '15'::jsonb, 'exchange', 'Largest AI condition adjustment (+/- percent) allowed on an Exchange indicative estimate (#14)')
ON CONFLICT (config_key) DO NOTHING;
