const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const intel = require('./notificationIntel.service');
const { formatInr } = require('../utils/price');
const { badRequest } = require('../utils/httpError');

// Daily Market Notification (sec. 20.4).
// Every morning each broker gets one digest about the localities they follow:
// new properties, new buyer requirements, urgent deals and market alerts.
//   Areas     the broker picks cities / localities; until they do, the areas
//             of their own listings are used.
//   Compile   in the 'market_digest_aggregate' posting window (08:30).
//   Send      in the 'market_digest' posting window (09:00 - 10:30): an in-app
//             notification, and WhatsApp / email / push through Notification
//             Intelligence, respecting the person's channel choices and mute.
// Nothing is sent on a day with nothing new. Buyer requirements never carry
// the buyer's name or contact details.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const low = (v) => String(v || '').trim().toLowerCase();

async function settings() {
  const [enabled, roles, max, hours, move] = await Promise.all([
    configService.getConfig('market_digest.enabled', true),
    configService.getConfig('market_digest.roles', null),
    configService.getConfig('market_digest.max_items', 5),
    configService.getConfig('market_digest.lookback_hours', 24),
    configService.getConfig('market_digest.price_move_percent', 2),
  ]);
  return {
    enabled: enabled !== false,
    roles: Array.isArray(roles) && roles.length ? roles : ['broker', 'agency_admin', 'builder'],
    max: Math.min(Math.max(Number(max) || 5, 1), 15),
    hours: Math.min(Math.max(Number(hours) || 24, 1), 168),
    move: Math.max(Number(move) || 0, 0),
  };
}

// ------------------------------------------------------------ areas

