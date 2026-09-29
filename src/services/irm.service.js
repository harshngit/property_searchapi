const pool = require('../config/db');
const configService = require('./config.service');
const { signUrls } = require('../utils/storage');
const { formatInr } = require('../utils/price');
const { notFound } = require('../utils/httpError');

// Module 38 - Investor Relationship Management and AI investor-deal
// matching. Matching blends three signals (weights admin-configurable):
//   stated   - the investor's profile: cities, asset classes, ticket size;
//   behaviour- what they actually engage with (views, shortlists, interest,
//              document requests) - cities, categories and ticket band;
//   quality  - the deal's own investment score.
// It is used both ways: best deals for an investor (HNI curated feed) and
// best investors for a deal (CRM).

const DEFAULT_WEIGHTS = { stated: 50, behaviour: 30, quality: 20 };
const POSITIVE = ['viewed', 'shortlisted', 'shared', 'document_requested', 'interest_expressed'];
const DEAL_CATEGORIES = ['auction', 'special_situation', 'institutional'];

const lc = (v) => String(v || '').toLowerCase();

async function weights() {
  const w = await configService.getConfig('irm.match_weights', DEFAULT_WEIGHTS);
  return { ...DEFAULT_WEIGHTS, ...(w || {}) };
}

// What an investor actually engages with over the last 180 days.
async function behaviourSummary(userId) {
  const result = await pool.query(
    `SELECT action, LOWER(city) AS city, listing_category, ticket_size
     FROM investor_deal_interactions WHERE user_id = $1 AND created_at > now() - interval '180 days'`,
    [userId]
  );
  const cities = {};
  const categories = {};
  const tickets = [];
  let positive = 0;
  let dismissed = 0;
  for (const r of result.rows) {
    if (POSITIVE.includes(r.action)) {
      positive += 1;
      if (r.city) cities[r.city] = (cities[r.city] || 0) + 1;
      if (r.listing_category) categories[r.listing_category] = (categories[r.listing_category] || 0) + 1;
      if (r.ticket_size) tickets.push(Number(r.ticket_size));
    } else if (r.action === 'dismissed') dismissed += 1;
  }
  tickets.sort((a, b) => a - b);
  const q = (p) => (tickets.length ? tickets[Math.min(tickets.length - 1, Math.floor(p * tickets.length))] : null);
  return { positive, dismissed, cities, categories, ticketP25: q(0.25), ticketP75: q(0.75), ticketMedian: q(0.5) };
}

