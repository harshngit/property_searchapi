const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const push = require('./push.service');
const auditService = require('./audit.service');
const { badRequest, notFound } = require('../utils/httpError');

// Module 43: Notification Intelligence (sec. 20.3 / 20.4).
// The in-app inbox always receives everything. This service decides what
// also leaves the app, on which channel and when:
//   critical  (overdue invoice, mandate 1 day from expiry, Hot match) goes out
//             at once, WhatsApp first, whatever the hour;
//   high      goes out at once, held only by quiet hours;
//   normal    goes out at once unless the person asked for a digest, has had
//             enough for the day (fatigue cap), is in quiet hours, keeps
//             ignoring that category, or the same alert is arriving in a burst;
//   low       always waits for the digest.
// Deliveries are rows in notification_deliveries: retried with backoff and
// dead-lettered when they keep failing. Digests go out inside the posting
// window stored in posting_windows.
//
// Channels: push (VAPID keys), WhatsApp (WHATSAPP_ACCESS_TOKEN +
// WHATSAPP_PHONE_NUMBER_ID and an approved template), SMS (MSG91_AUTH_KEY +
// MSG91_NOTIFY_TEMPLATE_ID), email (MSG91_AUTH_KEY + MSG91_EMAIL_TEMPLATE_ID +
// MSG91_EMAIL_FROM + MSG91_EMAIL_DOMAIN). A channel that is not set up is
// simply not offered.

const CATEGORIES = {
  match: 'Matches',
  deal: 'Deals and enquiries',
  mandate: 'Mandates',
  invoice: 'Invoices and payments',
  market: 'Market updates',
  system: 'System',
};
// First rule that matches the notification type wins; anything else is System.
const CATEGORY_RULES = [
  ['mandate', 'mandate'],
  ['invoice', 'invoice|payment|payout|commission|fee_'],
  ['market', 'market|notification_digest|advertis|gamification|institutional_listing|price_'],
  ['match', 'match|requirement|saved_search|routing|opportunit|investor_alert'],
  ['deal', 'deal|visit|inquiry|enquir|lead|legal_case|loan|insurance|cobroke|exchange|rental|lease|document|nri_service|institutional'],
];
const CHANNELS = { push: 'In-app push', whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' };
const FREQUENCIES = { instant: 'Instant', daily: 'Daily digest', weekly: 'Weekly summary' };
const PRIORITIES = ['critical', 'high', 'normal', 'low'];
const HIGH = /^(mandate_expiry_7d|mandate_breached|mandate_expired|inquiry_sla_breached|inquiry_assigned|inquiry_missed|visit_request|site_visit|dispute|deal_sla|franchise_suspension|fraud_alert|invoice|legal_case|territory_conflict)$/;
const LOW = /^(gamification|advertising|reputation|trust_badge|onboarding|review_received|lead_warm_digest|mandate_benefit)$/;

const categoryOf = (type) => {
  const t = String(type || '').toLowerCase();
  const hit = CATEGORY_RULES.find(([, re]) => new RegExp(re).test(t));
  return hit ? hit[0] : 'system';
};

// Category, priority and whether the alert stays until its cause is settled.
function classify({ type, title, priority }) {
  const t = String(type || '').toLowerCase();
  let p = 'normal';
  let persistent = false;
  if (t === 'invoice_overdue' || t === 'mandate_expiry_1d') {
    p = 'critical';
    persistent = true;
  } else if (t === 'opportunity_alert_priority' || (/^match_alert/.test(t) && /hot match/i.test(title || ''))) p = 'critical';
  else if (HIGH.test(t)) p = 'high';
  else if (LOW.test(t)) p = 'low';
  if (PRIORITIES.includes(priority)) p = priority;
  return { category: categoryOf(t), priority: p, persistent };
}

// Rows written before this module have no category: match them by type.
function categorySql(category, params) {
  const idx = CATEGORY_RULES.findIndex(([c]) => c === category);
  const earlier = (idx === -1 ? CATEGORY_RULES : CATEGORY_RULES.slice(0, idx)).map(([, re]) => re);
  params.push(category);
  const own = params.length;
  const parts = [];
  if (idx !== -1) {
    params.push(CATEGORY_RULES[idx][1]);
    parts.push(`type ~ $${params.length}`);
  }
  if (earlier.length) {
    params.push(earlier.join('|'));
    parts.push(`type !~ $${params.length}`);
  }
  return `(category = $${own} OR (category IS NULL AND ${parts.join(' AND ')}))`;
}

// ------------------------------------------------------------ settings

async function settings() {
  const [routing, defaults, quiet, cap, burst, engagement, retry, weeklyDay, template] = await Promise.all([
    configService.getConfig('notifications.routing', null),
    configService.getConfig('notifications.default_prefs', null),
    configService.getConfig('notifications.quiet_default', null),
    configService.getConfig('notifications.fatigue_daily_cap', 8),
    configService.getConfig('notifications.burst_minutes', 10),
    configService.getConfig('notifications.low_engagement_count', 10),
    configService.getConfig('notifications.retry_seconds', null),
    configService.getConfig('notifications.weekly_day', 1),
    configService.getConfig('notifications.whatsapp_template', 'ps_notification'),
  ]);
  const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null);
  return {
    routing: { critical: ['whatsapp', 'push', 'sms'], high: ['push', 'whatsapp'], normal: ['push'], low: [], digest: ['whatsapp', 'email', 'push'], ...(routing && typeof routing === 'object' ? routing : {}) },
    defaults: { frequency: { market: 'daily', ...(defaults?.frequency || {}) }, channels: { push: true, whatsapp: true, email: true, sms: false, ...(defaults?.channels || {}) } },
    quiet: { start: hhmm(quiet?.start) || '22:00', end: hhmm(quiet?.end) || '08:00' },
    cap: Math.max(0, Number(cap) || 0),
    burst: Math.max(0, Number(burst) || 0),
    engagement: Math.max(0, Number(engagement) || 0),
    retry: Array.isArray(retry) && retry.length ? retry.map(Number).filter((s) => s > 0) : [10, 60, 300],
    weeklyDay: Number(weeklyDay) >= 0 && Number(weeklyDay) <= 6 ? Number(weeklyDay) : 1,
    template: String(template || 'ps_notification'),
  };
}

