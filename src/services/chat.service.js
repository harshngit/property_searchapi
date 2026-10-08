const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { findViolations } = require('../utils/contentGuard');
const { badRequest, forbidden, notFound, unprocessable } = require('../utils/httpError');

// Module 36 - In-Platform Communication Layer.
//
// A conversation belongs to an enquiry (lead). In it: the enquirer, the
// lister and the assigned A R Buildwel representative - the representative
// is always a participant, so nothing passes between buyer and seller
// without A R Buildwel in the thread. People appear by first name and their
// part in the enquiry; nobody's number or email is ever sent to the other
// side, and a message that tries to pass contact details (number, email,
// link, "call me", "whatsapp" ...) is rejected before it is saved, logged,
// and the account is flagged for staff. Messages cannot be edited or
// deleted.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const isStaff = (u) => STAFF.includes(u.role);
const PARTY_LABEL = { enquirer: 'Enquirer', lister: 'Lister', representative: 'A R Buildwel representative', staff: 'A R Buildwel' };

const enabled = async () => (await configService.getConfig('chat.enabled', true)) !== false;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Member';
const maskPhone = (p) => (p && String(p).replace(/\D/g, '').length >= 6 ? `${String(p).replace(/\D/g, '').slice(-10, -8)}XXXXXX${String(p).replace(/\D/g, '').slice(-2)}` : null);
const maskEmail = (e) => (e && e.includes('@') ? `${e[0]}*@${e.split('@')[1]}` : null);

// Who belongs in the conversation on a lead.
async function partiesOf(leadId) {
  const l = (
    await pool.query(
      `SELECT l.id, l.property_id, l.assigned_to, l.arb_rep_id, l.created_by, l.enquiry_type, c.user_id AS enquirer_id, c.full_name AS enquirer_name,
              p.title AS property_title, COALESCE(p.broker_id, p.builder_id, p.created_by) AS lister_id
       FROM leads l LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN properties p ON p.id = l.property_id WHERE l.id = $1`,
      [leadId]
    )
  ).rows[0];
  if (!l) throw notFound('Enquiry not found');
  const roles = new Map();
  const ids = [...new Set([l.enquirer_id, l.lister_id, l.arb_rep_id, l.assigned_to].filter(Boolean))];
  if (ids.length) for (const r of (await pool.query(`SELECT u.id, ro.name FROM users u JOIN roles ro ON ro.id = u.role_id WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`, [ids])).rows) roles.set(r.id, r.name);
  const out = new Map();
  // The representative first: A R staff on the lead, whichever field holds them.
  for (const id of [l.arb_rep_id, l.assigned_to]) if (id && STAFF.includes(roles.get(id)) && !out.has(id)) out.set(id, 'representative');
  if (l.enquirer_id && roles.has(l.enquirer_id) && !out.has(l.enquirer_id)) out.set(l.enquirer_id, 'enquirer');
  // The lister, or the broker working the lead when there is no listing.
  for (const id of [l.lister_id, l.assigned_to]) if (id && roles.has(id) && !STAFF.includes(roles.get(id)) && !out.has(id)) out.set(id, 'lister');
  return { lead: l, parties: out };
}

async function threadFor(user, threadId) {
  const t = (await pool.query('SELECT * FROM chat_threads WHERE id = $1', [threadId])).rows[0];
  if (!t) throw notFound('Conversation not found');
  const me = (await pool.query('SELECT party, last_read_id FROM chat_participants WHERE thread_id = $1 AND user_id = $2', [threadId, user.id])).rows[0];
  // Staff can open any conversation (oversight); everyone else only their own.
  if (!me && !isStaff(user)) throw forbidden('This conversation is not yours');
  return { thread: t, me: me || null };
}

