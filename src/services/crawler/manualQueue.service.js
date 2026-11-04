const pool = require('../../config/db');
const configService = require('../config.service');
const notificationService = require('../notification.service');
const auditService = require('../audit.service');
const opportunityService = require('../opportunity.service');
const { badRequest, notFound } = require('../../utils/httpError');

// Contract sec. 25.5.2 - crawler sources: "add a manual-entry fallback queue
// so a blocked source's inventory category does not silently go stale".
//
// A task opens for a source that is switched on and legally approved but:
//   dead_letter     failed crawler.dead_letter_after_failures times in a row
//   blocked_robots  its last run was refused by robots.txt (the source must stay off)
//   stale           no successful run for crawler.manual_after_hours past its schedule
// While a task is open, staff check the portal by hand every
// crawler.manual_check_every_hours: they enter its new items (they go through
// the same normalise / dedupe / review pipeline as crawled ones) or record
// that there were none. An overdue check alerts the admins. The task closes
// by itself once the source crawls successfully again.

const REASON_TEXT = {
  dead_letter: 'The crawler failed repeatedly and is paused',
  blocked_robots: 'robots.txt now refuses the crawler',
  stale: 'No successful crawl for a long time',
};

async function notifyAdmins(title, message, relatedEntityId) {
  const admins = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
  for (const a of admins.rows) await notificationService.createNotification({ userId: a.id, type: 'crawler_manual_entry', title, message, relatedEntityType: 'crawler_manual_task', relatedEntityId });
}

