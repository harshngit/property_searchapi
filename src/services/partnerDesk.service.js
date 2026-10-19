const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const auditService = require('./audit.service');
const notificationService = require('./notification.service');
const legal = require('./legal.service');
const finance = require('./finance.service');
const { uploadBuffer, getReadUrl } = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Separate logins for the partner panel (Modules 24-26, contract sec. 4 and 33.8).
//   Legal Professional  active cases, document requests, drafting status,
//                       registration tracking, billing
//   Loan Officer        active applications, lender approval status,
//                       disbursement schedule, referral record
//   Insurance Officer   policy products linked to transactions
// A R staff create the login once the LP / LO / IO code is issued. A partner
// sees only what was assigned or referred to them, never the client's phone
// or email (the client is reached through the platform), and moves a case
// only through the steps that are theirs - A R opens, cancels and closes.
// The codes are for identity and attribution only: never commission-bearing.

const ROLE_OF = { legal: 'legal_professional', LO: 'loan_officer', IO: 'insurance_officer' };
const DOC_TYPES = ['kyc', 'agreement', 'payment_receipt', 'noc', 'other', 'sale_deed', 'agreement_to_sell', 'id_proof', 'tax_receipt', 'encumbrance_certificate', 'title_document', 'allotment_letter', 'occupancy_certificate', 'completion_certificate', 'approved_plan', 'mutation_record', 'society_noc', 'bank_noc', 'power_of_attorney', 'possession_letter', 'rent_agreement', 'utility_bill', 'rera_certificate'];
// The steps a partner takes; everything else stays with A R Buildwel.
const PARTNER_FLOW = {
  legal: { advocate_assigned: ['in_progress'], in_progress: ['report_ready'], report_ready: ['in_progress'] },
  loan: { referred: ['sanctioned', 'rejected'], sanctioned: ['disbursed'] },
  insurance: { referred: ['issued', 'declined'] },
};
const NON_COMMISSION = 'This code is for identity and attribution only and never carries commission (contract sec. 33.8). Any arrangement is with your institution, under its own agreement with A R Buildwel.';
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const notify = async (ids, n) => {
  for (const id of [...new Set(ids.filter(Boolean))]) await notificationService.createNotification({ userId: id, ...n }).catch(() => {});
};

// ------------------------------------------------------------- who am I

async function profileOf(user) {
  if (user.role === 'legal_professional') {
    const p = (await pool.query(`SELECT * FROM legal_professionals WHERE user_id = $1`, [user.id])).rows[0];
    if (!p) throw forbidden('This login is not linked to a panel record');
    if (p.status !== 'empanelled') throw forbidden('Your panel membership is not active');
    return { kind: 'legal', id: p.id, code: p.lp_code, name: p.full_name, firm: p.firm_name, type: p.kind };
  }
  if (['loan_officer', 'insurance_officer'].includes(user.role)) {
    const o = (await pool.query(`SELECT o.*, i.name AS institution_name FROM partner_officers o JOIN partner_institutions i ON i.id = o.institution_id WHERE o.user_id = $1`, [user.id])).rows[0];
    if (!o) throw forbidden('This login is not linked to a panel record');
    if (o.status !== 'verified') throw forbidden('Your panel membership is not active');
    return { kind: o.role, id: o.id, code: o.code, name: o.full_name, firm: o.institution_name, institutionId: o.institution_id, type: o.role === 'LO' ? 'loan_officer' : 'insurance_officer' };
  }
  throw forbidden('This area is for panel partners');
}

