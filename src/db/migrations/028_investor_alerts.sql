-- =====================================================================
-- Migration: 028_investor_alerts.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 4 auction alerts + Module 43 Notification Intelligence
--            for investors:
--              - priority alerts (high investment score) go out at once;
--              - other matches are held for the investor's optimal window
--                (default 9:30-10:30 in THEIR time zone - NRIs abroad);
--              - fatigue control: a daily cap per investor, and matches in
--                cities / categories the investor keeps dismissing are
--                suppressed (behavioural);
--              - multi-channel delivery (in-app always, WhatsApp when a
--                template is configured) chosen by the investor.
--            opportunity_alert_log becomes the alert queue + history.
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE investor_profiles
    ADD COLUMN alert_channels     JSONB NOT NULL DEFAULT '["in_app"]'::jsonb,
    ADD COLUMN alert_mode         VARCHAR(10) NOT NULL DEFAULT 'window' CHECK (alert_mode IN ('window', 'instant')),
    ADD COLUMN alert_max_per_day  SMALLINT CHECK (alert_max_per_day IS NULL OR alert_max_per_day BETWEEN 1 AND 50);

ALTER TABLE opportunity_alert_log
    ADD COLUMN status          VARCHAR(12) NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'suppressed')),
    ADD COLUMN scheduled_for   TIMESTAMPTZ,
    ADD COLUMN sent_at         TIMESTAMPTZ,
    ADD COLUMN reason          VARCHAR(60),
    ADD COLUMN channels        JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN match_score     SMALLINT;

-- Existing rows were delivered immediately.
UPDATE opportunity_alert_log SET sent_at = created_at, channels = '["in_app"]'::jsonb WHERE sent_at IS NULL;

CREATE INDEX idx_alert_log_pending ON opportunity_alert_log(scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_alert_log_user_sent ON opportunity_alert_log(user_id, sent_at);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('alerts.window_start', '"09:30"', 'alerts', 'Start of the daily alert window, investor''s local time (Module 43 optimal window).'),
  ('alerts.window_end', '"10:30"', 'alerts', 'End of the daily alert window, investor''s local time.'),
  ('alerts.max_per_day', '3', 'alerts', 'Default maximum non-priority deal alerts per investor per day (fatigue control). Investors can set their own.'),
  ('alerts.dismiss_suppress_threshold', '3', 'alerts', 'Suppress matches in a city + category the investor dismissed this many times in 30 days.'),
  ('alerts.whatsapp_template', '""', 'alerts', 'Approved WhatsApp template name for deal alerts (variables: title, city, price, link). Empty = WhatsApp alerts off.'),
  ('alerts.site_url', '"https://propertyserch.com"', 'alerts', 'Website base URL used in alert links.')
ON CONFLICT (config_key) DO NOTHING;
