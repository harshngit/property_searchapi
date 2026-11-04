-- Employee incentive engine - contract sec. 33.3 / 33.9 / 33.12 / 34.
--
--   EM codes      EM-[DESIGNATION:2]-[SERIAL:3], e.g. EM-RM-012. Issued to every
--                 A R representative (arb_representatives). The serial is
--                 permanent for the whole tenure - on promotion only the
--                 designation block changes (EM-TC-007 -> EM-TL-007) - and is
--                 retired for good on exit, never reissued (a sequence, never
--                 reused). Never public: internal attribution only.
--   Scoring       incentive_events, append-only: one row per scoring fact,
--                 taken from the records the platform already keeps:
--                   cascade_attended   first contact logged on an inquiry (sec. 34: "attended ones count for it")
--                   cascade_missed     the response window missed, inquiry moved on ("count against")
--                   sla_breached       the overall response SLA passed with no contact
--                   site_visit_done    a site visit completed on the rep's deal
--                   deal_closed        the rep's deal closed won (+ points per lakh of deal value)
--                   adjustment         a manual correction by an admin, with a reason
--                 A related-party transaction (sec. 33.12) still gets its row,
--                 marked excluded with 0 points - never counted for that employee.
--   Months        incentive_periods: open -> approved (statement frozen, amounts
--                 per incentive.rules) -> exported (sent to payroll). Employees
--                 earn incentives, never commissions, and the payout itself
--                 stays in payroll (TDS on salary) - nothing is paid here.

-- ---------------------------------------------------------------- EM codes
CREATE SEQUENCE IF NOT EXISTS employee_serial_seq START 1;