// ------------------------------------------------------------ channels

// Outside production, NOTIFY_CHANNEL_MOCK=true stands in for WhatsApp, SMS and
// email so the queue can be exercised without provider accounts. A message
// with "[fail]" in its title fails, to exercise the retries.
const mock = () => process.env.NODE_ENV !== 'production' && process.env.NOTIFY_CHANNEL_MOCK === 'true';

function ready(channel) {
  if (channel === 'push') return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (mock()) return true;
  if (channel === 'whatsapp') return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
  if (channel === 'sms') return !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_NOTIFY_TEMPLATE_ID);
  if (channel === 'email') return !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_EMAIL_TEMPLATE_ID && process.env.MSG91_EMAIL_FROM && process.env.MSG91_EMAIL_DOMAIN);
  return false;
}

const mobileOf = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? `91${d.slice(-10)}` : null;
};
const reachable = (ctx, channel) => (channel === 'push' ? ctx.push_subs > 0 : channel === 'email' ? !!ctx.email : !!mobileOf(ctx.mobile));

async function msg91(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.type && data.type !== 'success') || data.hasError) throw new Error(data.message || res.statusText || 'MSG91 refused the message');
  } finally {
    clearTimeout(timer);
  }
}

// Throws when the message did not go out.
async function send(channel, ctx, msg, cfg) {
  const title = String(msg.title || 'PropertySerch').slice(0, 200);
  const body = String(msg.body || '').slice(0, 900);
  if (channel === 'push') {
    const r = await push.sendToUser(ctx.id, { title, body, tag: msg.type || undefined, urgent: msg.priority === 'critical' });
    if (!r.sent) throw new Error(r.skipped ? 'Push is switched off' : 'No device accepted the push');
    return;
  }
  if (mock()) {
    if (/\[fail\]/i.test(title)) throw new Error('Simulated provider failure');
    return;
  }
  if (channel === 'whatsapp') {
    await require('./metaWhatsapp.service').sendTemplate({ to: mobileOf(ctx.mobile), templateName: cfg.template, variables: [title, body || title] });
  } else if (channel === 'sms') {
    await msg91('https://control.msg91.com/api/v5/flow/', { template_id: process.env.MSG91_NOTIFY_TEMPLATE_ID, short_url: '0', recipients: [{ mobiles: mobileOf(ctx.mobile), TITLE: title.slice(0, 60), BODY: body.slice(0, 100) }] });
  } else if (channel === 'email') {
    // Franchisee-branded where the person belongs to a white-label franchise (Section 14).
    const extras = require('./franchiseExtras.service');
    const brand = await extras.brandFor(ctx.id);
    await msg91('https://control.msg91.com/api/v5/email/send', {
      recipients: [{ to: [{ email: ctx.email, name: ctx.full_name || undefined }], variables: { title, body: body || title, brand_name: brand.brandName, logo_url: brand.logoUrl || '', primary_color: brand.primaryColor, footer: brand.footer, html: extras.renderEmail(brand, { title, body: body || title }) } }],
      from: { email: brand.fromAddress || process.env.MSG91_EMAIL_FROM, name: brand.fromName },
      ...(brand.replyTo ? { reply_to: [{ email: brand.replyTo }] } : {}),
      domain: process.env.MSG91_EMAIL_DOMAIN,
      template_id: process.env.MSG91_EMAIL_TEMPLATE_ID,
    });
  } else throw new Error('Unknown channel');
}

