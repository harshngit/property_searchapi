-- Franchise extras (Section 14) and statutory TDS (Unified per-PAN ledger).
--   1. Statutory parameters: TDS rate / threshold versions with the legal basis
--      and effective date, changed only by the Super Admin, never edited in place.
--   2. Payee tax profiles (PAN / GSTIN) for commission recipients, a unified
--      per-PAN TDS ledger across commission and WFH payouts, and payout lines
--      per commission share (gross, GST, TDS, net).
--   3. GST invoices raised by the franchisee / broker to A R Buildwel for their
--      share, uploaded and reviewed before the share is paid.
--   4. Branded email sender details and domain / SSL status per franchisee.
--   5. Row-Level Security on franchise-scoped tables: a request running for a
--      franchisee (app.franchisee_id set) only ever sees that franchisee's rows.

-- 1 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS statutory_parameters (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    param_key      VARCHAR(60) NOT NULL,
    value          NUMERIC(14, 4) NOT NULL,
    effective_from DATE NOT NULL,
    legal_basis    TEXT NOT NULL,
    set_by         UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (param_key, effective_from)
);
CREATE OR REPLACE FUNCTION statutory_parameters_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Statutory parameters are never edited - add a new version with its effective date';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_statutory_parameters_append_only ON statutory_parameters;
CREATE TRIGGER trg_statutory_parameters_append_only BEFORE UPDATE OR DELETE ON statutory_parameters FOR EACH ROW EXECUTE FUNCTION statutory_parameters_append_only();

