const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const { badRequest, notFound } = require('../utils/httpError');

// Contract sec. 25.5.4 - incident communication: a status page that tells
// franchisees and brokers about an active platform incident and when it is
// expected to be fixed.
//
//   Public    GET /api/status - each part of the platform (status.components)
//             with its state, open incidents and maintenance with their
//             updates and ETA, and the last 14 days of resolved incidents.
//             No internal detail, no sign-in; the website shows it at /status.
//   Staff     admins post an incident (impact, affected parts, ETA) and add
//             updates until it is resolved. Major / critical incidents and
//             maintenance are also sent in-app to status.notify_roles, and
//             again when resolved; the CRM shows a banner while one is open.
//   Checks    the admin view adds automatic checks the team should watch
//             (database, storage, providers configured, last off-site
//             backup and restore test, crawler, delayed geocoding).

const IMPACT_STATE = { maintenance: 'maintenance', minor: 'degraded', major: 'partial_outage', critical: 'major_outage' };
const STATE_RANK = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };
const OPEN = ['investigating', 'identified', 'monitoring', 'scheduled'];

async function components() {
  const list = await configService.getConfig('status.components', []);
  return Array.isArray(list) ? list.filter((c) => c && c.key && c.label) : [];
}

const updateView = (u) => ({ status: u.status, message: u.message, etaAt: u.eta_at, at: u.created_at });

async function incidentsWithUpdates(where, params) {
  const rows = (await pool.query(`SELECT * FROM platform_incidents WHERE ${where} ORDER BY starts_at DESC LIMIT 50`, params)).rows;
  if (!rows.length) return [];
  const ups = (await pool.query(`SELECT * FROM platform_incident_updates WHERE incident_id = ANY($1) ORDER BY created_at DESC`, [rows.map((r) => r.id)])).rows;
  return rows.map((r) => ({
    id: r.id, reference: r.reference, title: r.title, impact: r.impact, status: r.status, components: r.components,
    etaAt: r.eta_at, startsAt: r.starts_at, resolvedAt: r.resolved_at,
    updates: ups.filter((u) => u.incident_id === r.id).map(updateView),
  }));
}

// What anyone may see.
async function publicStatus() {
  const comps = await components();
  const open = await incidentsWithUpdates(`status <> 'resolved' AND (status <> 'scheduled' OR starts_at <= now() + interval '7 days')`, []);
  const recent = await incidentsWithUpdates(`status = 'resolved' AND resolved_at > now() - interval '14 days'`, []);
  const now = Date.now();
  const active = open.filter((i) => i.status !== 'scheduled' || new Date(i.startsAt).getTime() <= now);
  const state = (key) =>
    active.filter((i) => i.components.includes(key)).reduce((s, i) => (STATE_RANK[IMPACT_STATE[i.impact]] > STATE_RANK[s] ? IMPACT_STATE[i.impact] : s), 'operational');
  const list = comps.map((c) => ({ key: c.key, label: c.label, state: state(c.key) }));
  const overall = list.reduce((s, c) => (STATE_RANK[c.state] > STATE_RANK[s] ? c.state : s), 'operational');
  return {
    overall,
    components: list,
    active,
    upcoming: open.filter((i) => i.status === 'scheduled' && new Date(i.startsAt).getTime() > now),
    recent,
    updatedAt: new Date(),
  };
}

// The CRM banner: open incidents only, small.
async function banner() {
  const s = await publicStatus();
  return { overall: s.overall, active: s.active.map(({ updates, ...i }) => ({ ...i, latest: updates[0] || null })), upcoming: s.upcoming.map(({ updates, ...i }) => i) };
}