// ------------------------------------------------------------ preferences

async function context(userId) {
  return (await pool.query(
    `SELECT u.id, u.full_name, u.mobile, u.email, (np.user_id IS NOT NULL) AS has_prefs, np.push_enabled, np.push_muted, np.quiet_start, np.quiet_end, np.timezone, np.category_prefs,
            (SELECT COUNT(*)::int FROM push_subscriptions ps WHERE ps.user_id = u.id) AS push_subs
     FROM users u LEFT JOIN notification_preferences np ON np.user_id = u.id WHERE u.id = $1`,
    [userId]
  )).rows[0] || null;
}

// The person's own choices over the admin defaults.
function effective(ctx, cfg) {
  const own = ctx.category_prefs || {};
  const categories = {};
  for (const key of Object.keys(CATEGORIES)) {
    const mine = own[key] || {};
    categories[key] = {
      muted: !!mine.muted,
      frequency: FREQUENCIES[mine.frequency] ? mine.frequency : FREQUENCIES[cfg.defaults.frequency[key]] ? cfg.defaults.frequency[key] : 'instant',
      channels: Object.fromEntries(Object.keys(CHANNELS).map((ch) => [ch, mine.channels?.[ch] === undefined ? !!cfg.defaults.channels[ch] : !!mine.channels[ch]])),
    };
  }
  const t = (v) => (v ? String(v).slice(0, 5) : null);
  return {
    categories,
    pushEnabled: ctx.has_prefs ? ctx.push_enabled : true,
    pushMuted: ctx.push_muted || [],
    timezone: ctx.timezone || 'Asia/Kolkata',
    quietStart: ctx.has_prefs ? t(ctx.quiet_start) : cfg.quiet.start,
    quietEnd: ctx.has_prefs ? t(ctx.quiet_end) : cfg.quiet.end,
  };
}

async function getPreferences(userId) {
  const [base, ctx, cfg] = await Promise.all([push.getPreferences(userId), context(userId), settings()]);
  const eff = effective(ctx, cfg);
  return {
    ...base,
    quietStart: eff.quietStart,
    quietEnd: eff.quietEnd,
    categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label, ...eff.categories[key] })),
    channels: Object.entries(CHANNELS).map(([key, label]) => ({ key, label, available: ready(key), reachable: reachable(ctx, key) })),
    frequencies: Object.entries(FREQUENCIES).map(([key, label]) => ({ key, label })),
    alwaysInstant: 'An overdue invoice, a mandate one day from expiry and a Hot match are always sent at once.',
  };
}

async function updatePreferences(userId, data = {}) {
  const [ctx, cfg] = await Promise.all([context(userId), settings()]);
  const legacy = { ...data };
  // The first save keeps the default quiet hours unless the person changes them.
  if (!ctx.has_prefs && data.quietStart === undefined && data.quietEnd === undefined) Object.assign(legacy, { quietStart: cfg.quiet.start, quietEnd: cfg.quiet.end });
  await push.updatePreferences(userId, legacy);
  if (data.categories !== undefined) {
    if (!data.categories || typeof data.categories !== 'object') throw badRequest('categories must be an object keyed by category');
    const list = Array.isArray(data.categories) ? data.categories : Object.entries(data.categories).map(([key, v]) => ({ key, ...(v || {}) }));
    const next = { ...(ctx.category_prefs || {}) };
    for (const c of list) {
      if (!CATEGORIES[c.key]) throw badRequest(`Unknown category "${c.key}"`);
      if (c.frequency !== undefined && !FREQUENCIES[c.frequency]) throw badRequest('Frequency must be instant, daily or weekly');
      const cur = next[c.key] || {};
      const channels = { ...(cur.channels || {}) };
      for (const [ch, on] of Object.entries(c.channels || {})) {
        if (!CHANNELS[ch]) throw badRequest(`Unknown channel "${ch}"`);
        channels[ch] = !!on;
      }
      next[c.key] = { muted: c.muted === undefined ? !!cur.muted : !!c.muted, frequency: c.frequency || cur.frequency, channels };
    }
    await pool.query('UPDATE notification_preferences SET category_prefs = $1, updated_at = now() WHERE user_id = $2', [JSON.stringify(next), userId]);
  }
  return getPreferences(userId);
}

// ------------------------------------------------------------ timing

