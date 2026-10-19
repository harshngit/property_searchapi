const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { getReadUrl } = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');
const userBlock = require('../utils/userBlock');

// Modules 25 (Loan / Financing) and 26 (Insurance) - referral only.
//   Panel     : empanelled banks, NBFCs, housing finance companies and
//               insurers, with their Loan / Insurance Officers. An LO / IO
//               code is issued only after the empanelment / IRDAI licence
//               check and never carries commission.
//   Loan      : income + property value -> documents linked -> indicative
//               eligibility -> lender options -> application submitted ->
//               handed to the loan officer -> sanction -> disbursement.
//   Insurance : property details pre-filled -> coverage options -> insurer
//               selected -> handed to the insurance officer -> policy
//               confirmed.
//   The platform never lends, disburses, issues a policy or takes a premium.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const LOAN_TYPES = ['home_loan', 'commercial_property_loan', 'construction_finance', 'lap', 'nri_mortgage', 'builder_project_loan'];
const LOAN_LABEL = { home_loan: 'Home loan', commercial_property_loan: 'Commercial property loan', construction_finance: 'Construction finance', lap: 'Loan against property', nri_mortgage: 'NRI mortgage', builder_project_loan: 'Builder project loan' };
const COVER_TYPES = ['home_structure', 'home_contents', 'home_package', 'loan_protection', 'commercial_property'];
const LENDER_KINDS = ['bank', 'nbfc', 'hfc'];
const LOAN_OPEN = ['started', 'submitted', 'referred', 'sanctioned'];
const INS_OPEN = ['requested', 'option_selected', 'referred'];
const isStaff = (user) => STAFF.includes(user.role);
const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean))];
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round = (n) => Math.round(Number(n));

async function settings() {
  const [elig, loanDisclaimer, insDisclaimer, covers] = await Promise.all([
    configService.getConfig('loan.eligibility', {}),
    configService.getConfig('loan.disclaimer', 'Loan eligibility subject to lender assessment and applicable T&Cs.'),
    configService.getConfig('insurance.disclaimer', 'Insurance is issued by the insurer, subject to its own terms and underwriting.'),
    configService.getConfig('insurance.cover_labels', {}),
  ]);
  return {
    elig: { foir_percent: 50, rate_percent: 8.75, tenure_years: 20, ltv_slabs: [{ up_to: 3000000, percent: 90 }, { up_to: 7500000, percent: 80 }, { up_to: null, percent: 75 }], ...(elig || {}) },
    loanDisclaimer, insDisclaimer,
    covers: { home_structure: 'Home structure cover', home_contents: 'Home contents cover', home_package: 'Home package (structure + contents)', loan_protection: 'Home loan protection cover', commercial_property: 'Commercial property cover', ...(covers || {}) },
  };
}

