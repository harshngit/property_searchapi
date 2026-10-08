-- =====================================================================
-- Migration: 046_institutional_engine.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 7 - Institutional (Modules 8, 15, 22).
--            - Institutional listing data (confidential by default): the
--              institution's name and figures live here, never in the
--              public properties row.
--            - Institutional buyer qualification (buyer type, budget,
--              financial capacity) - the "Verified Buyer" step.
--            - The 9-stage deal pipeline: Intent Received -> Buyer
--              Qualification -> NDA Executed -> Data Room Access -> Site
--              Visit -> Valuation Discussion -> Legal Due Diligence ->
--              Offer and Negotiation -> Closure; append-only event log;
--              term sheets / offers / counter-offers.
--            - Institutional due diligence (regulatory checklist review)
--              and comparable transactions for valuation benchmarking.
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE institutional_listings (
    property_id          UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
    institution_name     VARCHAR(200) NOT NULL,
    asset_class          VARCHAR(30) NOT NULL CHECK (asset_class IN (
                           'k12_school', 'college', 'university', 'international_school', 'coaching_center', 'vocational_institute',
                           'hospital', 'hotel', 'corporate_campus', 'senior_living', 'entertainment')),
    sub_type             VARCHAR(120),
    board_affiliation    VARCHAR(120),
    year_established     SMALLINT CHECK (year_established IS NULL OR (year_established BETWEEN 1800 AND 2100)),
    campus_area_sqft     NUMERIC(14, 2),
    campus_area_acres    NUMERIC(10, 2),
    built_up_area_sqft   NUMERIC(14, 2),
    building_count       SMALLINT,
    infrastructure       TEXT,
    student_enrollment   INTEGER,
    faculty_count        INTEGER,
    capacity_units       INTEGER,
    capacity_label       VARCHAR(40),
    enrollment_history   JSONB NOT NULL DEFAULT '[]'::jsonb,
    noc_status           VARCHAR(20) NOT NULL DEFAULT 'not_applicable' CHECK (noc_status IN ('valid', 'pending', 'expired', 'not_applicable')),
    approvals            JSONB NOT NULL DEFAULT '[]'::jsonb,
    land_ownership       VARCHAR(20) NOT NULL DEFAULT 'owned' CHECK (land_ownership IN ('owned', 'leased', 'trust_held', 'mixed')),
    deal_type            VARCHAR(25) NOT NULL DEFAULT 'full_sale' CHECK (deal_type IN ('full_sale', 'stake_sale', 'lease', 'jv', 'management_takeover')),
    asking_price_cr      NUMERIC(12, 2),
    annual_revenue_cr    NUMERIC(12, 2),
    ebitda_cr            NUMERIC(12, 2),
    revenue_multiple     NUMERIC(8, 2),
    ebitda_multiple      NUMERIC(8, 2),
    -- Confidential unless the seller opts out; the name is still never in properties.title.
    is_confidential      BOOLEAN NOT NULL DEFAULT true,
    seller_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    valuation            JSONB,
    valuation_at         TIMESTAMPTZ,
    dd_review            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_institutional_listings_class ON institutional_listings(asset_class, deal_type);
CREATE TRIGGER trg_institutional_listings_updated_at BEFORE UPDATE ON institutional_listings
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Buyer qualification (Stage 2): who is buying and whether they can.
CREATE TABLE institutional_buyers (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    buyer_type          VARCHAR(30) NOT NULL CHECK (buyer_type IN ('pe_fund', 'trust', 'education_group', 'healthcare_group', 'hospitality_group', 'corporate', 'family_office', 'hni_individual', 'other')),
    organisation_name   VARCHAR(200),
    budget_min_cr       NUMERIC(12, 2),
    budget_max_cr       NUMERIC(12, 2),
    geographies         JSONB NOT NULL DEFAULT '[]'::jsonb,
    asset_classes       JSONB NOT NULL DEFAULT '[]'::jsonb,
    intent              TEXT,
    capacity_note       TEXT,
    capacity_document   VARCHAR(500),
    status              VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'rejected')),
    decision_note       TEXT,
    decided_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_institutional_buyers_updated_at BEFORE UPDATE ON institutional_buyers
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE SEQUENCE institutional_deal_seq;

