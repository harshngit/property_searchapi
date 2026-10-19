-- Contract sec. 33.12 - Employee-as-User conflict-of-interest safeguards.
--   Employees        active staff accounts (internal sales, admin, super admin)
--                    and A R representatives.
--   Linked accounts  a user whose mobile or PAN matches an employee's own
--                    mobile / PAN or a disclosed immediate-family member's
--                    (spouse, parent, child) is employee_linked_account.
--   Related party    a listing, inquiry or deal in which a linked account (or
--                    a customer record with a linked mobile) is a party - the
--                    buyer, the seller / lister or the broker on the other side -
--                    is tagged related_party_transaction the moment the parties
--                    are on the record. Staff accounts acting for a client are
--                    the platform's operators, not parties.
--   Every detection is logged append-only for the Compliance Dashboard. The
--   tags are written by triggers here, so no role can switch them off.

-- ---------------------------------------------------------------- disclosures

CREATE TABLE IF NOT EXISTS employee_disclosures (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    relation     VARCHAR(10) NOT NULL CHECK (relation IN ('self', 'spouse', 'parent', 'child')),
    full_name    VARCHAR(150),
    mobile10     VARCHAR(10) CHECK (mobile10 IS NULL OR mobile10 ~ '^[0-9]{10}$'),
    pan_hash     CHAR(64),
    pan_last4    VARCHAR(4),
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at   TIMESTAMPTZ,
    removed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    removal_note VARCHAR(300),
    CHECK (mobile10 IS NOT NULL OR pan_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_employee_disclosures_mobile ON employee_disclosures (mobile10) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employee_disclosures_pan ON employee_disclosures (pan_hash) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employee_disclosures_employee ON employee_disclosures (employee_id);

-- ---------------------------------------------------------------- flags

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_linked_account BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS employee_link_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS related_party_transaction BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS related_party_employee_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS related_party_transaction BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS related_party_employee_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS related_party_transaction BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS related_party_employee_ids UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_properties_related_party ON properties (id) WHERE related_party_transaction;
CREATE INDEX IF NOT EXISTS idx_leads_related_party ON leads (id) WHERE related_party_transaction;
CREATE INDEX IF NOT EXISTS idx_deals_related_party ON deals (id) WHERE related_party_transaction;
CREATE INDEX IF NOT EXISTS idx_users_employee_linked ON users (id) WHERE employee_linked_account;

-- ---------------------------------------------------------------- the immutable log

CREATE TABLE IF NOT EXISTS related_party_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type   VARCHAR(10) NOT NULL CHECK (entity_type IN ('property', 'lead', 'deal')),
    entity_id     UUID NOT NULL,
    employee_ids  UUID[] NOT NULL,
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_related_party_log_entity ON related_party_log (entity_type, entity_id, detected_at DESC);

-- City Head / Super Admin review of a flagged transaction - also append-only.
CREATE TABLE IF NOT EXISTS related_party_reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type  VARCHAR(10) NOT NULL CHECK (entity_type IN ('property', 'lead', 'deal')),
    entity_id    UUID NOT NULL,
    outcome      VARCHAR(20) NOT NULL CHECK (outcome IN ('disclosed_ok', 'undisclosed', 'not_related', 'noted')),
    note         TEXT NOT NULL,
    reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_related_party_reviews_entity ON related_party_reviews (entity_type, entity_id, reviewed_at DESC);

CREATE OR REPLACE FUNCTION rp_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'related-party records are append-only';
END $$;
DROP TRIGGER IF EXISTS trg_related_party_log_append_only ON related_party_log;
CREATE TRIGGER trg_related_party_log_append_only BEFORE UPDATE OR DELETE ON related_party_log FOR EACH ROW EXECUTE FUNCTION rp_append_only();
DROP TRIGGER IF EXISTS trg_related_party_reviews_append_only ON related_party_reviews;
CREATE TRIGGER trg_related_party_reviews_append_only BEFORE UPDATE OR DELETE ON related_party_reviews FOR EACH ROW EXECUTE FUNCTION rp_append_only();

-- ---------------------------------------------------------------- matching

CREATE OR REPLACE FUNCTION rp_mobile10(m TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(right(regexp_replace(COALESCE(m, ''), '\D', '', 'g'), 10), '')
$$;

-- Active employees.
CREATE OR REPLACE VIEW rp_employees AS
  SELECT u.id AS employee_id, u.mobile
  FROM users u JOIN roles r ON r.id = u.role_id
  WHERE u.status = 'active' AND (r.name IN ('internal_sales', 'admin', 'super_admin') OR EXISTS (SELECT 1 FROM arb_representatives a WHERE a.user_id = u.id));

CREATE INDEX IF NOT EXISTS idx_users_mobile10 ON users (rp_mobile10(mobile));
CREATE INDEX IF NOT EXISTS idx_customers_mobile10 ON customers (rp_mobile10(mobile));

CREATE OR REPLACE FUNCTION rp_is_employee(p_user UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.id = p_user AND u.status = 'active' AND (r.name IN ('internal_sales', 'admin', 'super_admin') OR EXISTS (SELECT 1 FROM arb_representatives a WHERE a.user_id = u.id))
  )
$$;

-- Employees a mobile number belongs to (their own, or a disclosed family member's).
CREATE OR REPLACE FUNCTION rp_mobile_links(p_mobile10 TEXT) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') FROM (
    SELECT u.id AS x FROM users u WHERE p_mobile10 IS NOT NULL AND rp_mobile10(u.mobile) = p_mobile10 AND rp_is_employee(u.id)
    UNION
    SELECT d.employee_id FROM employee_disclosures d WHERE p_mobile10 IS NOT NULL AND d.mobile10 = p_mobile10 AND d.removed_at IS NULL AND rp_is_employee(d.employee_id)
  ) k
$$;

CREATE OR REPLACE FUNCTION rp_pan_links(p_pan_hash TEXT) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT d.employee_id ORDER BY d.employee_id), '{}')
  FROM employee_disclosures d WHERE p_pan_hash IS NOT NULL AND d.pan_hash = p_pan_hash AND d.removed_at IS NULL AND rp_is_employee(d.employee_id)
$$;

-- Employees a (non-staff) account is linked to, by its mobile or its PAN on file.
-- Staff accounts are the platform's operators, so they are never "linked".
CREATE OR REPLACE FUNCTION rp_user_links(p_user UUID, p_mobile TEXT DEFAULT NULL) RETURNS UUID[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  m TEXT;
  ids UUID[];
BEGIN
  IF p_user IS NULL OR rp_is_employee(p_user) THEN RETURN '{}'; END IF;
  m := rp_mobile10(COALESCE(p_mobile, (SELECT mobile FROM users WHERE id = p_user)));
  ids := rp_mobile_links(m) || rp_pan_links((SELECT pan_hash FROM payee_tax_profiles WHERE user_id = p_user));
  RETURN (SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(ids) x WHERE x <> p_user);
END $$;

-- A customer record: its account's links, or its mobile when it has no account.
CREATE OR REPLACE FUNCTION rp_customer_links(p_customer UUID) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT CASE WHEN c.user_id IS NOT NULL THEN rp_user_links(c.user_id) ELSE rp_mobile_links(rp_mobile10(c.mobile)) END FROM customers c WHERE c.id = p_customer), '{}')
$$;

