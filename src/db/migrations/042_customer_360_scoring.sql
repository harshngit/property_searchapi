-- =====================================================================
-- Migration: 042_customer_360_scoring.sql
-- Project  : PropertySerch.com
-- Purpose  : Engine 9 - Module 48 Customer 360 & Event Capture and
--            Module 49 Lead Scoring:
--              - events                 dual-track (browser + server)
--                                       append-only, partitioned by month,
--                                       7-year retention
--              - identity_links         anonymous browser id -> user /
--                                       customer (merge on registration /
--                                       login / enquiry; events never edited)
--              - customer_360_profiles  identity, behaviour, attribution,
--                                       transaction - refreshed on events
--              - lead_scoring_config    admin-editable factors (no code)
--              - lead_scores            0-100 + HOT / WARM / NURTURE / COLD
--              - leads.lead_score*      denormalised for fast CRM lists
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE events (
    event_id            UUID NOT NULL DEFAULT gen_random_uuid(),
    event_timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type          VARCHAR(40) NOT NULL,
    source_track        VARCHAR(15) NOT NULL CHECK (source_track IN ('browser', 'server', 'whatsapp', 'telegram', 'phone', 'external_api')),
    user_id             UUID,
    anonymous_id        VARCHAR(64),
    customer_id         UUID,
    lead_id             UUID,
    session_id          VARCHAR(64),
    properties_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
    attribution_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
    device_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
    org_id              UUID,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, event_timestamp)
) PARTITION BY RANGE (event_timestamp);

CREATE TABLE events_default PARTITION OF events DEFAULT;

-- Monthly partitions from the start of 2026 to 12 months ahead; the
-- scheduler keeps creating the next months (events.service).
DO $$
DECLARE m DATE := DATE '2026-01-01';
BEGIN
  WHILE m <= (date_trunc('month', now()) + interval '12 months')::date LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
                   'events_' || to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

CREATE INDEX idx_events_user ON events (user_id, event_timestamp);
CREATE INDEX idx_events_anon ON events (anonymous_id, event_timestamp);
CREATE INDEX idx_events_type ON events (event_type, event_timestamp);
CREATE INDEX idx_events_org ON events (org_id, event_timestamp);
CREATE INDEX idx_events_customer ON events (customer_id, event_timestamp);
CREATE INDEX idx_events_lead ON events (lead_id, event_timestamp);

CREATE OR REPLACE FUNCTION trigger_reject_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
BEFORE UPDATE OR DELETE ON events
FOR EACH ROW EXECUTE FUNCTION trigger_reject_event_mutation();

-- anonymous browser id -> known person (one row per link, never edited).
CREATE TABLE identity_links (
    anonymous_id    VARCHAR(64) NOT NULL,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
    linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (anonymous_id)
);

CREATE INDEX idx_identity_links_user ON identity_links(user_id);
CREATE INDEX idx_identity_links_customer ON identity_links(customer_id);

CREATE TABLE customer_360_profiles (
    customer_id         UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    identity            JSONB NOT NULL DEFAULT '{}'::jsonb,
    behaviour           JSONB NOT NULL DEFAULT '{}'::jsonb,
    attribution         JSONB NOT NULL DEFAULT '{}'::jsonb,
    transactions        JSONB NOT NULL DEFAULT '{}'::jsonb,
    engagement_score    SMALLINT NOT NULL DEFAULT 0,
    last_active_at      TIMESTAMPTZ,
    refreshed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lead_scoring_config (
    factor_key      VARCHAR(40) PRIMARY KEY,
    label           VARCHAR(120) NOT NULL,
    points          SMALLINT NOT NULL,
    condition_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
    active          BOOLEAN NOT NULL DEFAULT true,
    display_order   SMALLINT NOT NULL DEFAULT 0,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO lead_scoring_config (factor_key, label, points, condition_json, display_order) VALUES
  ('views_1_3',          'Property views (1-3 unique)',                  5,  '{"min": 1, "max": 3}', 1),
  ('views_4_10',         'Property views (4-10 unique)',                 10, '{"min": 4, "max": 10}', 2),
  ('views_10_plus',      'Property views (more than 10 unique)',         15, '{"min": 11}', 3),
  ('search',             'Search performed (per session)',               3,  '{"cap": 15}', 4),
  ('whatsapp_click',     'WhatsApp click',                               8,  '{}', 5),
  ('call_click',         'Call click / call request',                    12, '{}', 6),
  ('site_visit_requested','Site visit requested',                        20, '{}', 7),
  ('site_visit_completed','Site visit completed',                        25, '{}', 8),
  ('registration',       'Registration completed',                       10, '{}', 9),
  ('budget_match',       'Budget within 10% of a live listing',          8,  '{"tolerance_percent": 10}', 10),
  ('location_match',     'Searched locality has available listings',     7,  '{}', 11),
  ('active_7d',          'Active in last 7 days',                        10, '{"days": 7}', 12),
  ('active_1d',          'Active in last 1 day (replaces 7-day bonus)',  15, '{"days": 1}', 13),
  ('shortlisted',        'Shortlisted a property',                       10, '{}', 14),
  ('offer_made',         'Offer made',                                   20, '{}', 15);

CREATE TABLE lead_scores (
    customer_id         UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    score               SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
    category            VARCHAR(10) NOT NULL CHECK (category IN ('hot', 'warm', 'nurture', 'cold')),
    previous_category   VARCHAR(10),
    breakdown           JSONB NOT NULL DEFAULT '[]'::jsonb,
    hot_alerted_at      TIMESTAMPTZ,
    last_computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_scores_category ON lead_scores(category, score DESC);

ALTER TABLE leads
    ADD COLUMN lead_score           SMALLINT,
    ADD COLUMN lead_score_category  VARCHAR(10);

CREATE INDEX idx_leads_score ON leads(lead_score_category, lead_score DESC);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('scoring.thresholds', '{"hot": 90, "warm": 70, "nurture": 40}', 'scoring', 'Module 49 - score bands: HOT >= hot, WARM >= warm, NURTURE >= nurture, else COLD.'),
  ('scoring.warm_digest_time', '"09:30"', 'scoring', 'IST time of the daily WARM-lead digest to representatives.'),
  ('scoring.nurture_summary_weekday', '1', 'scoring', 'Day of week (0 = Sunday) for the weekly NURTURE summary.'),
  ('events.retention_years', '7', 'events', 'Event retention (years) - partitions older than this may be detached for archive.'),
  ('events.browser_types', '["page_view", "property_view", "search_performed", "button_click", "whatsapp_click", "call_click", "registration_started", "registration_completed", "login", "shortlist_added", "site_visit_requested"]', 'events', 'Browser event types accepted by POST /events/track.')
ON CONFLICT (config_key) DO NOTHING;
