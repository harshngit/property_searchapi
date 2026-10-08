const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 29 - Gamification & Engagement System.
//
//   Points   are never self-awarded: each rule reads something the platform
//            already recorded (an approved listing, a lead answered inside
//            its SLA, a completed site visit, a closed deal ...) and writes
//            one ledger row per (user, action, entity). Re-running a sync
//            can therefore never double-count.
//   Tiers    Bronze -> Silver -> Gold -> Platinum -> Elite by lifetime points.
//   Boards   platform-wide and area-wise (the city the points were earned
//            in), for the month, the quarter or all time.
// Referral tiers / leaderboards are Phase 2 (CONNECT) and deliberately absent.

const ADMIN = ['admin', 'super_admin'];
const STAFF = ['internal_sales', ...ADMIN];
const PROFESSIONAL = ['broker', 'agency_admin', 'builder'];
const PLAYERS = [...PROFESSIONAL, 'customer'];
const audienceOf = (role) => (PROFESSIONAL.includes(role) ? 'professional' : role === 'customer' ? 'customer' : null);

async function tiers() {
  const t = await configService.getConfig('gamification.tiers', [{ key: 'bronze', label: 'Bronze', min: 0 }]);
  return [...t].sort((a, b) => a.min - b.min);
}
const tierFor = (list, points) => [...list].reverse().find((t) => points >= t.min) || list[0];
const enabled = async () => (await configService.getConfig('gamification.enabled', true)) !== false;

// Each source: rows of (user_id, entity_id, city, earned_at) for one rule.
// `$1` is an optional user id (NULL = everyone).
const SOURCES = {
  listing_approved: `
    SELECT COALESCE(p.broker_id, p.builder_id, p.created_by) AS user_id, p.id::text AS entity_id, p.city, COALESCE(p.approved_at, p.created_at) AS earned_at
    FROM properties p WHERE p.status = 'approved'`,
  listing_verified: `
    SELECT COALESCE(p.broker_id, p.builder_id, p.created_by), p.id::text, p.city, COALESCE(p.approved_at, p.created_at)
    FROM properties p WHERE p.status = 'approved' AND p.is_verified`,
  lead_fast_response: `
    SELECT l.first_contacted_by, l.id::text, p.city, l.first_contacted_at
    FROM leads l LEFT JOIN properties p ON p.id = l.property_id
    WHERE l.first_contacted_by IS NOT NULL AND l.first_contacted_at IS NOT NULL AND (l.response_sla_due_at IS NULL OR l.first_contacted_at <= l.response_sla_due_at)`,
  site_visit_completed: `
    SELECT d.broker_id, v.id::text, p.city, COALESCE(v.actual_visit_at, v.updated_at)
    FROM site_visits v JOIN deals d ON d.id = v.deal_id LEFT JOIN properties p ON p.id = d.property_id WHERE v.status = 'completed'`,
  deal_closed: `
    SELECT d.broker_id, d.id::text, p.city, COALESCE(d.closed_at, d.updated_at)
    FROM deals d LEFT JOIN properties p ON p.id = d.property_id WHERE d.stage = 'closed_won'`,
  deal_completed: `
    SELECT c.user_id, d.id::text, p.city, COALESCE(d.closed_at, d.updated_at)
    FROM deals d JOIN customers c ON c.id = d.customer_id LEFT JOIN properties p ON p.id = d.property_id WHERE d.stage = 'closed_won'`,
  mandate_activated: `
    SELECT m.user_id, m.id::text, p.city, COALESCE(m.acknowledged_at, m.created_at)
    FROM mandates m LEFT JOIN properties p ON p.id = m.listing_id WHERE m.status IN ('active', 'expired') AND m.acknowledged_at IS NOT NULL`,
  review_received: `
    SELECT r.subject_user_id, r.id::text, p.city, r.created_at
    FROM reviews r LEFT JOIN properties p ON p.id = r.property_id WHERE r.status = 'published' AND r.rating >= 4`,
  review_written: `
    SELECT r.reviewer_id, r.id::text, p.city, r.created_at
    FROM reviews r LEFT JOIN properties p ON p.id = r.property_id WHERE r.status = 'published'`,
  profile_verified: `
    SELECT v.user_id, v.kind::text, NULL::varchar, COALESCE(v.decided_at, v.updated_at)
    FROM user_verifications v WHERE v.status = 'verified'`,
  requirement_posted: `
    SELECT c.user_id, r.id::text, r.city, r.created_at
    FROM requirements r JOIN customers c ON c.id = r.customer_id`,
};

