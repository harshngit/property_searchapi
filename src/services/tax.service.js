const crypto = require('crypto');
const pool = require('../config/db');
const auditService = require('./audit.service');
const { badRequest, forbidden } = require('../utils/httpError');

// Statutory TDS, applied as the law prescribes and unified across payout
// channels (Section 14.6 commission settlements + Module 47 WFH payouts).
//   Parameters  rate, annual threshold and the no-PAN rate are versions in
//               statutory_parameters: added only by the Super Admin, with the
//               legal basis and an effective date from today onwards, never
//               edited. A payout uses the version in force on its date.
//   Ledger      every taxable payout is a row in tds_ledger keyed by the
//               payee's PAN, so the annual threshold is checked against the
//               person's real total across every channel.
// TDS is worked out on the amount before GST.

const KEYS = {
  tds_commission_percent: 'TDS rate (Section 194H), %',
  tds_annual_threshold: 'Annual threshold per PAN, Rs',
  tds_no_pan_percent: 'TDS rate without a PAN (Section 206AA), %',
};
const r2 = (v) => Math.round(Number(v) * 100) / 100;
// Same hash as the field-partner records, so a PAN matches across channels.
const panHash = (pan) => (pan ? crypto.createHash('sha256').update(`${process.env.JWT_ACCESS_SECRET || 'wfh'}|${String(pan).trim().toUpperCase()}`).digest('hex') : null);
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const fyOf = (date = new Date()) => {
  const d = new Date(date);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};

// The parameter values in force on a date.
async function params(on = new Date(), client = pool) {
  const day = new Date(on).toISOString().slice(0, 10);
  const rows = (await client.query(
    `SELECT DISTINCT ON (param_key) param_key, value::float AS value, effective_from FROM statutory_parameters WHERE effective_from <= $1::date ORDER BY param_key, effective_from DESC`,
    [day]
  )).rows;
  const get = (k, d) => Number(rows.find((r) => r.param_key === k)?.value ?? d);
  return { rate: get('tds_commission_percent', 5), threshold: get('tds_annual_threshold', 15000), noPanRate: get('tds_no_pan_percent', 20) };
}

async function listParams() {
  const rows = (await pool.query(`SELECT p.*, u.full_name AS set_by_name FROM statutory_parameters p LEFT JOIN users u ON u.id = p.set_by ORDER BY param_key, effective_from DESC`)).rows;
  const today = await params();
  return {
    inForce: today,
    versions: rows.map((r) => ({ id: r.id, key: r.param_key, label: KEYS[r.param_key] || r.param_key, value: Number(r.value), effectiveFrom: r.effective_from, legalBasis: r.legal_basis, setBy: r.set_by_name, createdAt: r.created_at })),
    keys: Object.entries(KEYS).map(([key, label]) => ({ key, label })),
  };
}

// A change in law: a new version from its effective date. Super Admin only.
async function setParam(admin, { key, value, effectiveFrom, legalBasis }, meta = {}) {
  if (admin.role !== 'super_admin') throw forbidden('Statutory parameters are changed only by the Super Admin');
  if (!KEYS[key]) throw badRequest(`Parameter must be one of: ${Object.keys(KEYS).join(', ')}`);
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0 || (key !== 'tds_annual_threshold' && v > 100)) throw badRequest('Give a valid value');
  const from = String(effectiveFrom || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw badRequest('Give the effective date');
  if (from < new Date().toISOString().slice(0, 10)) throw badRequest('A change takes effect from today or a later date - never backdated');
  if (!legalBasis || String(legalBasis).trim().length < 10) throw badRequest('Record the legal basis (e.g. Finance Act 2026, s. 194H as amended; CBDT notification no.)');
  const r = (await pool.query(
    `INSERT INTO statutory_parameters (param_key, value, effective_from, legal_basis, set_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (param_key, effective_from) DO NOTHING RETURNING *`,
    [key, v, from, String(legalBasis).trim().slice(0, 1000), admin.id]
  )).rows[0];
  if (!r) throw badRequest('A version of this parameter already starts on that date');
  await auditService.log({ actor: admin, action: 'tax.statutory_parameter_set', entityType: 'statutory_parameter', entityId: r.id, after: { key, value: v, effectiveFrom: from, legalBasis }, ...meta });
  return listParams();
}