function cleanAreas(input) {
  if (!Array.isArray(input)) throw badRequest('areas must be a list of { city, locality }');
  if (input.length > 25) throw badRequest('Follow up to 25 areas');
  const seen = new Set();
  const out = [];
  for (const a of input) {
    const city = String(a?.city || '').trim().slice(0, 120);
    const locality = String(a?.locality || '').trim().slice(0, 160);
    if (city.length < 2) throw badRequest('Each area needs a city');
    const key = `${low(city)}|${low(locality)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(locality ? { city, locality } : { city });
  }
  return out;
}

// The areas a person's digest covers: their own choice, else where their listings are.
async function areasFor(userId) {
  const sub = (await pool.query('SELECT enabled, areas FROM market_digest_subscriptions WHERE user_id = $1', [userId])).rows[0];
  if (sub && !sub.enabled) return { enabled: false, source: 'chosen', areas: sub.areas || [] };
  if (sub && (sub.areas || []).length) return { enabled: true, source: 'chosen', areas: sub.areas };
  const own = (await pool.query(
    `SELECT city, locality, COUNT(*) AS n FROM properties WHERE (created_by = $1 OR broker_id = $1) AND city IS NOT NULL AND status IN ('approved', 'pending_approval')
     GROUP BY city, locality ORDER BY n DESC LIMIT 10`,
    [userId]
  )).rows;
  return { enabled: true, source: own.length ? 'listings' : 'none', areas: own.map((r) => (r.locality ? { city: r.city, locality: r.locality } : { city: r.city })) };
}

// Does a city / locality fall inside the followed areas?
function matcher(areas) {
  const cityWide = new Set(areas.filter((a) => !a.locality).map((a) => low(a.city)));
  const pairs = new Set(areas.filter((a) => a.locality).map((a) => `${low(a.city)}|${low(a.locality)}`));
  const cities = [...new Set(areas.map((a) => low(a.city)))];
  return {
    cities,
    place: (city, locality) => cityWide.has(low(city)) || pairs.has(`${low(city)}|${low(locality)}`),
    // A requirement names several localities (or none, meaning anywhere in the city).
    requirement: (city, localities) => cityWide.has(low(city)) || !(localities || []).length || (localities || []).some((l) => pairs.has(`${low(city)}|${low(typeof l === 'string' ? l : l?.name)}`)),
  };
}

// ------------------------------------------------------------ compile

const where = (r) => [r.locality, r.city].filter(Boolean).join(', ');

async function compile(userId, areas, cfg, now = new Date()) {
  const m = matcher(areas);
  if (!m.cities.length) return { newProperties: [], newRequirements: [], urgentDeals: [], marketAlerts: [], sponsored: null, itemCount: 0 };
  const since = new Date(now.getTime() - cfg.hours * 3600000);
  const [props, reqs, urgent, stats] = await Promise.all([
    pool.query(
      `SELECT id, title, city, locality, price, price_value, bedrooms, property_type::text AS property_type, transaction_type::text AS transaction_type
       FROM properties WHERE status = 'approved' AND listing_category = 'residential' AND COALESCE(approved_at, created_at) > $1 AND lower(city) = ANY($2::text[])
         AND created_by <> $3 AND broker_id IS DISTINCT FROM $3 ORDER BY COALESCE(approved_at, created_at) DESC LIMIT 300`,
      [since, m.cities, userId]
    ),
    pool.query(
      `SELECT id, purpose, property_type::text AS property_type, city, localities, budget_max, bedrooms, urgency::text AS urgency, temperature::text AS temperature
       FROM requirements WHERE status = 'active' AND created_at > $1 AND lower(city) = ANY($2::text[]) AND created_by IS DISTINCT FROM $3
       ORDER BY (temperature::text = 'hot') DESC, created_at DESC LIMIT 300`,
      [since, m.cities, userId]
    ),
    pool.query(
      `SELECT id, title, city, locality, price, reserve_price, listing_category::text AS category, auction_date, discount_percent
       FROM properties WHERE status = 'approved' AND lower(city) = ANY($2::text[]) AND created_by <> $3 AND (
         (listing_category = 'auction' AND auction_date BETWEEN $4 AND $4::timestamptz + interval '14 days')
         OR (listing_category IN ('special_situation', 'auction') AND COALESCE(approved_at, created_at) > $1)
         OR (discount_percent >= 10 AND COALESCE(approved_at, created_at) > $1)
       ) ORDER BY auction_date NULLS LAST, discount_percent DESC NULLS LAST LIMIT 200`,
      [since, m.cities, userId, now]
    ),
    pool.query(
      `SELECT city, locality, ROUND(AVG(avg_price_per_sqft)) AS rate, ROUND(AVG(price_change_percent), 1) AS change, MAX(captured_on) AS captured_on
       FROM market_stats WHERE captured_on >= ($2::timestamptz)::date - 7 AND lower(city) = ANY($1::text[]) AND transaction_type = 'sell' AND price_change_percent IS NOT NULL
       GROUP BY city, locality`,
      [m.cities, now]
    ),
  ]);
  const newProperties = props.rows.filter((p) => m.place(p.city, p.locality)).slice(0, cfg.max).map((p) => ({
    id: p.id, title: p.title, where: where(p), price: p.price, bedrooms: p.bedrooms, propertyType: p.property_type, transactionType: p.transaction_type,
  }));
  const newRequirements = reqs.rows.filter((r) => m.requirement(r.city, r.localities)).slice(0, cfg.max).map((r) => ({
    id: r.id, purpose: r.purpose, propertyType: r.property_type, bedrooms: r.bedrooms, budgetMax: r.budget_max === null ? null : Number(r.budget_max),
    where: [(r.localities || []).slice(0, 2).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean).join(' / '), r.city].filter(Boolean).join(', '), hot: r.temperature === 'hot', immediate: r.urgency === 'immediate',
  }));
  const urgentDeals = urgent.rows.filter((p) => m.place(p.city, p.locality)).slice(0, cfg.max).map((p) => ({
    id: p.id, title: p.title, where: where(p), category: p.category, auctionDate: p.auction_date, price: p.reserve_price ? formatInr(p.reserve_price) : p.price, discountPercent: p.discount_percent === null ? null : Number(p.discount_percent),
  }));
  const marketAlerts = stats.rows
    .filter((s) => Math.abs(Number(s.change)) >= cfg.move && (s.locality ? m.place(s.city, s.locality) : true))
    .sort((a, b) => Math.abs(Number(b.change)) - Math.abs(Number(a.change)))
    .slice(0, cfg.max)
    .map((s) => ({ where: where(s), ratePerSqft: Number(s.rate), changePercent: Number(s.change), capturedOn: s.captured_on }));
  const itemCount = newProperties.length + newRequirements.length + urgentDeals.length + marketAlerts.length;
  return { newProperties, newRequirements, urgentDeals, marketAlerts, sponsored: null, itemCount };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The message as it travels on WhatsApp / push / email.
function render(content, areas) {
  const names = [...new Set(areas.map((a) => a.locality || a.city))];
  const place = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
  const parts = [
    content.newProperties.length ? plural(content.newProperties.length, 'new property', 'new properties') : null,
    content.newRequirements.length ? plural(content.newRequirements.length, 'buyer requirement', 'buyer requirements') : null,
    content.urgentDeals.length ? plural(content.urgentDeals.length, 'urgent deal', 'urgent deals') : null,
    content.marketAlerts.length ? plural(content.marketAlerts.length, 'market alert', 'market alerts') : null,
  ].filter(Boolean);
  const lines = [];
  if (content.newProperties.length) lines.push(`New: ${content.newProperties.slice(0, 3).map((p) => `${p.title} (${p.where}${p.price ? `, ${p.price}` : ''})`).join('; ')}`);
  if (content.newRequirements.length) {
    lines.push(`Buyers: ${content.newRequirements.slice(0, 3).map((r) => `${r.hot ? 'Hot - ' : ''}${[r.bedrooms ? `${r.bedrooms} BHK` : null, r.propertyType, 'to', r.purpose].filter(Boolean).join(' ')} in ${r.where}${r.budgetMax ? ` up to ${formatInr(r.budgetMax)}` : ''}`).join('; ')}`);
  }
  if (content.urgentDeals.length) lines.push(`Urgent: ${content.urgentDeals.slice(0, 2).map((d) => `${d.title} (${d.where})${d.auctionDate ? ` - auction ${new Date(d.auctionDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}` : ''}`).join('; ')}`);
  if (content.marketAlerts.length) lines.push(`Market: ${content.marketAlerts.slice(0, 2).map((a) => `${a.where} ${a.changePercent > 0 ? 'up' : 'down'} ${Math.abs(a.changePercent)}% (Rs ${a.ratePerSqft.toLocaleString('en-IN')}/sq ft)`).join('; ')}`);
  // ar_digest_sponsored goes out as its own follow-up WhatsApp message (see
  // dispatch()), not appended here, so it isn't duplicated across channels.
  return { title: `Today in ${place}: ${parts.join(', ')}`.slice(0, 200), message: lines.join('\n') };
}

// ------------------------------------------------------------ the two daily steps

async function recipients(cfg, userId) {
  const params = [cfg.roles];
  if (userId) params.push(userId);
  return (await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN market_digest_subscriptions s ON s.user_id = u.id
     WHERE r.name = ANY($1::text[]) AND u.status = 'active' AND COALESCE(s.enabled, true) ${userId ? 'AND u.id = $2' : ''}`,
    params
  )).rows.map((r) => r.id);
}