// Award everything earned and not yet in the ledger (for one user, or all).
async function sync(userId = null) {
  if (!(await enabled())) return { awarded: 0 };
  const rules = (await pool.query('SELECT * FROM gamification_rules WHERE is_active AND points <> 0')).rows;
  const touched = new Set();
  let awarded = 0;
  for (const rule of rules) {
    const source = SOURCES[rule.action_key];
    if (!source) continue;
    const roles = rule.audience === 'professional' ? PROFESSIONAL : rule.audience === 'customer' ? ['customer'] : PLAYERS;
    const r = await pool.query(
      `INSERT INTO gamification_points (user_id, action_key, points, entity_id, city, earned_at)
       SELECT s.user_id, $2, $3, s.entity_id, s.city, s.earned_at
       FROM (${source}) AS s(user_id, entity_id, city, earned_at)
       JOIN users u ON u.id = s.user_id JOIN roles ro ON ro.id = u.role_id
       WHERE s.user_id IS NOT NULL AND ro.name = ANY($4::text[]) AND u.status = 'active' AND ($1::uuid IS NULL OR s.user_id = $1)
       ON CONFLICT (user_id, action_key, entity_id) DO NOTHING RETURNING user_id`,
      [userId, rule.action_key, rule.points, roles]
    );
    awarded += r.rows.length;
    for (const row of r.rows) touched.add(row.user_id);
  }
  for (const id of touched) await refreshProfile(id);
  return { awarded, users: touched.size };
}

// One ledger row; false when it was already there (or the rule is off).
async function award(userId, actionKey, { entityId, city = null, points = null, note = null, createdBy = null } = {}) {
  const r = await pool.query(
    `INSERT INTO gamification_points (user_id, action_key, points, entity_id, city, note, created_by)
     SELECT $1, g.action_key, COALESCE($4::int, g.points), $3, $5, $6, $7 FROM gamification_rules g
     WHERE g.action_key = $2 AND (g.is_active OR $4::int IS NOT NULL) AND COALESCE($4::int, g.points) <> 0
     ON CONFLICT (user_id, action_key, entity_id) DO NOTHING RETURNING id`,
    [userId, actionKey, String(entityId), points, city, note, createdBy]
  );
  return r.rows.length > 0;
}

// Recompute the total, the tier and the weekly streak; tell the user when they move up.
async function refreshProfile(userId) {
  const list = await tiers();
  const total = (await pool.query('SELECT COALESCE(SUM(points), 0)::int AS n FROM gamification_points WHERE user_id = $1', [userId])).rows[0].n;
  const weeks = (await pool.query(`SELECT DISTINCT date_trunc('week', earned_at)::date AS w FROM gamification_points WHERE user_id = $1 AND action_key <> 'weekly_streak' ORDER BY 1 DESC LIMIT 520`, [userId])).rows.map((r) => r.w);
  const week = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / (7 * 86400000));
  let streak = 0;
  let best = 0;
  let run = 0;
  const thisWeek = week((await pool.query(`SELECT date_trunc('week', now())::date AS w`)).rows[0].w);
  weeks.forEach((w, i) => {
    run = i > 0 && week(weeks[i - 1]) - week(w) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    // The current streak is the run that reaches this week or last week.
    if (i + 1 === run && thisWeek - week(weeks[0]) <= 1) streak = run;
  });
  const tier = tierFor(list, Math.max(total, 0));
  const before = (await pool.query('SELECT tier FROM gamification_profiles WHERE user_id = $1', [userId])).rows[0];
  await pool.query(
    `INSERT INTO gamification_profiles (user_id, total_points, tier, streak_weeks, best_streak_weeks) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET total_points = EXCLUDED.total_points, streak_weeks = EXCLUDED.streak_weeks, best_streak_weeks = GREATEST(gamification_profiles.best_streak_weeks, EXCLUDED.best_streak_weeks),
       tier_since = CASE WHEN gamification_profiles.tier <> EXCLUDED.tier THEN now() ELSE gamification_profiles.tier_since END, tier = EXCLUDED.tier, updated_at = now()`,
    [userId, total, tier.key, streak, best]
  );
  const rank = (k) => list.findIndex((t) => t.key === k);
  if (before && rank(tier.key) > rank(before.tier)) {
    await notificationService.createNotification({ userId, type: 'gamification', title: `You reached ${tier.label}`, message: `${total.toLocaleString('en-IN')} points so far. Keep going.`, relatedEntityType: 'gamification', relatedEntityId: null }).catch(() => {});
  }
  return { total, tier: tier.key, streak };
}