async function me(user) {
  const p = await profileOf(user);
  let summary;
  if (p.kind === 'legal') {
    summary = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('advocate_assigned', 'in_progress', 'report_ready'))::int AS open,
              COUNT(*) FILTER (WHERE status = 'advocate_assigned')::int AS to_start,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE status IN ('advocate_assigned', 'in_progress') AND due_on < CURRENT_DATE)::int AS overdue,
              COALESCE(SUM(fee_amount) FILTER (WHERE fee_status = 'paid'), 0)::float AS fees_paid,
              COALESCE(SUM(fee_amount) FILTER (WHERE fee_status IN ('quoted', 'invoiced')), 0)::float AS fees_open
       FROM legal_cases WHERE professional_id = $1`,
      [p.id]
    )).rows[0];
  } else if (p.kind === 'LO') {
    summary = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('referred', 'sanctioned'))::int AS open, COUNT(*) FILTER (WHERE status = 'referred')::int AS awaiting_decision,
              COUNT(*)::int AS referrals, COUNT(*) FILTER (WHERE status IN ('sanctioned', 'disbursed'))::int AS sanctioned, COUNT(*) FILTER (WHERE status = 'disbursed')::int AS disbursed,
              COALESCE(SUM(sanctioned_amount) FILTER (WHERE status IN ('sanctioned', 'disbursed')), 0)::float AS sanctioned_amount
       FROM loan_applications WHERE officer_id = $1`,
      [p.id]
    )).rows[0];
  } else {
    summary = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'referred')::int AS open, COUNT(*)::int AS referrals, COUNT(*) FILTER (WHERE status = 'issued')::int AS issued,
              COALESCE(SUM(premium_amount) FILTER (WHERE status = 'issued'), 0)::float AS premium
       FROM insurance_requests WHERE officer_id = $1`,
      [p.id]
    )).rows[0];
  }
  return { ...p, summary, nonCommission: NON_COMMISSION };
}

// ------------------------------------------------------------ documents

async function caseDocs(kind, id) {
  const r = kind === 'legal'
    ? await pool.query(`SELECT d.id, d.document_type, d.file_name, d.created_at, l.auto_linked, d.uploaded_by FROM legal_case_documents l JOIN documents d ON d.id = l.document_id WHERE l.case_id = $1 ORDER BY d.created_at`, [id])
    : await pool.query(`SELECT d.id, d.document_type, d.file_name, d.created_at, l.auto_linked, d.uploaded_by FROM finance_case_documents l JOIN documents d ON d.id = l.document_id WHERE l.subject_type = $1 AND l.subject_id = $2 ORDER BY d.created_at`, [kind, id]);
  return r.rows.map((d) => ({ id: d.id, type: d.document_type, fileName: d.file_name, addedAt: d.created_at, autoLinked: d.auto_linked, uploadedByMe: false, uploadedBy: d.uploaded_by }));
}

// Notes the client sees, and the partner's own entries.
async function partnerTimeline(kind, id, user) {
  const r = kind === 'legal'
    ? await pool.query(`SELECT e.kind, e.note, e.created_at, e.actor_id, u.full_name FROM legal_case_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.case_id = $1 AND (e.client_visible OR e.actor_id = $2) ORDER BY e.created_at`, [id, user.id])
    : await pool.query(`SELECT e.kind, e.note, e.created_at, e.actor_id, u.full_name FROM finance_case_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.subject_type = $1 AND e.subject_id = $2 AND (e.client_visible OR e.actor_id = $3) ORDER BY e.created_at`, [kind, id, user.id]);
  return r.rows.map((e) => ({ kind: e.kind, note: e.note, at: e.created_at, mine: e.actor_id === user.id, by: e.actor_id === user.id ? 'You' : null }));
}

const withMine = (docs, user) => docs.map(({ uploadedBy, ...d }) => ({ ...d, uploadedByMe: uploadedBy === user.id }));

// ------------------------------------------------------------ legal cases

const LEGAL_SELECT = `SELECT c.*, cu.full_name AS customer_name, pr.title AS property_title, pr.city AS property_city, pr.locality AS property_locality,
    (SELECT COUNT(*) FROM legal_case_documents d WHERE d.case_id = c.id)::int AS documents
  FROM legal_cases c LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN properties pr ON pr.id = c.property_id`;

const legalView = (c) => ({
  id: c.id, number: c.case_number, serviceType: c.service_type, serviceLabel: legal.SERVICE_LABEL[c.service_type] || c.service_type, requirement: c.requirement, status: c.status,
  clientName: c.customer_name, property: c.property_id ? { title: c.property_title, city: c.property_city, locality: c.property_locality } : null,
  assignedAt: c.assigned_at, dueOn: c.due_on, overdue: ['advocate_assigned', 'in_progress'].includes(c.status) && !!c.due_on && new Date(c.due_on) < new Date(new Date().toISOString().slice(0, 10)),
  reportReady: !!c.report_document_id, documents: c.documents,
  fee: c.fee_status ? { amount: num(c.fee_amount), status: c.fee_status, note: c.fee_note } : null,
  next: PARTNER_FLOW.legal[c.status] || [], updatedAt: c.updated_at,
});

async function legalCases(user, { open = false } = {}) {
  const p = await profileOf(user);
  if (p.kind !== 'legal') throw forbidden();
  const r = await pool.query(`${LEGAL_SELECT} WHERE c.professional_id = $1 ${open ? `AND c.status IN ('advocate_assigned', 'in_progress', 'report_ready')` : ''} ORDER BY (c.status IN ('completed', 'cancelled')), c.due_on NULLS LAST, c.created_at DESC`, [p.id]);
  return { cases: r.rows.map(legalView) };
}

async function legalCaseRow(user, id) {
  const p = await profileOf(user);
  if (p.kind !== 'legal') throw forbidden();
  const c = (await pool.query(`${LEGAL_SELECT} WHERE c.id = $1 AND c.professional_id = $2`, [id, p.id])).rows[0];
  if (!c) throw notFound('Case not found');
  return c;
}

async function legalCase(user, id) {
  const c = await legalCaseRow(user, id);
  const [docs, timeline, s] = await Promise.all([caseDocs('legal', id), partnerTimeline('legal', id, user), legal.settings()]);
  return { ...legalView(c), linkedDocuments: withMine(docs, user), timeline, disclaimer: s.disclaimer };
}

// ------------------------------------------------------------ loans

const loanView = (a) => ({
  id: a.id, number: a.application_number, loanType: a.loan_type, loanLabel: finance.LOAN_LABEL[a.loan_type] || a.loan_type, status: a.status, clientName: a.customer_name,
  propertyTitle: a.property_title, city: a.city, isNri: a.is_nri, employmentType: a.employment_type,
  monthlyIncome: num(a.monthly_income), existingEmi: num(a.existing_emi), propertyValue: num(a.property_value), loanAmountRequested: num(a.loan_amount_requested), tenureYears: a.tenure_years,
  referredAt: a.referred_at, lenderReference: a.lender_reference,
  sanction: a.sanctioned_amount ? { amount: num(a.sanctioned_amount), rate: num(a.sanctioned_rate), on: a.sanctioned_on } : null,
  disbursementSchedule: a.disbursement_schedule || [], documents: a.documents, next: PARTNER_FLOW.loan[a.status] || [], updatedAt: a.updated_at,
});

const LOAN_SELECT = `SELECT a.*, cu.full_name AS customer_name, pr.title AS property_title,
    (SELECT COUNT(*) FROM finance_case_documents d WHERE d.subject_type = 'loan' AND d.subject_id = a.id)::int AS documents
  FROM loan_applications a LEFT JOIN customers cu ON cu.id = a.customer_id LEFT JOIN properties pr ON pr.id = a.property_id`;

async function officerRow(user, kind, id) {
  const p = await profileOf(user);
  if (p.kind !== (kind === 'loan' ? 'LO' : 'IO')) throw forbidden();
  const row = kind === 'loan'
    ? (await pool.query(`${LOAN_SELECT} WHERE a.id = $1 AND a.officer_id = $2`, [id, p.id])).rows[0]
    : (await pool.query(`${INS_SELECT} WHERE q.id = $1 AND q.officer_id = $2`, [id, p.id])).rows[0];
  if (!row) throw notFound(kind === 'loan' ? 'Application not found' : 'Request not found');
  return { p, row };
}

async function loans(user, { open = false } = {}) {
  const p = await profileOf(user);
  if (p.kind !== 'LO') throw forbidden();
  const r = await pool.query(`${LOAN_SELECT} WHERE a.officer_id = $1 ${open ? `AND a.status IN ('referred', 'sanctioned')` : ''} ORDER BY (a.status IN ('disbursed', 'rejected', 'withdrawn')), a.referred_at DESC NULLS LAST`, [p.id]);
  return { applications: r.rows.map(loanView) };
}

async function loan(user, id) {
  const { row } = await officerRow(user, 'loan', id);
  const [docs, timeline, s] = await Promise.all([caseDocs('loan', id), partnerTimeline('loan', id, user), finance.settings()]);
  return { ...loanView(row), linkedDocuments: withMine(docs, user), timeline, disclaimer: s.loanDisclaimer };
}

// ------------------------------------------------------------ insurance

const INS_SELECT = `SELECT q.*, cu.full_name AS customer_name, pr.title AS property_title,
    (SELECT COUNT(*) FROM finance_case_documents d WHERE d.subject_type = 'insurance' AND d.subject_id = q.id)::int AS documents
  FROM insurance_requests q LEFT JOIN customers cu ON cu.id = q.customer_id LEFT JOIN properties pr ON pr.id = q.property_id`;

const insView = (q, covers) => ({
  id: q.id, number: q.request_number, coverType: q.cover_type, coverLabel: covers[q.cover_type] || q.cover_type, status: q.status, clientName: q.customer_name, propertyTitle: q.property_title,
  propertyDetails: q.property_details || {}, sumInsured: num(q.sum_insured), referredAt: q.referred_at, linkedToLoan: !!q.loan_application_id, linkedToDeal: !!q.deal_id,
  policy: q.policy_number ? { number: q.policy_number, start: q.policy_start, end: q.policy_end, premium: num(q.premium_amount) } : null,
  documents: q.documents, next: PARTNER_FLOW.insurance[q.status] || [], updatedAt: q.updated_at,
});

async function insuranceList(user, { open = false } = {}) {
  const p = await profileOf(user);
  if (p.kind !== 'IO') throw forbidden();
  const s = await finance.settings();
  const r = await pool.query(`${INS_SELECT} WHERE q.officer_id = $1 ${open ? `AND q.status = 'referred'` : ''} ORDER BY (q.status <> 'referred'), q.referred_at DESC NULLS LAST`, [p.id]);
  return { requests: r.rows.map((q) => insView(q, s.covers)) };
}

async function insurance(user, id) {
  const { row } = await officerRow(user, 'insurance', id);
  const [docs, timeline, s] = await Promise.all([caseDocs('insurance', id), partnerTimeline('insurance', id, user), finance.settings()]);
  return { ...insView(row, s.covers), linkedDocuments: withMine(docs, user), timeline, disclaimer: s.insDisclaimer };
}

// ------------------------------------------------------------ actions

const KINDS = ['legal', 'loan', 'insurance'];
const getOne = (user, kind, id) => (kind === 'legal' ? legalCase(user, id) : kind === 'loan' ? loan(user, id) : insurance(user, id));
const rowOf = async (user, kind, id) => (kind === 'legal' ? legalCaseRow(user, id) : (await officerRow(user, kind, id)).row);

// Move the case one of the partner's own steps, or add a note. A report
// document is attached only through upload(), never by id from the request -
// otherwise any document on the platform could be pulled into the case.
const update = (user, kind, id, data = {}, meta = {}) => {
  const { reportDocumentId: _ignored, ...rest } = data || {}; // eslint-disable-line no-unused-vars
  return applyUpdate(user, kind, id, rest, meta);
};

async function applyUpdate(user, kind, id, data = {}, meta = {}) {
  if (!KINDS.includes(kind)) throw notFound();
  const row = await rowOf(user, kind, id);
  const { status = null } = data;
  if (status && status !== row.status && !(PARTNER_FLOW[kind][row.status] || []).includes(status)) {
    throw forbidden(`From "${row.status.replace(/_/g, ' ')}" you can ${(PARTNER_FLOW[kind][row.status] || []).length ? `move it to: ${PARTNER_FLOW[kind][row.status].map((x) => x.replace(/_/g, ' ')).join(', ')}` : 'only add notes and documents - A R Buildwel takes it from here'}`);
  }
  const clean = { ...data, status: status && status !== row.status ? status : null };
  if (kind === 'legal') await legal.setStatus(user, id, { status: clean.status, note: clean.note, clientVisible: clean.clientVisible !== false, reportDocumentId: clean.reportDocumentId }, meta);
  else if (kind === 'loan') {
    const allowed = ['status', 'note', 'clientVisible', 'sanctionedAmount', 'sanctionedRate', 'sanctionedOn', 'lenderReference', 'disbursementSchedule'];
    await finance.updateLoanStatus(user, id, Object.fromEntries(Object.entries(clean).filter(([k]) => allowed.includes(k))), meta);
  } else {
    const allowed = ['status', 'note', 'clientVisible', 'policyNumber', 'policyStart', 'policyEnd', 'premiumAmount'];
    await finance.updateInsuranceStatus(user, id, Object.fromEntries(Object.entries(clean).filter(([k]) => allowed.includes(k))), meta);
  }
  return getOne(user, kind, id);
}

// Ask the client (through A R Buildwel) for documents - the partner never contacts them off-platform.
async function requestDocuments(user, kind, id, { note } = {}, meta = {}) {
  if (!KINDS.includes(kind)) throw notFound();
  const row = await rowOf(user, kind, id);
  const text = String(note || '').trim();
  if (text.length < 5) throw badRequest('Say which documents are needed');
  const p = await profileOf(user);
  const message = `${p.name} (${p.code}) asks for: ${text.slice(0, 500)}`;
  if (kind === 'legal') await pool.query(`INSERT INTO legal_case_events (case_id, kind, note, client_visible, actor_id) VALUES ($1, 'document_request', $2, true, $3)`, [id, message, user.id]);
  else await pool.query(`INSERT INTO finance_case_events (subject_type, subject_id, kind, note, client_visible, actor_id) VALUES ($1, $2, 'document_request', $3, true, $4)`, [kind, id, message, user.id]);
  const number = row.case_number || row.application_number || row.request_number;
  await notify([row.requested_by, row.assigned_by, row.referred_by], { type: kind === 'legal' ? 'legal_case' : kind === 'loan' ? 'loan_application' : 'insurance_request', title: `${number}: documents requested`, message, priority: 'high' });
  await auditService.log({ actor: user, action: 'partner.documents_requested', entityType: kind === 'legal' ? 'legal_case' : kind === 'loan' ? 'loan_application' : 'insurance_request', entityId: id, after: { note: text }, ...meta });
  return getOne(user, kind, id);
}

// A file added to the case by the partner (a report, a sanction letter, a policy schedule...).
async function upload(user, kind, id, file, { documentType = 'other', asReport = false } = {}, meta = {}) {
  if (!KINDS.includes(kind)) throw notFound();
  if (!file) throw badRequest('Attach the file');
  const type = DOC_TYPES.includes(documentType) ? documentType : 'other';
  const row = await rowOf(user, kind, id);
  const path = await uploadBuffer(file.buffer, `partner-desk/${kind}/${id}`, file.originalname, file.mimetype);
  const doc = (await pool.query(
    `INSERT INTO documents (customer_id, deal_id, property_id, document_type, document_url, file_name, uploaded_by, status, visible_to) VALUES ($1, $2, $3, $4::document_category, $5, $6, $7, 'pending', '["admin", "buyer", "owner"]'::jsonb) RETURNING id`,
    [row.customer_id || null, row.deal_id || null, row.property_id || null, type, path, String(file.originalname || 'document').slice(0, 255), user.id]
  )).rows[0];
  if (kind === 'legal') {
    await pool.query('INSERT INTO legal_case_documents (case_id, document_id, auto_linked) VALUES ($1, $2, false) ON CONFLICT DO NOTHING', [id, doc.id]);
    // The report moves the case to "report ready" in one go.
    if (asReport) return applyUpdate(user, 'legal', id, { status: row.status === 'in_progress' ? 'report_ready' : null, reportDocumentId: doc.id, note: row.status === 'in_progress' ? null : 'Report attached.' }, meta);
    await pool.query(`INSERT INTO legal_case_events (case_id, kind, note, client_visible, actor_id) VALUES ($1, 'document_added', $2, true, $3)`, [id, `Document added: ${file.originalname}`, user.id]);
  } else {
    await pool.query(`INSERT INTO finance_case_documents (subject_type, subject_id, document_id, auto_linked) VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING`, [kind, id, doc.id]);
    await pool.query(`INSERT INTO finance_case_events (subject_type, subject_id, kind, note, client_visible, actor_id) VALUES ($1, $2, 'document_added', $3, true, $4)`, [kind, id, `Document added: ${file.originalname}`, user.id]);
  }
  await auditService.log({ actor: user, action: 'partner.document_uploaded', entityType: 'document', entityId: doc.id, after: { kind, caseId: id, documentType: type }, ...meta });
  return getOne(user, kind, id);
}

// A short-lived link to a document on one of the partner's own cases.
async function documentUrl(user, kind, id, documentId) {
  if (!KINDS.includes(kind)) throw notFound();
  await rowOf(user, kind, id);
  const d = kind === 'legal'
    ? (await pool.query(`SELECT d.document_url, d.file_name FROM legal_case_documents l JOIN documents d ON d.id = l.document_id WHERE l.case_id = $1 AND d.id = $2`, [id, documentId])).rows[0]
    : (await pool.query(`SELECT d.document_url, d.file_name FROM finance_case_documents l JOIN documents d ON d.id = l.document_id WHERE l.subject_type = $1 AND l.subject_id = $2 AND d.id = $3`, [kind, id, documentId])).rows[0];
  if (!d) throw notFound('Document not found on this case');
  await auditService.log({ actor: user, action: 'partner.document_viewed', entityType: 'document', entityId: documentId, after: { kind, caseId: id } });
  return { url: await getReadUrl(d.document_url), fileName: d.file_name };
}

// Billing: what the advocate quoted or invoiced the client, and whether it is
// paid. Settled directly between them - recorded here, never collected or shared.
async function setFee(user, id, { amount, status, note } = {}, meta = {}) {
  const c = await legalCaseRow(user, id);
  if (!['quoted', 'invoiced', 'paid'].includes(status)) throw badRequest('status must be quoted, invoiced or paid');
  const a = num(amount);
  if (a === null || !Number.isFinite(a) || a < 0) throw badRequest('Enter the fee amount');
  await pool.query('UPDATE legal_cases SET fee_amount = $2, fee_status = $3, fee_note = $4 WHERE id = $1', [id, a, status, note ? String(note).trim().slice(0, 300) : null]);
  await pool.query(`INSERT INTO legal_case_events (case_id, kind, note, client_visible, actor_id) VALUES ($1, 'fee', $2, true, $3)`, [id, `Fee ${status}: ₹${a.toLocaleString('en-IN')}${note ? ` - ${String(note).trim().slice(0, 200)}` : ''}. Paid directly to the advocate; A R Buildwel takes no share.`, user.id]);
  await auditService.log({ actor: user, action: 'partner.fee_recorded', entityType: 'legal_case', entityId: id, before: { amount: num(c.fee_amount), status: c.fee_status }, after: { amount: a, status }, ...meta });
  return legalCase(user, id);
}

// ------------------------------------------------------------ logins (A R staff)

// Create the partner's login once their code is issued. A R staff set a first
// password and pass it on; the partner changes it from Settings.
async function createLogin(admin, kind, id, { email, password, mobile } = {}, meta = {}) {
  if (!['admin', 'super_admin'].includes(admin.role)) throw forbidden('Only an admin creates partner logins');
  const rec = kind === 'legal'
    ? (await pool.query('SELECT id, full_name, email, mobile, status, lp_code AS code, user_id FROM legal_professionals WHERE id = $1', [id])).rows[0]
    : (await pool.query('SELECT id, full_name, email, mobile, status, code, role, user_id FROM partner_officers WHERE id = $1', [id])).rows[0];
  if (!rec) throw notFound('Panel record not found');
  if (rec.user_id) throw badRequest('This partner already has a login');
  const active = kind === 'legal' ? rec.status === 'empanelled' : rec.status === 'verified';
  if (!active || !rec.code) throw badRequest(kind === 'legal' ? 'Empanel the professional first - the LP code is issued with the enrolment check' : 'Verify the officer first - the code is issued with the empanelment / licence check');
  const role = kind === 'legal' ? ROLE_OF.legal : ROLE_OF[rec.role];
  const mail = String(email || rec.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw badRequest('A login email is required');
  if (!password || String(password).length < 8) throw badRequest('Set a first password of at least 8 characters');
  if ((await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [mail])).rows.length) throw badRequest('An account with this email already exists');
  const phone = String(mobile || rec.mobile || '').replace(/\D/g, '').slice(-10) || null;
  const phoneFree = phone && !(await pool.query('SELECT 1 FROM users WHERE mobile = $1', [phone])).rows.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roleId = (await client.query('SELECT id FROM roles WHERE name = $1', [role])).rows[0].id;
    const u = (await client.query(
      `INSERT INTO users (role_id, full_name, email, mobile, password_hash, status, email_verified, created_by, signup_source) VALUES ($1, $2, $3, $4, $5, 'active', true, $6, 'admin_created') RETURNING id`,
      [roleId, rec.full_name, mail, phoneFree ? phone : null, await bcrypt.hash(String(password), 10), admin.id]
    )).rows[0];
    await client.query(`UPDATE ${kind === 'legal' ? 'legal_professionals' : 'partner_officers'} SET user_id = $2 WHERE id = $1`, [id, u.id]);
    await client.query('COMMIT');
    await auditService.log({ actor: admin, action: 'partner.login_created', entityType: kind === 'legal' ? 'legal_professional' : 'partner_officer', entityId: id, after: { userId: u.id, role, code: rec.code }, ...meta });
    return { userId: u.id, email: mail, role, code: rec.code };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ROLES: Object.values(ROLE_OF), DOC_TYPES, me, legalCases, legalCase, loans, loan, insuranceList, insurance, update, requestDocuments, upload, documentUrl, setFee, createLogin };
