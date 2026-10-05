-- =====================================================================
-- Migration: 040_deal_stages_enum.sql
-- Project  : PropertySerch.com
-- Purpose  : Annexure A Engine 2 deal pipeline - the contract's stages:
--            Lead -> Requirement -> Match -> Site Visit -> Negotiation ->
--            Legal Coordination -> Loan Referral -> Insurance Referral ->
--            Payment Confirmation -> Closure.
--            New enum values only (used from 041 on - Postgres cannot use a
--            value in the transaction that adds it). 'inquiry' is shown as
--            Lead, 'payment' as Payment Confirmation, 'closed_won' as
--            Closure. 'booking' / 'documentation' stay in the type for old
--            history rows but are no longer used.
-- DB       : PostgreSQL
-- =====================================================================
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'requirement' BEFORE 'site_visit';
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'match' BEFORE 'site_visit';
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'legal_coordination' AFTER 'negotiation';
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'loan_referral' AFTER 'legal_coordination';
ALTER TYPE deal_stage ADD VALUE IF NOT EXISTS 'insurance_referral' AFTER 'loan_referral';
