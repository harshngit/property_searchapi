-- Module 29 - Gamification & Engagement System.
--   Points engine   gamification_rules (admin-editable points per action) and
--                   an append-only ledger. Points are derived from what
--                   already happened on the platform (a listing approved, a
--                   lead answered inside its SLA, a site visit completed, a
--                   deal closed ...) so nothing can be self-awarded.
--   Tiers           Bronze / Silver / Gold / Platinum / Elite by lifetime
--                   points - thresholds in app_config.
--   Leaderboards    platform-wide and area-wise (city), month / quarter / all time.
-- Referral-based tiers and leaderboards stay in Phase 2 with CONNECT (sec. 33).

CREATE TABLE gamification_rules (
    action_key   VARCHAR(40) PRIMARY KEY,
    label        VARCHAR(120) NOT NULL,
    description  VARCHAR(300),
    points       INTEGER NOT NULL DEFAULT 0,
    audience     VARCHAR(15) NOT NULL DEFAULT 'professional' CHECK (audience IN ('professional', 'customer', 'all')),
    is_active    BOOLEAN NOT NULL DEFAULT true,
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gamification_points (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_key   VARCHAR(40) NOT NULL,
    points       INTEGER NOT NULL,
    -- What earned it: one award per (user, action, entity), ever.
    entity_id    VARCHAR(80) NOT NULL,
    city         VARCHAR(120),
    note         VARCHAR(300),
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    earned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, action_key, entity_id)
);

CREATE INDEX idx_gamification_points_user ON gamification_points(user_id, earned_at DESC);
CREATE INDEX idx_gamification_points_board ON gamification_points(earned_at, lower(city));

CREATE OR REPLACE FUNCTION trigger_gamification_points_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'gamification_points is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gamification_points_append_only
BEFORE UPDATE ON gamification_points
FOR EACH ROW EXECUTE FUNCTION trigger_gamification_points_append_only();

CREATE TABLE gamification_profiles (
    user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_points       INTEGER NOT NULL DEFAULT 0,
    tier               VARCHAR(20) NOT NULL DEFAULT 'bronze',
    tier_since         TIMESTAMPTZ NOT NULL DEFAULT now(),
    streak_weeks       SMALLINT NOT NULL DEFAULT 0,
    best_streak_weeks  SMALLINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO gamification_rules (action_key, label, description, points, audience, sort_order) VALUES
  ('listing_approved',     'Listing approved',               'A listing you posted passed review and went live.',                         20,  'all',          1),
  ('listing_verified',     'Listing verified',               'One of your listings earned the Verified mark.',                            15,  'all',          2),
  ('lead_fast_response',   'Lead answered within the SLA',   'You made first contact with a lead before its response deadline.',          10,  'professional', 3),
  ('site_visit_completed', 'Site visit completed',           'A site visit on your deal was completed.',                                  15,  'professional', 4),
  ('deal_closed',          'Deal closed',                    'A deal you handled closed successfully.',                                   100, 'professional', 5),
  ('mandate_activated',    'Exclusive mandate activated',    'An exclusive mandate you signed became active.',                            30,  'all',          6),
  ('review_received',      'Review of 4 stars or more',      'A published review rated you 4 or 5 stars.',                                10,  'professional', 7),
  ('profile_verified',     'Verification approved',          'A verification on your profile (KYC, RERA, GST ...) was approved.',         25,  'all',          8),
  ('requirement_posted',   'Requirement posted',             'You posted what you are looking for.',                                      10,  'customer',     9),
  ('review_written',       'Review written',                 'A review you wrote was published.',                                         5,   'customer',     10),
  ('deal_completed',       'Purchase / lease completed',     'A deal you were the customer on closed successfully.',                      50,  'customer',     11),
  ('daily_login',          'Daily sign-in',                  'Signed in on a new day.',                                                   2,   'all',          12),
  ('weekly_streak',        'Weekly streak',                  'Active for another week in a row (from the second week).',                  10,  'all',          13),
  ('manual_adjustment',    'Adjustment by A R Buildwel',     'Bonus or correction recorded by an admin with a reason.',                   0,   'all',          99);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('gamification.enabled', 'true', 'gamification', 'Master switch for points, tiers and leaderboards'),
  ('gamification.tiers', '[{"key":"bronze","label":"Bronze","min":0},{"key":"silver","label":"Silver","min":250},{"key":"gold","label":"Gold","min":1000},{"key":"platinum","label":"Platinum","min":3000},{"key":"elite","label":"Elite","min":7500}]', 'gamification', 'Tier thresholds by lifetime points (lowest first)'),
  ('gamification.leaderboard_size', '50', 'gamification', 'How many ranks a leaderboard shows'),
  ('gamification.leaderboard_min_points', '1', 'gamification', 'Points needed in the period to appear on a leaderboard')
ON CONFLICT (config_key) DO NOTHING;
