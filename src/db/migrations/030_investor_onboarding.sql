-- =====================================================================
-- Migration: 030_investor_onboarding.sql
-- Project  : PropertySerch.com
-- Purpose  : Screen 2 NRI / HNI onboarding - property interest type,
--            relationship-manager introduction (auto-assignment on sign-up);
--            HNI investors get Full CRM from joining (sec. 33 exemption).
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE investor_profiles
    ADD COLUMN property_interest_types JSONB NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('investor.auto_assign_manager', 'true', 'investor',
   'Assign a relationship manager (least-loaded internal sales user) when an NRI / HNI profile is created, and introduce them to the investor.'),
  ('full_crm_exempt_investor_types', '["hni"]', 'crm',
   'Investor types with Full CRM from the moment of joining (sec. 33 - HNI; add "nri" only if the client decides so).')
ON CONFLICT (config_key) DO NOTHING;

-- SEO landing pages /for-nri and /for-hni (and /tools) in sitemap.xml -
-- appended only where missing so admin edits are kept.
UPDATE app_config
SET value = value || (
  SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
  FROM jsonb_array_elements_text('["/for-nri", "/for-hni", "/tools"]'::jsonb) p
  WHERE NOT (app_config.value ? p)
)
WHERE config_key = 'site.sitemap_static_paths' AND jsonb_typeof(value) = 'array';
