-- =====================================================================
-- Migration: 018_nri_hni_investors.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 3 - NRI + HNI Investment (Premium Vertical) and
--            Module 38 IRM basics:
--              - investor_profiles            (NRI / OCI / HNI profile,
--                                              preferences, verification,
--                                              assigned manager)
--              - nri_properties               (owned properties under
--                                              platform management)
--              - nri_service_requests         (buy/sell/rent/management
--                + nri_service_request_updates  requests with an append-only
--                                              status timeline)
--              - nri_rent_records             (rent collection ledger)
--              - nri_repatriation_records     (repatriation tracking)
--              - hni_investments              (portfolio + exit tracking)
--              - investor_deal_interactions   (behaviour tracking)
-- DB       : PostgreSQL
-- =====================================================================

-- A profile hangs off a platform user (normally role `customer`), so one
-- person can be both NRI and HNI without a second account or a new role.
CREATE TABLE investor_profiles (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    customer_id                 UUID REFERENCES customers(id) ON DELETE SET NULL,
    tenant_id                   UUID REFERENCES tenants(id) ON DELETE SET NULL,

    is_nri                      BOOLEAN NOT NULL DEFAULT false,
    is_hni                      BOOLEAN NOT NULL DEFAULT false,
    residency_status            VARCHAR(20)
                                CHECK (residency_status IS NULL OR residency_status IN ('nri', 'oci', 'pio', 'resident')),
    country_of_residence        VARCHAR(100),
    city_of_residence           VARCHAR(100),
    time_zone                   VARCHAR(60),
    preferred_contact_window    VARCHAR(100),

    investor_category           VARCHAR(50)
                                CHECK (investor_category IS NULL OR investor_category IN
                                       ('individual', 'family_office', 'trust', 'pe_fund', 'corporate', 'education_group')),
    asset_class_preferences     JSONB NOT NULL DEFAULT '[]',
    preferred_cities            JSONB NOT NULL DEFAULT '[]',
    preferred_property_types    JSONB NOT NULL DEFAULT '[]',
    ticket_size_min             NUMERIC(16, 2) CHECK (ticket_size_min IS NULL OR ticket_size_min >= 0),
    ticket_size_max             NUMERIC(16, 2) CHECK (ticket_size_max IS NULL OR ticket_size_max >= 0),
    risk_appetite               VARCHAR(20)
                                CHECK (risk_appetite IS NULL OR risk_appetite IN ('conservative', 'moderate', 'aggressive')),
    investment_horizon_years    SMALLINT CHECK (investment_horizon_years IS NULL OR investment_horizon_years > 0),
    institutional_interest      BOOLEAN NOT NULL DEFAULT false,
    alerts_enabled              BOOLEAN NOT NULL DEFAULT true,

    verification_status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                                CHECK (verification_status IN ('pending', 'verified', 'rejected')),
    verification_notes          TEXT,
    verified_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at                 TIMESTAMPTZ,
    assigned_manager_id         UUID REFERENCES users(id) ON DELETE SET NULL,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_investor_profiles_type CHECK (is_nri OR is_hni),
    CONSTRAINT chk_investor_profiles_ticket CHECK (
        ticket_size_min IS NULL OR ticket_size_max IS NULL OR ticket_size_min <= ticket_size_max
    )
);

CREATE INDEX idx_investor_profiles_manager      ON investor_profiles(assigned_manager_id);
CREATE INDEX idx_investor_profiles_verification ON investor_profiles(verification_status);

