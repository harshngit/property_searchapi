-- =====================================================================
-- Migration: 033_trust_reputation.sql
-- Project  : PropertySerch.com
-- Purpose  : Module 6 / sec. 8 Trust & Reputation System:
--              - user_verifications: KYC, RERA, GST, company registration
--                and institutional certification, each submitted by the
--                user and verified by A R staff;
--              - trust_scores (+ history): 0-100 from the binding weights
--                Verification 20 / Deal count 30 / Response time 20 /
--                Ratings 25 / Geo-validation 5, recomputed on events and
--                by the daily batch;
--              - user_badges: automatically awarded badges with a 7-day
--                warning before revocation, award badges (Featured Agent,
--                Best Broker) with their period;
--              - reviews: only after a verified interaction; auto-published
--                unless the fraud filter flags them for admin moderation.
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE user_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            VARCHAR(20) NOT NULL CHECK (kind IN ('kyc', 'rera', 'gst', 'company', 'institutional_cert')),
    reference       VARCHAR(120),
    document_path   VARCHAR(500),
    status          VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
    notes           TEXT,
    decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_verification UNIQUE (user_id, kind)
);

CREATE INDEX idx_user_verifications_status ON user_verifications(status);

CREATE TRIGGER set_updated_at_user_verifications
BEFORE UPDATE ON user_verifications
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE trust_scores (
    user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    score                   SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
    components              JSONB NOT NULL DEFAULT '{}'::jsonb,
    inputs                  JSONB NOT NULL DEFAULT '{}'::jsonb,
    search_boost            NUMERIC(6, 2) NOT NULL DEFAULT 0,
    lead_priority           BOOLEAN NOT NULL DEFAULT false,
    region                  VARCHAR(100),
    mandate_bonus_awarded_at TIMESTAMPTZ,
    computed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trust_scores_region ON trust_scores(region, score DESC);

CREATE TABLE trust_score_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score       SMALLINT NOT NULL,
    reason      VARCHAR(60),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trust_score_history_user ON trust_score_history(user_id, created_at DESC);

CREATE TABLE user_badges (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_key   VARCHAR(40) NOT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'warning', 'revoked')),
    period      VARCHAR(20),              -- award badges: '2026-W39', '2026-Q3', '2026'
    region      VARCHAR(100),
    meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
    awarded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    warning_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);

-- One live row per badge (and per period for award badges).
CREATE UNIQUE INDEX uq_user_badges_live ON user_badges(user_id, badge_key, COALESCE(period, '')) WHERE status <> 'revoked';
CREATE INDEX idx_user_badges_user ON user_badges(user_id, status);

CREATE TABLE reviews (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reviewer_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    property_id         UUID REFERENCES properties(id) ON DELETE SET NULL,
    deal_id             UUID REFERENCES deals(id) ON DELETE SET NULL,
    lease_id            UUID REFERENCES leases(id) ON DELETE SET NULL,
    interaction         VARCHAR(20) NOT NULL CHECK (interaction IN ('deal_closed', 'site_visit', 'lease')),
    rating              SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title               VARCHAR(150),
    body                TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'published'
                        CHECK (status IN ('published', 'pending_moderation', 'rejected', 'hidden')),
    fraud_score         SMALLINT NOT NULL DEFAULT 0,
    fraud_reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
    reported_at         TIMESTAMPTZ,
    report_reason       TEXT,
    moderated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    moderated_at        TIMESTAMPTZ,
    moderation_note     TEXT,
    reply               TEXT,
    replied_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One review per reviewer per subject per interaction.
CREATE UNIQUE INDEX uq_reviews_interaction
    ON reviews(reviewer_id, subject_user_id, COALESCE(deal_id, lease_id, property_id));
CREATE INDEX idx_reviews_subject ON reviews(subject_user_id, status);
CREATE INDEX idx_reviews_status  ON reviews(status);

CREATE TRIGGER set_updated_at_reviews
BEFORE UPDATE ON reviews
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('trust.weights', '{"verification": 20, "deals": 30, "response": 20, "ratings": 25, "geo": 5}', 'trust',
   'Sec. 8.1 binding trust score weights (sum 100).'),
  ('trust.verification_items', '{"customer": ["email", "phone", "kyc"], "broker": ["email", "phone", "kyc", "rera", "gst"], "agency_admin": ["email", "phone", "kyc", "rera", "gst"], "builder": ["email", "phone", "kyc", "rera", "gst", "company"]}', 'trust',
   'Which verifications count toward the Verification component for each role (equal share each).'),
  ('trust.deal_count_for_full_score', '25', 'trust',
   'Completed deals at which the Deal Count component reaches 100 (log-scaled below that).'),
  ('trust.response_full_score_minutes', '30', 'trust',
   'Average first-response time (minutes) that scores 100; 0 at response_zero_score_minutes.'),
  ('trust.response_zero_score_minutes', '1440', 'trust',
   'Average first-response time (minutes) at or above which the Response component scores 0.'),
  ('trust.rating_prior', '{"mean": 3.5, "weight": 3}', 'trust',
   'Bayesian prior for the Ratings component so a handful of reviews cannot swing it.'),
  ('trust.mandate_bonus', '5', 'trust',
   'Module 46 - one-time trust bonus on Exclusive Mandate activation.'),
  ('trust.badges',
   '{"verified_user": {"profile_min_percent": 70},
     "verified_broker": {"min_deals": 2, "search_boost": 5},
     "verified_builder": {"min_active_listings": 5, "search_boost": 5},
     "top_broker": {"min_score": 85, "min_deals": 25},
     "highly_rated": {"min_avg": 4.5, "min_reviews": 10, "search_boost": 5},
     "quick_responder": {"min_percent": 90, "within_minutes": 120, "min_inquiries": 5},
     "zero_disputes": {"min_deals": 100},
     "network_builder": {"min_activated": 10, "search_boost": 3},
     "trusted_introducer": {"min_activated": 25, "min_retention_percent": 60},
     "community_champion": {"min_activated": 50},
     "institutional_specialist": {"min_institutional_deals": 5},
     "featured_agent": {"top_per_region": 50, "min_avg": 4.6, "max_dispute_rate_percent": 2},
     "best_broker": {},
     "exclusive_mandate": {}}',
   'trust', 'Sec. 8.2 badge criteria and search boosts - admin-editable.'),
  ('trust.badge_revoke_warning_days', '7', 'trust',
   'Sec. 8.3 - a badge whose criteria lapse is revoked after this many days of warning.'),
  ('reviews.moderation_threshold', '40', 'trust',
   'Review fraud score (0-100) at or above which a review goes to admin moderation instead of auto-publishing.'),
  ('reviews.ai_filter_enabled', 'true', 'trust',
   'Use the AI fake-review classifier in addition to the rule-based signals (needs ANTHROPIC_API_KEY).')
ON CONFLICT (config_key) DO NOTHING;
