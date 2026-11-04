-- Contract sec. 25.5 - operational resilience.
--
--   Map / geo failover (25.5.2)  a listing is never blocked because the map or
--        the geocoder is down: a 6-digit pincode is accepted in place of the
--        pin and the location is filled in later (delayed geocoding).
--        properties.geo_status   pinned      - set on the map / typed lat-lng
--                                pending     - pincode only, waiting for the geocoder
--                                approximate - placed at the pincode / locality / city centre
--                                failed      - the geocoder gave up (staff pin it by hand)
--        pincode_geocodes        cache of pincode -> centre, so each pincode is looked up once
--   Crawler manual-entry queue (25.5.2)  when a source is blocked, dead-lettered
--        or has not succeeded for crawler.manual_after_hours, a task opens so
--        staff enter that source's inventory by hand until it recovers.
--   Status page (25.5.4)  incidents with components, impact, ETA and updates,
--        shown publicly and to franchisees / brokers in the CRM.
--   Backups (25.5.1)  every backup run (and restore test) is recorded, so the
--        status admin shows when the last good off-site backup was taken.

-- ---------------------------------------------------------------- geo
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS geo_status VARCHAR(12),
  ADD COLUMN IF NOT EXISTS geo_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS geocode_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_geo_status_check;
ALTER TABLE properties ADD CONSTRAINT properties_geo_status_check
  CHECK (geo_status IS NULL OR geo_status IN ('pinned', 'pending', 'approximate', 'failed'));
UPDATE properties SET geo_status = 'pinned', geo_source = 'map' WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND geo_status IS NULL;
CREATE INDEX IF NOT EXISTS idx_properties_geo_pending ON properties (geocode_attempts) WHERE geo_status = 'pending';

-- Every path that saves a listing (website, CRM, chat intake, institutional,
-- crawler) gets the same rule: a typed / pinned point is 'pinned'; no point
-- but a 6-digit pincode is 'pending' for the geocoder. The geocoder sets
-- geo_status itself ('approximate' / 'failed'), which this keeps.
CREATE OR REPLACE FUNCTION properties_geo_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latitude IS NULL OR NEW.longitude IS NULL THEN
    IF NEW.pincode ~ '^[0-9]{6}$' THEN
      IF TG_OP = 'INSERT' OR NEW.geo_status IS NULL OR NEW.geo_status = 'pinned'
         OR NEW.pincode IS DISTINCT FROM OLD.pincode THEN
        NEW.geo_status := 'pending';
        NEW.geocode_attempts := 0;
      END IF;
    ELSE
      NEW.geo_status := NULL;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.geo_status IS NULL OR NEW.geo_status = 'pending' THEN NEW.geo_status := 'pinned'; NEW.geo_source := COALESCE(NEW.geo_source, 'map'); END IF;
  ELSIF (NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude)
        AND NEW.geo_status IS NOT DISTINCT FROM OLD.geo_status THEN
    -- Moved by a person (the geocoder always sets the status with the point).
    NEW.geo_status := 'pinned';
    NEW.geo_source := 'map';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_properties_geo_status ON properties;
CREATE TRIGGER trg_properties_geo_status BEFORE INSERT OR UPDATE OF latitude, longitude, pincode, geo_status ON properties
FOR EACH ROW EXECUTE FUNCTION properties_geo_status();
UPDATE properties SET geo_status = 'pending' WHERE (latitude IS NULL OR longitude IS NULL) AND pincode ~ '^[0-9]{6}$';

