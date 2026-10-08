const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const { formatInr } = require('../utils/price');
const { notFound } = require('../utils/httpError');

// Module 6 / Annexure A sec. 8 - Trust & Reputation.
//
// Trust score 0-100 = Verification 20% + Deal count 30% + Response time 20%
// + Ratings 25% + Geo-validation 5% (binding weights, admin-configurable),
// plus the one-time +5 Exclusive Mandate bonus. Recomputed on every
// relevant event (deal closure, review, verification decision, listing
// approval) and by the daily batch.
//
// Badges (sec. 8.2) are awarded automatically when their criteria are met;
// when criteria lapse the badge goes to "warning" and is revoked after 7
// days (sec. 8.3) - the Exclusive Mandate badge is revoked at once on
// expiry. Featured Agent (weekly, top 50 per region) and Best Broker
// (quarterly / annual, per region) are award badges with a period.
// Badges drive search ranking boosts and lead priority in matching.

const DEFAULT_WEIGHTS = { verification: 20, deals: 30, response: 20, ratings: 25, geo: 5 };
const BROKER_ROLES = ['broker', 'agency_admin'];
const LISTER_ROLES = ['broker', 'agency_admin', 'builder', 'customer'];

const BADGES = {
  verified_user: { label: 'Verified User', effect: 'Base trust' },
  verified_broker: { label: 'Verified Broker', effect: 'Search boost' },
  verified_builder: { label: 'Verified Builder', effect: 'Search boost' },
  top_broker: { label: 'Top Broker', effect: 'Lead priority, commission discount' },
  highly_rated: { label: 'Highly Rated', effect: 'Search boost' },
  quick_responder: { label: 'Quick Responder', effect: 'Profile badge' },
  zero_disputes: { label: 'Zero Disputes', effect: 'Trust signal' },
  network_builder: { label: 'Network Builder', effect: 'Profile + listing visibility boost' },
  trusted_introducer: { label: 'Trusted Introducer', effect: 'Higher trust weighting' },
  community_champion: { label: 'Community Champion', effect: 'Featured newsletter + credit bonus' },
  institutional_specialist: { label: 'Institutional Specialist', effect: 'Institutional deal access' },
  featured_agent: { label: 'Featured Agent', effect: 'Weekly regional feature', award: true },
  best_broker: { label: 'Best Broker', effect: 'Trophy + commission discount', award: true },
  exclusive_mandate: { label: 'Exclusive Mandate', effect: 'Mandate holder' },
};
const CONTINUOUS = Object.keys(BADGES).filter((k) => !BADGES[k].award);
const SHAREABLE = ['featured_agent', 'best_broker', 'top_broker', 'highly_rated', 'community_champion'];

async function cfg() {
  const [weights, items, dealFull, respFull, respZero, prior, mandateBonus, badges, warnDays] = await Promise.all([
    configService.getConfig('trust.weights', DEFAULT_WEIGHTS),
    configService.getConfig('trust.verification_items', {}),
    configService.getConfig('trust.deal_count_for_full_score', 25),
    configService.getConfig('trust.response_full_score_minutes', 30),
    configService.getConfig('trust.response_zero_score_minutes', 1440),
    configService.getConfig('trust.rating_prior', { mean: 3.5, weight: 3 }),
    configService.getConfig('trust.mandate_bonus', 5),
    configService.getConfig('trust.badges', {}),
    configService.getConfig('trust.badge_revoke_warning_days', 7),
  ]);
  return {
    weights: { ...DEFAULT_WEIGHTS, ...(weights || {}) },
    items: items || {},
    dealFull: Number(dealFull) || 25,
    respFull: Number(respFull) || 30,
    respZero: Number(respZero) || 1440,
    prior: { mean: 3.5, weight: 3, ...(prior || {}) },
    mandateBonus: Number(mandateBonus) || 0,
    badges: badges || {},
    warnDays: Number(warnDays) || 7,
  };
}

async function tableExists(name) {
  const r = await pool.query('SELECT to_regclass($1) AS t', [name]);
  return !!r.rows[0].t;
}

// ------------------------------------------------------------------ inputs

