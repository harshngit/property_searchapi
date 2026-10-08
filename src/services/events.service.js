const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 9 - Module 48 Customer 360 & Event Capture + Module 49 Lead Scoring.
//   - track(): browser events (POST /events/track) and server events (every
//     business action calls emit()) land in ONE append-only events table.
//   - Anonymous browser ids are linked to the person (identity_links) at
//     login / registration / enquiry; events themselves are never edited -
//     reads join through the links.
//   - After each event the person's Customer 360 profile and 0-100 lead
//     score are recomputed (debounced per customer); the score is copied to
//     their open leads. HOT -> instant alert to the rep / broker; WARM ->
//     daily digest; NURTURE -> weekly summary; COLD -> logged only.
//   - lead_created / property_enquiry / site_visit_requested / deal_closure
//     are forwarded server-side to GA4 Measurement Protocol and Meta CAPI
//     (hashed email / phone, event_id for de-duplication) when configured.

const SERVER_TYPES = new Set([
  'lead_created', 'property_enquiry', 'site_visit_requested', 'site_visit_completed', 'whatsapp_enquiry', 'telegram_enquiry',
  'user_registered', 'broker_registered', 'builder_registered', 'payment_event', 'deal_closure', 'lead_status_changed',
  'crm_activity_logged', 'offer_made', 'shortlist_added', 'login', 'ad_attribution_confirmed', 'requirement_posted',
]);
const FORWARDED = new Set(['lead_created', 'property_enquiry', 'site_visit_requested', 'deal_closure']);
const STAFF = ['internal_sales', 'admin', 'super_admin', 'agency_admin', 'broker'];
const ADMIN = ['admin', 'super_admin'];
const OPEN_LEAD = "status NOT IN ('won', 'lost')";

const clip = (v, n = 64) => (v === null || v === undefined ? null : String(v).slice(0, n));
const sha = (v) => (v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined);

async function browserTypes() {
  return new Set(await configService.getConfig('events.browser_types', ['page_view', 'property_view', 'search_performed', 'button_click', 'whatsapp_click', 'call_click', 'registration_started', 'registration_completed', 'login', 'shortlist_added', 'site_visit_requested']));
}

async function customerForUser(userId) {
  if (!userId) return null;
  return (await pool.query('SELECT id FROM customers WHERE user_id = $1', [userId])).rows[0]?.id || null;
}

async function customerForAnon(anonymousId) {
  if (!anonymousId) return null;
  return (await pool.query('SELECT customer_id, user_id FROM identity_links WHERE anonymous_id = $1', [anonymousId])).rows[0] || null;
}

// Insert one event (never updated afterwards).
async function insert(e) {
  const row = (
    await pool.query(
      `INSERT INTO events (event_id, event_timestamp, event_type, source_track, user_id, anonymous_id, customer_id, lead_id, session_id,
         properties_json, attribution_json, device_json, org_id)
       VALUES (COALESCE($1, gen_random_uuid()), COALESCE($2, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING event_id, event_timestamp`,
      [
        e.eventId || null, e.timestamp || null, e.type, e.track, e.userId || null, clip(e.anonymousId), e.customerId || null, e.leadId || null,
        clip(e.sessionId), JSON.stringify(e.properties || {}), JSON.stringify(e.attribution || {}), JSON.stringify(e.device || {}), e.orgId || null,
      ]
    )
  ).rows[0];
  if (e.customerId) scheduleRefresh(e.customerId);
  if (FORWARDED.has(e.type)) forward({ ...e, eventId: row.event_id, timestamp: row.event_timestamp }).catch(() => {});
  return row;
}

