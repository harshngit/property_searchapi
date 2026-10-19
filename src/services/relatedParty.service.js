const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const notificationService = require('./notification.service');
const { panHash, PAN_RE } = require('./tax.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Contract sec. 33.12 - Employee-as-User conflict-of-interest safeguards.
// Most of it lives in the database (migration 079) so no role can switch it off:
//   - an account whose mobile / PAN matches an employee or their disclosed
//     family is employee_linked_account (on registration, or when the mobile
//     or PAN changes);
//   - a listing, inquiry or deal with such a party is tagged
//     related_party_transaction the moment the parties are on record, and the
//     detection is logged append-only;
//   - the employee can never be set as its representative.
// Here: employees disclose their family, identity changes trigger a re-check
// (and an inquiry already with the now-linked employee is re-routed), and the
// Compliance Dashboard lists every flagged transaction for review. A flagged
// transaction is not blocked - an employee buying or selling is not wrong in
// itself. An undisclosed one is a Section 35 matter for the Super Admin.

const RELATIONS = ['self', 'spouse', 'parent', 'child'];
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const OPEN_LEAD = `status::text NOT IN ('won', 'lost')`;
const mobile10 = (m) => {
  const d = String(m || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

async function isEmployee(userId) {
  return (await pool.query(`SELECT 1 FROM rp_employees WHERE employee_id = $1`, [userId])).rows.length > 0;
}

async function reviewers() {
  const roles = await configService.getConfig('compliance.related_party_reviewers', ['super_admin', 'admin']);
  return Array.isArray(roles) && roles.length ? roles : ['super_admin'];
}
async function assertReviewer(user) {
  if (!(await reviewers()).includes(user.role)) throw forbidden('The related-party dashboard is for the Super Admin and City Heads');
}

// ---------------------------------------------------------------- re-check

// Re-tag everything after an identity change, then move any open inquiry
// still with a now-linked employee to someone else.
async function rescan(reason = 'scheduled') {
  const changed = (await pool.query('SELECT rp_rescan() AS n')).rows[0].n;
  const stuck = (await pool.query(`SELECT id FROM leads WHERE related_party_transaction AND arb_rep_id = ANY(related_party_employee_ids) AND ${OPEN_LEAD}`)).rows;
  const assignment = require('./assignment.service');
  for (const l of stuck) {
    await assignment.route(l.id, { reason: 'related_party' }).catch((err) => console.error('[related-party] re-route failed:', err.message));
  }
  // A deal not tied to an inquiry with the linked employee as its rep: the reviewers are told.
  const deals = (await pool.query(`SELECT id FROM deals WHERE related_party_transaction AND assigned_rep_id = ANY(related_party_employee_ids) AND lead_id IS NULL AND stage NOT IN ('closed_won', 'closed_lost')`)).rows;
  if (deals.length) await notifyReviewers({ title: `${deals.length} related-party deal(s) are with the linked employee`, message: 'Open the Compliance Dashboard and reassign them.' });
  return { changed, rerouted: stuck.length, dealsToReassign: deals.length, reason };
}

// Alerts go out in the background - never holding up the request.
function alert(roles, n) {
  (async () => {
    const ids = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ANY($1) AND u.status = 'active'`, [roles])).rows.map((r) => r.id);
    for (const id of ids) await notificationService.createNotification({ userId: id, type: 'related_party', ...n }).catch(() => {});
  })().catch((err) => console.error('[related-party] alert failed:', err.message));
}

async function notifyReviewers({ title, message, entityType = null, entityId = null }) {
  alert(await reviewers(), { title, message, priority: 'high', relatedEntityType: entityType, relatedEntityId: entityId });
}

// ---------------------------------------------------------------- disclosures

const disclosureView = (d) => ({
  id: d.id, employeeId: d.employee_id, employeeName: d.employee_name, relation: d.relation, fullName: d.full_name,
  mobile: d.mobile10 ? `••••••${d.mobile10.slice(-4)}` : null, panLast4: d.pan_last4, createdAt: d.created_at,
  removedAt: d.removed_at, removalNote: d.removal_note,
});

async function myDisclosures(user) {
  if (!(await isEmployee(user.id))) throw forbidden('Disclosures are for A R Buildwel employees');
  const r = await pool.query(`SELECT d.*, u.full_name AS employee_name FROM employee_disclosures d JOIN users u ON u.id = d.employee_id WHERE d.employee_id = $1 ORDER BY d.removed_at NULLS FIRST, d.created_at`, [user.id]);
  return { disclosures: r.rows.map(disclosureView), relations: RELATIONS };
}

// An employee discloses their own PAN or an immediate family member's
// mobile / PAN; an admin may record one for any employee.
async function addDisclosure(user, data = {}, meta = {}) {
  const employeeId = data.employeeId && data.employeeId !== user.id ? data.employeeId : user.id;
  if (employeeId !== user.id && !['admin', 'super_admin'].includes(user.role)) throw forbidden('You can disclose only your own family');
  if (!(await isEmployee(employeeId))) throw badRequest('Disclosures are recorded for active employees only');
  const relation = String(data.relation || '');
  if (!RELATIONS.includes(relation)) throw badRequest(`relation must be one of: ${RELATIONS.join(', ')}`);
  const m = data.mobile ? mobile10(data.mobile) : null;
  if (data.mobile && !m) throw badRequest('Give a 10-digit mobile number');
  const pan = data.pan ? String(data.pan).trim().toUpperCase() : null;
  if (pan && !PAN_RE.test(pan)) throw badRequest('Give a valid PAN (e.g. ABCDE1234F)');
  if (!m && !pan) throw badRequest('Give the mobile number, the PAN, or both');
  if (relation === 'self' && m) throw badRequest('Your own mobile is already on your account - disclose your PAN here');
  if (relation !== 'self' && (!data.fullName || String(data.fullName).trim().length < 2)) throw badRequest("Give the family member's name");
  const r = (await pool.query(
    `INSERT INTO employee_disclosures (employee_id, relation, full_name, mobile10, pan_hash, pan_last4, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [employeeId, relation, data.fullName ? String(data.fullName).trim().slice(0, 150) : null, m, pan ? panHash(pan) : null, pan ? pan.slice(-4) : null, user.id]
  )).rows[0];
  await auditService.log({ actor: user, action: 'related_party.disclosure_added', entityType: 'employee_disclosure', entityId: r.id, after: { employeeId, relation, mobileLast4: m ? m.slice(-4) : null, panLast4: r.pan_last4 }, ...meta });
  const scan = await rescan('disclosure');
  return { disclosure: disclosureView(r), scan };
}

// A disclosure is withdrawn (e.g. a number changed hands), never deleted.
async function withdrawDisclosure(user, id, { note } = {}, meta = {}) {
  const d = (await pool.query('SELECT * FROM employee_disclosures WHERE id = $1', [id])).rows[0];
  if (!d || d.removed_at) throw notFound('Disclosure not found');
  if (d.employee_id !== user.id && !['admin', 'super_admin'].includes(user.role)) throw forbidden();
  if (!note || String(note).trim().length < 5) throw badRequest('Say why it is withdrawn');
  await pool.query('UPDATE employee_disclosures SET removed_at = now(), removed_by = $2, removal_note = $3 WHERE id = $1', [id, user.id, String(note).trim().slice(0, 300)]);
  await auditService.log({ actor: user, action: 'related_party.disclosure_withdrawn', entityType: 'employee_disclosure', entityId: id, after: { note }, ...meta });
  await rescan('disclosure_withdrawn');
  return { withdrawn: true };
}

async function allDisclosures(user, { employeeId = null } = {}) {
  await assertReviewer(user);
  const r = await pool.query(`SELECT d.*, u.full_name AS employee_name FROM employee_disclosures d JOIN users u ON u.id = d.employee_id ${employeeId ? 'WHERE d.employee_id = $1' : ''} ORDER BY u.full_name, d.created_at`, employeeId ? [employeeId] : []);
  return r.rows.map(disclosureView);
}

// ---------------------------------------------------------------- dashboard

const ENTITY = {
  property: { table: 'properties', title: `COALESCE(e.title, 'Listing')`, city: 'e.city', open: `e.status::text IN ('draft', 'pending_approval', 'approved')`, rep: 'NULL::uuid', link: (id) => `/app/properties/${id}` },
  lead: { table: 'leads', title: `'Inquiry' || COALESCE(' - ' || (SELECT title FROM properties WHERE id = e.property_id), '')`, city: '(SELECT city FROM properties WHERE id = e.property_id)', open: `e.status::text NOT IN ('won', 'lost')`, rep: 'e.arb_rep_id', link: (id) => `/app/leads/${id}` },
  deal: { table: 'deals', title: `'Deal' || COALESCE(' - ' || (SELECT title FROM properties WHERE id = e.property_id), '')`, city: '(SELECT city FROM properties WHERE id = e.property_id)', open: `e.stage::text NOT IN ('closed_won', 'closed_lost')`, rep: 'e.assigned_rep_id', link: (id) => `/app/deals/${id}` },
};

async function dashboard(user, { entityType = null, review = 'open', q = null } = {}) {
  await assertReviewer(user);
  const kinds = entityType ? [entityType] : Object.keys(ENTITY);
  const rows = [];
  for (const k of kinds) {
    const e = ENTITY[k];
    if (!e) throw badRequest('entityType must be property, lead or deal');
    const r = await pool.query(
      `SELECT e.id, ${e.title} AS title, ${e.city} AS city, ${e.open} AS is_open, ${e.rep} AS rep_id, e.related_party_employee_ids AS employee_ids, e.created_at,
              (SELECT MIN(detected_at) FROM related_party_log g WHERE g.entity_type = $1 AND g.entity_id = e.id) AS detected_at,
              (SELECT row_to_json(x) FROM (SELECT v.outcome, v.note, v.reviewed_at, ru.full_name AS reviewer FROM related_party_reviews v LEFT JOIN users ru ON ru.id = v.reviewed_by WHERE v.entity_type = $1 AND v.entity_id = e.id ORDER BY v.reviewed_at DESC LIMIT 1) x) AS last_review
       FROM ${e.table} e WHERE e.related_party_transaction ORDER BY e.created_at DESC LIMIT 500`,
      [k]
    );
    for (const x of r.rows) rows.push({ ...x, entity_type: k });
  }
  const empIds = [...new Set(rows.flatMap((x) => x.employee_ids))];
  const names = Object.fromEntries((await pool.query(
    `SELECT u.id, u.full_name, r.name AS role, ar.designation FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN arb_representatives ar ON ar.user_id = u.id WHERE u.id = ANY($1::uuid[])`, [empIds]
  )).rows.map((u) => [u.id, { name: u.full_name, role: u.role, designation: u.designation }]));
  let items = rows.map((x) => ({
    entityType: x.entity_type, id: x.id, title: x.title, city: x.city, open: x.is_open, link: ENTITY[x.entity_type].link(x.id),
    employees: x.employee_ids.map((id) => ({ id, ...(names[id] || { name: 'Former employee' }) })),
    // The one thing that must never happen: the linked employee holding it.
    selfAssigned: !!x.rep_id && x.employee_ids.includes(x.rep_id),
    detectedAt: x.detected_at || x.created_at, lastReview: x.last_review,
  }));
  if (review === 'open') items = items.filter((i) => !i.lastReview);
  if (q) {
    const s = String(q).toLowerCase();
    items = items.filter((i) => `${i.title} ${i.city || ''} ${i.employees.map((e) => e.name).join(' ')}`.toLowerCase().includes(s));
  }
  items.sort((a, b) => Number(b.selfAssigned) - Number(a.selfAssigned) || new Date(b.detectedAt) - new Date(a.detectedAt));
  const summary = (await pool.query(
    `SELECT (SELECT COUNT(*) FROM users WHERE employee_linked_account)::int AS linked_accounts,
            (SELECT COUNT(*) FROM properties WHERE related_party_transaction)::int AS listings,
            (SELECT COUNT(*) FROM leads WHERE related_party_transaction)::int AS inquiries,
            (SELECT COUNT(*) FROM deals WHERE related_party_transaction)::int AS deals,
            (SELECT COUNT(*) FROM employee_disclosures WHERE removed_at IS NULL)::int AS disclosures,
            (SELECT COUNT(DISTINCT (entity_type, entity_id)) FROM related_party_log WHERE detected_at > now() - interval '30 days')::int AS detected_30d`
  )).rows[0];
  return { summary, items: items.slice(0, 300) };
}

// Accounts linked to an employee - who and why (mobile or PAN, and the relation).
async function linkedAccounts(user) {
  await assertReviewer(user);
  const r = await pool.query(
    `SELECT u.id, u.full_name, r.name AS role, u.created_at, u.employee_link_ids,
            (SELECT array_agg(DISTINCT d.relation) FROM employee_disclosures d LEFT JOIN payee_tax_profiles t ON t.user_id = u.id
             WHERE d.removed_at IS NULL AND d.employee_id = ANY(u.employee_link_ids) AND ((d.mobile10 IS NOT NULL AND d.mobile10 = rp_mobile10(u.mobile)) OR (d.pan_hash IS NOT NULL AND d.pan_hash = t.pan_hash))) AS relations
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.employee_linked_account ORDER BY u.created_at DESC LIMIT 500`
  );
  const empIds = [...new Set(r.rows.flatMap((x) => x.employee_link_ids))];
  const names = Object.fromEntries((await pool.query('SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])', [empIds])).rows.map((u) => [u.id, u.full_name]));
  return r.rows.map((x) => ({
    id: x.id, name: x.full_name, role: x.role, since: x.created_at,
    employees: x.employee_link_ids.map((id) => ({ id, name: names[id] || 'Former employee' })),
    // No disclosure behind the link means it matched the employee's own mobile.
    via: x.relations?.length ? x.relations : ['self'],
  }));
}

async function history(user, entityType, id) {
  await assertReviewer(user);
  if (!ENTITY[entityType]) throw badRequest('entityType must be property, lead or deal');
  const [log, reviews, events] = await Promise.all([
    pool.query('SELECT employee_ids, detected_at FROM related_party_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY detected_at', [entityType, id]),
    pool.query('SELECT v.outcome, v.note, v.reviewed_at, u.full_name AS reviewer FROM related_party_reviews v LEFT JOIN users u ON u.id = v.reviewed_by WHERE v.entity_type = $1 AND v.entity_id = $2 ORDER BY v.reviewed_at', [entityType, id]),
    entityType === 'lead' ? pool.query(`SELECT kind, detail, created_at FROM lead_assignment_events WHERE lead_id = $1 AND kind IN ('rp_rerouted', 'rp_escalated') ORDER BY created_at`, [id]) : { rows: [] },
  ]);
  return { detections: log.rows, reviews: reviews.rows, cascade: events.rows };
}

// City Head / Super Admin review - recorded, never edited.
async function review(user, entityType, id, { outcome, note } = {}, meta = {}) {
  await assertReviewer(user);
  if (!ENTITY[entityType]) throw badRequest('entityType must be property, lead or deal');
  if (!['disclosed_ok', 'undisclosed', 'not_related', 'noted'].includes(outcome)) throw badRequest('outcome must be disclosed_ok, undisclosed, not_related or noted');
  if (!note || String(note).trim().length < 5) throw badRequest('Record what was checked');
  const row = (await pool.query(`SELECT related_party_employee_ids AS ids FROM ${ENTITY[entityType].table} WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound();
  await pool.query('INSERT INTO related_party_reviews (entity_type, entity_id, outcome, note, reviewed_by) VALUES ($1, $2, $3, $4, $5)', [entityType, id, outcome, String(note).trim().slice(0, 2000), user.id]);
  await auditService.log({ actor: user, action: 'related_party.reviewed', entityType, entityId: id, after: { outcome, note, employees: row.ids }, ...meta });
  // Undisclosed: a policy violation under Section 35, decided by the Super Admin.
  if (outcome === 'undisclosed') {
    alert(['super_admin'], { title: 'Undisclosed related-party transaction', message: 'Reviewed as undisclosed - a Section 35 decision on the employee is needed.', priority: 'critical', relatedEntityType: entityType, relatedEntityId: id });
  }
  return history(user, entityType, id);
}

let timer = null;
function startScheduler() {
  if (timer) return;
  // Staff joining or leaving, roles changing: re-check twice an hour.
  timer = setInterval(() => rescan().catch((err) => console.error('[related-party] rescan failed:', err.message)), 30 * 60 * 1000);
  timer.unref?.();
}

module.exports = { RELATIONS, isEmployee, assertReviewer, rescan, myDisclosures, addDisclosure, withdrawDisclosure, allDisclosures, dashboard, linkedAccounts, history, review, startScheduler };