async function gatherInputs(userId) {
  const u = (
    await pool.query(
      `SELECT u.id, u.full_name, u.email, u.mobile, u.email_verified, u.mobile_verified, u.profile_picture_url,
              u.status, u.created_at, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [userId]
    )
  ).rows[0];
  if (!u) throw notFound('User not found');

  const [verifs, deals, instDeals, response, ratings, listings, referrals, mandate, customer] = await Promise.all([
    pool.query(`SELECT kind, status FROM user_verifications WHERE user_id = $1`, [userId]),
    // Completed transactions: broker of record, builder / lister of the
    // property, or the customer on the deal; plus investment deals closed.
    pool.query(
      `SELECT COUNT(DISTINCT d.id)::int AS n, COALESCE(SUM(d.deal_value), 0) AS value
       FROM deals d
       LEFT JOIN properties p ON p.id = d.property_id
       LEFT JOIN customers c ON c.id = d.customer_id
       WHERE d.stage = 'closed_won'
         AND (d.broker_id = $1 OR p.builder_id = $1 OR p.created_by = $1 OR c.user_id = $1)`,
      [userId]
    ),
    pool.query(
      // Closed institutional deals: the ordinary pipeline plus the Engine 7 nine-stage pipeline.
      `SELECT ((SELECT COUNT(DISTINCT d.id) FROM deals d JOIN properties p ON p.id = d.property_id
                WHERE d.stage = 'closed_won' AND p.listing_category = 'institutional' AND (d.broker_id = $1 OR p.created_by = $1))
             + (SELECT COUNT(*) FROM institutional_deals i JOIN properties p ON p.id = i.property_id
                WHERE i.status = 'closed_won' AND (p.broker_id = $1 OR p.created_by = $1)))::int AS n`,
      [userId]
    ),
    // First response on leads assigned to the user in the last 180 days:
    // their first status change or note after the lead arrived.
    pool.query(
      `SELECT l.id, l.created_at,
              LEAST(
                (SELECT MIN(a.created_at) FROM lead_activity_log a WHERE a.lead_id = l.id AND a.user_id = $1 AND a.action = 'status_changed'),
                (SELECT MIN(n.created_at) FROM lead_notes n WHERE n.lead_id = l.id AND n.user_id = $1)
              ) AS first_response
       FROM leads l WHERE l.assigned_to = $1 AND l.created_at > now() - interval '180 days'`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(rating), 0)::int AS total, AVG(rating) AS avg
       FROM reviews WHERE subject_user_id = $1 AND status = 'published'`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS active,
              -- Geo-validation (sec. 8.1): coordinates in India and no listing
              -- photo whose EXIF GPS is far (> ~5 km) from them.
              COUNT(*) FILTER (WHERE latitude BETWEEN 6 AND 37.6 AND longitude BETWEEN 68 AND 97.5
                AND NOT EXISTS (SELECT 1 FROM property_media pm WHERE pm.property_id = properties.id AND pm.exif_lat IS NOT NULL
                                AND (abs(pm.exif_lat - properties.latitude) > 0.045 OR abs(pm.exif_lng - properties.longitude) > 0.05)))::int AS geo_valid,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM property_media pm WHERE pm.property_id = properties.id AND pm.exif_lat IS NOT NULL
                                AND abs(pm.exif_lat - properties.latitude) <= 0.045 AND abs(pm.exif_lng - properties.longitude) <= 0.05))::int AS exif_matched,
              MODE() WITHIN GROUP (ORDER BY city) FILTER (WHERE status = 'approved') AS region
       FROM properties WHERE (created_by = $1 OR broker_id = $1) AND status IN ('approved', 'inactive', 'pending_approval')`,
      [userId]
    ),
    // Activated referral = the referred person onboarded, listed, posted a
    // requirement or enquired. Retention = activated ones seen in 90 days.
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE act)::int AS activated,
              COUNT(*) FILTER (WHERE act AND last_login_at > now() - interval '90 days')::int AS retained
       FROM (
         SELECT u.last_login_at,
                (c.onboarded_at IS NOT NULL
                 OR EXISTS (SELECT 1 FROM properties p WHERE p.created_by = u.id)
                 OR EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = c.id)) AS act
         FROM referral_tree rt JOIN users u ON u.id = rt.referred_id
         LEFT JOIN customers c ON c.user_id = u.id
         WHERE rt.referrer_id = $1
       ) x`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM properties WHERE (created_by = $1 OR broker_id = $1) AND status = 'approved' AND mandate_type = 'exclusive'`,
      [userId]
    ),
    pool.query('SELECT onboarded_at, portal_roles FROM customers WHERE user_id = $1', [userId]),
  ]);

  let disputes = { open: 0, total: 0 };
  if (await tableExists('disputes')) {
    const d = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'dismissed', 'closed'))::int AS open, COUNT(*)::int AS total
       FROM disputes WHERE against_user_id = $1`,
      [userId]
    );
    disputes = d.rows[0];
  }

  const verified = Object.fromEntries(verifs.rows.map((v) => [v.kind, v.status]));
  const now = Date.now();
  const leads = response.rows;
  const times = leads.map((l) => {
    if (l.first_response) return Math.max(0, (new Date(l.first_response) - new Date(l.created_at)) / 60000);
    const age = (now - new Date(l.created_at)) / 60000;
    return age > 24 * 60 ? Infinity : null; // unanswered for a day counts as a miss; newer ones are pending
  }).filter((t) => t !== null);

  // Profile completeness: name, email, phone, photo, verified email, verified phone (+ onboarding for customers).
  const checks = [!!u.full_name, !!u.email, !!u.mobile, !!u.profile_picture_url, u.email_verified, u.mobile_verified];
  if (u.role === 'customer') checks.push(!!customer.rows[0]?.onboarded_at);
  const profilePercent = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  return {
    user: u,
    verified,
    profilePercent,
    deals: deals.rows[0].n,
    dealValue: Number(deals.rows[0].value) || 0,
    institutionalDeals: instDeals.rows[0].n,
    responseSamples: times.length,
    avgResponseMinutes: times.length ? times.reduce((a, t) => a + (Number.isFinite(t) ? t : 24 * 60), 0) / times.length : null,
    respondedWithin: (mins) => (times.length ? times.filter((t) => t <= mins).length / times.length : 0),
    reviews: ratings.rows[0].n,
    ratingTotal: ratings.rows[0].total,
    ratingAvg: ratings.rows[0].avg != null ? Math.round(Number(ratings.rows[0].avg) * 10) / 10 : null,
    listings: listings.rows[0],
    region: listings.rows[0].region || null,
    referrals: referrals.rows[0],
    activeMandates: mandate.rows[0].n,
    disputes,
  };
}