function localParts(now, timeZone = 'Asia/Kolkata') {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, minutes: Number(hour) * 60 + Number(p.minute), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const toMinutes = (hhmm) => Number(String(hhmm).slice(0, 2)) * 60 + Number(String(hhmm).slice(3, 5));

// When the person's quiet hours end, or null when it is not quiet now.
function quietUntil(eff, now = new Date()) {
  if (!eff.quietStart || !eff.quietEnd) return null;
  let local;
  try {
    local = localParts(now, eff.timezone).minutes;
  } catch {
    local = localParts(now).minutes;
  }
  const start = toMinutes(eff.quietStart);
  const end = toMinutes(eff.quietEnd);
  const inside = start <= end ? local >= start && local < end : local >= start || local < end;
  if (!inside) return null;
  return new Date(now.getTime() + (((end - local) + 1440) % 1440 || 1440) * 60000);
}

// The posting window for a kind of content right now (India time). A row for
// the city beats a general one; then priority; then a row for the day.
async function windowFor(contentType, { city, now = new Date() } = {}) {
  const ist = localParts(now);
  const w = (await pool.query(
    `SELECT * FROM posting_windows
     WHERE is_active AND content_type = $1 AND (day_of_week IS NULL OR day_of_week = $2) AND (city IS NULL OR lower(city) = lower($3))
     ORDER BY (city IS NOT NULL) DESC, priority DESC, (day_of_week IS NOT NULL) DESC LIMIT 1`,
    [contentType, ist.dow, city || '']
  )).rows[0];
  if (!w) return { configured: false, open: false, date: ist.date };
  const start = toMinutes(w.time_start);
  const end = toMinutes(w.time_end);
  return { configured: true, open: ist.minutes >= start && ist.minutes < end, passed: ist.minutes >= end, start: String(w.time_start).slice(0, 5), end: String(w.time_end).slice(0, 5), windowId: w.window_id, date: ist.date, dow: ist.dow };
}

// ------------------------------------------------------------ dispatch

async function queueDigest(n, frequency, reason) {
  await pool.query('INSERT INTO notification_digest_items (user_id, notification_id, frequency, reason) VALUES ($1, $2, $3, $4)', [n.user_id, n.id, frequency === 'weekly' ? 'weekly' : 'daily', reason]);
  return { route: 'digest', reason };
}

const retryAt = (cfg, attempts) => new Date(Date.now() + (cfg.retry[Math.min(attempts, cfg.retry.length) - 1] || 300) * 1000);

// One delivery attempt for one or more rows that travel as a single message.
async function attempt(rows, ctx, msg, cfg) {
  const ids = rows.map((r) => r.id);
  try {
    await send(rows[0].channel, ctx, msg, cfg);
    await pool.query(`UPDATE notification_deliveries SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL, batch_id = $2 WHERE id = ANY($1::uuid[])`, [ids, rows.length > 1 ? crypto.randomUUID() : null]);
    return { sent: rows.length, dead: 0 };
  } catch (err) {
    const tries = rows[0].attempts + 1;
    const dead = tries > cfg.retry.length;
    await pool.query(
      `UPDATE notification_deliveries SET status = $2, attempts = attempts + 1, last_error = $3, next_attempt_at = $4 WHERE id = ANY($1::uuid[])`,
      [ids, dead ? 'dead' : 'failed', String(err.message || err).slice(0, 500), dead ? new Date() : retryAt(cfg, tries)]
    );
    return { sent: 0, dead: dead ? rows.length : 0 };
  }
}

// Decide what happens to a notification that has just been written to the
// inbox. Returns the route taken (mostly for tests and the admin log).
// `scheduled` marks a message that is itself a scheduled digest (the daily market
// digest): it goes out now on the digest channels and is never batched again.
async function dispatch(n, { alreadySent = [], now = new Date(), scheduled = false } = {}) {
  const [ctx, cfg] = await Promise.all([context(n.user_id), settings()]);
  if (!ctx) return { route: 'none' };
  const eff = effective(ctx, cfg);
  const cat = eff.categories[n.category] || eff.categories.system;
  const critical = n.priority === 'critical';
  if (!critical && cat.muted) return { route: 'muted' };

  if (!critical && !scheduled && (n.priority === 'low' || cat.frequency !== 'instant')) return queueDigest(n, cat.frequency, n.priority === 'low' && cat.frequency === 'instant' ? 'low_priority' : 'frequency');

  const wanted = (cfg.routing[scheduled ? 'digest' : n.priority] || []).filter((ch) => {
    if (!CHANNELS[ch] || alreadySent.includes(ch)) return false;
    if (ch === 'push') return eff.pushEnabled && (critical || !eff.pushMuted.includes(push.topicOf(n.type)));
    // WhatsApp is the primary channel for a critical alert whatever the toggles say.
    return (critical && ch === 'whatsapp') || cat.channels[ch];
  });
  const usable = wanted.filter((ch) => ready(ch) && reachable(ctx, ch));
  if (!usable.length) return { route: 'in_app' };

  let hold = null;
  let reason = null;
  if (!critical && !scheduled) {
    if (n.priority === 'normal') {
      if (cfg.engagement) {
        const seen = (await pool.query(
          `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_read)::int AS read FROM (
             SELECT is_read FROM notifications WHERE user_id = $1 AND category = $2 AND id <> $3 AND created_at < $4::timestamptz - interval '1 hour' ORDER BY created_at DESC LIMIT $5
           ) x`,
          [n.user_id, n.category, n.id, now, cfg.engagement]
        )).rows[0];
        if (seen.n >= cfg.engagement && seen.read === 0) return queueDigest(n, 'daily', 'low_engagement');
      }
      if (cfg.cap) {
        const today = (await pool.query(
          `SELECT COUNT(DISTINCT COALESCE(batch_id, id))::int AS n FROM notification_deliveries
           WHERE user_id = $1 AND priority <> 'critical' AND digest_id IS NULL AND status IN ('sent', 'queued', 'failed')
             AND created_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
          [n.user_id, now]
        )).rows[0].n;
        if (today >= cfg.cap) return queueDigest(n, 'daily', 'fatigue_cap');
      }
    }
    const quiet = quietUntil(eff, now);
    if (quiet) {
      hold = quiet;
      reason = 'quiet_hours';
    } else if (cfg.burst) {
      const last = (await pool.query(
        `SELECT MAX(created_at) AS at FROM notification_deliveries WHERE user_id = $1 AND type = $2 AND digest_id IS NULL AND created_at > $3::timestamptz - ($4 || ' minutes')::interval`,
        [n.user_id, n.type, now, String(cfg.burst)]
      )).rows[0].at;
      if (last) {
        hold = new Date(new Date(last).getTime() + cfg.burst * 60000);
        reason = 'burst';
      }
    }
  }

  const rows = [];
  for (const ch of usable) {
    // A row being sent right now is leased for 30 seconds so the queue worker leaves it alone.
    rows.push((await pool.query(
      `INSERT INTO notification_deliveries (notification_id, user_id, channel, type, priority, title, body, status, reason, next_attempt_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [n.id, n.user_id, ch, n.type, n.priority, n.title, n.message || null, hold ? 'held' : 'queued', reason, hold || new Date(Date.now() + 30000), now]
    )).rows[0]);
  }
  if (hold) return { route: 'held', reason, until: hold, channels: usable };
  const outcome = [];
  for (const row of rows) outcome.push({ channel: row.channel, ...(await attempt([row], ctx, { title: n.title, body: n.message, type: n.type, priority: n.priority }, cfg)) });
  return { route: 'instant', channels: usable, outcome };
}

// Fire-and-forget from notification.service - never throws.
function onCreated(n, opts) {
  dispatch(n, opts).catch((err) => console.error('[notifications] dispatch failed:', err.message));
}

// ------------------------------------------------------------ queue worker

let working = false;
let lastDeadAlert = 0;

// Send what is due: retries, and held messages whose time has come. Several
// held messages for one person on one channel travel as one.
async function processQueue({ now = new Date(), limit = 300, userId } = {}) {
  if (working) return { skipped: true };
  working = true;
  try {
    const cfg = await settings();
    const due = (await pool.query(
      `SELECT * FROM notification_deliveries WHERE status IN ('queued', 'held', 'failed') AND next_attempt_at <= $1 ${userId ? 'AND user_id = $3' : ''} ORDER BY next_attempt_at LIMIT $2`,
      userId ? [now, limit, userId] : [now, limit]
    )).rows;
    const groups = new Map();
    for (const d of due) {
      // Only held messages are combined; retries and digests go out as they are.
      const key = d.status === 'held' ? `${d.user_id}|${d.channel}|held` : d.id;
      groups.set(key, [...(groups.get(key) || []), d]);
    }
    let sent = 0;
    let dead = 0;
    let batches = 0;
    for (const rows of groups.values()) {
      const ctx = await context(rows[0].user_id);
      if (!ctx) continue;
      let msg = { title: rows[0].title, body: rows[0].body, type: rows[0].type, priority: rows[0].priority };
      if (rows.length > 1) {
        batches += 1;
        const titles = rows.map((r) => r.title);
        msg = { title: `${rows.length} updates from PropertySerch`, body: titles.slice(0, 5).join(' • ') + (titles.length > 5 ? ` • and ${titles.length - 5} more` : ''), type: 'notification_batch', priority: 'normal' };
      }
      const r = await attempt(rows, ctx, msg, cfg);
      sent += r.sent;
      dead += r.dead;
    }
    if (dead && Date.now() - lastDeadAlert > 3600000) {
      lastDeadAlert = Date.now();
      await opsAlert(dead).catch((err) => console.error('[notifications] ops alert failed:', err.message));
    }
    return { due: due.length, sent, dead, batches };
  } finally {
    working = false;
  }
}

// Dead letters need a person: tell the admins (in the inbox only).
async function opsAlert(count) {
  const admins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`)).rows;
  for (const a of admins) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, category, priority) VALUES ($1, 'notification_dead_letter', $2, $3, 'system', 'high')`,
      [a.id, `${count} notification${count === 1 ? '' : 's'} could not be delivered`, 'Delivery failed after every retry. Open Notification Intelligence to see why and send again.']
    );
  }
}

// ------------------------------------------------------------ digests

const RANK = `CASE n.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

// Compile and send the digests that are due. Runs only inside the posting
// window for 'notification_digest' unless forced (admin "send now").
async function runDigests({ now = new Date(), force = false, userId } = {}) {
  const cfg = await settings();
  const win = await windowFor('notification_digest', { now });
  if (!force && !win.open) return { open: false, window: win, sent: 0 };
  const weekly = force || win.dow === cfg.weeklyDay;
  const params = [weekly];
  if (userId) params.push(userId);
  const pending = (await pool.query(
    `SELECT DISTINCT user_id, frequency FROM notification_digest_items WHERE digest_id IS NULL AND (frequency = 'daily' OR $1) ${userId ? 'AND user_id = $2' : ''} LIMIT 5000`,
    params
  )).rows;
  let sent = 0;
  for (const p of pending) {
    if ((await pool.query('SELECT 1 FROM notification_digests WHERE user_id = $1 AND frequency = $2 AND digest_date = $3', [p.user_id, p.frequency, win.date])).rows.length) continue;
    const items = (await pool.query(
      `SELECT i.id AS item_id, n.id, n.title, n.category, n.type, n.priority, n.is_read FROM notification_digest_items i LEFT JOIN notifications n ON n.id = i.notification_id
       WHERE i.user_id = $1 AND i.frequency = $2 AND i.digest_id IS NULL ORDER BY ${RANK}, n.created_at DESC`,
      [p.user_id, p.frequency]
    )).rows;
    // What the person has already read (or was rolled back) does not belong in a digest.
    const stale = items.filter((i) => !i.id || i.is_read).map((i) => i.item_id);
    if (stale.length) await pool.query('DELETE FROM notification_digest_items WHERE id = ANY($1::uuid[])', [stale]);
    const fresh = items.filter((i) => i.id && !i.is_read);
    if (!fresh.length) continue;
    const byCategory = {};
    for (const i of fresh) byCategory[i.category || categoryOf(i.type)] = (byCategory[i.category || categoryOf(i.type)] || 0) + 1;
    const summary = { byCategory, top: fresh.slice(0, 5).map((i) => i.title) };
    const digest = (await pool.query(
      `INSERT INTO notification_digests (user_id, frequency, digest_date, item_count, summary) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, frequency, digest_date) DO NOTHING RETURNING id`,
      [p.user_id, p.frequency, win.date, fresh.length, JSON.stringify(summary)]
    )).rows[0];
    if (!digest) continue;
    await pool.query('UPDATE notification_digest_items SET digest_id = $1 WHERE id = ANY($2::uuid[])', [digest.id, fresh.map((i) => i.item_id)]);
    const ctx = await context(p.user_id);
    const eff = effective(ctx, cfg);
    const cats = Object.keys(byCategory);
    const channels = (cfg.routing.digest || []).filter((ch) => CHANNELS[ch] && ready(ch) && reachable(ctx, ch) && (ch === 'push' ? eff.pushEnabled : cats.some((c) => eff.categories[c]?.channels[ch])));
    const title = p.frequency === 'weekly' ? `Your week on PropertySerch: ${fresh.length} update${fresh.length === 1 ? '' : 's'}` : `Today on PropertySerch: ${fresh.length} update${fresh.length === 1 ? '' : 's'}`;
    const body = `${Object.entries(byCategory).map(([c, k]) => `${k} ${CATEGORIES[c] || c}`).join(' · ')}\n${summary.top.join(' • ')}`;
    for (const ch of channels) {
      await pool.query(
        `INSERT INTO notification_deliveries (digest_id, user_id, channel, type, priority, title, body, status, next_attempt_at) VALUES ($1, $2, $3, 'notification_digest', 'low', $4, $5, 'queued', $6)`,
        [digest.id, p.user_id, ch, title, body, now]
      );
    }
    await pool.query('UPDATE notification_digests SET channels = $1 WHERE id = $2', [JSON.stringify(channels), digest.id]);
    sent += 1;
  }
  const queue = sent ? await processQueue({ now, userId }) : null;
  return { open: win.open, window: win, sent, queue };
}

// ------------------------------------------------------------ persistent alerts

// A red alert goes away only when its cause does: the invoice is no longer
// overdue, or the mandate was renewed or has ended.
async function resolvePersistent(userId) {
  const params = [];
  if (userId) params.push(userId);
  const r = await pool.query(
    `UPDATE notifications n SET resolved_at = now()
     WHERE n.persistent AND n.resolved_at IS NULL ${userId ? 'AND n.user_id = $1' : ''} AND (
       (n.related_entity_type = 'invoice' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = n.related_entity_id AND (i.status = 'overdue' OR (i.status = 'invoiced' AND i.due_date < CURRENT_DATE))))
       OR (n.related_entity_type = 'mandate' AND NOT EXISTS (SELECT 1 FROM mandates m WHERE m.id = n.related_entity_id AND m.status = 'active' AND m.mandate_end_date <= CURRENT_DATE + 1))
       OR n.related_entity_type IS NULL OR n.related_entity_type NOT IN ('invoice', 'mandate')
     )`,
    params
  );
  return { resolved: r.rowCount };
}

async function alerts(userId) {
  await resolvePersistent(userId);
  const r = await pool.query(`SELECT * FROM notifications WHERE user_id = $1 AND persistent AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20`, [userId]);
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND persistent AND resolved_at IS NULL`, [userId])).rows[0].n;
  return { items: r.rows, total };
}