// Browser batch: POST /events/track. Unknown types are dropped (not errors).
async function track(batch, { user = null, ip = null, userAgent = null } = {}) {
  const allowed = await browserTypes();
  const list = (Array.isArray(batch?.events) ? batch.events : [batch]).slice(0, 50);
  let accepted = 0;
  for (const raw of list) {
    if (!raw || !allowed.has(raw.type)) continue;
    const anonymousId = clip(raw.anonymousId || batch.anonymousId);
    let customerId = user ? await customerForUser(user.id) : null;
    if (!customerId && anonymousId) customerId = (await customerForAnon(anonymousId))?.customer_id || null;
    const ts = raw.ts ? new Date(raw.ts) : null;
    const props = typeof raw.properties === 'object' && raw.properties ? raw.properties : {};
    // Never store full IP (DPDP) - only the coarse region the client sent, plus the UA family.
    const device = { ...(typeof raw.device === 'object' ? raw.device : {}), ua: String(userAgent || '').slice(0, 160) };
    await insert({
      type: raw.type, track: 'browser', userId: user?.id || null, anonymousId, customerId,
      sessionId: raw.sessionId || batch.sessionId, properties: props, attribution: raw.attribution || batch.attribution || {},
      device, timestamp: ts && !Number.isNaN(ts.getTime()) && Math.abs(Date.now() - ts.getTime()) < 86400000 ? ts : null,
    });
    accepted += 1;
  }
  void ip;
  return { accepted };
}

// Server events from business code - never throws.
function emit(type, data = {}) {
  if (!SERVER_TYPES.has(type)) return;
  (async () => {
    let customerId = data.customerId || null;
    if (!customerId && data.leadId) customerId = (await pool.query('SELECT customer_id FROM leads WHERE id = $1', [data.leadId])).rows[0]?.customer_id || null;
    if (!customerId && data.userId) customerId = await customerForUser(data.userId);
    let attribution = data.attribution || {};
    if (!Object.keys(attribution).length && customerId) {
      // Carry the person's first / last touch onto business events (closed-loop attribution).
      const p = (await pool.query('SELECT attribution FROM customer_360_profiles WHERE customer_id = $1', [customerId])).rows[0];
      if (p?.attribution) attribution = p.attribution;
    }
    await insert({ type, track: data.track || 'server', userId: data.userId || null, customerId, leadId: data.leadId || null, properties: data.properties || {}, attribution, orgId: data.orgId || null });
  })().catch((err) => console.error(`[events] ${type} failed:`, err.message));
}

// Link a browser's anonymous id to the signed-in person (or an enquirer).
async function identify({ anonymousId, userId = null, customerId = null }) {
  if (!anonymousId) return { linked: false };
  if (!customerId && userId) customerId = await customerForUser(userId);
  if (!userId && !customerId) return { linked: false };
  await pool.query(
    `INSERT INTO identity_links (anonymous_id, user_id, customer_id) VALUES ($1, $2, $3)
     ON CONFLICT (anonymous_id) DO NOTHING`,
    [clip(anonymousId), userId, customerId]
  );
  if (customerId) scheduleRefresh(customerId);
  return { linked: true, customerId };
}

// ---------------------------------------------------------------- partitions

async function ensurePartitions(monthsAhead = 3) {
  for (let i = 0; i <= monthsAhead; i += 1) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + i);
    const start = d.toISOString().slice(0, 7);
    const next = new Date(d);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const name = `events_${start.replace('-', '_')}`;
    await pool.query(
      `DO $$ BEGIN
         IF to_regclass('${name}') IS NULL THEN
           EXECUTE format('CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)', '${name}', '${start}-01', '${next.toISOString().slice(0, 10)}');
         END IF;
       EXCEPTION WHEN others THEN RAISE NOTICE '%', SQLERRM; END $$;`
    );
  }
}

// ---------------------------------------------------------------- Customer 360

// Every event belonging to a person: their customer id, user id, or any
// anonymous browser id linked to them.
function personFilter(alias = 'e') {
  return `(${alias}.customer_id = $1 OR ($2::uuid IS NOT NULL AND ${alias}.user_id = $2)
           OR ${alias}.anonymous_id IN (SELECT anonymous_id FROM identity_links WHERE customer_id = $1 OR ($2::uuid IS NOT NULL AND user_id = $2)))`;
}