-- EM-RM-012; a serial past 999 keeps all its digits (lpad alone would cut it).
CREATE OR REPLACE FUNCTION employee_code_text(d TEXT, s INT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT 'EM-' || upper(d) || '-' || CASE WHEN length(s::text) < 3 THEN lpad(s::text, 3, '0') ELSE s::text END
$$;

CREATE TABLE IF NOT EXISTS employee_codes (
    user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    serial         INT NOT NULL UNIQUE,
    designation    VARCHAR(2) NOT NULL,
    em_code        VARCHAR(12) NOT NULL UNIQUE,
    status         VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    terminated_at  TIMESTAMPTZ,
    exit_reason    VARCHAR(300),
    history        JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE OR REPLACE FUNCTION employee_code_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d VARCHAR(2) := upper(NEW.designation);
  c employee_codes%ROWTYPE;
  s INT;
BEGIN
  SELECT * INTO c FROM employee_codes WHERE user_id = NEW.user_id;
  IF NOT FOUND THEN
    s := nextval('employee_serial_seq');
    INSERT INTO employee_codes (user_id, serial, designation, em_code, history)
    VALUES (NEW.user_id, s, d, employee_code_text(d, s),
            jsonb_build_array(jsonb_build_object('at', now(), 'event', 'issued', 'designation', d)));
  ELSIF c.status = 'active' AND c.designation <> d THEN
    -- Promotion / transfer: same serial, new designation block.
    UPDATE employee_codes SET designation = d, em_code = employee_code_text(d, c.serial),
           history = history || jsonb_build_array(jsonb_build_object('at', now(), 'event', 'designation_changed', 'from', c.designation, 'to', d))
    WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_employee_code_sync ON arb_representatives;
CREATE TRIGGER trg_employee_code_sync AFTER INSERT OR UPDATE OF designation ON arb_representatives
FOR EACH ROW EXECUTE FUNCTION employee_code_sync();

-- A retired serial is never reissued: the row stays (ON DELETE RESTRICT) and the code is frozen.
CREATE OR REPLACE FUNCTION employee_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'employee codes are never deleted - terminate instead'; END IF;
  IF NEW.serial <> OLD.serial THEN RAISE EXCEPTION 'the serial of an employee code never changes'; END IF;
  IF OLD.status = 'terminated' AND (NEW.status <> 'terminated' OR NEW.em_code <> OLD.em_code) THEN
    RAISE EXCEPTION 'a terminated employee code is retired permanently';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_employee_code_guard ON employee_codes;
CREATE TRIGGER trg_employee_code_guard BEFORE UPDATE OR DELETE ON employee_codes FOR EACH ROW EXECUTE FUNCTION employee_code_guard();

-- Codes for the representatives who already exist, in the order they joined.
DO $$
DECLARE r RECORD; s INT;
BEGIN
  FOR r IN SELECT ar.user_id, upper(ar.designation) AS d FROM arb_representatives ar
           WHERE NOT EXISTS (SELECT 1 FROM employee_codes c WHERE c.user_id = ar.user_id) ORDER BY ar.created_at, ar.user_id LOOP
    s := nextval('employee_serial_seq');
    INSERT INTO employee_codes (user_id, serial, designation, em_code, history)
    VALUES (r.user_id, s, r.d, employee_code_text(r.d, s),
            jsonb_build_array(jsonb_build_object('at', now(), 'event', 'issued', 'designation', r.d)));
  END LOOP;
END $$;

-- ---------------------------------------------------------------- scoring
CREATE TABLE IF NOT EXISTS incentive_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    em_code         VARCHAR(12) NOT NULL,
    period          DATE NOT NULL,
    kind            VARCHAR(20) NOT NULL CHECK (kind IN ('cascade_attended', 'cascade_missed', 'sla_breached', 'site_visit_done', 'deal_closed', 'adjustment')),
    points          NUMERIC(10,2) NOT NULL,
    excluded        BOOLEAN NOT NULL DEFAULT false,
    exclude_reason  VARCHAR(200),
    source_type     VARCHAR(20) NOT NULL,
    source_id       UUID NOT NULL,
    lead_id         UUID,
    deal_id         UUID,
    occurred_at     TIMESTAMPTZ NOT NULL,
    note            VARCHAR(300),
    late            BOOLEAN NOT NULL DEFAULT false,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Each fact scores once per employee.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incentive_events_source ON incentive_events (kind, source_type, source_id, user_id) WHERE kind <> 'adjustment';
CREATE INDEX IF NOT EXISTS idx_incentive_events_user_period ON incentive_events (user_id, period);
CREATE INDEX IF NOT EXISTS idx_incentive_events_period ON incentive_events (period);
CREATE INDEX IF NOT EXISTS idx_incentive_events_source ON incentive_events (source_type, source_id);

CREATE OR REPLACE FUNCTION incentive_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'incentive_events is append-only - correct with an adjustment';
END $$;
DROP TRIGGER IF EXISTS trg_incentive_events_append_only ON incentive_events;
CREATE TRIGGER trg_incentive_events_append_only BEFORE UPDATE OR DELETE ON incentive_events FOR EACH ROW EXECUTE FUNCTION incentive_events_append_only();

-- ---------------------------------------------------------------- months
CREATE TABLE IF NOT EXISTS incentive_periods (
    period          DATE PRIMARY KEY CHECK (extract(day FROM period) = 1),
    status          VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'exported')),
    rules           JSONB,
    approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    exported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    exported_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS incentive_statements (
    period          DATE NOT NULL REFERENCES incentive_periods(period),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    em_code         VARCHAR(12) NOT NULL,
    designation     VARCHAR(2) NOT NULL,
    points          NUMERIC(12,2) NOT NULL,
    excluded_points NUMERIC(12,2) NOT NULL DEFAULT 0,
    breakdown       JSONB NOT NULL,
    amount_inr      NUMERIC(12,2) NOT NULL,
    PRIMARY KEY (period, user_id)
);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('incentive.rules', '{
     "points": {"cascade_attended": 5, "cascade_missed": -10, "sla_breached": -5, "site_visit_done": 10, "deal_closed": 50},
     "dealPointsPerLakh": 1,
     "dealPointsCap": 500,
     "rupeesPerPoint": 0,
     "minPointsForPayout": 0,
     "monthlyCapInr": null,
     "designations": ["rm", "dm", "tl", "tc", "fm", "ld", "id", "ch", "ah"]
   }'::jsonb, 'incentive',
   'Employee incentive scoring (sec. 33 / 34). Points per fact; rupeesPerPoint 0 until A R Buildwel sets the incentive rate. Super Admin only. A month is scored with the rules in force when it is approved.')
ON CONFLICT (config_key) DO NOTHING;
