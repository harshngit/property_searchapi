const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { assertCleanContent } = require('../utils/contentGuard');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 5 - Dispute Resolution System + sec. 9.6 client / lead conflicts
// + the Advanced Audit Layer's dispute reconstruction.
//   - Any party can open a case (broker dispute, duplicate listing, fake
//     claim, institutional data access, lead conflict, commission, review)
//     with evidence; the case timeline is append-only.
//   - A R admins resolve within 48 h (configurable); overdue cases escalate.
//   - Reconstruction merges the case timeline with every audit log, lead
//     activity, note, deal stage change, site visit and WhatsApp message on
//     the linked listing / lead / deal - the "full message timeline".
//   - Lead conflicts: the same buyer's phone in two brokers' CRMs. The later
//     broker picks mandate-verification routing, a different property or a
//     transfer; commission attribution is traced from the immutable logs.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const BROKER_ROLES = ['broker', 'agency_admin'];
const OPEN = ['open', 'under_review', 'awaiting_info'];
const phoneKey = (m) => {
  const d = String(m || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

async function slaHours() {
  return Number(await configService.getConfig('disputes.sla_hours', 48)) || 48;
}

async function admins() {
  const r = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
  return r.rows.map((x) => x.id);
}

async function notifyMany(userIds, title, message, disputeId) {
  for (const userId of [...new Set(userIds.filter(Boolean))]) {
    await notificationService.createNotification({ userId, type: 'dispute', title, message, relatedEntityType: 'dispute', relatedEntityId: disputeId }).catch(() => {});
  }
}

async function addEvent(disputeId, actorId, kind, body, { attachments = [], visibility = 'parties' } = {}) {
  await pool.query(
    `INSERT INTO dispute_events (dispute_id, actor_id, kind, body, attachments, visibility) VALUES ($1, $2, $3, $4, $5, $6)`,
    [disputeId, actorId || null, kind, body || null, JSON.stringify(attachments), visibility]
  );
}

// ----------------------------------------------------------------- disputes

async function openDispute(user, data, meta = {}) {
  const { type, title, description, againstUserId, propertyId, dealId, leadId, leadConflictId, priority, attachments = [] } = data;
  await assertCleanContent({ title, description }, { blockContact: true });
  if (againstUserId && againstUserId === user.id) throw badRequest('You cannot raise a dispute against yourself');
  // Institutional data-room disputes must reference the listing.
  if (type === 'institutional_data_access' && !propertyId) throw badRequest('Choose the listing whose data room this is about');
  const n = (await pool.query(`SELECT nextval('dispute_number_seq') AS n`)).rows[0].n;
  const caseNumber = `DSP-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
  const hours = await slaHours();
  const r = await pool.query(
    `INSERT INTO disputes (case_number, type, title, description, raised_by, against_user_id, property_id, deal_id, lead_id, lead_conflict_id, priority, sla_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + ($12 || ' hours')::interval) RETURNING *`,
    [caseNumber, type, title, description, user.id, againstUserId || null, propertyId || null, dealId || null, leadId || null, leadConflictId || null, priority || 'normal', String(hours)]
  );
  const d = r.rows[0];
  await addEvent(d.id, user.id, 'created', description, { attachments });
  await auditService.log({ actor: user, action: 'dispute.opened', entityType: 'dispute', entityId: d.id, after: { caseNumber, type }, ...meta });
  await notifyMany(await admins(), `New dispute ${caseNumber}`, `${title} - resolve within ${hours} hours.`, d.id);
  if (d.against_user_id) {
    await notifyMany([d.against_user_id], `A dispute was raised involving you (${caseNumber})`, `${title}. You can respond with your side and evidence.`, d.id);
  }
  require('./trust.service').safeRecompute(d.against_user_id, 'dispute_opened');
  return d;
}

function canSee(user, d) {
  return STAFF.includes(user.role) || d.raised_by === user.id || d.against_user_id === user.id;
}

async function getDispute(user, id) {
  const d = (
    await pool.query(
      `SELECT d.*, ur.full_name AS raised_by_name, ua.full_name AS against_name, uas.full_name AS assigned_name, p.title AS property_title
       FROM disputes d JOIN users ur ON ur.id = d.raised_by LEFT JOIN users ua ON ua.id = d.against_user_id
       LEFT JOIN users uas ON uas.id = d.assigned_to LEFT JOIN properties p ON p.id = d.property_id
       WHERE d.id = $1`,
      [id]
    )
  ).rows[0];
  if (!d) throw notFound('Dispute not found');
  if (!canSee(user, d)) throw forbidden('Not a party to this dispute');
  const staff = STAFF.includes(user.role);
  const events = await pool.query(
    `SELECT e.id, e.kind, e.body, e.attachments, e.visibility, e.created_at, u.full_name AS actor_name, e.actor_id
     FROM dispute_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.dispute_id = $1 AND ($2 OR e.visibility = 'parties') ORDER BY e.created_at ASC`,
    [id, staff]
  );
  return { ...d, overdue: OPEN.includes(d.status) && new Date(d.sla_due_at) < new Date(), timeline: events.rows };
}

async function listDisputes(user, { status, type, mine } = {}) {
  const where = [];
  const params = [];
  if (!STAFF.includes(user.role) || mine === 'true') {
    params.push(user.id);
    where.push(`(d.raised_by = $${params.length} OR d.against_user_id = $${params.length})`);
  }
  if (status === 'open') where.push(`d.status IN ('open', 'under_review', 'awaiting_info')`);
  else if (status) {
    params.push(status);
    where.push(`d.status = $${params.length}`);
  }
  if (type) {
    params.push(type);
    where.push(`d.type = $${params.length}`);
  }
  const r = await pool.query(
    `SELECT d.id, d.case_number, d.type, d.title, d.status, d.priority, d.sla_due_at, d.created_at, d.resolved_at, d.escalated_at,
            ur.full_name AS raised_by_name, ua.full_name AS against_name, uas.full_name AS assigned_name, p.title AS property_title,
            (d.status IN ('open', 'under_review', 'awaiting_info') AND d.sla_due_at < now()) AS overdue
     FROM disputes d JOIN users ur ON ur.id = d.raised_by LEFT JOIN users ua ON ua.id = d.against_user_id
     LEFT JOIN users uas ON uas.id = d.assigned_to LEFT JOIN properties p ON p.id = d.property_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY (d.status IN ('open', 'under_review', 'awaiting_info')) DESC, d.sla_due_at ASC LIMIT 300`,
    params
  );
  return r.rows;
}

async function comment(user, id, { body, attachments = [], internal = false }, meta = {}) {
  const d = await getDispute(user, id);
  if (!OPEN.includes(d.status)) throw badRequest('This dispute is closed');
  if (internal && !STAFF.includes(user.role)) throw forbidden('Internal notes are for A R staff');
  await assertCleanContent({ body }, { blockContact: true });
  await addEvent(id, user.id, attachments.length && !body ? 'evidence' : 'comment', body, { attachments, visibility: internal ? 'internal' : 'parties' });
  // A party replying moves an awaiting-info case back to review.
  if (d.status === 'awaiting_info' && !STAFF.includes(user.role)) {
    await pool.query(`UPDATE disputes SET status = 'under_review' WHERE id = $1`, [id]);
    await addEvent(id, null, 'status', 'Party responded - back under review', { visibility: 'parties' });
  }
  if (!internal) {
    const others = [d.raised_by, d.against_user_id, d.assigned_to].filter((u) => u && u !== user.id);
    await notifyMany(others, `Update on ${d.case_number}`, (body || 'New evidence added').slice(0, 140), id);
  }
  await auditService.log({ actor: user, action: 'dispute.comment', entityType: 'dispute', entityId: id, after: { internal }, ...meta });
  return getDispute(user, id);
}

async function update(user, id, { status, assignedTo, priority, note }, meta = {}) {
  const d = await getDispute(user, id);
  const set = [];
  const params = [];
  if (status) {
    if (!['under_review', 'awaiting_info', 'closed'].includes(status)) throw badRequest('Use resolve to resolve or dismiss');
    params.push(status);
    set.push(`status = $${params.length}`);
  }
  if (assignedTo) {
    params.push(assignedTo);
    set.push(`assigned_to = $${params.length}`);
  }
  if (priority) {
    params.push(priority);
    set.push(`priority = $${params.length}`);
  }
  if (!set.length) throw badRequest('Nothing to update');
  params.push(id);
  await pool.query(`UPDATE disputes SET ${set.join(', ')} WHERE id = $${params.length}`, params);
  if (status) await addEvent(id, user.id, 'status', `Status: ${status.replace('_', ' ')}${note ? ` - ${note}` : ''}`);
  if (assignedTo) await addEvent(id, user.id, 'assignment', 'Case assigned', { visibility: 'internal' });
  if (status === 'awaiting_info') await notifyMany([d.raised_by, d.against_user_id], `More information needed on ${d.case_number}`, note || 'Please add your details or evidence.', id);
  await auditService.log({ actor: user, action: 'dispute.updated', entityType: 'dispute', entityId: id, before: { status: d.status }, after: { status, assignedTo, priority }, ...meta });
  return getDispute(user, id);
}

async function resolve(user, id, { decision, resolution, inFavourOf, outcome = {} }, meta = {}) {
  const d = await getDispute(user, id);
  if (!OPEN.includes(d.status)) throw badRequest('Already closed');
  if (!resolution) throw badRequest('Write the resolution');
  const status = decision === 'dismiss' ? 'dismissed' : 'resolved';
  await pool.query(
    `UPDATE disputes SET status = $1, resolution = $2, in_favour_of = $3, outcome = $4, resolved_by = $5, resolved_at = now() WHERE id = $6`,
    [status, resolution, inFavourOf || null, JSON.stringify(outcome), user.id, id]
  );
  await addEvent(id, user.id, 'resolution', resolution);
  // Lead conflict decided by admin.
  if (d.lead_conflict_id) {
    await pool.query(
      `UPDATE lead_conflicts SET status = 'resolved', resolution = 'admin_decided', resolution_detail = $1, resolved_at = now() WHERE id = $2`,
      [JSON.stringify({ disputeId: id, inFavourOf, ...outcome }), d.lead_conflict_id]
    );
  }
  await notifyMany([d.raised_by, d.against_user_id], `${d.case_number} ${status}`, resolution.slice(0, 200), id);
  await auditService.log({ actor: user, action: `dispute.${status}`, entityType: 'dispute', entityId: id, after: { resolution, inFavourOf, outcome }, ...meta });
  require('./trust.service').safeRecompute(d.against_user_id, 'dispute_closed');
  return getDispute(user, id);
}

// Full action trail for the case (Advanced Audit Layer).
async function reconstruct(user, id) {
  if (!STAFF.includes(user.role)) throw forbidden('A R staff only');
  const d = await getDispute(user, id);
  const events = [];
  const push = (rows, source, map) => rows.forEach((r) => events.push({ source, at: r.created_at || r.at, ...map(r) }));
  push(d.timeline, 'case', (e) => ({ actor: e.actor_name, action: e.kind, detail: e.body, visibility: e.visibility }));

  const entityIds = [d.property_id, d.deal_id, d.lead_id, d.id].filter(Boolean);
  const audits = await pool.query(
    `SELECT a.created_at, a.action, a.entity_type, a.after_json, u.full_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.entity_id = ANY($1::text[]) ORDER BY a.created_at`,
    [entityIds.map(String)]
  );
  push(audits.rows, 'audit', (r) => ({ actor: r.full_name, action: r.action, detail: r.entity_type }));

  // Leads: the linked lead, the conflict's two leads, and deals' leads.
  const leadIds = new Set([d.lead_id].filter(Boolean));
  if (d.lead_conflict_id) {
    const c = (await pool.query('SELECT first_lead_id, later_lead_id FROM lead_conflicts WHERE id = $1', [d.lead_conflict_id])).rows[0];
    if (c) {
      leadIds.add(c.first_lead_id);
      leadIds.add(c.later_lead_id);
    }
  }
  if (d.deal_id) {
    const l = (await pool.query('SELECT lead_id FROM deals WHERE id = $1', [d.deal_id])).rows[0];
    if (l?.lead_id) leadIds.add(l.lead_id);
  }
  const ids = [...leadIds];
  if (ids.length) {
    const [acts, notes, msgs] = await Promise.all([
      pool.query(`SELECT a.created_at, a.action, a.details, a.lead_id, u.full_name FROM lead_activity_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ANY($1::uuid[])`, [ids]),
      pool.query(`SELECT n.created_at, n.note, n.lead_id, u.full_name FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.lead_id = ANY($1::uuid[])`, [ids]),
      pool.query(
        `SELECT created_at, direction, COALESCE(message_body, template_name) AS content, lead_id FROM whatsapp_conversations WHERE lead_id = ANY($1::uuid[])`,
        [ids]
      ),
    ]);
    push(acts.rows, 'lead', (r) => ({ actor: r.full_name, action: r.action, detail: JSON.stringify(r.details), leadId: r.lead_id }));
    push(notes.rows, 'note', (r) => ({ actor: r.full_name, action: 'note', detail: r.note, leadId: r.lead_id }));
    push(msgs.rows, 'whatsapp', (r) => ({ actor: r.direction === 'inbound' ? 'Customer' : 'Platform', action: `whatsapp_${r.direction}`, detail: r.content, leadId: r.lead_id }));
  }
  const dealIds = d.deal_id ? [d.deal_id] : ids.length ? (await pool.query('SELECT id FROM deals WHERE lead_id = ANY($1::uuid[])', [ids])).rows.map((x) => x.id) : [];
  if (dealIds.length) {
    const [stages, visits] = await Promise.all([
      pool.query(`SELECT h.created_at, h.from_stage, h.to_stage, h.notes, u.full_name FROM deal_stage_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.deal_id = ANY($1::uuid[])`, [dealIds]),
      pool.query(`SELECT v.created_at, v.status, v.scheduled_at, u.full_name FROM site_visits v LEFT JOIN users u ON u.id = v.created_by WHERE v.deal_id = ANY($1::uuid[])`, [dealIds]),
    ]);
    push(stages.rows, 'deal', (r) => ({ actor: r.full_name, action: `stage_${r.to_stage}`, detail: `${r.from_stage || '-'} -> ${r.to_stage}${r.notes ? `: ${r.notes}` : ''}` }));
    push(visits.rows, 'visit', (r) => ({ actor: r.full_name, action: `site_visit_${r.status}`, detail: `Scheduled ${new Date(r.scheduled_at).toISOString()}` }));
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { dispute: { id: d.id, caseNumber: d.case_number, type: d.type, status: d.status }, events };
}

// Hourly: escalate overdue cases to every admin once.
async function escalateOverdue() {
  const r = await pool.query(
    `UPDATE disputes SET escalated_at = now(), priority = CASE WHEN priority IN ('low', 'normal') THEN 'high' ELSE priority END
     WHERE status IN ('open', 'under_review', 'awaiting_info') AND sla_due_at < now() AND escalated_at IS NULL RETURNING id, case_number, title`
  );
  const adminIds = r.rows.length ? await admins() : [];
  for (const d of r.rows) {
    await addEvent(d.id, null, 'system', 'SLA missed - escalated', { visibility: 'internal' });
    await notifyMany(adminIds, `Dispute ${d.case_number} is overdue`, d.title, d.id);
  }
  return { escalated: r.rows.length };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => escalateOverdue().catch((err) => console.error('[disputes] escalation failed:', err.message)), 60 * 60 * 1000);
}

// -------------------------------------------------------- lead conflicts

// The broker who "owns" a lead: its assignee if a broker, else its creator
// if a broker. A R staff leads are not broker conflicts.
async function brokerOf(lead) {
  const ids = [lead.assigned_to, lead.created_by].filter(Boolean);
  if (!ids.length) return null;
  const r = await pool.query(`SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ANY($1::uuid[])`, [ids]);
  const byId = Object.fromEntries(r.rows.map((x) => [x.id, x.role]));
  if (lead.assigned_to && BROKER_ROLES.includes(byId[lead.assigned_to])) return lead.assigned_to;
  if (lead.created_by && BROKER_ROLES.includes(byId[lead.created_by])) return lead.created_by;
  return null;
}

// Called after a lead is created or re-assigned.
async function detectLeadConflict(leadId) {
  try {
    const lead = (
      await pool.query(`SELECT l.*, c.mobile FROM leads l JOIN customers c ON c.id = l.customer_id WHERE l.id = $1`, [leadId])
    ).rows[0];
    if (!lead) return null;
    const key = phoneKey(lead.mobile);
    const laterBroker = await brokerOf(lead);
    if (!key || !laterBroker) return null;
    const days = Number(await configService.getConfig('lead_conflicts.lookback_days', 90)) || 90;
    const others = await pool.query(
      `SELECT l.* FROM leads l JOIN customers c ON c.id = l.customer_id
       WHERE l.id <> $1 AND right(regexp_replace(COALESCE(c.mobile, ''), '\\D', '', 'g'), 10) = $2
         AND l.created_at < $3 AND l.created_at > now() - ($4 || ' days')::interval
         AND l.status NOT IN ('won', 'lost')
       ORDER BY l.created_at ASC`,
      [leadId, key, lead.created_at, String(days)]
    );
    for (const first of others.rows) {
      const firstBroker = await brokerOf(first);
      if (!firstBroker || firstBroker === laterBroker) continue;
      const ins = await pool.query(
        `INSERT INTO lead_conflicts (phone_key, first_lead_id, later_lead_id, first_broker_id, later_broker_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (first_lead_id, later_lead_id) DO NOTHING RETURNING *`,
        [key, first.id, lead.id, firstBroker, laterBroker]
      );
      const c = ins.rows[0];
      if (!c) return null;
      await notificationService.createNotification({
        userId: laterBroker,
        type: 'lead_conflict',
        title: 'This buyer is already with another broker',
        message: 'Another broker registered this buyer first. Choose: mandate-verification routing (work together), work a different property, or transfer the lead.',
        relatedEntityType: 'lead',
        relatedEntityId: lead.id,
      });
      await notificationService.createNotification({
        userId: firstBroker,
        type: 'lead_conflict',
        title: 'Your buyer was registered by another broker',
        message: 'A second broker added the same buyer. You keep priority as the first contact; they have been asked to choose routing, a different property or a transfer.',
        relatedEntityType: 'lead',
        relatedEntityId: first.id,
      });
      return c;
    }
    return null;
  } catch (err) {
    console.error(`[lead-conflict] ${leadId}:`, err.message);
    return null;
  }
}

async function getConflict(user, id) {
  const c = (
    await pool.query(
      `SELECT lc.*, fb.full_name AS first_broker_name, lb.full_name AS later_broker_name
       FROM lead_conflicts lc JOIN users fb ON fb.id = lc.first_broker_id JOIN users lb ON lb.id = lc.later_broker_id WHERE lc.id = $1`,
      [id]
    )
  ).rows[0];
  if (!c) throw notFound('Conflict not found');
  if (!STAFF.includes(user.role) && ![c.first_broker_id, c.later_broker_id].includes(user.id)) throw forbidden('Not your conflict');
  return c;
}

async function listConflicts(user, { status } = {}) {
  const params = [];
  const where = [];
  if (!STAFF.includes(user.role)) {
    params.push(user.id);
    where.push(`(lc.first_broker_id = $1 OR lc.later_broker_id = $1)`);
  }
  if (status) {
    params.push(status);
    where.push(`lc.status = $${params.length}`);
  }
  const r = await pool.query(
    `SELECT lc.*, fb.full_name AS first_broker_name, lb.full_name AS later_broker_name, c.full_name AS customer_name,
            (lc.later_broker_id = $${params.length + 1}) AS i_am_later
     FROM lead_conflicts lc JOIN users fb ON fb.id = lc.first_broker_id JOIN users lb ON lb.id = lc.later_broker_id
     JOIN leads l ON l.id = lc.later_lead_id JOIN customers c ON c.id = l.customer_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lc.created_at DESC LIMIT 200`,
    [...params, user.id]
  );
  // Brokers see a masked buyer name (first name only) - contact stays with A R.
  return r.rows.map((x) => (STAFF.includes(user.role) ? x : { ...x, customer_name: String(x.customer_name || '').split(' ')[0] }));
}

// The later broker's choice (sec. 9.6); the first broker answers routing.
async function resolveConflict(user, id, { action, propertyId, note }, meta = {}) {
  const c = await getConflict(user, id);
  if (!['open', 'routing_requested'].includes(c.status)) throw badRequest('Already resolved');
  if (action === 'accept_routing' || action === 'decline_routing') {
    if (c.first_broker_id !== user.id && !ADMIN.includes(user.role)) throw forbidden('Only the first broker answers a routing request');
    if (c.status !== 'routing_requested') throw badRequest('No routing request pending');
    const accepted = action === 'accept_routing';
    await pool.query(
      `UPDATE lead_conflicts SET status = 'resolved', resolution = $1, resolution_detail = resolution_detail || $2, resolved_at = now() WHERE id = $3`,
      [accepted ? 'mandate_routing' : 'routing_declined', JSON.stringify({ answeredBy: user.id, split: accepted ? { first: 50, later: 50 } : null }), id]
    );
    await notificationService.createNotification({
      userId: c.later_broker_id,
      type: 'lead_conflict',
      title: accepted ? 'Routing accepted' : 'Routing declined',
      message: accepted ? 'You now work this buyer together with the first broker (co-broked, predefined split).' : 'The first broker keeps this buyer. You can escalate to A R if you disagree.',
      relatedEntityType: 'lead',
      relatedEntityId: c.later_lead_id,
    });
  } else {
    if (c.later_broker_id !== user.id && !ADMIN.includes(user.role)) throw forbidden('Only the later broker chooses');
    if (action === 'request_routing') {
      await pool.query(`UPDATE lead_conflicts SET status = 'routing_requested', resolution_detail = $1 WHERE id = $2`, [JSON.stringify({ note: note || null }), id]);
      await notificationService.createNotification({
        userId: c.first_broker_id,
        type: 'lead_conflict',
        title: 'Mandate-verification routing request',
        message: 'The second broker asks to work this buyer with you. Accept or decline in Lead conflicts.',
        relatedEntityType: 'lead',
        relatedEntityId: c.first_lead_id,
      });
    } else if (action === 'different_property') {
      if (!propertyId) throw badRequest('Choose the property you will work');
      const clash = await pool.query('SELECT 1 FROM leads WHERE id = $1 AND property_id = $2', [c.first_lead_id, propertyId]);
      if (clash.rows.length) throw badRequest('The first broker is already working that property with this buyer');
      await pool.query(`UPDATE leads SET property_id = $1 WHERE id = $2`, [propertyId, c.later_lead_id]);
      await pool.query(
        `UPDATE lead_conflicts SET status = 'resolved', resolution = 'different_property', resolution_detail = $1, resolved_at = now() WHERE id = $2`,
        [JSON.stringify({ propertyId }), id]
      );
    } else if (action === 'transfer') {
      await pool.query(`UPDATE leads SET assigned_to = $1 WHERE id = $2`, [c.first_broker_id, c.later_lead_id]);
      await pool.query(`INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'assigned', $3)`, [
        c.later_lead_id,
        user.id,
        JSON.stringify({ reason: 'lead_conflict_transfer', to: c.first_broker_id }),
      ]);
      await pool.query(
        `UPDATE lead_conflicts SET status = 'resolved', resolution = 'transferred', resolved_at = now() WHERE id = $1`,
        [id]
      );
      await notificationService.createNotification({
        userId: c.first_broker_id,
        type: 'lead_conflict',
        title: 'Lead transferred to you',
        message: 'The second broker transferred their lead for your buyer to you.',
        relatedEntityType: 'lead',
        relatedEntityId: c.later_lead_id,
      });
    } else {
      throw badRequest('Unknown action');
    }
  }
  await auditService.log({ actor: user, action: `lead_conflict.${action}`, entityType: 'lead_conflict', entityId: id, after: { propertyId, note }, ...meta });
  return getConflict(user, id);
}

// Commission attribution from the immutable logs: who contacted first,
// who scheduled the visit, who negotiated.
async function attribution(user, id) {
  const c = await getConflict(user, id);
  const leads = [c.first_lead_id, c.later_lead_id];
  const firstTouch = await pool.query(
    `SELECT user_id, MIN(at) AS at FROM (
       SELECT a.user_id, a.created_at AS at FROM lead_activity_log a WHERE a.lead_id = ANY($1::uuid[]) AND a.action IN ('status_changed', 'lead_created')
       UNION ALL SELECT n.user_id, n.created_at FROM lead_notes n WHERE n.lead_id = ANY($1::uuid[])
     ) t WHERE user_id = ANY($2::uuid[]) GROUP BY user_id ORDER BY at`,
    [leads, [c.first_broker_id, c.later_broker_id]]
  );
  const deals = await pool.query(`SELECT id, broker_id, lead_id FROM deals WHERE lead_id = ANY($1::uuid[])`, [leads]);
  const dealIds = deals.rows.map((d) => d.id);
  const visits = dealIds.length
    ? await pool.query(`SELECT created_by, MIN(created_at) AS at FROM site_visits WHERE deal_id = ANY($1::uuid[]) GROUP BY created_by ORDER BY at`, [dealIds])
    : { rows: [] };
  const negotiation = dealIds.length
    ? await pool.query(`SELECT changed_by, MIN(created_at) AS at FROM deal_stage_history WHERE deal_id = ANY($1::uuid[]) AND to_stage = 'negotiation' GROUP BY changed_by ORDER BY at`, [dealIds])
    : { rows: [] };
  const who = (uid) => (uid === c.first_broker_id ? 'first' : uid === c.later_broker_id ? 'later' : 'other');
  const credit = { first: 0, later: 0 };
  const steps = [];
  const award = (label, row, weight, idKey) => {
    const uid = row?.[idKey];
    if (!uid || !['first', 'later'].includes(who(uid))) {
      steps.push({ step: label, by: row ? 'A R / other' : 'not yet', at: row?.at || null, weight });
      return;
    }
    credit[who(uid)] += weight;
    steps.push({ step: label, by: who(uid) === 'first' ? c.first_broker_name : c.later_broker_name, at: row.at, weight });
  };
  award('First contact', firstTouch.rows[0], 40, 'user_id');
  award('Site visit scheduled', visits.rows[0], 30, 'created_by');
  award('Negotiation', negotiation.rows[0], 30, 'changed_by');
  const total = credit.first + credit.later;
  return {
    conflictId: id,
    steps,
    suggestedSplit: total ? { [c.first_broker_name]: Math.round((credit.first / total) * 100), [c.later_broker_name]: Math.round((credit.later / total) * 100) } : null,
    note: 'Derived from the immutable lead activity log, notes, site visits and deal stage history. Final split is decided by A R admin.',
  };
}

async function escalateConflict(user, id, { reason }, meta = {}) {
  const c = await getConflict(user, id);
  if (c.dispute_id) throw badRequest('Already escalated');
  const other = user.id === c.first_broker_id ? c.later_broker_id : c.first_broker_id;
  const d = await openDispute(
    user,
    {
      type: 'lead_conflict',
      title: 'Lead conflict - same buyer with two brokers',
      description: reason || 'Please decide who works this buyer and the commission attribution.',
      againstUserId: STAFF.includes(user.role) ? null : other,
      leadId: c.later_lead_id,
      leadConflictId: id,
      priority: 'high',
    },
    meta
  );
  await pool.query(`UPDATE lead_conflicts SET status = 'escalated', dispute_id = $1 WHERE id = $2`, [d.id, id]);
  return d;
}

module.exports = {
  openDispute,
  getDispute,
  listDisputes,
  comment,
  update,
  resolve,
  reconstruct,
  escalateOverdue,
  startScheduler,
  detectLeadConflict,
  listConflicts,
  getConflict,
  resolveConflict,
  attribution,
  escalateConflict,
  phoneKey,
};