CREATE OR REPLACE FUNCTION rp_merge(a UUID[], b UUID[]) RETURNS UUID[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(COALESCE(a, '{}') || COALESCE(b, '{}')) x WHERE x IS NOT NULL
$$;

-- The parties of each record (staff accounts acting for a client are not parties).
CREATE OR REPLACE FUNCTION rp_property_links(p_created_by UUID, p_broker UUID, p_builder UUID) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT rp_merge(rp_merge(rp_user_links(p_created_by), rp_user_links(p_broker)), rp_user_links(p_builder))
$$;

CREATE OR REPLACE FUNCTION rp_property_links_of(p_property UUID) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT rp_property_links(created_by, broker_id, builder_id) FROM properties WHERE id = p_property), '{}')
$$;

CREATE OR REPLACE FUNCTION rp_lead_links(p_customer UUID, p_property UUID, p_created_by UUID) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT rp_merge(rp_merge(rp_customer_links(p_customer), rp_property_links_of(p_property)), rp_user_links(p_created_by))
$$;

CREATE OR REPLACE FUNCTION rp_deal_links(p_customer UUID, p_property UUID, p_broker UUID) RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT rp_merge(rp_merge(rp_customer_links(p_customer), rp_property_links_of(p_property)), rp_user_links(p_broker))
$$;