// ----------------------------------------------------------------- scoring

function verificationItemsFor(role, c) {
  return c.items[role] || (BROKER_ROLES.includes(role) ? ['email', 'phone', 'kyc', 'rera', 'gst'] : ['email', 'phone', 'kyc']);
}

function computeComponents(inp, c) {
  const items = verificationItemsFor(inp.user.role, c);
  const done = items.filter((k) =>
    k === 'email' ? inp.user.email_verified : k === 'phone' ? inp.user.mobile_verified : inp.verified[k] === 'verified'
  );
  const verification = Math.round((done.length / items.length) * 100);

  const deals = Math.round(100 * Math.min(1, Math.log(1 + inp.deals) / Math.log(1 + c.dealFull)));

  let response = 50; // no inquiries yet - neutral
  if (inp.avgResponseMinutes != null) {
    const m = inp.avgResponseMinutes;
    response = m <= c.respFull ? 100 : m >= c.respZero ? 0 : Math.round(100 * (1 - (m - c.respFull) / (c.respZero - c.respFull)));
  }

  const bayes = (c.prior.mean * c.prior.weight + inp.ratingTotal) / (c.prior.weight + inp.reviews);
  const ratings = Math.round(((bayes - 1) / 4) * 100);

  const geo = inp.listings.total ? Math.round((inp.listings.geo_valid / inp.listings.total) * 100) : 50;

  return {
    verification: { score: verification, detail: `${done.length} of ${items.length} verified (${items.join(', ')})`, missing: items.filter((k) => !done.includes(k)) },
    deals: { score: deals, detail: `${inp.deals} completed deal${inp.deals === 1 ? '' : 's'}` },
    response: {
      score: response,
      detail: inp.avgResponseMinutes == null ? 'No inquiries yet' : `Average first response ${Math.round(inp.avgResponseMinutes)} min over ${inp.responseSamples} inquiries`,
    },
    ratings: { score: ratings, detail: inp.reviews ? `${inp.ratingAvg} average from ${inp.reviews} review${inp.reviews === 1 ? '' : 's'}` : 'No reviews yet' },
    geo: {
      score: geo,
      detail: inp.listings.total
        ? `${inp.listings.geo_valid} of ${inp.listings.total} listings geo-located${inp.listings.exif_matched ? `, ${inp.listings.exif_matched} confirmed by photo GPS` : ''}`
        : 'No listings',
    },
  };
}

