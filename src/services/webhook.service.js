const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 35 - webhooks: real-time lead / deal / match / mandate / message
// events sent to an organisation's own system.
//
//   Events     are found by a scanner that reads the platform's own change
//              logs (new leads, lead status changes, deal stage history, new
//              matches, mandate events) once a minute, so no business code
//              has to remember to send them. Chat messages are sent directly.
//   Who gets   an endpoint receives an event when its owner (or its
//              organisation) is a party to the record. Endpoints created by
//              an admin receive everything.
//   Payloads   never carry a phone number, email or address - contact stays
//              controlled. They carry ids; the receiver reads the detail
//              through the API with its key.
//   Delivery   POST with an HMAC-SHA256 signature, retried with back-off;
//              an endpoint that keeps failing is paused.

const ADMIN = ['admin', 'super_admin'];
const OWNERS = ['agency_admin', 'builder', 'broker', ...ADMIN];
const EVENTS = ['lead.created', 'lead.status_changed', 'deal.stage_changed', 'deal.closed', 'match.found', 'mandate.status_changed', 'message.new', 'ping'];
const BACKOFF_MIN = [1, 5, 30, 120, 360, 720];
const enabled = async () => (await configService.getConfig('api.enabled', true)) !== false;

function privateAddress(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:') && privateAddress(ip.slice(7));
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// Only public https addresses: a webhook must not be a way to reach internal systems.
async function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw badRequest('Enter a full web address, for example https://example.com/hooks/propertyserch');
  }
  const local = process.env.WEBHOOK_ALLOW_LOCAL === 'true';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw badRequest('The address must start with https://');
  if (u.username || u.password) throw badRequest('Do not put a username or password in the address');
  if (local) return u.toString();
  const addresses = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addresses.length) throw badRequest('That address could not be found');
  if (addresses.some((a) => privateAddress(a.address))) throw badRequest('That address is not reachable from the internet');
  return u.toString();
}

const view = (e, withSecret = false) => ({
  id: e.id, url: e.url, description: e.description, events: e.events, status: e.status, failureStreak: e.failure_streak, pausedReason: e.paused_reason, lastDeliveryAt: e.last_delivery_at, createdAt: e.created_at,
  secret: withSecret ? e.secret : undefined, secretHint: `${e.secret.slice(0, 8)}…`,
});

function cleanEvents(list) {
  const events = [...new Set((Array.isArray(list) ? list : []).filter((e) => EVENTS.includes(e) && e !== 'ping'))];
  if (!events.length) throw badRequest('Choose at least one event');
  return events;
}

async function owned(user, id) {
  const e = (await pool.query('SELECT * FROM webhook_endpoints WHERE id = $1', [id])).rows[0];
  if (!e) throw notFound('Webhook not found');
  if (e.owner_user_id !== user.id && !ADMIN.includes(user.role)) throw forbidden('Not your webhook');
  return e;
}

async function create(user, { url, description, events }, meta = {}) {
  if (!OWNERS.includes(user.role)) throw forbidden('Webhooks are for agencies, builders and brokers');
  const safe = await assertSafeUrl(url);
  const count = (await pool.query('SELECT COUNT(*)::int AS n FROM webhook_endpoints WHERE owner_user_id = $1', [user.id])).rows[0].n;
  if (count >= 10) throw badRequest('You can have up to 10 webhooks');
  const e = (await pool.query(
    'INSERT INTO webhook_endpoints (owner_user_id, tenant_id, url, description, secret, events) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [user.id, user.tenant_id || null, safe, description ? String(description).slice(0, 160) : null, `whsec_${crypto.randomBytes(24).toString('hex')}`, JSON.stringify(cleanEvents(events))]
  )).rows[0];
  await auditService.log({ actor: user, action: 'api.webhook_created', entityType: 'webhook_endpoint', entityId: e.id, after: { url: safe, events: e.events }, ...meta });
  return view(e, true); // the signing secret is shown once, here
}