-- ---------------------------------------------------------------- triggers

CREATE OR REPLACE FUNCTION rp_tag_property() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.related_party_employee_ids := rp_property_links(NEW.created_by, NEW.broker_id, NEW.builder_id);
  NEW.related_party_transaction := cardinality(NEW.related_party_employee_ids) > 0;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION rp_tag_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.related_party_employee_ids := rp_lead_links(NEW.customer_id, NEW.property_id, NEW.created_by);
  NEW.related_party_transaction := cardinality(NEW.related_party_employee_ids) > 0;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION rp_tag_deal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.related_party_employee_ids := rp_deal_links(NEW.customer_id, NEW.property_id, NEW.broker_id);
  NEW.related_party_transaction := cardinality(NEW.related_party_employee_ids) > 0;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_rp_tag_property ON properties;
CREATE TRIGGER trg_rp_tag_property BEFORE INSERT OR UPDATE OF created_by, broker_id, builder_id ON properties FOR EACH ROW EXECUTE FUNCTION rp_tag_property();
DROP TRIGGER IF EXISTS trg_rp_tag_lead ON leads;
CREATE TRIGGER trg_rp_tag_lead BEFORE INSERT OR UPDATE OF customer_id, property_id, created_by ON leads FOR EACH ROW EXECUTE FUNCTION rp_tag_lead();
DROP TRIGGER IF EXISTS trg_rp_tag_deal ON deals;
CREATE TRIGGER trg_rp_tag_deal BEFORE INSERT OR UPDATE OF customer_id, property_id, broker_id ON deals FOR EACH ROW EXECUTE FUNCTION rp_tag_deal();

-- Log each new detection (a new record, or a new employee on an existing one).
CREATE OR REPLACE FUNCTION rp_log_detection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind TEXT := CASE TG_TABLE_NAME WHEN 'properties' THEN 'property' WHEN 'leads' THEN 'lead' ELSE 'deal' END;
BEGIN
  IF NEW.related_party_transaction AND (TG_OP = 'INSERT' OR NOT (NEW.related_party_employee_ids <@ OLD.related_party_employee_ids)) THEN
    INSERT INTO related_party_log (entity_type, entity_id, employee_ids) VALUES (kind, NEW.id, NEW.related_party_employee_ids);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_rp_log_property ON properties;
CREATE TRIGGER trg_rp_log_property AFTER INSERT OR UPDATE OF related_party_employee_ids ON properties FOR EACH ROW EXECUTE FUNCTION rp_log_detection();
DROP TRIGGER IF EXISTS trg_rp_log_lead ON leads;
CREATE TRIGGER trg_rp_log_lead AFTER INSERT OR UPDATE OF related_party_employee_ids ON leads FOR EACH ROW EXECUTE FUNCTION rp_log_detection();
DROP TRIGGER IF EXISTS trg_rp_log_deal ON deals;
CREATE TRIGGER trg_rp_log_deal AFTER INSERT OR UPDATE OF related_party_employee_ids ON deals FOR EACH ROW EXECUTE FUNCTION rp_log_detection();

-- Registration: a new account (or a changed mobile) is linked at once.
CREATE OR REPLACE FUNCTION rp_tag_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.employee_link_ids := rp_user_links(NEW.id, NEW.mobile);
  NEW.employee_linked_account := cardinality(NEW.employee_link_ids) > 0;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rp_tag_user ON users;
CREATE TRIGGER trg_rp_tag_user BEFORE INSERT OR UPDATE OF mobile ON users FOR EACH ROW EXECUTE FUNCTION rp_tag_user();

-- Re-check everything an identity change can affect (a disclosure added or
-- withdrawn, a PAN recorded, someone joining or leaving the staff), set-based.
-- Only the rows whose result changes are written (and logged).
CREATE OR REPLACE FUNCTION rp_rescan() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER := 0;
  c INTEGER;
