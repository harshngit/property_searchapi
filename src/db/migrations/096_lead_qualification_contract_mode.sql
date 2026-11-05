-- =====================================================================
-- Migration: 096_lead_qualification_contract_mode.sql
-- Project  : PropertySerch.com
-- Purpose  : The "Lead qualification sequence" item on the project status
--            board is a client decision, not a dev task - keep the current
--            flat-hours behaviour ('legacy') live until someone flips
--            lead_qualification.mode to 'contract' in Admin Panel ->
--            Settings. The contract spec (sec. 19 of the client's Master
--            Platform Vision Document / the WhatsApp templates doc):
--              - Off-hours: ar_lead_qualification sends immediately.
--              - Business hours: waits for the assigned rep's own response
--                SLA to be missed first (a human gets the first chance).
--              - No second nudge - HOT waits 10 minutes, anything else 30,
--                then escalates straight to a Telecaller. No AI-voice step
--                (decision: skip it entirely - nothing to call through to).
--              - Human-contact kill switch: an RM/DM/TC logging "Contacted"
--                (markContacted()) stops the cascade for that lead, in
--                either mode.
-- DB       : PostgreSQL
-- =====================================================================

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('lead_qualification.mode', '"legacy"', 'notifications', 'Module 49 lead qualification timing. "legacy" (default, unchanged behaviour): send on assignment regardless of hour, nudge once after reminder_hours, escalate after escalate_hours. "contract": off-hours immediate / business-hours after the rep''s own SLA miss, HOT escalates after hot_wait_minutes, everything else after warm_wait_minutes, no second nudge.'),
  ('lead_qualification.hot_wait_minutes', '10', 'notifications', 'Contract mode only - minutes a HOT lead can go unanswered before ar_tc_escalation fires.'),
  ('lead_qualification.warm_wait_minutes', '30', 'notifications', 'Contract mode only - minutes a non-HOT lead can go unanswered before ar_tc_escalation fires.'),
  ('lead_qualification.business_hours_start', '"09:00"', 'notifications', 'Contract mode only - India time, HH:MM. Before this, a new general enquiry sends ar_lead_qualification immediately.'),
  ('lead_qualification.business_hours_end', '"21:00"', 'notifications', 'Contract mode only - India time, HH:MM. After this, a new general enquiry sends ar_lead_qualification immediately.')
ON CONFLICT (config_key) DO NOTHING;