CREATE TABLE institutional_deals (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_number        VARCHAR(20) NOT NULL UNIQUE,
    property_id        UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    buyer_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    customer_id        UUID REFERENCES customers(id) ON DELETE SET NULL,
    lead_id            UUID REFERENCES leads(id) ON DELETE SET NULL,
    rep_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    source             VARCHAR(12) NOT NULL DEFAULT 'platform' CHECK (source IN ('platform', 'whatsapp', 'guest', 'crm')),
    stage              VARCHAR(25) NOT NULL DEFAULT 'intent_received' CHECK (stage IN (
                         'intent_received', 'buyer_qualification', 'nda_executed', 'data_room_access', 'site_visit',
                         'valuation_discussion', 'legal_due_diligence', 'offer_negotiation', 'closure')),
    status             VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'closed_won', 'dropped')),
    stage_entered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    screened_at        TIMESTAMPTZ,
    site_visit_at      TIMESTAMPTZ,
    site_visit_done_at TIMESTAMPTZ,
    valuation_shared_at TIMESTAMPTZ,
    legal_cleared_at   TIMESTAMPTZ,
    legal_notes        TEXT,
    agreed_value_cr    NUMERIC(12, 2),
    agreement_date     DATE,
    payment_confirmed_at TIMESTAMPTZ,
    advisory_fee_cr    NUMERIC(12, 4),
    drop_reason        TEXT,
    closed_at          TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live deal per buyer per asset.
CREATE UNIQUE INDEX uq_institutional_deal_live ON institutional_deals(property_id, buyer_user_id) WHERE status IN ('active', 'on_hold') AND buyer_user_id IS NOT NULL;
CREATE INDEX idx_institutional_deals_stage ON institutional_deals(status, stage);
CREATE TRIGGER trg_institutional_deals_updated_at BEFORE UPDATE ON institutional_deals
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE institutional_deal_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id     UUID NOT NULL REFERENCES institutional_deals(id) ON DELETE CASCADE,
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('created', 'stage', 'note', 'site_visit', 'valuation', 'legal', 'offer', 'hold', 'dropped', 'closed', 'override')),
    from_stage  VARCHAR(25),
    to_stage    VARCHAR(25),
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_institutional_deal_events ON institutional_deal_events(deal_id, created_at);

CREATE OR REPLACE FUNCTION trigger_reject_institutional_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'institutional_deal_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER institutional_deal_events_append_only
BEFORE UPDATE OR DELETE ON institutional_deal_events
FOR EACH ROW EXECUTE FUNCTION trigger_reject_institutional_event_mutation();

-- Term sheets, offers and counter-offers (Stage 8).
CREATE TABLE institutional_offers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id     UUID NOT NULL REFERENCES institutional_deals(id) ON DELETE CASCADE,
    kind        VARCHAR(15) NOT NULL CHECK (kind IN ('term_sheet', 'offer', 'counter_offer')),
    by_party    VARCHAR(10) NOT NULL CHECK (by_party IN ('buyer', 'seller', 'platform')),
    amount_cr   NUMERIC(12, 2) NOT NULL CHECK (amount_cr > 0),
    terms       TEXT,
    status      VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'superseded', 'withdrawn')),
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_institutional_offers_deal ON institutional_offers(deal_id, created_at);

