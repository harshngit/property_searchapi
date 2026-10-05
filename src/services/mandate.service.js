const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { encrypt, decrypt } = require('../utils/crypto');
const { maskPhone } = require('../utils/masking');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 46 - Exclusive Mandate (core, build before launch).
//   - Professional fee consent is OTP-verified and unbypassable: a listing or
//     requirement is accepted only with a fresh, unused consent token
//     (fee_consents), whatever the role or API path.
//   - Every posted listing / requirement gets a mandate record - Exclusive
//     (pending_rep_ack until an A R representative acknowledges it) or
//     Standard. The fee rate is locked at 1% by a database CHECK.
//   - The price range (seller min / max, buyer min / max budget) is
//     AES-256-GCM encrypted in mandates and never returned by any endpoint
//     except GET /mandates/:id/price-range, for the assigned representative
//     and the Super Admin only - every read is logged in mandate_events.
//   - Exclusive placement / Priority Buyer (+20 boost, badge, trust bonus)
//     apply only while the mandate is ACTIVE: properties / requirements
//     .mandate_type is set to 'exclusive' on activation and back to
//     'standard' on expiry, breach or cancellation.
//   - Renewal by the assigned RM/DM only once the deal is past Site Visit
//     Completed; after `mandate.renewal_cap` renewals a Super Admin must
//     approve. Daily sweep: 30 / 7 / 1-day expiry reminders, then expiry.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const PAST_SITE_VISIT = require('./dealStages').PAST_SITE_VISIT;
const BENEFIT_VALUES = {
  valuation_status: ['not_requested', 'requested', 'in_progress', 'completed', 'report_uploaded'],
  due_diligence_status: ['not_requested', 'in_progress', 'completed', 'report_uploaded'],
  deed_writer_waiver_status: ['not_applicable', 'active', 'utilised'],
};
// Public summary columns - never the *_enc price columns.
const SUMMARY_COLUMNS = `m.id, m.mandate_number, m.mandate_type, m.user_id, m.customer_id, m.listing_id, m.requirement_id,
  m.professional_fee_rate_percent, m.gst_type, m.assigned_rep_id, m.mandate_start_date, m.mandate_end_date, m.renewal_count,
  m.valuation_status, m.due_diligence_status, m.deed_writer_waiver_status, m.valuation_document_id, m.due_diligence_document_id,
  m.benefit_due_dates, m.status, m.status_reason, m.acknowledged_at, m.created_at, m.updated_at,
  (m.seller_min_price_enc IS NOT NULL OR m.buyer_max_budget_enc IS NOT NULL) AS price_range_on_file`;

const isExclusive = (type) => type === 'seller_exclusive' || type === 'buyer_exclusive';
const isSeller = (type) => type === 'seller_exclusive' || type === 'seller_standard';
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function cfg() {
  const [sellerDays, buyerDays, cap, warnDays, sla, benefitSla, version, tokenMinutes, text] = await Promise.all([
    configService.getConfig('mandate.seller_days', 180),
    configService.getConfig('mandate.buyer_days', 90),
    configService.getConfig('mandate.renewal_cap', 2),
    configService.getConfig('mandate.expiry_warning_days', [30, 7, 1]),
    configService.getConfig('mandate.response_sla_hours', { exclusive: 2, standard: 24 }),
    configService.getConfig('mandate.benefit_sla', { rep_initiate_hours: 24, valuation_working_days: 10, due_diligence_working_days: 15 }),
    configService.getConfig('mandate.consent_version', '2026-07'),
    configService.getConfig('mandate.consent_token_minutes', 30),
    configService.getConfig('mandate.fee_consent_text', ''),
  ]);
  return {
    sellerDays: Number(sellerDays) || 180,
    buyerDays: Number(buyerDays) || 90,
    cap: Number(cap) || 2,
    warnDays: (Array.isArray(warnDays) ? warnDays : [30, 7, 1]).map(Number).sort((a, b) => b - a),
    sla: { exclusive: 2, standard: 24, ...(sla || {}) },
    benefitSla: benefitSla || {},
    version: String(version),
    tokenMinutes: Number(tokenMinutes) || 30,
    text,
  };
}

async function logEvent(mandateId, kind, { actor = null, stage = null, detail = {}, ip = null } = {}, client = pool) {
  await client.query(
    `INSERT INTO mandate_events (mandate_id, kind, actor_id, pipeline_stage, detail, ip_address) VALUES ($1, $2, $3, $4, $5, $6)`,
    [mandateId, kind, actor?.id || null, stage, JSON.stringify(detail), ip]
  );
}

