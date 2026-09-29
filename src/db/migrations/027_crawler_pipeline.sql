-- =====================================================================
-- Migration: 027_crawler_pipeline.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 4 / Section 23 - Automated Data Acquisition Pipeline,
--            Layers 1 (crawler) and 2 (parser), feeding the existing
--            normalise -> filter & score -> publish layers
--            (opportunity_ingestion_items).
--              - crawler_sources: one row per crawler module in the
--                contract, admin-configured (URL, adapter, field mapping,
--                schedule). Every source starts DISABLED and not
--                legally approved - the client's counsel approves each
--                source (ToS / robots.txt review) before activation.
--              - crawler_runs: every run with counts, errors and the
--                archived raw payload - the crawler health dashboard.
--              - legal-review gate on ingestion items from legal /
--                newspaper notices (lawyer panel review before going live).
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE crawler_sources (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key                VARCHAR(60) NOT NULL UNIQUE,
    name                      VARCHAR(150) NOT NULL,
    module                    VARCHAR(60) NOT NULL,
    category                  VARCHAR(30) NOT NULL
        CHECK (category IN ('bank_auction', 'nbfc_arc', 'statutory', 'housing_board', 'newspaper_notice')),
    base_url                  VARCHAR(500),
    list_url                  VARCHAR(1000),
    adapter                   VARCHAR(20) NOT NULL DEFAULT 'html_list'
        CHECK (adapter IN ('html_list', 'json_api', 'rss', 'pdf_links')),
    config                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    schedule_hours            INT NOT NULL DEFAULT 12 CHECK (schedule_hours BETWEEN 1 AND 720),
    default_listing_category  VARCHAR(20) NOT NULL DEFAULT 'auction'
        CHECK (default_listing_category IN ('auction', 'special_situation')),
    requires_legal_review     BOOLEAN NOT NULL DEFAULT false,
    use_ai_parser             BOOLEAN NOT NULL DEFAULT false,
    max_pages                 INT NOT NULL DEFAULT 5 CHECK (max_pages BETWEEN 1 AND 50),
    is_enabled                BOOLEAN NOT NULL DEFAULT false,
    legal_approved            BOOLEAN NOT NULL DEFAULT false,
    legal_approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    legal_approved_at         TIMESTAMPTZ,
    legal_notes               TEXT,
    status                    VARCHAR(20) NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'healthy', 'failing', 'dead_letter')),
    consecutive_failures      INT NOT NULL DEFAULT 0,
    last_run_at               TIMESTAMPTZ,
    last_success_at           TIMESTAMPTZ,
    next_run_at               TIMESTAMPTZ,
    last_error                TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_crawler_sources_updated_at
BEFORE UPDATE ON crawler_sources
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE crawler_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id         UUID NOT NULL REFERENCES crawler_sources(id) ON DELETE CASCADE,
    trigger           VARCHAR(20) NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual', 'test')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    status            VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'success', 'partial', 'failed', 'blocked_robots', 'not_configured')),
    pages_fetched     INT NOT NULL DEFAULT 0,
    items_found       INT NOT NULL DEFAULT 0,
    items_ingested    INT NOT NULL DEFAULT 0,
    items_duplicate   INT NOT NULL DEFAULT 0,
    items_skipped     INT NOT NULL DEFAULT 0,
    error_type        VARCHAR(40),
    error_message     TEXT,
    recovery_action   TEXT,
    raw_object_path   VARCHAR(500),
    sample            JSONB,
    triggered_by      UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_crawler_runs_source ON crawler_runs(source_id, started_at DESC);

-- Legal-review gate (lawyer panel, Module 24) + which crawler produced the item.
ALTER TABLE opportunity_ingestion_items
    ADD COLUMN crawler_source_id     UUID REFERENCES crawler_sources(id) ON DELETE SET NULL,
    ADD COLUMN requires_legal_review BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN legal_reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN legal_reviewed_at     TIMESTAMPTZ,
    ADD COLUMN legal_review_notes    TEXT;