async function update(user, id, data, meta = {}) {
  const e = await owned(user, id);
  const url = data.url !== undefined ? await assertSafeUrl(data.url) : e.url;
  const events = data.events !== undefined ? cleanEvents(data.events) : e.events;
  const status = data.status !== undefined ? data.status : e.status;
  if (!['active', 'paused'].includes(status)) throw badRequest('status must be active or paused');
  const r = (await pool.query(
    `UPDATE webhook_endpoints SET url = $1, events = $2, status = $3, description = COALESCE($4, description), failure_streak = CASE WHEN $3 = 'active' THEN 0 ELSE failure_streak END, paused_reason = CASE WHEN $3 = 'active' THEN NULL ELSE COALESCE(paused_reason, 'Paused by the owner') END WHERE id = $5 RETURNING *`,
    [url, JSON.stringify(events), status, data.description ? String(data.description).slice(0, 160) : null, id]
  )).rows[0];
  await auditService.log({ actor: user, action: 'api.webhook_updated', entityType: 'webhook_endpoint', entityId: id, after: { url, events, status }, ...meta });
  return view(r);
}

async function remove(user, id, meta = {}) {
  await owned(user, id);
  await pool.query('DELETE FROM webhook_endpoints WHERE id = $1', [id]);
  await auditService.log({ actor: user, action: 'api.webhook_deleted', entityType: 'webhook_endpoint', entityId: id, ...meta });
  return { deleted: true };
}

async function list(user) {
  const all = ADMIN.includes(user.role);
  const r = await pool.query(
    `SELECT e.*, u.full_name AS owner_name FROM webhook_endpoints e JOIN users u ON u.id = e.owner_user_id ${all ? '' : 'WHERE e.owner_user_id = $1'} ORDER BY e.created_at DESC LIMIT 200`,
    all ? [] : [user.id]
  );
  return { events: EVENTS.filter((e) => e !== 'ping'), items: r.rows.map((e) => ({ ...view(e), ownerName: all ? e.owner_name : undefined, mine: e.owner_user_id === user.id })) };
}

async function deliveries(user, id) {
  await owned(user, id);
  const r = await pool.query('SELECT id, event, status, attempts, response_code, last_error, next_attempt_at, delivered_at, created_at, payload FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 50', [id]);
  return r.rows;
}

// ------------------------------------------------------------ sending

const sign = (secret, timestamp, body) => crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

