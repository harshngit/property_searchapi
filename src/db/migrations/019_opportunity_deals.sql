-- =====================================================================
-- Migration: 019_opportunity_deals.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 4 - Bank Auction & Special Situation deals, plus two
--            supporting changes the rest of the platform needed anyway:
--              - properties.price_value      numeric INR value parsed from
--                                            the free-text `price`, so
--                                            budgets/discounts/ROI can be
--                                            computed and filtered
--              - auction + special-situation fields on properties
--              - opportunity_ingestion_items (pipeline layers 2-5: parse,
--                                            normalise, filter/score, publish)
--              - opportunity_interests       (Lead -> Deal Interest -> Due
--                + opportunity_interest_history  Diligence -> Negotiation ->
--                                            Closure pipeline)
--              - opportunity_alert_log       (one alert per investor/deal)
--              - ai_insight_reviews          (CRM "confirm / override AI
--                                            score" - append-only)
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- properties.price_value - INR, numeric. Backfilled from the free-text
-- price ("2.1 Cr", "85 Lakh", "5000000"); anything unparseable ("Price on
-- Request") stays NULL. Kept in sync by property.service on every write.
-- ---------------------------------------------------------------------
ALTER TABLE properties ADD COLUMN price_value NUMERIC(16, 2)
  CHECK (price_value IS NULL OR price_value >= 0);

UPDATE properties p
SET price_value = CASE
    WHEN m.unit IS NULL OR m.unit = ''                 THEN m.num
    WHEN m.unit IN ('cr', 'crore', 'crores')           THEN m.num * 10000000
    WHEN m.unit IN ('l', 'lac', 'lacs', 'lakh', 'lakhs') THEN m.num * 100000
    WHEN m.unit IN ('k', 'thousand')                    THEN m.num * 1000
    ELSE NULL
  END
FROM (
  SELECT id,
         (regexp_match(lower(regexp_replace(price, '[₹,\s]|rs\.?|inr', '', 'gi')),
                       '^([0-9]+(?:\.[0-9]+)?)([a-z]*)$'))[1]::numeric AS num,
         (regexp_match(lower(regexp_replace(price, '[₹,\s]|rs\.?|inr', '', 'gi')),
                       '^([0-9]+(?:\.[0-9]+)?)([a-z]*)$'))[2] AS unit
  FROM properties
) m
WHERE m.id = p.id AND m.num IS NOT NULL;

CREATE INDEX idx_properties_price_value ON properties(price_value);

-- ---------------------------------------------------------------------
-- Opportunity (auction / special situation) fields on properties
-- ---------------------------------------------------------------------
CREATE TYPE opportunity_source_type AS ENUM (
    'sarfaesi_bank_auction',
    'nbfc_repossession',
    'arc_asset',
    'drt_auction',
    'nclt_liquidation',
    'housing_board',
    'legal_notice',
    'broker_sourced',
    'direct_seller',
    'internal_crm',
    'other'
);

ALTER TABLE properties
  ADD COLUMN opportunity_source_type  opportunity_source_type,
  ADD COLUMN reserve_price            NUMERIC(16, 2) CHECK (reserve_price IS NULL OR reserve_price >= 0),
  ADD COLUMN emd_amount               NUMERIC(16, 2) CHECK (emd_amount IS NULL OR emd_amount >= 0),
  ADD COLUMN emd_deadline             TIMESTAMPTZ,
  ADD COLUMN inspection_date          TIMESTAMPTZ,
  ADD COLUMN auction_reference_id     VARCHAR(150),
  ADD COLUMN auction_portal_url       VARCHAR(500),
  ADD COLUMN possession_type          VARCHAR(20)
                                      CHECK (possession_type IS NULL OR possession_type IN ('physical', 'symbolic', 'vacant', 'occupied', 'unknown')),
  ADD COLUMN legal_status_note        TEXT,
  ADD COLUMN estimated_market_value   NUMERIC(16, 2) CHECK (estimated_market_value IS NULL OR estimated_market_value >= 0),
  ADD COLUMN discount_percent         NUMERIC(6, 2),
  ADD COLUMN investment_score         SMALLINT CHECK (investment_score IS NULL OR investment_score BETWEEN 0 AND 100),
  ADD COLUMN liquidity_band           VARCHAR(10) CHECK (liquidity_band IS NULL OR liquidity_band IN ('high', 'moderate', 'low')),
  ADD COLUMN liquidity_score          SMALLINT CHECK (liquidity_score IS NULL OR liquidity_score BETWEEN 0 AND 100),
  ADD COLUMN situation_tags           JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN risk_indicators          JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN score_breakdown          JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN data_source              VARCHAR(20) NOT NULL DEFAULT 'manual'
                                      CHECK (data_source IN ('manual', 'csv_import', 'crawler', 'api')),
  ADD COLUMN source_confidence        NUMERIC(5, 2),
  ADD COLUMN is_institutional_asset   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN scored_at                TIMESTAMPTZ;

CREATE INDEX idx_properties_investment_score ON properties(investment_score);
CREATE INDEX idx_properties_auction_date     ON properties(auction_date);
CREATE INDEX idx_properties_auction_ref      ON properties(source_bank, auction_reference_id);

-- ---------------------------------------------------------------------
-- TABLE: opportunity_ingestion_items - one row per raw record received
-- from a crawler, a CSV upload or an admin API push. Raw payload is kept
-- verbatim for audit; `normalised` is the parsed/standardised record.
-- ---------------------------------------------------------------------
CREATE TYPE ingestion_status AS ENUM (
    'pending',
    'needs_review',
    'duplicate',
    'published',
    'rejected',
    'failed'
);

CREATE TABLE opportunity_ingestion_items (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_name             VARCHAR(100) NOT NULL,
    source_url              VARCHAR(1000),
    external_ref            VARCHAR(200),
    raw_payload             JSONB NOT NULL,
    normalised              JSONB NOT NULL DEFAULT '{}',
    confidence              NUMERIC(5, 2) NOT NULL DEFAULT 0,
    issues                  JSONB NOT NULL DEFAULT '[]',
    status                  ingestion_status NOT NULL DEFAULT 'pending',
    duplicate_of_property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
    property_id             UUID REFERENCES properties(id) ON DELETE SET NULL,
    ingested_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at             TIMESTAMPTZ,
    review_notes            TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ingestion_items_status ON opportunity_ingestion_items(status, created_at);
CREATE UNIQUE INDEX uq_ingestion_items_source_ref
    ON opportunity_ingestion_items(source_name, external_ref) WHERE external_ref IS NOT NULL;

CREATE TRIGGER set_updated_at_opportunity_ingestion_items
BEFORE UPDATE ON opportunity_ingestion_items
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- Special-situation CRM pipeline (Engine 4):
-- Lead -> Deal Interest -> Due Diligence -> Negotiation -> Closure
-- ---------------------------------------------------------------------
CREATE TYPE opportunity_stage AS ENUM (
    'lead',
    'deal_interest',
    'due_diligence',
    'negotiation',
    'closure',
    'dropped'
);

CREATE TABLE opportunity_interests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id             UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    investor_profile_id     UUID REFERENCES investor_profiles(id) ON DELETE SET NULL,
    customer_id             UUID REFERENCES customers(id) ON DELETE SET NULL,
    lead_id                 UUID REFERENCES leads(id) ON DELETE SET NULL,
    tenant_id               UUID REFERENCES tenants(id) ON DELETE SET NULL,

    stage                   opportunity_stage NOT NULL DEFAULT 'lead',
    intended_bid_amount     NUMERIC(16, 2) CHECK (intended_bid_amount IS NULL OR intended_bid_amount >= 0),
    financing_needed        BOOLEAN NOT NULL DEFAULT false,
    message                 TEXT,
    assigned_to             UUID REFERENCES users(id) ON DELETE SET NULL,
    dropped_reason          TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_opportunity_interest_user_property UNIQUE (property_id, user_id)
);

CREATE INDEX idx_opportunity_interests_stage    ON opportunity_interests(stage);
CREATE INDEX idx_opportunity_interests_assigned ON opportunity_interests(assigned_to);

CREATE TRIGGER set_updated_at_opportunity_interests
BEFORE UPDATE ON opportunity_interests
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE opportunity_interest_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interest_id     UUID NOT NULL REFERENCES opportunity_interests(id) ON DELETE CASCADE,
    from_stage      opportunity_stage,
    to_stage        opportunity_stage NOT NULL,
    changed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_opportunity_interest_history ON opportunity_interest_history(interest_id);

CREATE TABLE opportunity_alert_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_priority     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_opportunity_alert UNIQUE (property_id, user_id)
);

-- ---------------------------------------------------------------------
-- TABLE: ai_insight_reviews - staff confirmation / override of an AI lead
-- score. Kept separate so ai_lead_insights stays append-only.
-- ---------------------------------------------------------------------
CREATE TABLE ai_insight_reviews (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_id          UUID NOT NULL REFERENCES ai_lead_insights(id) ON DELETE CASCADE,
    lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    action              VARCHAR(10) NOT NULL CHECK (action IN ('confirm', 'override')),
    original_score      ai_score_level,
    new_score           ai_score_level,
    reason              TEXT,
    reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_insight_reviews_lead ON ai_insight_reviews(lead_id, created_at);

-- Opportunity interests open a CRM lead with this source. (Added outside
-- any use in this file - a new enum value can't be used in the same
-- transaction that adds it.)
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'opportunity';