// Opens tasks for sources that need hand entry, closes recovered ones and
// alerts on overdue checks. Safe to run as often as wanted.
async function sweep() {
  const staleHours = Number(await configService.getConfig('crawler.manual_after_hours', 72)) || 72;
  const every = Number(await configService.getConfig('crawler.manual_check_every_hours', 24)) || 24;
  const out = { opened: 0, closed: 0, alerted: 0 };
  const closed = await pool.query(
    `UPDATE crawler_manual_tasks t SET status = 'closed', closed_at = now(), close_note = 'The source crawled successfully again'
     FROM crawler_sources s
     WHERE s.id = t.crawler_source_id AND t.status = 'open' AND s.last_success_at > t.opened_at
     RETURNING t.id`
  );
  out.closed = closed.rowCount;

  const need = (await pool.query(
    `SELECT s.id, s.name, s.status, s.last_success_at, s.last_error,
            (SELECT r.status FROM crawler_runs r WHERE r.source_id = s.id AND r.trigger <> 'test' ORDER BY r.started_at DESC LIMIT 1) AS last_run_status
     FROM crawler_sources s
     WHERE s.is_enabled AND s.legal_approved
       AND NOT EXISTS (SELECT 1 FROM crawler_manual_tasks t WHERE t.crawler_source_id = s.id AND t.status = 'open')
       AND (s.status = 'dead_letter'
            OR (SELECT r.status FROM crawler_runs r WHERE r.source_id = s.id AND r.trigger <> 'test' ORDER BY r.started_at DESC LIMIT 1) = 'blocked_robots'
            OR COALESCE(s.last_success_at, s.legal_approved_at, s.created_at) < now() - make_interval(hours => s.schedule_hours + $1))`,
    [staleHours]
  )).rows;
  for (const s of need) {
    const reason = s.status === 'dead_letter' ? 'dead_letter' : s.last_run_status === 'blocked_robots' ? 'blocked_robots' : 'stale';
    const detail = [REASON_TEXT[reason], s.last_success_at ? `last successful crawl ${new Date(s.last_success_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'never crawled successfully', s.last_error ? `last error: ${String(s.last_error).slice(0, 200)}` : null].filter(Boolean).join('; ');
    const t = (await pool.query(
      `INSERT INTO crawler_manual_tasks (crawler_source_id, reason, detail, due_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4)) ON CONFLICT DO NOTHING RETURNING id`,
      [s.id, reason, detail.slice(0, 500), every]
    )).rows[0];
    if (!t) continue;
    out.opened += 1;
    await notifyAdmins(`Enter ${s.name} by hand`, `${detail}. Until it recovers, check the portal and enter its new items in Opportunity Deals > Crawlers > Manual entry.`, t.id);
  }

  const overdue = (await pool.query(
    `UPDATE crawler_manual_tasks t SET alerted_at = now()
     FROM crawler_sources s
     WHERE s.id = t.crawler_source_id AND t.status = 'open' AND t.due_at < now() AND (t.alerted_at IS NULL OR t.alerted_at < t.due_at)
     RETURNING t.id, s.name, t.due_at`
  )).rows;
  for (const t of overdue) {
    await notifyAdmins(`Manual check overdue: ${t.name}`, `${t.name} cannot be crawled and nobody has checked it by hand since it was due. Enter its new items or record that there were none.`, t.id);
    out.alerted += 1;
  }
  return out;
}

const view = (t) => ({
  id: t.id, sourceId: t.crawler_source_id, sourceName: t.source_name, sourceUrl: t.list_url || t.base_url, output: t.output,
  listingCategory: t.default_listing_category, reason: t.reason, detail: t.detail, status: t.status, dueAt: t.due_at,
  overdue: t.status === 'open' && new Date(t.due_at) < new Date(), itemsEntered: t.items_entered, checks: t.checks,
  openedAt: t.opened_at, closedAt: t.closed_at, closeNote: t.close_note,
});

async function list({ status = 'open' } = {}) {
  const r = await pool.query(
    `SELECT t.*, s.name AS source_name, s.list_url, s.base_url, s.output, s.default_listing_category
     FROM crawler_manual_tasks t JOIN crawler_sources s ON s.id = t.crawler_source_id
     WHERE ($1::text = 'all' OR t.status = $1) ORDER BY t.status, t.due_at LIMIT 200`,
    [status]
  );
  return r.rows.map(view);
}

async function load(id) {
  const t = (await pool.query(
    `SELECT t.*, s.name AS source_name, s.list_url, s.base_url, s.output, s.default_listing_category, s.requires_legal_review
     FROM crawler_manual_tasks t JOIN crawler_sources s ON s.id = t.crawler_source_id WHERE t.id = $1`,
    [id]
  )).rows[0];
  if (!t) throw notFound('Manual-entry task not found');
  if (t.status !== 'open') throw badRequest('This task is closed - the source is crawling again');
  return t;
}

async function logCheck(t, user, entry) {
  const every = Number(await configService.getConfig('crawler.manual_check_every_hours', 24)) || 24;
  const byName = (await pool.query('SELECT full_name FROM users WHERE id = $1', [user.id])).rows[0]?.full_name || null;
  const r = (await pool.query(
    `UPDATE crawler_manual_tasks SET checks = (checks || $2::jsonb), items_entered = items_entered + $3, due_at = now() + make_interval(hours => $4)
     WHERE id = $1 RETURNING *`,
    [t.id, JSON.stringify([{ at: new Date(), by: user.id, byName, ...entry }]), entry.items || 0, every]
  )).rows[0];
  return r;
}

// One item typed in by staff from the source's own website.
async function addItem(user, id, item = {}, meta = {}) {
  const t = await load(id);
  if (t.output !== 'opportunity') throw badRequest('This source feeds reference data (RERA / indices / market stats) - record the check instead');
  if (!item.title || !item.city) throw badRequest('Give at least a title and the city');
  const summary = await opportunityService.ingestItems(
    [{ ...item, auction_portal_url: item.auction_portal_url || t.list_url || t.base_url }],
    { sourceName: t.source_name, dataSource: 'manual', crawlerSourceId: t.crawler_source_id, defaultCategory: t.default_listing_category, requiresLegalReview: t.requires_legal_review },
    user
  );
  const added = summary.received - summary.skipped_existing - summary.failed;
  await logCheck(t, user, { kind: 'item', items: added, note: item.title.slice(0, 120) });
  await auditService.log({ actor: user, action: 'crawler.manual_item', entityType: 'crawler_manual_task', entityId: t.id, after: { source: t.source_name, title: item.title, status: summary.items?.[0]?.status }, ...meta });
  return { summary, task: view({ ...(await pool.query('SELECT * FROM crawler_manual_tasks WHERE id = $1', [t.id])).rows[0], source_name: t.source_name, list_url: t.list_url, base_url: t.base_url, output: t.output, default_listing_category: t.default_listing_category }) };
}

// "Checked the portal" - with how many items were entered, or none new.
async function recordCheck(user, id, { note, itemsEntered = 0 } = {}, meta = {}) {
  const t = await load(id);
  if (!note || String(note).trim().length < 3) throw badRequest('Say what you checked (e.g. "No new notices since yesterday")');
  const n = Math.max(0, Math.min(1000, Number(itemsEntered) || 0));
  const r = await logCheck(t, user, { kind: 'check', items: n, note: String(note).slice(0, 300) });
  await auditService.log({ actor: user, action: 'crawler.manual_check', entityType: 'crawler_manual_task', entityId: t.id, after: { source: t.source_name, itemsEntered: n, note }, ...meta });
  return view({ ...r, source_name: t.source_name, list_url: t.list_url, base_url: t.base_url, output: t.output, default_listing_category: t.default_listing_category });
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((err) => console.error('[crawler manual queue]', err.message)), 30 * 60 * 1000);
  timer.unref?.();
}

module.exports = { sweep, list, addItem, recordCheck, startScheduler };
