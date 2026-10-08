-- Module 47 - Work From Home (WFH) Citizen-Sourcing.
-- Any registered user can become a field partner and earn a fixed amount
-- per verified task: bringing a buyer to a listed property, getting an
-- owner's consent for photos of an unlisted property, collecting a
-- requirement, helping an owner list, a condition report, an auction-property
-- field check, an area demand survey. Nothing is paid until the task passes
-- its checks (GPS, photo EXIF, OTP of the buyer / seller, representative or
-- admin confirmation). Earnings are paid monthly after TDS.
-- Phase 1: paid for the task, never for the deal (CONNECT is Phase 2).

ALTER TABLE property_media ADD COLUMN IF NOT EXISTS source_tag VARCHAR(30);

CREATE TABLE wfh_workers (
    user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- KYC, AES-256-GCM encrypted (utils/crypto). Hashes are for duplicate / same-person checks only.
    aadhaar_number_encrypted TEXT,
    aadhaar_hash             CHAR(64),
    aadhaar_last4            CHAR(4),
    pan_encrypted            TEXT,
    pan_hash                 CHAR(64),
    bank_account_encrypted   TEXT,
    bank_account_last4       VARCHAR(4),
    bank_ifsc                VARCHAR(11),
    bank_account_name        VARCHAR(120),
    kyc_status               VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
    kyc_note                 TEXT,
    kyc_decided_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    kyc_decided_at           TIMESTAMPTZ,
    agreement_version        VARCHAR(20),
    agreement_accepted_at    TIMESTAMPTZ,
    agreement_ip             VARCHAR(64),
    -- Where the worker operates: the task board is centred here.
    city                     VARCHAR(120),
    locality                 VARCHAR(160),
    latitude                 NUMERIC(10,7),
    longitude                NUMERIC(10,7),
    device_hash              CHAR(64),
    total_earned             NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_paid_out           NUMERIC(14,2) NOT NULL DEFAULT 0,
    rejection_rate           NUMERIC(5,2) NOT NULL DEFAULT 0,
    forfeit_rate             NUMERIC(5,2) NOT NULL DEFAULT 0,
    accept_blocked_until     TIMESTAMPTZ,
    status                   VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
    status_note              TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wfh_workers_aadhaar ON wfh_workers(aadhaar_hash);
CREATE INDEX idx_wfh_workers_device ON wfh_workers(device_hash);

CREATE TABLE wfh_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type       VARCHAR(20) NOT NULL CHECK (task_type IN ('buyer_visit', 'seller_photo', 'requirement_collect', 'listing_assist', 'condition_report', 'area_survey', 'auction_check')),
    property_id     UUID REFERENCES properties(id) ON DELETE CASCADE,
    requirement_id  UUID REFERENCES requirements(id) ON DELETE SET NULL,
    title           VARCHAR(200) NOT NULL,
    instructions    TEXT,
    city            VARCHAR(120),
    locality        VARCHAR(160),
    latitude        NUMERIC(10,7),
    longitude       NUMERIC(10,7),
    -- Copied from wfh_task_config when the task is created; never changes after.
    payment_amount  NUMERIC(10,2) NOT NULL,
    origin          VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (origin IN ('admin', 'no_photos', 'unmet_requirement')),
    expiry_at       TIMESTAMPTZ NOT NULL,
    status          VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'completed', 'verified', 'expired', 'cancelled')),
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wfh_tasks_board ON wfh_tasks(status, expiry_at);
CREATE INDEX idx_wfh_tasks_property ON wfh_tasks(property_id);

CREATE OR REPLACE FUNCTION trigger_wfh_task_payment_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.payment_amount IS DISTINCT FROM OLD.payment_amount THEN
    RAISE EXCEPTION 'wfh_tasks.payment_amount is immutable once the task is live';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wfh_task_payment_immutable
BEFORE UPDATE ON wfh_tasks
FOR EACH ROW EXECUTE FUNCTION trigger_wfh_task_payment_immutable();

