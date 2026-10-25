-- Serchi realignment (client decisions of 25 Oct 2026, Phase 1):
--   * every AI call is paid from the asking user's wallet - never by
--     A R Buildwel, and staff spend credits too;
--   * the safety checks (image contact blocking, crawler / scan OCR,
--     duplicate detection) and the chat-message reader run on rules and
--     self-hosted tools only, so their AI activities are switched off;
--   * the fake-review and field-partner checks are rules-first, with an AI
--     second opinion only on request (paid);
--   * every AI output carries a disclaimer;
--   * #1 / #2 AI lead qualification returns HOT / WARM / NURTURE / COLD;
--   * learning from outcomes (#4 matching weights, #6 deal scores) stays off
--     until Phase 2 - the data keeps being collected.

ALTER TYPE ai_score_level ADD VALUE IF NOT EXISTS 'nurture';

ALTER TABLE ai_activities ADD COLUMN IF NOT EXISTS disclaimer TEXT;

UPDATE ai_activities SET payer = 'user';
ALTER TABLE ai_activities DROP CONSTRAINT IF EXISTS ai_activities_payer_check;
ALTER TABLE ai_activities ADD CONSTRAINT ai_activities_payer_check CHECK (payer = 'user');
ALTER TABLE ai_activities ALTER COLUMN payer SET DEFAULT 'user';

-- Activities that are now user-asked buttons, with their credit price.
UPDATE ai_activities SET label = 'Lead qualification + rating', credits = 2,
  description = 'Serchi reads the lead''s notes: intent, budget, location, timeline, a summary and a HOT / WARM / NURTURE / COLD rating',
  disclaimer = 'AI reading of the lead''s notes. Indicative only - confirm the details with the customer.'
  WHERE activity_key = 'lead_insight';
UPDATE ai_activities SET label = 'Read a lead with AI', credits = 1, is_active = true,
  description = 'Reads an inbound lead email the rules could not, and suggests the fields to check',
  disclaimer = 'AI suggestion. Check every field against the original message before creating the lead.'
  WHERE activity_key = 'email_lead_parse';
UPDATE ai_activities SET label = 'Review second opinion', credits = 2, is_active = true,
  description = 'AI view on whether a review is fake, incentivised or abusive, on top of the rule-based filter',
  disclaimer = 'AI second opinion only. The moderator makes the decision.'
  WHERE activity_key = 'review_screen';
UPDATE ai_activities SET label = 'Field-task second opinion', credits = 3, is_active = true, max_output_tokens = 500,
  description = 'AI view on a field-partner submission: its fraud signals and up to 3 photos (screenshots, map imagery, photos of screens)',
  disclaimer = 'AI second opinion only. It can raise a submission for review, never clear it; a person makes the decision.'
  WHERE activity_key = 'field_fraud_review';
UPDATE ai_activities SET label = 'Document analysis', credits = 25,
  description = 'Classifies a property document, summarises it and flags risks: charges, litigation, compliance, possession, anomalies',
  disclaimer = 'AI working analysis of the document. Not legal advice - verify every point with a qualified advocate before relying on it.'
  WHERE activity_key = 'document_analysis';
UPDATE ai_activities SET
  disclaimer = 'AI working-draft review. Not legal advice - have your advocate review the document before execution.'
  WHERE activity_key = 'agreement_review';
UPDATE ai_activities SET label = 'Translation drafts', credits = 2,
  description = 'Drafts missing interface translations for a person to review',
  disclaimer = 'AI draft translation. A native speaker should review it.'
  WHERE activity_key = 'translation';

-- Safety checks and parsing that now run on rules / self-hosted tools only.
UPDATE ai_activities SET is_active = false
  WHERE activity_key IN ('image_contact_scan', 'image_origin_check', 'scan_transcribe', 'notice_extract', 'chat_intent_parse');

-- Wallet: a user-set low-balance alert and optional daily / monthly caps.
ALTER TABLE ai_wallets
  ADD COLUMN IF NOT EXISTS low_balance_alert INT CHECK (low_balance_alert IS NULL OR low_balance_alert >= 0),
  ADD COLUMN IF NOT EXISTS daily_cap INT CHECK (daily_cap IS NULL OR daily_cap > 0),
  ADD COLUMN IF NOT EXISTS monthly_cap INT CHECK (monthly_cap IS NULL OR monthly_cap > 0);

-- The moderator-requested AI second opinion on a review.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ai_opinion JSONB;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('ai.low_balance_alert', '25'::jsonb, 'ai', 'Default credits level below which a user is alerted (each user may set their own)'),
  ('ai.default_disclaimer', '"AI-generated output. Indicative only - not financial or legal advice. Check it before relying on it."'::jsonb, 'ai', 'Shown on any AI output whose activity has no disclaimer of its own'),
  ('opportunity.learning_enabled', 'false'::jsonb, 'ai', 'Refine deal scores from past conversions (Phase 2; the history is collected meanwhile)')
ON CONFLICT (config_key) DO NOTHING;

-- Phase 1: rule-based weights + A/B testing; learning switches on in Phase 2.
UPDATE app_config SET value = 'false'::jsonb WHERE config_key = 'matching.learning_enabled';
INSERT INTO app_config (config_key, value, category, description) VALUES
  ('matching.learning_enabled', 'false'::jsonb, 'matching', 'Learn matching weights from outcomes (Phase 2)')
ON CONFLICT (config_key) DO NOTHING;
UPDATE app_config SET value = 'false'::jsonb WHERE config_key IN ('reviews.ai_filter_enabled', 'dd.ai_enabled');

-- #14: an indicative estimate, never a valuation.
UPDATE app_config SET value = '"Indicative estimate based on available platform data. It is not a valuation. Verify independently before transacting."'::jsonb
  WHERE config_key = 'exchange.valuation_disclaimer';