async function personIds(customerId) {
  const c = (await pool.query('SELECT id, user_id FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!c) throw notFound('Customer not found');
  return [c.id, c.user_id || null];
}

async function buildProfile(customerId) {
  const ids = await personIds(customerId);
  const f = personFilter();
  const q = (sql, extra = []) => pool.query(sql, [...ids, ...extra]).then((r) => r.rows);
  const [identity] = await q(
    `SELECT c.full_name AS name, c.mobile, c.email, u.referral_code AS coupon_code, r.name AS user_type,
            COALESCE(u.mobile_verified, false) AS mobile_verified, COALESCE(u.email_verified, false) AS email_verified,
            (SELECT city FROM requirements WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1) AS city
     FROM customers c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN roles r ON r.id = u.role_id WHERE c.id = $1 AND ($2::uuid IS NULL OR TRUE)`
  );
  const counts = Object.fromEntries(
    (await q(`SELECT e.event_type, COUNT(*)::int AS n FROM events e WHERE ${f} GROUP BY 1`)).map((r) => [r.event_type, r.n])
  );
  const viewed = await q(
    `SELECT e.properties_json->>'propertyId' AS id, MAX(e.event_timestamp) AS at, MAX(p.title) AS title, MAX(p.locality) AS locality, MAX(p.city) AS city
     FROM events e LEFT JOIN properties p ON p.id::text = e.properties_json->>'propertyId'
     WHERE ${f} AND e.event_type = 'property_view' AND e.properties_json ? 'propertyId'
     GROUP BY 1 ORDER BY at DESC LIMIT 50`
  );
  const searches = await q(
    `SELECT e.properties_json AS filters, e.event_timestamp AS at FROM events e WHERE ${f} AND e.event_type = 'search_performed' ORDER BY e.event_timestamp DESC LIMIT 20`
  );
  const locs = {};
  for (const v of viewed) if (v.locality || v.city) locs[v.locality || v.city] = (locs[v.locality || v.city] || 0) + 2;
  for (const s of searches) {
    const l = s.filters?.locality || s.filters?.city || s.filters?.q;
    if (l) locs[l] = (locs[l] || 0) + 1;
  }
  const budgets = searches.map((s) => [Number(s.filters?.minPrice) || null, Number(s.filters?.maxPrice) || null]).filter(([a, b]) => a || b);
  const [time] = await q(`SELECT COALESCE(SUM((e.properties_json->>'timeOnPageSeconds')::numeric), 0)::float AS secs, MAX(e.event_timestamp) AS last FROM events e WHERE ${f}`);
  const touches = await q(
    `SELECT e.attribution_json AS a, e.event_timestamp AS at FROM events e WHERE ${f} AND e.attribution_json <> '{}'::jsonb
       AND (e.attribution_json ? 'utm_source' OR e.attribution_json ? 'source' OR e.attribution_json ? 'referrer' OR e.attribution_json ? 'first_touch')
     ORDER BY e.event_timestamp`
  );
  const pickTouch = (t) => {
    if (!t) return null;
    const a = t.a.first_touch && typeof t.a.first_touch === 'object' ? t.a.first_touch : t.a;
    return { source: a.utm_source || a.source || null, medium: a.utm_medium || a.medium || null, campaign: a.utm_campaign || a.campaign || null, keyword: a.utm_term || a.keyword || null, ad_id: a.ad_id || a.gclid || a.fbclid || null, landing_page: a.landing_page || null, referrer: a.referrer || null, at: t.at };
  };
  const firstTouch = touches[0] ? pickTouch(touches[0]) : null;
  const lastRaw = touches[touches.length - 1];
  const lastTouch = lastRaw ? pickTouch({ a: lastRaw.a.last_touch && typeof lastRaw.a.last_touch === 'object' ? lastRaw.a.last_touch : lastRaw.a, at: lastRaw.at }) : null;
  const [tx] = await q(
    `SELECT
       (SELECT COUNT(*) FROM property_favorites WHERE customer_id = $1)::int AS shortlisted,
       (SELECT COUNT(*) FROM site_visits sv JOIN deals d ON d.id = sv.deal_id WHERE d.customer_id = $1 AND sv.status = 'completed')::int AS visits_completed,
       (SELECT COUNT(*) FROM deals WHERE customer_id = $1 AND stage = 'closed_won')::int AS deals_closed,
       (SELECT COALESCE(SUM(total_amount), 0) FROM invoices WHERE liable_customer_id = $1 AND status = 'paid')::float AS lifetime_revenue,
       (SELECT COUNT(*) FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id WHERE d.customer_id = $1 AND h.notes ILIKE 'offer%')::int AS offers_logged
     WHERE $2::uuid IS NULL OR TRUE`
  );
  const behaviour = {
    properties_viewed: viewed.map((v) => ({ id: v.id, title: v.title, locality: v.locality, city: v.city, at: v.at })),
    unique_properties_viewed: viewed.length,
    searches_performed: counts.search_performed || 0,
    recent_searches: searches,
    localities_viewed: Object.entries(locs).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, weight]) => ({ name, weight })),
    budget_ranges_explored: budgets.slice(0, 10).map(([min, max]) => ({ min, max })),
    total_platform_time_minutes: Math.round((time?.secs || 0) / 60),
    whatsapp_interactions: (counts.whatsapp_click || 0) + (counts.whatsapp_enquiry || 0),
    call_interactions: counts.call_click || 0,
    site_visit_requests: counts.site_visit_requested || 0,
    page_views: counts.page_view || 0,
  };
  const transactions = {
    offers_made: (counts.offer_made || 0) || tx.offers_logged,
    properties_shortlisted: Math.max(tx.shortlisted, counts.shortlist_added || 0),
    site_visits_completed: tx.visits_completed,
    deals_closed: tx.deals_closed,
    lifetime_revenue_generated: tx.lifetime_revenue,
    enquiries: (counts.property_enquiry || 0) + (counts.lead_created || 0),
  };
  const engagement = Math.min(100, behaviour.page_views + 3 * behaviour.unique_properties_viewed + 5 * behaviour.searches_performed + 10 * (behaviour.whatsapp_interactions + behaviour.call_interactions) + 15 * behaviour.site_visit_requests);
  const attribution = { first_touch: firstTouch, last_touch: lastTouch };
  await pool.query(
    `INSERT INTO customer_360_profiles (customer_id, user_id, identity, behaviour, attribution, transactions, engagement_score, last_active_at, refreshed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (customer_id) DO UPDATE SET user_id = EXCLUDED.user_id, identity = EXCLUDED.identity, behaviour = EXCLUDED.behaviour,
       attribution = EXCLUDED.attribution, transactions = EXCLUDED.transactions, engagement_score = EXCLUDED.engagement_score,
       last_active_at = EXCLUDED.last_active_at, refreshed_at = now()`,
    [customerId, ids[1], JSON.stringify(identity || {}), JSON.stringify(behaviour), JSON.stringify(attribution), JSON.stringify(transactions), engagement, time?.last || null]
  );
  return { customerId, identity, behaviour, attribution, transactions, engagementScore: engagement, lastActiveAt: time?.last || null, counts };
}

