-- =====================================================================
-- Migration: 034_verification_duplicates_fraud.sql
-- Project  : PropertySerch.com
-- Purpose  : Annexure A sec. 9 + Module 19 (Fraud Detection):
--              9.1 four-level property verification (System / Seller /
--                  Legally / Site Verified) with search boosts;
--              9.2 four-layer anti-duplicate detection (image fingerprint,
--                  address/geo, metadata, text similarity);
--              9.3 auto-resolution (mandate-verification routing, update
--                  existing, cancel) - first valid timestamp + user wins;
--              9.4/9.5 cumulative fraud risk score with Green / Yellow /
--                  Red / Critical actions, appeals and repeat-offender
--                  suspension;
--              sec. 11.2 image-level blocking (contact details in images,
--                  visiting cards) and geo mismatch from photo EXIF.
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE properties
    ADD COLUMN verification_level  SMALLINT NOT NULL DEFAULT 0 CHECK (verification_level BETWEEN 0 AND 4),
    ADD COLUMN fraud_score         SMALLINT,
    ADD COLUMN fraud_band          VARCHAR(10) CHECK (fraud_band IS NULL OR fraud_band IN ('green', 'yellow', 'red', 'critical')),
    ADD COLUMN fraud_factors       JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN fraud_assessed_at   TIMESTAMPTZ,
    ADD COLUMN under_review        BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN review_due_at       TIMESTAMPTZ,
    ADD COLUMN duplicate_of        UUID REFERENCES properties(id) ON DELETE SET NULL,
    ADD COLUMN duplicate_status    VARCHAR(20) CHECK (duplicate_status IS NULL OR duplicate_status IN ('blocked', 'flagged', 'resolved'));

CREATE INDEX idx_properties_fraud_band ON properties(fraud_band) WHERE fraud_band IN ('yellow', 'red', 'critical');
CREATE INDEX idx_properties_under_review ON properties(under_review) WHERE under_review;

ALTER TABLE property_media
    ADD COLUMN phash          BIGINT,
    ADD COLUMN width          INTEGER,
    ADD COLUMN height         INTEGER,
    ADD COLUMN exif_lat       NUMERIC(10, 7),
    ADD COLUMN exif_lng       NUMERIC(10, 7),
    ADD COLUMN exif_taken_at  TIMESTAMPTZ,
    ADD COLUMN scan_status    VARCHAR(10) CHECK (scan_status IS NULL OR scan_status IN ('clean', 'flagged', 'blocked')),
    ADD COLUMN scan_reasons   JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX idx_property_media_phash ON property_media(phash) WHERE phash IS NOT NULL;

-- 9.1 Four-level verification requests / results per listing.
CREATE TABLE property_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    level           SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
    status          VARCHAR(12) NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'in_progress', 'verified', 'rejected')),
    checks          JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes           TEXT,
    auto_requested  BOOLEAN NOT NULL DEFAULT false,
    requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at          TIMESTAMPTZ,
    decided_at      TIMESTAMPTZ,
    CONSTRAINT uq_property_verification_level UNIQUE (property_id, level)
);

CREATE INDEX idx_property_verifications_status ON property_verifications(status);

-- 9.2 Duplicate findings (one row per pair + layer).
CREATE TABLE duplicate_matches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    original_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    layer               VARCHAR(10) NOT NULL CHECK (layer IN ('image', 'geo', 'metadata', 'text')),
    similarity          NUMERIC(5, 2),
    decision            VARCHAR(10) NOT NULL CHECK (decision IN ('block', 'flag')),
    same_lister         BOOLEAN NOT NULL DEFAULT false,
    detail              TEXT,
    status              VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    resolution          VARCHAR(30),
    resolved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_duplicate_match UNIQUE (property_id, original_id, layer)
);

CREATE INDEX idx_duplicate_matches_open ON duplicate_matches(status) WHERE status = 'open';

-- 9.3 Mandate-verification routing requests between the new and the
-- original lister, and the partner record created when accepted.
CREATE TABLE duplicate_routing_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    original_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    requester_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_lister_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    split               JSONB NOT NULL DEFAULT '{}'::jsonb,
    note                TEXT,
    responded_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE property_partners (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    partner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    split_percent   NUMERIC(5, 2) NOT NULL,
    via             VARCHAR(30) NOT NULL DEFAULT 'duplicate_routing',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_property_partner UNIQUE (property_id, partner_user_id)
);