// Badge criteria (sec. 8.2). Returns { key: boolean }.
function badgeCriteria(inp, score, c) {
  const b = (k) => c.badges[k] || {};
  const role = inp.user.role;
  const v = (k) => inp.verified[k] === 'verified';
  const activated = inp.referrals.activated || 0;
  const retention = activated ? (inp.referrals.retained / activated) * 100 : 0;
  const quick = b('quick_responder');
  return {
    verified_user: inp.user.email_verified && inp.user.mobile_verified && inp.profilePercent >= (b('verified_user').profile_min_percent ?? 70),
    verified_broker: BROKER_ROLES.includes(role) && v('kyc') && v('rera') && inp.deals >= (b('verified_broker').min_deals ?? 2),
    verified_builder: role === 'builder' && v('company') && v('rera') && inp.listings.active >= (b('verified_builder').min_active_listings ?? 5),
    top_broker: BROKER_ROLES.includes(role) && score >= (b('top_broker').min_score ?? 85) && inp.deals >= (b('top_broker').min_deals ?? 25),
    highly_rated: inp.reviews >= (b('highly_rated').min_reviews ?? 10) && (inp.ratingAvg || 0) >= (b('highly_rated').min_avg ?? 4.5),
    quick_responder:
      inp.responseSamples >= (quick.min_inquiries ?? 5) && inp.respondedWithin(quick.within_minutes ?? 120) * 100 >= (quick.min_percent ?? 90),
    zero_disputes: inp.deals >= (b('zero_disputes').min_deals ?? 100) && inp.disputes.open === 0,
    network_builder: activated >= (b('network_builder').min_activated ?? 10),
    trusted_introducer: activated >= (b('trusted_introducer').min_activated ?? 25) && retention >= (b('trusted_introducer').min_retention_percent ?? 60),
    community_champion: activated >= (b('community_champion').min_activated ?? 50),
    institutional_specialist: inp.institutionalDeals >= (b('institutional_specialist').min_institutional_deals ?? 5) && v('institutional_cert'),
    exclusive_mandate: inp.activeMandates > 0,
  };
}

async function notify(userId, title, message, badgeKey) {
  await notificationService
    .createNotification({ userId, type: 'trust_badge', title, message, relatedEntityType: 'badge', relatedEntityId: null })
    .catch(() => {});
  return badgeKey;
}

// Apply criteria to user_badges with the warning / revocation lifecycle.
async function applyBadges(userId, criteria, c) {
  const live = await pool.query(`SELECT * FROM user_badges WHERE user_id = $1 AND status <> 'revoked' AND period IS NULL`, [userId]);
  const byKey = new Map(live.rows.map((r) => [r.badge_key, r]));
  const changes = [];
  for (const key of CONTINUOUS) {
    const met = !!criteria[key];
    const row = byKey.get(key);
    const label = BADGES[key].label;
    if (met && !row) {
      await pool.query(`INSERT INTO user_badges (user_id, badge_key) VALUES ($1, $2)`, [userId, key]);
      changes.push(await notify(userId, `You earned the ${label} badge`, `${label}: ${BADGES[key].effect}. It shows on your profile and listings.`, `+${key}`));
    } else if (met && row?.status === 'warning') {
      await pool.query(`UPDATE user_badges SET status = 'active', warning_at = NULL WHERE id = $1`, [row.id]);
      changes.push(`restored:${key}`);
    } else if (!met && row) {
      if (key === 'exclusive_mandate') {
        await pool.query(`UPDATE user_badges SET status = 'revoked', revoked_at = now() WHERE id = $1`, [row.id]);
        changes.push(await notify(userId, 'Exclusive Mandate badge removed', 'Your Exclusive Mandate has ended, so the badge was removed.', `-${key}`));
      } else if (row.status === 'active') {
        await pool.query(`UPDATE user_badges SET status = 'warning', warning_at = now() WHERE id = $1`, [row.id]);
        changes.push(
          await notify(userId, `${label} badge at risk`, `You no longer meet the ${label} criteria. The badge is removed in ${c.warnDays} days unless the criteria are met again.`, `!${key}`)
        );
      } else if (row.status === 'warning' && new Date(row.warning_at).getTime() <= Date.now() - c.warnDays * 86400000) {
        await pool.query(`UPDATE user_badges SET status = 'revoked', revoked_at = now() WHERE id = $1`, [row.id]);
        changes.push(await notify(userId, `${label} badge removed`, `The ${label} criteria were not met within ${c.warnDays} days.`, `-${key}`));
      }
    }
  }
  return changes;
}