BEGIN
  CREATE TEMP TABLE _rp_emp ON COMMIT DROP AS
    SELECT u.id, rp_mobile10(u.mobile) AS m FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.status = 'active' AND (r.name IN ('internal_sales', 'admin', 'super_admin') OR EXISTS (SELECT 1 FROM arb_representatives a WHERE a.user_id = u.id));
  CREATE TEMP TABLE _rp_keys ON COMMIT DROP AS
    SELECT id AS employee_id, 'mobile'::text AS key_type, m AS key FROM _rp_emp WHERE m IS NOT NULL
    UNION SELECT d.employee_id, 'mobile', d.mobile10 FROM employee_disclosures d JOIN _rp_emp e ON e.id = d.employee_id WHERE d.removed_at IS NULL AND d.mobile10 IS NOT NULL
    UNION SELECT d.employee_id, 'pan', d.pan_hash FROM employee_disclosures d JOIN _rp_emp e ON e.id = d.employee_id WHERE d.removed_at IS NULL AND d.pan_hash IS NOT NULL;
  -- Linked non-staff accounts.
  CREATE TEMP TABLE _rp_users ON COMMIT DROP AS
    SELECT x.id, array_agg(DISTINCT x.employee_id ORDER BY x.employee_id) AS ids FROM (
      SELECT u.id, k.employee_id FROM users u JOIN _rp_keys k ON k.key_type = 'mobile' AND k.key = rp_mobile10(u.mobile)
      UNION SELECT t.user_id, k.employee_id FROM payee_tax_profiles t JOIN _rp_keys k ON k.key_type = 'pan' AND k.key = t.pan_hash
    ) x WHERE x.id <> x.employee_id AND NOT EXISTS (SELECT 1 FROM _rp_emp e WHERE e.id = x.id) GROUP BY x.id;
  CREATE INDEX ON _rp_users (id);
  -- Customer records without an account, by mobile.
  CREATE TEMP TABLE _rp_customers ON COMMIT DROP AS
    SELECT c.id, COALESCE(uu.ids, mk.ids) AS ids FROM customers c
    LEFT JOIN _rp_users uu ON uu.id = c.user_id
    LEFT JOIN LATERAL (SELECT array_agg(DISTINCT k.employee_id ORDER BY k.employee_id) AS ids FROM _rp_keys k WHERE c.user_id IS NULL AND k.key_type = 'mobile' AND k.key = rp_mobile10(c.mobile)) mk ON true
    WHERE uu.ids IS NOT NULL OR mk.ids IS NOT NULL;
  CREATE INDEX ON _rp_customers (id);

  UPDATE users u SET employee_link_ids = COALESCE(x.ids, '{}'), employee_linked_account = x.ids IS NOT NULL
  FROM users u2 LEFT JOIN _rp_users x ON x.id = u2.id
  WHERE u2.id = u.id AND u.employee_link_ids IS DISTINCT FROM COALESCE(x.ids, '{}');
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  CREATE TEMP TABLE _rp_props ON COMMIT DROP AS
    SELECT p.id, rp_merge(rp_merge(a.ids, b.ids), d.ids) AS ids FROM properties p
    LEFT JOIN _rp_users a ON a.id = p.created_by LEFT JOIN _rp_users b ON b.id = p.broker_id LEFT JOIN _rp_users d ON d.id = p.builder_id;
  CREATE INDEX ON _rp_props (id);
  UPDATE properties p SET related_party_employee_ids = x.ids, related_party_transaction = cardinality(x.ids) > 0
  FROM _rp_props x WHERE x.id = p.id AND p.related_party_employee_ids IS DISTINCT FROM x.ids;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  UPDATE leads l SET related_party_employee_ids = x.ids, related_party_transaction = cardinality(x.ids) > 0
  FROM (SELECT l2.id, rp_merge(rp_merge(cu.ids, pp.ids), cb.ids) AS ids FROM leads l2
        LEFT JOIN _rp_customers cu ON cu.id = l2.customer_id LEFT JOIN _rp_props pp ON pp.id = l2.property_id LEFT JOIN _rp_users cb ON cb.id = l2.created_by) x
  WHERE x.id = l.id AND l.related_party_employee_ids IS DISTINCT FROM x.ids;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;

  UPDATE deals d SET related_party_employee_ids = x.ids, related_party_transaction = cardinality(x.ids) > 0
  FROM (SELECT d2.id, rp_merge(rp_merge(cu.ids, pp.ids), br.ids) AS ids FROM deals d2
        LEFT JOIN _rp_customers cu ON cu.id = d2.customer_id LEFT JOIN _rp_props pp ON pp.id = d2.property_id LEFT JOIN _rp_users br ON br.id = d2.broker_id) x
  WHERE x.id = d.id AND d.related_party_employee_ids IS DISTINCT FROM x.ids;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DROP TABLE _rp_emp, _rp_keys, _rp_users, _rp_customers, _rp_props;
  RETURN n;