CREATE TABLE wfh_task_assignments (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id                       UUID NOT NULL REFERENCES wfh_tasks(id) ON DELETE CASCADE,
    worker_id                     UUID NOT NULL REFERENCES wfh_workers(user_id) ON DELETE CASCADE,
    accepted_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    lock_expires_at               TIMESTAMPTZ NOT NULL,
    submitted_at                  TIMESTAMPTZ,
    gps_lat                       NUMERIC(10,7),
    gps_lng                       NUMERIC(10,7),
    gps_distance_from_property_m  INTEGER,
    photo_urls                    JSONB NOT NULL DEFAULT '[]',
    evidence                      JSONB NOT NULL DEFAULT '{}',
    -- The buyer's / seller's phone: encrypted, plus a hash for the duplicate checks.
    buyer_phone_submitted         TEXT,
    seller_phone_submitted        TEXT,
    party_phone_hash              CHAR(64),
    party_phone_last4             CHAR(4),
    party_name                    VARCHAR(150),
    otp_hash                      CHAR(64),
    otp_expires_at                TIMESTAMPTZ,
    otp_attempts                  SMALLINT NOT NULL DEFAULT 0,
    buyer_otp_confirmed           BOOLEAN NOT NULL DEFAULT false,
    seller_otp_confirmed          BOOLEAN NOT NULL DEFAULT false,
    otp_confirmed_at              TIMESTAMPTZ,
    rep_id                        UUID REFERENCES users(id) ON DELETE SET NULL,
    rep_due_at                    TIMESTAMPTZ,
    rep_confirmed                 BOOLEAN,
    rep_decided_at                TIMESTAMPTZ,
    rep_escalated_at              TIMESTAMPTZ,
    fraud_flags                   JSONB NOT NULL DEFAULT '[]',
    device_hash                   CHAR(64),
    state                         VARCHAR(12) NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'submitted', 'forfeited', 'closed')),
    verification_status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'passed', 'failed')),
    rejection_reason              TEXT,
    verified_by                   UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at                   TIMESTAMPTZ,
    lead_id                       UUID,
    payout_status                 VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (payout_status IN ('pending', 'credited', 'paid')),
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_wfh_assignment_active ON wfh_task_assignments(task_id) WHERE state IN ('accepted', 'submitted');
CREATE INDEX idx_wfh_assignments_worker ON wfh_task_assignments(worker_id, created_at DESC);
CREATE INDEX idx_wfh_assignments_phone ON wfh_task_assignments(party_phone_hash, submitted_at);
CREATE INDEX idx_wfh_assignments_review ON wfh_task_assignments(state, verification_status);

CREATE TABLE wfh_payouts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_number       VARCHAR(24) NOT NULL UNIQUE,
    worker_id           UUID NOT NULL REFERENCES wfh_workers(user_id) ON DELETE CASCADE,
    period              VARCHAR(7) NOT NULL,
    gross_amount        NUMERIC(14,2) NOT NULL,
    tds_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_amount          NUMERIC(14,2) NOT NULL,
    tds_rate_percent    NUMERIC(5,2) NOT NULL DEFAULT 0,
    bank_account_last4  VARCHAR(4),
    status              VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
    utr_reference       VARCHAR(60),
    paid_at             TIMESTAMPTZ,
    paid_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE wfh_payout_seq START 1;

CREATE TABLE wfh_earnings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id      UUID NOT NULL REFERENCES wfh_workers(user_id) ON DELETE CASCADE,
    assignment_id  UUID NOT NULL UNIQUE REFERENCES wfh_task_assignments(id) ON DELETE CASCADE,
    gross_amount   NUMERIC(10,2) NOT NULL,
    tds_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
    net_amount     NUMERIC(10,2) NOT NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'credited' CHECK (status IN ('pending', 'credited', 'paid')),
    payout_id      UUID REFERENCES wfh_payouts(id) ON DELETE SET NULL,
    paid_at        TIMESTAMPTZ,
    utr_reference  VARCHAR(60),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wfh_earnings_worker ON wfh_earnings(worker_id, status);

