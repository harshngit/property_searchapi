-- =====================================================================
-- Migration: 044_guest_interest_push_market_data.sql
-- Project  : PropertySerch.com
-- Purpose  : Step 5 - Guest Interest (mobile + OTP, no account) log;
--            web-push subscriptions for the PWA; new public pages in the
--            sitemap.
--            Step 6 - crawler outputs beyond auction listings: State RERA
--            project registry, NHB / RBI price indices and portal market
--            statistics (aggregates only - never listings or contacts);
--            OCR settings for scanned notices.
-- DB       : PostgreSQL
-- =====================================================================

-- ------------------------------------------------------------ guest interest
-- One row per verified "I'm Interested" from a guest. The lead is tied to
-- the phone (customers.mobile), not to a user account; registering later
-- with the same mobile attaches the customer (and so every lead) to it.
CREATE TABLE guest_interests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mobile          VARCHAR(20) NOT NULL,
    full_name       VARCHAR(150),
    customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
    lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
    property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
    requirement_id  UUID REFERENCES requirements(id) ON DELETE SET NULL,
    message         TEXT,
    anonymous_id    VARCHAR(80),
    attribution     JSONB NOT NULL DEFAULT '{}'::jsonb,
    reused_lead     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_interests_mobile ON guest_interests(mobile, created_at DESC);

-- ------------------------------------------------------------ web push (PWA)
CREATE TABLE push_subscriptions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint         TEXT NOT NULL UNIQUE,
    p256dh           VARCHAR(200) NOT NULL,
    auth             VARCHAR(100) NOT NULL,
    user_agent       VARCHAR(300),
    app              VARCHAR(20) NOT NULL DEFAULT 'website',
    failure_count    INTEGER NOT NULL DEFAULT 0,
    last_success_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

-- ------------------------------------------------------------ crawler outputs
ALTER TABLE crawler_sources DROP CONSTRAINT crawler_sources_category_check;
ALTER TABLE crawler_sources ADD CONSTRAINT crawler_sources_category_check
  CHECK (category IN ('bank_auction', 'nbfc_arc', 'statutory', 'housing_board', 'newspaper_notice', 'rera', 'price_index', 'portal_market'));

-- Where a source's parsed rows go: the opportunity ingestion queue
-- (auction / special-situation listings) or a reference-data table.
ALTER TABLE crawler_sources
  ADD COLUMN output VARCHAR(20) NOT NULL DEFAULT 'opportunity'
    CHECK (output IN ('opportunity', 'rera_projects', 'price_indices', 'market_stats'));

ALTER TABLE crawler_runs ADD COLUMN IF NOT EXISTS ocr_pages INTEGER NOT NULL DEFAULT 0;

-- State RERA public project registry (Engine 5 due-diligence enrichment).
CREATE TABLE rera_projects (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state                     VARCHAR(60) NOT NULL,
    rera_number               VARCHAR(80) NOT NULL,
    rera_number_key           VARCHAR(80) NOT NULL,
    project_name              VARCHAR(300),
    promoter_name             VARCHAR(300),
    district                  VARCHAR(120),
    city                      VARCHAR(120),
    project_status            VARCHAR(20) NOT NULL DEFAULT 'unknown'
                                CHECK (project_status IN ('ongoing', 'completed', 'delayed', 'lapsed', 'revoked', 'unknown')),
    approved_units            INTEGER,
    complaints_count          INTEGER,
    registration_date         DATE,
    proposed_completion_date  DATE,
    source_url                VARCHAR(1000),
    crawler_source_id         UUID REFERENCES crawler_sources(id) ON DELETE SET NULL,
    first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_rera_project UNIQUE (rera_number_key)
);

CREATE INDEX idx_rera_projects_promoter ON rera_projects(lower(promoter_name));
CREATE INDEX idx_rera_projects_city ON rera_projects(lower(city));

-- NHB Residex / RBI House Price Index (Engine 6 base data).
CREATE TABLE price_indices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    index_source        VARCHAR(30) NOT NULL,
    index_kind          VARCHAR(40) NOT NULL DEFAULT 'composite',
    city                VARCHAR(120) NOT NULL,
    period              VARCHAR(12) NOT NULL,
    period_start        DATE,
    index_value         NUMERIC(10, 2) NOT NULL,
    yoy_change_percent  NUMERIC(7, 2),
    qoq_change_percent  NUMERIC(7, 2),
    source_url          VARCHAR(1000),
    crawler_source_id   UUID REFERENCES crawler_sources(id) ON DELETE SET NULL,
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_price_index UNIQUE (index_source, index_kind, city, period)
);

CREATE INDEX idx_price_indices_city ON price_indices(lower(city), period_start DESC);