const notify = async (ids, n) => {
  for (const id of [...new Set(ids.filter(Boolean))]) await notificationService.createNotification({ userId: id, ...n }).catch(() => {});
};
// The internal desk (LD / ID coordinators) and admins; the deal's representative when there is one.
async function deskIds(designation, { dealId = null, leadId = null } = {}) {
  const r = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN arb_representatives ar ON ar.user_id = u.id
     WHERE u.status = 'active' AND (r.name = ANY($1) OR ar.designation = $2)`,
    [ADMIN, designation]
  );
  const rep = (await pool.query(`SELECT COALESCE((SELECT assigned_rep_id FROM deals WHERE id = $1), (SELECT arb_rep_id FROM leads WHERE id = $2)) AS id`, [dealId, leadId])).rows[0]?.id;
  return [rep, ...r.rows.map((x) => x.id)];
}
const event = (type, id, kind, note, actor, clientVisible = true, client = pool) =>
  client.query(`INSERT INTO finance_case_events (subject_type, subject_id, kind, note, client_visible, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`, [type, id, kind, note || null, clientVisible, actor?.id || null]);

async function timeline(type, id, staff) {
  const r = await pool.query(
    `SELECT e.kind, e.note, e.client_visible, e.created_at, u.full_name FROM finance_case_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.subject_type = $1 AND e.subject_id = $2 ${staff ? '' : 'AND e.client_visible'} ORDER BY e.created_at`,
    [type, id]
  );
  return r.rows.map((e) => ({ kind: e.kind, note: e.note, at: e.created_at, ...(staff ? { by: e.full_name, clientVisible: e.client_visible } : {}) }));
}

// "Document upload": whatever is already on file is linked; anything
// uploaded later under Documents can be added to the case.
async function autoLink(type, id, { customerId, dealId, propertyId }, client = pool) {
  const r = await client.query(
    `INSERT INTO finance_case_documents (subject_type, subject_id, document_id)
     SELECT $1, $2, d.id FROM documents d
     WHERE ($3::uuid IS NOT NULL AND d.deal_id = $3) OR ($4::uuid IS NOT NULL AND d.property_id = $4) OR ($5::uuid IS NOT NULL AND d.customer_id = $5 AND d.deal_id IS NULL)
     ON CONFLICT DO NOTHING RETURNING document_id`,
    [type, id, dealId || null, propertyId || null, customerId || null]
  );
  return r.rows.length;
}
async function linkedDocs(type, id) {
  const r = await pool.query(
    `SELECT d.id, d.document_type, d.file_name, d.status, d.document_url, l.auto_linked, d.created_at FROM finance_case_documents l JOIN documents d ON d.id = l.document_id
     WHERE l.subject_type = $1 AND l.subject_id = $2 ORDER BY d.created_at`,
    [type, id]
  );
  return r.rows;
}
const docView = (d) => ({ id: d.id, type: d.document_type, fileName: d.file_name, status: d.status, autoLinked: d.auto_linked, addedAt: d.created_at });

// A partner officer reaches only what was referred to them, while verified.
async function isOfficerOf(user, officerId) {
  if (!officerId) return false;
  return (await pool.query(`SELECT 1 FROM partner_officers WHERE id = $1 AND user_id = $2 AND status = 'verified'`, [officerId, user.id])).rows.length > 0;
}

async function customerOf(user) {
  const c = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [user.id])).rows[0];
  if (!c) throw badRequest('Complete your profile first');
  return c.id;
}
async function ownDeal(dealId, customerId) {
  const d = (await pool.query('SELECT id, property_id, deal_value FROM deals WHERE id = $1 AND customer_id = $2', [dealId, customerId])).rows[0];
  if (!d) throw notFound('Deal not found');
  return d;
}
// Staff may open a case for a client from a deal, an enquiry or directly.
async function resolveSubject(data) {
  let { customerId = null, dealId = null, propertyId = null, leadId = null } = data;
  let dealValue = null;
  if (dealId) {
    const d = (await pool.query('SELECT customer_id, property_id, lead_id, deal_value FROM deals WHERE id = $1', [dealId])).rows[0];
    if (!d) throw notFound('Deal not found');
    customerId = customerId || d.customer_id;
    propertyId = propertyId || d.property_id;
    leadId = leadId || d.lead_id;
    dealValue = d.deal_value;
  }
  if (leadId && !customerId) {
    const l = (await pool.query('SELECT customer_id, property_id FROM leads WHERE id = $1', [leadId])).rows[0];
    if (!l) throw notFound('Enquiry not found');
    customerId = l.customer_id;
    propertyId = propertyId || l.property_id;
  }
  if (!customerId) throw badRequest('Choose the deal, enquiry or customer this is for');
  const requestedBy = (await pool.query('SELECT user_id FROM customers WHERE id = $1', [customerId])).rows[0]?.user_id || null;
  return { customerId, dealId, propertyId, leadId, requestedBy, dealValue };
}

// ------------------------------------------------------------------ panel

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // ^(LO|IO)-[A-HJ-KM-NP-Z2-9]{5}$
async function newCode(prefix, client) {
  for (let i = 0; i < 20; i += 1) {
    const code = `${prefix}-${Array.from(crypto.randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
    if (!(await client.query('SELECT 1 FROM partner_officers WHERE code = $1', [code])).rows.length) return code;
  }
  throw new Error('Could not issue an officer code');
}

const instView = (i, { staff = false } = {}) => ({
  id: i.id, kind: i.kind, name: i.name, status: i.status, loanProducts: i.loan_products, insuranceProducts: i.insurance_products,
  rateFromPercent: num(i.rate_from_percent), rateToPercent: num(i.rate_to_percent), maxTenureYears: i.max_tenure_years, maxLtvPercent: num(i.max_ltv_percent), servesNri: i.serves_nri,
  ...(staff ? { empanelmentRef: i.empanelment_ref, irdaiRegistration: i.irdai_registration, minLoanAmount: num(i.min_loan_amount), maxLoanAmount: num(i.max_loan_amount), maxFoirPercent: num(i.max_foir_percent),
    cities: i.cities, states: i.states, notes: i.notes, verifiedAt: i.verified_at, verificationNote: i.verification_note, officers: i.officers, openCases: i.open_cases, referrals90d: i.referrals_90d } : {}),
});
const officerView = (o) => ({ id: o.id, institutionId: o.institution_id, institutionName: o.institution_name, code: o.code, role: o.role, fullName: o.full_name, designation: o.designation, licenceNumber: o.licence_number, email: o.email, mobile: o.mobile, cities: o.cities, status: o.status, verifiedAt: o.verified_at, verificationNote: o.verification_note, hasLogin: !!o.user_id });

async function listInstitutions({ kind = null, status = null } = {}) {
  const r = await pool.query(
    `SELECT i.*, (SELECT COUNT(*) FROM partner_officers o WHERE o.institution_id = i.id AND o.status = 'verified')::int AS officers,
            ((SELECT COUNT(*) FROM loan_applications a WHERE a.institution_id = i.id AND a.status = ANY($3)) + (SELECT COUNT(*) FROM insurance_requests q WHERE q.institution_id = i.id AND q.status = ANY($4)))::int AS open_cases,
            ((SELECT COUNT(*) FROM loan_applications a WHERE a.institution_id = i.id AND a.referred_at > now() - interval '90 days') + (SELECT COUNT(*) FROM insurance_requests q WHERE q.institution_id = i.id AND q.referred_at > now() - interval '90 days'))::int AS referrals_90d
     FROM partner_institutions i WHERE ($1::text IS NULL OR i.kind = $1 OR ($1 = 'lender' AND i.kind = ANY($5))) AND ($2::text IS NULL OR i.status = $2)
     ORDER BY (i.status = 'empanelled') DESC, i.name`,
    [kind, status, LOAN_OPEN, INS_OPEN, LENDER_KINDS]
  );
  return r.rows.map((i) => instView(i, { staff: true }));
}

async function saveInstitution(user, data, meta = {}) {
  const before = data.id ? (await pool.query('SELECT * FROM partner_institutions WHERE id = $1', [data.id])).rows[0] : null;
  if (data.id && !before) throw notFound('Institution not found');
  const pick = (k, col) => (data[k] !== undefined ? data[k] : before?.[col]);
  const kind = pick('kind', 'kind');
  if (!['bank', 'nbfc', 'hfc', 'insurer'].includes(kind)) throw badRequest('kind must be bank, nbfc, hfc or insurer');
  const name = String(pick('name', 'name') || '').trim();
  if (name.length < 2) throw badRequest('The institution name is required');
  const loanProducts = kind === 'insurer' ? [] : list(pick('loanProducts', 'loan_products'));
  const insuranceProducts = kind === 'insurer' ? list(pick('insuranceProducts', 'insurance_products')) : [];
  if (loanProducts.some((p) => !LOAN_TYPES.includes(p))) throw badRequest(`Loan products must be from: ${LOAN_TYPES.join(', ')}`);
  if (insuranceProducts.some((p) => !COVER_TYPES.includes(p))) throw badRequest(`Insurance products must be from: ${COVER_TYPES.join(', ')}`);
  const pct = (k, col) => {
    const v = num(pick(k, col));
    if (v !== null && (v <= 0 || v > 100)) throw badRequest(`${k} must be a percentage`);
    return v;
  };
  const vals = [kind, name, pick('empanelmentRef', 'empanelment_ref') || null, pick('irdaiRegistration', 'irdai_registration') || null, loanProducts, insuranceProducts, num(pick('minLoanAmount', 'min_loan_amount')), num(pick('maxLoanAmount', 'max_loan_amount')),
    pct('rateFromPercent', 'rate_from_percent'), pct('rateToPercent', 'rate_to_percent'), pct('maxLtvPercent', 'max_ltv_percent'), pct('maxFoirPercent', 'max_foir_percent'), num(pick('maxTenureYears', 'max_tenure_years')),
    pick('servesNri', 'serves_nri') === true, list(pick('cities', 'cities')), list(pick('states', 'states')).map((s) => s.toUpperCase()), pick('notes', 'notes') || null];
  let i;
  try {
    i = before
      ? (await pool.query(`UPDATE partner_institutions SET kind = $2, name = $3, empanelment_ref = $4, irdai_registration = $5, loan_products = $6, insurance_products = $7, min_loan_amount = $8, max_loan_amount = $9, rate_from_percent = $10, rate_to_percent = $11, max_ltv_percent = $12, max_foir_percent = $13, max_tenure_years = $14, serves_nri = $15, cities = $16, states = $17, notes = $18 WHERE id = $1 RETURNING *`, [before.id, ...vals])).rows[0]
      : (await pool.query(`INSERT INTO partner_institutions (kind, name, empanelment_ref, irdai_registration, loan_products, insurance_products, min_loan_amount, max_loan_amount, rate_from_percent, rate_to_percent, max_ltv_percent, max_foir_percent, max_tenure_years, serves_nri, cities, states, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`, [...vals, user.id])).rows[0];
  } catch (err) {
    if (err.code === '23505') throw badRequest('This institution is already on the panel');
    throw err;
  }
  await auditService.log({ actor: user, action: before ? 'finance.institution_updated' : 'finance.institution_added', entityType: 'partner_institution', entityId: i.id, after: { name, kind }, ...meta });
  return instView(i, { staff: true });
}

// Empanelment: an institution goes live only with the letter / registration on record.
async function decideInstitution(user, id, { action, note }, meta = {}) {
  const i = (await pool.query('SELECT * FROM partner_institutions WHERE id = $1', [id])).rows[0];
  if (!i) throw notFound('Institution not found');
  if (!['empanel', 'suspend', 'reinstate'].includes(action)) throw badRequest('action must be empanel, suspend or reinstate');
  if (!note || String(note).trim().length < 5) throw badRequest(action === 'suspend' ? 'Give the reason' : 'Record what was checked (empanelment letter, IRDAI registration)');
  const allowed = { empanel: 'pending', suspend: 'empanelled', reinstate: 'suspended' }[action];
  if (i.status !== allowed) throw badRequest(`Only a ${allowed} institution can be ${action === 'empanel' ? 'empanelled' : `${action}${action === 'suspend' ? 'ed' : 'd'}`}`);
  if (action !== 'suspend') {
    if (!i.empanelment_ref) throw badRequest('Add the empanelment letter / agreement reference first');
    if (i.kind === 'insurer' && !i.irdai_registration) throw badRequest("Add the insurer's IRDAI registration number first");
  }
  const status = action === 'suspend' ? 'suspended' : 'empanelled';
  const u = (await pool.query(`UPDATE partner_institutions SET status = $2::varchar, verified_by = CASE WHEN $2::varchar = 'empanelled' THEN $3 ELSE verified_by END, verified_at = CASE WHEN $2::varchar = 'empanelled' THEN now() ELSE verified_at END, verification_note = $4 WHERE id = $1 RETURNING *`, [id, status, user.id, String(note).trim()])).rows[0];
  await auditService.log({ actor: user, action: `finance.institution_${action}`, entityType: 'partner_institution', entityId: id, before: { status: i.status }, after: { status, note }, ...meta });
  return instView(u, { staff: true });
}

async function listOfficers({ institutionId = null, role = null, status = null } = {}) {
  const r = await pool.query(
    `SELECT o.*, i.name AS institution_name FROM partner_officers o JOIN partner_institutions i ON i.id = o.institution_id
     WHERE ($1::uuid IS NULL OR o.institution_id = $1) AND ($2::text IS NULL OR o.role = $2) AND ($3::text IS NULL OR o.status = $3) ORDER BY i.name, o.full_name`,
    [institutionId, role, status]
  );
  return r.rows.map(officerView);
}

async function saveOfficer(user, data, meta = {}) {
  const before = data.id ? (await pool.query('SELECT * FROM partner_officers WHERE id = $1', [data.id])).rows[0] : null;
  if (data.id && !before) throw notFound('Officer not found');
  const institutionId = before?.institution_id || data.institutionId;
  const inst = (await pool.query('SELECT * FROM partner_institutions WHERE id = $1', [institutionId])).rows[0];
  if (!inst) throw badRequest('Choose the institution this officer works for');
  const pick = (k, col) => (data[k] !== undefined ? data[k] : before?.[col]);
  const fullName = String(pick('fullName', 'full_name') || '').trim();
  if (fullName.length < 2) throw badRequest("The officer's name is required");
  const email = pick('email', 'email') ? String(pick('email', 'email')).trim().toLowerCase() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email');
  // The role follows the institution: a lender's staff are Loan Officers, an insurer's are Insurance Officers.
  const role = inst.kind === 'insurer' ? 'IO' : 'LO';
  const vals = [fullName, pick('designation', 'designation') || null, pick('licenceNumber', 'licence_number') || null, email, pick('mobile', 'mobile') || null, list(pick('cities', 'cities'))];
  const o = before
    ? (await pool.query(`UPDATE partner_officers SET full_name = $2, designation = $3, licence_number = $4, email = $5, mobile = $6, cities = $7 WHERE id = $1 RETURNING *`, [before.id, ...vals])).rows[0]
    : (await pool.query(`INSERT INTO partner_officers (institution_id, role, full_name, designation, licence_number, email, mobile, cities, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [institutionId, role, ...vals, user.id])).rows[0];
  await auditService.log({ actor: user, action: before ? 'finance.officer_updated' : 'finance.officer_added', entityType: 'partner_officer', entityId: o.id, after: { name: fullName, role, institution: inst.name }, ...meta });
  return officerView({ ...o, institution_name: inst.name });
}

// The LO / IO code is issued here, with the check recorded against it.
// A partner's login follows their panel status: suspended locks it at once (sessions cut), reinstated opens it again.
async function syncPartnerLogin(userId, panelActive) {
  if (!userId) return;
  await pool.query(`UPDATE users SET status = $2 WHERE id = $1 AND status IN ('active', 'suspended')`, [userId, panelActive ? 'active' : 'suspended']);
  if (panelActive) userBlock.unblock(userId);
  else {
    userBlock.block(userId, 'suspended');
    await pool.query('UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1', [userId]);
  }
}

async function decideOfficer(user, id, { action, note }, meta = {}) {
  const o = (await pool.query('SELECT o.*, i.name AS institution_name, i.status AS inst_status FROM partner_officers o JOIN partner_institutions i ON i.id = o.institution_id WHERE o.id = $1', [id])).rows[0];
  if (!o) throw notFound('Officer not found');
  if (!['verify', 'suspend', 'reinstate'].includes(action)) throw badRequest('action must be verify, suspend or reinstate');
  if (!note || String(note).trim().length < 5) throw badRequest(action === 'suspend' ? 'Give the reason' : 'Record what was checked');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let u;
    if (action === 'suspend') {
      if (o.status !== 'verified') throw badRequest('Only a verified officer can be suspended');
      u = (await client.query(`UPDATE partner_officers SET status = 'suspended', verification_note = $2 WHERE id = $1 RETURNING *`, [id, `Suspended: ${String(note).trim()}`])).rows[0];
    } else {
      if (action === 'verify' && o.status !== 'pending') throw badRequest('This officer already has a code');
      if (action === 'reinstate' && o.status !== 'suspended') throw badRequest('Only a suspended officer can be reinstated');
      if (o.inst_status !== 'empanelled') throw badRequest('Empanel the institution first');
      // Only an IRDAI-licensed person may deal in insurance: the licence number must be on record.
      if (o.role === 'IO' && !o.licence_number) throw badRequest("Add the officer's IRDAI licence number first");
      const code = o.code || (await newCode(o.role, client));
      u = (await client.query(`UPDATE partner_officers SET status = 'verified', code = $2, verified_by = $3, verified_at = now(), verification_note = $4 WHERE id = $1 RETURNING *`, [id, code, user.id, String(note).trim()])).rows[0];
    }
    await client.query('COMMIT');
    await syncPartnerLogin(u.user_id, u.status === 'verified');
    await auditService.log({ actor: user, action: `finance.officer_${action}`, entityType: 'partner_officer', entityId: id, before: { status: o.status }, after: { status: u.status, code: u.code, note }, ...meta });
    return officerView({ ...u, institution_name: o.institution_name });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------- loan eligibility

// Largest loan an EMI can service at a rate over a tenure.
function principalFor(emi, ratePercent, years) {
  const r = ratePercent / 1200;
  const n = years * 12;
  if (emi <= 0 || n <= 0) return 0;
  return r === 0 ? emi * n : (emi * (1 - (1 + r) ** -n)) / r;
}
const emiFor = (principal, ratePercent, years) => {
  const r = ratePercent / 1200;
  const n = years * 12;
  if (!principal || n <= 0) return 0;
  return r === 0 ? principal / n : (principal * r) / (1 - (1 + r) ** -n);
};
const ltvFor = (value, slabs) => Number((slabs.find((s) => s.up_to === null || s.up_to === undefined || value <= Number(s.up_to)) || slabs[slabs.length - 1] || { percent: 75 }).percent);

// Indicative only. Two caps: what the income can service, and the loan-to-value limit.
function assess({ monthlyIncome, existingEmi = 0, propertyValue, loanAmountRequested, tenureYears }, { foir, rate, tenure, ltv }) {
  const years = Math.min(Number(tenureYears) || tenure, 30);
  const availableEmi = Math.max(0, (Number(monthlyIncome) || 0) * (foir / 100) - (Number(existingEmi) || 0));
  const byIncome = monthlyIncome ? principalFor(availableEmi, rate, years) : null;
  const byValue = propertyValue ? (Number(propertyValue) * ltv) / 100 : null;
  const caps = [byIncome, byValue].filter((v) => v !== null);
  const eligible = caps.length ? Math.max(0, Math.min(...caps)) : null;
  const requested = num(loanAmountRequested);
  const amount = eligible === null ? requested : requested ? Math.min(requested, eligible) : eligible;
  return {
    foirPercent: foir, ratePercent: rate, tenureYears: years, ltvPercent: ltv,
    availableEmi: round(availableEmi), eligibleByIncome: byIncome === null ? null : round(byIncome), eligibleByPropertyValue: byValue === null ? null : round(byValue),
    eligibleAmount: eligible === null ? null : round(eligible), indicativeEmi: amount ? round(emiFor(amount, rate, years)) : null,
    limitedBy: eligible === null ? null : byIncome !== null && (byValue === null || byIncome <= byValue) ? 'income' : 'property_value',
    verdict: eligible === null ? 'more_details_needed' : !requested ? 'indicative' : requested <= eligible ? 'within_eligibility' : 'above_eligibility',
  };
}

// Empanelled lenders that offer this loan in this place, each with its own indicative terms.
async function lenderOptions(input, s) {
  const r = await pool.query(
    `SELECT * FROM partner_institutions WHERE status = 'empanelled' AND kind = ANY($1) AND $2 = ANY(loan_products)
       AND (cardinality(cities) = 0 OR $3::text IS NULL OR EXISTS (SELECT 1 FROM unnest(cities) x WHERE lower(x) = lower($3)))
       AND (NOT $4::boolean OR serves_nri) ORDER BY rate_from_percent ASC NULLS LAST, name`,
    [LENDER_KINDS, input.loanType, input.city || null, !!input.isNri]
  );
  const options = [];
  for (const i of r.rows) {
    const terms = { foir: num(i.max_foir_percent) || s.elig.foir_percent, rate: num(i.rate_from_percent) || s.elig.rate_percent, tenure: i.max_tenure_years || s.elig.tenure_years, ltv: Math.min(num(i.max_ltv_percent) || 100, ltvFor(Number(input.propertyValue) || 0, s.elig.ltv_slabs)) };
    const a = assess(input, terms);
    const want = num(input.loanAmountRequested) || a.eligibleAmount;
    if (want && i.min_loan_amount && want < Number(i.min_loan_amount)) continue;
    if (want && i.max_loan_amount && want > Number(i.max_loan_amount) && !(a.eligibleAmount && a.eligibleAmount <= Number(i.max_loan_amount))) continue;
    options.push({ institutionId: i.id, name: i.name, kind: i.kind, rateFromPercent: num(i.rate_from_percent), rateToPercent: num(i.rate_to_percent), maxTenureYears: i.max_tenure_years, maxLtvPercent: num(i.max_ltv_percent), eligibleAmount: a.eligibleAmount, indicativeEmi: a.indicativeEmi, verdict: a.verdict });
  }
  return options;
}

function cleanLoanInput(data) {
  const loanType = data.loanType || 'home_loan';
  if (!LOAN_TYPES.includes(loanType)) throw badRequest(`loanType must be one of: ${LOAN_TYPES.join(', ')}`);
  const out = { loanType, employmentType: data.employmentType || null, monthlyIncome: num(data.monthlyIncome), existingEmi: num(data.existingEmi) || 0, propertyValue: num(data.propertyValue), loanAmountRequested: num(data.loanAmountRequested), tenureYears: num(data.tenureYears), city: data.city ? String(data.city).trim().slice(0, 100) : null, isNri: data.isNri === true || loanType === 'nri_mortgage' };
  if (out.employmentType && !['salaried', 'self_employed', 'business', 'professional', 'other'].includes(out.employmentType)) throw badRequest('Unknown employment type');
  for (const k of ['monthlyIncome', 'existingEmi', 'propertyValue', 'loanAmountRequested']) if (out[k] !== null && out[k] < 0) throw badRequest(`${k} cannot be negative`);
  if (out.tenureYears !== null && (out.tenureYears < 1 || out.tenureYears > 30)) throw badRequest('Tenure must be between 1 and 30 years');
  return out;
}

// The eligibility check on its own - nothing is saved.
async function checkEligibility(data) {
  const s = await settings();
  const input = cleanLoanInput(data);
  if (!input.monthlyIncome && !input.propertyValue) throw badRequest('Enter your monthly income and the property value');
  const eligibility = assess(input, { foir: s.elig.foir_percent, rate: s.elig.rate_percent, tenure: s.elig.tenure_years, ltv: ltvFor(input.propertyValue || 0, s.elig.ltv_slabs) });
  return { eligibility, lenderOptions: await lenderOptions(input, s), disclaimer: s.loanDisclaimer };
}

// ------------------------------------------------------ loan applications

const LOAN_SELECT = `SELECT a.*, i.name AS institution_name, i.kind AS institution_kind, o.full_name AS officer_name, o.code AS officer_code,
    cu.full_name AS customer_name, pr.title AS property_title,
    (SELECT COUNT(*) FROM finance_case_documents d WHERE d.subject_type = 'loan' AND d.subject_id = a.id)::int AS documents
  FROM loan_applications a LEFT JOIN partner_institutions i ON i.id = a.institution_id LEFT JOIN partner_officers o ON o.id = a.officer_id
  LEFT JOIN customers cu ON cu.id = a.customer_id LEFT JOIN properties pr ON pr.id = a.property_id`;

const loanView = (a, { staff = false } = {}) => ({
  id: a.id, applicationNumber: a.application_number, loanType: a.loan_type, loanLabel: LOAN_LABEL[a.loan_type], status: a.status,
  employmentType: a.employment_type, monthlyIncome: num(a.monthly_income), existingEmi: num(a.existing_emi), propertyValue: num(a.property_value), loanAmountRequested: num(a.loan_amount_requested), tenureYears: a.tenure_years, city: a.city, isNri: a.is_nri,
  eligibility: a.eligibility, dealId: a.deal_id, propertyId: a.property_id, propertyTitle: a.property_title, documents: a.documents,
  // The client sees the lender and the officer's name and code - never the officer's phone or email.
  lender: a.institution_id ? { institutionId: a.institution_id, name: a.institution_name, kind: a.institution_kind, officer: a.officer_id ? { name: a.officer_name, code: a.officer_code } : null } : null,
  submittedAt: a.submitted_at, referredAt: a.referred_at, sanctionedAmount: num(a.sanctioned_amount), sanctionedRate: num(a.sanctioned_rate), sanctionedOn: a.sanctioned_on, disbursementSchedule: a.disbursement_schedule || [],
  createdAt: a.created_at, updatedAt: a.updated_at,
  ...(staff ? { customerId: a.customer_id, customerName: a.customer_name, leadId: a.lead_id, institutionId: a.institution_id, officerId: a.officer_id, lenderReference: a.lender_reference, source: a.source } : {}),
});

async function insertLoan(actor, subject, input, source, meta = {}) {
  const s = await settings();
  const eligibility = input.monthlyIncome || input.propertyValue ? assess(input, { foir: s.elig.foir_percent, rate: s.elig.rate_percent, tenure: s.elig.tenure_years, ltv: ltvFor(input.propertyValue || 0, s.elig.ltv_slabs) }) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = (await client.query(`SELECT nextval('loan_application_seq') AS n`)).rows[0].n;
    const a = (
      await client.query(
        `INSERT INTO loan_applications (application_number, requested_by, customer_id, deal_id, property_id, lead_id, loan_type, employment_type, monthly_income, existing_emi, property_value, loan_amount_requested, tenure_years, city, is_nri, eligibility, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
        [`LA-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`, subject.requestedBy || null, subject.customerId, subject.dealId || null, subject.propertyId || null, subject.leadId || null, input.loanType, input.employmentType,
          input.monthlyIncome, input.existingEmi || 0, input.propertyValue, input.loanAmountRequested, input.tenureYears, input.city, input.isNri, eligibility ? JSON.stringify(eligibility) : null, source]
      )
    ).rows[0];
    const linked = await autoLink('loan', a.id, subject, client);
    await event('loan', a.id, 'started', `${LOAN_LABEL[input.loanType]} enquiry started. ${linked} document${linked === 1 ? '' : 's'} on file linked automatically.`, actor, true, client);
    await client.query('COMMIT');
    await auditService.log({ actor, action: 'finance.loan_started', entityType: 'loan_application', entityId: a.id, after: { number: a.application_number, loanType: input.loanType, source }, ...meta });
    return a;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Step 1-4 of the flow for the client: details in, eligibility and lender options out.
async function startLoan(user, data, meta = {}) {
  const input = cleanLoanInput(data);
  let subject;
  if (isStaff(user)) subject = await resolveSubject(data);
  else {
    const customerId = await customerOf(user);
    if (!input.monthlyIncome || !input.propertyValue) throw badRequest('Enter your monthly income and the property value');
    let dealId = null;
    let propertyId = data.propertyId || null;
    if (data.dealId) {
      const d = await ownDeal(data.dealId, customerId);
      dealId = d.id;
      propertyId = propertyId || d.property_id;
    }
    subject = { customerId, requestedBy: user.id, dealId, propertyId, leadId: null };
  }
  if (subject.propertyId && !input.city) input.city = (await pool.query('SELECT city FROM properties WHERE id = $1', [subject.propertyId])).rows[0]?.city || null;
  const a = await insertLoan(user, subject, input, isStaff(user) ? 'staff' : 'customer', meta);
  return getLoan(user, a.id);
}

// A home-loan enquiry from the website starts an application with what the visitor gave.
async function onLoanEnquiry(lead) {
  if (lead.enquiry_type !== 'home_loan') return null;
  const d = lead.enquiry_details || {};
  const requestedBy = (await pool.query('SELECT user_id FROM customers WHERE id = $1', [lead.customer_id])).rows[0]?.user_id || null;
  // The website form's own wording for employment.
  const emp = String(d.employment || '').toLowerCase();
  const employmentType = /salaried/.test(emp) ? 'salaried' : /self/.test(emp) ? 'self_employed' : /business/.test(emp) ? 'business' : /other/.test(emp) ? 'other' : null;
  const input = cleanLoanInput({ loanType: /nri/.test(emp) ? 'nri_mortgage' : 'home_loan', monthlyIncome: d.monthlyIncome, propertyValue: d.propertyValue, loanAmountRequested: d.loanAmount, city: d.city, employmentType, isNri: /nri/.test(emp) });
  const a = await insertLoan(null, { customerId: lead.customer_id, requestedBy, propertyId: lead.property_id, leadId: lead.id }, input, 'enquiry');
  await notify(await deskIds('ld', { leadId: lead.id }), { type: 'loan_application', title: `Home loan enquiry ${a.application_number}`, message: 'A website home-loan enquiry opened a loan application. Collect the details and refer it to a lender.' });
  return a;
}

async function loanRow(user, id) {
  const a = (await pool.query(`${LOAN_SELECT} WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw notFound('Loan application not found');
  if (user.role === 'loan_officer') {
    if (!(await isOfficerOf(user, a.officer_id))) throw notFound('Loan application not found');
    return a;
  }
  if (!isStaff(user) && a.requested_by !== user.id) {
    const own = (await pool.query('SELECT 1 FROM customers WHERE id = $1 AND user_id = $2', [a.customer_id, user.id])).rows.length;
    if (!own) throw notFound('Loan application not found');
  }
  return a;
}

async function getLoan(user, id) {
  const a = await loanRow(user, id);
  const staff = isStaff(user);
  const s = await settings();
  const input = { loanType: a.loan_type, monthlyIncome: num(a.monthly_income), existingEmi: num(a.existing_emi), propertyValue: num(a.property_value), loanAmountRequested: num(a.loan_amount_requested), tenureYears: a.tenure_years, city: a.city, isNri: a.is_nri };
  const [docs, tl, options] = await Promise.all([linkedDocs('loan', id), timeline('loan', id, staff), ['started', 'submitted'].includes(a.status) ? lenderOptions(input, s) : []]);
  return { ...loanView(a, { staff }), lenderOptions: options, linkedDocuments: docs.map(docView), timeline: tl, loanTypes: LOAN_TYPES.map((k) => ({ value: k, label: LOAN_LABEL[k] })), disclaimer: s.loanDisclaimer };
}

async function myLoans(user) {
  const r = await pool.query(`${LOAN_SELECT} WHERE a.requested_by = $1 OR a.customer_id IN (SELECT id FROM customers WHERE user_id = $1) ORDER BY a.created_at DESC`, [user.id]);
  const s = await settings();
  return { applications: r.rows.map((a) => loanView(a)), loanTypes: LOAN_TYPES.map((k) => ({ value: k, label: LOAN_LABEL[k] })), disclaimer: s.loanDisclaimer };
}

async function listLoans({ status = null, institutionId = null, q = null } = {}) {
  const r = await pool.query(
    `${LOAN_SELECT} WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.institution_id = $2)
       AND ($3::text IS NULL OR a.application_number ILIKE $3 OR cu.full_name ILIKE $3 OR pr.title ILIKE $3 OR i.name ILIKE $3)
     ORDER BY (a.status = 'submitted') DESC, a.created_at DESC LIMIT 500`,
    [status, institutionId, q ? `%${q}%` : null]
  );
  const stats = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'started')::int AS started, COUNT(*) FILTER (WHERE status = 'submitted')::int AS to_refer, COUNT(*) FILTER (WHERE status = 'referred')::int AS with_lender,
            COUNT(*) FILTER (WHERE status = 'sanctioned')::int AS sanctioned, COUNT(*) FILTER (WHERE status = 'disbursed')::int AS disbursed FROM loan_applications`
  )).rows[0];
  return { applications: r.rows.map((a) => loanView(a, { staff: true })), stats, loanTypes: LOAN_TYPES.map((k) => ({ value: k, label: LOAN_LABEL[k] })) };
}

// The client (or staff for them) updates details while nothing has gone to a lender.
async function updateLoan(user, id, data, meta = {}) {
  const a = await loanRow(user, id);
  if (!['started', 'submitted'].includes(a.status)) throw badRequest('This application is already with the lender');
  const input = cleanLoanInput({ loanType: a.loan_type, employmentType: a.employment_type, monthlyIncome: a.monthly_income, existingEmi: a.existing_emi, propertyValue: a.property_value, loanAmountRequested: a.loan_amount_requested, tenureYears: a.tenure_years, city: a.city, isNri: a.is_nri, ...data });
  const s = await settings();
  const eligibility = input.monthlyIncome || input.propertyValue ? assess(input, { foir: s.elig.foir_percent, rate: s.elig.rate_percent, tenure: s.elig.tenure_years, ltv: ltvFor(input.propertyValue || 0, s.elig.ltv_slabs) }) : null;
  await pool.query(
    `UPDATE loan_applications SET loan_type = $2, employment_type = $3, monthly_income = $4, existing_emi = $5, property_value = $6, loan_amount_requested = $7, tenure_years = $8, city = $9, is_nri = $10, eligibility = $11 WHERE id = $1`,
    [id, input.loanType, input.employmentType, input.monthlyIncome, input.existingEmi || 0, input.propertyValue, input.loanAmountRequested, input.tenureYears, input.city, input.isNri, eligibility ? JSON.stringify(eligibility) : null]
  );
  await autoLink('loan', id, { customerId: a.customer_id, dealId: a.deal_id, propertyId: a.property_id });
  await auditService.log({ actor: user, action: 'finance.loan_updated', entityType: 'loan_application', entityId: id, ...meta });
  return getLoan(user, id);
}

async function assertLender(institutionId, loanType) {
  const i = (await pool.query('SELECT * FROM partner_institutions WHERE id = $1', [institutionId])).rows[0];
  if (!i || !LENDER_KINDS.includes(i.kind)) throw notFound('Lender not found');
  if (i.status !== 'empanelled') throw badRequest('Only an empanelled lender can be chosen');
  if (!i.loan_products.includes(loanType)) throw badRequest(`${i.name} does not offer this kind of loan`);
  return i;
}

// "Application submitted": the client picks a lender from the options and submits.
async function submitLoan(user, id, { institutionId }, meta = {}) {
  const a = await loanRow(user, id);
  if (a.status !== 'started') throw badRequest('This application has already been submitted');
  if (!a.monthly_income || !a.property_value) throw badRequest('Add the monthly income and the property value before submitting');
  const inst = institutionId ? await assertLender(institutionId, a.loan_type) : null;
  await pool.query(`UPDATE loan_applications SET status = 'submitted', submitted_at = now(), institution_id = $2 WHERE id = $1`, [id, inst?.id || null]);
  await event('loan', id, 'submitted', inst ? `Application submitted. Preferred lender: ${inst.name}.` : 'Application submitted. A lender will be suggested by the loan desk.', user);
  await auditService.log({ actor: user, action: 'finance.loan_submitted', entityType: 'loan_application', entityId: id, after: { institutionId: inst?.id || null }, ...meta });
  await notify(await deskIds('ld', { dealId: a.deal_id, leadId: a.lead_id }), { type: 'loan_application', title: `Loan application ${a.application_number} submitted`, message: `${LOAN_LABEL[a.loan_type]}${inst ? ` - preferred lender ${inst.name}` : ''}. Refer it to the lender's loan officer.` });
  return getLoan(user, id);
}

async function syncDealLoan(a, status, lenderName, actor) {
  if (!a.deal_id) return;
  const map = { referred: 'referred', sanctioned: 'sanctioned', disbursed: 'disbursed' };
  if (!map[status]) return;
  await pool.query('UPDATE deals SET loan_referral_status = $2, loan_lender = COALESCE($3, loan_lender) WHERE id = $1', [a.deal_id, map[status], lenderName ? String(lenderName).slice(0, 150) : null]);
  // The deal moves on by itself once the loan referral is recorded.
  await require('./orchestration.service').evaluate(a.deal_id, { actor }).catch((err) => console.error('[finance] deal evaluate failed:', err.message));
}

// Hand-off: the loan desk refers the application to the lender's verified Loan Officer.
async function referLoan(user, id, { institutionId, officerId, note }, meta = {}) {
  const a = await loanRow(user, id);
  if (!['started', 'submitted', 'referred'].includes(a.status)) throw badRequest('This application can no longer be referred');
  const inst = await assertLender(institutionId || a.institution_id, a.loan_type);
  const officer = (await pool.query(`SELECT * FROM partner_officers WHERE id = $1 AND institution_id = $2`, [officerId, inst.id])).rows[0];
  if (!officer) throw badRequest("Choose one of this lender's loan officers");
  if (officer.status !== 'verified' || !officer.code) throw badRequest('Only a verified loan officer with an LO code can receive a referral');
  await pool.query(`UPDATE loan_applications SET status = 'referred', institution_id = $2, officer_id = $3, referred_at = now(), referred_by = $4, submitted_at = COALESCE(submitted_at, now()) WHERE id = $1`, [id, inst.id, officer.id, user.id]);
  await event('loan', id, 'referred', `Referred to ${inst.name} - loan officer ${officer.full_name} (${officer.code}).`, user);
  if (note) await event('loan', id, 'note', String(note).trim(), user, false);
  await auditService.log({ actor: user, action: 'finance.loan_referred', entityType: 'loan_application', entityId: id, after: { institutionId: inst.id, officerId: officer.id }, ...meta });
  await syncDealLoan(a, 'referred', inst.name, user);
  await notify([a.requested_by], { type: 'loan_application', title: `${a.application_number}: referred to ${inst.name}`, message: `Loan officer ${officer.full_name} (${officer.code}) will take it forward. Your representative coordinates with them.` });
  return getLoan(user, id);
}

// The pack the desk passes to the loan officer: the numbers, the property and time-limited document links.
async function loanHandoff(user, id, meta = {}) {
  const a = await loanRow(user, id);
  if (!a.officer_id) throw badRequest('Refer the application to a loan officer first');
  const officer = (await pool.query('SELECT * FROM partner_officers WHERE id = $1', [a.officer_id])).rows[0];
  const property = a.property_id ? (await pool.query('SELECT title, city, locality, property_type FROM properties WHERE id = $1', [a.property_id])).rows[0] : null;
  const documents = [];
  for (const d of await linkedDocs('loan', id)) documents.push({ id: d.id, type: d.document_type, fileName: d.file_name, url: await getReadUrl(d.document_url) });
  await event('loan', id, 'handoff_pack', `Hand-off pack with ${documents.length} document${documents.length === 1 ? '' : 's'} prepared for the loan officer.`, user, false);
  await auditService.log({ actor: user, action: 'finance.loan_handoff', entityType: 'loan_application', entityId: id, after: { documents: documents.length }, ...meta });
  const s = await settings();
  return {
    applicationNumber: a.application_number, loanType: LOAN_LABEL[a.loan_type], lender: a.institution_name,
    officer: { name: officer.full_name, code: officer.code, email: officer.email, mobile: officer.mobile },
    figures: { monthlyIncome: num(a.monthly_income), existingEmi: num(a.existing_emi), propertyValue: num(a.property_value), loanAmountRequested: num(a.loan_amount_requested), tenureYears: a.tenure_years, employmentType: a.employment_type, isNri: a.is_nri },
    eligibility: a.eligibility, property, documents, disclaimer: s.loanDisclaimer,
    note: "The client's contact reaches the loan officer through the A R Buildwel representative. No commission is paid to or received from the officer.",
  };
}

// Lender approval status and the disbursement schedule.
async function updateLoanStatus(user, id, data, meta = {}) {
  const a = await loanRow(user, id);
  const { status = null, note = null } = data;
  const flow = { started: ['withdrawn'], submitted: ['withdrawn', 'rejected'], referred: ['sanctioned', 'rejected', 'withdrawn'], sanctioned: ['disbursed', 'withdrawn'], disbursed: [], rejected: [], withdrawn: [] };
  const set = [];
  const params = [id];
  const push = (sql, v) => { params.push(v); set.push(sql.replace('?', `$${params.length}`)); };
  if (status && status !== a.status) {
    if (!flow[a.status].includes(status)) throw badRequest(`An application that is "${a.status}" cannot become "${status}"`);
    if (['rejected', 'withdrawn'].includes(status) && (!note || String(note).trim().length < 3)) throw badRequest('Give the reason');
    if (status === 'sanctioned') {
      const amount = num(data.sanctionedAmount);
      if (!amount || amount <= 0) throw badRequest('Enter the sanctioned amount');
      push('sanctioned_amount = ?', amount);
      push('sanctioned_rate = ?', num(data.sanctionedRate));
      push('sanctioned_on = ?', data.sanctionedOn || new Date().toISOString().slice(0, 10));
    }
    push('status = ?', status);
  }
  if (data.lenderReference !== undefined) push('lender_reference = ?', data.lenderReference ? String(data.lenderReference).slice(0, 80) : null);
  let schedule = null;
  if (data.disbursementSchedule !== undefined) {
    if (!['sanctioned', 'disbursed'].includes(status || a.status)) throw badRequest('A disbursement schedule follows the sanction');
    if (!Array.isArray(data.disbursementSchedule)) throw badRequest('disbursementSchedule must be a list');
    schedule = data.disbursementSchedule.slice(0, 24).map((x) => {
      const amount = num(x.amount);
      if (!amount || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.dueOn || ''))) throw badRequest('Each tranche needs a date and an amount');
      return { dueOn: x.dueOn, amount, note: x.note ? String(x.note).slice(0, 150) : null, paidOn: /^\d{4}-\d{2}-\d{2}$/.test(String(x.paidOn || '')) ? x.paidOn : null };
    });
    const total = schedule.reduce((t, x) => t + x.amount, 0);
    const cap = num(data.sanctionedAmount) || num(a.sanctioned_amount);
    if (cap && total > cap + 1) throw badRequest('The tranches add up to more than the sanctioned amount');
    push('disbursement_schedule = ?', JSON.stringify(schedule));
  }
  if (!set.length && !note) throw badRequest('Nothing to update');
  if (set.length) await pool.query(`UPDATE loan_applications SET ${set.join(', ')} WHERE id = $1`, params);
  const next = status || a.status;
  const text = {
    sanctioned: `Sanctioned: ₹${Number(num(data.sanctionedAmount) || 0).toLocaleString('en-IN')}${num(data.sanctionedRate) ? ` at ${num(data.sanctionedRate)}%` : ''}.`,
    disbursed: 'Loan disbursed by the lender.', rejected: `Not approved by the lender: ${note}`, withdrawn: `Withdrawn: ${note}`,
  }[status && status !== a.status ? status : ''];
  if (text) await event('loan', id, next, text, user);
  else if (schedule) await event('loan', id, 'disbursement_schedule', `Disbursement schedule updated: ${schedule.length} tranche${schedule.length === 1 ? '' : 's'}.`, user);
  if (note && !['rejected', 'withdrawn'].includes(status)) await event('loan', id, 'note', String(note).trim(), user, data.clientVisible !== false);
  await auditService.log({ actor: user, action: 'finance.loan_status', entityType: 'loan_application', entityId: id, before: { status: a.status }, after: { status: next }, ...meta });
  if (status && status !== a.status) {
    await syncDealLoan(a, status, a.institution_name, user);
    await notify([a.requested_by], { type: 'loan_application', title: `${a.application_number}: ${status}`, message: text || 'Status updated.' });
  }
  return getLoan(user, id);
}

// The client withdraws while it has not been sanctioned.
async function withdrawLoan(user, id, reason, meta = {}) {
  const a = await loanRow(user, id);
  if (!['started', 'submitted', 'referred'].includes(a.status)) throw badRequest('This application can no longer be withdrawn here - speak to your representative');
  await pool.query(`UPDATE loan_applications SET status = 'withdrawn' WHERE id = $1`, [id]);
  await event('loan', id, 'withdrawn', reason ? String(reason).trim().slice(0, 300) : 'Withdrawn by the client', user);
  await auditService.log({ actor: user, action: 'finance.loan_withdrawn', entityType: 'loan_application', entityId: id, ...meta });
  return getLoan(user, id);
}

// -------------------------------------------------------------- insurance

const INS_SELECT = `SELECT q.*, i.name AS institution_name, o.full_name AS officer_name, o.code AS officer_code, cu.full_name AS customer_name, pr.title AS property_title,
    (SELECT COUNT(*) FROM finance_case_documents d WHERE d.subject_type = 'insurance' AND d.subject_id = q.id)::int AS documents
  FROM insurance_requests q LEFT JOIN partner_institutions i ON i.id = q.institution_id LEFT JOIN partner_officers o ON o.id = q.officer_id
  LEFT JOIN customers cu ON cu.id = q.customer_id LEFT JOIN properties pr ON pr.id = q.property_id`;

const insView = (q, covers, { staff = false } = {}) => ({
  id: q.id, requestNumber: q.request_number, coverType: q.cover_type, coverLabel: covers[q.cover_type] || q.cover_type, status: q.status, propertyDetails: q.property_details, sumInsured: num(q.sum_insured),
  dealId: q.deal_id, propertyId: q.property_id, propertyTitle: q.property_title, documents: q.documents,
  insurer: q.institution_id ? { institutionId: q.institution_id, name: q.institution_name, officer: q.officer_id ? { name: q.officer_name, code: q.officer_code } : null } : null,
  policy: q.policy_number ? { number: q.policy_number, start: q.policy_start, end: q.policy_end, premiumAmount: num(q.premium_amount) } : null,
  selectedAt: q.selected_at, referredAt: q.referred_at, confirmedAt: q.confirmed_at, createdAt: q.created_at,
  ...(staff ? { customerId: q.customer_id, customerName: q.customer_name, leadId: q.lead_id, institutionId: q.institution_id, officerId: q.officer_id, loanApplicationId: q.loan_application_id, source: q.source } : {}),
});

// "Property details pre-filled": from the listing and the deal.
async function prefill({ propertyId = null, dealId = null }) {
  const p = propertyId ? (await pool.query('SELECT id, title, property_type, listing_category, city, locality, address, area_sqft, price_value FROM properties WHERE id = $1', [propertyId])).rows[0] : null;
  const d = dealId ? (await pool.query('SELECT deal_value, loan_lender FROM deals WHERE id = $1', [dealId])).rows[0] : null;
  return {
    title: p?.title || null, propertyType: p?.property_type || null, city: p?.city || null, locality: p?.locality || null, address: p?.address || null, areaSqft: num(p?.area_sqft),
    propertyValue: num(d?.deal_value) || num(p?.price_value), lender: d?.loan_lender || null,
    suggestedCover: p?.listing_category === 'commercial' || /office|shop|commercial|warehouse/i.test(p?.property_type || '') ? 'commercial_property' : 'home_package',
  };
}

// "Coverage options": the empanelled insurers offering this cover in this place.
async function coverageOptions(coverType, city) {
  const r = await pool.query(
    `SELECT id, name, insurance_products FROM partner_institutions WHERE kind = 'insurer' AND status = 'empanelled' AND $1 = ANY(insurance_products)
       AND (cardinality(cities) = 0 OR $2::text IS NULL OR EXISTS (SELECT 1 FROM unnest(cities) x WHERE lower(x) = lower($2))) ORDER BY name`,
    [coverType, city || null]
  );
  return r.rows.map((i) => ({ institutionId: i.id, name: i.name, covers: i.insurance_products }));
}

// What the client sees before asking: their property pre-filled and the options for each cover.
async function insurancePreview(user, { dealId = null, propertyId = null } = {}) {
  const s = await settings();
  let pid = propertyId;
  let did = null;
  if (!isStaff(user)) {
    const customerId = await customerOf(user);
    if (dealId) {
      const d = await ownDeal(dealId, customerId);
      did = d.id;
      pid = pid || d.property_id;
    }
  } else if (dealId) {
    did = dealId;
    pid = pid || (await pool.query('SELECT property_id FROM deals WHERE id = $1', [dealId])).rows[0]?.property_id || null;
  }
  const details = await prefill({ propertyId: pid, dealId: did });
  const options = {};
  for (const c of COVER_TYPES) options[c] = await coverageOptions(c, details.city);
  return { propertyDetails: details, coverTypes: COVER_TYPES.map((k) => ({ value: k, label: s.covers[k], insurers: options[k] })), disclaimer: s.insDisclaimer };
}

async function insertInsurance(actor, subject, { coverType, sumInsured = null, institutionId = null, loanApplicationId = null }, source, meta = {}) {
  if (!COVER_TYPES.includes(coverType)) throw badRequest(`coverType must be one of: ${COVER_TYPES.join(', ')}`);
  const details = await prefill({ propertyId: subject.propertyId, dealId: subject.dealId });
  const sum = num(sumInsured) || details.propertyValue || null;
  if (sum !== null && sum <= 0) throw badRequest('The sum insured must be more than zero');
  let inst = null;
  if (institutionId) inst = await assertInsurer(institutionId, coverType);
  const s = await settings();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = (await client.query(`SELECT nextval('insurance_request_seq') AS n`)).rows[0].n;
    const q = (
      await client.query(
        `INSERT INTO insurance_requests (request_number, requested_by, customer_id, deal_id, property_id, lead_id, loan_application_id, cover_type, property_details, sum_insured, status, institution_id, selected_at, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [`IN-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`, subject.requestedBy || null, subject.customerId, subject.dealId || null, subject.propertyId || null, subject.leadId || null, loanApplicationId, coverType,
          JSON.stringify(details), sum, inst ? 'option_selected' : 'requested', inst?.id || null, inst ? new Date() : null, source]
      )
    ).rows[0];
    await autoLink('insurance', q.id, subject, client);
    await event('insurance', q.id, 'requested', `${s.covers[coverType]} requested${details.title ? ` for ${details.title}` : ''}. Property details filled in from the listing.`, actor, true, client);
    if (inst) await event('insurance', q.id, 'option_selected', `Insurer chosen: ${inst.name}.`, actor, true, client);
    await client.query('COMMIT');
    await auditService.log({ actor, action: 'finance.insurance_requested', entityType: 'insurance_request', entityId: q.id, after: { number: q.request_number, coverType, source, institutionId: inst?.id || null }, ...meta });
    await notify(await deskIds('id', { dealId: subject.dealId, leadId: subject.leadId }), { type: 'insurance_request', title: `Insurance request ${q.request_number}`, message: `${s.covers[coverType]}${inst ? ` - ${inst.name}` : ''}. Refer it to the insurer's officer.` });
    return q;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function assertInsurer(institutionId, coverType) {
  const i = (await pool.query(`SELECT * FROM partner_institutions WHERE id = $1 AND kind = 'insurer'`, [institutionId])).rows[0];
  if (!i) throw notFound('Insurer not found');
  if (i.status !== 'empanelled') throw badRequest('Only an empanelled insurer can be chosen');
  if (!i.insurance_products.includes(coverType)) throw badRequest(`${i.name} does not offer this cover`);
  return i;
}

async function requestInsurance(user, data, meta = {}) {
  let subject;
  if (isStaff(user)) subject = await resolveSubject(data);
  else {
    const customerId = await customerOf(user);
    let dealId = null;
    let propertyId = data.propertyId || null;
    if (data.dealId) {
      const d = await ownDeal(data.dealId, customerId);
      dealId = d.id;
      propertyId = propertyId || d.property_id;
    }
    if (!propertyId) throw badRequest('Choose the deal or property to insure');
    subject = { customerId, requestedBy: user.id, dealId, propertyId, leadId: null };
  }
  if (data.loanApplicationId) await loanRow(user, data.loanApplicationId);
  const q = await insertInsurance(user, subject, data, isStaff(user) ? 'staff' : 'customer', meta);
  return getInsurance(user, q.id);
}

async function onInsuranceEnquiry(lead) {
  if (lead.enquiry_type !== 'insurance') return null;
  const requestedBy = (await pool.query('SELECT user_id FROM customers WHERE id = $1', [lead.customer_id])).rows[0]?.user_id || null;
  const asked = String(lead.enquiry_details?.coverType || '').toLowerCase();
  const cover = COVER_TYPES.includes(asked) ? asked : /loan protection/.test(asked) ? 'loan_protection' : 'home_package';
  return insertInsurance(null, { customerId: lead.customer_id, requestedBy, propertyId: lead.property_id, leadId: lead.id }, { coverType: cover, sumInsured: lead.enquiry_details?.propertyValue }, 'enquiry');
}

async function insRow(user, id) {
  const q = (await pool.query(`${INS_SELECT} WHERE q.id = $1`, [id])).rows[0];
  if (!q) throw notFound('Insurance request not found');
  if (user.role === 'insurance_officer') {
    if (!(await isOfficerOf(user, q.officer_id))) throw notFound('Insurance request not found');
    return q;
  }
  if (!isStaff(user) && q.requested_by !== user.id) {
    const own = (await pool.query('SELECT 1 FROM customers WHERE id = $1 AND user_id = $2', [q.customer_id, user.id])).rows.length;
    if (!own) throw notFound('Insurance request not found');
  }
  return q;
}

async function getInsurance(user, id) {
  const q = await insRow(user, id);
  const staff = isStaff(user);
  const s = await settings();
  const [docs, tl, options] = await Promise.all([linkedDocs('insurance', id), timeline('insurance', id, staff), ['requested', 'option_selected'].includes(q.status) ? coverageOptions(q.cover_type, q.property_details?.city) : []]);
  return { ...insView(q, s.covers, { staff }), coverageOptions: options, linkedDocuments: docs.map(docView), timeline: tl, disclaimer: s.insDisclaimer };
}

async function myInsurance(user) {
  const r = await pool.query(`${INS_SELECT} WHERE q.requested_by = $1 OR q.customer_id IN (SELECT id FROM customers WHERE user_id = $1) ORDER BY q.created_at DESC`, [user.id]);
  const s = await settings();
  return { requests: r.rows.map((q) => insView(q, s.covers)), coverTypes: COVER_TYPES.map((k) => ({ value: k, label: s.covers[k] })), disclaimer: s.insDisclaimer };
}

async function listInsurance({ status = null, institutionId = null, q = null } = {}) {
  const s = await settings();
  const r = await pool.query(
    `${INS_SELECT} WHERE ($1::text IS NULL OR q.status = $1) AND ($2::uuid IS NULL OR q.institution_id = $2)
       AND ($3::text IS NULL OR q.request_number ILIKE $3 OR cu.full_name ILIKE $3 OR pr.title ILIKE $3 OR i.name ILIKE $3)
     ORDER BY (q.status IN ('requested', 'option_selected')) DESC, q.created_at DESC LIMIT 500`,
    [status, institutionId, q ? `%${q}%` : null]
  );
  const stats = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('requested', 'option_selected'))::int AS to_refer, COUNT(*) FILTER (WHERE status = 'referred')::int AS with_insurer,
            COUNT(*) FILTER (WHERE status = 'issued')::int AS issued, COUNT(*) FILTER (WHERE status = 'issued' AND policy_end BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS renewing_soon FROM insurance_requests`
  )).rows[0];
  return { requests: r.rows.map((x) => insView(x, s.covers, { staff: true })), stats, coverTypes: COVER_TYPES.map((k) => ({ value: k, label: s.covers[k] })) };
}

// "Policy selected": the client picks one of the coverage options.
async function selectInsurer(user, id, { institutionId }, meta = {}) {
  const q = await insRow(user, id);
  if (!['requested', 'option_selected'].includes(q.status)) throw badRequest('This request is already with the insurer');
  const inst = await assertInsurer(institutionId, q.cover_type);
  await pool.query(`UPDATE insurance_requests SET institution_id = $2, status = 'option_selected', selected_at = now() WHERE id = $1`, [id, inst.id]);
  await event('insurance', id, 'option_selected', `Insurer chosen: ${inst.name}.`, user);
  await auditService.log({ actor: user, action: 'finance.insurance_selected', entityType: 'insurance_request', entityId: id, after: { institutionId: inst.id }, ...meta });
  if (!isStaff(user)) await notify(await deskIds('id', { dealId: q.deal_id, leadId: q.lead_id }), { type: 'insurance_request', title: `${q.request_number}: insurer chosen`, message: `${inst.name}. Refer it to their insurance officer.` });
  return getInsurance(user, id);
}

async function syncDealInsurance(q, status, insurerName, actor) {
  if (!q.deal_id) return;
  const map = { referred: 'referred', issued: 'issued' };
  if (!map[status]) return;
  await pool.query('UPDATE deals SET insurance_referral_status = $2, insurance_provider = COALESCE($3, insurance_provider) WHERE id = $1', [q.deal_id, map[status], insurerName ? String(insurerName).slice(0, 150) : null]);
  await require('./orchestration.service').evaluate(q.deal_id, { actor }).catch((err) => console.error('[finance] deal evaluate failed:', err.message));
}

// Hand-off to the insurer's licensed officer.
async function referInsurance(user, id, { institutionId, officerId, note }, meta = {}) {
  const q = await insRow(user, id);
  if (!['requested', 'option_selected', 'referred'].includes(q.status)) throw badRequest('This request can no longer be referred');
  const inst = await assertInsurer(institutionId || q.institution_id, q.cover_type);
  const officer = (await pool.query(`SELECT * FROM partner_officers WHERE id = $1 AND institution_id = $2`, [officerId, inst.id])).rows[0];
  if (!officer) throw badRequest("Choose one of this insurer's officers");
  if (officer.status !== 'verified' || !officer.code || !officer.licence_number) throw badRequest('Only a verified, IRDAI-licensed insurance officer with an IO code can receive a referral');
  await pool.query(`UPDATE insurance_requests SET status = 'referred', institution_id = $2, officer_id = $3, referred_at = now(), referred_by = $4, selected_at = COALESCE(selected_at, now()) WHERE id = $1`, [id, inst.id, officer.id, user.id]);
  await event('insurance', id, 'referred', `Referred to ${inst.name} - insurance officer ${officer.full_name} (${officer.code}).`, user);
  if (note) await event('insurance', id, 'note', String(note).trim(), user, false);
  await auditService.log({ actor: user, action: 'finance.insurance_referred', entityType: 'insurance_request', entityId: id, after: { institutionId: inst.id, officerId: officer.id }, ...meta });
  await syncDealInsurance(q, 'referred', inst.name, user);
  await notify([q.requested_by], { type: 'insurance_request', title: `${q.request_number}: referred to ${inst.name}`, message: `Insurance officer ${officer.full_name} (${officer.code}) will share the quote and terms. The policy and premium are between you and the insurer.` });
  return getInsurance(user, id);
}

async function insuranceHandoff(user, id, meta = {}) {
  const q = await insRow(user, id);
  if (!q.officer_id) throw badRequest('Refer the request to an insurance officer first');
  const officer = (await pool.query('SELECT * FROM partner_officers WHERE id = $1', [q.officer_id])).rows[0];
  const documents = [];
  for (const d of await linkedDocs('insurance', id)) documents.push({ id: d.id, type: d.document_type, fileName: d.file_name, url: await getReadUrl(d.document_url) });
  await event('insurance', id, 'handoff_pack', `Hand-off pack with ${documents.length} document${documents.length === 1 ? '' : 's'} prepared for the insurance officer.`, user, false);
  await auditService.log({ actor: user, action: 'finance.insurance_handoff', entityType: 'insurance_request', entityId: id, after: { documents: documents.length }, ...meta });
  const s = await settings();
  return {
    requestNumber: q.request_number, cover: s.covers[q.cover_type], insurer: q.institution_name, sumInsured: num(q.sum_insured),
    officer: { name: officer.full_name, code: officer.code, licenceNumber: officer.licence_number, email: officer.email, mobile: officer.mobile },
    propertyDetails: q.property_details, documents, disclaimer: s.insDisclaimer,
    note: "The client's contact reaches the insurance officer through the A R Buildwel representative. The platform takes no premium and no commission.",
  };
}

// "Confirmation": the policy the insurer issued is recorded; or the request is declined / cancelled.
async function updateInsuranceStatus(user, id, data, meta = {}) {
  const q = await insRow(user, id);
  const { status = null, note = null } = data;
  const flow = { requested: ['cancelled'], option_selected: ['cancelled'], referred: ['issued', 'declined', 'cancelled'], issued: [], declined: [], cancelled: [] };
  if (status && status !== q.status) {
    if (!flow[q.status].includes(status)) throw badRequest(`A request that is "${q.status.replace('_', ' ')}" cannot become "${status}"`);
    if (['declined', 'cancelled'].includes(status) && (!note || String(note).trim().length < 3)) throw badRequest('Give the reason');
    if (status === 'issued') {
      if (!data.policyNumber || String(data.policyNumber).trim().length < 3) throw badRequest('Enter the policy number');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.policyStart || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.policyEnd || ''))) throw badRequest('Enter the policy start and end dates');
      if (data.policyEnd <= data.policyStart) throw badRequest('The policy must end after it starts');
      await pool.query(`UPDATE insurance_requests SET status = 'issued', policy_number = $2, policy_start = $3, policy_end = $4, premium_amount = $5, confirmed_at = now() WHERE id = $1`, [id, String(data.policyNumber).trim().slice(0, 80), data.policyStart, data.policyEnd, num(data.premiumAmount)]);
      await event('insurance', id, 'issued', `Policy ${String(data.policyNumber).trim()} confirmed, valid ${data.policyStart} to ${data.policyEnd}.`, user);
    } else {
      await pool.query('UPDATE insurance_requests SET status = $2 WHERE id = $1', [id, status]);
      await event('insurance', id, status, String(note).trim(), user);
    }
    await syncDealInsurance(q, status, q.institution_name, user);
    await notify([q.requested_by], { type: 'insurance_request', title: `${q.request_number}: ${status}`, message: status === 'issued' ? `Policy ${String(data.policyNumber).trim()} is on record.` : String(note).trim() });
  } else if (note) await event('insurance', id, 'note', String(note).trim(), user, data.clientVisible !== false);
  else throw badRequest('Nothing to update');
  await auditService.log({ actor: user, action: 'finance.insurance_status', entityType: 'insurance_request', entityId: id, before: { status: q.status }, after: { status: status || q.status }, ...meta });
  return getInsurance(user, id);
}

async function cancelInsurance(user, id, reason, meta = {}) {
  const q = await insRow(user, id);
  if (!['requested', 'option_selected'].includes(q.status)) throw badRequest('This request is already with the insurer - speak to your representative');
  await pool.query(`UPDATE insurance_requests SET status = 'cancelled' WHERE id = $1`, [id]);
  await event('insurance', id, 'cancelled', reason ? String(reason).trim().slice(0, 300) : 'Cancelled by the client', user);
  await auditService.log({ actor: user, action: 'finance.insurance_cancelled', entityType: 'insurance_request', entityId: id, ...meta });
  return getInsurance(user, id);
}

// Staff add a document to a case (uploaded under Documents).
async function linkDocument(user, type, id, documentId, meta = {}) {
  if (type === 'loan') await loanRow(user, id);
  else await insRow(user, id);
  if (!(await pool.query('SELECT 1 FROM documents WHERE id = $1', [documentId])).rows.length) throw notFound('Document not found');
  await pool.query(`INSERT INTO finance_case_documents (subject_type, subject_id, document_id, auto_linked) VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING`, [type, id, documentId]);
  await auditService.log({ actor: user, action: 'finance.document_linked', entityType: type === 'loan' ? 'loan_application' : 'insurance_request', entityId: id, after: { documentId }, ...meta });
  return type === 'loan' ? getLoan(user, id) : getInsurance(user, id);
}

// Loan and insurance on one deal - for the deal's referral panel.
async function forDeal(dealId) {
  const s = await settings();
  const [loans, ins] = await Promise.all([pool.query(`${LOAN_SELECT} WHERE a.deal_id = $1 ORDER BY a.created_at DESC`, [dealId]), pool.query(`${INS_SELECT} WHERE q.deal_id = $1 ORDER BY q.created_at DESC`, [dealId])]);
  return { loans: loans.rows.map((a) => loanView(a, { staff: true })), insurance: ins.rows.map((q) => insView(q, s.covers, { staff: true })) };
}

// Referral volume by partner and city (last 90 days) - feeds the advertiser suggestions.
async function referralVolume() {
  const r = await pool.query(
    `SELECT i.id, i.name, i.kind, COALESCE(x.city, 'Unspecified') AS city, COUNT(*)::int AS referrals FROM (
       SELECT institution_id, city, referred_at FROM loan_applications WHERE referred_at IS NOT NULL
       UNION ALL SELECT institution_id, property_details->>'city', referred_at FROM insurance_requests WHERE referred_at IS NOT NULL
     ) x JOIN partner_institutions i ON i.id = x.institution_id
     WHERE x.referred_at > now() - interval '90 days' GROUP BY 1, 2, 3, 4 HAVING COUNT(*) >= 2 ORDER BY referrals DESC LIMIT 40`
  );
  return r.rows;
}

module.exports = {
  LOAN_TYPES, LOAN_LABEL, COVER_TYPES, settings, assess, principalFor,
  listInstitutions, saveInstitution, decideInstitution, listOfficers, saveOfficer, decideOfficer,
  checkEligibility, startLoan, onLoanEnquiry, getLoan, myLoans, listLoans, updateLoan, submitLoan, referLoan, loanHandoff, updateLoanStatus, withdrawLoan,
  insurancePreview, requestInsurance, onInsuranceEnquiry, getInsurance, myInsurance, listInsurance, selectInsurer, referInsurance, insuranceHandoff, updateInsuranceStatus, cancelInsurance,
  linkDocument, forDeal, referralVolume,
};