-- ---------------------------------------------------------------------
-- TABLE: nri_properties - properties an NRI owns in India and wants
-- monitored/managed. Full address and tenant contact are private: the
-- tenant phone is AES-256-GCM encrypted at the application layer.
-- ---------------------------------------------------------------------
CREATE TABLE nri_properties (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_profile_id         UUID NOT NULL REFERENCES investor_profiles(id) ON DELETE CASCADE,
    property_id                 UUID REFERENCES properties(id) ON DELETE SET NULL,

    title                       VARCHAR(200) NOT NULL,
    property_type               VARCHAR(50),
    city                        VARCHAR(100) NOT NULL,
    locality                    VARCHAR(150),
    address                     VARCHAR(500),
    area_sqft                   NUMERIC(10, 2) CHECK (area_sqft IS NULL OR area_sqft >= 0),
    ownership_type              VARCHAR(20) NOT NULL DEFAULT 'sole'
                                CHECK (ownership_type IN ('sole', 'joint', 'inherited', 'company')),
    purchase_price              NUMERIC(16, 2) CHECK (purchase_price IS NULL OR purchase_price >= 0),
    purchase_date               DATE,
    current_estimated_value     NUMERIC(16, 2) CHECK (current_estimated_value IS NULL OR current_estimated_value >= 0),
    valuation_date              DATE,

    management_status           VARCHAR(30) NOT NULL DEFAULT 'self_managed'
                                CHECK (management_status IN ('self_managed', 'platform_managed', 'management_requested')),
    occupancy_status            VARCHAR(30) NOT NULL DEFAULT 'vacant'
                                CHECK (occupancy_status IN ('vacant', 'tenant_occupied', 'owner_occupied', 'under_maintenance')),
    monthly_rent_expected       NUMERIC(12, 2) CHECK (monthly_rent_expected IS NULL OR monthly_rent_expected >= 0),
    tenant_name                 VARCHAR(150),
    tenant_phone_encrypted      TEXT,
    lease_start_date            DATE,
    lease_end_date              DATE,
    notes                       TEXT,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nri_properties_profile ON nri_properties(investor_profile_id);

CREATE TYPE nri_request_type AS ENUM (
    'buy',
    'sell',
    'rent_out',
    'property_management',
    'rent_collection',
    'tenant_management',
    'maintenance',
    'document_coordination',
    'legal_guidance',
    'tax_guidance',
    'repatriation',
    'institutional_acquisition',
    'other'
);

CREATE TYPE nri_request_status AS ENUM (
    'submitted',
    'acknowledged',
    'in_progress',
    'awaiting_customer',
    'completed',
    'cancelled'
);

CREATE TABLE nri_service_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_profile_id     UUID NOT NULL REFERENCES investor_profiles(id) ON DELETE CASCADE,
    nri_property_id         UUID REFERENCES nri_properties(id) ON DELETE SET NULL,
    request_type            nri_request_type NOT NULL,
    title                   VARCHAR(200) NOT NULL,
    description             TEXT,
    priority                VARCHAR(10) NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status                  nri_request_status NOT NULL DEFAULT 'submitted',
    assigned_manager_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    sla_due_at              TIMESTAMPTZ,
    first_response_at       TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nri_requests_profile  ON nri_service_requests(investor_profile_id);
CREATE INDEX idx_nri_requests_status   ON nri_service_requests(status);
CREATE INDEX idx_nri_requests_manager  ON nri_service_requests(assigned_manager_id);

-- Append-only timeline ("status tracking with timeline updates").
-- is_internal rows are staff-only notes, never shown to the NRI.
CREATE TABLE nri_service_request_updates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES nri_service_requests(id) ON DELETE CASCADE,
    author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    update_type     VARCHAR(20) NOT NULL DEFAULT 'comment'
                    CHECK (update_type IN ('created', 'status_change', 'comment', 'assignment')),
    from_status     nri_request_status,
    to_status       nri_request_status,
    message         TEXT,
    is_internal     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nri_request_updates_request ON nri_service_request_updates(request_id);

CREATE TABLE nri_rent_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nri_property_id     UUID NOT NULL REFERENCES nri_properties(id) ON DELETE CASCADE,
    period_month        DATE NOT NULL,
    rent_due            NUMERIC(12, 2) NOT NULL CHECK (rent_due >= 0),
    rent_received       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (rent_received >= 0),
    tds_deducted        NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tds_deducted >= 0),
    received_on         DATE,
    status              VARCHAR(20) NOT NULL DEFAULT 'due'
                        CHECK (status IN ('due', 'received', 'partial', 'overdue', 'waived')),
    notes               TEXT,
    recorded_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_nri_rent_property_month UNIQUE (nri_property_id, period_month)
);

