-- =====================================================================
-- Migration: 047_advertising.sql
-- Project  : PropertySerch.com
-- Purpose  : Module 17 - Advertiser & Monetization (100% native ads; no
--            third-party networks; real-estate-ecosystem advertisers only).
--            - Advertiser role + advertiser accounts (AV code) created only
--              after Super Admin eligibility approval - no self-signup.
--            - ad_rate_config: the rate card (9 formats + 2 packages),
--              admin-editable, optional per-city override.
--            - Campaigns with creative, targeting, dates, the campaign
--              approval workflow, GST invoices (18%, GSTIN on invoice).
--            - Impression / click log (user id hashed), daily roll-up,
--              frequency cap support.
-- DB       : PostgreSQL
-- =====================================================================

INSERT INTO roles (name, description)
SELECT 'advertiser', 'Advertiser portal - books and tracks ad campaigns (Module 17)'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'advertiser');

CREATE SEQUENCE advertiser_code_seq;
CREATE SEQUENCE ad_invoice_seq;

CREATE TABLE advertisers (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    av_code            VARCHAR(12) NOT NULL UNIQUE,
    user_id            UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    business_name      VARCHAR(200) NOT NULL,
    business_category  VARCHAR(40) NOT NULL,
    contact_name       VARCHAR(150),
    contact_email      VARCHAR(200),
    contact_mobile     VARCHAR(20),
    gstin              VARCHAR(20),
    billing_address    TEXT,
    rera_number        VARCHAR(80),
    bd_lead_id         UUID REFERENCES bd_leads(id) ON DELETE SET NULL,
    source             VARCHAR(10) NOT NULL DEFAULT 'inbound' CHECK (source IN ('inbound', 'outbound')),
    status             VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    approved_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_advertisers_updated_at BEFORE UPDATE ON advertisers
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- The rate card. city = NULL is the default; a row with a city overrides it there.
CREATE TABLE ad_rate_config (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    format_key     VARCHAR(30) NOT NULL,
    label          VARCHAR(120) NOT NULL,
    description    TEXT,
    pricing_unit   VARCHAR(10) NOT NULL CHECK (pricing_unit IN ('week', 'month', 'send')),
    rate           NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
    min_units      INTEGER NOT NULL DEFAULT 1 CHECK (min_units >= 1),
    -- Placements this format buys (a package buys several).
    placements     JSONB NOT NULL,
    -- How many advertisers can run in the slot at once (1 = exclusive).
    max_concurrent INTEGER,
    city           VARCHAR(120),
    is_active      BOOLEAN NOT NULL DEFAULT true,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_ad_rate ON ad_rate_config(format_key, COALESCE(lower(city), ''));

CREATE TABLE ad_campaigns (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    advertiser_id     UUID NOT NULL REFERENCES advertisers(id) ON DELETE RESTRICT,
    name              VARCHAR(160) NOT NULL,
    format_key        VARCHAR(30) NOT NULL,
    placements        JSONB NOT NULL,
    headline          VARCHAR(120),
    body              VARCHAR(400),
    image_url         VARCHAR(1000),
    cta_label         VARCHAR(40),
    cta_url           VARCHAR(1000),
    rera_number       VARCHAR(80),
    -- Sponsored / featured listing and institutional featured slot promote a listing.
    property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,
    -- A/B: an optional second creative.
    variant_b         JSONB,
    targeting         JSONB NOT NULL DEFAULT '{}'::jsonb,
    start_date        DATE NOT NULL,
    end_date          DATE NOT NULL,
    units             INTEGER NOT NULL CHECK (units >= 1),
    pricing_unit      VARCHAR(10) NOT NULL,
    rate              NUMERIC(12, 2) NOT NULL,
    amount            NUMERIC(14, 2) NOT NULL,
    sends_used        INTEGER NOT NULL DEFAULT 0,
    status            VARCHAR(16) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'pending_payment', 'pending_review', 'approved', 'paused', 'rejected', 'ended', 'cancelled')),
    review_flags      JSONB NOT NULL DEFAULT '[]'::jsonb,
    review_note       TEXT,
    reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at       TIMESTAMPTZ,
    submitted_at      TIMESTAMPTZ,
    renewal_alerted_at TIMESTAMPTZ,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_ad_dates CHECK (end_date >= start_date)
);

CREATE INDEX idx_ad_campaigns_serving ON ad_campaigns(status, start_date, end_date);
CREATE INDEX idx_ad_campaigns_advertiser ON ad_campaigns(advertiser_id, created_at DESC);
CREATE TRIGGER trg_ad_campaigns_updated_at BEFORE UPDATE ON ad_campaigns
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE ad_invoices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number     VARCHAR(30) NOT NULL UNIQUE,
    campaign_id        UUID NOT NULL UNIQUE REFERENCES ad_campaigns(id) ON DELETE RESTRICT,
    advertiser_id      UUID NOT NULL REFERENCES advertisers(id) ON DELETE RESTRICT,
    amount             NUMERIC(14, 2) NOT NULL,
    gst_percent        NUMERIC(5, 2) NOT NULL DEFAULT 18,
    gst_amount         NUMERIC(14, 2) NOT NULL,
    total_amount       NUMERIC(14, 2) NOT NULL,
    gstin              VARCHAR(20) NOT NULL,
    status             VARCHAR(10) NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'refunded', 'void')),
    gateway            VARCHAR(12),
    gateway_order_id   VARCHAR(80),
    gateway_payment_id VARCHAR(80),
    payment_reference  VARCHAR(120),
    paid_at            TIMESTAMPTZ,
    recorded_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every impression and click. user_hash is a salted hash - never the user id.