async function staffIds(roles = STAFF) {
  return (
    await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ANY($1) AND u.status = 'active'`, [roles])
  ).rows.map((r) => r.id);
}

async function notify(userIds, { type, title, message, id }) {
  for (const userId of new Set(userIds.filter(Boolean))) {
    await notificationService
      .createNotification({ userId, type, title, message, relatedEntityType: 'mandate', relatedEntityId: id })
      .catch(() => {});
  }
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- consent

// Text, fee table and benefit lists shown above the consent checkbox.
async function consentTerms() {
  const c = await cfg();
  return {
    version: c.version,
    text: c.text,
    feeRatePercent: 1,
    feeTable: [
      { deal: 'Sale / purchase', fee: '1% of the transaction value + GST / IGST', schedule: '50% + tax at Agreement to Sell execution; 50% + tax at Sale Deed execution' },
      { deal: 'Rent / lease', fee: "One month's gross rent + GST / IGST", schedule: 'At Lease Deed / Leave and Licence execution' },
    ],
    mandatePeriodDays: { seller: c.sellerDays, buyer: c.buyerDays },
    responseSlaHours: c.sla,
    sellerBenefits: [
      'Priority / Featured listing placement, re-ranked to the top every 7 days',
      'Free property valuation by an empanelled registered valuer',
      'Property legal due diligence - free of cost',
      'Dedicated A R representative for the full mandate period',
      'Waiver of deed writer / document writer charges',
      `Priority ${c.sla.exclusive}-hour inquiry response SLA`,
      'Exclusive Mandate badge',
    ],
    buyerBenefits: [
      `Priority ${c.sla.exclusive}-hour response SLA; shortlist within 24 hours`,
      'Negotiation representation without revealing your maximum budget',
      'Legal due diligence on one property - free',
      'Waiver of deed writer charges',
      'Access to off-market, Special Situation and bank auction properties',
      'Priority Buyer badge and matching priority',
      'Dedicated A R representative end-to-end',
    ],
    disclaimerTypes: ['mandate_deed_writer_waiver', 'mandate_due_diligence', 'mandate_valuation'],
  };
}

async function accountMobile(userId) {
  const u = (await pool.query('SELECT mobile FROM users WHERE id = $1', [userId])).rows[0];
  if (!u?.mobile) throw badRequest('Add a mobile number to your profile - the professional fee consent is confirmed by OTP');
  return u.mobile;
}

// Step 1a - OTP to the account's mobile.
async function sendConsentOtp(user) {
  const authService = require('./auth.service');
  const mobile = await accountMobile(user.id);
  const otp = await authService.createOtp(mobile, 'fee_consent', user.id);
  return { sentTo: maskPhone(mobile), ...(process.env.NODE_ENV !== 'production' ? { otp } : {}) };
}

// Step 1b - OTP verified: record the consent and hand back a one-time
// token the listing / requirement submit must carry.
async function verifyConsentOtp(user, { otp, kind }, meta = {}) {
  if (!['listing', 'requirement'].includes(kind)) throw badRequest('kind must be listing or requirement');
  const authService = require('./auth.service');
  const mobile = await accountMobile(user.id);
  await authService.verifyOtp(mobile, String(otp || ''), 'fee_consent');
  const c = await cfg();
  const token = crypto.randomBytes(24).toString('hex');
  const row = (
    await pool.query(
      `INSERT INTO fee_consents (user_id, kind, consent_version, mobile_last4, token_hash, token_expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval, $7, $8)
       RETURNING id, otp_verified_at, token_expires_at`,
      [user.id, kind, c.version, String(mobile).replace(/\D/g, '').slice(-4), hashToken(token), String(c.tokenMinutes), meta.ip || null, meta.userAgent || null]
    )
  ).rows[0];
  await auditService.log({ actor: user, action: 'professional_fee_consent_accepted', entityType: 'fee_consent', entityId: row.id, after: { kind, version: c.version }, ...meta });
  return { consentToken: token, consentId: row.id, verifiedAt: row.otp_verified_at, expiresAt: row.token_expires_at };
}

// Consumes a consent token inside the caller's transaction. Throws unless it
// belongs to this user, matches the kind, is unused and unexpired.
async function consumeConsent(client, user, token, kind) {
  if (!token) throw badRequest('Professional fee consent must be confirmed by OTP before submitting');
  const row = (
    await client.query('SELECT * FROM fee_consents WHERE token_hash = $1 FOR UPDATE', [hashToken(token)])
  ).rows[0];
  if (!row || row.user_id !== user.id || row.kind !== kind) throw badRequest('Professional fee consent is not valid for this submission - confirm it again');
  if (row.used_at) throw badRequest('This professional fee consent has already been used - confirm it again');
  if (new Date(row.token_expires_at) < new Date()) throw badRequest('Professional fee consent has expired - confirm it again');
  await client.query('UPDATE fee_consents SET used_at = now() WHERE id = $1', [row.id]);
  return row;
}

// Read-only pre-check (no consumption) so a listing is never created with a
// consent that would then be refused.
async function assertConsentUsable(user, token, kind) {
  if (!token) throw badRequest('Professional fee consent must be confirmed by OTP before submitting');
  const row = (await pool.query('SELECT user_id, kind, used_at, token_expires_at FROM fee_consents WHERE token_hash = $1', [hashToken(token)])).rows[0];
  if (!row || row.user_id !== user.id || row.kind !== kind) throw badRequest('Professional fee consent is not valid for this submission - confirm it again');
  if (row.used_at) throw badRequest('This professional fee consent has already been used - confirm it again');
  if (new Date(row.token_expires_at) < new Date()) throw badRequest('Professional fee consent has expired - confirm it again');
}

// ---------------------------------------------------------------- creation

function readAmount(value, label) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n) || n <= 0) {
    throw badRequest(`${label} is required for an Exclusive Mandate`);
  }
  return Math.round(n);
}

// Validates the price range for an Exclusive Mandate before any write.
function validatePriceRange(kind, mandateType, range = {}) {
  if (mandateType !== 'exclusive') return null;
  if (kind === 'listing') {
    const min = readAmount(range.minPrice, 'Minimum acceptable price');
    const max = readAmount(range.maxPrice, 'Maximum listed price');
    if (min > max) throw badRequest('Minimum acceptable price cannot be more than the maximum listed price');
    return { min, max };
  }
  const min = readAmount(range.minBudget, 'Minimum budget');
  const max = readAmount(range.maxBudget, 'Maximum budget');
  if (min > max) throw badRequest('Minimum budget cannot be more than the maximum budget');
  return { min, max };
}

async function gstTypeFor(userId) {
  const nri = (
    await pool.query(`SELECT 1 FROM investor_profiles WHERE user_id = $1 AND (is_nri OR residency_status IN ('nri', 'oci', 'pio'))`, [userId])
  ).rows.length > 0;
  return nri ? 'IGST' : 'GST';
}

// Inside the listing / requirement transaction: consume consent + create
// the mandate. `range` is the already-validated {min, max} or null.
async function createForPost(client, { user, customerId, kind, targetId, mandateType, consentToken, range }) {
  const consent = await consumeConsent(client, user, consentToken, kind);
  const type = `${kind === 'listing' ? 'seller' : 'buyer'}_${mandateType === 'exclusive' ? 'exclusive' : 'standard'}`;
  const prices =
    mandateType === 'exclusive'
      ? kind === 'listing'
        ? { seller_min_price_enc: encrypt(range.min), seller_max_price_enc: encrypt(range.max) }
        : { buyer_min_budget_enc: encrypt(range.min), buyer_max_budget_enc: encrypt(range.max) }
      : {};
  const number = (await client.query(`SELECT 'MND-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('mandate_number_seq')::text, 5, '0') AS n`)).rows[0].n;
  const row = (
    await client.query(
      `INSERT INTO mandates (mandate_number, mandate_type, user_id, customer_id, listing_id, requirement_id, fee_consent_id, gst_type,
         seller_min_price_enc, seller_max_price_enc, buyer_min_budget_enc, buyer_max_budget_enc, status, mandate_start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, mandate_number, mandate_type, status`,
      [
        number, type, user.id, customerId || null,
        kind === 'listing' ? targetId : null, kind === 'requirement' ? targetId : null,
        consent.id, await gstTypeFor(user.id),
        prices.seller_min_price_enc || null, prices.seller_max_price_enc || null,
        prices.buyer_min_budget_enc || null, prices.buyer_max_budget_enc || null,
        isExclusive(type) ? 'pending_rep_ack' : 'active',
        isExclusive(type) ? null : today(),
      ]
    )
  ).rows[0];
  await logEvent(row.id, 'created', { actor: user, detail: { mandate_type: type, consent_id: consent.id } }, client);
  return row;
}

// After commit: tell A R staff an Exclusive Mandate is waiting.
async function afterCreate(mandate, label) {
  if (!isExclusive(mandate.mandate_type)) return;
  await notify(await staffIds(), {
    type: 'mandate_pending_ack',
    title: `Exclusive Mandate awaiting acknowledgement (${mandate.mandate_number})`,
    message: `${isSeller(mandate.mandate_type) ? 'Seller' : 'Buyer'} mandate on ${label}. Acknowledge to activate benefits.`,
    id: mandate.id,
  });
}

// ---------------------------------------------------------------- reads

async function loadMandate(id, client = pool) {
  const m = (await client.query(`SELECT m.* FROM mandates m WHERE m.id = $1`, [id])).rows[0];
  if (!m) throw notFound('Mandate not found');
  return m;
}

function stripPrices(m) {
  const { seller_min_price_enc: a, seller_max_price_enc: b, buyer_min_budget_enc: c, buyer_max_budget_enc: d, ...rest } = m;
  return { ...rest, price_range_on_file: Boolean(a || b || c || d) };
}

function canSeePrices(m, user) {
  return user.role === 'super_admin' || (m.assigned_rep_id && m.assigned_rep_id === user.id);
}

async function enrich(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const extra = (
    await pool.query(
      `SELECT m.id,
              u.full_name AS client_name, rep.full_name AS assigned_rep_name,
              p.title AS listing_title, p.city AS listing_city, p.locality AS listing_locality,
              r.purpose AS requirement_purpose, r.city AS requirement_city
       FROM mandates m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN users rep ON rep.id = m.assigned_rep_id
       LEFT JOIN properties p ON p.id = m.listing_id
       LEFT JOIN requirements r ON r.id = m.requirement_id
       WHERE m.id = ANY($1::uuid[])`,
      [ids]
    )
  ).rows;
  const byId = new Map(extra.map((e) => [e.id, e]));
  return rows.map((r) => {
    const e = byId.get(r.id) || {};
    const label = e.listing_title
      ? `${e.listing_title}${e.listing_locality ? `, ${e.listing_locality}` : ''}`
      : e.requirement_city ? `${e.requirement_purpose === 'rent' ? 'Rental' : 'Purchase'} requirement in ${e.requirement_city}` : null;
    const daysLeft = r.mandate_end_date ? Math.ceil((new Date(r.mandate_end_date) - new Date(today())) / 86400000) : null;
    return { ...r, client_name: e.client_name || null, assigned_rep_name: e.assigned_rep_name || null, subject: label, days_left: daysLeft };
  });
}

// Staff list - Mandate Management screen.
async function list(query, user) {
  if (!STAFF.includes(user.role)) throw forbidden();
  const where = ['1=1'];
  const params = [];
  if (query.status) {
    params.push(query.status);
    where.push(`m.status = $${params.length}`);
  }
  if (query.type === 'exclusive') where.push(`m.mandate_type IN ('seller_exclusive', 'buyer_exclusive')`);
  if (query.type === 'standard') where.push(`m.mandate_type IN ('seller_standard', 'buyer_standard')`);
  if (query.party === 'seller') where.push(`m.mandate_type LIKE 'seller_%'`);
  if (query.party === 'buyer') where.push(`m.mandate_type LIKE 'buyer_%'`);
  if (query.expiringWithin) {
    params.push(Number(query.expiringWithin) || 30);
    where.push(`m.status = 'active' AND m.mandate_end_date IS NOT NULL AND m.mandate_end_date <= current_date + ($${params.length} || ' days')::interval`);
  }
  if (query.mine === 'true') {
    params.push(user.id);
    where.push(`m.assigned_rep_id = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    where.push(`(m.mandate_number ILIKE $${params.length} OR EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id AND u.full_name ILIKE $${params.length}))`);
  }
  params.push(Math.min(Number(query.limit) || 100, 300));
  const rows = (
    await pool.query(
      `SELECT ${SUMMARY_COLUMNS} FROM mandates m WHERE ${where.join(' AND ')}
       ORDER BY (m.status = 'pending_rep_ack') DESC, m.mandate_end_date ASC NULLS LAST, m.created_at DESC
       LIMIT $${params.length}`,
      params
    )
  ).rows;
  const summary = (
    await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending_rep_ack')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'active' AND mandate_type LIKE '%_exclusive')::int AS active_exclusive,
              COUNT(*) FILTER (WHERE status = 'active' AND mandate_end_date <= current_date + interval '30 days')::int AS expiring_30,
              COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
              COUNT(*) FILTER (WHERE status = 'breached')::int AS breached
       FROM mandates`
    )
  ).rows[0];
  return { summary, items: await enrich(rows) };
}

