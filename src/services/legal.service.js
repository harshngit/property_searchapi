const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { getReadUrl } = require('../utils/storage');
const { assertCleanContent } = require('../utils/contentGuard');
const { badRequest, forbidden, notFound } = require('../utils/httpError');
const userBlock = require('../utils/userBlock');

// Module 24 - Legal Integration.
//   Panel : empanelled advocates and registered valuers. The LP code is
//           issued only once the enrolment / empanelment check is recorded,
//           and is for attribution only - never commission-bearing.
//   Cases : describe the requirement -> documents auto-linked -> advocate
//           assigned -> status tracked. The client engages the advocate
//           directly and may name an advocate of their own choice; A R
//           Buildwel refers and coordinates and takes no fee share.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const SERVICES = ['due_diligence', 'title_verification', 'agreement_drafting', 'registration_support', 'valuation', 'other'];
const SERVICE_LABEL = { due_diligence: 'Due diligence', title_verification: 'Title verification', agreement_drafting: 'Agreement drafting', registration_support: 'Registration support', valuation: 'Valuation', other: 'Other legal help' };
const SPECIALITIES = ['due_diligence', 'title_verification', 'agreement_drafting', 'registration_support', 'litigation', 'valuation'];
const OPEN = ['requested', 'advocate_assigned', 'in_progress', 'report_ready'];
// Each status and where it may go next.
const FLOW = {
  requested: ['advocate_assigned', 'cancelled'],
  advocate_assigned: ['in_progress', 'report_ready', 'completed', 'cancelled'],
  in_progress: ['report_ready', 'completed', 'cancelled'],
  report_ready: ['completed', 'in_progress'],
  completed: [],
  cancelled: [],
};
const isStaff = (user) => STAFF.includes(user.role);
const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean))];

async function settings() {
  const [days, hours, disclaimer] = await Promise.all([
    configService.getConfig('legal.working_days', {}),
    configService.getConfig('legal.initiate_hours', 24),
    configService.getConfig('legal.disclaimer', "Due diligence conducted by A R Buildwel's empanelled advocates is for the client's guidance. It does not constitute a guarantee of clear title. Clients are advised to obtain independent legal advice."),
  ]);
  return { days: { due_diligence: 15, title_verification: 15, valuation: 10, agreement_drafting: 7, registration_support: 7, other: 10, ...(days || {}) }, initiateHours: Number(hours) || 24, disclaimer };
}