// Open (or return) the conversation on an enquiry.
async function open(user, { leadId }, meta = {}) {
  if (!(await enabled())) throw badRequest('Messaging is switched off at the moment');
  const { lead, parties } = await partiesOf(leadId);
  if (!parties.has(user.id) && !isStaff(user)) throw forbidden('You are not part of this enquiry');
  let t = (await pool.query('SELECT * FROM chat_threads WHERE lead_id = $1', [leadId])).rows[0];
  if (!t) {
    const subject = lead.property_title ? `Enquiry: ${lead.property_title}` : `${String(lead.enquiry_type || 'General').replace(/_/g, ' ')} enquiry`;
    t = (await pool.query(
      `INSERT INTO chat_threads (lead_id, property_id, subject, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (lead_id) DO UPDATE SET subject = chat_threads.subject RETURNING *`,
      [leadId, lead.property_id, subject.slice(0, 200), user.id]
    )).rows[0];
    await auditService.log({ actor: user, action: 'chat.thread_opened', entityType: 'chat_thread', entityId: t.id, after: { leadId }, ...meta });
  }
  // Keep the participant list in step with the lead (a reassigned representative joins).
  for (const [id, party] of parties) await pool.query('INSERT INTO chat_participants (thread_id, user_id, party) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [t.id, id, party]);
  if (!parties.has(user.id)) await pool.query(`INSERT INTO chat_participants (thread_id, user_id, party) VALUES ($1, $2, 'staff') ON CONFLICT DO NOTHING`, [t.id, user.id]);
  return view(user, t.id);
}

async function participants(threadId, viewer) {
  const r = await pool.query(
    `SELECT p.user_id, p.party, u.full_name, ar.platform_number, ar.designation
     FROM chat_participants p JOIN users u ON u.id = p.user_id LEFT JOIN arb_representatives ar ON ar.user_id = u.id WHERE p.thread_id = $1 ORDER BY p.joined_at`,
    [threadId]
  );
  return r.rows.map((p) => {
    const arb = ['representative', 'staff'].includes(p.party);
    return {
      userId: p.user_id, party: p.party, partyLabel: PARTY_LABEL[p.party], isMe: p.user_id === viewer.id,
      // A R people are shown in full with their platform number; everyone else by first name only.
      name: arb || isStaff(viewer) || p.user_id === viewer.id ? p.full_name : firstName(p.full_name),
      platformNumber: arb ? p.platform_number || null : undefined, designation: arb ? p.designation || null : undefined,
    };
  });
}

async function view(user, threadId) {
  const { thread: t, me } = await threadFor(user, threadId);
  const people = await participants(threadId, user);
  const unread = me ? (await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_id = $1 AND id > $2 AND sender_id IS DISTINCT FROM $3', [threadId, me.last_read_id, user.id])).rows[0].n : 0;
  return {
    id: t.id, leadId: t.lead_id, propertyId: t.property_id, subject: t.subject, status: t.status, closedReason: t.closed_reason, lastMessageAt: t.last_message_at, createdAt: t.created_at,
    myParty: me?.party || 'staff', participants: people, unread, hasRepresentative: people.some((p) => p.party === 'representative'),
    notice: 'Phone numbers, emails and links cannot be shared here. Your A R Buildwel representative is part of this conversation.',
  };
}

async function list(user, { scope } = {}) {
  const all = isStaff(user) && scope === 'all';
  const r = await pool.query(
    `SELECT t.*, COALESCE(me.party, 'staff') AS my_party,
            (SELECT COUNT(*)::int FROM chat_messages m WHERE m.thread_id = t.id AND m.id > COALESCE(me.last_read_id, 0) AND m.sender_id IS DISTINCT FROM $1) AS unread,
            (SELECT json_build_object('body', m.body, 'party', m.party, 'at', m.created_at, 'mine', m.sender_id = $1) FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last
     FROM chat_threads t LEFT JOIN chat_participants me ON me.thread_id = t.id AND me.user_id = $1
     WHERE ${all ? 'TRUE' : 'me.user_id IS NOT NULL'} ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT 200`,
    [user.id]
  );
  return r.rows.map((t) => ({ id: t.id, leadId: t.lead_id, subject: t.subject, status: t.status, myParty: t.my_party, unread: all && t.my_party === 'staff' && !t.unread ? 0 : t.unread, last: t.last ? { ...t.last, body: String(t.last.body).slice(0, 140) } : null, lastMessageAt: t.last_message_at }));
}

// Enquiries of mine that can have a conversation but do not have one yet.
async function startable(user) {
  const r = await pool.query(
    `SELECT l.id AS lead_id, COALESCE(p.title, initcap(replace(COALESCE(l.enquiry_type, 'general'), '_', ' ')) || ' enquiry') AS subject, l.created_at
     FROM leads l LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN properties p ON p.id = l.property_id
     WHERE (c.user_id = $1 OR l.assigned_to = $1 OR l.arb_rep_id = $1 OR COALESCE(p.broker_id, p.builder_id, p.created_by) = $1)
       AND l.status NOT IN ('won', 'lost') AND NOT EXISTS (SELECT 1 FROM chat_threads t WHERE t.lead_id = l.id)
     ORDER BY l.created_at DESC LIMIT 50`,
    [user.id]
  );
  return r.rows.map((x) => ({ leadId: x.lead_id, subject: x.subject, createdAt: x.created_at }));
}

const shapeMessage = (m, user) => ({ id: Number(m.id), party: m.party, partyLabel: PARTY_LABEL[m.party] || m.party, kind: m.kind, body: m.body, mine: m.sender_id === user.id, senderName: m.sender_name, at: m.created_at });

async function messages(user, threadId, { after, before, limit } = {}) {
  await threadFor(user, threadId);
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const params = [threadId];
  let cond = '';
  if (after) { params.push(Number(after)); cond = `AND m.id > $${params.length}`; }
  else if (before) { params.push(Number(before)); cond = `AND m.id < $${params.length}`; }
  // Newest page by default; "after" pages forward for live updates.
  const rows = (await pool.query(
    `SELECT m.*, u.full_name AS full_name FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.thread_id = $1 ${cond} ORDER BY m.id ${after ? 'ASC' : 'DESC'} LIMIT ${size + 1}`, params)).rows;
  const more = rows.length > size;
  const page = rows.slice(0, size);
  if (!after) page.reverse();
  const staffView = isStaff(user);
  return {
    items: page.map((m) => shapeMessage({ ...m, sender_name: m.kind === 'system' ? null : staffView || ['representative', 'staff'].includes(m.party) || m.sender_id === user.id ? m.full_name : firstName(m.full_name) }, user)),
    has_more: more, next_cursor: page.length ? String(after ? page[page.length - 1].id : page[0].id) : null,
  };
}

// Reject anything that passes contact details. Returns the list of problems.
async function contactViolations(body) {
  const v = await findViolations({ message: body }, { blockContact: true });
  // "contact" on its own is everyday language in a conversation ("I will contact my bank").
  return v.filter((x) => x.rule !== 'brand_spelling' && x.rule !== 'forbidden_term' && !(x.rule === 'contact_phrase' && String(x.match).trim().toLowerCase() === 'contact'));
}

async function send(user, threadId, { body }, meta = {}) {
  if (!(await enabled())) throw badRequest('Messaging is switched off at the moment');
  const { thread: t, me } = await threadFor(user, threadId);
  if (t.status !== 'open') throw badRequest('This conversation is closed');
  const text = String(body || '').replace(/\s+\n/g, '\n').trim();
  const max = Number(await configService.getConfig('chat.max_message_length', 2000)) || 2000;
  if (!text) throw badRequest('Write a message');
  if (text.length > max) throw badRequest(`Keep the message under ${max} characters`);
  // Representatives and staff are the controlled contact point and may give the platform number.
  const arb = isStaff(user);
  if (!arb) {
    const bad = await contactViolations(text);
    if (bad.length) {
      await pool.query(`INSERT INTO contact_access_log (user_id, lead_id, action, detail, ip_address) VALUES ($1, $2, 'message_blocked', $3, $4)`, [user.id, t.lead_id, JSON.stringify({ threadId, rules: [...new Set(bad.map((b) => b.rule))] }), meta.ip || null]);
      const limit = Number(await configService.getConfig('chat.blocked_attempts_to_flag', 1)) || 1;
      const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM contact_access_log WHERE user_id = $1 AND action = 'message_blocked' AND created_at > now() - interval '30 days'`, [user.id])).rows[0].n;
      if (n >= limit && !(await pool.query(`SELECT 1 FROM user_flags WHERE user_id = $1 AND reason = 'contact_sharing_attempt' AND resolved_at IS NULL`, [user.id])).rows.length) {
        await pool.query(`INSERT INTO user_flags (user_id, reason, detail) VALUES ($1, 'contact_sharing_attempt', $2)`, [user.id, JSON.stringify({ threadId, attempts: n })]);
      }
      throw unprocessable('Contact details cannot be shared here - your A R Buildwel representative will connect you', bad.map((b) => ({ field: 'body', rule: b.rule, msg: 'Remove phone numbers, emails, links and requests to move off the platform' })));
    }
  }
  if (!me) await pool.query(`INSERT INTO chat_participants (thread_id, user_id, party) VALUES ($1, $2, 'staff') ON CONFLICT DO NOTHING`, [threadId, user.id]);
  const party = me?.party || 'staff';
  const m = (await pool.query('INSERT INTO chat_messages (thread_id, sender_id, party, body) VALUES ($1, $2, $3, $4) RETURNING *', [threadId, user.id, party, text])).rows[0];
  await pool.query('UPDATE chat_threads SET last_message_at = now() WHERE id = $1', [threadId]);
  await pool.query('UPDATE chat_participants SET last_read_id = $1 WHERE thread_id = $2 AND user_id = $3', [m.id, threadId, user.id]);
  // Tell the others (in-app + push), without the sender's contact details.
  const others = await pool.query('SELECT user_id FROM chat_participants WHERE thread_id = $1 AND user_id <> $2', [threadId, user.id]);
  for (const o of others.rows) {
    await notificationService.createNotification({ userId: o.user_id, type: 'chat_message', title: `New message - ${t.subject}`.slice(0, 120), message: `${PARTY_LABEL[party]}: ${text.slice(0, 140)}`, relatedEntityType: 'chat_thread', relatedEntityId: threadId }).catch(() => {});
  }
  require('./webhook.service').emit('message.new', { threadId, leadId: t.lead_id, party, at: m.created_at }, { leadId: t.lead_id }).catch(() => {});
  const name = (await pool.query('SELECT full_name FROM users WHERE id = $1', [user.id])).rows[0]?.full_name;
  return shapeMessage({ ...m, sender_name: name }, user);
}

async function markRead(user, threadId) {
  await threadFor(user, threadId);
  await pool.query('UPDATE chat_participants SET last_read_id = COALESCE((SELECT MAX(id) FROM chat_messages WHERE thread_id = $1), 0) WHERE thread_id = $1 AND user_id = $2', [threadId, user.id]);
  return { ok: true };
}

async function unreadCount(user) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS messages, COUNT(DISTINCT m.thread_id)::int AS threads FROM chat_participants p JOIN chat_messages m ON m.thread_id = p.thread_id AND m.id > p.last_read_id AND m.sender_id IS DISTINCT FROM p.user_id WHERE p.user_id = $1`,
    [user.id]
  );
  return r.rows[0];
}

async function setStatus(user, threadId, { status, reason }, meta = {}) {
  if (!isStaff(user)) throw forbidden('Only A R Buildwel staff can close or reopen a conversation');
  if (!['open', 'closed'].includes(status)) throw badRequest('status must be open or closed');
  const t = (await pool.query('UPDATE chat_threads SET status = $1, closed_by = $2, closed_reason = $3 WHERE id = $4 RETURNING id', [status, status === 'closed' ? user.id : null, status === 'closed' ? String(reason || '').slice(0, 300) || null : null, threadId])).rows[0];
  if (!t) throw notFound('Conversation not found');
  await pool.query(`INSERT INTO chat_messages (thread_id, sender_id, party, kind, body) VALUES ($1, $2, 'staff', 'system', $3)`, [threadId, user.id, status === 'closed' ? `Conversation closed by A R Buildwel${reason ? `: ${String(reason).slice(0, 200)}` : ''}` : 'Conversation reopened by A R Buildwel']);
  await auditService.log({ actor: user, action: `chat.thread_${status}`, entityType: 'chat_thread', entityId: threadId, after: { reason }, ...meta });
  return view(user, threadId);
}

// GET /inquiry/buyer-contact - masked only, representative / staff only, every look logged.
async function maskedContact(user, leadId, meta = {}) {
  const l = (await pool.query(`SELECT l.id, l.arb_rep_id, l.assigned_to, c.full_name, c.mobile, c.email FROM leads l LEFT JOIN customers c ON c.id = l.customer_id WHERE l.id = $1`, [leadId])).rows[0];
  if (!l) throw notFound('Enquiry not found');
  const allowed = isStaff(user) && (['admin', 'super_admin'].includes(user.role) || [l.arb_rep_id, l.assigned_to].includes(user.id));
  await pool.query(`INSERT INTO contact_access_log (user_id, lead_id, action, detail, ip_address) VALUES ($1, $2, $3, $4, $5)`, [user.id, leadId, allowed ? 'masked_contact_viewed' : 'masked_contact_denied', JSON.stringify({ role: user.role }), meta.ip || null]);
  if (!allowed) throw forbidden('Only the assigned A R Buildwel representative can see this');
  return { name: firstName(l.full_name), phone_masked: maskPhone(l.mobile), email_masked: maskEmail(l.email), note: 'Use platform messaging to reach this person.' };
}

module.exports = { open, list, startable, view, messages, send, markRead, unreadCount, setStatus, maskedContact, contactViolations };