// ---------------------------------------------------------------- scoring

async function scoringConfig() {
  return (await pool.query('SELECT * FROM lead_scoring_config ORDER BY display_order, factor_key')).rows;
}

async function updateScoringConfig(items, actor) {
  if (!ADMIN.includes(actor.role)) throw forbidden('Only admins edit scoring rules');
  if (!Array.isArray(items) || !items.length) throw badRequest('Give the factors to update');
  for (const it of items) {
    const points = Number(it.points);
    if (!it.factorKey || !Number.isInteger(points) || points < 0 || points > 100) throw badRequest('Each factor needs a factorKey and integer points 0-100');
    const r = await pool.query(
      `UPDATE lead_scoring_config SET points = $2, active = COALESCE($3, active), condition_json = COALESCE($4, condition_json), updated_by = $5, updated_at = now()
       WHERE factor_key = $1 RETURNING factor_key`,
      [it.factorKey, points, typeof it.active === 'boolean' ? it.active : null, it.condition ? JSON.stringify(it.condition) : null, actor.id]
    );
    if (!r.rows.length) throw badRequest(`Unknown factor ${it.factorKey}`);
  }
  await require('./audit.service').log({ actor, action: 'scoring_config.updated', entityType: 'lead_scoring_config', after: items });
  return scoringConfig();
}

async function thresholds() {
  return { hot: 90, warm: 70, nurture: 40, ...(await configService.getConfig('scoring.thresholds', {})) };
}

const categoryOf = (score, t) => (score >= t.hot ? 'hot' : score >= t.warm ? 'warm' : score >= t.nurture ? 'nurture' : 'cold');

