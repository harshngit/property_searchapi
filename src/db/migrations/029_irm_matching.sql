-- =====================================================================
-- Migration: 029_irm_matching.sql
-- Project  : PropertySerch.com
-- Purpose  : Module 38 IRM / AI investor-deal matching and Engine 3 AI deal
--            scoring refined by conversion history - admin-tunable weights.
--            (No schema change: matching reads investor_profiles,
--            investor_deal_interactions and opportunity_interests.)
-- DB       : PostgreSQL
-- =====================================================================

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('irm.match_weights', '{"stated": 50, "behaviour": 30, "quality": 20}', 'irm',
   'AI investor-deal match weights: stated preferences (cities, asset classes, ticket), observed behaviour, deal investment score.'),
  ('opportunity.learning_max_adjustment', '10', 'opportunity',
   'Max points the conversion-history learning can add to / subtract from a deal''s rule-based investment score.'),
  ('opportunity.learning_min_interests', '20', 'opportunity',
   'Minimum investor interests on the platform before conversion-history learning is applied.'),
  ('opportunity.learning_prior_weight', '10', 'opportunity',
   'Bayesian smoothing weight - how many interests a segment needs before its own conversion rate dominates.')
ON CONFLICT (config_key) DO NOTHING;