// Saturdays and Sundays are skipped.
function addWorkingDays(from, n) {
  const d = new Date(from);
  let left = Math.max(0, Number(n) || 0);
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (![0, 6].includes(d.getDay())) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

const staffIds = async () => (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ANY($1) AND u.status = 'active'`, [ADMIN])).rows.map((r) => r.id);
const notify = async (ids, n) => {
  for (const id of [...new Set(ids.filter(Boolean))]) await notificationService.createNotification({ userId: id, ...n }).catch(() => {});
};
const event = (caseId, kind, note, actor, clientVisible = true, client = pool) =>
  client.query(`INSERT INTO legal_case_events (case_id, kind, note, client_visible, actor_id) VALUES ($1, $2, $3, $4, $5)`, [caseId, kind, note || null, clientVisible, actor?.id || null]);

// ------------------------------------------------------------------ panel

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1 - matches ^LP-[A-HJ-KM-NP-Z2-9]{5}$
async function newLpCode(client) {
  for (let i = 0; i < 20; i += 1) {
    const code = `LP-${Array.from(crypto.randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
    if (!(await client.query('SELECT 1 FROM legal_professionals WHERE lp_code = $1', [code])).rows.length) return code;
  }
  throw new Error('Could not issue an LP code');
}

const proView = (p, { staff = false } = {}) => ({
  id: p.id, lpCode: p.lp_code, kind: p.kind, fullName: p.full_name, firmName: p.firm_name, states: p.states, cities: p.cities, specialities: p.specialities, status: p.status,
  ...(staff ? { enrolmentNumber: p.enrolment_number, enrolmentBody: p.enrolment_body, email: p.email, mobile: p.mobile, verifiedAt: p.verified_at, verificationNote: p.verification_note, notes: p.notes, openCases: p.open_cases, completedCases: p.completed_cases, createdAt: p.created_at, hasLogin: !!p.user_id } : {}),
});

async function listProfessionals({ status = null, kind = null, city = null, q = null } = {}) {
  const r = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM legal_cases c WHERE c.professional_id = p.id AND c.status = ANY($5))::int AS open_cases,
            (SELECT COUNT(*) FROM legal_cases c WHERE c.professional_id = p.id AND c.status = 'completed')::int AS completed_cases
     FROM legal_professionals p
     WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.kind = $2)
       AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM unnest(p.cities) x WHERE lower(x) = lower($3)))
       AND ($4::text IS NULL OR p.full_name ILIKE $4 OR p.firm_name ILIKE $4 OR p.lp_code ILIKE $4 OR p.enrolment_number ILIKE $4)
     ORDER BY (p.status = 'empanelled') DESC, p.full_name`,
    [status, kind, city, q ? `%${q}%` : null, OPEN]
  );
  return r.rows.map((p) => proView(p, { staff: true }));
}

function cleanPro(data, before = {}) {
  const pick = (k, col) => (data[k] !== undefined ? data[k] : before[col]);
  const kind = pick('kind', 'kind') || 'advocate';
  if (!['advocate', 'valuer'].includes(kind)) throw badRequest('kind must be advocate or valuer');
  const fullName = String(pick('fullName', 'full_name') || '').trim();
  const enrolment = String(pick('enrolmentNumber', 'enrolment_number') || '').trim();
  if (fullName.length < 2) throw badRequest('The name is required');
  if (enrolment.length < 3) throw badRequest(kind === 'advocate' ? 'The Bar Council enrolment number is required' : "The valuer's registration number is required");
  const specialities = list(pick('specialities', 'specialities'));
  const bad = specialities.filter((s) => !SPECIALITIES.includes(s));
  if (bad.length) throw badRequest(`Unknown speciality: ${bad.join(', ')}`);
  const email = pick('email', 'email') ? String(pick('email', 'email')).trim().toLowerCase() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email');
  return [kind, fullName, pick('firmName', 'firm_name') || null, enrolment, pick('enrolmentBody', 'enrolment_body') || null, email, pick('mobile', 'mobile') || null,
    list(pick('states', 'states')).map((s) => s.toUpperCase()), list(pick('cities', 'cities')), specialities, pick('notes', 'notes') || null];
}

async function saveProfessional(user, data, meta = {}) {
  const before = data.id ? (await pool.query('SELECT * FROM legal_professionals WHERE id = $1', [data.id])).rows[0] : null;
  if (data.id && !before) throw notFound('Legal professional not found');
  const v = cleanPro(data, before || {});
  let p;
  try {
    p = before
      ? (await pool.query(`UPDATE legal_professionals SET kind = $2, full_name = $3, firm_name = $4, enrolment_number = $5, enrolment_body = $6, email = $7, mobile = $8, states = $9, cities = $10, specialities = $11, notes = $12 WHERE id = $1 RETURNING *`, [before.id, ...v])).rows[0]
      : (await pool.query(`INSERT INTO legal_professionals (kind, full_name, firm_name, enrolment_number, enrolment_body, email, mobile, states, cities, specialities, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`, [...v, user.id])).rows[0];
  } catch (err) {
    if (err.code === '23505') throw badRequest('A record with this enrolment / registration number already exists');
    throw err;
  }
  await auditService.log({ actor: user, action: before ? 'legal.professional_updated' : 'legal.professional_added', entityType: 'legal_professional', entityId: p.id, after: { name: p.full_name, kind: p.kind }, ...meta });
  return proView(p, { staff: true });
}

// Empanelment: the LP code is issued here, with what was checked recorded against it.
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

async function decideProfessional(user, id, { action, note }, meta = {}) {
  const p = (await pool.query('SELECT * FROM legal_professionals WHERE id = $1', [id])).rows[0];
  if (!p) throw notFound('Legal professional not found');
  if (!['empanel', 'suspend', 'reinstate'].includes(action)) throw badRequest('action must be empanel, suspend or reinstate');
  if (!note || String(note).trim().length < 5) throw badRequest(action === 'empanel' ? 'Record what was checked (enrolment certificate, empanelment letter)' : 'Give the reason');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let u;
    if (action === 'suspend') {
      if (p.status !== 'empanelled') throw badRequest('Only an empanelled professional can be suspended');
      u = (await client.query(`UPDATE legal_professionals SET status = 'suspended', notes = concat_ws(E'\\n', notes, $2::text) WHERE id = $1 RETURNING *`, [id, `Suspended: ${String(note).trim()}`])).rows[0];
    } else {
      if (action === 'empanel' && p.status !== 'pending') throw badRequest('This professional is already on the panel');
      if (action === 'reinstate' && p.status !== 'suspended') throw badRequest('Only a suspended professional can be reinstated');
      const code = p.lp_code || (await newLpCode(client));
      u = (await client.query(`UPDATE legal_professionals SET status = 'empanelled', lp_code = $2, verified_by = $3, verified_at = now(), verification_note = $4 WHERE id = $1 RETURNING *`, [id, code, user.id, String(note).trim()])).rows[0];
    }
    await client.query('COMMIT');
    await syncPartnerLogin(u.user_id, u.status === 'empanelled');
    await auditService.log({ actor: user, action: `legal.professional_${action}`, entityType: 'legal_professional', entityId: id, before: { status: p.status }, after: { status: u.status, lpCode: u.lp_code, note }, ...meta });
    return proView(u, { staff: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ cases

const CASE_SELECT = `SELECT c.*, p.full_name AS pro_name, p.firm_name AS pro_firm, p.lp_code AS pro_code, p.kind AS pro_kind,
    cu.full_name AS customer_name, pr.title AS property_title, pr.city AS property_city, pr.locality AS property_locality,
    (SELECT COUNT(*) FROM legal_case_documents d WHERE d.case_id = c.id)::int AS documents
  FROM legal_cases c LEFT JOIN legal_professionals p ON p.id = c.professional_id
  LEFT JOIN customers cu ON cu.id = c.customer_id LEFT JOIN properties pr ON pr.id = c.property_id`;

function caseView(c, { staff = false } = {}) {
  return {
    id: c.id, caseNumber: c.case_number, serviceType: c.service_type, serviceLabel: SERVICE_LABEL[c.service_type], requirement: c.requirement, status: c.status,
    propertyId: c.property_id, propertyTitle: c.property_title, propertyCity: c.property_city, dealId: c.deal_id, documents: c.documents,
    // The client learns who the advocate is (they engage them directly) - name, firm and LP code, never a phone or email.
    advocate: c.professional_id ? { name: c.pro_name, firm: c.pro_firm, lpCode: c.pro_code, kind: c.pro_kind } : c.client_advocate_name ? { name: c.client_advocate_name, firm: null, lpCode: null, kind: 'own_choice' } : null,
    assignedAt: c.assigned_at, dueOn: c.due_on, reportReady: !!c.report_document_id, createdAt: c.created_at, updatedAt: c.updated_at,
    ...(staff ? { customerId: c.customer_id, customerName: c.customer_name, leadId: c.lead_id, mandateId: c.mandate_id, professionalId: c.professional_id, source: c.source, initiateBy: c.initiate_by, handedOffAt: c.handed_off_at, reportDocumentId: c.report_document_id,
      overdue: OPEN.includes(c.status) && !!c.due_on && new Date(c.due_on) < new Date(new Date().toISOString().slice(0, 10)),
      initiationLate: c.status === 'requested' && !!c.initiate_by && new Date(c.initiate_by) < new Date() } : {}),
  };
}

// "Documents auto-linked": everything already on file for the deal, the
// property and the client - nothing has to be uploaded again.
async function autoLink(caseId, { customerId, dealId, propertyId }, client = pool) {
  const r = await client.query(
    `INSERT INTO legal_case_documents (case_id, document_id)
     SELECT $1, d.id FROM documents d
     WHERE ($2::uuid IS NOT NULL AND d.deal_id = $2) OR ($3::uuid IS NOT NULL AND d.property_id = $3)
        OR ($4::uuid IS NOT NULL AND d.customer_id = $4 AND d.deal_id IS NULL AND ($3::uuid IS NULL OR d.property_id IS NULL OR d.property_id = $3))
     ON CONFLICT DO NOTHING RETURNING document_id`,
    [caseId, dealId || null, propertyId || null, customerId || null]
  );
  return r.rows.length;
}

async function insertCase(actor, { customerId, requestedBy, dealId = null, propertyId = null, leadId = null, mandateId = null, serviceType, requirement, source }, meta = {}) {
  if (!SERVICES.includes(serviceType)) throw badRequest(`serviceType must be one of: ${SERVICES.join(', ')}`);
  const text = String(requirement || '').trim();
  if (text.length < 10) throw badRequest('Describe what you need in a sentence or two');
  if (source === 'customer') await assertCleanContent({ requirement: text }, { blockContact: true });
  const s = await settings();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = (await client.query(`SELECT nextval('legal_case_seq') AS n`)).rows[0].n;
    const c = (
      await client.query(
        `INSERT INTO legal_cases (case_number, requested_by, customer_id, deal_id, property_id, lead_id, mandate_id, service_type, requirement, source, initiate_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(hours => $11)) RETURNING *`,
        [`LC-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`, requestedBy || null, customerId || null, dealId, propertyId, leadId, mandateId, serviceType, text.slice(0, 4000), source, s.initiateHours]
      )
    ).rows[0];
    const linked = await autoLink(c.id, { customerId, dealId, propertyId }, client);
    await event(c.id, 'requested', `${SERVICE_LABEL[serviceType]} requested. ${linked} document${linked === 1 ? '' : 's'} on file linked automatically.`, actor, true, client);
    await client.query('COMMIT');
    await auditService.log({ actor, action: 'legal.case_opened', entityType: 'legal_case', entityId: c.id, after: { caseNumber: c.case_number, serviceType, source, documents: linked }, ...meta });
    // The representative on the deal or enquiry starts it with the panel; admins see it too.
    const rep = (await pool.query(`SELECT COALESCE((SELECT assigned_rep_id FROM deals WHERE id = $1), (SELECT arb_rep_id FROM leads WHERE id = $2)) AS id`, [dealId, leadId])).rows[0]?.id;
    await notify([rep, ...(await staffIds())], { type: 'legal_case', title: `Legal case ${c.case_number}: ${SERVICE_LABEL[serviceType]}`, message: `Assign an empanelled ${serviceType === 'valuation' ? 'valuer' : 'advocate'} within ${s.initiateHours} hours.` });
    return c;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// A customer asks for legal help from their dashboard.
async function requestCase(user, data, meta = {}) {
  const customer = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [user.id])).rows[0];
  if (!customer) throw badRequest('Complete your profile first');
  let dealId = null;
  let propertyId = data.propertyId || null;
  if (data.dealId) {
    const d = (await pool.query('SELECT id, property_id FROM deals WHERE id = $1 AND customer_id = $2', [data.dealId, customer.id])).rows[0];
    if (!d) throw notFound('Deal not found');
    dealId = d.id;
    propertyId = propertyId || d.property_id;
  }
  if (propertyId && !(await pool.query('SELECT 1 FROM properties WHERE id = $1', [propertyId])).rows.length) throw notFound('Property not found');
  const c = await insertCase(user, { customerId: customer.id, requestedBy: user.id, dealId, propertyId, serviceType: data.serviceType, requirement: data.requirement, source: 'customer' }, meta);
  return getCase(user, c.id);
}

// Staff open a case for a client: from a deal, an enquiry or directly.
async function openCase(user, data, meta = {}) {
  let { customerId = null, dealId = null, propertyId = null, leadId = null } = data;
  if (dealId) {
    const d = (await pool.query('SELECT customer_id, property_id, lead_id FROM deals WHERE id = $1', [dealId])).rows[0];
    if (!d) throw notFound('Deal not found');
    customerId = customerId || d.customer_id;
    propertyId = propertyId || d.property_id;
    leadId = leadId || d.lead_id;
  }
  if (leadId && !customerId) {
    const l = (await pool.query('SELECT customer_id, property_id FROM leads WHERE id = $1', [leadId])).rows[0];
    if (!l) throw notFound('Enquiry not found');
    customerId = l.customer_id;
    propertyId = propertyId || l.property_id;
  }
  if (!customerId) throw badRequest('Choose the deal, enquiry or customer this case is for');
  const requestedBy = (await pool.query('SELECT user_id FROM customers WHERE id = $1', [customerId])).rows[0]?.user_id || null;
  const c = await insertCase(user, { customerId, requestedBy, dealId, propertyId, leadId, serviceType: data.serviceType, requirement: data.requirement, source: 'staff' }, meta);
  return getCase(user, c.id);
}

// A website enquiry of type "legal" becomes a case straight away.
async function onLegalEnquiry(lead, message) {
  if (lead.enquiry_type !== 'legal') return null;
  const requestedBy = (await pool.query('SELECT user_id FROM customers WHERE id = $1', [lead.customer_id])).rows[0]?.user_id || null;
  const text = [lead.enquiry_topic, message].filter(Boolean).join(' - ') || 'Legal help requested from the website enquiry form';
  return insertCase(null, { customerId: lead.customer_id, requestedBy, propertyId: lead.property_id, leadId: lead.id, serviceType: 'other', requirement: text.length >= 10 ? text : `${text} (website enquiry)`, source: 'enquiry' });
}

// Exclusive Mandate benefits: free due diligence and valuation for the seller.
async function onMandateActivated(mandate) {
  if (mandate.mandate_type !== 'seller_exclusive') return;
  for (const serviceType of ['due_diligence', 'valuation']) {
    const exists = (await pool.query('SELECT 1 FROM legal_cases WHERE mandate_id = $1 AND service_type = $2', [mandate.id, serviceType])).rows.length;
    if (exists) continue;
    await insertCase(null, {
      customerId: mandate.customer_id, requestedBy: mandate.user_id, propertyId: mandate.listing_id, mandateId: mandate.id, serviceType, source: 'mandate',
      requirement: serviceType === 'valuation' ? `Free valuation by an empanelled registered valuer under Exclusive Mandate ${mandate.mandate_number}.` : `Free due diligence by an empanelled advocate under Exclusive Mandate ${mandate.mandate_number}: title verification, encumbrance check and litigation status.`,
    });
  }
}

async function caseRow(user, id) {
  const c = (await pool.query(`${CASE_SELECT} WHERE c.id = $1`, [id])).rows[0];
  if (!c) throw notFound('Legal case not found');
  // An empanelled professional reaches only the cases assigned to them.
  if (user.role === 'legal_professional') {
    const mine = c.professional_id && (await pool.query(`SELECT 1 FROM legal_professionals WHERE id = $1 AND user_id = $2 AND status = 'empanelled'`, [c.professional_id, user.id])).rows.length;
    if (!mine) throw notFound('Legal case not found');
    return c;
  }
  if (!isStaff(user) && c.requested_by !== user.id) {
    const own = (await pool.query('SELECT 1 FROM customers WHERE id = $1 AND user_id = $2', [c.customer_id, user.id])).rows.length;
    if (!own) throw notFound('Legal case not found');
  }
  return c;
}

async function getCase(user, id) {
  const c = await caseRow(user, id);
  const staff = isStaff(user);
  const [events, docs, s] = await Promise.all([
    pool.query(`SELECT e.kind, e.note, e.client_visible, e.created_at, u.full_name FROM legal_case_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.case_id = $1 ${staff ? '' : 'AND e.client_visible'} ORDER BY e.created_at`, [id]),
    pool.query(`SELECT d.id, d.document_type, d.file_name, d.status, d.created_at, l.auto_linked FROM legal_case_documents l JOIN documents d ON d.id = l.document_id WHERE l.case_id = $1 ORDER BY d.created_at`, [id]),
    settings(),
  ]);
  return {
    ...caseView(c, { staff }),
    timeline: events.rows.map((e) => ({ kind: e.kind, note: e.note, at: e.created_at, ...(staff ? { by: e.full_name, clientVisible: e.client_visible } : {}) })),
    linkedDocuments: docs.rows.map((d) => ({ id: d.id, type: d.document_type, fileName: d.file_name, status: d.status, autoLinked: d.auto_linked, addedAt: d.created_at })),
    disclaimer: s.disclaimer,
  };
}

async function myCases(user) {
  const r = await pool.query(`${CASE_SELECT} WHERE c.requested_by = $1 OR c.customer_id IN (SELECT id FROM customers WHERE user_id = $1) ORDER BY c.created_at DESC`, [user.id]);
  const s = await settings();
  return { cases: r.rows.map((c) => caseView(c)), services: SERVICES.map((k) => ({ value: k, label: SERVICE_LABEL[k] })), disclaimer: s.disclaimer };
}

async function listCases({ status = null, serviceType = null, professionalId = null, q = null, open = false } = {}) {
  const r = await pool.query(
    `${CASE_SELECT}
     WHERE ($1::text IS NULL OR c.status = $1) AND ($2::text IS NULL OR c.service_type = $2) AND ($3::uuid IS NULL OR c.professional_id = $3)
       AND ($4::text IS NULL OR c.case_number ILIKE $4 OR cu.full_name ILIKE $4 OR pr.title ILIKE $4 OR p.full_name ILIKE $4)
       AND (NOT $5::boolean OR c.status = ANY($6))
     ORDER BY (c.status = 'requested') DESC, c.due_on ASC NULLS LAST, c.created_at DESC LIMIT 500`,
    [status, serviceType, professionalId, q ? `%${q}%` : null, !!open, OPEN]
  );
  const stats = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'requested')::int AS to_assign, COUNT(*) FILTER (WHERE status IN ('advocate_assigned', 'in_progress'))::int AS in_progress,
            COUNT(*) FILTER (WHERE status = 'report_ready')::int AS report_ready, COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
            COUNT(*) FILTER (WHERE status = ANY($1) AND due_on < CURRENT_DATE)::int AS overdue FROM legal_cases`,
    [OPEN]
  )).rows[0];
  return { cases: r.rows.map((c) => caseView(c, { staff: true })), stats, services: SERVICES.map((k) => ({ value: k, label: SERVICE_LABEL[k] })) };
}