async function computeScore(customerId, profile = null) {
  const p = profile || (await buildProfile(customerId));
  const factors = Object.fromEntries((await scoringConfig()).filter((x) => x.active).map((x) => [x.factor_key, x]));
  const parts = [];
  const add = (key, mult = 1) => {
    const f = factors[key];
    if (!f) return;
    let pts = f.points * mult;
    if (f.condition_json?.cap) pts = Math.min(pts, Number(f.condition_json.cap));
    if (pts > 0) parts.push({ factor: key, label: f.label, points: pts });
  };
  const views = p.behaviour.unique_properties_viewed;
  if (views >= 11) add('views_10_plus');
  else if (views >= 4) add('views_4_10');
  else if (views >= 1) add('views_1_3');
  if (p.behaviour.searches_performed) add('search', p.behaviour.searches_performed);
  if (p.behaviour.whatsapp_interactions) add('whatsapp_click');
  if (p.behaviour.call_interactions) add('call_click');
  if (p.behaviour.site_visit_requests || p.counts.site_visit_requested) add('site_visit_requested');
  if (p.transactions.site_visits_completed || p.counts.site_visit_completed) add('site_visit_completed');
  if (p.counts.registration_completed || p.counts.user_registered || p.identity?.user_type) add('registration');
  if (p.transactions.properties_shortlisted) add('shortlisted');
  if (p.transactions.offers_made) add('offer_made');
  // Budget / location match against live listings.
  const pref = (await pool.query('SELECT budget_max, preferred_locations FROM customer_preferences WHERE customer_id = $1', [customerId])).rows[0];
  const reqRow = (await pool.query(`SELECT budget_max, city, localities FROM requirements WHERE customer_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [customerId])).rows[0];
  const budget = Number(reqRow?.budget_max || pref?.budget_max) || null;
  if (budget && factors.budget_match) {
    const tol = (Number(factors.budget_match.condition_json?.tolerance_percent) || 10) / 100;
    const hit = (await pool.query(`SELECT 1 FROM properties WHERE status = 'approved' AND price_value BETWEEN $1 AND $2 LIMIT 1`, [budget * (1 - tol), budget * (1 + tol)])).rows.length;
    if (hit) add('budget_match');
  }
  const places = [
    ...(reqRow?.localities || []), reqRow?.city,
    ...(Array.isArray(pref?.preferred_locations) ? pref.preferred_locations : []),
    ...p.behaviour.localities_viewed.map((l) => l.name),
  ].filter((x) => typeof x === 'string' && x.trim());
  if (places.length && factors.location_match) {
    const hit = (await pool.query(`SELECT 1 FROM properties WHERE status = 'approved' AND (lower(locality) = ANY($1) OR lower(city) = ANY($1)) LIMIT 1`, [places.map((x) => x.toLowerCase())])).rows.length;
    if (hit) add('location_match');
  }
  const last = p.lastActiveAt ? new Date(p.lastActiveAt) : null;
  if (last) {
    const days = (Date.now() - last.getTime()) / 86400000;
    if (days <= (Number(factors.active_1d?.condition_json?.days) || 1) && factors.active_1d) add('active_1d');
    else if (days <= (Number(factors.active_7d?.condition_json?.days) || 7)) add('active_7d');
  }
  const score = Math.min(100, parts.reduce((s, x) => s + x.points, 0));
  const t = await thresholds();
  const category = categoryOf(score, t);
  const prev = (await pool.query('SELECT category, hot_alerted_at FROM lead_scores WHERE customer_id = $1', [customerId])).rows[0];
  await pool.query(
    `INSERT INTO lead_scores (customer_id, score, category, previous_category, breakdown, last_computed_at) VALUES ($1, $2, $3, NULL, $4, now())
     ON CONFLICT (customer_id) DO UPDATE SET previous_category = lead_scores.category, score = EXCLUDED.score, category = EXCLUDED.category,
       breakdown = EXCLUDED.breakdown, last_computed_at = now(),
       hot_alerted_at = CASE WHEN EXCLUDED.category = 'hot' THEN lead_scores.hot_alerted_at ELSE NULL END`,
    [customerId, score, category, JSON.stringify(parts)]
  );
  await pool.query(`UPDATE leads SET lead_score = $2, lead_score_category = $3 WHERE customer_id = $1 AND ${OPEN_LEAD}`, [customerId, score, category]);
  if (category === 'hot' && !(prev?.category === 'hot' && prev?.hot_alerted_at)) await alertHot(customerId, score);
  return { customerId, score, category, previousCategory: prev?.category || null, breakdown: parts, thresholds: t };
}

// HOT: instant in-app alert to the A R rep and the broker on each open lead.
async function alertHot(customerId, score) {
  const leads = (await pool.query(`SELECT id, arb_rep_id, assigned_to FROM leads WHERE customer_id = $1 AND ${OPEN_LEAD}`, [customerId])).rows;
  const name = (await pool.query('SELECT full_name FROM customers WHERE id = $1', [customerId])).rows[0]?.full_name || 'A lead';
  for (const l of leads) {
    for (const userId of new Set([l.arb_rep_id, l.assigned_to].filter(Boolean))) {
      await notificationService.createNotification({
        userId, type: 'lead_hot', title: `HOT lead: ${name} scored ${score}`,
        message: 'Strong buying signals - call now.', relatedEntityType: 'lead', relatedEntityId: l.id,
      }).catch(() => {});
    }
  }
  await pool.query('UPDATE lead_scores SET hot_alerted_at = now() WHERE customer_id = $1', [customerId]);
}

// Debounced refresh per customer (many events in a burst = one recompute).
const pending = new Map();
function scheduleRefresh(customerId) {
  if (process.env.EVENTS_SYNC_REFRESH === 'true') return refresh(customerId).catch(() => {});
  if (pending.has(customerId)) return;
  pending.set(customerId, setTimeout(() => {
    pending.delete(customerId);
    refresh(customerId).catch((err) => console.error('[events] refresh failed:', err.message));
  }, 1500));
}

async function refresh(customerId) {
  const profile = await buildProfile(customerId);
  return computeScore(customerId, profile);
}

// ---------------------------------------------------------------- digests

async function digests({ force = null } = {}) {
  const out = { warm: 0, nurture: 0 };
  const groups = async (category) => (
    await pool.query(
      `SELECT COALESCE(l.arb_rep_id, l.assigned_to) AS owner, COUNT(*)::int AS n, string_agg(c.full_name, ', ' ORDER BY ls.score DESC) AS names
       FROM leads l JOIN lead_scores ls ON ls.customer_id = l.customer_id JOIN customers c ON c.id = l.customer_id
       WHERE l.${OPEN_LEAD} AND ls.category = $1 AND COALESCE(l.arb_rep_id, l.assigned_to) IS NOT NULL GROUP BY 1`,
      [category]
    )
  ).rows;
  if (force === 'warm' || force === null) {
    for (const g of await groups('warm')) {
      await notificationService.createNotification({ userId: g.owner, type: 'lead_warm_digest', title: `${g.n} WARM lead(s) today`, message: String(g.names).slice(0, 400) }).catch(() => {});
      out.warm += 1;
    }
  }
  if (force === 'nurture' || force === null) {
    for (const g of await groups('nurture')) {
      await notificationService.createNotification({ userId: g.owner, type: 'lead_nurture_summary', title: `${g.n} lead(s) in nurture this week`, message: String(g.names).slice(0, 400) }).catch(() => {});
      out.nurture += 1;
    }
  }
  return out;
}

let timer = null;
let lastDigestDay = null;
function startScheduler() {
  if (timer) return;
  ensurePartitions().catch(() => {});
  timer = setInterval(async () => {
    try {
      const now = new Date(Date.now() + 330 * 60000); // IST
      const hhmm = now.toISOString().slice(11, 16);
      const day = now.toISOString().slice(0, 10);
      const at = await configService.getConfig('scoring.warm_digest_time', '09:30');
      if (hhmm >= at && lastDigestDay !== day) {
        lastDigestDay = day;
        await digests({ force: 'warm' });
        const weekday = Number(await configService.getConfig('scoring.nurture_summary_weekday', 1));
        if (now.getUTCDay() === weekday) await digests({ force: 'nurture' });
        if (now.getUTCDate() === 1) await ensurePartitions();
        // Recency decays - re-score people active in the last 8 days.
        const recent = await pool.query(`SELECT customer_id FROM customer_360_profiles WHERE last_active_at > now() - interval '8 days'`);
        for (const r of recent.rows) await computeScore(r.customer_id).catch(() => {});
      }
    } catch (err) {
      console.error('[events] scheduler failed:', err.message);
    }
  }, 60 * 1000);
}

// ---------------------------------------------------------------- forwarding

// GA4 Measurement Protocol + Meta Conversions API (server-side). Skipped
// unless the client's ids / secrets are configured.
async function forward(e) {
  const c = e.customerId ? (await pool.query('SELECT email, mobile FROM customers WHERE id = $1', [e.customerId])).rows[0] : null;
  const value = Number(e.properties?.value || e.properties?.dealValue) || undefined;
  const tasks = [];
  if (process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET) {
    tasks.push(
      fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: e.anonymousId || e.customerId || e.eventId,
          ...(e.userId ? { user_id: e.userId } : {}),
          events: [{ name: e.type, params: { event_id: e.eventId, ...(value ? { value, currency: 'INR' } : {}), campaign: e.attribution?.first_touch?.campaign || undefined } }],
        }),
      })
    );
  }
  if (process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN) {
    const name = { lead_created: 'Lead', property_enquiry: 'Contact', site_visit_requested: 'Schedule', deal_closure: 'Purchase' }[e.type] || e.type;
    tasks.push(
      fetch(`https://graph.facebook.com/v21.0/${process.env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_CAPI_TOKEN)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [{
            event_name: name, event_time: Math.floor(new Date(e.timestamp || Date.now()).getTime() / 1000), event_id: e.eventId, action_source: 'website',
            user_data: { em: c?.email ? [sha(c.email)] : undefined, ph: c?.mobile ? [sha(`91${String(c.mobile).replace(/\D/g, '').slice(-10)}`)] : undefined },
            custom_data: value ? { value, currency: 'INR' } : undefined,
          }],
        }),
      })
    );
  }
  await Promise.allSettled(tasks);
}

