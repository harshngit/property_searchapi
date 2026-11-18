-- =====================================================================
-- Migration: 097_ai_platform_spend_cap.sql
-- Project  : PropertySerch.com
-- Purpose  : Production OpenAI / Anthropic keys are about to go live. Today
--            the only spend ceiling is per-user (ai_wallets.daily_cap /
--            monthly_cap, in credits) - platform-paid activities (credits=0,
--            e.g. review screening, fraud checks, translation) bypass that
--            entirely and still cost real USD. This adds one platform-wide
--            monthly ceiling, in USD, across every AI run regardless of who
--            pays. NULL (the default) means no cap - unchanged behaviour
--            until an admin sets a number in Admin Panel -> Settings.
-- DB       : PostgreSQL
-- =====================================================================

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('ai.platform_monthly_cap_usd', 'null', 'ai', 'Safety ceiling on total AI spend (USD, all providers, all activities - user-paid and platform-paid alike) in the current calendar month (Asia/Kolkata). NULL (default) = no cap. Once the total for the month reaches this, every AI call is refused with a clear message until the next month or until an admin raises/clears it.')
ON CONFLICT (config_key) DO NOTHING;
