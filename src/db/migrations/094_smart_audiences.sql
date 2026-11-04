-- Smart Audience Engine - Module 49 (sec. "Smart Audience Engine", API
-- GET /audiences, GET /audiences/:id/members, POST /admin/audiences).
--
--   audience_segments  behaviour segments kept up to date from the events,
--                      lead scores and profiles the platform already holds.
--                      Each rule is JSON an admin edits in the CRM - no code
--                      change to add or tune a segment:
--                        { "match": "any" | "all", "conditions": [ ... ] }
--                      condition types: event_count, search_count, budget_above,
--                      distinct_views, lead_score, nri, combo (a nested rule).
--   audience_members   current membership (recomputed nightly and on demand);
--                      joined_at survives recomputes, left members are removed.
--   audience_sync_runs one row per push to Meta (Custom Audience) or Google
--                      Ads (Customer Match). Only members whose latest
--                      "marketing" consent is granted are ever sent, and only
--                      as SHA-256 hashes of the normalised email / phone.

CREATE TABLE IF NOT EXISTS audience_segments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_key        VARCHAR(40) NOT NULL UNIQUE CHECK (segment_key ~ '^[a-z][a-z0-9_]{2,39}$'),
    name               VARCHAR(100) NOT NULL,
    description        VARCHAR(500),
    rule               JSONB NOT NULL,
    active             BOOLEAN NOT NULL DEFAULT true,
    sync_meta          BOOLEAN NOT NULL DEFAULT false,
    sync_google        BOOLEAN NOT NULL DEFAULT false,
    -- The audience ids on the ad platforms (Meta custom audience id; Google
    -- Ads user list resource name). Set once the accounts exist.
    meta_audience_id   VARCHAR(40),
    google_user_list   VARCHAR(120),
    member_count       INT NOT NULL DEFAULT 0,
    last_computed_at   TIMESTAMPTZ,
    built_in           BOOLEAN NOT NULL DEFAULT false,
    created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audience_members (
    segment_id   UUID NOT NULL REFERENCES audience_segments(id) ON DELETE CASCADE,
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (segment_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_audience_members_customer ON audience_members (customer_id);

CREATE TABLE IF NOT EXISTS audience_sync_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id    UUID NOT NULL REFERENCES audience_segments(id) ON DELETE CASCADE,
    platform      VARCHAR(10) NOT NULL CHECK (platform IN ('meta', 'google')),
    status        VARCHAR(15) NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
    sent          INT NOT NULL DEFAULT 0,
    removed       INT NOT NULL DEFAULT 0,
    held_back     INT NOT NULL DEFAULT 0,
    detail        VARCHAR(500),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_audience_sync_runs_segment ON audience_sync_runs (segment_id, started_at DESC);

-- What was last sent to each platform, so the next sync adds the joiners and removes the leavers.
CREATE TABLE IF NOT EXISTS audience_synced_members (
    segment_id   UUID NOT NULL REFERENCES audience_segments(id) ON DELETE CASCADE,
    platform     VARCHAR(10) NOT NULL CHECK (platform IN ('meta', 'google')),
    customer_id  UUID NOT NULL,
    email_sha256 CHAR(64),
    phone_sha256 CHAR(64),
    synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (segment_id, platform, customer_id)
);

-- The eight segments of the contract, with the thresholds it names. All editable in CRM > Audiences.
INSERT INTO audience_segments (segment_key, name, description, rule, built_in) VALUES
  ('commercial_buyers', 'Commercial Property Buyers', 'Searched commercial property 3 or more times in 14 days',
   '{"match": "any", "conditions": [{"type": "search_count", "propertyTypes": ["commercial"], "minCount": 3, "days": 14}]}', true),
  ('luxury_buyers', 'Luxury Property Buyers', 'Explored a budget above Rs 2 Cr in any session',
   '{"match": "any", "conditions": [{"type": "budget_above", "minRupees": 20000000}]}', true),
  ('nri_buyers', 'NRI Buyers', 'NRI flag on the profile, or registered from outside India',
   '{"match": "any", "conditions": [{"type": "nri", "homeCountry": "IN"}]}', true),
  ('active_investors', 'Active Investors', 'Viewed 10 or more properties across 3 or more localities in 30 days',
   '{"match": "any", "conditions": [{"type": "distinct_views", "minProperties": 10, "minLocalities": 3, "days": 30}]}', true),
  ('high_intent', 'High Intent Leads', 'Lead score 70 or more',
   '{"match": "any", "conditions": [{"type": "lead_score", "min": 70}]}', true),
  ('site_visit_requested', 'Site Visit Requested', 'Asked for a site visit',
   '{"match": "any", "conditions": [{"type": "event_count", "eventTypes": ["site_visit_requested"], "minCount": 1, "days": 90}]}', true),
  ('whatsapp_enquiry', 'WhatsApp Enquiry Users', 'Clicked WhatsApp or enquired on WhatsApp in the last 30 days',
   '{"match": "any", "conditions": [{"type": "event_count", "eventTypes": ["whatsapp_click", "whatsapp_enquiry"], "minCount": 1, "days": 30}]}', true),
  ('deal_ready', 'Deal Ready Leads', 'Made an offer, or completed a site visit with a lead score of 80 or more',
   '{"match": "any", "conditions": [{"type": "event_count", "eventTypes": ["offer_made"], "minCount": 1, "days": 180},
                                    {"type": "combo", "match": "all", "conditions": [{"type": "event_count", "eventTypes": ["site_visit_completed"], "minCount": 1, "days": 180}, {"type": "lead_score", "min": 80}]}]}', true)
ON CONFLICT (segment_key) DO NOTHING;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('audiences.settings', '{"requireMarketingConsent": true, "minSyncSize": 100, "metaApiVersion": "v21.0", "googleAdsApiVersion": "v18"}'::jsonb, 'audiences',
   'Smart Audience Engine. Only members with marketing consent are sent to Meta / Google Ads (as SHA-256 hashes). Ad platforms refuse very small lists - minSyncSize holds a segment back until it has that many sendable members.')
ON CONFLICT (config_key) DO NOTHING;
