-- =====================================================================
-- Migration: 016_platform_foundation.sql
-- Project  : PropertySerch.com
-- Purpose  : Shared foundation tables the rest of the platform reads its
--            configuration from, per Annexure A "The Governing Principle -
--            Everything Is Dynamic" (no value that can change after launch
--            may live in code):
--              - audit_logs          (append-only, legal-grade, sec. 19/31)
--              - app_config          (every rate/threshold/weight/label)
--              - feature_flags       (global/state/city scoped toggles)
--              - disclaimers         (admin-editable library, sec. 19.4)
--              - countries/states/cities/localities/pincodes (sec. 22)
--              - stamp_duty_rules/circle_rates/sub_registrar_offices
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- TABLE: audit_logs
-- Append-only. Every admin/configuration action writes one row with the
-- before/after JSON. UPDATE and DELETE are rejected at the database level
-- (not just by convention in the service layer), which is what the
-- "append-only constraint verified" acceptance gate checks.
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role      VARCHAR(50),
    action          VARCHAR(100) NOT NULL,
    entity_type     VARCHAR(100) NOT NULL,
    entity_id       VARCHAR(100),
    before_json     JSONB,
    after_json      JSONB,
    ip_address      VARCHAR(64),
    user_agent      VARCHAR(500),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_entity     ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_actor_id   ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

CREATE OR REPLACE FUNCTION trigger_reject_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION trigger_reject_audit_log_mutation();