-- Seeded from the values already configured; the Super Admin records any change in law as a new version.
INSERT INTO statutory_parameters (param_key, value, effective_from, legal_basis)
SELECT k, v, DATE '2000-04-01', 'Initial value carried over from configuration (tax.payout_tds_*). Confirm against the current Finance Act.'
FROM (VALUES
  ('tds_commission_percent', COALESCE((SELECT (value #>> '{}')::numeric FROM app_config WHERE config_key = 'tax.payout_tds_percent'), 5)),
  ('tds_annual_threshold', COALESCE((SELECT (value #>> '{}')::numeric FROM app_config WHERE config_key = 'tax.payout_tds_threshold'), 15000)),
  ('tds_no_pan_percent', COALESCE((SELECT (value #>> '{}')::numeric FROM app_config WHERE config_key = 'tax.payout_tds_no_pan_percent'), 20))
) AS x(k, v)
ON CONFLICT (param_key, effective_from) DO NOTHING;

-- 2 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payee_tax_profiles (
    user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    legal_name     VARCHAR(200),
    pan_encrypted  TEXT,
    pan_hash       CHAR(64),
    pan_last4      CHAR(4),
    gstin          VARCHAR(15),
    pan_verified   BOOLEAN NOT NULL DEFAULT false,
    verified_by    UUID REFERENCES users(id),
    verified_at    TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payee_tax_profiles_pan ON payee_tax_profiles (pan_hash);

-- Every taxable payout A R Buildwel makes to a PAN, whatever the channel.
CREATE TABLE IF NOT EXISTS tds_ledger (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pan_hash      CHAR(64),
    pan_last4     CHAR(4),
    user_id       UUID REFERENCES users(id),
    payee_name    VARCHAR(200),
    source        VARCHAR(20) NOT NULL CHECK (source IN ('commission', 'wfh')),
    source_ref    UUID NOT NULL,
    fy            VARCHAR(7) NOT NULL,
    gross_amount  NUMERIC(14, 2) NOT NULL,
    tds_rate      NUMERIC(6, 3) NOT NULL,
    tds_amount    NUMERIC(14, 2) NOT NULL,
    section       VARCHAR(10) NOT NULL DEFAULT '194H',
    paid_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_ref, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tds_ledger_pan_fy ON tds_ledger (pan_hash, fy);
CREATE INDEX IF NOT EXISTS idx_tds_ledger_user_fy ON tds_ledger (user_id, fy);
CREATE OR REPLACE FUNCTION tds_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tds_ledger is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tds_ledger_append_only ON tds_ledger;
CREATE TRIGGER trg_tds_ledger_append_only BEFORE UPDATE OR DELETE ON tds_ledger FOR EACH ROW EXECUTE FUNCTION tds_ledger_append_only();

-- What each recipient of a commission was actually paid.
CREATE TABLE IF NOT EXISTS commission_payout_lines (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commission_id  UUID NOT NULL REFERENCES franchisee_commissions(id) ON DELETE CASCADE,
    user_id        UUID REFERENCES users(id),
    party          VARCHAR(20) NOT NULL,
    payee_name     VARCHAR(200),
    base_amount    NUMERIC(14, 2) NOT NULL,
    gst_amount     NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tds_rate       NUMERIC(6, 3) NOT NULL DEFAULT 0,
    tds_amount     NUMERIC(14, 2) NOT NULL DEFAULT 0,
    net_amount     NUMERIC(14, 2) NOT NULL,
    pan_last4      CHAR(4),
    invoice_id     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (commission_id, user_id)
);

-- 3 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commission_id   UUID NOT NULL REFERENCES franchisee_commissions(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id),
    party           VARCHAR(20) NOT NULL,
    invoice_number  VARCHAR(60) NOT NULL,
    invoice_date    DATE NOT NULL,
    supplier_gstin  VARCHAR(15) NOT NULL,
    taxable_amount  NUMERIC(14, 2) NOT NULL,
    gst_amount      NUMERIC(14, 2) NOT NULL,
    total_amount    NUMERIC(14, 2) NOT NULL,
    file_path       TEXT NOT NULL,
    file_name       VARCHAR(200),
    status          VARCHAR(12) NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
    review_note     TEXT,
    reviewed_by     UUID REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_invoices_commission ON commission_invoices (commission_id, user_id);
-- One live invoice per person per commission (a rejected one can be replaced).
CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_invoices_live ON commission_invoices (commission_id, user_id) WHERE status <> 'rejected';

-- 4 ------------------------------------------------------------------------
ALTER TABLE franchisee_branding
  ADD COLUMN IF NOT EXISTS email_from_address VARCHAR(150),
  ADD COLUMN IF NOT EXISTS email_reply_to     VARCHAR(150),
  ADD COLUMN IF NOT EXISTS domain_status      VARCHAR(16) NOT NULL DEFAULT 'none' CHECK (domain_status IN ('none', 'pending_dns', 'dns_ok', 'ssl_pending', 'live', 'error')),
  ADD COLUMN IF NOT EXISTS dns_detail         TEXT,
  ADD COLUMN IF NOT EXISTS dns_checked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ssl_issuer         VARCHAR(200),
  ADD COLUMN IF NOT EXISTS ssl_expires_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ssl_checked_at     TIMESTAMPTZ;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('franchise.domain_target', '"partners.propertyserch.com"', 'franchise', 'The host every franchisee domain must point to (CNAME), or an IP address for an A record'),
  ('franchise.require_gst_invoice', 'true', 'franchise', 'A GST-registered franchisee or broker must have an approved GST invoice for their share before it is paid'),
  ('franchise.ssl_warn_days', '14', 'franchise', 'Warn the admins when a franchisee domain certificate expires within this many days')
ON CONFLICT (config_key) DO NOTHING;

-- 5 ------------------------------------------------------------------------
-- Database-level isolation. Normal platform requests leave app.franchisee_id
-- unset and see every row, as before. Requests served for a franchisee set it
-- (SET LOCAL inside a transaction) and only ever see that franchisee's rows,
-- even if a query forgets its WHERE clause.
CREATE OR REPLACE FUNCTION franchise_scope_ok(row_franchisee UUID) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.franchisee_id', true), ''), '') = ''
      OR row_franchisee::text = current_setting('app.franchisee_id', true)
$$;

-- Leads also belong to a franchisee through its broker firm (tenant).
CREATE OR REPLACE FUNCTION franchise_lead_scope_ok(row_franchisee UUID, row_tenant UUID) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.franchisee_id', true), ''), '') = ''
      OR row_franchisee::text = current_setting('app.franchisee_id', true)
      OR row_tenant::text = NULLIF(current_setting('app.franchise_tenant_id', true), '')
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['franchisee_commissions', 'franchisee_payment_tracking', 'franchisee_tickets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS franchise_isolation ON %I', t);
    EXECUTE format('CREATE POLICY franchise_isolation ON %I USING (franchise_scope_ok(franchisee_id)) WITH CHECK (franchise_scope_ok(franchisee_id))', t);
  END LOOP;
END $$;

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS franchise_isolation ON leads;
CREATE POLICY franchise_isolation ON leads USING (franchise_lead_scope_ok(franchisee_id, tenant_id)) WITH CHECK (franchise_lead_scope_ok(franchisee_id, tenant_id));