// This year's taxable payouts so far to a PAN (or, without one, to the person).
async function yearTotal({ panHash: ph, userId, fy }, client = pool) {
  const r = await client.query(
    `SELECT COALESCE(SUM(gross_amount), 0)::float AS total FROM tds_ledger WHERE fy = $1 AND (($2::char(64) IS NOT NULL AND pan_hash = $2) OR ($2 IS NULL AND user_id = $3))`,
    [fy, ph || null, userId || null]
  );
  return r.rows[0].total;
}

// TDS on one payout. Once the year's total crosses the threshold, this payout
// is taxed in full; without a PAN the higher rate applies.
async function compute({ panHash: ph, userId, gross, on = new Date() }, client = pool) {
  const p = await params(on, client);
  const fy = fyOf(on);
  const before = await yearTotal({ panHash: ph, userId, fy }, client);
  const crosses = before + Number(gross) > p.threshold;
  const rate = crosses ? (ph ? p.rate : p.noPanRate) : 0;
  return { fy, rate, tds: r2((Number(gross) * rate) / 100), yearBefore: before, threshold: p.threshold };
}

async function record({ panHash: ph, panLast4, userId, payeeName, source, sourceRef, fy, gross, rate, tds, section = '194H' }, client = pool) {
  await client.query(
    `INSERT INTO tds_ledger (pan_hash, pan_last4, user_id, payee_name, source, source_ref, fy, gross_amount, tds_rate, tds_amount, section) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (source, source_ref, user_id) DO NOTHING`,
    [ph || null, panLast4 || null, userId || null, payeeName ? String(payeeName).slice(0, 200) : null, source, sourceRef, fy, r2(gross), rate, r2(tds), section]
  );
}

// Staff: the ledger by PAN for a year - the basis for the quarterly TDS return.
async function ledger({ fy = fyOf(), q } = {}) {
  const params_ = [fy];
  let where = 'WHERE t.fy = $1';
  if (q) {
    params_.push(`%${String(q).trim()}%`);
    where += ` AND (t.payee_name ILIKE $2 OR t.pan_last4 ILIKE $2)`;
  }
  const rows = (await pool.query(
    `SELECT COALESCE(t.pan_hash, 'user:' || t.user_id::text) AS payee_key, MAX(t.pan_last4) AS pan_last4, MAX(t.payee_name) AS payee_name, BOOL_OR(t.pan_hash IS NULL) AS no_pan,
            SUM(t.gross_amount)::float AS gross, SUM(t.tds_amount)::float AS tds, COUNT(*)::int AS payouts,
            COUNT(*) FILTER (WHERE t.source = 'commission')::int AS commission_payouts, COUNT(*) FILTER (WHERE t.source = 'wfh')::int AS wfh_payouts
     FROM tds_ledger t ${where} GROUP BY 1 ORDER BY gross DESC LIMIT 1000`,
    params_
  )).rows;
  return {
    fy,
    params: await params(),
    payees: rows.map((r) => ({ panLast4: r.pan_last4, payeeName: r.payee_name, noPan: r.no_pan, gross: r.gross, tds: r.tds, payouts: r.payouts, commissionPayouts: r.commission_payouts, wfhPayouts: r.wfh_payouts })),
    totals: { gross: r2(rows.reduce((s, r) => s + r.gross, 0)), tds: r2(rows.reduce((s, r) => s + r.tds, 0)) },
  };
}

module.exports = { KEYS, PAN_RE, GSTIN_RE, panHash, fyOf, params, listParams, setParam, yearTotal, compute, record, ledger };