// "Advocate assigned": from the panel, or the client's own chosen advocate.
async function assign(user, id, { professionalId = null, clientAdvocateName = null, note = null }, meta = {}) {
  const c = await caseRow(user, id);
  if (!['requested', 'advocate_assigned'].includes(c.status)) throw badRequest('An advocate can be assigned only before work has started');
  let pro = null;
  let ownName = null;
  if (professionalId) {
    pro = (await pool.query('SELECT * FROM legal_professionals WHERE id = $1', [professionalId])).rows[0];
    if (!pro) throw notFound('Legal professional not found');
    if (pro.status !== 'empanelled' || !pro.lp_code) throw badRequest('Only an empanelled professional with an LP code can be assigned');
    if ((c.service_type === 'valuation') !== (pro.kind === 'valuer')) throw badRequest(c.service_type === 'valuation' ? 'A valuation needs a registered valuer' : 'This case needs an advocate, not a valuer');
  } else {
    ownName = String(clientAdvocateName || '').trim();
    if (ownName.length < 3) throw badRequest("Choose an empanelled professional, or enter the client's own advocate");
  }
  const s = await settings();
  const due = addWorkingDays(new Date(), s.days[c.service_type]);
  await pool.query(
    `UPDATE legal_cases SET professional_id = $2, client_advocate_name = $3, status = 'advocate_assigned', assigned_by = $4, assigned_at = now(), due_on = $5 WHERE id = $1`,
    [id, pro?.id || null, ownName, user.id, due]
  );
  const who = pro ? `${pro.full_name}${pro.firm_name ? `, ${pro.firm_name}` : ''} (${pro.lp_code})` : `${ownName} (client's own advocate)`;
  await event(id, 'advocate_assigned', `${pro?.kind === 'valuer' ? 'Valuer' : 'Advocate'} assigned: ${who}. Expected by ${due}.`, user);
  if (note) await event(id, 'note', String(note).trim(), user, false);
  // The deal's legal coordination panel shows who is on it.
  if (c.deal_id && c.service_type !== 'valuation') await pool.query('UPDATE deals SET legal_advocate = $2 WHERE id = $1', [c.deal_id, (pro ? `${pro.full_name} (${pro.lp_code})` : ownName).slice(0, 150)]);
  await auditService.log({ actor: user, action: 'legal.case_assigned', entityType: 'legal_case', entityId: id, after: { professionalId: pro?.id || null, clientAdvocateName: ownName, due }, ...meta });
  await notify([c.requested_by], { type: 'legal_case', title: `${pro?.kind === 'valuer' ? 'Valuer' : 'Advocate'} assigned to ${c.case_number}`, message: `${who}. Your representative coordinates the next steps with you.` });
  return getCase(user, id);
}