-- ---------------------------------------------------------------------
-- TABLE: app_config
-- Key/value store for every admin-configurable parameter. `is_statutory`
-- marks values that only change when the law changes (TDS/GST rates etc.)
-- - these need super_admin, and every change is audit-logged either way.
-- ---------------------------------------------------------------------
CREATE TABLE app_config (
    config_key      VARCHAR(150) PRIMARY KEY,
    value           JSONB NOT NULL,
    category        VARCHAR(50) NOT NULL DEFAULT 'general',
    description     TEXT,
    is_statutory    BOOLEAN NOT NULL DEFAULT false,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_config_category ON app_config(category);

CREATE TRIGGER set_updated_at_app_config
BEFORE UPDATE ON app_config
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: feature_flags
-- ---------------------------------------------------------------------
CREATE TABLE feature_flags (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flag_key            VARCHAR(150) NOT NULL,
    scope               VARCHAR(20) NOT NULL DEFAULT 'global'
                        CHECK (scope IN ('global', 'state', 'city')),
    scope_id            UUID,
    is_enabled          BOOLEAN NOT NULL DEFAULT false,
    rollout_percentage  SMALLINT NOT NULL DEFAULT 100
                        CHECK (rollout_percentage BETWEEN 0 AND 100),
    description         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- COALESCE so a NULL scope_id (global flags) still participates in uniqueness.
CREATE UNIQUE INDEX uq_feature_flags_key_scope
    ON feature_flags(flag_key, scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TRIGGER set_updated_at_feature_flags
BEFORE UPDATE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- Geographic master data (sec. 22.1) - all admin-editable, nothing
-- geographic hardcoded anywhere in application code.
-- ---------------------------------------------------------------------
CREATE TABLE countries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code    VARCHAR(3) NOT NULL UNIQUE,
    country_name    VARCHAR(100) NOT NULL,
    currency_code   VARCHAR(3) NOT NULL DEFAULT 'INR',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE states (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_id          UUID NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
    state_code          VARCHAR(10) NOT NULL UNIQUE,
    state_name          VARCHAR(100) NOT NULL,
    is_union_territory  BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT false,
    rera_portal_url     VARCHAR(500),
    default_language    VARCHAR(10) NOT NULL DEFAULT 'en',
    time_zone           VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    capital_city        VARCHAR(100),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE city_status AS ENUM ('active', 'coming_soon', 'inactive');

CREATE TABLE cities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id            UUID NOT NULL REFERENCES states(id) ON DELETE RESTRICT,
    city_name           VARCHAR(100) NOT NULL,
    slug                VARCHAR(120) NOT NULL UNIQUE,
    status              city_status NOT NULL DEFAULT 'inactive',
    city_tier           SMALLINT CHECK (city_tier IS NULL OR city_tier BETWEEN 1 AND 3),
    match_radius_km     NUMERIC(6, 2) NOT NULL DEFAULT 50,
    launch_date         DATE,
    lat_centroid        NUMERIC(10, 7),
    lng_centroid        NUMERIC(10, 7),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_cities_state_name UNIQUE (state_id, city_name)
);

CREATE INDEX idx_cities_state_id ON cities(state_id);
CREATE INDEX idx_cities_status   ON cities(status);

CREATE TABLE localities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id             UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    locality_name       VARCHAR(150) NOT NULL,
    sub_locality        VARCHAR(150),
    pincode             VARCHAR(10),
    lat_centroid        NUMERIC(10, 7),
    lng_centroid        NUMERIC(10, 7),
    is_premium_area     BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_localities_city_name UNIQUE (city_id, locality_name)
);

CREATE INDEX idx_localities_city_id ON localities(city_id);
CREATE INDEX idx_localities_pincode ON localities(pincode);

CREATE TABLE pincodes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pincode         VARCHAR(10) NOT NULL,
    locality_id     UUID REFERENCES localities(id) ON DELETE SET NULL,
    city_id         UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    state_id        UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_pincodes_pincode_locality UNIQUE (pincode, locality_id)
);

CREATE INDEX idx_pincodes_pincode ON pincodes(pincode);
CREATE INDEX idx_pincodes_city_id ON pincodes(city_id);

CREATE TABLE stamp_duty_rules (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id                    UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    city_id                     UUID REFERENCES cities(id) ON DELETE CASCADE,
    transaction_type            VARCHAR(50) NOT NULL DEFAULT 'sale',
    buyer_gender                VARCHAR(20) NOT NULL DEFAULT 'any'
                                CHECK (buyer_gender IN ('any', 'male', 'female', 'joint')),
    rate_percent                NUMERIC(6, 3) NOT NULL CHECK (rate_percent >= 0),
    registration_fee_percent    NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (registration_fee_percent >= 0),
    registration_fee_cap        NUMERIC(14, 2),
    effective_from              DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_until             DATE,
    notes                       TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stamp_duty_rules_state_city ON stamp_duty_rules(state_id, city_id);

CREATE TABLE circle_rates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id        UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    city_id         UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    locality_id     UUID REFERENCES localities(id) ON DELETE CASCADE,
    property_type   VARCHAR(50) NOT NULL DEFAULT 'any',
    rate_per_sqft   NUMERIC(12, 2) NOT NULL CHECK (rate_per_sqft >= 0),
    effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_until DATE,
    source_doc_url  VARCHAR(500),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_circle_rates_city_locality ON circle_rates(city_id, locality_id);

CREATE TABLE sub_registrar_offices (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id                UUID NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    city_id                 UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    sro_name                VARCHAR(200) NOT NULL,
    address                 VARCHAR(500),
    jurisdiction_localities JSONB NOT NULL DEFAULT '[]',
    office_hours            VARCHAR(200),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sro_city_id ON sub_registrar_offices(city_id);

-- ---------------------------------------------------------------------
-- TABLE: disclaimers (sec. 19.4) - rendered by content type + state; no
-- disclaimer text is ever hardcoded in a template or component.
-- ---------------------------------------------------------------------
CREATE TABLE disclaimers (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    disclaimer_key              VARCHAR(100) NOT NULL UNIQUE,
    title                       VARCHAR(200) NOT NULL,
    content_html                TEXT NOT NULL,
    applicable_content_types    JSONB NOT NULL DEFAULT '[]',
    applicable_states           JSONB NOT NULL DEFAULT '[]',
    is_mandatory                BOOLEAN NOT NULL DEFAULT true,
    is_active                   BOOLEAN NOT NULL DEFAULT true,
    sort_order                  SMALLINT NOT NULL DEFAULT 0,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['countries', 'states', 'cities', 'localities', 'pincodes',
                           'stamp_duty_rules', 'circle_rates', 'sub_registrar_offices', 'disclaimers']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at_%I BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- SEED: India + all 28 states and 8 union territories (sec. 22.1 - "all
-- 28 states + 8 UTs of India seeded; admin toggles is_active"). Every state
-- starts inactive - activating Delhi NCR for launch is an admin action.
-- ---------------------------------------------------------------------
INSERT INTO countries (country_code, country_name, currency_code) VALUES ('IN', 'India', 'INR');

INSERT INTO states (country_id, state_code, state_name, is_union_territory)
SELECT c.id, s.code, s.name, s.is_ut
FROM countries c,
     (VALUES
        ('AP', 'Andhra Pradesh', false), ('AR', 'Arunachal Pradesh', false),
        ('AS', 'Assam', false), ('BR', 'Bihar', false), ('CG', 'Chhattisgarh', false),
        ('GA', 'Goa', false), ('GJ', 'Gujarat', false), ('HR', 'Haryana', false),
        ('HP', 'Himachal Pradesh', false), ('JH', 'Jharkhand', false),
        ('KA', 'Karnataka', false), ('KL', 'Kerala', false), ('MP', 'Madhya Pradesh', false),
        ('MH', 'Maharashtra', false), ('MN', 'Manipur', false), ('ML', 'Meghalaya', false),
        ('MZ', 'Mizoram', false), ('NL', 'Nagaland', false), ('OD', 'Odisha', false),
        ('PB', 'Punjab', false), ('RJ', 'Rajasthan', false), ('SK', 'Sikkim', false),
        ('TN', 'Tamil Nadu', false), ('TG', 'Telangana', false), ('TR', 'Tripura', false),
        ('UP', 'Uttar Pradesh', false), ('UK', 'Uttarakhand', false), ('WB', 'West Bengal', false),
        ('AN', 'Andaman and Nicobar Islands', true), ('CH', 'Chandigarh', true),
        ('DH', 'Dadra and Nagar Haveli and Daman and Diu', true), ('DL', 'Delhi', true),
        ('JK', 'Jammu and Kashmir', true), ('LA', 'Ladakh', true),
        ('LD', 'Lakshadweep', true), ('PY', 'Puducherry', true)
     ) AS s(code, name, is_ut)
WHERE c.country_code = 'IN';

-- ---------------------------------------------------------------------
-- SEED: disclaimers library - binding default text from Annexure A sec.
-- 19.4 and Module 46 (sec. 16.8). All admin-editable afterwards.
-- ---------------------------------------------------------------------
INSERT INTO disclaimers (disclaimer_key, title, content_html, applicable_content_types, sort_order) VALUES
  ('all_listings', 'All property listings',
   'Verify independently before transacting. Platform does not guarantee accuracy of listing data.',
   '["all_listings", "auction", "special_situation", "institutional"]', 1),
  ('special_situation', 'Special Situation Properties',
   'Special situation property. Independent legal and financial due diligence required before proceeding.',
   '["special_situation"]', 2),
  ('auction', 'Auction data',
   'Sourced from public auction notices. Verify with the auctioning institution before bidding.',
   '["auction"]', 3),
  ('ai_output', 'AI / indicative outputs',
   'Indicative guidance only. Not financial or legal advice. Consult a qualified professional.',
   '["ai_output", "liquidity_score"]', 4),
  ('loan', 'Loan content',
   'Loan eligibility subject to lender assessment and applicable T&Cs.',
   '["loan"]', 5),
  ('tax_legal', 'Tax / legal content',
   'Tax and legal rules vary by situation. Consult a qualified CA / advocate of your choice.',
   '["tax_legal", "nri_guidance"]', 6),
  ('document_draft', 'Property document drafts',
   'Working draft. Must be reviewed by the chosen advocate, stamped, and registered before execution. A R Buildwel facilitates and coordinates; we do not act as legal counsel.',
   '["document_draft"]', 7),
  ('investment_guidance', 'Investment guidance',
   'ROI, yield, and appreciation projections are indicative. Not guaranteed. Not investment advice.',
   '["investment_guidance", "auction", "special_situation", "hni_portfolio"]', 8),
  ('institutional', 'Institutional deals',
   'Institutional asset transactions involve complex regulatory, legal, and financial considerations. Engage a qualified CA, legal counsel, and regulatory expert before entering any agreement.',
   '["institutional"]', 9),
  ('mandate_deed_writer_waiver', 'Deed writer waiver scope',
   'The deed writer / document writer drafting fee is waived for Exclusive Mandate clients. Stamp duty, registration charges, and all expenses of Sale Deed execution are borne by the purchaser as per applicable law and convention. This waiver covers deed drafting charges only.',
   '["mandate"]', 10),
  ('mandate_due_diligence', 'Due diligence disclaimer',
   'Due diligence conducted by A R Buildwel''s empanelled advocates is for the client''s guidance. It does not constitute a guarantee of clear title. Clients are advised to obtain independent legal advice before transacting.',
   '["mandate", "due_diligence"]', 11),
  ('mandate_valuation', 'Valuation disclaimer',
   'Valuation provided by the empanelled registered valuer is indicative. It does not constitute a certified government valuation for stamp duty or any statutory purpose.',
   '["mandate", "valuation"]', 12);

-- ---------------------------------------------------------------------
-- SEED: app_config defaults. Values are the binding defaults stated in
-- Annexure A; statutory values reflect current law and are changed only
-- on a change in law (super_admin, audit-logged).
-- ---------------------------------------------------------------------
INSERT INTO app_config (config_key, value, category, description, is_statutory) VALUES
  ('site.base_url', '"https://propertyserch.com"', 'site',
   'Public website origin, used for sitemap.xml and share links.', false),

  ('content_guard.forbidden_terms',
   '[{"term": "distressed", "use": "Special Situation Properties or High-Opportunity Investment Deals"},
     {"term": "disputed", "use": "Special Situation Properties"},
     {"term": "cheap", "use": null},
     {"term": "guaranteed returns", "use": "indicative projections, not guaranteed"},
     {"term": "risk-free investment", "use": null},
     {"term": "first in india", "use": null},
     {"term": "india''s only", "use": null},
     {"term": "law firm", "use": null}]',
   'content_guard', 'Sec. 0.4 - server-side validator rejects these on every user-visible string.', false),
  ('content_guard.brand_misspellings', '["buildwell", "propertysearch"]', 'content_guard',
   'Sec. 0.3 - locked brand spellings (Buildwel, Propertyserch). Cannot be bypassed by any role.', false),
  ('content_guard.contact_phrases',
   '["call me", "reach at", "contact", "whatsapp", "telegram", "text me", "call karo", "contact karo"]',
   'content_guard', 'Sec. 11.2 - contact phrases blocked in listing text.', false),
  ('content_guard.contact_block_enabled', 'true', 'content_guard',
   'Sec. 11.2 - reject listing text containing phone numbers, emails, URLs or contact phrases.', false),

  ('opportunity.scoring_weights',
   '{"discount": 40, "liquidity": 25, "risk": 20, "yield": 15}', 'opportunity',
   'Engine 4 - investment score (0-100) component weights.', false),
  ('opportunity.discount_full_score_percent', '40', 'opportunity',
   'Discount-to-market % at which the discount component scores its full weight.', false),
  ('opportunity.yield_full_score_percent', '12', 'opportunity',
   'Rental/estimated yield % at which the yield component scores its full weight.', false),
  ('opportunity.priority_alert_score', '75', 'opportunity',
   'Investment score at or above which an opportunity alert is sent as priority.', false),
  ('opportunity.auto_publish_enabled', 'false', 'opportunity',
   'Layer 5 - publish ingested opportunities above the confidence threshold without manual review.', false),
  ('opportunity.auto_publish_min_confidence', '95', 'opportunity',
   'Layer 4/5 - minimum parse confidence (0-100) for auto-publish.', false),
  ('opportunity.full_access_roles',
   '["broker", "agency_admin", "internal_sales", "admin", "super_admin"]', 'opportunity',
   'Engine 4 access control - staff roles that always see full opportunity details (verified NRI/HNI investors are added on top of this).', false),
  ('opportunity.public_teaser_enabled', 'true', 'opportunity',
   'Show masked teaser cards for auction / special situation deals to casual visitors.', false),

  ('liquidity.weights', '{"demand_supply": 45, "velocity": 35, "engagement": 20}', 'liquidity',
   'Module 14 - liquidity/saleability score component weights.', false),
  ('liquidity.bands', '{"high": 70, "moderate": 40}', 'liquidity',
   'Module 14 - score thresholds for High / Moderate liquidity (below moderate = Low).', false),
  ('liquidity.lookback_days', '180', 'liquidity',
   'Module 14 - window for transaction velocity and demand signals.', false),

  ('nri.service_request_sla_hours', '{"low": 72, "medium": 48, "high": 24, "urgent": 4}', 'nri',
   'Engine 3 - NRI service request first-response SLA by priority.', false),
  ('nri.fema_guidance_points',
   '["NRIs and OCIs may purchase residential and commercial property in India; agricultural land, plantation property and farmhouses generally require RBI approval.",
     "Payment for purchase must come through normal banking channels or from NRE/NRO/FCNR(B) accounts - not traveller''s cheques or foreign currency notes.",
     "Rental income is credited to an NRO account and is taxable in India.",
     "Sale proceeds may be repatriated subject to the annual limit from NRO balances, after taxes, with Form 15CA/15CB where applicable.",
     "Buyers of property from an NRI must deduct TDS on the capital gain portion under Section 195."]',
   'nri', 'Engine 3 - FEMA/RBI basics shown on the NRI guidance screen (non-advisory).', false),

  ('tax.nri_ltcg_rate_percent', '12.5', 'tax',
   'Statutory - long-term capital gains rate applied for indicative TDS on NRI property sale.', true),
  ('tax.nri_stcg_rate_percent', '30', 'tax',
   'Statutory - short-term capital gains rate applied for indicative TDS on NRI property sale.', true),
  ('tax.ltcg_holding_months', '24', 'tax',
   'Statutory - holding period (months) after which immovable property gains are long-term.', true),
  ('tax.cess_percent', '4', 'tax', 'Statutory - health and education cess on tax + surcharge.', true),
  ('tax.nri_surcharge_bands',
   '[{"above": 5000000, "rate_percent": 10}, {"above": 10000000, "rate_percent": 15}]', 'tax',
   'Statutory - surcharge bands (on the gain) for indicative NRI TDS.', true),
  ('tax.nri_rent_tds_percent', '30', 'tax',
   'Statutory - TDS rate (before cess) on rent paid to an NRI landlord.', true),
  ('fema.repatriation_annual_limit_usd', '1000000', 'tax',
   'Statutory - FEMA annual repatriation limit from NRO balances (USD per financial year).', true),

  ('bd_leads.advertiser_eligible_categories',
   '["builder_developer", "bank", "nbfc", "insurance", "legal_services", "interior_design",
     "packers_movers", "property_management", "vastu_consultant", "broker_firm", "proptech"]',
   'bd_leads', 'Module 17 - only real-estate-ecosystem businesses may enquire to advertise.', false);