END $$;

-- A PAN recorded on a tax profile can link the account.
CREATE OR REPLACE FUNCTION rp_tag_tax_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users SET employee_link_ids = rp_user_links(id, mobile), employee_linked_account = cardinality(rp_user_links(id, mobile)) > 0 WHERE id = NEW.user_id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_rp_tag_tax_profile ON payee_tax_profiles;
CREATE TRIGGER trg_rp_tag_tax_profile AFTER INSERT OR UPDATE OF pan_hash ON payee_tax_profiles FOR EACH ROW EXECUTE FUNCTION rp_tag_tax_profile();

-- The Compliance Dashboard is for the Super Admin and City Heads.
INSERT INTO app_config (config_key, value, category, description)
VALUES ('compliance.related_party_reviewers', '["super_admin", "admin"]'::jsonb, 'compliance', 'Roles that see and review related-party transactions on the Compliance Dashboard (sec. 33.12: City Head / Super Admin).')
ON CONFLICT (config_key) DO NOTHING;

-- No self-assignment: an employee is never the representative on a
-- transaction they (or their family) are a party to - whoever makes the
-- change. ("trg_rp_zguard" sorts after the tagging trigger, so it sees the
-- record's current parties.)
CREATE OR REPLACE FUNCTION rp_refuse_self_assignment() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'related_party_self_assignment' USING ERRCODE = 'P0403', DETAIL = 'An employee cannot be assigned a transaction they or their disclosed family are a party to (sec. 33.12).';
END $$;

-- A newly set representative (or CRM assignee) who is linked to a party is refused.
CREATE OR REPLACE FUNCTION rp_guard_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.arb_rep_id = ANY(NEW.related_party_employee_ids) AND (TG_OP = 'INSERT' OR NEW.arb_rep_id IS DISTINCT FROM OLD.arb_rep_id))
     OR (NEW.assigned_to = ANY(NEW.related_party_employee_ids) AND (TG_OP = 'INSERT' OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to)) THEN
    PERFORM rp_refuse_self_assignment();
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION rp_guard_deal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_rep_id = ANY(NEW.related_party_employee_ids) AND (TG_OP = 'INSERT' OR NEW.assigned_rep_id IS DISTINCT FROM OLD.assigned_rep_id) THEN
    PERFORM rp_refuse_self_assignment();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rp_zguard_lead ON leads;
CREATE TRIGGER trg_rp_zguard_lead BEFORE INSERT OR UPDATE OF arb_rep_id, assigned_to, customer_id, property_id, created_by ON leads FOR EACH ROW EXECUTE FUNCTION rp_guard_lead();
DROP TRIGGER IF EXISTS trg_rp_zguard_deal ON deals;
CREATE TRIGGER trg_rp_zguard_deal BEFORE INSERT OR UPDATE OF assigned_rep_id, customer_id, property_id, broker_id ON deals FOR EACH ROW EXECUTE FUNCTION rp_guard_deal();

-- The cascade records when it skipped a linked employee or had to hand the
-- inquiry to a Team Leader / admin for manual assignment.
ALTER TABLE lead_assignment_events DROP CONSTRAINT IF EXISTS lead_assignment_events_kind_check;
ALTER TABLE lead_assignment_events ADD CONSTRAINT lead_assignment_events_kind_check
  CHECK (kind IN ('assigned', 'missed', 'transferred', 'manual_reassign', 'exit_reinjected', 'contacted', 'mapping_gap', 'sla_breached', 'rp_rerouted', 'rp_escalated'));

-- Tag what is already on the platform (employees' own mobiles match from day one).
SELECT rp_rescan();