// Step 1: compile today's digest for everyone who has something new.
async function aggregate({ now = new Date(), force = false, userId } = {}) {
  const cfg = await settings();
  if (!cfg.enabled) return { enabled: false, compiled: 0 };
  const win = await intel.windowFor('market_digest_aggregate', { now });
  if (!force && !(win.open || win.passed)) return { enabled: true, open: false, window: win, compiled: 0 };
  let compiled = 0;
  let empty = 0;
  for (const id of await recipients(cfg, userId)) {
    if ((await pool.query('SELECT 1 FROM market_digests WHERE user_id = $1 AND digest_date = $2', [id, win.date])).rows.length) continue;
    const a = await areasFor(id);
    if (!a.areas.length) continue;
    const content = await compile(id, a.areas, cfg, now);
    if (!content.itemCount) {
      empty += 1;
      continue;
    }
    // Module 17: one sponsored line, when a campaign has booked the slot.
    content.sponsored = await require('./advertising.service').digestSponsor(id);
    const r = await pool.query(
      `INSERT INTO market_digests (user_id, digest_date, areas, content, item_count) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, digest_date) DO NOTHING`,
      [id, win.date, JSON.stringify(a.areas), JSON.stringify(content), content.itemCount]
    );
    compiled += r.rowCount;
  }
  return { enabled: true, open: true, date: win.date, compiled, nothingNew: empty };
}