async function activeBadges(userId) {
  const r = await pool.query(
    `SELECT id, badge_key, status, period, region, meta, awarded_at, warning_at FROM user_badges
     WHERE user_id = $1 AND status <> 'revoked' ORDER BY awarded_at`,
    [userId]
  );
  return r.rows.map((b) => ({
    ...b,
    label: `${BADGES[b.badge_key]?.label || b.badge_key}${b.period ? ` ${b.period}` : ''}`,
    effect: BADGES[b.badge_key]?.effect || null,
    shareable: SHAREABLE.includes(b.badge_key),
  }));
}

// Recompute one user's trust score + badges. Returns the saved row.
async function recompute(userId, reason = 'event') {
  const c = await cfg();
  const inp = await gatherInputs(userId);
  const components = computeComponents(inp, c);
  let score = Object.entries(c.weights).reduce((sum, [k, w]) => sum + (components[k]?.score || 0) * (Number(w) / 100), 0);

  // Module 46 one-time mandate bonus - awarded on the first activation, kept after.
  const existing = (await pool.query('SELECT score, mandate_bonus_awarded_at FROM trust_scores WHERE user_id = $1', [userId])).rows[0];
  let bonusAt = existing?.mandate_bonus_awarded_at || null;
  if (!bonusAt && inp.activeMandates > 0) bonusAt = new Date();
  if (bonusAt) score += c.mandateBonus;
  // Module 44 Reputation Graph: bounded network adjustment (who you work
  // with, weighted by quality) - computed by reputation.service.
  const rep = (await pool.query('SELECT adjustment, network_score, neighbours FROM reputation_scores WHERE user_id = $1', [userId]).catch(() => ({ rows: [] }))).rows[0];
  const networkAdjustment = rep ? Number(rep.adjustment) || 0 : 0;
  score += networkAdjustment;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const criteria = badgeCriteria(inp, score, c);
  const changes = await applyBadges(userId, criteria, c);
  const badges = await activeBadges(userId);
  const boostOf = (k) => Number(c.badges[k]?.search_boost) || 0;
  const searchBoost = badges.filter((b) => b.status !== 'revoked').reduce((s, b) => s + boostOf(b.badge_key), 0) + Math.round(score / 20);
  const leadPriority = badges.some((b) => b.badge_key === 'top_broker');

  const inputs = {
    role: inp.user.role,
    profilePercent: inp.profilePercent,
    deals: inp.deals,
    dealValue: inp.dealValue,
    institutionalDeals: inp.institutionalDeals,
    avgResponseMinutes: inp.avgResponseMinutes != null ? Math.round(inp.avgResponseMinutes) : null,
    responseSamples: inp.responseSamples,
    respondedWithin2hPercent: Math.round(inp.respondedWithin(120) * 100),
    reviews: inp.reviews,
    ratingAvg: inp.ratingAvg,
    listings: inp.listings.total,
    activeListings: inp.listings.active,
    referrals: inp.referrals,
    activeMandates: inp.activeMandates,
    disputes: inp.disputes,
    mandateBonus: bonusAt ? c.mandateBonus : 0,
    networkAdjustment,
    networkScore: rep?.network_score != null ? Number(rep.network_score) : null,
    networkNeighbours: rep?.neighbours || 0,
  };
  const saved = await pool.query(
    `INSERT INTO trust_scores (user_id, score, components, inputs, search_boost, lead_priority, region, mandate_bonus_awarded_at, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET score = EXCLUDED.score, components = EXCLUDED.components, inputs = EXCLUDED.inputs,
       search_boost = EXCLUDED.search_boost, lead_priority = EXCLUDED.lead_priority, region = EXCLUDED.region,
       mandate_bonus_awarded_at = EXCLUDED.mandate_bonus_awarded_at, computed_at = now()
     RETURNING *`,
    [userId, score, JSON.stringify(components), JSON.stringify(inputs), searchBoost, leadPriority, inp.region, bonusAt]
  );
  if (!existing || existing.score !== score) {
    await pool.query('INSERT INTO trust_score_history (user_id, score, reason) VALUES ($1, $2, $3)', [userId, score, String(reason).slice(0, 60)]);
  }
  return { ...saved.rows[0], badges, changes, criteria };
}