-- Comparable transactions for benchmarking (entered by staff; closed
-- platform deals are added automatically).
CREATE TABLE institutional_comparables (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_class      VARCHAR(30) NOT NULL,
    city             VARCHAR(120),
    state            VARCHAR(80),
    deal_type        VARCHAR(25),
    deal_year        SMALLINT,
    deal_value_cr    NUMERIC(12, 2) NOT NULL CHECK (deal_value_cr > 0),
    revenue_cr       NUMERIC(12, 2),
    ebitda_cr        NUMERIC(12, 2),
    enrollment       INTEGER,
    capacity_units   INTEGER,
    area_acres       NUMERIC(10, 2),
    source           VARCHAR(200),
    notes            TEXT,
    deal_id          UUID REFERENCES institutional_deals(id) ON DELETE SET NULL,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_institutional_comparables ON institutional_comparables(asset_class, lower(city));

-- Regulatory documents in the data room.
ALTER TABLE deal_room_documents DROP CONSTRAINT IF EXISTS deal_room_documents_document_type_check;
ALTER TABLE deal_room_documents ADD CONSTRAINT deal_room_documents_document_type_check CHECK (document_type IN (
  'auction_notice', 'sale_notice', 'emd_receipt', 'title_documents', 'valuation_report', 'legal_opinion', 'inspection_report', 'term_sheet', 'financials', 'photos', 'other',
  'noc', 'affiliation_certificate', 'land_records', 'fire_noc', 'trust_deed', 'enrollment_records', 'audited_financials', 'municipal_approval', 'regulatory_approval', 'encumbrance_certificate'));

INSERT INTO app_config (config_key, value, category, description, is_statutory) VALUES
  ('institutional.sector_multiples', '{"k12_school": 9, "international_school": 11, "college": 7, "university": 8, "coaching_center": 6, "vocational_institute": 5, "hospital": 12, "hotel": 10, "corporate_campus": 11, "senior_living": 9, "entertainment": 7}', 'institutional',
   'Engine 7 valuation - EBITDA multiple by asset class (indicative).', false),
  ('institutional.enrollment_trend_adjustment', '{"growing": 10, "stable": 0, "declining": -15}', 'institutional',
   'Percent added to / taken off the sector multiple for the enrollment trend.', false),
  ('institutional.replacement_cost_per_sqft', '{"k12_school": 2800, "international_school": 4200, "college": 3000, "university": 3200, "coaching_center": 2600, "vocational_institute": 2400, "hospital": 6500, "hotel": 7000, "corporate_campus": 4500, "senior_living": 4000, "entertainment": 5000}', 'institutional',
   'Building replacement cost in Rs per sq ft of built-up area, by asset class.', false),
  ('institutional.default_land_rate_per_sqft', '2500', 'institutional',
   'Land rate used when the area has no circle rate or market benchmark (Rs per sq ft).', false),
  ('institutional.brand_value', '{"revenue_percent_per_decade": 8, "max_revenue_percent": 40}', 'institutional',
   'Brand value = this percent of annual revenue per decade of operation, capped.', false),
  ('institutional.approval_value_lakh', '{"valid": 50, "pending": 10}', 'institutional',
   'Value attributed to each regulatory approval (Rs lakh), by its status.', false),
  ('institutional.setup_premium_percent', '15', 'institutional',
   'Replacement cost - premium over land + building for approvals, time and pre-operative expenses.', false),
  ('institutional.stage_sla_days', '{"intent_received": 2, "buyer_qualification": 5, "nda_executed": 3, "data_room_access": 7, "site_visit": 10, "valuation_discussion": 10, "legal_due_diligence": 21, "offer_negotiation": 21}', 'institutional',
   'Expected days in each stage of the 9-stage pipeline.', false),
  ('institutional.dd_checklist', '{"common": ["land_records", "noc", "fire_noc", "municipal_approval", "encumbrance_certificate", "audited_financials"], "education": ["affiliation_certificate", "trust_deed", "enrollment_records"], "healthcare": ["regulatory_approval", "trust_deed"], "hospitality": ["regulatory_approval"], "other": []}', 'institutional',
   'Regulatory document checklist for institutional due diligence, by sector.', false),
  ('institutional.advisory_fee_percent', '1.00', 'institutional',
   'Transaction advisory fee recorded on closure (percent of agreed value).', false),
  ('institutional.disclaimer', '"A R Buildwel facilitates and coordinates; we do not act as legal counsel. All institutional transactions must involve qualified legal professionals and chartered accountants."', 'institutional',
   'Mandatory disclaimer on every institutional screen.', true)
ON CONFLICT (config_key) DO NOTHING;

UPDATE app_config SET value = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements_text(value || '["/post-institutional"]'::jsonb) AS p)
WHERE config_key = 'site.sitemap_static_paths';
