-- =====================================================================
-- Migration: 031_investor_crm_workspace.sql
-- Project  : PropertySerch.com
-- Purpose  : Sec. 13.2A Full CRM for customers - HNI investors from joining,
--            everyone else (incl. NRI) after 5 closed deals or 15 referrals.
--            The upgrade is permanent ("downgrade never applies"), so the
--            moment it happens is recorded. SLA per investor pipeline stage
--            (sec. 13.2 "SLA tracking per stage") is admin-configurable.
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE customers ADD COLUMN full_crm_since TIMESTAMPTZ;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('workspace.stage_sla_days', '{"lead": 2, "deal_interest": 5, "due_diligence": 14, "negotiation": 10}', 'crm',
   'Investor CRM workspace: expected days in each deal stage before it is flagged overdue (SLA tracking).')
ON CONFLICT (config_key) DO NOTHING;