// Hand-off to the advocate: the brief and time-limited links to the linked
// documents, for the representative to pass on. Recorded on the case.
async function handoff(user, id, meta = {}) {
  const c = await caseRow(user, id);
  if (!c.professional_id && !c.client_advocate_name) throw badRequest('Assign an advocate first');
  const pro = c.professional_id ? (await pool.query('SELECT * FROM legal_professionals WHERE id = $1', [c.professional_id])).rows[0] : null;
  const docs = await pool.query(`SELECT d.id, d.document_type, d.file_name, d.document_url FROM legal_case_documents l JOIN documents d ON d.id = l.document_id WHERE l.case_id = $1 ORDER BY d.created_at`, [id]);
  const documents = [];
  for (const d of docs.rows) documents.push({ id: d.id, type: d.document_type, fileName: d.file_name, url: await getReadUrl(d.document_url) });
  if (!c.handed_off_at) {
    await pool.query('UPDATE legal_cases SET handed_off_at = now() WHERE id = $1', [id]);
    await event(id, 'handed_off', `Brief and ${documents.length} document${documents.length === 1 ? '' : 's'} handed to the ${pro?.kind === 'valuer' ? 'valuer' : 'advocate'}.`, user);
  }
  await auditService.log({ actor: user, action: 'legal.case_handoff', entityType: 'legal_case', entityId: id, after: { documents: documents.length }, ...meta });
  const s = await settings();
  return {
    caseNumber: c.case_number, service: SERVICE_LABEL[c.service_type], requirement: c.requirement, dueOn: c.due_on,
    property: c.property_id ? { title: c.property_title, city: c.property_city, locality: c.property_locality } : null,
    advocate: pro ? { name: pro.full_name, firm: pro.firm_name, lpCode: pro.lp_code, email: pro.email, mobile: pro.mobile } : { name: c.client_advocate_name, ownChoice: true },
    // The client's identity goes to the advocate through the representative, not through this pack.
    documents, disclaimer: s.disclaimer,
    note: 'The client engages the advocate directly. A R Buildwel refers and coordinates only; no fee is shared with or received from the advocate.',
  };
}