// Unread counts per category for the Notification Centre tabs (last 90 days).
async function summary(userId) {
  const rows = (await pool.query(
    `SELECT category, type, COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = false AND created_at > now() - interval '90 days' GROUP BY category, type`,
    [userId]
  )).rows;
  const unread = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  for (const r of rows) unread[r.category || categoryOf(r.type)] += r.n;
  return { categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label, unread: unread[key] })), unread: Object.values(unread).reduce((a, b) => a + b, 0), alerts: (await alerts(userId)).total };
}

// ------------------------------------------------------------ admin

async function overview({ days = 7 } = {}) {
  const d = String(Math.min(Math.max(Number(days) || 7, 1), 90));
  const [byChannel, reasons, digests, pending, engagement, cfg, win] = await Promise.all([
    pool.query(`SELECT channel, status, COUNT(*)::int AS n FROM notification_deliveries WHERE created_at > now() - ($1 || ' days')::interval GROUP BY channel, status`, [d]),
    pool.query(`SELECT COALESCE(reason, 'none') AS reason, COUNT(*)::int AS n FROM notification_deliveries WHERE created_at > now() - ($1 || ' days')::interval AND reason IS NOT NULL GROUP BY 1`, [d]),
    pool.query(`SELECT frequency, COUNT(*)::int AS digests, COALESCE(SUM(item_count), 0)::int AS items FROM notification_digests WHERE created_at > now() - ($1 || ' days')::interval GROUP BY frequency`, [d]),
    pool.query(`SELECT reason, COUNT(*)::int AS n FROM notification_digest_items WHERE digest_id IS NULL GROUP BY reason`),
    pool.query(
      `SELECT category, COUNT(*)::int AS sent, COUNT(*) FILTER (WHERE is_read)::int AS read FROM notifications
       WHERE category IS NOT NULL AND created_at > now() - ($1 || ' days')::interval GROUP BY category`,
      [d]
    ),
    settings(),
    windowFor('notification_digest'),
  ]);
  const channels = Object.entries(CHANNELS).map(([key, label]) => {
    const mine = byChannel.rows.filter((r) => r.channel === key);
    const count = (s) => mine.find((r) => r.status === s)?.n || 0;
    return { key, label, available: ready(key), sent: count('sent'), held: count('held'), queued: count('queued'), retrying: count('failed'), dead: count('dead') };
  });
  return {
    days: Number(d),
    channels,
    held: Object.fromEntries(reasons.rows.map((r) => [r.reason, r.n])),
    digests: digests.rows,
    waitingForDigest: Object.fromEntries(pending.rows.map((r) => [r.reason, r.n])),
    readRate: engagement.rows.map((r) => ({ category: r.category, label: CATEGORIES[r.category] || r.category, sent: r.sent, read: r.read, percent: r.sent ? Math.round((r.read / r.sent) * 100) : 0 })),
    settings: { routing: cfg.routing, defaults: cfg.defaults, quiet: cfg.quiet, fatigueDailyCap: cfg.cap, burstMinutes: cfg.burst, lowEngagementCount: cfg.engagement, retrySeconds: cfg.retry, weeklyDay: cfg.weeklyDay },
    digestWindow: win,
    mock: mock(),
  };
}