// Deals a mandate covers: the listing's deals (seller) or the buyer's deals.
async function linkedDeals(m) {
  const rows = isSeller(m.mandate_type)
    ? m.listing_id
      ? (await pool.query(`SELECT d.id, d.stage, d.deal_value, d.ats_execution_date, d.sale_deed_execution_date FROM deals d WHERE d.property_id = $1 ORDER BY d.created_at DESC`, [m.listing_id])).rows
      : []
    : m.customer_id
      ? (await pool.query(`SELECT d.id, d.stage, d.deal_value, d.ats_execution_date, d.sale_deed_execution_date FROM deals d WHERE d.customer_id = $1 ORDER BY d.created_at DESC`, [m.customer_id])).rows
      : [];
  for (const d of rows) {
    d.site_visit_completed = (await pool.query(`SELECT 1 FROM site_visits WHERE deal_id = $1 AND status = 'completed' LIMIT 1`, [d.id])).rows.length > 0;
    d.invoices = (
      await pool.query(
        `SELECT id, invoice_number, kind, total_amount, status, issue_date, due_date FROM invoices WHERE deal_id = $1 ORDER BY issue_date`,
        [d.id]
      )
    ).rows;
  }
  return rows;
}

async function get(id, user) {
  const m = await loadMandate(id);
  const staff = STAFF.includes(user.role);
  if (!staff && m.user_id !== user.id) throw notFound('Mandate not found');
  const [item] = await enrich([stripPrices(m)]);
  const out = { ...item, can_view_price_range: canSeePrices(m, user) };
  if (staff) {
    out.events = (
      await pool.query(
        `SELECT e.kind, e.pipeline_stage, e.detail, e.created_at, u.full_name AS actor_name
         FROM mandate_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.mandate_id = $1 ORDER BY e.created_at DESC`,
        [id]
      )
    ).rows;
    out.deals = await linkedDeals(m);
  }
  return out;
}