function safeRecompute(userId, reason) {
  if (!userId) return;
  recompute(userId, reason).catch((err) => console.error(`[trust] recompute ${userId} failed:`, err.message));
}

// ------------------------------------------------------------------ reads

function nextSteps(row) {
  const steps = [];
  const comp = row.components || {};
  for (const k of comp.verification?.missing || []) {
    steps.push(
      { email: 'Verify your email', phone: 'Verify your mobile number', kyc: 'Complete KYC', rera: 'Add your RERA registration', gst: 'Add your GSTIN', company: 'Add company registration' }[k] || `Verify ${k}`
    );
  }
  if ((row.inputs?.listings || 0) > 0 && (comp.geo?.score || 0) < 100) steps.push('Add map coordinates to all your listings');
  if ((comp.response?.score ?? 100) < 70) steps.push('Respond to new inquiries faster (under 30 minutes scores full marks)');
  return steps;
}

async function getProfile(userId, { refresh = false } = {}) {
  let row = (await pool.query('SELECT * FROM trust_scores WHERE user_id = $1', [userId])).rows[0];
  if (!row || refresh || Date.now() - new Date(row.computed_at).getTime() > 6 * 3600 * 1000) row = await recompute(userId, 'view');
  const [badges, history, verifications, c] = await Promise.all([
    activeBadges(userId),
    pool.query('SELECT score, reason, created_at FROM trust_score_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [userId]),
    pool.query('SELECT id, kind, reference, status, notes, decided_at, created_at, (document_path IS NOT NULL) AS has_document FROM user_verifications WHERE user_id = $1', [userId]),
    cfg(),
  ]);
  return {
    userId,
    score: row.score,
    weights: c.weights,
    components: row.components,
    inputs: row.inputs,
    searchBoost: Number(row.search_boost),
    leadPriority: row.lead_priority,
    region: row.region,
    computedAt: row.computed_at,
    badges,
    history: history.rows,
    verifications: verifications.rows,
    nextSteps: nextSteps(row),
    commissionDiscount: badges.some((b) => ['top_broker', 'best_broker'].includes(b.badge_key)),
  };
}

// Public trust card for a listing - no identity, no contact (controlled
// contact architecture): lister role, score, badges, rating + reviews,
// and the ownership timestamp (first valid entry wins disputes).
async function publicForListing(propertyId) {
  const p = (
    await pool.query(
      `SELECT p.id, p.created_at, p.created_by, p.broker_id, p.builder_id, r.name AS role
       FROM properties p LEFT JOIN users u ON u.id = COALESCE(p.broker_id, p.builder_id, p.created_by)
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE p.id = $1 AND p.status IN ('approved', 'inactive')`,
      [propertyId]
    )
  ).rows[0];
  if (!p) throw notFound('Listing not found');
  const lister = p.broker_id || p.builder_id || p.created_by;
  const row = (await pool.query('SELECT * FROM trust_scores WHERE user_id = $1', [lister])).rows[0] || (await recompute(lister, 'view'));
  const [badges, reviews] = await Promise.all([
    activeBadges(lister),
    pool.query(
      `SELECT rv.id, rv.rating, rv.title, rv.body, rv.interaction, rv.reply, rv.replied_at, rv.created_at,
              split_part(u.full_name, ' ', 1) AS reviewer_first_name, COALESCE(rv.property_id = $2, false) AS for_this_listing
       FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
       WHERE (rv.subject_user_id = $1 OR rv.property_id = $2) AND rv.status = 'published' ORDER BY (rv.property_id = $2) DESC NULLS LAST, rv.created_at DESC LIMIT 20`,
      [lister, propertyId]
    ),
  ]);
  const listerType = { broker: 'broker', agency_admin: 'broker', builder: 'builder', customer: 'owner' }[p.role] || 'lister';
  return {
    listerType,
    trustScore: row.score,
    badges: badges.filter((b) => b.status !== 'revoked').map((b) => ({ key: b.badge_key, label: b.label, effect: b.effect })),
    rating: { average: row.inputs?.ratingAvg ?? null, count: row.inputs?.reviews || 0 },
    completedDeals: row.inputs?.deals || 0,
    reviews: reviews.rows,
    firstListedAt: p.created_at,
  };
}

async function leaderboard({ region, limit = 50 } = {}) {
  const params = [];
  let where = `r.name IN ('broker', 'agency_admin', 'builder')`;
  if (region) {
    params.push(region);
    where += ` AND ts.region ILIKE $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 50, 200));
  const rows = await pool.query(
    `SELECT ts.user_id, u.full_name, r.name AS role, ts.score, ts.region, ts.inputs, ts.search_boost, ts.lead_priority,
            (SELECT COALESCE(json_agg(ub.badge_key), '[]'::json) FROM user_badges ub WHERE ub.user_id = ts.user_id AND ub.status <> 'revoked') AS badges
     FROM trust_scores ts JOIN users u ON u.id = ts.user_id JOIN roles r ON r.id = u.role_id
     WHERE ${where} ORDER BY ts.score DESC LIMIT $${params.length}`,
    params
  );
  return rows.rows;
}

// ------------------------------------------------------------------ awards

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

// Weekly: top N per region among Top Brokers with rating >= 4.6 and a
// dispute rate under 2%. Last week's Featured Agents are retired.
async function awardFeaturedAgents() {
  const c = await cfg();
  const f = c.badges.featured_agent || {};
  const period = isoWeek();
  const candidates = await pool.query(
    `SELECT ts.user_id, ts.score, ts.region, ts.inputs FROM trust_scores ts
     WHERE ts.region IS NOT NULL AND EXISTS (SELECT 1 FROM user_badges ub WHERE ub.user_id = ts.user_id AND ub.badge_key = 'top_broker' AND ub.status <> 'revoked')
     ORDER BY ts.region, ts.score DESC`
  );
  const perRegion = new Map();
  for (const r of candidates.rows) {
    const avg = Number(r.inputs?.ratingAvg) || 0;
    const deals = Number(r.inputs?.deals) || 0;
    const disputes = Number(r.inputs?.disputes?.total) || 0;
    const rate = deals ? (disputes / deals) * 100 : 0;
    if (avg < (f.min_avg ?? 4.6) || rate >= (f.max_dispute_rate_percent ?? 2)) continue;
    const list = perRegion.get(r.region) || [];
    if (list.length < (f.top_per_region ?? 50)) list.push(r);
    perRegion.set(r.region, list);
  }
  await pool.query(`UPDATE user_badges SET status = 'revoked', revoked_at = now() WHERE badge_key = 'featured_agent' AND status <> 'revoked' AND period <> $1`, [period]);
  let awarded = 0;
  for (const [region, list] of perRegion) {
    for (const [i, r] of list.entries()) {
      const ins = await pool.query(
        `INSERT INTO user_badges (user_id, badge_key, period, region, meta) VALUES ($1, 'featured_agent', $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [r.user_id, period, region, JSON.stringify({ rank: i + 1 })]
      );
      if (ins.rows[0]) {
        awarded += 1;
        await notify(r.user_id, `Featured Agent - ${region}`, `You are #${i + 1} in ${region} this week (${period}). Share your badge!`, 'featured_agent');
      }
    }
  }
  return { period, regions: perRegion.size, awarded };
}