// 0-100 fit of one deal for one investor, with the reasons.
function scoreMatch(profile, behaviour, deal, w) {
  const reasons = [];
  const ticket = Number(deal.reserve_price ?? deal.price_value) || null;
  const total = Number(w.stated) + Number(w.behaviour) + Number(w.quality) || 100;

  // Stated preferences (city 30%, asset class 30%, ticket 40% of the stated weight).
  const cities = (profile.preferred_cities || []).map(lc);
  const classes = profile.asset_class_preferences || [];
  const cityFit = cities.length === 0 ? 0.5 : cities.includes(lc(deal.city)) ? 1 : 0;
  const classFit = classes.length === 0 ? 0.5 : classes.includes(deal.listing_category) || (deal.property_type === 'commercial' && classes.includes('commercial')) ? 1 : 0;
  let ticketFit = 0.5;
  if (ticket && (profile.ticket_size_min != null || profile.ticket_size_max != null)) {
    const min = profile.ticket_size_min != null ? Number(profile.ticket_size_min) : 0;
    const max = profile.ticket_size_max != null ? Number(profile.ticket_size_max) : Infinity;
    ticketFit = ticket >= min && ticket <= max ? 1 : ticket >= min * 0.8 && ticket <= max * 1.2 ? 0.5 : 0;
  }
  if (cityFit === 1) reasons.push(`Preferred city (${deal.city})`);
  if (classFit === 1) reasons.push('Preferred asset class');
  if (ticketFit === 1) reasons.push('Within ticket size');
  const stated = 0.3 * cityFit + 0.3 * classFit + 0.4 * ticketFit;

  // Behaviour (only once there is some; otherwise neutral).
  let behaviourFit = 0.5;
  if (behaviour.positive > 0) {
    const cityShare = (behaviour.cities[lc(deal.city)] || 0) / behaviour.positive;
    const catShare = (behaviour.categories[deal.listing_category] || 0) / behaviour.positive;
    let band = 0.5;
    if (ticket && behaviour.ticketP25 != null) band = ticket >= behaviour.ticketP25 * 0.8 && ticket <= behaviour.ticketP75 * 1.25 ? 1 : 0.2;
    behaviourFit = 0.35 * Math.min(1, cityShare * 2) + 0.35 * Math.min(1, catShare * 1.5) + 0.3 * band;
    if (cityShare >= 0.3) reasons.push(`Frequently engaged city (${deal.city})`);
    if (catShare >= 0.4) reasons.push('Frequently engaged deal type');
    if (band === 1) reasons.push('In the usual engaged ticket range');
  }

  const quality = deal.investment_score != null ? Number(deal.investment_score) / 100 : 0.5;
  if (deal.investment_score != null && deal.investment_score >= 75) reasons.push(`High investment score (${deal.investment_score})`);

  const score = Math.round(((stated * w.stated + behaviourFit * w.behaviour + quality * w.quality) / total) * 100);
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

async function liveDeals(limit = 300) {
  const highTicketMin = await configService.getConfig('hni.high_ticket_commercial_min', 10000000);
  const result = await pool.query(
    `SELECT p.id, p.title, p.listing_category, p.property_type, p.city, p.locality, p.price_value, p.reserve_price,
            p.investment_score, p.discount_percent, p.liquidity_band, p.auction_date, p.is_institutional_asset,
            (SELECT url FROM property_media pm WHERE pm.property_id = p.id ORDER BY pm.is_primary DESC, pm.display_order LIMIT 1) AS primary_image
     FROM properties p
     WHERE p.status = 'approved'
       AND (p.listing_category::text = ANY($1::text[]) OR (p.property_type = 'commercial' AND p.price_value >= $2))
       AND (p.listing_category <> 'auction' OR p.auction_date IS NULL OR p.auction_date >= now() - interval '1 day')
     ORDER BY p.investment_score DESC NULLS LAST LIMIT $3`,
    [DEAL_CATEGORIES, Number(highTicketMin), limit]
  );
  return result.rows;
}

async function getProfileRow(profileId) {
  const result = await pool.query(
    `SELECT ip.*, u.full_name, u.email, u.mobile, m.full_name AS manager_name
     FROM investor_profiles ip JOIN users u ON u.id = ip.user_id LEFT JOIN users m ON m.id = ip.assigned_manager_id
     WHERE ip.id = $1`,
    [profileId]
  );
  if (!result.rows[0]) throw notFound('Investor profile not found');
  return result.rows[0];
}

// Best live deals for one investor, ranked by match score.
async function matchDealsForProfile(profile, { limit = 10, excludeDismissed = true } = {}) {
  const [w, behaviour, deals] = await Promise.all([weights(), behaviourSummary(profile.user_id), liveDeals()]);
  let dismissedIds = new Set();
  if (excludeDismissed) {
    const d = await pool.query(`SELECT DISTINCT property_id FROM investor_deal_interactions WHERE user_id = $1 AND action = 'dismissed'`, [profile.user_id]);
    dismissedIds = new Set(d.rows.map((r) => r.property_id));
  }
  return deals
    .filter((deal) => !dismissedIds.has(deal.id))
    .map((deal) => ({ deal, ...scoreMatch(profile, behaviour, deal, w) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Best verified investors for one deal (CRM: who should hear about this).
async function matchInvestorsForDeal(propertyId, { limit = 20 } = {}) {
  const dealResult = await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId]);
  const deal = dealResult.rows[0];
  if (!deal) throw notFound('Deal not found');
  const [w, profiles] = await Promise.all([
    weights(),
    pool.query(
      `SELECT ip.*, u.full_name, u.email, m.full_name AS manager_name,
              EXISTS (SELECT 1 FROM opportunity_interests oi WHERE oi.property_id = $1 AND oi.user_id = ip.user_id) AS already_interested,
              EXISTS (SELECT 1 FROM opportunity_alert_log a WHERE a.property_id = $1 AND a.user_id = ip.user_id AND a.status = 'sent') AS alerted
       FROM investor_profiles ip JOIN users u ON u.id = ip.user_id AND u.status = 'active'
       LEFT JOIN users m ON m.id = ip.assigned_manager_id
       WHERE ip.verification_status = 'verified'`,
      [propertyId]
    ),
  ]);
  const scored = [];
  for (const profile of profiles.rows) {
    const behaviour = await behaviourSummary(profile.user_id);
    const m = scoreMatch(profile, behaviour, deal, w);
    scored.push({
      investorProfileId: profile.id,
      name: profile.full_name,
      email: profile.email,
      type: [profile.is_nri && 'NRI', profile.is_hni && 'HNI'].filter(Boolean).join(' + '),
      manager: profile.manager_name,
      alreadyInterested: profile.already_interested,
      alerted: profile.alerted,
      ...m,
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Relationship tier from real outcomes (Module 38 repeat-investor logic).
function tierOf({ closures, advancedInterests, positive }) {
  if (closures >= 3) return 'vip';
  if (closures >= 2 || advancedInterests >= 3) return 'repeat';
  if (closures >= 1 || advancedInterests >= 1 || positive >= 10) return 'engaged';
  return 'new';
}

// Full IRM profile for one investor (CRM).
async function getIrmProfile(profileId) {
  const profile = await getProfileRow(profileId);
  const [behaviour, interests, rooms, alerts, portfolio, matches] = await Promise.all([
    behaviourSummary(profile.user_id),
    pool.query(
      `SELECT oi.id, oi.stage, oi.intended_bid_amount, oi.financing_needed, oi.dropped_reason, oi.created_at, oi.updated_at,
              p.id AS property_id, p.title, p.listing_category, p.city, COALESCE(p.reserve_price, p.price_value) AS ticket
       FROM opportunity_interests oi JOIN properties p ON p.id = oi.property_id
       WHERE oi.user_id = $1 ORDER BY oi.updated_at DESC`,
      [profile.user_id]
    ),
    pool.query(`SELECT status, COUNT(*)::int AS n FROM deal_room_access WHERE user_id = $1 GROUP BY status`, [profile.user_id]),
    pool.query(`SELECT status, COUNT(*)::int AS n FROM opportunity_alert_log WHERE user_id = $1 GROUP BY status`, [profile.user_id]),
    pool.query(
      `SELECT COUNT(*)::int AS positions, COALESCE(SUM(acquisition_cost + COALESCE(additional_costs, 0)), 0) AS invested,
              COALESCE(SUM(COALESCE(current_valuation, acquisition_cost)), 0) AS current_value,
              COUNT(*) FILTER (WHERE status = 'exited')::int AS exited
       FROM hni_investments WHERE investor_profile_id = $1`,
      [profileId]
    ),
    matchDealsForProfile(profile, { limit: 5 }),
  ]);
  const closures = interests.rows.filter((i) => i.stage === 'closure');
  const advancedInterests = interests.rows.filter((i) => ['due_diligence', 'negotiation', 'closure'].includes(i.stage)).length;
  const tier = tierOf({ closures: closures.length, advancedInterests, positive: behaviour.positive });

  return {
    profile: {
      id: profile.id, name: profile.full_name, email: profile.email, mobile: profile.mobile, isNri: profile.is_nri, isHni: profile.is_hni,
      category: profile.investor_category, verification: profile.verification_status, manager: profile.manager_name,
      institutionalInterest: profile.institutional_interest, assetClasses: profile.asset_class_preferences, cities: profile.preferred_cities,
    },
    tier,
    repeatInvestor: tier === 'repeat' || tier === 'vip',
    ticket: {
      statedMin: profile.ticket_size_min, statedMax: profile.ticket_size_max,
      engagedP25: behaviour.ticketP25, engagedMedian: behaviour.ticketMedian, engagedP75: behaviour.ticketP75,
      closedTotal: closures.reduce((s, c) => s + Number(c.ticket || 0), 0),
      closedTotalDisplay: formatInr(closures.reduce((s, c) => s + Number(c.ticket || 0), 0)),
    },
    engagement: { positive180d: behaviour.positive, dismissed180d: behaviour.dismissed, topCities: Object.entries(behaviour.cities).sort((a, b) => b[1] - a[1]).slice(0, 5), categories: behaviour.categories },
    deals: { interests: interests.rows, closures: closures.length, active: interests.rows.filter((i) => !['closure', 'dropped'].includes(i.stage)).length, dropped: interests.rows.filter((i) => i.stage === 'dropped').length },
    dealRooms: Object.fromEntries(rooms.rows.map((r) => [r.status, r.n])),
    alerts: Object.fromEntries(alerts.rows.map((r) => [r.status, r.n])),
    portfolio: portfolio.rows[0],
    aiMatches: await Promise.all(matches.map(async (m) => ({ score: m.score, reasons: m.reasons, deal: await signUrls(m.deal, 'primary_image') }))),
  };
}

// Segmentation across all investors (asset class incl. institutional, type,
// tier) - IRM overview.
async function getSegments() {
  const profiles = await pool.query(`SELECT id, user_id, is_nri, is_hni, investor_category, asset_class_preferences, institutional_interest, verification_status FROM investor_profiles`);
  const outcomes = await pool.query(
    `SELECT user_id, COUNT(*) FILTER (WHERE stage = 'closure')::int AS closures,
            COUNT(*) FILTER (WHERE stage IN ('due_diligence', 'negotiation', 'closure'))::int AS advanced
     FROM opportunity_interests GROUP BY user_id`
  );
  const engaged = await pool.query(
    `SELECT user_id, COUNT(*)::int AS positive FROM investor_deal_interactions
     WHERE action = ANY($1::text[]) AND created_at > now() - interval '180 days' GROUP BY user_id`,
    [POSITIVE]
  );
  const outMap = new Map(outcomes.rows.map((r) => [r.user_id, r]));
  const engMap = new Map(engaged.rows.map((r) => [r.user_id, r.positive]));
  const seg = { total: profiles.rows.length, byTier: {}, byAssetClass: {}, byCategory: {}, nri: 0, hni: 0, institutional: 0, verified: 0 };
  const tiers = [];
  for (const p of profiles.rows) {
    const o = outMap.get(p.user_id) || { closures: 0, advanced: 0 };
    const tier = tierOf({ closures: o.closures, advancedInterests: o.advanced, positive: engMap.get(p.user_id) || 0 });
    tiers.push({ profileId: p.id, tier });
    seg.byTier[tier] = (seg.byTier[tier] || 0) + 1;
    for (const a of p.asset_class_preferences || []) seg.byAssetClass[a] = (seg.byAssetClass[a] || 0) + 1;
    seg.byCategory[p.investor_category || 'individual'] = (seg.byCategory[p.investor_category || 'individual'] || 0) + 1;
    if (p.is_nri) seg.nri += 1;
    if (p.is_hni) seg.hni += 1;
    if (p.institutional_interest || (p.asset_class_preferences || []).includes('institutional')) seg.institutional += 1;
    if (p.verification_status === 'verified') seg.verified += 1;
  }
  return { ...seg, tiers };
}

module.exports = { weights, scoreMatch, behaviourSummary, matchDealsForProfile, matchInvestorsForDeal, getIrmProfile, getSegments, tierOf };