-- Admin-configurable amounts and rules; value is JSONB so an amount can carry city / property-type overrides.
CREATE TABLE wfh_task_config (
    config_key      VARCHAR(60) PRIMARY KEY,
    value           JSONB NOT NULL,
    description     VARCHAR(300),
    effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO wfh_task_config (config_key, value, description) VALUES
  ('buyer_visit_payment_default',         '{"amount": 0, "overrides": []}', 'Paid per verified buyer site visit'),
  ('seller_photo_payment_default',        '{"amount": 0, "overrides": []}', 'Paid per verified seller photo session'),
  ('requirement_collect_payment_default', '{"amount": 0, "overrides": []}', 'Paid per genuine requirement collected'),
  ('listing_assist_payment_default',      '{"amount": 0, "overrides": []}', 'Paid when the assisted listing passes verification and goes live'),
  ('condition_report_payment_default',    '{"amount": 0, "overrides": []}', 'Paid per accepted property condition report'),
  ('auction_check_payment_default',       '{"amount": 0, "overrides": []}', 'Paid per accepted auction-property field check'),
  ('area_survey_payment_default',         '{"amount": 0, "overrides": []}', 'Paid per consenting lead from an area demand survey'),
  ('program_label',            '"Work From Home"', 'Name shown to users: "Work From Home" or "ARB Field Network"'),
  ('agreement_version',        '"1.0"', 'Field Partner Agreement version a worker must accept'),
  ('board_radius_km',          '5',    'Task board shows tasks within this distance of the worker'),
  ('lock_hours',               '48',   'How long an accepted task is reserved for the worker'),
  ('task_expiry_days',         '14',   'How long a new task stays on the board'),
  ('otp_minutes',              '10',   'Buyer / seller OTP validity'),
  ('gps_visit_radius_m',       '100',  'GPS check-in must be within this distance of the property'),
  ('photo_radius_m',           '50',   'Photo EXIF location must be within this distance of the property'),
  ('photo_max_age_hours',      '24',   'Photos must have been taken within this many hours'),
  ('min_photos',               '5',    'Minimum photos for a seller photo session'),
  ('rep_confirm_hours',        '24',   'Representative must confirm a buyer visit within this time, then it escalates to admin'),
  ('max_submissions_per_day',  '5',    'Task submissions a worker may make in a day'),
  ('max_active_tasks',         '5',    'Tasks a worker may hold at once'),
  ('phone_dedupe_days',        '90',   'A buyer / seller phone already submitted in this period is rejected'),
  ('phone_repeat_flag_count',  '3',    'Same phone in this many WFH tasks in a month is flagged'),
  ('new_account_hours',        '24',   'A registered user must be at least this old to be a WFH-sourced buyer / seller'),
  ('rejection_rate_review_percent', '30', 'Rejection rate above this puts the worker under review'),
  ('forfeit_rate_suspend_percent',  '30', 'Forfeit rate above this pauses task acceptance'),
  ('forfeit_block_days',       '7',    'How long acceptance is paused after the forfeit rate is exceeded'),
  ('rejections_to_flag',       '3',    '"Did not happen" rejections after which the account is flagged'),
  ('min_payout',               '500',  'Verified earnings below this carry over to the next month'),
  ('gst_flag_amount',          '2000000', 'Cumulative yearly earnings at which the worker is flagged for GST registration'),
  ('auto_tasks_enabled',       'false', 'Create tasks automatically for listings without photos and unmet requirements'),
  ('auto_tasks_per_run',       '20',   'Most tasks created automatically in one run')
ON CONFLICT (config_key) DO NOTHING;

-- Statutory: TDS on task payments (sec. 194H today). Super Admin only, to follow a change in law.
INSERT INTO app_config (config_key, value, category, description, is_statutory) VALUES
  ('tax.payout_tds_percent', '5', 'statutory', 'TDS rate on commission / task payouts once the yearly threshold per PAN is crossed', true),
  ('tax.payout_tds_threshold', '15000', 'statutory', 'Cumulative payout per PAN per financial year above which TDS applies', true),
  ('tax.payout_tds_no_pan_percent', '20', 'statutory', 'TDS rate when no PAN is on record (sec. 206AA)', true),
  ('wfh.enabled', 'true', 'wfh', 'Module 47 - Work From Home citizen-sourcing', false)
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO gamification_rules (action_key, label, description, points, audience, sort_order) VALUES
  ('wfh_task_verified', 'Field task verified', 'A Work From Home task you completed passed verification.', 15, 'all', 14)
ON CONFLICT (action_key) DO NOTHING;