CREATE TABLE IF NOT EXISTS pincode_geocodes (
    pincode      VARCHAR(6) PRIMARY KEY,
    latitude     NUMERIC(10,7),
    longitude    NUMERIC(10,7),
    source       VARCHAR(20) NOT NULL,
    found        BOOLEAN NOT NULL,
    looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- crawler manual queue
CREATE TABLE IF NOT EXISTS crawler_manual_tasks (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    crawler_source_id UUID NOT NULL REFERENCES crawler_sources(id) ON DELETE CASCADE,
    reason            VARCHAR(20) NOT NULL CHECK (reason IN ('dead_letter', 'blocked_robots', 'stale')),
    detail            VARCHAR(500),
    status            VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    due_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    items_entered     INT NOT NULL DEFAULT 0,
    checks            JSONB NOT NULL DEFAULT '[]'::jsonb,
    alerted_at        TIMESTAMPTZ,
    opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at         TIMESTAMPTZ,
    close_note        VARCHAR(300)
);
-- One open task per source.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crawler_manual_open ON crawler_manual_tasks (crawler_source_id) WHERE status = 'open';

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('crawler.manual_after_hours', '72'::jsonb, 'crawler',
   'Sec. 25.5.2 - a source with no successful run for this many hours (past its schedule) opens a manual-entry task'),
  ('crawler.manual_check_every_hours', '24'::jsonb, 'crawler',
   'How often staff must check a blocked source by hand (enter its new items, or record that there were none)'),
  ('geo.geocoder_order', '["google", "nominatim", "master_data"]'::jsonb, 'geo',
   'Sec. 25.5.2 - delayed geocoding of pincode-only listings: providers tried in order. google needs GOOGLE_GEOCODING_API_KEY; master_data uses the locality / city centre (approximate)'),
  ('geo.max_geocode_attempts', '5'::jsonb, 'geo', 'Attempts before a pincode-only listing is marked failed for staff to pin by hand')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------- status page
CREATE TABLE IF NOT EXISTS platform_incidents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference     VARCHAR(20) NOT NULL UNIQUE,
    title         VARCHAR(160) NOT NULL,
    impact        VARCHAR(10) NOT NULL CHECK (impact IN ('minor', 'major', 'critical', 'maintenance')),
    status        VARCHAR(14) NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled')),
    components    TEXT[] NOT NULL DEFAULT '{}',
    eta_at        TIMESTAMPTZ,
    starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ,
    notified_at   TIMESTAMPTZ,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_incidents_open ON platform_incidents (starts_at DESC) WHERE status <> 'resolved';
CREATE SEQUENCE IF NOT EXISTS platform_incident_seq;

CREATE TABLE IF NOT EXISTS platform_incident_updates (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id  UUID NOT NULL REFERENCES platform_incidents(id) ON DELETE CASCADE,
    status       VARCHAR(14) NOT NULL,
    message      VARCHAR(1000) NOT NULL,
    eta_at       TIMESTAMPTZ,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_incident_updates ON platform_incident_updates (incident_id, created_at);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('status.components', '[
     {"key": "website", "label": "Website and listings"},
     {"key": "crm", "label": "CRM"},
     {"key": "login", "label": "Sign-in and OTP"},
     {"key": "whatsapp", "label": "WhatsApp"},
     {"key": "telegram", "label": "Telegram"},
     {"key": "payments", "label": "Payments"},
     {"key": "maps", "label": "Maps and location"},
     {"key": "notifications", "label": "Notifications"},
     {"key": "ai", "label": "AI features"}
   ]'::jsonb, 'status', 'Sec. 25.5.4 - parts of the platform shown on the status page'),
  ('status.notify_roles', '["franchisee_admin", "broker", "agency_admin", "builder"]'::jsonb, 'status',
   'Roles told in-app when a major / critical incident or maintenance is posted, and when it is resolved')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------- backups
CREATE TABLE IF NOT EXISTS backup_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         VARCHAR(14) NOT NULL CHECK (kind IN ('backup', 'restore_test')),
    status       VARCHAR(10) NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    target       VARCHAR(300),
    size_bytes   BIGINT,
    sha256       VARCHAR(64),
    retain_until TIMESTAMPTZ,
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error        VARCHAR(1000),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_backup_runs_recent ON backup_runs (kind, started_at DESC);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('backup.max_age_hours', '26'::jsonb, 'backup', 'Sec. 25.4 / 25.5.1 - the status admin warns when the last good off-site backup is older than this'),
  ('backup.restore_test_max_age_days', '35'::jsonb, 'backup', 'Warn when the last successful restore test is older than this (contract: test restores before each release, DR drill quarterly)')
ON CONFLICT (config_key) DO NOTHING;
