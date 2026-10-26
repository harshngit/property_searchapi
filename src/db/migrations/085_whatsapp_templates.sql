-- =====================================================================
-- Migration: 085_whatsapp_templates.sql
-- Project  : PropertySerch.com
-- Purpose  : Client-approved spec defines 29 named WhatsApp templates (see
--            PropertySerch_WhatsApp_Templates_Developer_Mapping.pdf). Module
--            43 (notificationIntel.service.js) already sends WhatsApp for
--            every notification type through ONE generic template - this
--            adds a per-type template registry and lets a trigger site pass
--            the exact structured content (body variables, a dynamic button
--            URL suffix, a document/image header) its chosen template needs,
--            instead of the generic [title, body] pair.
-- DB       : PostgreSQL
-- =====================================================================

-- `whatsapp_content` shape (both columns, same shape): nullable JSONB
--   { "vars": ["Rahul", "3 BHK Flat, Dwarka Sector 12", ...],
--     "buttonUrl": "dwarka-3bhk-20481",
--     "headerDocument": { "link": "https://...", "filename": "..." },
--     "headerImage": { "link": "https://..." } }
-- Stored on both tables (not just `notifications`) because
-- notificationIntel.service.js's retry/held-message queue worker
-- (processQueue) rebuilds the outgoing message purely from the
-- notification_deliveries row, with no access back to the original
-- notifications row once queued.
ALTER TABLE notifications ADD COLUMN whatsapp_content JSONB;
ALTER TABLE notification_deliveries ADD COLUMN whatsapp_content JSONB;

-- ar_invoice_due_reminder (7 days before due) - no existing trigger reads
-- this; dedupe flag mirrors the existing overdue_alerted_at column.
ALTER TABLE invoices ADD COLUMN due_soon_alerted_at TIMESTAMPTZ;

-- ar_site_visit_reminder (2 hours before a scheduled visit) - no existing
-- trigger reads this either.
ALTER TABLE site_visits ADD COLUMN reminder_sent_at TIMESTAMPTZ;

-- ar_lead_qualification (Buy/Rent/Sell quick-reply) -> ar_lead_qualified_summary
-- on reply, or ar_tc_escalation after two unanswered attempts (no AI-voice
-- step - see leadQualification.service.js).
ALTER TABLE leads ADD COLUMN qualification_sent_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN qualification_reminded_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN qualification_answered_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN qualification_escalated_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN qualification_purpose VARCHAR(10);

-- ar_fee_consent_request / ar_mandate_offer / ar_mandate_complete_link, over
-- WhatsApp, for a seller/rent-out chat submission with no app account.
-- Interest-only by design: no OTP and no mandate row is created from this
-- reply alone (mandate.service.js's consent/pricing pipeline is account-
-- based) - it just records what the seller chose so staff complete the real
-- OTP + mandate when they review the listing (chatIntake.service.js).
ALTER TABLE chat_listing_submissions ADD COLUMN fee_consent_requested_at TIMESTAMPTZ;
ALTER TABLE chat_listing_submissions ADD COLUMN fee_consent_response VARCHAR(10);
ALTER TABLE chat_listing_submissions ADD COLUMN mandate_type_requested VARCHAR(10);

-- Per-type template registry. `_default` keeps today's generic template as
-- the fallback for any type not listed here. Admin-editable via the
-- existing app_config update path (config.service.js) - no new CRUD needed.
INSERT INTO app_config (config_key, value, category, description) VALUES
  ('notifications.whatsapp_templates', '{
    "_default": "ps_notification",
    "inquiry_assigned": "ar_rep_new_lead",
    "inquiry_received": "ar_inquiry_received",
    "match_alert": "ar_match_found",
    "site_visit": "ar_site_visit_confirmed",
    "site_visit_reminder": "ar_site_visit_reminder",
    "deal_stage_update": "ar_deal_stage_update",
    "mandate_pending_ack": "ar_mandate_rep_ack",
    "mandate_benefit": "ar_benefit_delivered",
    "mandate_expiry_1d": "ar_mandate_expiry_reminder",
    "mandate_expiry_7d": "ar_mandate_expiry_reminder",
    "mandate_expiry_30d": "ar_mandate_expiry_reminder",
    "fee_consent_request": "ar_fee_consent_request",
    "fee_consent_record": "ar_fee_consent_record",
    "mandate_offer": "ar_mandate_offer",
    "mandate_complete_link": "ar_mandate_complete_link",
    "listing_live": "ar_listing_live",
    "invoice": "ar_invoice_generated",
    "invoice_due_soon": "ar_invoice_due_reminder",
    "invoice_overdue": "ar_invoice_overdue",
    "invoice_overdue_internal": "ar_invoice_overdue_internal",
    "payment_received": "ar_payment_received",
    "lead_qualified_summary": "ar_lead_qualified_summary",
    "lead_tc_escalation": "ar_tc_escalation",
    "market_digest": "ar_daily_market_digest",
    "digest_sponsored": "ar_digest_sponsored",
    "wfh_task_assigned": "ar_wfh_task_assigned",
    "wfh_rep_confirm": "ar_wfh_rep_confirm",
    "wfh_task_result": "ar_wfh_task_result",
    "lead_qualification": "ar_lead_qualification"
  }', 'notifications', 'Module 43 - WhatsApp template name per notification type (client-approved spec). Falls back to _default for any type not listed.')
ON CONFLICT (config_key) DO NOTHING;
