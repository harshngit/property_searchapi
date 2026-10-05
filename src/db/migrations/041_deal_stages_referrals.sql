-- =====================================================================
-- Migration: 041_deal_stages_referrals.sql
-- Project  : PropertySerch.com
-- Purpose  : Move live deals onto the contract pipeline and record the
--            loan / insurance referral steps (referral-only facilitation -
--            "not needed" is a valid outcome, e.g. cash buyers, rentals).
--              booking, documentation -> legal_coordination
-- DB       : PostgreSQL
-- =====================================================================
ALTER TABLE deals
    ADD COLUMN loan_referral_status       VARCHAR(15) NOT NULL DEFAULT 'pending'
        CHECK (loan_referral_status IN ('pending', 'not_needed', 'referred', 'sanctioned', 'disbursed')),
    ADD COLUMN loan_lender                VARCHAR(150),
    ADD COLUMN insurance_referral_status  VARCHAR(15) NOT NULL DEFAULT 'pending'
        CHECK (insurance_referral_status IN ('pending', 'not_needed', 'referred', 'issued')),
    ADD COLUMN insurance_provider         VARCHAR(150),
    ADD COLUMN legal_advocate             VARCHAR(150),
    ADD COLUMN legal_notes                TEXT;

-- Rentals rarely involve a home loan / property insurance referral.
UPDATE deals d SET loan_referral_status = 'not_needed', insurance_referral_status = 'not_needed'
FROM properties p WHERE p.id = d.property_id AND p.transaction_type = 'rent';

UPDATE deals SET stage = 'legal_coordination' WHERE stage IN ('booking', 'documentation');

-- SLA days per stage (admin-configurable; replaces the old keys).
UPDATE app_config SET value = '{"inquiry": 2, "requirement": 2, "match": 3, "site_visit": 5, "negotiation": 7, "legal_coordination": 15, "loan_referral": 10, "insurance_referral": 5, "payment": 30}'
WHERE config_key = 'orchestration.stage_sla_days';

ALTER TABLE orchestration_events DROP CONSTRAINT IF EXISTS orchestration_events_kind_check;
ALTER TABLE orchestration_events ADD CONSTRAINT orchestration_events_kind_check
    CHECK (kind IN ('auto_advance', 'blocked', 'override', 'sla_alert', 'invoice', 'invoice_overdue', 'milestone', 'referrals'));