async function setStatus(user, id, { status, note = null, clientVisible = true, reportDocumentId = undefined }, meta = {}) {
  const c = await caseRow(user, id);
  if (status && status !== c.status) {
    if (!FLOW[c.status].includes(status)) throw badRequest(`A case that is "${c.status.replace(/_/g, ' ')}" cannot move to "${String(status).replace(/_/g, ' ')}"`);
    if (status === 'advocate_assigned') throw badRequest('Use "Assign" to assign an advocate');
    if (status === 'cancelled' && (!note || String(note).trim().length < 5)) throw badRequest('Give the reason for cancelling');
  }
  if (reportDocumentId) {
    if (!(await pool.query('SELECT 1 FROM documents WHERE id = $1', [reportDocumentId])).rows.length) throw notFound('Report document not found');
    await pool.query('INSERT INTO legal_case_documents (case_id, document_id, auto_linked) VALUES ($1, $2, false) ON CONFLICT DO NOTHING', [id, reportDocumentId]);
  }
  const next = status || c.status;
  if (next === 'report_ready' && !(reportDocumentId || c.report_document_id)) throw badRequest('Attach the report document first');
  await pool.query('UPDATE legal_cases SET status = $2, report_document_id = COALESCE($3, report_document_id) WHERE id = $1', [id, next, reportDocumentId || null]);
  if (next !== c.status) await event(id, next, note ? String(note).trim() : null, user, true);
  else if (note) await event(id, 'note', String(note).trim(), user, !!clientVisible);
  else if (!reportDocumentId) throw badRequest('Nothing to update');
  // Exclusive Mandate benefit status follows the case.
  if (c.mandate_id && ['report_ready', 'completed'].includes(next) && ['due_diligence', 'valuation'].includes(c.service_type)) {
    const col = c.service_type === 'valuation' ? 'valuation' : 'due_diligence';
    await pool.query(`UPDATE mandates SET ${col}_status = $2, ${col}_document_id = COALESCE($3, ${col}_document_id) WHERE id = $1`, [c.mandate_id, next === 'completed' ? 'completed' : 'report_uploaded', reportDocumentId || c.report_document_id || null]);
  }
  await auditService.log({ actor: user, action: 'legal.case_updated', entityType: 'legal_case', entityId: id, before: { status: c.status }, after: { status: next, note }, ...meta });
  if (next !== c.status) {
    const text = { in_progress: 'Work has started.', report_ready: 'The report is ready - your representative will take you through it.', completed: 'This legal case is complete.', cancelled: `Cancelled: ${note}` }[next];
    await notify([c.requested_by], { type: 'legal_case', title: `${c.case_number}: ${next.replace(/_/g, ' ')}`, message: text || 'Status updated.' });
  }
  return getCase(user, id);
}

