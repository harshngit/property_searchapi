-- =====================================================================
-- Migration: 032_matching_engine.sql
-- Project  : PropertySerch.com
-- Purpose  : Module 4 / sec. 7 Property-Requirement Matching Engine and the
--            Engine 5 Requirement Marketplace:
--              - binding weights (location 30, budget 25, type 20, area 15,
--                amenities 10) and thresholds (Hot 90 / Warm 75 /
--                Lukewarm 60) - all admin-configurable;
--              - requirement_matches: the continuously maintained match set
--                (on listing / requirement change + nightly batch) with the
--                parameter-wise breakdown, alert / digest state and broker
--                "send to buyer" for Lukewarm matches;
--              - match_events: shown / clicked / enquired / converted - the
--                behaviour data the AI layer learns weights from, per A/B
--                variant;
--              - requirement_shares: mandate-verification routing of a
--                requirement to a partner broker;
--              - requirement expiry (60 days, 3-day warning, renewal) and
--                Exclusive Mandate boost / price compatibility.
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE requirements
    ADD COLUMN latitude          NUMERIC(10, 7),
    ADD COLUMN longitude         NUMERIC(10, 7),
    ADD COLUMN amenities         JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN expires_at        TIMESTAMPTZ,
    ADD COLUMN expiry_warned_at  TIMESTAMPTZ,
    ADD COLUMN expired_at        TIMESTAMPTZ,
    ADD COLUMN renewal_count     SMALLINT NOT NULL DEFAULT 0;

UPDATE requirements SET expires_at = created_at + interval '60 days' WHERE expires_at IS NULL;

-- Seller's minimum acceptable price under an Exclusive Mandate - private,
-- used only for the Price-Compatible flag shown to the A R representative.
ALTER TABLE properties ADD COLUMN min_acceptable_price NUMERIC(16, 2);

CREATE TABLE requirement_matches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id      UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    score               SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
    rank_score          NUMERIC(6, 2) NOT NULL,
    tier                VARCHAR(10) NOT NULL CHECK (tier IN ('hot', 'warm', 'lukewarm', 'none')),
    breakdown           JSONB NOT NULL DEFAULT '{}'::jsonb,
    price_compatible    BOOLEAN NOT NULL DEFAULT false,
    variant             VARCHAR(10) NOT NULL DEFAULT 'A',
    first_matched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at         TIMESTAMPTZ,
    broker_notified_at  TIMESTAMPTZ,
    digest_sent_at      TIMESTAMPTZ,
    sent_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    sent_at             TIMESTAMPTZ,
    CONSTRAINT uq_requirement_match UNIQUE (requirement_id, property_id)
);

CREATE INDEX idx_requirement_matches_property ON requirement_matches(property_id);
CREATE INDEX idx_requirement_matches_tier     ON requirement_matches(tier);

CREATE TABLE match_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id  UUID REFERENCES requirements(id) ON DELETE SET NULL,
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    event           VARCHAR(20) NOT NULL CHECK (event IN ('shown', 'clicked', 'enquired', 'visited', 'converted', 'sent')),
    event_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    variant         VARCHAR(10) NOT NULL DEFAULT 'A',
    score           SMALLINT,
    breakdown       JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_events_event   ON match_events(event, created_at);
CREATE INDEX idx_match_events_variant ON match_events(variant, event);
-- One "shown" per requirement + property per day keeps the denominator honest.
CREATE UNIQUE INDEX uq_match_events_shown_daily
    ON match_events(requirement_id, property_id, event_date) WHERE event = 'shown';

CREATE TABLE requirement_shares (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id  UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    shared_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
    note            TEXT,
    responded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_requirement_share UNIQUE (requirement_id, shared_with)
);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('matching.weights', '{"location": 30, "budget": 25, "type": 20, "area": 15, "amenities": 10}', 'matching',
   'Sec. 7.1 binding match weights (sum 100): location / budget / property type / area / amenities.'),
  ('matching.thresholds', '{"hot": 90, "warm": 75, "lukewarm": 60}', 'matching',
   'Sec. 7.2 - Hot (instant alerts), Warm (daily digest), Lukewarm (visible only when a broker sends it); below Lukewarm is not shown.'),
  ('city_match_radius_km', '50', 'matching',
   'Sec. 7.1 default match radius (km); cities.match_radius_km overrides per city. Location scores 100% inside the radius, falling to 0% at 50 km beyond it.'),
  ('matching.type_similarity', '{"villa": ["independent_house", "farmhouse"], "independent_house": ["villa"], "farmhouse": ["villa"]}', 'matching',
   'Sec. 7.1 - property types scored 70% as a "similar class" of each other.'),
  ('matching.mandate_boost', '20', 'matching',
   'Sec. 7 / Module 46 - ranking boost for listings under an active Exclusive Mandate.'),
  ('matching.price_compatible_boost', '10', 'matching',
   'Sec. 7 - ranking boost when an exclusive buyer''s max budget >= an exclusive seller''s minimum price (flag visible to A R staff only).'),
  ('matching.learning_enabled', 'true', 'matching',
   'Sec. 7.4 - tune match weights nightly from shown / clicked / enquired / converted behaviour.'),
  ('matching.learning_min_events', '50', 'matching',
   'Sec. 7.4 - minimum positive match events (click / enquiry / visit / conversion) before weights are learned.'),
  ('matching.learning_max_shift_percent', '30', 'matching',
   'Sec. 7.4 - a learned weight can move at most this % away from its configured value.'),
  ('matching.learned_weights', 'null', 'matching',
   'Sec. 7.4 - weights learned by the nightly job (null = not enough data yet). Written by the system.'),
  ('matching.pattern_boosts', '{}', 'matching',
   'Sec. 7.4 - ranking boosts for historically converting segments (city|type|budget band). Written by the nightly job.'),
  ('matching.ab_test', '{"enabled": false, "split_percent": 50, "variant_b_weights": {"location": 35, "budget": 25, "type": 15, "area": 15, "amenities": 10}}', 'matching',
   'Sec. 7.4 - A/B test: users in variant B are matched with variant_b_weights; compare conversion per variant and promote the winner.'),
  ('matching.hot_whatsapp_template', '""', 'matching',
   'Approved WhatsApp template for Hot Match alerts (variables: listing title, match %, locality). Empty = in-app only.'),
  ('matching.digest_hour', '9', 'matching',
   'Hour (IST, 0-23) the daily Warm Match digest is sent.'),
  ('requirement.validity_days', '60', 'matching',
   'Engine 5 - requirements auto-expire after this many days; renewal extends by the same period.'),
  ('requirement.expiry_warning_days', '3', 'matching',
   'Engine 5 - warn the buyer this many days before a requirement expires.')
ON CONFLICT (config_key) DO NOTHING;