// Step 2: send what was compiled, inside the dispatch window.
async function dispatch({ now = new Date(), force = false, userId } = {}) {
  const cfg = await settings();
  if (!cfg.enabled) return { enabled: false, sent: 0 };
  const win = await intel.windowFor('market_digest', { now });
  if (!force && !win.open) return { enabled: true, open: false, window: win, sent: 0 };
  const params = [win.date];
  if (userId) params.push(userId);
  const due = (await pool.query(`SELECT * FROM market_digests WHERE digest_date = $1 AND sent_at IS NULL ${userId ? 'AND user_id = $2' : ''} ORDER BY created_at LIMIT 5000`, params)).rows;
  let sent = 0;
  for (const d of due) {
    // Claim it first, so two ticks never send the same digest twice.
    if (!(await pool.query('UPDATE market_digests SET sent_at = now() WHERE id = $1 AND sent_at IS NULL', [d.id])).rowCount) continue;
    const msg = render(d.content, d.areas);
    const areaNames = [...new Set((d.areas || []).map((a) => a.locality || a.city))];
    const place = areaNames.slice(0, 2).join(', ') + (areaNames.length > 2 ? ` +${areaNames.length - 2}` : '');
    const broker = (await pool.query('SELECT full_name FROM users WHERE id = $1', [d.user_id])).rows[0];
    const dateDisplay = new Date(d.digest_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    await notificationService.createNotification({
      userId: d.user_id, type: 'market_digest', title: msg.title, message: msg.message,
      relatedEntityType: 'market_digest', relatedEntityId: d.id, scheduled: true,
      // ar_daily_market_digest (approved wording): broker.first_name,
      // broker.localities_display, digest.date_display, digest.new_listings,
      // digest.new_requirements, digest.urgent_deals - 6 separate vars.
      whatsappContent: {
        vars: [
          (broker?.full_name || '').split(' ')[0] || 'there',
          place || 'your areas',
          dateDisplay,
          String(d.content.newProperties?.length || 0),
          String(d.content.newRequirements?.length || 0),
          String(d.content.urgentDeals?.length || 0),
        ],
        buttonUrl: d.id,
      },
    });
    sent += 1;
    // ar_digest_sponsored was approved with a required image header - skip
    // the send (not the digest itself) when the campaign has no image.
    if (d.content.sponsored?.imageUrl) {
      const s = d.content.sponsored;
      await notificationService.createNotification({
        userId: d.user_id, type: 'digest_sponsored', title: 'Sponsored listing', message: s.text || s.headline,
        relatedEntityType: 'market_digest', relatedEntityId: d.id, scheduled: true,
        // ar_digest_sponsored (approved wording): sponsor.headline, sponsor.body - plus an image header.
        whatsappContent: { vars: [s.headline, s.body], headerImage: s.imageUrl ? { link: s.imageUrl } : undefined, buttonUrl: s.campaignId },
      }).catch((err) => console.error('[market digest] sponsored send failed:', err.message));
    }
  }
  return { enabled: true, open: true, date: win.date, sent };
}

async function run(opts = {}) {
  const compiled = await aggregate(opts);
  const sent = await dispatch(opts);
  return { aggregate: compiled, dispatch: sent };
}

// ------------------------------------------------------------ the broker's own view

const digestView = (d) => (d ? { id: d.id, date: d.digest_date, areas: d.areas, itemCount: d.item_count, sentAt: d.sent_at, ...d.content, ...render(d.content, d.areas) } : null);

async function mine(user) {
  const [cfg, a, latest, win] = await Promise.all([
    settings(),
    areasFor(user.id),
    pool.query('SELECT * FROM market_digests WHERE user_id = $1 ORDER BY digest_date DESC LIMIT 7', [user.id]),
    intel.windowFor('market_digest'),
  ]);
  return {
    receives: cfg.enabled && cfg.roles.includes(user.role),
    enabled: a.enabled,
    areas: a.areas,
    areasFrom: a.source,
    sendWindow: win.configured ? { start: win.start, end: win.end } : null,
    latest: digestView(latest.rows[0]),
    history: latest.rows.map((d) => ({ id: d.id, date: d.digest_date, itemCount: d.item_count, sentAt: d.sent_at })),
  };
}

// What today's digest would say right now (nothing is stored or sent).
async function preview(user) {
  const cfg = await settings();
  const a = await areasFor(user.id);
  const content = await compile(user.id, a.areas, cfg);
  return { areas: a.areas, areasFrom: a.source, itemCount: content.itemCount, ...content, ...(content.itemCount ? render(content, a.areas) : { title: null, message: null }) };
}

async function getDigest(user, id) {
  const d = (await pool.query('SELECT * FROM market_digests WHERE id = $1', [id])).rows[0];
  if (!d || (d.user_id !== user.id && !STAFF.includes(user.role))) throw badRequest('Digest not found');
  return digestView(d);
}

async function updateSubscription(user, data = {}, meta = {}) {
  const cur = (await pool.query('SELECT enabled, areas FROM market_digest_subscriptions WHERE user_id = $1', [user.id])).rows[0] || { enabled: true, areas: [] };
  const areas = data.areas === undefined ? cur.areas : cleanAreas(data.areas);
  const enabled = data.enabled === undefined ? cur.enabled : !!data.enabled;
  await pool.query(
    `INSERT INTO market_digest_subscriptions (user_id, enabled, areas) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, areas = EXCLUDED.areas, updated_at = now()`,
    [user.id, enabled, JSON.stringify(areas)]
  );
  await auditService.log({ actor: user, action: 'market_digest.subscription_updated', entityType: 'market_digest_subscription', entityId: user.id, after: { enabled, areas: areas.length }, ...meta });
  return mine(user);
}

// Cities and localities to pick from (geographic master data).
async function areaOptions({ city } = {}) {
  if (!city) return { cities: (await pool.query('SELECT city_name FROM cities ORDER BY city_name')).rows.map((r) => r.city_name) };
  const r = await pool.query(
    `SELECT DISTINCT l.locality_name FROM localities l JOIN cities c ON c.id = l.city_id WHERE lower(c.city_name) = lower($1) AND l.is_active ORDER BY 1 LIMIT 500`,
    [String(city)]
  );
  return { city, localities: r.rows.map((x) => x.locality_name) };
}

// ------------------------------------------------------------ admin

async function overview() {
  const [cfg, days, subs, agg, send] = await Promise.all([
    settings(),
    pool.query(`SELECT digest_date, COUNT(*)::int AS compiled, COUNT(sent_at)::int AS sent, COALESCE(SUM(item_count), 0)::int AS items FROM market_digests WHERE digest_date > CURRENT_DATE - 14 GROUP BY digest_date ORDER BY digest_date DESC`),
    pool.query(`SELECT COUNT(*)::int AS chosen, COUNT(*) FILTER (WHERE NOT enabled)::int AS off FROM market_digest_subscriptions`),
    intel.windowFor('market_digest_aggregate'),
    intel.windowFor('market_digest'),
  ]);
  const eligible = (await recipients(cfg)).length;
  return { settings: cfg, eligible, choseAreas: subs.rows[0].chosen, switchedOff: subs.rows[0].off, compileWindow: agg, sendWindow: send, days: days.rows.map((d) => ({ date: d.digest_date, compiled: d.compiled, sent: d.sent, items: d.items })) };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => run().catch((err) => console.error('[market digest] tick failed:', err.message)), 5 * 60 * 1000);
  timer.unref?.();
}

module.exports = { settings, areasFor, compile, render, aggregate, dispatch, run, mine, preview, getDigest, updateSubscription, areaOptions, overview, startScheduler };