// Best Broker for the last completed quarter or year, per region: most
// closed deals (then highest value).
async function awardBestBroker(kind = 'quarter', ref = new Date()) {
  const y = ref.getFullYear();
  let from;
  let to;
  let period;
  if (kind === 'year') {
    from = new Date(Date.UTC(y - 1, 0, 1));
    to = new Date(Date.UTC(y, 0, 1));
    period = String(y - 1);
  } else {
    const q = Math.floor(ref.getMonth() / 3); // current quarter index; award the previous one
    const pq = q === 0 ? 3 : q - 1;
    const py = q === 0 ? y - 1 : y;
    from = new Date(Date.UTC(py, pq * 3, 1));
    to = new Date(Date.UTC(py, pq * 3 + 3, 1));
    period = `${py}-Q${pq + 1}`;
  }
  const rows = await pool.query(
    `SELECT DISTINCT ON (region) region, broker_id, n, value FROM (
       SELECT COALESCE(ts.region, p.city) AS region, d.broker_id, COUNT(*)::int AS n, COALESCE(SUM(d.deal_value), 0) AS value
       FROM deals d LEFT JOIN properties p ON p.id = d.property_id
       LEFT JOIN trust_scores ts ON ts.user_id = d.broker_id
       JOIN users u ON u.id = d.broker_id JOIN roles r ON r.id = u.role_id
       WHERE d.stage = 'closed_won' AND d.closed_at >= $1 AND d.closed_at < $2 AND r.name IN ('broker', 'agency_admin')
       GROUP BY 1, 2
     ) x WHERE region IS NOT NULL
     ORDER BY region, n DESC, value DESC`,
    [from, to]
  );
  let awarded = 0;
  for (const r of rows.rows) {
    const ins = await pool.query(
      `INSERT INTO user_badges (user_id, badge_key, period, region, meta) VALUES ($1, 'best_broker', $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [r.broker_id, period, r.region, JSON.stringify({ kind, deals: r.n, value: Number(r.value), commissionDiscount: true })]
    );
    if (ins.rows[0]) {
      awarded += 1;
      await notify(r.broker_id, `Best Broker ${period} - ${r.region}`, `Most deals closed in ${r.region} (${r.n}, ${formatInr(r.value) || '—'}). Congratulations!`, 'best_broker');
    }
  }
  return { period, awarded };
}

// Daily batch: every lister / agent / customer with activity.
async function recomputeAll() {
  const users = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active' AND r.name = ANY($1::text[])`,
    [LISTER_ROLES.concat(['internal_sales'])]
  );
  let n = 0;
  for (const { id } of users.rows) {
    try {
      await recompute(id, 'daily');
      n += 1;
    } catch (err) {
      console.error(`[trust] daily ${id} failed:`, err.message);
    }
  }
  return { recomputed: n };
}

// Shareable award image (sec. 8.3) - SVG, safe to post on social media.
async function badgeImage(badgeId) {
  const r = await pool.query(
    `SELECT ub.*, split_part(u.full_name, ' ', 1) AS first_name FROM user_badges ub JOIN users u ON u.id = ub.user_id
     WHERE ub.id = $1 AND ub.status <> 'revoked'`,
    [badgeId]
  );
  const b = r.rows[0];
  if (!b || !SHAREABLE.includes(b.badge_key)) throw notFound('Badge not found');
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const title = BADGES[b.badge_key].label;
  const sub = [b.period, b.region].filter(Boolean).join(' · ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <rect width="1080" height="1080" fill="#FFF7F7"/>
  <circle cx="540" cy="430" r="250" fill="#E51C23"/>
  <circle cx="540" cy="430" r="215" fill="none" stroke="#FFFFFF" stroke-width="8"/>
  <text x="540" y="400" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="800" fill="#FFFFFF">${esc(title)}</text>
  <text x="540" y="475" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#FFFFFF">${esc(sub)}</text>
  <text x="540" y="780" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="52" font-weight="700" fill="#111827">${esc(b.first_name)}</text>
  <text x="540" y="850" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#4B5563">Awarded on PropertySerch.com</text>
  <text x="540" y="1000" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#9CA3AF">A brand of A R Buildwel</text>
</svg>`;
}

// ------------------------------------------------------------- scheduler

let timer = null;
function startScheduler() {
  if (timer) return;
  const done = {};
  timer = setInterval(async () => {
    try {
      const d = new Date(Date.now() + 5.5 * 3600 * 1000); // IST
      const date = d.toISOString().slice(0, 10);
      if (d.getUTCHours() >= 3 && done.daily !== date) {
        done.daily = date;
        await recomputeAll();
      }
      if (d.getUTCDay() === 1 && d.getUTCHours() >= 4 && done.featured !== date) {
        done.featured = date;
        await awardFeaturedAgents();
      }
      if (d.getUTCDate() === 1 && [0, 3, 6, 9].includes(d.getUTCMonth()) && d.getUTCHours() >= 4 && done.quarter !== date) {
        done.quarter = date;
        await awardBestBroker('quarter', new Date(date));
        if (d.getUTCMonth() === 0) await awardBestBroker('year', new Date(date));
      }
    } catch (err) {
      console.error('[trust] scheduler tick failed:', err.message);
    }
  }, 15 * 60 * 1000);
}

module.exports = {
  BADGES,
  recompute,
  safeRecompute,
  getProfile,
  publicForListing,
  leaderboard,
  awardFeaturedAgents,
  awardBestBroker,
  recomputeAll,
  badgeImage,
  startScheduler,
  isoWeek,
};