async function listDeliveries({ status, channel, page = 1, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`d.status = $${params.length}`); }
  if (channel) { params.push(channel); where.push(`d.channel = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM notification_deliveries d ${w}`, params)).rows[0].n;
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pg = Math.max(Number(page) || 1, 1);
  params.push(lim, (pg - 1) * lim);
  const r = await pool.query(
    `SELECT d.id, d.channel, d.type, d.priority, d.title, d.status, d.reason, d.attempts, d.next_attempt_at, d.last_error, d.created_at, d.sent_at, d.digest_id, (d.batch_id IS NOT NULL) AS batched, u.full_name AS user_name
     FROM notification_deliveries d JOIN users u ON u.id = d.user_id ${w} ORDER BY d.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: r.rows, pagination: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) } };
}

// Put a dead letter back in the queue with its retries reset.
async function retryDelivery(admin, id, meta = {}) {
  const r = await pool.query(`UPDATE notification_deliveries SET status = 'queued', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status = 'dead' RETURNING id, user_id, channel`, [id]);
  if (!r.rows.length) throw notFound('No dead-lettered delivery with that id');
  await auditService.log({ actor: admin, action: 'notification.delivery_retried', entityType: 'notification_delivery', entityId: id, after: { channel: r.rows[0].channel }, ...meta });
  await processQueue({ userId: r.rows[0].user_id });
  return (await pool.query('SELECT id, status, attempts, last_error FROM notification_deliveries WHERE id = $1', [id])).rows[0];
}

const windowView = (w) => ({ id: w.window_id, city: w.city, contentType: w.content_type, dayOfWeek: w.day_of_week, timeStart: String(w.time_start).slice(0, 5), timeEnd: String(w.time_end).slice(0, 5), priority: w.priority, notes: w.notes, isActive: w.is_active, updatedAt: w.updated_at });

async function listWindows() {
  return (await pool.query('SELECT * FROM posting_windows ORDER BY content_type, city NULLS FIRST, day_of_week NULLS FIRST, time_start')).rows.map(windowView);
}

function windowInput(data) {
  const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null);
  const start = hhmm(data.timeStart);
  const end = hhmm(data.timeEnd);
  if (!start || !end) throw badRequest('Times must be HH:MM (24-hour, India time)');
  if (end <= start) throw badRequest('The window must end after it starts');
  const type = String(data.contentType || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,39}$/.test(type)) throw badRequest('Content type must be a short name such as notification_digest');
  const day = data.dayOfWeek === null || data.dayOfWeek === undefined || data.dayOfWeek === '' ? null : Number(data.dayOfWeek);
  if (day !== null && !(Number.isInteger(day) && day >= 0 && day <= 6)) throw badRequest('Day of week is 0 (Sunday) to 6 (Saturday), or empty for every day');
  return [data.city ? String(data.city).trim().slice(0, 120) : null, type, day, start, end, Number.isInteger(Number(data.priority)) ? Number(data.priority) : 0, data.notes ? String(data.notes).slice(0, 500) : null, data.isActive === undefined ? true : !!data.isActive];
}

async function saveWindow(admin, id, data, meta = {}) {
  const v = windowInput(data);
  const r = id
    ? await pool.query(`UPDATE posting_windows SET city = $1, content_type = $2, day_of_week = $3, time_start = $4, time_end = $5, priority = $6, notes = $7, is_active = $8, updated_by = $9, updated_at = now() WHERE window_id = $10 RETURNING *`, [...v, admin.id, id])
    : await pool.query(`INSERT INTO posting_windows (city, content_type, day_of_week, time_start, time_end, priority, notes, is_active, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [...v, admin.id]);
  if (!r.rows.length) throw notFound('Posting window not found');
  await auditService.log({ actor: admin, action: id ? 'notification.window_updated' : 'notification.window_created', entityType: 'posting_window', entityId: r.rows[0].window_id, after: windowView(r.rows[0]), ...meta });
  return windowView(r.rows[0]);
}

