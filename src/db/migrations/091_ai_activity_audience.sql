-- Who an AI action is for, so a customer's price list on the website shows
-- only the actions they can ask for. Staff tools (reading an inbound lead,
-- review / field-task second opinions, translation drafts, CRM lead rating)
-- stay on the CRM AI credits page, which lists every action.
--
--   audience  customer - asked for by customers on the website (and the CRM)
--             staff    - CRM tools only

ALTER TABLE ai_activities ADD COLUMN IF NOT EXISTS audience VARCHAR(10) NOT NULL DEFAULT 'customer';
ALTER TABLE ai_activities DROP CONSTRAINT IF EXISTS ai_activities_audience_check;
ALTER TABLE ai_activities ADD CONSTRAINT ai_activities_audience_check CHECK (audience IN ('customer', 'staff'));

UPDATE ai_activities SET audience = 'staff'
WHERE activity_key IN ('email_lead_parse', 'review_screen', 'field_fraud_review', 'translation', 'lead_insight', 'chat_intent_parse', 'image_contact_scan', 'image_origin_check', 'notice_extract', 'scan_transcribe');