// The client's own mandates (website dashboard) - never the price range.
async function listMine(user) {
  const rows = (await pool.query(`SELECT ${SUMMARY_COLUMNS} FROM mandates m WHERE m.user_id = $1 ORDER BY m.created_at DESC`, [user.id])).rows;
  return enrich(rows);
}

// Decrypted price range - assigned representative and Super Admin only,
// every access logged immutably.
async function priceRange(id, user, meta = {}) {
  const m = await loadMandate(id);
  if (!canSeePrices(m, user)) throw forbidden('The price range is visible only to the assigned A R representative and the Super Admin');
  await logEvent(id, 'price_range_viewed', { actor: user, ip: meta.ip });
  const dec = (v) => (v ? Number(decrypt(v)) : null);
  return isSeller(m.mandate_type)
    ? { party: 'seller', minAcceptablePrice: dec(m.seller_min_price_enc), maxListedPrice: dec(m.seller_max_price_enc) }
    : { party: 'buyer', minBudget: dec(m.buyer_min_budget_enc), maxBudget: dec(m.buyer_max_budget_enc) };
}

// Mandate Status Panel at the top of Deal Detail (Screen 8).
async function forDeal(dealId, user) {
  const deal = (await pool.query(`SELECT id, property_id, customer_id, deal_value, broker_id FROM deals WHERE id = $1`, [dealId])).rows[0];
  if (!deal) throw notFound('Deal not found');
  const rows = (
    await pool.query(
      `SELECT m.* FROM mandates m
       WHERE m.status <> 'cancelled' AND ((m.listing_id = $1 AND m.mandate_type LIKE 'seller_%')
          OR (m.customer_id = $2 AND m.mandate_type LIKE 'buyer_%'))
       ORDER BY m.created_at DESC`,
      [deal.property_id, deal.customer_id]
    )
  ).rows;
  const visible = rows.filter((m) => ADMIN.includes(user.role) || m.assigned_rep_id === user.id);
  if (!visible.length) return { dealId, mandates: [], visible: rows.length === 0 };
  const invoices = (
    await pool.query(`SELECT id, invoice_number, kind, party, fee_amount, total_amount, gst_type, status, due_date FROM invoices WHERE deal_id = $1`, [dealId])
  ).rows;
  const value = Number(deal.deal_value) || null;
  const out = [];
  for (const m of visible) {
    const seller = isSeller(m.mandate_type);
    const showPrices = canSeePrices(m, user);
    const dec = (v) => (showPrices && v ? Number(decrypt(v)) : null);
    if (showPrices && (m.seller_min_price_enc || m.buyer_min_budget_enc)) await logEvent(m.id, 'price_range_viewed', { actor: user, detail: { via: 'deal_panel', deal_id: dealId } });
    const fee = value ? Math.round(value * 0.01 * 100) / 100 : null;
    const party = seller ? 'seller' : 'buyer';
    const inst = (kind) => {
      const i = invoices.find((x) => x.kind === kind && (x.party === party || !x.party));
      if (!i) return { status: 'not_triggered' };
      const overdue = i.status !== 'paid' && i.status !== 'waived' && new Date(i.due_date) < new Date();
      return {
        invoiceId: i.id, invoiceNumber: i.invoice_number, amount: Number(i.total_amount), status: overdue ? 'overdue' : i.status,
        dueDate: i.due_date, daysOverdue: overdue ? Math.floor((Date.now() - new Date(i.due_date)) / 86400000) : 0,
      };
    };
    out.push({
      id: m.id,
      mandateNumber: m.mandate_number,
      mandateType: isExclusive(m.mandate_type) ? 'Exclusive' : 'Standard',
      party,
      status: m.status,
      startDate: m.mandate_start_date,
      endDate: m.mandate_end_date,
      priceRange: showPrices
        ? seller
          ? { minAcceptablePrice: dec(m.seller_min_price_enc), maxListedPrice: dec(m.seller_max_price_enc) }
          : { minBudget: dec(m.buyer_min_budget_enc), maxBudget: dec(m.buyer_max_budget_enc) }
        : 'confidential',
      professionalFeeRate: '1% + GST/IGST - all transactions; no discount',
      gstType: m.gst_type,
      professionalFeeIndicative: fee ? { fee, tax: Math.round(fee * 0.18 * 100) / 100, total: Math.round(fee * 1.18 * 100) / 100 } : null,
      instalment1: inst('instalment_1'),
      instalment2: inst('instalment_2'),
      benefits: { valuation: m.valuation_status, dueDiligence: m.due_diligence_status, deedWriterWaiver: m.deed_writer_waiver_status },
      renewalCount: m.renewal_count,
    });
  }
  return { dealId, mandates: out, visible: true };
}