// ---------------------------------------------------------------- reads

async function assertCanSeeCustomer(user, customerId) {
  if (ADMIN.includes(user.role) || user.role === 'internal_sales') return;
  if (!STAFF.includes(user.role)) throw forbidden();
  const ok = await pool.query(
    `SELECT 1 FROM leads WHERE customer_id = $1 AND (created_by = $2 OR assigned_to = $2 OR arb_rep_id = $2 OR ($3::uuid IS NOT NULL AND tenant_id = $3)) LIMIT 1`,
    [customerId, user.id, user.tenant_id || null]
  );
  if (!ok.rows.length) throw notFound('Customer not found');
}

async function c360(user, customerId) {
  await assertCanSeeCustomer(user, customerId);
  const profile = await buildProfile(customerId);
  const score = (await pool.query('SELECT score, category, breakdown, last_computed_at FROM lead_scores WHERE customer_id = $1', [customerId])).rows[0]
    || (await computeScore(customerId, profile));
  const { counts, ...rest } = profile;
  return { ...rest, eventCounts: counts, leadScore: score };
}

async function c360ForLead(user, leadId) {
  const lead = (await pool.query('SELECT customer_id FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) throw notFound('Lead not found');
  return c360(user, lead.customer_id);
}

async function timeline(user, customerId, { page = 1, limit = 50 } = {}) {
  await assertCanSeeCustomer(user, customerId);
  const ids = await personIds(customerId);
  const lim = Math.min(Number(limit) || 50, 200);
  const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const rows = (
    await pool.query(
      `SELECT e.event_id, e.event_type, e.source_track, e.event_timestamp, e.properties_json, e.attribution_json, e.lead_id
       FROM events e WHERE ${personFilter()} ORDER BY e.event_timestamp DESC LIMIT $3 OFFSET $4`,
      [...ids, lim, off]
    )
  ).rows;
  return { page: Number(page) || 1, limit: lim, items: rows };
}

async function scoreForLead(user, leadId) {
  const lead = (await pool.query('SELECT customer_id FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) throw notFound('Lead not found');
  await assertCanSeeCustomer(user, lead.customer_id);
  return computeScore(lead.customer_id);
}

module.exports = {
  SERVER_TYPES,
  track,
  emit,
  identify,
  ensurePartitions,
  buildProfile,
  computeScore,
  refresh,
  scoringConfig,
  updateScoringConfig,
  digests,
  startScheduler,
  c360,
  c360ForLead,
  timeline,
  scoreForLead,
};
