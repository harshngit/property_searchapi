-- Module 33 - Data Ownership & Export (DPDP Act 2023, sec. 19.1)
--   consent_logs     what a person agreed to, when, which version (append-only)
--   data_requests    "give me my data" and "delete my data" requests with
--                    the 30-day clock; deletion = anonymisation, never a
--                    hard delete, and waits while a legal hold applies
--                    (open deal, unpaid invoice, active mandate)
--   events           stay append-only, except that the anonymiser may blank
--                    a person's identifiers (sec. 16: "events not deleted -
--                    PII zeroed")
-- Module 32 - Compliance & Risk Alerts
--   compliance_rules   what is checked (on / off, severity, thresholds)
--   compliance_alerts  one row per rule + record; opened and closed by the
--                      hourly sweep, acknowledged / dismissed by staff

CREATE TABLE consent_logs (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
    category         VARCHAR(30) NOT NULL,
    consent_version  VARCHAR(20) NOT NULL,
    granted          BOOLEAN NOT NULL DEFAULT true,
    source           VARCHAR(30) NOT NULL DEFAULT 'registration',
    ip_address       VARCHAR(64),
    user_agent       VARCHAR(500),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_logs_user ON consent_logs(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION trigger_consent_logs_append_only()
RETURNS TRIGGER AS $$
BEGIN
  -- ON DELETE SET NULL on the user is the only change allowed.
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.category = NEW.category AND OLD.granted = NEW.granted AND OLD.created_at = NEW.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'consent_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_logs_append_only
BEFORE UPDATE OR DELETE ON consent_logs
FOR EACH ROW EXECUTE FUNCTION trigger_consent_logs_append_only();

CREATE SEQUENCE data_request_seq START 1;

CREATE TABLE data_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number  VARCHAR(20) NOT NULL UNIQUE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    kind            VARCHAR(12) NOT NULL CHECK (kind IN ('export', 'deletion', 'inactivity')),
    status          VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'on_hold', 'completed', 'cancelled', 'rejected')),
    reason          TEXT,
    hold_reasons    JSONB NOT NULL DEFAULT '[]',
    decision_note   TEXT,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 30 days from the request: the notice period for a deletion, the SLA for an export.
    due_at          TIMESTAMPTZ NOT NULL,
    processed_at    TIMESTAMPTZ,
    processed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    summary         JSONB,
    ip_address      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_data_requests_open ON data_requests(status, due_at);
CREATE UNIQUE INDEX uq_data_requests_open_deletion ON data_requests(user_id) WHERE kind IN ('deletion', 'inactivity') AND status IN ('pending', 'on_hold');

ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMPTZ;

-- The anonymiser sets app.dpdp_anonymise for its transaction; nothing else may touch events.
CREATE OR REPLACE FUNCTION trigger_reject_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('app.dpdp_anonymise', true) = 'on'
     AND NEW.event_id = OLD.event_id AND NEW.event_timestamp = OLD.event_timestamp AND NEW.event_type = OLD.event_type THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE compliance_rules (
    rule_key     VARCHAR(40) PRIMARY KEY,
    label        VARCHAR(120) NOT NULL,
    description  VARCHAR(400),
    area         VARCHAR(20) NOT NULL,
    severity     VARCHAR(10) NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
    is_active    BOOLEAN NOT NULL DEFAULT true,
    params       JSONB NOT NULL DEFAULT '{}',
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_alerts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key       VARCHAR(40) NOT NULL REFERENCES compliance_rules(rule_key) ON DELETE CASCADE,
    entity_type    VARCHAR(30) NOT NULL,
    entity_id      VARCHAR(80) NOT NULL,
    title          VARCHAR(200) NOT NULL,
    detail         TEXT,
    city           VARCHAR(120),
    owner_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    severity       VARCHAR(10) NOT NULL,
    status         VARCHAR(14) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    note           TEXT,
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    handled_at     TIMESTAMPTZ,
    resolved_at    TIMESTAMPTZ,
    auto_resolved  BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (rule_key, entity_id)
);
CREATE INDEX idx_compliance_alerts_status ON compliance_alerts(status, severity);

INSERT INTO compliance_rules (rule_key, label, description, area, severity, params, sort_order) VALUES
  ('rera_missing_builder_listing', 'Builder listing live without a RERA number', 'RERA registration is mandatory on builder listings (sec. 19.2).', 'rera', 'critical', '{}', 1),
  ('verification_expired',         'Verification expired',                        'A RERA, GST or KYC verification on an active profile has expired.', 'rera', 'high', '{}', 2),
  ('professional_unverified_live', 'Live listings from an unverified broker or builder', 'A broker or builder has live listings but no approved KYC.', 'kyc', 'medium', '{"min_listings": 1}', 3),
  ('fraud_listing_live',           'High-fraud-risk listing is live',             'A listing in the red or critical fraud band is publicly visible.', 'fraud', 'critical', '{}', 4),
  ('listing_review_overdue',       'Listing held for review past its deadline',   'An Under Review listing has passed its 24-hour manual review window.', 'fraud', 'high', '{}', 5),
  ('invoice_overdue',              'Professional-fee invoice overdue',            'A GST invoice is unpaid after its due date.', 'gst', 'high', '{"grace_days": 0}', 6),
  ('mandate_breached',             'Exclusive mandate breached',                  'A mandate has been marked breached and needs the breach letter / follow-up.', 'mandate', 'high', '{}', 7),
  ('dispute_sla_breached',         'Dispute past its resolution deadline',        'An open dispute has passed its 48-hour SLA.', 'disputes', 'high', '{}', 8),
  ('lead_response_overdue',        'Enquiry not answered within its SLA',         'A lead has had no first contact after its response deadline.', 'intermediation', 'medium', '{"grace_hours": 4}', 9),
  ('dpdp_request_due',             'Data request close to its 30-day limit',      'A data export or deletion request is due soon or overdue (DPDP sec. 19.1).', 'dpdp', 'critical', '{"warn_days": 5}', 10),
  ('consent_missing',              'Active users without a recorded consent',     'People using the platform with no consent on record for the current policy version.', 'dpdp', 'medium', '{}', 11),
  ('crawler_without_legal_approval', 'Crawler running without legal approval',    'A data source that needs legal review is switched on without approval.', 'data', 'critical', '{}', 12)
ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('privacy.consent_version', '"2026-10"', 'privacy', 'Version of the privacy / consent wording people agree to; raise it when the wording changes'),
  ('privacy.deletion_notice_days', '30', 'privacy', 'Days between a deletion request and anonymisation (the person can cancel in this window)'),
  ('privacy.inactive_years', '2', 'privacy', 'An account with no sign-in for this long gets a 30-day notice and is then anonymised'),
  ('privacy.inactivity_sweep_enabled', 'false', 'privacy', 'Switch on to start sending inactivity notices (off until the client confirms)'),
  ('compliance.enabled', 'true', 'compliance', 'Run the hourly compliance and risk checks')
ON CONFLICT (config_key) DO NOTHING;