-- 9.4 Fraud assessments - append-only history of every score.
CREATE TABLE fraud_assessments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    score           SMALLINT NOT NULL,
    band            VARCHAR(10) NOT NULL,
    factors         JSONB NOT NULL DEFAULT '[]'::jsonb,
    action          VARCHAR(30),
    trigger         VARCHAR(30),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fraud_assessments_property ON fraud_assessments(property_id, created_at DESC);

-- 9.5 Appeals against a critical auto-rejection.
CREATE TABLE listing_appeals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,
    evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
    status          VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'upheld', 'dismissed')),
    decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    decision_note   TEXT,
    decided_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users flagged by fraud rules (critical listings, repeat offences).
CREATE TABLE user_flags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason          VARCHAR(60) NOT NULL,
    property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_flags_user ON user_flags(user_id, created_at DESC);

-- "Multiple accounts from same phone / IP" (public IPs only).
CREATE TABLE user_ips (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip          VARCHAR(64) NOT NULL,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, ip)
);

CREATE INDEX idx_user_ips_ip ON user_ips(ip);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('fraud.weights',
   '{"duplicate_images": 20, "contact_in_text": 30, "phone_visible": 15, "url_link": 15, "unusual_price": 25,
     "new_lister_high_value": 20, "suspicious_payment": 40, "rapid_listings": 25, "unverified_contact": 10,
     "shared_accounts": 30, "behaviour_anomaly": 15, "stolen_content": 50, "negative_reviews": 25}',
   'fraud', 'Sec. 9.4 fraud risk points per factor (cumulative, capped at 100).'),
  ('fraud.bands', '{"yellow": 21, "red": 41, "critical": 71}', 'fraud',
   'Sec. 9.5 - Green below yellow, Yellow / Red / Critical from these scores.'),
  ('fraud.auto_approve_green', 'true', 'fraud',
   'Sec. 9.5 - Green residential listings go live instantly; Yellow go live with an Under Review banner.'),
  ('fraud.review_sla_hours', '{"yellow": 2, "red": 24}', 'fraud',
   'Sec. 9.5 manual review windows.'),
  ('fraud.suspend_after_critical', '3', 'fraud',
   'Sec. 9.5 - repeat rejections: critical auto-rejections in 90 days before the account is suspended.'),
  ('fraud.new_lister_days', '30', 'fraud',
   'A lister account younger than this (with no verified KYC) counts as new for the high-value factor.'),
  ('fraud.high_value_threshold', '10000000', 'fraud',
   'Price (INR) above which a new unverified lister adds risk; also the Legally Verified auto-request threshold.'),
  ('fraud.rapid_listings_per_day', '10', 'fraud',
   'Listings by one user in 24 hours that count as rapid listing.'),
  ('fraud.unusual_price_percent', '50', 'fraud',
   'Price per sq.ft this % above / below the circle-rate median counts as unusual.'),
  ('fraud.payment_red_flags',
   '["advance payment", "pay advance", "token amount online", "pay before visit", "booking amount upfront", "crypto", "bitcoin", "usdt", "gift card", "western union", "moneygram", "send money", "upi only"]',
   'fraud', 'Sec. 9.4 suspicious payment request phrases.'),
  ('fraud.image_scan_enabled', 'true', 'fraud',
   'Sec. 11.2 - scan every uploaded image for phone numbers, emails and addresses (AI vision when ANTHROPIC_API_KEY is set, visiting-card heuristic otherwise).'),
  ('fraud.geo_mismatch_km', '5', 'fraud',
   'Photo GPS (EXIF) farther than this from the listing location is a geo mismatch.'),
  ('duplicates.thresholds', '{"image_max_hamming": 6, "geo_radius_m": 50, "address_similarity": 0.6, "price_similar_percent": 10, "text_block": 0.95, "text_warn": 0.85}', 'fraud',
   'Sec. 9.2 - image near-duplicate (Hamming distance on the 64-bit fingerprint; 6 = ~90% similar), geo radius, fuzzy address, similar price, text similarity block / warn.'),
  ('duplicates.routing_split', '{"original": 50, "requester": 50}', 'fraud',
   'Sec. 9.3 - predefined commission split when a mandate-verification routing request is accepted.'),
  ('verification.search_boost', '{"1": 5, "2": 15, "3": 25, "4": 35}', 'fraud',
   'Sec. 9.1 search boost per verification level (System / Seller / Legally / Site Verified).'),
  ('verification.sla_hours', '{"2": 24, "3": 72, "4": 120}', 'fraud',
   'Target turnaround per verification level.')
ON CONFLICT (config_key) DO NOTHING;