// ---------------------------------------------------------------- lifecycle

// Exclusive placement / Priority Buyer follow the ACTIVE mandate.
async function syncTarget(m, exclusive, client = pool) {
  if (m.listing_id) await client.query(`UPDATE properties SET mandate_type = $1 WHERE id = $2`, [exclusive ? 'exclusive' : 'standard', m.listing_id]);
  if (m.requirement_id) await client.query(`UPDATE requirements SET mandate_type = $1 WHERE id = $2`, [exclusive ? 'exclusive' : 'standard', m.requirement_id]);
}

// Badge / trust bonus and matching follow the change, best-effort.
function afterStatusChange(m) {
  const trust = require('./trust.service');
  const match = require('./matchEngine.service');
  if (m.user_id) trust.recompute(m.user_id, 'mandate').catch(() => {});
  if (m.listing_id) match.safeRefreshProperty?.(m.listing_id);
  if (m.requirement_id) match.safeRefreshRequirement?.(m.requirement_id);
}

function assertRepOrAdmin(m, user) {
  if (ADMIN.includes(user.role)) return;
  if (user.role === 'internal_sales' && (!m.assigned_rep_id || m.assigned_rep_id === user.id)) return;
  throw forbidden('Only the assigned A R representative or an admin can do this');
}

// Rep acknowledgement: activates the mandate and its benefits.
async function acknowledge(id, user, meta = {}) {
  if (!STAFF.includes(user.role)) throw forbidden();
  const c = await cfg();
  const client = await pool.connect();
  let m;
  try {
    await client.query('BEGIN');
    m = (await client.query('SELECT * FROM mandates WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!m) throw notFound('Mandate not found');
    assertRepOrAdmin(m, user);
    if (m.status !== 'pending_rep_ack') throw badRequest(`Mandate is ${m.status} - only a pending mandate can be acknowledged`);
    if (!m.seller_min_price_enc && !m.buyer_max_budget_enc) {
      throw badRequest('The price range is not on file - the client must re-confirm the mandate with the price range before activation');
    }
    const start = today();
    const end = addDays(start, isSeller(m.mandate_type) ? c.sellerDays : c.buyerDays);
    const due = {
      rep_initiate_by: new Date(Date.now() + (Number(c.benefitSla.rep_initiate_hours) || 24) * 3600000).toISOString(),
      valuation_working_days: Number(c.benefitSla.valuation_working_days) || 10,
      due_diligence_working_days: Number(c.benefitSla.due_diligence_working_days) || 15,
    };
    m = (
      await client.query(
        `UPDATE mandates SET status = 'active', acknowledged_at = now(), mandate_start_date = $2, mandate_end_date = $3,
           assigned_rep_id = COALESCE(assigned_rep_id, $4), deed_writer_waiver_status = 'active',
           valuation_status = CASE WHEN mandate_type = 'seller_exclusive' THEN 'requested' ELSE valuation_status END,
           due_diligence_status = CASE WHEN mandate_type = 'seller_exclusive' THEN 'in_progress' ELSE due_diligence_status END,
           benefit_due_dates = $5
         WHERE id = $1 RETURNING *`,
        [id, start, end, user.id, JSON.stringify(due)]
      )
    ).rows[0];
    await syncTarget(m, true, client);
    await logEvent(id, 'acknowledged', { actor: user, ip: meta.ip, detail: { start, end } }, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  afterStatusChange(m);
  await notify([m.user_id], {
    type: 'mandate_active',
    title: `Your Exclusive Mandate ${m.mandate_number} is active`,
    message: `Valid until ${new Date(m.mandate_end_date).toLocaleDateString('en-IN')}. Your dedicated A R representative will be in touch. Download the Mandate Summary from your dashboard.`,
    id: m.id,
  });
  return get(id, user);
}

async function assignRep(id, repId, user, meta = {}) {
  if (!ADMIN.includes(user.role)) throw forbidden('Only an admin can assign the representative');
  const rep = (
    await pool.query(`SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND r.name = ANY($2) AND u.status = 'active'`, [repId, STAFF])
  ).rows[0];
  if (!rep) throw badRequest('Representative must be an active A R staff member');
  const m = await loadMandate(id);
  await pool.query('UPDATE mandates SET assigned_rep_id = $1 WHERE id = $2', [repId, id]);
  await logEvent(id, 'assigned', { actor: user, ip: meta.ip, detail: { from: m.assigned_rep_id, to: repId } });
  await notify([repId], { type: 'mandate_assigned', title: `Mandate ${m.mandate_number} assigned to you`, message: 'You are now the dedicated A R representative.', id });
  return get(id, user);
}

// Mid-term renewal for a deal that is genuinely progressing.
async function renew(id, user, { reason } = {}, meta = {}) {
  if (!STAFF.includes(user.role)) throw forbidden();
  const c = await cfg();
  const m = await loadMandate(id);
  assertRepOrAdmin(m, user);
  if (!isExclusive(m.mandate_type)) throw badRequest('Only an Exclusive Mandate is renewed');
  if (!['active', 'expired'].includes(m.status)) throw badRequest(`A ${m.status} mandate cannot be renewed`);
  const deals = await linkedDeals(m);
  const progressing = deals.find((d) => PAST_SITE_VISIT.includes(d.stage) || (d.site_visit_completed && d.stage !== 'closed_lost'));
  if (!progressing) {
    await logEvent(id, 'renewal_refused', { actor: user, ip: meta.ip, detail: { reason: 'no deal past Site Visit Completed' } });
    throw badRequest('Renewal needs a deal on this mandate that has moved past Site Visit Completed');
  }
  if (m.renewal_count >= c.cap && user.role !== 'super_admin') {
    await logEvent(id, 'renewal_refused', { actor: user, ip: meta.ip, stage: progressing.stage, detail: { reason: 'renewal cap reached' } });
    throw forbidden(`This mandate has been renewed ${m.renewal_count} times - further renewal needs Super Admin approval`);
  }
  const from = m.mandate_end_date && new Date(m.mandate_end_date) > new Date() ? new Date(m.mandate_end_date).toISOString().slice(0, 10) : today();
  const end = addDays(from, isSeller(m.mandate_type) ? c.sellerDays : c.buyerDays);
  const updated = (
    await pool.query(
      `UPDATE mandates SET status = 'active', mandate_end_date = $2, renewal_count = renewal_count + 1, expiry_warnings_sent = '[]'::jsonb, status_reason = NULL
       WHERE id = $1 RETURNING *`,
      [id, end]
    )
  ).rows[0];
  if (m.status !== 'active') await syncTarget(updated, true);
  await logEvent(id, 'renewed', {
    actor: user, ip: meta.ip, stage: progressing.stage,
    detail: { deal_id: progressing.id, new_end_date: end, renewal_number: updated.renewal_count, admin_override: m.renewal_count >= c.cap, reason: reason || null },
  });
  if (m.status !== 'active') afterStatusChange(updated);
  await notify([m.user_id], {
    type: 'mandate_renewed', title: `Mandate ${m.mandate_number} renewed`,
    message: `Your mandate now runs until ${new Date(end).toLocaleDateString('en-IN')}.`, id,
  });
  return get(id, user);
}

async function endMandate(id, user, status, reason, meta = {}) {
  if (!STAFF.includes(user.role)) throw forbidden();
  if (!reason || !String(reason).trim()) throw badRequest('A reason is required');
  const m = await loadMandate(id);
  assertRepOrAdmin(m, user);
  if (['expired', 'breached', 'cancelled'].includes(m.status)) throw badRequest(`Mandate is already ${m.status}`);
  const updated = (await pool.query(`UPDATE mandates SET status = $2, status_reason = $3 WHERE id = $1 RETURNING *`, [id, status, String(reason).trim()])).rows[0];
  await syncTarget(updated, false);
  await logEvent(id, status, { actor: user, ip: meta.ip, detail: { reason } });
  afterStatusChange(updated);
  await notify([m.user_id, m.assigned_rep_id], {
    type: `mandate_${status}`,
    title: `Mandate ${m.mandate_number} ${status === 'breached' ? 'flagged as breached' : 'cancelled'}`,
    message: String(reason).trim(), id,
  });
  return get(id, user);
}

async function updateBenefits(id, user, data, meta = {}) {
  if (!STAFF.includes(user.role)) throw forbidden();
  const m = await loadMandate(id);
  assertRepOrAdmin(m, user);
  if (m.status !== 'active') throw badRequest('Benefits are delivered on an active mandate');
  const map = {
    valuationStatus: 'valuation_status',
    dueDiligenceStatus: 'due_diligence_status',
    deedWriterWaiverStatus: 'deed_writer_waiver_status',
    valuationDocumentId: 'valuation_document_id',
    dueDiligenceDocumentId: 'due_diligence_document_id',
  };
  const set = [];
  const params = [];
  const changed = {};
  for (const [key, col] of Object.entries(map)) {
    if (data[key] === undefined) continue;
    if (BENEFIT_VALUES[col] && !BENEFIT_VALUES[col].includes(data[key])) throw badRequest(`${key} must be one of ${BENEFIT_VALUES[col].join(', ')}`);
    if (col === 'valuation_status' && m.mandate_type !== 'seller_exclusive' && data[key] !== 'not_requested') {
      throw badRequest('Free valuation is a seller Exclusive Mandate benefit');
    }
    params.push(data[key] || null);
    set.push(`${col} = $${params.length}`);
    changed[col] = data[key] || null;
  }
  if (!set.length) throw badRequest('Nothing to update');
  params.push(id);
  await pool.query(`UPDATE mandates SET ${set.join(', ')} WHERE id = $${params.length}`, params);
  await logEvent(id, 'benefit_updated', { actor: user, ip: meta.ip, detail: changed });
  const done = Object.entries(changed).filter(([, v]) => ['completed', 'report_uploaded', 'utilised'].includes(v));
  if (done.length) {
    const label = { valuation_status: 'Valuation', due_diligence_status: 'Legal due diligence', deed_writer_waiver_status: 'Deed writer waiver' };
    await notify([m.user_id], {
      type: 'mandate_benefit', title: `Mandate benefit delivered: ${done.map(([k]) => label[k]).join(', ')}`,
      message: `${done.map(([k, v]) => `${label[k]} - ${v.replace('_', ' ')}`).join('; ')}`, id,
    });
  }
  return get(id, user);
}

// ---------------------------------------------------------------- sweep

// Daily: 30 / 7 / 1-day reminders to the client and rep, then expiry.
async function sweep() {
  const c = await cfg();
  let warned = 0;
  let expired = 0;
  const due = (await pool.query(`SELECT * FROM mandates WHERE status = 'active' AND mandate_end_date IS NOT NULL AND mandate_type LIKE '%_exclusive'`)).rows;
  for (const m of due) {
    const daysLeft = Math.ceil((new Date(m.mandate_end_date) - new Date(today())) / 86400000);
    if (daysLeft <= 0) {
      const updated = (await pool.query(`UPDATE mandates SET status = 'expired', status_reason = 'Mandate period ended' WHERE id = $1 AND status = 'active' RETURNING *`, [m.id])).rows[0];
      if (!updated) continue;
      await syncTarget(updated, false);
      await logEvent(m.id, 'expired', { detail: { end_date: m.mandate_end_date } });
      afterStatusChange(updated);
      await notify([m.user_id, m.assigned_rep_id], {
        type: 'mandate_expired', title: `Mandate ${m.mandate_number} has expired`,
        message: 'Exclusive benefits have ended. Your representative can renew it while a deal is in progress.', id: m.id,
      });
      expired += 1;
      continue;
    }
    const sent = Array.isArray(m.expiry_warnings_sent) ? m.expiry_warnings_sent.map(Number) : [];
    const step = c.warnDays.filter((d) => daysLeft <= d && !sent.includes(d)).sort((a, b) => a - b)[0];
    if (step === undefined) continue;
    const marks = c.warnDays.filter((d) => daysLeft <= d);
    await pool.query(`UPDATE mandates SET expiry_warnings_sent = $2 WHERE id = $1`, [m.id, JSON.stringify([...new Set([...sent, ...marks])])]);
    await logEvent(m.id, 'expiry_warning', { detail: { days_left: daysLeft, step } });
    await notify([m.user_id, m.assigned_rep_id], {
      type: `mandate_expiry_${step <= 1 ? '1d' : step <= 7 ? '7d' : '30d'}`,
      title: `Mandate ${m.mandate_number} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      message: `Ends on ${new Date(m.mandate_end_date).toLocaleDateString('en-IN')}.`, id: m.id,
    });
    warned += 1;
  }
  return { warned, expired };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  const run = () => sweep().catch((err) => console.error('[mandates] sweep failed:', err.message));
  setTimeout(run, 60 * 1000);
  timer = setInterval(run, 6 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------- PDFs

async function renderPdf(title, lines) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const draw = (text, { size = 10, f = font } = {}) => {
    if (y < 60) {
      page = pdf.addPage([595, 842]);
      y = 790;
    }
    page.drawText(String(text), { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.15) });
    y -= size + 7;
  };
  const wrap = (text, opts) => {
    let buf = '';
    for (const w of String(text).split(/\s+/)) {
      if ((buf + w).length > 95) {
        draw(buf.trim(), opts);
        buf = '';
      }
      buf += `${w} `;
    }
    if (buf.trim()) draw(buf.trim(), opts);
  };
  draw('A R Buildwel - PropertySerch.com', { size: 15, f: bold });
  draw('GSTIN: 07DERPR1574G2ZY');
  y -= 6;
  draw(title, { size: 13, f: bold });
  y -= 4;
  for (const l of lines) {
    if (l === '') y -= 6;
    else if (typeof l === 'object') wrap(l.text, { size: l.size || 10, f: l.bold ? bold : font });
    else wrap(l);
  }
  return Buffer.from(await pdf.save());
}

// Professional Fee Consent Record - built from the immutable fee_consents row.
async function consentPdf(id, user, meta = {}) {
  const m = await loadMandate(id);
  if (!STAFF.includes(user.role) && m.user_id !== user.id) throw notFound('Mandate not found');
  if (!m.fee_consent_id) throw notFound('No OTP consent record on file for this mandate (created before OTP consent was introduced)');
  const fc = (await pool.query('SELECT * FROM fee_consents WHERE id = $1', [m.fee_consent_id])).rows[0];
  const c = await cfg();
  await logEvent(id, 'consent_downloaded', { actor: user, ip: meta.ip });
  return renderPdf('Professional Fee Consent Record', [
    `Platform reference: ${m.mandate_number} / consent ${fc.id}`,
    `Fee rate: 1% + GST/IGST of the transaction value (rentals: one month's gross rent + GST/IGST)`,
    'Instalment schedule: 50% + tax at Agreement to Sell execution; 50% + tax at Sale Deed execution',
    `Mandate type selected: ${isExclusive(m.mandate_type) ? 'Exclusive Mandate' : 'Standard Engagement'} (${isSeller(m.mandate_type) ? 'seller' : 'buyer'})`,
    `OTP verified by mobile ending ${fc.mobile_last4 || '----'} at ${new Date(fc.otp_verified_at).toISOString()}`,
    `IP address: ${fc.ip_address || '-'}`,
    `Consent text version: ${fc.consent_version}`,
    '',
    { text: 'Consent text', bold: true },
    c.text || '-',
    '',
    { text: 'This record is system-generated from an immutable consent log and requires no signature.', size: 8 },
  ]);
}

// Mandate Summary - shared with the client on acknowledgement. Never shows the price range.
async function summaryPdf(id, user, meta = {}) {
  const m = await loadMandate(id);
  if (!STAFF.includes(user.role) && m.user_id !== user.id) throw notFound('Mandate not found');
  if (m.status === 'pending_rep_ack') throw badRequest('The Mandate Summary is issued once the representative acknowledges the mandate');
  const [item] = await enrich([stripPrices(m)]);
  const terms = await consentTerms();
  const seller = isSeller(m.mandate_type);
  const disclaimers = (
    await pool.query(`SELECT content_html AS body FROM disclaimers WHERE disclaimer_key = ANY($1) AND is_active ORDER BY sort_order`, [terms.disclaimerTypes]).catch(() => ({ rows: [] }))
  ).rows.map((r) => r.body);
  await logEvent(id, 'summary_downloaded', { actor: user, ip: meta.ip });
  return renderPdf(`Mandate Summary - ${m.mandate_number}`, [
    `Client: ${item.client_name || '-'}`,
    `Subject: ${item.subject || '-'}`,
    `Mandate: ${isExclusive(m.mandate_type) ? 'Exclusive Mandate' : 'Standard Engagement'} (${seller ? 'seller' : 'buyer'})`,
    `Period: ${m.mandate_start_date ? new Date(m.mandate_start_date).toLocaleDateString('en-IN') : '-'} to ${m.mandate_end_date ? new Date(m.mandate_end_date).toLocaleDateString('en-IN') : '-'}`,
    `Dedicated A R representative: ${item.assigned_rep_name || 'to be assigned'}`,
    'Professional fee: 1% + GST/IGST - all transactions; no discount. 50% at ATS execution, 50% at Sale Deed execution.',
    'Execution of the Sale Deed and its registration at the Sub-Registrar Office are one and the same act. All stamp duty, registration charges and related expenses are borne exclusively by the purchaser.',
    '',
    { text: 'Benefits', bold: true },
    ...(isExclusive(m.mandate_type) ? (seller ? terms.sellerBenefits : terms.buyerBenefits).map((b) => `- ${b}`) : ['- Standard service']),
    '',
    { text: 'Your price range is held confidentially by your representative and is not shown in this document.', size: 9 },
    ...disclaimers.map((d) => ({ text: d, size: 8 })),
  ]);
}

// ---------------------------------------------------------------- matching

// Decrypted seller minimum / buyer maximum for the Price-Compatible flag -
// attached as non-enumerable properties so they can never be serialised.
function hidePrice(row, encKey, hiddenKey) {
  if (!row || !(encKey in row)) return row;
  let value = null;
  try {
    value = row[encKey] ? Number(decrypt(row[encKey])) : null;
  } catch {
    value = null;
  }
  delete row[encKey];
  Object.defineProperty(row, hiddenKey, { value, enumerable: false, configurable: true });
  return row;
}

async function attachBuyerMax(reqs) {
  const list = (Array.isArray(reqs) ? reqs : [reqs]).filter((r) => r && r.id && r.mandate_type === 'exclusive');
  if (!list.length) return reqs;
  const rows = (
    await pool.query(
      `SELECT requirement_id, buyer_max_budget_enc FROM mandates
       WHERE requirement_id = ANY($1::uuid[]) AND mandate_type = 'buyer_exclusive' AND status = 'active'`,
      [list.map((r) => r.id)]
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.requirement_id, r.buyer_max_budget_enc]));
  for (const r of list) {
    r.buyer_max_enc = byId.get(r.id) || null;
    hidePrice(r, 'buyer_max_enc', '_buyerMax');
  }
  return reqs;
}

// Response SLA (hours) for an inquiry on a listing / from a buyer.
async function responseSlaHours({ listingId, requirementId }) {
  const c = await cfg();
  const active = (
    await pool.query(
      `SELECT 1 FROM mandates WHERE status = 'active' AND mandate_type LIKE '%_exclusive' AND (listing_id = $1 OR requirement_id = $2) LIMIT 1`,
      [listingId || null, requirementId || null]
    )
  ).rows.length > 0;
  return active ? Number(c.sla.exclusive) : Number(c.sla.standard);
}

module.exports = {
  STAFF,
  consentTerms,
  sendConsentOtp,
  verifyConsentOtp,
  validatePriceRange,
  assertConsentUsable,
  createForPost,
  afterCreate,
  list,
  get,
  listMine,
  priceRange,
  forDeal,
  acknowledge,
  assignRep,
  renew,
  breach: (id, user, reason, meta) => endMandate(id, user, 'breached', reason, meta),
  cancel: (id, user, reason, meta) => endMandate(id, user, 'cancelled', reason, meta),
  updateBenefits,
  sweep,
  startScheduler,
  consentPdf,
  summaryPdf,
  hidePrice,
  attachBuyerMax,
  responseSlaHours,
};