-- Every crawler module named in Annexure A sec. 23 / Engine 4. All start
-- disabled and unapproved; URLs are the public portal entry points - the
-- admin sets the exact listing URL and field mapping after legal approval.
INSERT INTO crawler_sources (source_key, name, module, category, base_url, list_url, adapter, schedule_hours, default_listing_category, requires_legal_review) VALUES
  ('sbi_eauction',      'SBI e-Auction',                        'crawler_sbi.js',              'bank_auction',     'https://sbi.co.in',                  'https://sbi.co.in/web/sbi-in-the-news/auction-notices/bank-e-auctions', 'html_list', 6,  'auction', false),
  ('ibapi',             'IBAPI (Indian Banks Auction Properties)', 'crawler_ibapi.js',         'bank_auction',     'https://ibapi.in',                   'https://ibapi.in',                         'html_list', 6,  'auction', false),
  ('mstc',              'MSTC e-Auction',                       'crawler_mstc.js',             'bank_auction',     'https://www.mstcecommerce.com',      'https://www.mstcecommerce.com',            'html_list', 6,  'auction', false),
  ('bank_of_baroda',    'Bank of Baroda auctions',              'crawler_bank_others.js',      'bank_auction',     'https://www.bankofbaroda.in',        NULL,                                       'html_list', 12, 'auction', false),
  ('canara_bank',       'Canara Bank auctions',                 'crawler_bank_others.js',      'bank_auction',     'https://canarabank.com',             NULL,                                       'html_list', 12, 'auction', false),
  ('union_bank',        'Union Bank of India auctions',         'crawler_bank_others.js',      'bank_auction',     'https://www.unionbankofindia.co.in', NULL,                                       'html_list', 12, 'auction', false),
  ('pnb',               'Punjab National Bank auctions',        'crawler_bank_others.js',      'bank_auction',     'https://www.pnbindia.in',            NULL,                                       'html_list', 12, 'auction', false),
  ('hdfc_bank',         'HDFC Bank auctions',                   'crawler_bank_others.js',      'bank_auction',     'https://www.hdfcbank.com',           NULL,                                       'html_list', 12, 'auction', false),
  ('icici_bank',        'ICICI Bank auctions',                  'crawler_bank_others.js',      'bank_auction',     'https://www.icicibank.com',          NULL,                                       'html_list', 12, 'auction', false),
  ('edelweiss_arc',     'Edelweiss ARC',                        'crawler_nbfc_arc.js',         'nbfc_arc',         'https://www.edelweissarc.in',        NULL,                                       'html_list', 12, 'special_situation', false),
  ('jm_financial_arc',  'JM Financial ARC',                     'crawler_nbfc_arc.js',         'nbfc_arc',         'https://www.jmfinancialarc.com',     NULL,                                       'html_list', 12, 'special_situation', false),
  ('piramal',           'Piramal Finance asset sales',          'crawler_nbfc_arc.js',         'nbfc_arc',         'https://www.piramalfinance.com',     NULL,                                       'html_list', 12, 'special_situation', false),
  ('indiabulls',        'Indiabulls asset sales',               'crawler_nbfc_arc.js',         'nbfc_arc',         'https://www.indiabullshomeloans.com', NULL,                                      'html_list', 12, 'special_situation', false),
  ('iifl',              'IIFL asset disposal',                  'crawler_nbfc_arc.js',         'nbfc_arc',         'https://www.iifl.com',               NULL,                                       'html_list', 12, 'special_situation', false),
  ('drt',               'DRT notice boards',                    'crawler_drt_nclt.js',         'statutory',        'https://drt.gov.in',                 NULL,                                       'html_list', 24, 'auction', true),
  ('nclt',              'NCLT insolvency property auctions',    'crawler_drt_nclt.js',         'statutory',        'https://nclt.gov.in',                NULL,                                       'html_list', 24, 'auction', true),
  ('dda',               'DDA housing',                          'crawler_housing_boards.js',   'housing_board',    'https://dda.gov.in',                 NULL,                                       'html_list', 24, 'auction', false),
  ('mhada',             'MHADA',                                'crawler_housing_boards.js',   'housing_board',    'https://mhada.gov.in',               NULL,                                       'html_list', 24, 'auction', false),
  ('dusib',             'DUSIB',                                'crawler_housing_boards.js',   'housing_board',    'https://delhishelterboard.in',       NULL,                                       'html_list', 24, 'auction', false),
  ('huda',              'HUDA / HSVP',                          'crawler_housing_boards.js',   'housing_board',    'https://hsvphry.org.in',             NULL,                                       'html_list', 24, 'auction', false),
  ('bda',               'BDA',                                  'crawler_housing_boards.js',   'housing_board',    'https://bdabangalore.org',           NULL,                                       'html_list', 24, 'auction', false),
  ('toi_notices',       'Times of India public notices',        'crawler_newspaper_notices.js','newspaper_notice', 'https://timesofindia.indiatimes.com', NULL,                                      'html_list', 48, 'special_situation', true),
  ('ht_notices',        'Hindustan Times public notices',       'crawler_newspaper_notices.js','newspaper_notice', 'https://www.hindustantimes.com',     NULL,                                       'html_list', 48, 'special_situation', true),
  ('ie_notices',        'Indian Express public notices',        'crawler_newspaper_notices.js','newspaper_notice', 'https://indianexpress.com',          NULL,                                       'html_list', 48, 'special_situation', true)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('crawler.enabled', 'false', 'crawler',
   'Master switch for the scheduled crawlers (sources must also be enabled and legally approved).'),
  ('crawler.min_request_interval_ms', '3000', 'crawler',
   'Minimum gap between requests to the same domain (Annexure A: max 1 request / 3 seconds).'),
  ('crawler.dead_letter_after_failures', '5', 'crawler',
   'Consecutive failed runs after which a source moves to the dead-letter state and stops until reset.'),
  ('crawler.user_agents', '["Mozilla/5.0 (compatible; PropertySerchBot/1.0; +https://propertyserch.com/bot)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PropertySerchBot/1.0", "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) PropertySerchBot/1.0"]', 'crawler',
   'User agents rotated between requests.')
ON CONFLICT (config_key) DO NOTHING;