CREATE TABLE nri_repatriation_records (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_profile_id     UUID NOT NULL REFERENCES investor_profiles(id) ON DELETE CASCADE,
    nri_property_id         UUID REFERENCES nri_properties(id) ON DELETE SET NULL,
    source                  VARCHAR(30) NOT NULL
                            CHECK (source IN ('sale_proceeds', 'rental_income', 'other')),
    amount_inr              NUMERIC(16, 2) NOT NULL CHECK (amount_inr >= 0),
    fx_currency             VARCHAR(3),
    amount_fx               NUMERIC(16, 2) CHECK (amount_fx IS NULL OR amount_fx >= 0),
    amount_usd_equivalent   NUMERIC(16, 2) CHECK (amount_usd_equivalent IS NULL OR amount_usd_equivalent >= 0),
    financial_year          VARCHAR(9) NOT NULL,
    form_15ca_cb_status     VARCHAR(20) NOT NULL DEFAULT 'not_started'
                            CHECK (form_15ca_cb_status IN ('not_started', 'in_progress', 'filed', 'not_applicable')),
    bank_name               VARCHAR(150),
    status                  VARCHAR(20) NOT NULL DEFAULT 'planned'
                            CHECK (status IN ('planned', 'in_process', 'completed', 'cancelled')),
    completed_on            DATE,
    notes                   TEXT,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nri_repatriation_profile_fy ON nri_repatriation_records(investor_profile_id, financial_year);

-- ---------------------------------------------------------------------
-- TABLE: hni_investments - portfolio positions with exit tracking.
-- ROI / yield / CAGR are always computed on read from these inputs.
-- ---------------------------------------------------------------------
CREATE TABLE hni_investments (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_profile_id         UUID NOT NULL REFERENCES investor_profiles(id) ON DELETE CASCADE,
    property_id                 UUID REFERENCES properties(id) ON DELETE SET NULL,

    title                       VARCHAR(200) NOT NULL,
    asset_class                 VARCHAR(30) NOT NULL DEFAULT 'residential'
                                CHECK (asset_class IN ('residential', 'commercial', 'institutional', 'land',
                                                       'special_situation', 'auction', 'hospitality', 'other')),
    city                        VARCHAR(100),
    locality                    VARCHAR(150),
    property_type               VARCHAR(50),

    acquisition_date            DATE,
    acquisition_cost            NUMERIC(16, 2) NOT NULL CHECK (acquisition_cost >= 0),
    additional_costs            NUMERIC(16, 2) NOT NULL DEFAULT 0 CHECK (additional_costs >= 0),
    current_valuation           NUMERIC(16, 2) CHECK (current_valuation IS NULL OR current_valuation >= 0),
    valuation_date              DATE,
    monthly_rental_income       NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (monthly_rental_income >= 0),
    annual_expenses             NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (annual_expenses >= 0),

    status                      VARCHAR(20) NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'exit_planned', 'exited')),
    target_exit_date            DATE,
    target_exit_value           NUMERIC(16, 2) CHECK (target_exit_value IS NULL OR target_exit_value >= 0),
    exit_date                   DATE,
    exit_value                  NUMERIC(16, 2) CHECK (exit_value IS NULL OR exit_value >= 0),
    notes                       TEXT,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hni_investments_profile ON hni_investments(investor_profile_id);
CREATE INDEX idx_hni_investments_status  ON hni_investments(status);

-- Investor behaviour tracking (Engine 3): which deal types, areas and
-- ticket sizes each investor engages with. Append-only.
CREATE TABLE investor_deal_interactions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_profile_id     UUID REFERENCES investor_profiles(id) ON DELETE CASCADE,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    property_id             UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    action                  VARCHAR(30) NOT NULL
                            CHECK (action IN ('viewed', 'shortlisted', 'unshortlisted', 'interest_expressed',
                                              'document_requested', 'dismissed', 'shared')),
    listing_category        VARCHAR(30),
    city                    VARCHAR(100),
    ticket_size             NUMERIC(16, 2),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_investor_interactions_profile  ON investor_deal_interactions(investor_profile_id, created_at);
CREATE INDEX idx_investor_interactions_property ON investor_deal_interactions(property_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['investor_profiles', 'nri_properties', 'nri_service_requests',
                           'nri_rent_records', 'nri_repatriation_records', 'hni_investments']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at_%I BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at()', t, t);
  END LOOP;
END $$;