async function notifyRoles(incident, text) {
  const roles = (await configService.getConfig('status.notify_roles', [])) || [];
  if (!roles.length) return 0;
  const intel = require('./notificationIntel.service');
  const kind = intel.classify({ type: 'platform_incident', title: incident.title, priority: incident.impact === 'critical' ? 'critical' : 'high' });
  const r = await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, related_entity_type, related_entity_id, category, priority, persistent)
     SELECT u.id, 'platform_incident', $1, $2, 'platform_incident', $3, $4, $5, false
     FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ANY($6) AND u.status = 'active'`,
    [text.title.slice(0, 200), text.message, incident.id, kind.category, kind.priority, roles]
  );
  return r.rowCount;
}

const cleanComponents = async (list) => {
  const keys = new Set((await components()).map((c) => c.key));
  const out = [...new Set((Array.isArray(list) ? list : []).map(String))];
  const bad = out.filter((k) => !keys.has(k));
  if (bad.length) throw badRequest(`Unknown part of the platform: ${bad.join(', ')}`);
  if (!out.length) throw badRequest('Choose the parts of the platform that are affected');
  return out;
};
const when = (v) => (v ? new Date(v) : null);
const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);

async function createIncident(user, data = {}, meta = {}) {
  const impact = data.impact;
  if (!IMPACT_STATE[impact]) throw badRequest('impact must be minor, major, critical or maintenance');
  const status = impact === 'maintenance' ? 'scheduled' : data.status || 'investigating';
  if (impact !== 'maintenance' && !['investigating', 'identified', 'monitoring'].includes(status)) throw badRequest('A new incident is investigating, identified or monitoring');
  if (!data.title || String(data.title).trim().length < 5) throw badRequest('Give the incident a short title');
  if (!data.message || String(data.message).trim().length < 5) throw badRequest('Say what users will notice');
  const comps = await cleanComponents(data.components);
  const startsAt = when(data.startsAt) || new Date();
  const etaAt = when(data.etaAt);
  if (impact === 'maintenance' && !etaAt) throw badRequest('Maintenance needs an end time');
  if (etaAt && etaAt < startsAt) throw badRequest('The expected fix time is before the start');
  const seq = (await pool.query(`SELECT nextval('platform_incident_seq') AS n`)).rows[0].n;
  const reference = `INC-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
  const client = await pool.connect();
  let inc;
  try {
    await client.query('BEGIN');
    inc = (await client.query(
      `INSERT INTO platform_incidents (reference, title, impact, status, components, eta_at, starts_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [reference, String(data.title).trim().slice(0, 160), impact, status, comps, etaAt, startsAt, user.id]
    )).rows[0];
    await client.query(`INSERT INTO platform_incident_updates (incident_id, status, message, eta_at, created_by) VALUES ($1, $2, $3, $4, $5)`, [inc.id, status, String(data.message).trim().slice(0, 1000), etaAt, user.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  let notified = 0;
  if (impact !== 'minor') {
    const title = impact === 'maintenance' ? `Planned maintenance: ${inc.title}` : `Service issue: ${inc.title}`;
    const message = `${String(data.message).trim()}${impact === 'maintenance' ? ` From ${fmt(startsAt)} to ${fmt(etaAt)}.` : etaAt ? ` Expected to be fixed by ${fmt(etaAt)}.` : ''} Updates: propertyserch.com/status`;
    notified = await notifyRoles(inc, { title, message });
    await pool.query('UPDATE platform_incidents SET notified_at = now() WHERE id = $1', [inc.id]);
  }
  await auditService.log({ actor: user, action: 'status.incident_created', entityType: 'platform_incident', entityId: inc.id, after: { reference, impact, status, components: comps, etaAt }, ...meta });
  return { ...(await incidentsWithUpdates('id = $1', [inc.id]))[0], notified };
}

async function addUpdate(user, id, data = {}, meta = {}) {
  const inc = (await pool.query('SELECT * FROM platform_incidents WHERE id = $1', [id])).rows[0];
  if (!inc) throw notFound('Incident not found');
  if (inc.status === 'resolved') throw badRequest('This incident is already resolved');
  const status = data.status || inc.status;
  if (![...OPEN, 'resolved'].includes(status)) throw badRequest('Unknown status');
  if (!data.message || String(data.message).trim().length < 5) throw badRequest('Write the update');
  const etaAt = data.etaAt !== undefined ? when(data.etaAt) : inc.eta_at;
  const comps = data.components !== undefined ? await cleanComponents(data.components) : inc.components;
  await pool.query(
    `UPDATE platform_incidents SET status = $2::varchar, eta_at = $3, components = $4, resolved_at = CASE WHEN $2::varchar = 'resolved' THEN now() END, updated_at = now() WHERE id = $1`,
    [id, status, etaAt, comps]
  );
  await pool.query(`INSERT INTO platform_incident_updates (incident_id, status, message, eta_at, created_by) VALUES ($1, $2, $3, $4, $5)`, [id, status, String(data.message).trim().slice(0, 1000), etaAt, user.id]);
  let notified = 0;
  // Everyone told about the incident is told when it is over.
  if (status === 'resolved' && inc.notified_at) {
    notified = await notifyRoles(inc, { title: `Resolved: ${inc.title}`, message: String(data.message).trim() });
  }
  await auditService.log({ actor: user, action: 'status.incident_updated', entityType: 'platform_incident', entityId: id, before: { status: inc.status, etaAt: inc.eta_at }, after: { status, etaAt }, ...meta });
  return { ...(await incidentsWithUpdates('id = $1', [id]))[0], notified };
}

// ------------------------------------------------------------ automatic checks (staff only)

async function checks() {
  const out = [];
  const add = (key, label, ok, detail, level = ok ? 'ok' : 'warn') => out.push({ key, label, level, detail });
  try {
    const t = Date.now();
    await pool.query('SELECT 1');
    add('database', 'Database', true, `Answered in ${Date.now() - t} ms`);
  } catch (err) {
    add('database', 'Database', false, err.message, 'down');
  }
  add('storage', 'File storage', !!process.env.GCS_BUCKET_NAME, process.env.GCS_BUCKET_NAME ? 'Bucket configured' : 'GCS_BUCKET_NAME not set - uploads are not stored');
  add('whatsapp', 'WhatsApp', !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID), process.env.WHATSAPP_ACCESS_TOKEN ? 'Configured' : 'Not configured - messages are simulated');
  add('telegram', 'Telegram', !!process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_BOT_TOKEN ? 'Configured' : 'Not configured');
  add('payments', 'Razorpay', !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), process.env.RAZORPAY_KEY_ID ? `Configured${process.env.RAZORPAY_WEBHOOK_SECRET ? '' : ' - webhook secret missing'}` : 'Not configured - bank / UPI only');
  add('ai', 'AI providers', !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY), [process.env.OPENAI_API_KEY ? 'OpenAI' : null, process.env.ANTHROPIC_API_KEY ? 'Claude' : null].filter(Boolean).join(' + ') || 'No key set');

  const [maxAge, restoreDays] = await Promise.all([configService.getConfig('backup.max_age_hours', 26), configService.getConfig('backup.restore_test_max_age_days', 35)]);
  const last = (await pool.query(`SELECT finished_at, retain_until, target FROM backup_runs WHERE kind = 'backup' AND status = 'success' ORDER BY finished_at DESC LIMIT 1`)).rows[0];
  const ageH = last ? (Date.now() - new Date(last.finished_at).getTime()) / 3600000 : null;
  add('backup', 'Off-site backup', ageH !== null && ageH <= Number(maxAge), last ? `Last good backup ${Math.round(ageH)} h ago${last.retain_until ? `, locked until ${new Date(last.retain_until).toISOString().slice(0, 10)}` : ''}` : 'No successful backup recorded yet', ageH === null || ageH > Number(maxAge) * 2 ? 'down' : undefined);
  const restore = (await pool.query(`SELECT finished_at FROM backup_runs WHERE kind = 'restore_test' AND status = 'success' ORDER BY finished_at DESC LIMIT 1`)).rows[0];
  const restoreAge = restore ? (Date.now() - new Date(restore.finished_at).getTime()) / 86400000 : null;
  add('restore_test', 'Restore test', restoreAge !== null && restoreAge <= Number(restoreDays), restore ? `Last successful restore test ${Math.round(restoreAge)} days ago` : 'No restore test recorded yet');

  const crawler = (await pool.query(
    `SELECT (SELECT COUNT(*) FROM crawler_sources WHERE status = 'dead_letter' AND is_enabled)::int AS dead,
            (SELECT COUNT(*) FROM crawler_manual_tasks WHERE status = 'open')::int AS manual,
            (SELECT COUNT(*) FROM crawler_manual_tasks WHERE status = 'open' AND due_at < now())::int AS overdue`
  )).rows[0];
  add('crawler', 'Crawler', !crawler.dead && !crawler.overdue, `${crawler.dead} source(s) paused, ${crawler.manual} entered by hand${crawler.overdue ? `, ${crawler.overdue} manual check(s) overdue` : ''}`);
  const geo = (await pool.query(`SELECT COUNT(*) FILTER (WHERE geo_status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE geo_status = 'failed')::int AS failed FROM properties`)).rows[0];
  add('geocoding', 'Delayed geocoding', !geo.failed && geo.pending < 100, `${geo.pending} listing(s) waiting for a location, ${geo.failed} to pin by hand`);
  return out;
}

async function adminView() {
  const [pub, all, list] = await Promise.all([
    publicStatus(),
    incidentsWithUpdates(`starts_at > now() - interval '90 days' OR status <> 'resolved'`, []),
    checks(),
  ]);
  return { ...pub, incidents: all, checks: list, componentsAvailable: await components() };
}

module.exports = { publicStatus, banner, adminView, createIncident, addUpdate, checks, IMPACT_STATE };