async function deleteWindow(admin, id, meta = {}) {
  const r = await pool.query('DELETE FROM posting_windows WHERE window_id = $1 RETURNING *', [id]);
  if (!r.rows.length) throw notFound('Posting window not found');
  await auditService.log({ actor: admin, action: 'notification.window_deleted', entityType: 'posting_window', entityId: id, before: windowView(r.rows[0]), ...meta });
  return { deleted: true };
}

// ------------------------------------------------------------ scheduler

let timers = null;
function startScheduler() {
  if (timers) return;
  const safe = (label, fn) => () => fn().catch((err) => console.error(`[notifications] ${label} failed:`, err.message));
  timers = [
    setInterval(safe('queue', () => processQueue()), 15 * 1000),
    setInterval(safe('digest', () => runDigests()), 5 * 60 * 1000),
    setInterval(safe('alerts', () => resolvePersistent()), 15 * 60 * 1000),
  ];
  timers.forEach((t) => t.unref?.());
}

module.exports = {
  CATEGORIES, CHANNELS, FREQUENCIES, PRIORITIES,
  classify, categoryOf, categorySql,
  getPreferences, updatePreferences,
  dispatch, onCreated, processQueue, runDigests, windowFor, quietUntil,
  resolvePersistent, alerts, summary,
  overview, listDeliveries, retryDelivery, listWindows, saveWindow, deleteWindow,
  startScheduler,
};