// Called on sign-in: the daily point and, from the second week in a row, the streak bonus.
async function recordLogin(user) {
  try {
    if (!audienceOf(user.role) || !(await enabled())) return;
    const day = (await pool.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d, date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata')::date::text AS w`)).rows[0];
    if (!(await award(user.id, 'daily_login', { entityId: day.d }))) return;
    const p = await refreshProfile(user.id);
    if (p.streak >= 2 && (await award(user.id, 'weekly_streak', { entityId: day.w, note: `${p.streak} weeks in a row` }))) await refreshProfile(user.id);
  } catch (err) {
    console.error('[gamification] login award failed:', err.message);
  }
}

async function me(user) {
  const audience = audienceOf(user.role);
  if (!audience) throw forbidden('Points are for brokers, builders and customers');
  if (!(await enabled())) return { enabled: false };
  await sync(user.id);
  const list = await tiers();
  const profile = (await pool.query('SELECT * FROM gamification_profiles WHERE user_id = $1', [user.id])).rows[0] || { total_points: 0, tier: list[0].key, streak_weeks: 0, best_streak_weeks: 0, tier_since: null };
  const idx = Math.max(list.findIndex((t) => t.key === profile.tier), 0);
  const next = list[idx + 1] || null;
  const [recent, byAction, month, rules, platformRank] = await Promise.all([
    pool.query(`SELECT g.id, g.action_key, COALESCE(r.label, g.action_key) AS label, g.points, g.city, g.note, g.earned_at FROM gamification_points g LEFT JOIN gamification_rules r ON r.action_key = g.action_key WHERE g.user_id = $1 ORDER BY g.earned_at DESC, g.id DESC LIMIT 30`, [user.id]),
    pool.query(`SELECT g.action_key, COALESCE(r.label, g.action_key) AS label, COUNT(*)::int AS times, SUM(g.points)::int AS points FROM gamification_points g LEFT JOIN gamification_rules r ON r.action_key = g.action_key WHERE g.user_id = $1 GROUP BY 1, 2 ORDER BY points DESC`, [user.id]),
    pool.query(`SELECT COALESCE(SUM(points), 0)::int AS n FROM gamification_points WHERE user_id = $1 AND earned_at >= date_trunc('month', now())`, [user.id]),
    pool.query(`SELECT action_key, label, description, points FROM gamification_rules WHERE is_active AND points > 0 AND audience IN ('all', $1) ORDER BY sort_order`, [audience]),
    leaderboard(user, { scope: 'platform', period: 'month', limit: 1 }),
  ]);
  const cities = (await pool.query(`SELECT city, SUM(points)::int AS points FROM gamification_points WHERE user_id = $1 AND city IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [user.id])).rows;
  return {
    enabled: true, audience, totalPoints: profile.total_points, pointsThisMonth: month.rows[0].n,
    tier: list[idx], nextTier: next, pointsToNext: next ? Math.max(next.min - profile.total_points, 0) : 0,
    progressPercent: next ? Math.min(100, Math.round(((profile.total_points - list[idx].min) / (next.min - list[idx].min)) * 100)) : 100,
    tiers: list, tierSince: profile.tier_since, streakWeeks: profile.streak_weeks, bestStreakWeeks: profile.best_streak_weeks,
    rankThisMonth: platformRank.me?.rank || null, cities, recent: recent.rows, byAction: byAction.rows, howToEarn: rules.rows,
  };
}

const PERIODS = { month: `date_trunc('month', now())`, quarter: `date_trunc('quarter', now())`, all: `'-infinity'::timestamptz` };
// Customers are private individuals: first name and initial only.
const publicName = (row, audience) => {
  if (audience === 'professional') return row.business || row.full_name;
  const [first, ...rest] = String(row.full_name || 'Member').trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
};

// Platform-wide, or area-wise when a city is given. Brokers / builders and
// customers are ranked on separate boards.
async function leaderboard(user, { scope = 'platform', city, period = 'month', audience, limit } = {}) {
  if (!(await enabled())) return { enabled: false, items: [] };
  if (!PERIODS[period]) throw badRequest('period must be month, quarter or all');
  const staff = STAFF.includes(user.role);
  const aud = staff ? (audience === 'customer' ? 'customer' : 'professional') : audienceOf(user.role);
  if (!aud) throw forbidden('Leaderboards are for brokers, builders and customers');
  if (scope === 'area' && !city) throw badRequest('Choose the city for the area leaderboard');
  const size = Math.min(Number(limit) || Number(await configService.getConfig('gamification.leaderboard_size', 50)) || 50, 200);
  const min = Number(await configService.getConfig('gamification.leaderboard_min_points', 1)) || 1;
  const list = await tiers();
  const rows = (
    await pool.query(
      `WITH board AS (
         SELECT g.user_id, SUM(g.points)::int AS points
         FROM gamification_points g JOIN users u ON u.id = g.user_id JOIN roles r ON r.id = u.role_id
         WHERE g.earned_at >= ${PERIODS[period]} AND u.status = 'active' AND r.name = ANY($1::text[]) AND ($2::varchar IS NULL OR lower(g.city) = lower($2))
         GROUP BY 1 HAVING SUM(g.points) >= $3
       ), ranked AS (SELECT b.*, RANK() OVER (ORDER BY b.points DESC)::int AS rank FROM board b)
       SELECT k.user_id, k.points, k.rank, u.full_name, t.name AS business, r.name AS role, u.profile_picture_url, COALESCE(p.tier, 'bronze') AS tier, COALESCE(p.total_points, 0) AS total_points,
              (SELECT COUNT(*)::int FROM ranked) AS players
       FROM ranked k JOIN users u ON u.id = k.user_id JOIN roles r ON r.id = u.role_id LEFT JOIN tenants t ON t.id = u.tenant_id AND r.name = 'agency_admin' LEFT JOIN gamification_profiles p ON p.user_id = k.user_id
       WHERE k.rank <= $4 OR k.user_id = $5 ORDER BY k.rank, u.full_name`,
      [aud === 'professional' ? PROFESSIONAL : ['customer'], scope === 'area' ? city : null, min, size, user.id]
    )
  ).rows;
  const shape = (r) => ({ rank: r.rank, userId: aud === 'professional' || staff ? r.user_id : undefined, name: staff ? r.business || r.full_name : publicName(r, aud), role: r.role, points: r.points, tier: list.find((t) => t.key === r.tier) || list[0], isMe: r.user_id === user.id });
  const mine = rows.find((r) => r.user_id === user.id);
  return { enabled: true, scope, city: scope === 'area' ? city : null, period, audience: aud, players: rows[0]?.players || 0, items: rows.filter((r) => r.rank <= size).map(shape), me: mine ? shape(mine) : null };
}

// Cities that have a board, for the area picker.
async function boardCities(user) {
  const aud = STAFF.includes(user.role) ? null : audienceOf(user.role);
  const r = await pool.query(
    `SELECT g.city, COUNT(DISTINCT g.user_id)::int AS players FROM gamification_points g JOIN users u ON u.id = g.user_id JOIN roles r ON r.id = u.role_id
     WHERE g.city IS NOT NULL AND ($1::text[] IS NULL OR r.name = ANY($1::text[])) GROUP BY 1 ORDER BY players DESC, g.city LIMIT 200`,
    [aud ? (aud === 'professional' ? PROFESSIONAL : ['customer']) : null]
  );
  return r.rows;
}

// ------------------------------------------------------------ admin

async function settings() {
  const [rules, list, totals, dist] = await Promise.all([
    pool.query('SELECT * FROM gamification_rules ORDER BY sort_order'),
    tiers(),
    pool.query(`SELECT COUNT(DISTINCT user_id)::int AS players, COALESCE(SUM(points), 0)::int AS points, COALESCE(SUM(points) FILTER (WHERE earned_at >= date_trunc('month', now())), 0)::int AS points_month FROM gamification_points`),
    pool.query('SELECT tier, COUNT(*)::int AS n FROM gamification_profiles GROUP BY 1'),
  ]);
  return {
    enabled: await enabled(), tiers: list.map((t) => ({ ...t, members: dist.rows.find((d) => d.tier === t.key)?.n || 0 })), totals: totals.rows[0],
    rules: rules.rows.map((r) => ({ actionKey: r.action_key, label: r.label, description: r.description, points: r.points, audience: r.audience, isActive: r.is_active, automatic: !!SOURCES[r.action_key] || ['daily_login', 'weekly_streak'].includes(r.action_key) })),
  };
}

async function updateRule(admin, actionKey, { points, isActive }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  if (points !== undefined && !(Number.isInteger(Number(points)) && Number(points) >= 0 && Number(points) <= 10000)) throw badRequest('Points must be a whole number from 0 to 10,000');
  const r = await pool.query(
    'UPDATE gamification_rules SET points = COALESCE($1, points), is_active = COALESCE($2, is_active), updated_by = $3, updated_at = now() WHERE action_key = $4 RETURNING *',
    [points === undefined ? null : Number(points), isActive === undefined ? null : !!isActive, admin.id, actionKey]
  );
  if (!r.rows[0]) throw notFound('Rule not found');
  await auditService.log({ actor: admin, action: 'gamification.rule_updated', entityType: 'gamification_rule', entityId: null, after: { actionKey, points, isActive }, ...meta });
  return r.rows[0];
}

async function updateTiers(admin, list, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  const current = await tiers();
  if (!Array.isArray(list) || list.length !== current.length) throw badRequest('Send a threshold for every tier');
  const next = current.map((t) => ({ ...t, min: Number(list.find((x) => x.key === t.key)?.min) }));
  if (next.some((t) => !Number.isInteger(t.min) || t.min < 0) || next[0].min !== 0) throw badRequest('Thresholds must be whole numbers and the first tier starts at 0');
  if (next.some((t, i) => i > 0 && t.min <= next[i - 1].min)) throw badRequest('Each tier must need more points than the one before');
  await pool.query(`UPDATE app_config SET value = $1 WHERE config_key = 'gamification.tiers'`, [JSON.stringify(next)]);
  configService.invalidate();
  await auditService.log({ actor: admin, action: 'gamification.tiers_updated', entityType: 'app_config', entityId: null, after: { tiers: next }, ...meta });
  // Everyone's tier follows the new thresholds.
  for (const u of (await pool.query('SELECT user_id FROM gamification_profiles')).rows) await refreshProfile(u.user_id);
  return next;
}

// Bonus or correction: a ledger row of its own, never an edit of history.
async function adjust(admin, { userId, points, reason }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  const n = Number(points);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) throw badRequest('Give a whole number of points (negative to deduct)');
  if (!reason || String(reason).trim().length < 5) throw badRequest('Give the reason');
  const u = (await pool.query(`SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0];
  if (!u || !audienceOf(u.role)) throw badRequest('Points can be adjusted for brokers, builders and customers');
  await award(userId, 'manual_adjustment', { entityId: `adj-${Date.now()}`, points: n, note: String(reason).trim().slice(0, 300), createdBy: admin.id });
  await auditService.log({ actor: admin, action: 'gamification.points_adjusted', entityType: 'user', entityId: userId, after: { points: n, reason }, ...meta });
  if (n > 0) await notificationService.createNotification({ userId, type: 'gamification', title: `${n} bonus points`, message: String(reason).trim().slice(0, 200), relatedEntityType: 'gamification', relatedEntityId: null }).catch(() => {});
  return refreshProfile(userId);
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sync().catch((err) => console.error('[gamification] sync failed:', err.message)), 60 * 60 * 1000);
}

module.exports = { sync, award, refreshProfile, recordLogin, me, leaderboard, boardCities, settings, updateRule, updateTiers, adjust, startScheduler, audienceOf };