// The client can cancel while nothing has started.
async function cancelMine(user, id, reason, meta = {}) {
  const c = await caseRow(user, id);
  if (c.status !== 'requested') throw badRequest('This case is already with an advocate - ask your representative to cancel it');
  if (c.source === 'mandate') throw forbidden('This case is part of your Exclusive Mandate');
  await pool.query(`UPDATE legal_cases SET status = 'cancelled' WHERE id = $1`, [id]);
  await event(id, 'cancelled', reason ? String(reason).trim().slice(0, 300) : 'Cancelled by the client', user);
  await auditService.log({ actor: user, action: 'legal.case_cancelled', entityType: 'legal_case', entityId: id, ...meta });
  return getCase(user, id);
}

async function linkDocument(user, id, documentId, meta = {}) {
  await caseRow(user, id);
  if (!(await pool.query('SELECT 1 FROM documents WHERE id = $1', [documentId])).rows.length) throw notFound('Document not found');
  await pool.query('INSERT INTO legal_case_documents (case_id, document_id, auto_linked) VALUES ($1, $2, false) ON CONFLICT DO NOTHING', [id, documentId]);
  await event(id, 'document_linked', 'A document was added to the case.', user, false);
  await auditService.log({ actor: user, action: 'legal.case_document_linked', entityType: 'legal_case', entityId: id, after: { documentId }, ...meta });
  return getCase(user, id);
}

// Cases for one deal - shown on the deal's legal coordination panel.
async function forDeal(dealId) {
  const r = await pool.query(`${CASE_SELECT} WHERE c.deal_id = $1 ORDER BY c.created_at DESC`, [dealId]);
  return r.rows.map((c) => caseView(c, { staff: true }));
}

module.exports = {
  SERVICES, SERVICE_LABEL, SPECIALITIES, settings, addWorkingDays,
  listProfessionals, saveProfessional, decideProfessional,
  requestCase, openCase, onLegalEnquiry, onMandateActivated, getCase, myCases, listCases, assign, handoff, setStatus, cancelMine, linkDocument, forDeal,
};