-- Portal market statistics: aggregated area / city numbers ONLY. There is
-- deliberately no column that could hold a listing, a person or a contact.
CREATE TABLE market_stats (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_key            VARCHAR(60) NOT NULL,
    city                  VARCHAR(120) NOT NULL,
    locality              VARCHAR(160) NOT NULL DEFAULT '',
    property_type         VARCHAR(40) NOT NULL DEFAULT 'all',
    transaction_type      VARCHAR(10) NOT NULL DEFAULT 'sell' CHECK (transaction_type IN ('sell', 'rent')),
    avg_price_per_sqft    NUMERIC(12, 2),
    min_price_per_sqft    NUMERIC(12, 2),
    max_price_per_sqft    NUMERIC(12, 2),
    price_change_percent  NUMERIC(7, 2),
    demand_index          NUMERIC(7, 2),
    supply_count          INTEGER,
    rental_yield_percent  NUMERIC(6, 2),
    captured_on           DATE NOT NULL DEFAULT CURRENT_DATE,
    source_url            VARCHAR(1000),
    crawler_source_id     UUID REFERENCES crawler_sources(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_market_stat UNIQUE (portal_key, city, locality, property_type, transaction_type, captured_on)
);

CREATE INDEX idx_market_stats_area ON market_stats(lower(city), lower(locality), captured_on DESC);

-- New crawler modules (contract sec. 23 expanded list). Like every source:
-- off, and not runnable until legal approves it in the admin panel; the
-- URL / field mapping is completed there after the Terms-of-Service review.
INSERT INTO crawler_sources (source_key, name, module, category, base_url, list_url, adapter, schedule_hours, default_listing_category, requires_legal_review, output, config) VALUES
  ('rera_maharera',     'MahaRERA project registry',           'crawler_rera.js',          'rera',          'https://maharera.maharashtra.gov.in', NULL, 'html_list', 168, 'auction', false, 'rera_projects', '{"constants": {"state": "Maharashtra"}}'),
  ('rera_hrera',        'Haryana RERA (HRERA) project registry','crawler_rera.js',         'rera',          'https://haryanarera.gov.in',          NULL, 'html_list', 168, 'auction', false, 'rera_projects', '{"constants": {"state": "Haryana"}}'),
  ('rera_delhi',        'Delhi RERA project registry',         'crawler_rera.js',          'rera',          'https://rera.delhi.gov.in',           NULL, 'html_list', 168, 'auction', false, 'rera_projects', '{"constants": {"state": "Delhi"}}'),
  ('rera_tnrera',       'Tamil Nadu RERA (TNRERA) registry',   'crawler_rera.js',          'rera',          'https://www.rera.tn.gov.in',          NULL, 'html_list', 168, 'auction', false, 'rera_projects', '{"constants": {"state": "Tamil Nadu"}}'),
  ('rera_krera',        'Karnataka RERA (KRERA) registry',     'crawler_rera.js',          'rera',          'https://rera.karnataka.gov.in',       NULL, 'html_list', 168, 'auction', false, 'rera_projects', '{"constants": {"state": "Karnataka"}}'),
  ('rera_up',           'UP RERA project registry',            'crawler_rera.js',          'rera',          'https://www.up-rera.in',              NULL, 'html_list', 168, 'auction', false, 'rera_projects', '{"constants": {"state": "Uttar Pradesh"}}'),
  ('nhb_residex',       'NHB Residex (housing price index)',   'crawler_nhb_rbi.js',       'price_index',   'https://residex.nhbonline.org.in',    NULL, 'html_list', 720, 'auction', false, 'price_indices', '{"constants": {"index_source": "nhb_residex"}}'),
  ('rbi_hpi',           'RBI House Price Index reports',       'crawler_nhb_rbi.js',       'price_index',   'https://www.rbi.org.in',              NULL, 'pdf_links', 720, 'auction', false, 'price_indices', '{"constants": {"index_source": "rbi_hpi"}}'),
  ('portal_99acres',    '99acres market data pages',           'crawler_portal_market.js', 'portal_market', 'https://www.99acres.com',             NULL, 'html_list', 168, 'auction', false, 'market_stats', '{}'),
  ('portal_magicbricks','MagicBricks market trend pages',      'crawler_portal_market.js', 'portal_market', 'https://www.magicbricks.com',         NULL, 'html_list', 168, 'auction', false, 'market_stats', '{}'),
  ('portal_housing',    'Housing.com price trend reports',     'crawler_portal_market.js', 'portal_market', 'https://housing.com',                 NULL, 'html_list', 168, 'auction', false, 'market_stats', '{}'),
  ('portal_proptiger',  'PropTiger public market reports',     'crawler_portal_market.js', 'portal_market', 'https://www.proptiger.com',           NULL, 'html_list', 168, 'auction', false, 'market_stats', '{}'),
  ('portal_anarock',    'Anarock public market reports',       'crawler_portal_market.js', 'portal_market', 'https://www.anarock.com',             NULL, 'pdf_links', 168, 'auction', false, 'market_stats', '{}')
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO app_config (config_key, value, category, description, is_statutory) VALUES
  ('crawler.ocr_enabled', 'true', 'crawler',
   'Layer 2 - run OCR (Tesseract) on scanned notice PDFs / images that have no text layer.', false),
  ('crawler.ocr_languages', '"eng"', 'crawler',
   'Tesseract languages for notices, e.g. "eng" or "eng+hin" (each language downloads its model once).', false),
  ('crawler.ocr_max_pages', '8', 'crawler',
   'Most pages of one scanned PDF that are OCR-ed.', false),
  ('crawler.ocr_min_confidence', '55', 'crawler',
   'Below this Tesseract confidence the AI vision parser is used when an AI key is configured.', false),
  ('market.data_disclaimer', '"Data sourced from public portal listings and public indices. Updated {frequency}. For reference only - verify independently before transacting."', 'market',
   'Freshness label shown with every market-intelligence figure derived from crawled data.', false),
  ('guest_interest.reuse_lead_days', '30', 'leads',
   'A guest who expresses interest in the same listing again within this many days adds a note to the open lead instead of creating a duplicate.', false),
  ('push.enabled', 'true', 'notifications',
   'Send browser push for in-app notifications (needs VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).', false)
ON CONFLICT (config_key) DO NOTHING;

-- New public pages in sitemap.xml (kept admin-editable).
UPDATE app_config
SET value = (
  SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements_text(
    value || '["/about", "/contact", "/for-brokers", "/for-buyers", "/for-sellers", "/institutional", "/legal-coordination", "/loan-assistance", "/insurance", "/due-diligence", "/pricing", "/advertise", "/partner-with-us", "/requirements"]'::jsonb
  ) AS p
)
WHERE config_key = 'site.sitemap_static_paths';