async function attempt(d, endpoint) {
  const body = JSON.stringify(d.payload);
  const ts = Math.floor(Date.now() / 1000);
  let code = null;
  let error = null;
  try {
    await assertSafeUrl(endpoint.url);
    const res = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PropertySerch-Webhooks/1.0', 'X-PropertySerch-Event': d.event, 'X-PropertySerch-Delivery': d.id, 'X-PropertySerch-Signature': `t=${ts},v1=${sign(endpoint.secret, ts, body)}` },
      body,
    });
    code = res.status;
    if (code < 200 || code >= 300) error = `Receiver answered ${code}`;
  } catch (err) {
    error = String(err.message || err).slice(0, 300);
  }
  const maxAttempts = Number(await configService.getConfig('api.webhook_max_attempts', 6)) || 6;
  const attempts = d.attempts + 1;
  if (!error) {
    await pool.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = $1, response_code = $2, last_error = NULL, delivered_at = now() WHERE id = $3`, [attempts, code, d.id]);
    await pool.query('UPDATE webhook_endpoints SET failure_streak = 0, last_delivery_at = now() WHERE id = $1', [endpoint.id]);
    return true;
  }
  const final = attempts >= maxAttempts;
  await pool.query(
    `UPDATE webhook_deliveries SET status = $1, attempts = $2, response_code = $3, last_error = $4, next_attempt_at = now() + ($5 || ' minutes')::interval WHERE id = $6`,
    [final ? 'failed' : 'pending', attempts, code, error, String(BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]), d.id]
  );
  if (final) {
    const pauseAfter = Number(await configService.getConfig('api.webhook_pause_after_failures', 20)) || 20;
    await pool.query(
      `UPDATE webhook_endpoints SET failure_streak = failure_streak + 1,
         status = CASE WHEN failure_streak + 1 >= $2 THEN 'paused' ELSE status END, paused_reason = CASE WHEN failure_streak + 1 >= $2 THEN 'Paused automatically after repeated failures' ELSE paused_reason END WHERE id = $1`,
      [endpoint.id, pauseAfter]
    );
  }
  return false;
}

async function deliverDue(limit = 100) {
  const due = await pool.query(
    `SELECT d.*, row_to_json(e) AS endpoint FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.status = 'active' ORDER BY d.next_attempt_at LIMIT $1`,
    [limit]
  );
  let delivered = 0;
  for (const d of due.rows) if (await attempt(d, d.endpoint)) delivered += 1;
  return { attempted: due.rows.length, delivered };
}

// Queue an event for every endpoint whose owner is a party to it.
async function emit(event, data, { userIds = [], tenantIds = [], leadId = null } = {}) {
  if (!(await enabled())) return 0;
  const users = new Set(userIds.filter(Boolean));
  const tenants = new Set(tenantIds.filter(Boolean));
  if (leadId) {
    const l = (await pool.query(`SELECT l.tenant_id, l.assigned_to, l.created_by, COALESCE(p.broker_id, p.builder_id, p.created_by) AS lister FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE l.id = $1`, [leadId])).rows[0];
    if (l) {
      [l.assigned_to, l.created_by, l.lister].filter(Boolean).forEach((u) => users.add(u));
      if (l.tenant_id) tenants.add(l.tenant_id);
    }
  }
  const targets = await pool.query(
    `SELECT e.id FROM webhook_endpoints e JOIN users u ON u.id = e.owner_user_id JOIN roles r ON r.id = u.role_id
     WHERE e.status = 'active' AND e.events ? $1 AND u.status = 'active'
       AND (r.name IN ('admin', 'super_admin') OR e.owner_user_id = ANY($2::uuid[]) OR (e.tenant_id IS NOT NULL AND e.tenant_id = ANY($3::uuid[])))`,
    [event, [...users], [...tenants]]
  );
  for (const t of targets.rows) {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO webhook_deliveries (id, endpoint_id, event, payload) VALUES ($1, $2, $3, $4)', [id, t.id, event, JSON.stringify({ id, event, created_at: new Date().toISOString(), data })]);
  }
  return targets.rows.length;
}

// One row per change-log source: read what is new since last time.
const SOURCES = {
  leads: {
    sql: `SELECT l.created_at AS ts, l.id, l.source::text AS source, l.status::text AS status, l.property_id, l.enquiry_type, l.tenant_id, l.assigned_to, l.created_by, COALESCE(p.broker_id, p.builder_id, p.created_by) AS lister
          FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE l.created_at > $1 ORDER BY l.created_at LIMIT 500`,
    map: (r) => ['lead.created', { lead_id: r.id, source: r.source, status: r.status, property_id: r.property_id, enquiry_type: r.enquiry_type }, { userIds: [r.assigned_to, r.created_by, r.lister], tenantIds: [r.tenant_id] }],
  },
  lead_status: {
    sql: `SELECT a.created_at AS ts, a.lead_id, a.details, l.tenant_id, l.assigned_to, l.created_by FROM lead_activity_log a JOIN leads l ON l.id = a.lead_id WHERE a.action = 'status_changed' AND a.created_at > $1 ORDER BY a.created_at LIMIT 500`,
    map: (r) => ['lead.status_changed', { lead_id: r.lead_id, from: r.details?.from || null, to: r.details?.to || null }, { userIds: [r.assigned_to, r.created_by], tenantIds: [r.tenant_id] }],
  },
  deal_stages: {
    sql: `SELECT h.created_at AS ts, h.deal_id, h.from_stage::text AS from_stage, h.to_stage::text AS to_stage, d.tenant_id, d.broker_id, d.property_id, d.lead_id FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id WHERE h.created_at > $1 ORDER BY h.created_at LIMIT 500`,
    map: (r) => [['closed_won', 'closed_lost'].includes(r.to_stage) ? 'deal.closed' : 'deal.stage_changed', { deal_id: r.deal_id, lead_id: r.lead_id, property_id: r.property_id, from: r.from_stage, to: r.to_stage }, { userIds: [r.broker_id], tenantIds: [r.tenant_id] }],
  },
  matches: {
    sql: `SELECT m.first_matched_at AS ts, m.id, m.requirement_id, m.property_id, m.score, m.tier, COALESCE(p.broker_id, p.builder_id, p.created_by) AS lister, p.tenant_id, r.created_by AS req_owner
          FROM requirement_matches m JOIN properties p ON p.id = m.property_id JOIN requirements r ON r.id = m.requirement_id WHERE m.first_matched_at > $1 ORDER BY m.first_matched_at LIMIT 500`,
    map: (r) => ['match.found', { match_id: r.id, requirement_id: r.requirement_id, property_id: r.property_id, score: r.score, tier: r.tier }, { userIds: [r.lister, r.req_owner], tenantIds: [r.tenant_id] }],
  },
  mandates: {
    sql: `SELECT e.created_at AS ts, e.mandate_id, e.kind, m.mandate_number, m.status, m.user_id FROM mandate_events e JOIN mandates m ON m.id = e.mandate_id
          WHERE e.kind IN ('created', 'acknowledged', 'renewed', 'expired', 'breached', 'cancelled', 'renewal_refused') AND e.created_at > $1 ORDER BY e.created_at LIMIT 500`,
    map: (r) => ['mandate.status_changed', { mandate_id: r.mandate_id, mandate_number: r.mandate_number, change: r.kind, status: r.status }, { userIds: [r.user_id] }],
  },
};

async function scan() {
  if (!(await enabled())) return { enabled: false };
  // Nothing to tell anyone: just move the cursors on.
  const active = (await pool.query(`SELECT 1 FROM webhook_endpoints WHERE status = 'active' LIMIT 1`)).rows.length > 0;
  let queued = 0;
  for (const [source, def] of Object.entries(SOURCES)) {
    const cur = (await pool.query(`INSERT INTO webhook_cursors (source) VALUES ($1) ON CONFLICT (source) DO UPDATE SET source = EXCLUDED.source RETURNING last_seen::text AS last_seen`, [source])).rows[0].last_seen;
    if (!active) {
      await pool.query('UPDATE webhook_cursors SET last_seen = now() WHERE source = $1', [source]);
      continue;
    }
    // The cursor travels as text: a JS Date keeps only milliseconds and would replay the last row.
    const rows = (await pool.query(`SELECT q.*, q.ts::text AS ts_text FROM (${def.sql.replace('$1', '$1::timestamptz')}) q ORDER BY q.ts`, [cur])).rows;
    for (const r of rows) {
      const [event, data, who] = def.map(r);
      queued += await emit(event, data, who);
    }
    if (rows.length) await pool.query('UPDATE webhook_cursors SET last_seen = $1::timestamptz WHERE source = $2', [rows[rows.length - 1].ts_text, source]);
  }
  const sent = await deliverDue();
  return { enabled: true, queued, ...sent };
}

// A test event to one endpoint, sent at once.
async function ping(user, id) {
  const e = await owned(user, id);
  const deliveryId = crypto.randomUUID();
  const d = (await pool.query('INSERT INTO webhook_deliveries (id, endpoint_id, event, payload) VALUES ($1, $2, $3, $4) RETURNING *', [deliveryId, e.id, 'ping', JSON.stringify({ id: deliveryId, event: 'ping', created_at: new Date().toISOString(), data: { message: 'Test event from PropertySerch' } })])).rows[0];
  const ok = await attempt(d, e);
  const out = (await pool.query('SELECT status, response_code, last_error FROM webhook_deliveries WHERE id = $1', [deliveryId])).rows[0];
  return { delivered: ok, responseCode: out.response_code, error: out.last_error };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => scan().catch((err) => console.error('[webhooks] scan failed:', err.message)), 60 * 1000);
  // Old deliveries and idempotency records are housekeeping, not history.
  setInterval(() => {
    pool.query(`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '30 days'`).catch(() => {});
    pool.query(`DELETE FROM api_idempotency WHERE created_at < now() - interval '24 hours'`).catch(() => {});
  }, 6 * 60 * 60 * 1000);
}

module.exports = { EVENTS, sign, assertSafeUrl, create, update, remove, list, deliveries, emit, scan, deliverDue, ping, startScheduler };