CREATE TABLE ad_events (
    id           BIGSERIAL PRIMARY KEY,
    campaign_id  UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
    kind         VARCHAR(10) NOT NULL CHECK (kind IN ('impression', 'click')),
    placement    VARCHAR(30) NOT NULL,
    variant      CHAR(1) NOT NULL DEFAULT 'A',
    user_hash    VARCHAR(64),
    city         VARCHAR(120),
    device       VARCHAR(10),
    -- One page view: repeat serves within it are not counted again.
    view_id      VARCHAR(40),
    event_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ad_events_cap ON ad_events(user_hash, event_date, campaign_id) WHERE kind = 'impression';
CREATE INDEX idx_ad_events_campaign ON ad_events(campaign_id, event_date, kind);
CREATE INDEX idx_ad_events_view ON ad_events(view_id) WHERE view_id IS NOT NULL;

INSERT INTO ad_rate_config (format_key, label, description, pricing_unit, rate, min_units, placements, max_concurrent, sort_order) VALUES
  ('home_hero',        'Homepage Hero Banner',                 'Top of the home page - full width, the most premium position.',                         'week',  0, 1, '["home_hero"]', NULL, 1),
  ('home_sidebar',     'Homepage Sidebar / Card',              'Two card slots on the home page; rotates when more than two advertisers are live.',     'week',  0, 2, '["home_sidebar"]', NULL, 2),
  ('search_sponsored', 'Search Results - Sponsored Listing',   'Your listing in the top 3 of search results, labelled Sponsored.',                      'month', 0, 1, '["search_sponsored"]', NULL, 3),
  ('city_banner',      'Area / City Page Banner',              'Banner at the top of a city or locality page.',                                         'month', 0, 1, '["city_banner"]', NULL, 4),
  ('crm_dashboard',    'CRM Dashboard Banner (broker-facing)', 'Banner on brokers'' CRM dashboard - a B2B audience.',                                  'month', 0, 1, '["crm_dashboard"]', NULL, 5),
  ('digest_sponsored', 'Notification Digest Sponsored Slot',   'One sponsored line in the daily match digest, labelled Sponsored. Priced per send.',    'send',  0, 5, '["digest_sponsored"]', NULL, 6),
  ('featured_listing', 'Featured Listing (property boost)',    'One listing shown first for its locality with a Featured badge.',                       'month', 0, 1, '["featured_listing"]', NULL, 7),
  ('institutional_featured', 'Institutional Deal Featured Slot','Top position in the institutional listings section.',                                 'month', 0, 1, '["institutional_featured"]', NULL, 8),
  ('login_splash',     'Login Splash Interstitial (exclusive)','Full-screen ad once per session after sign-in; dismissible after 3 seconds. One advertiser at a time.', 'week', 0, 1, '["login_splash"]', 1, 9),
  ('package_builder',  'Builder Project Campaign Package',     'All formats bundled for a project launch.',                                             'month', 0, 1, '["home_hero", "home_sidebar", "city_banner", "search_sponsored", "crm_dashboard", "digest_sponsored"]', NULL, 10),
  ('package_lender',   'Bank / NBFC Home Loan Campaign Package','CRM banner + digest slot + homepage sidebar.',                                          'month', 0, 1, '["crm_dashboard", "digest_sponsored", "home_sidebar"]', NULL, 11);

INSERT INTO app_config (config_key, value, category, description, is_statutory) VALUES
  ('ads.enabled', 'true', 'advertising', 'Module 17 - serve native ads on the website and the broker CRM.', false),
  ('ads.frequency_cap_per_day', '3', 'advertising', 'Most times one person sees the same ad in a day; after that the slot rotates to the next advertiser.', false),
  ('ads.gst_percent', '18', 'advertising', 'GST added to every advertising invoice.', true),
  ('ads.gstin', '"07DERPR1574G2ZY"', 'advertising', 'A R Buildwel GSTIN printed on advertising invoices.', true),
  ('ads.prohibited_phrases', '["guaranteed returns", "guaranteed return", "risk-free", "risk free", "assured returns", "assured return", "100% safe", "no risk", "double your money"]', 'advertising',
   'Phrases that may not appear in an ad creative (campaign approval check).', false),
  ('ads.rera_required_categories', '["builder_developer"]', 'advertising', 'Advertiser categories whose ads must show a RERA number.', false),
  ('ads.renewal_alert_days', '7', 'advertising', 'Days before a campaign ends that it is listed as an upcoming renewal and the advertiser is reminded.', false),
  ('ads.package_send_allowance', '30', 'advertising', 'Digest sends included per month in a package that has the digest slot.', false)
ON CONFLICT (config_key) DO NOTHING;

