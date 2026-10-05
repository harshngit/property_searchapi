const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const { formatInr, parsePriceToNumber } = require('../utils/price');

// Module 4 / Annexure A sec. 7 - Property <-> Requirement Matching Engine.
// Bidirectional and continuous: runs when a listing goes live or changes,
// when a requirement is posted or edited, and in a nightly batch.
//
//   score = Location 30% + Budget 25% + Type 20% + Area 15% + Amenities 10%
//
// (binding weights, admin-configurable in matching.weights). Every match
// carries its parameter-wise breakdown. Tiers: Hot >= 90 (instant alert to
// buyer + broker, top of results), Warm 75-89 (daily digest), Lukewarm
// 60-74 (visible only when a broker sends it), below 60 not shown.
//
// Ranking (not the displayed %) adds the Exclusive Mandate boost (+20), the
// Price-Compatible boost (+10, visible to A R staff only) and learned
// conversion-pattern boosts. The AI layer (sec. 7.4) re-learns the weights
// nightly from shown / clicked / enquired / visited / converted events, and
// an optional A/B test runs a second weight set for half the users.

const DEFAULT_WEIGHTS = { location: 30, budget: 25, type: 20, area: 15, amenities: 10 };
const DEFAULT_THRESHOLDS = { hot: 90, warm: 75, lukewarm: 60 };
const COMPONENTS = Object.keys(DEFAULT_WEIGHTS);
const PURPOSE_TRANSACTION_TYPES = { buy: ['sell', 'buy'], rent: ['rent'] };
const POSITIVE_EVENTS = ['clicked', 'enquired', 'visited', 'converted'];
const EVENT_VALUE = { clicked: 1, enquired: 3, visited: 5, converted: 10 };

const lc = (v) => String(v || '').trim().toLowerCase();
const num = (v) => (v == null || v === '' ? null : Number(v));

function normaliseWeights(w) {
  const merged = { ...DEFAULT_WEIGHTS, ...(w || {}) };
  const total = COMPONENTS.reduce((s, k) => s + Math.max(0, Number(merged[k]) || 0), 0) || 100;
  return Object.fromEntries(COMPONENTS.map((k) => [k, Math.round(((Math.max(0, Number(merged[k]) || 0) / total) * 100) * 100) / 100]));
}

// ------------------------------------------------------------------ settings

let geoCache = null;
let geoLoadedAt = 0;
async function geo() {
  if (geoCache && Date.now() - geoLoadedAt < 10 * 60 * 1000) return geoCache;
  const [cities, localities] = await Promise.all([
    pool.query('SELECT id, LOWER(city_name) AS name, match_radius_km, lat_centroid, lng_centroid FROM cities'),
    pool.query(
      `SELECT LOWER(l.locality_name) AS name, LOWER(c.city_name) AS city, l.lat_centroid, l.lng_centroid
       FROM localities l JOIN cities c ON c.id = l.city_id WHERE l.lat_centroid IS NOT NULL`
    ),
  ]);
  geoCache = {
    cities: new Map(cities.rows.map((c) => [c.name, c])),
    localities: new Map(localities.rows.map((l) => [`${l.city}|${l.name}`, l])),
  };
  geoLoadedAt = Date.now();
  return geoCache;
}

async function settings() {
  const [configured, learned, learningEnabled, thresholds, radius, similarity, mandateBoost, priceBoost, patternBoosts, ab] = await Promise.all([
    configService.getConfig('matching.weights', DEFAULT_WEIGHTS),
    configService.getConfig('matching.learned_weights', null),
    configService.getConfig('matching.learning_enabled', true),
    configService.getConfig('matching.thresholds', DEFAULT_THRESHOLDS),
    configService.getConfig('city_match_radius_km', 50),
    configService.getConfig('matching.type_similarity', {}),
    configService.getConfig('matching.mandate_boost', 20),
    configService.getConfig('matching.price_compatible_boost', 10),
    configService.getConfig('matching.pattern_boosts', {}),
    configService.getConfig('matching.ab_test', { enabled: false }),
  ]);
  const base = normaliseWeights(configured);
  const useLearned = learningEnabled && learned && learned.weights;
  return {
    baseWeights: base,
    weights: useLearned ? normaliseWeights(learned.weights) : base,
    learned: useLearned ? learned : null,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) },
    radiusKm: Number(radius) || 50,
    similarity: similarity || {},
    mandateBoost: Number(mandateBoost) || 0,
    priceBoost: Number(priceBoost) || 0,
    patternBoosts: patternBoosts || {},
    ab: ab || { enabled: false },
    geo: await geo(),
  };
}

// Stable A/B assignment per user.
function variantFor(s, userId) {
  if (!s.ab?.enabled || !userId) return 'A';
  let h = 0;
  for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 100 < (Number(s.ab.split_percent) || 50) ? 'B' : 'A';
}

function weightsFor(s, variant) {
  return variant === 'B' && s.ab?.variant_b_weights ? normaliseWeights(s.ab.variant_b_weights) : s.weights;
}

// ------------------------------------------------------------------- scoring

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Where the buyer wants to be: their own pin, else the centroid of their
// first known locality, else the city centroid.
function requirementCentre(req, s) {
  if (req.latitude != null && req.longitude != null) return { lat: Number(req.latitude), lng: Number(req.longitude), source: 'pin' };
  for (const loc of req.localities || []) {
    const hit = s.geo.localities.get(`${lc(req.city)}|${lc(loc)}`);
    if (hit) return { lat: Number(hit.lat_centroid), lng: Number(hit.lng_centroid), source: 'locality' };
  }
  const city = s.geo.cities.get(lc(req.city));
  if (city?.lat_centroid != null) return { lat: Number(city.lat_centroid), lng: Number(city.lng_centroid), source: 'city' };
  return null;
}

function radiusFor(req, s) {
  const city = s.geo.cities.get(lc(req.city));
  return Number(city?.match_radius_km) || s.radiusKm;
}

function scoreLocation(listing, req, s) {
  const centre = requirementCentre(req, s);
  const radius = radiusFor(req, s);
  if (centre && listing.latitude != null && listing.longitude != null) {
    const d = haversineKm(centre, { lat: Number(listing.latitude), lng: Number(listing.longitude) });
    const value = d <= radius ? 100 : Math.max(0, 100 * (1 - (d - radius) / 50));
    return { value: Math.round(value), detail: `${Math.round(d * 10) / 10} km from ${centre.source === 'pin' ? 'your pin' : centre.source === 'locality' ? (req.localities || [])[0] : req.city} (radius ${radius} km)` };
  }
  // No coordinates on one side - fall back to city / locality names.
  if (lc(listing.city) !== lc(req.city)) return { value: 0, detail: `In ${listing.city || 'another city'}, not ${req.city}` };
  const locs = (req.localities || []).map(lc);
  if (!locs.length || locs.includes(lc(listing.locality))) return { value: 100, detail: listing.locality ? `In ${listing.locality}` : `In ${req.city}` };
  return { value: 85, detail: `In ${listing.locality || req.city}, same city` };
}

function band(deviation, steps) {
  for (const [limit, value] of steps) if (deviation <= limit) return value;
  return 0;
}

function scoreBudget(listing, req) {
  const price = num(listing.price_value) ?? parsePriceToNumber(listing.price);
  const min = num(req.budget_min);
  const max = num(req.budget_max);
  if (min == null && max == null) return { value: 100, detail: 'Any budget' };
  if (!price || !Number.isFinite(price)) return { value: 50, detail: 'Price on request' };
  if ((min == null || price >= min) && (max == null || price <= max)) return { value: 100, detail: `${formatInr(price)} - within budget` };
  const dev = max != null && price > max ? (price - max) / max : (min - price) / min;
  const value = band(dev, [[0.1, 75], [0.2, 50]]);
  return { value, detail: `${formatInr(price)} - ${Math.round(dev * 100)}% ${max != null && price > max ? 'over' : 'under'} budget` };
}

function scoreType(listing, req, s) {
  if (!req.property_type) return { value: 100, detail: 'Any property type' };
  if (req.property_type === listing.property_type) return { value: 100, detail: 'Exact type' };
  const similar = s.similarity[req.property_type] || [];
  if (similar.includes(listing.property_type)) return { value: 70, detail: 'Similar type' };
  return { value: 0, detail: 'Different type' };
}

function scoreArea(listing, req) {
  const area = num(listing.area_sqft) ?? num(listing.carpet_area_sqft);
  const min = num(req.area_min_sqft);
  const max = num(req.area_max_sqft);
  if (min != null || max != null) {
    if (area == null) return { value: 50, detail: 'Area not given' };
    if ((min == null || area >= min) && (max == null || area <= max)) return { value: 100, detail: `${Math.round(area)} sq.ft - in range` };
    const dev = max != null && area > max ? (area - max) / max : (min - area) / min;
    return { value: band(dev, [[0.15, 80], [0.3, 50]]), detail: `${Math.round(area)} sq.ft - ${Math.round(dev * 100)}% outside range` };
  }
  // No area range: size by bedrooms.
  if (req.bedrooms) {
    if (listing.bedrooms == null) return { value: 50, detail: 'BHK not given' };
    if (listing.bedrooms >= req.bedrooms) return { value: 100, detail: `${listing.bedrooms} BHK` };
    return { value: listing.bedrooms === req.bedrooms - 1 ? 50 : 0, detail: `${listing.bedrooms} BHK - smaller than ${req.bedrooms} BHK` };
  }
  return { value: 100, detail: 'Any size' };
}

// Amenity names are free text on listings ("Pool", "Swimming pool",
// "Club House") - compare normalised forms, synonyms and containment.
const AMENITY_SYNONYMS = { swimmingpool: 'pool', clubhouse: 'clubhouse', club: 'clubhouse', gymnasium: 'gym', fitnesscentre: 'gym', lifts: 'lift', elevator: 'lift', powerbackup: 'powerbackup', generator: 'powerbackup', carparking: 'parking', coveredparking: 'parking', playarea: 'playarea', kidsplayarea: 'playarea', '24x7security': 'security', cctv: 'security' };
const amenityKey = (a) => {
  const k = lc(a).replace(/[^a-z0-9]/g, '');
  return AMENITY_SYNONYMS[k] || k;
};
function scoreAmenities(listing, req) {
  const wanted = (req.amenities || []).map(amenityKey).filter(Boolean);
  if (!wanted.length) return { value: 100, detail: 'No specific amenities' };
  const have = (listing.amenities || []).map(amenityKey).filter(Boolean);
  const missing = [];
  let hits = 0;
  for (const w of wanted) {
    if (have.some((h) => h === w || h.includes(w) || w.includes(h))) hits += 1;
    else missing.push(w);
  }
  return {
    value: Math.round((hits / wanted.length) * 100),
    detail: `${hits} of ${wanted.length} amenities${missing.length && missing.length <= 3 ? ` (missing: ${missing.join(', ')})` : ''}`,
  };
}

function budgetBand(price) {
  if (!price) return 'na';
  if (price < 5e6) return 'u50l';
  if (price < 1e7) return '50l-1c';
  if (price < 2.5e7) return '1-2.5c';
  if (price < 5e7) return '2.5-5c';
  return '5c+';
}
const segmentOf = (listing) => `${lc(listing.city)}|${listing.property_type || 'any'}|${budgetBand(num(listing.price_value))}`;

// One listing against one requirement.
function scoreOne(listing, req, s, weights = s.weights) {
  const parts = {
    location: scoreLocation(listing, req, s),
    budget: scoreBudget(listing, req),
    type: scoreType(listing, req, s),
    area: scoreArea(listing, req),
    amenities: scoreAmenities(listing, req),
  };
  const score = Math.round(COMPONENTS.reduce((sum, k) => sum + parts[k].value * (weights[k] / 100), 0));
  const breakdown = Object.fromEntries(COMPONENTS.map((k) => [k, { score: parts[k].value, weight: weights[k], detail: parts[k].detail }]));
  // Module 46 Price-Compatible: buyer's confidential max budget >= seller's
  // confidential minimum, both from active Exclusive Mandates (decrypted
  // values ride on non-enumerable props - never serialised).
  const sellerMin = num(listing._sellerMin);
  const buyerMax = num(req._buyerMax);
  const priceCompatible =
    listing.mandate_type === 'exclusive' && req.mandate_type === 'exclusive' &&
    sellerMin != null && buyerMax != null && buyerMax >= sellerMin;
  const boosts = {
    mandate: listing.mandate_type === 'exclusive' ? s.mandateBoost : 0,
    priceCompatible: priceCompatible ? s.priceBoost : 0,
    pattern: Number(s.patternBoosts[segmentOf(listing)]) || 0,
    trust: Number(listing.rank_boost) || 0, // trust / verification boosts (Engine 5 trust layer)
  };
  const t = s.thresholds;
  const tier = score >= t.hot ? 'hot' : score >= t.warm ? 'warm' : score >= t.lukewarm ? 'lukewarm' : 'none';
  return {
    score,
    tier,
    breakdown,
    priceCompatible,
    boosts,
    rankScore: Math.round((score + Object.values(boosts).reduce((a, b) => a + b, 0)) * 100) / 100,
  };
}

// ---------------------------------------------------------------- candidates

const LISTING_COLUMNS = `p.id, p.title, p.property_type, p.transaction_type, p.listing_category, p.price, p.price_value,
  p.city, p.locality, p.latitude, p.longitude, p.area_sqft, p.carpet_area_sqft, p.bedrooms, p.bathrooms, p.amenities,
  p.furnishing, p.is_verified, p.badge, p.tags, p.created_at, p.created_by, p.broker_id, p.mandate_type,
  (SELECT mm.seller_min_price_enc FROM mandates mm WHERE mm.listing_id = p.id AND mm.mandate_type = 'seller_exclusive' AND mm.status = 'active' ORDER BY mm.created_at DESC LIMIT 1) AS seller_min_enc,
  COALESCE((SELECT ts.search_boost + CASE WHEN ts.lead_priority THEN 5 ELSE 0 END FROM trust_scores ts
   WHERE ts.user_id = COALESCE(p.broker_id, p.created_by)), 0)
   + COALESCE((SELECT (ac.value->>(p.verification_level::text))::numeric FROM app_config ac WHERE ac.config_key = 'verification.search_boost'), 0) / 5 AS rank_boost,
  (SELECT url FROM property_media pm WHERE pm.property_id = p.id ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS primary_image`;

// Listing rows: swap the encrypted seller minimum for a hidden value.
const hideSellerMin = (rows) => rows.map((r) => require('./mandate.service').hidePrice(r, 'seller_min_enc', '_sellerMin'));

// Live residential listings a requirement could match: same deal type, in
// the city or within radius + 50 km of the buyer's centre.
async function candidatesFor(req, s, { excludeCreatedBy = null, limit = 500 } = {}) {
  const params = [PURPOSE_TRANSACTION_TYPES[req.purpose] || ['sell', 'buy'], req.city];
  let geoClause = '';
  const centre = requirementCentre(req, s);
  if (centre) {
    const reach = radiusFor(req, s) + 50;
    const dLat = reach / 111;
    const dLng = reach / (111 * Math.max(0.2, Math.cos((centre.lat * Math.PI) / 180)));
    params.push(centre.lat - dLat, centre.lat + dLat, centre.lng - dLng, centre.lng + dLng);
    geoClause = `OR (p.latitude BETWEEN $3 AND $4 AND p.longitude BETWEEN $5 AND $6)`;
  }
  let exclude = '';
  if (excludeCreatedBy) {
    params.push(excludeCreatedBy);
    exclude = `AND p.created_by <> $${params.length}`;
  }
  params.push(limit);
  const result = await pool.query(
    `SELECT ${LISTING_COLUMNS} FROM properties p
     WHERE p.status = 'approved' AND p.listing_category = 'residential'
       AND p.transaction_type::text = ANY($1) AND (p.city ILIKE $2 ${geoClause}) ${exclude}
     ORDER BY p.created_at DESC LIMIT $${params.length}`,
    params
  );
  return hideSellerMin(result.rows);
}

async function requirementOwner(req) {
  const r = await pool.query('SELECT user_id FROM customers WHERE id = $1', [req.customer_id]);
  return r.rows[0]?.user_id || req.created_by || null;
}

// --------------------------------------------------------------- persistence

async function upsertMatch(req, listing, m, variant) {
  const r = await pool.query(
    `INSERT INTO requirement_matches (requirement_id, property_id, score, rank_score, tier, breakdown, price_compatible, variant)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (requirement_id, property_id) DO UPDATE
       SET score = EXCLUDED.score, rank_score = EXCLUDED.rank_score, tier = EXCLUDED.tier, breakdown = EXCLUDED.breakdown,
           price_compatible = EXCLUDED.price_compatible, variant = EXCLUDED.variant, updated_at = now()
     RETURNING *`,
    [req.id, listing.id, m.score, m.rankScore, m.tier, JSON.stringify(m.breakdown), m.priceCompatible, variant]
  );
  return r.rows[0];
}

// Brokers / reps who should hear about a match on this listing (never the
// buyer's contact - mandatory intermediation).
async function listingBrokerIds(listing) {
  const ids = new Set();
  const users = await pool.query(
    `SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`,
    [[listing.broker_id, listing.created_by].filter(Boolean)]
  );
  for (const u of users.rows) if (['broker', 'agency_admin', 'builder', 'internal_sales'].includes(u.role)) ids.add(u.id);
  return [...ids];
}

async function sendHotWhatsapp(userId, listing, score) {
  const template = await configService.getConfig('matching.hot_whatsapp_template', '');
  if (!template) return;
  try {
    const u = await pool.query('SELECT mobile FROM users WHERE id = $1', [userId]);
    const digits = String(u.rows[0]?.mobile || '').replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) return;
    await require('./metaWhatsapp.service').sendTemplate({
      to: `91${digits}`,
      templateName: template,
      variables: [listing.title, `${score}%`, [listing.locality, listing.city].filter(Boolean).join(', ')],
    });
  } catch (err) {
    console.error('[matching] Hot Match WhatsApp failed:', err.message);
  }
}

// Instant alerts for a (new) Hot match: buyer push + broker alert.
async function notifyHot(req, listing, row) {
  if (!row.notified_at) {
    const buyer = await requirementOwner(req);
    if (buyer && buyer !== listing.created_by) {
      await notificationService.createNotification({
        userId: buyer,
        type: 'match_alert',
        title: `Hot Match (${row.score}%): ${listing.title}`,
        message: `A listing in ${[listing.locality, listing.city].filter(Boolean).join(', ')} matches your requirement - ${row.score}% match.`,
        relatedEntityType: 'property',
        relatedEntityId: listing.id,
      });
    }
    await pool.query('UPDATE requirement_matches SET notified_at = now() WHERE id = $1', [row.id]);
  }
  if (!row.broker_notified_at) {
    const brokers = await listingBrokerIds(listing);
    const lead = req.lead_id ? await pool.query('SELECT assigned_to FROM leads WHERE id = $1', [req.lead_id]) : { rows: [] };
    const rep = lead.rows[0]?.assigned_to;
    for (const id of new Set([...brokers, rep].filter(Boolean))) {
      await notificationService.createNotification({
        userId: id,
        type: 'match_alert_broker',
        title: `Hot Match (${row.score}%) for ${listing.title}`,
        message: `A ${req.mandate_type === 'exclusive' ? 'Priority ' : ''}buyer requirement (${req.purpose}, ${req.city}${
          req.budget_max ? `, up to ${formatInr(req.budget_max)}` : ''
        }) matches this listing. The A R Buildwel representative coordinates the buyer.`,
        relatedEntityType: 'requirement',
        relatedEntityId: req.id,
      });
      await sendHotWhatsapp(id, listing, row.score);
    }
    await pool.query('UPDATE requirement_matches SET broker_notified_at = now() WHERE id = $1', [row.id]);
  }
}

// Re-match one requirement against all live listings. Keeps rows for
// Lukewarm-and-above; removes the rest unless a broker sent them.
async function refreshRequirement(reqOrId, { notify = true } = {}) {
  const req = typeof reqOrId === 'object' ? reqOrId : (await pool.query('SELECT * FROM requirements WHERE id = $1', [reqOrId])).rows[0];
  if (!req) return { matched: 0 };
  await require('./mandate.service').attachBuyerMax(req);
  if (req.status !== 'active') {
    await pool.query('DELETE FROM requirement_matches WHERE requirement_id = $1 AND sent_at IS NULL', [req.id]);
    return { matched: 0 };
  }
  const s = await settings();
  const owner = await requirementOwner(req);
  const variant = variantFor(s, owner);
  const weights = weightsFor(s, variant);
  const listings = await candidatesFor(req, s, { excludeCreatedBy: owner });
  const keep = [];
  let hot = 0;
  for (const listing of listings) {
    const m = scoreOne(listing, req, s, weights);
    if (m.tier === 'none') continue;
    const row = await upsertMatch(req, listing, m, variant);
    keep.push(listing.id);
    if (m.tier === 'hot') {
      hot += 1;
      if (notify) await notifyHot(req, listing, row);
    }
  }
  await pool.query(
    `DELETE FROM requirement_matches WHERE requirement_id = $1 AND sent_at IS NULL AND NOT (property_id = ANY($2::uuid[]))`,
    [req.id, keep]
  );
  return { matched: keep.length, hot };
}

// Re-match one listing against all active requirements (reverse matching).
async function refreshProperty(propertyId, { notify = true } = {}) {
  const r = await pool.query(`SELECT ${LISTING_COLUMNS}, p.status FROM properties p WHERE p.id = $1`, [propertyId]);
  const listing = hideSellerMin(r.rows)[0];
  if (!listing || listing.status !== 'approved' || listing.listing_category !== 'residential') {
    await pool.query('DELETE FROM requirement_matches WHERE property_id = $1', [propertyId]);
    return { matched: 0 };
  }
  const s = await settings();
  const purpose = listing.transaction_type === 'rent' ? 'rent' : 'buy';
  const reqs = await pool.query(
    `SELECT r.*, c.user_id AS owner_id FROM requirements r JOIN customers c ON c.id = r.customer_id
     WHERE r.status = 'active' AND r.purpose = $1`,
    [purpose]
  );
  let matched = 0;
  let hot = 0;
  await require('./mandate.service').attachBuyerMax(reqs.rows);
  for (const req of reqs.rows) {
    if (req.owner_id && req.owner_id === listing.created_by) continue;
    const variant = variantFor(s, req.owner_id);
    const m = scoreOne(listing, req, s, weightsFor(s, variant));
    if (m.tier === 'none') {
      await pool.query('DELETE FROM requirement_matches WHERE requirement_id = $1 AND property_id = $2 AND sent_at IS NULL', [req.id, listing.id]);
      continue;
    }
    const row = await upsertMatch(req, listing, m, variant);
    matched += 1;
    if (m.tier === 'hot') {
      hot += 1;
      if (notify) await notifyHot(req, listing, row);
    }
  }
  return { matched, hot };
}

function safeRefreshProperty(id) {
  refreshProperty(id).catch((err) => console.error(`[matching] refresh property ${id} failed:`, err.message));
}
function safeRefreshRequirement(id) {
  refreshRequirement(id).catch((err) => console.error(`[matching] refresh requirement ${id} failed:`, err.message));
}

// --------------------------------------------------------------- read side

function publicMatch(row, listing, { staff = false } = {}) {
  return {
    requirementId: row.requirement_id,
    score: row.score,
    tier: row.tier,
    hotMatch: row.tier === 'hot',
    breakdown: row.breakdown,
    sentByRepresentative: !!row.sent_at,
    firstMatchedAt: row.first_matched_at,
    ...(staff ? { priceCompatible: row.price_compatible, rankScore: Number(row.rank_score) } : {}),
    property: listing,
  };
}

// Buyer view (Screen 6): Hot + Warm, plus Lukewarm ones a broker sent;
// ranked by rank score. Records 'shown' events for learning.
async function matchesForRequirements(requirements, user, { refresh = true } = {}) {
  if (!requirements.length) return [];
  if (refresh) for (const req of requirements) await refreshRequirement(req);
  const s = await settings();
  const rows = await pool.query(
    `SELECT m.*, ${LISTING_COLUMNS}
     FROM requirement_matches m JOIN properties p ON p.id = m.property_id
     WHERE m.requirement_id = ANY($1::uuid[]) AND p.status = 'approved'
       AND (m.score >= $2 OR m.sent_at IS NOT NULL)
     ORDER BY m.rank_score DESC, m.score DESC`,
    [requirements.map((r) => r.id), s.thresholds.warm]
  );
  const best = new Map();
  for (const row of hideSellerMin(rows.rows)) {
    const current = best.get(row.property_id);
    if (!current || Number(row.rank_score) > Number(current.rank_score)) best.set(row.property_id, row);
  }
  const items = [...best.values()];
  for (const row of items) {
    await pool
      .query(
        `INSERT INTO match_events (requirement_id, property_id, user_id, event, variant, score, breakdown)
         VALUES ($1, $2, $3, 'shown', $4, $5, $6) ON CONFLICT DO NOTHING`,
        [row.requirement_id, row.property_id, user?.id || null, row.variant, row.score, JSON.stringify(row.breakdown)]
      )
      .catch(() => {});
  }
  return items.map((row) =>
    publicMatch(row, {
      id: row.property_id, title: row.title, property_type: row.property_type, transaction_type: row.transaction_type,
      price: row.price, price_value: row.price_value, city: row.city, locality: row.locality, area_sqft: row.area_sqft,
      bedrooms: row.bedrooms, bathrooms: row.bathrooms, furnishing: row.furnishing, is_verified: row.is_verified,
      badge: row.badge, tags: row.tags, primary_image: row.primary_image, mandate_type: row.mandate_type, created_at: row.created_at,
    })
  );
}

// Match badges on search cards: best score for each property across the
// user's active requirements.
async function scoresForUser(user, propertyIds) {
  const customer = await pool.query('SELECT id FROM customers WHERE user_id = $1', [user.id]);
  if (!customer.rows[0] || !propertyIds.length) return {};
  const reqs = await pool.query(`SELECT * FROM requirements WHERE customer_id = $1 AND status = 'active'`, [customer.rows[0].id]);
  if (!reqs.rows.length) return {};
  const listings = await pool.query(`SELECT ${LISTING_COLUMNS} FROM properties p WHERE p.id = ANY($1::uuid[])`, [propertyIds]);
  const s = await settings();
  const weights = weightsFor(s, variantFor(s, user.id));
  const out = {};
  for (const listing of hideSellerMin(listings.rows)) {
    for (const req of reqs.rows) {
      if (PURPOSE_TRANSACTION_TYPES[req.purpose] && !PURPOSE_TRANSACTION_TYPES[req.purpose].includes(listing.transaction_type)) continue;
      const m = scoreOne(listing, req, s, weights);
      if (!out[listing.id] || m.score > out[listing.id].score) {
        out[listing.id] = { score: m.score, tier: m.tier, breakdown: m.breakdown, requirementId: req.id };
      }
    }
  }
  return out;
}

// Records a behaviour event against the requirement(s) that matched the
// property for this user (AI learning + A/B conversion).
async function recordEvent({ userId = null, customerId = null, propertyId, requirementId = null, event }) {
  if (!propertyId || !['clicked', 'enquired', 'visited', 'converted', 'sent'].includes(event)) return 0;
  try {
    const params = [propertyId];
    let where = 'm.property_id = $1';
    if (requirementId) {
      params.push(requirementId);
      where += ` AND m.requirement_id = $${params.length}`;
    } else if (customerId) {
      params.push(customerId);
      where += ` AND r.customer_id = $${params.length}`;
    } else if (userId) {
      params.push(userId);
      where += ` AND c.user_id = $${params.length}`;
    } else return 0;
    const rows = await pool.query(
      `SELECT m.requirement_id, m.variant, m.score, m.breakdown, c.user_id
       FROM requirement_matches m JOIN requirements r ON r.id = m.requirement_id JOIN customers c ON c.id = r.customer_id
       WHERE ${where}`,
      params
    );
    for (const row of rows.rows) {
      await pool.query(
        `INSERT INTO match_events (requirement_id, property_id, user_id, event, variant, score, breakdown)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.requirement_id, propertyId, userId || row.user_id, event, row.variant, row.score, JSON.stringify(row.breakdown)]
      );
    }
    return rows.rows.length;
  } catch (err) {
    console.error('[matching] record event failed:', err.message);
    return 0;
  }
}

// ------------------------------------------------------------ broker side

function maskRequirement(r) {
  return {
    id: r.id,
    purpose: r.purpose,
    propertyType: r.property_type,
    city: r.city,
    localities: r.localities || [],
    budgetMin: r.budget_min,
    budgetMax: r.budget_max,
    budgetDisplay: r.budget_min || r.budget_max ? `${formatInr(r.budget_min) || 'any'} - ${formatInr(r.budget_max) || 'any'}` : 'Any budget',
    areaMinSqft: r.area_min_sqft,
    areaMaxSqft: r.area_max_sqft,
    bedrooms: r.bedrooms,
    urgency: r.urgency,
    temperature: r.temperature,
    hot: r.temperature === 'hot',
    priority: r.mandate_type === 'exclusive', // Priority Requirement / Priority Buyer
    postedAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

const STAFF = ['internal_sales', 'admin', 'super_admin'];

async function myListings(user) {
  const r = await pool.query(
    `SELECT ${LISTING_COLUMNS} FROM properties p
     WHERE p.status = 'approved' AND p.listing_category = 'residential' AND (p.broker_id = $1 OR p.created_by = $1)`,
    [user.id]
  );
  return hideSellerMin(r.rows);
}

// Requirement Marketplace (buyer-first): active requirements, buyer identity
// masked, Hot and Priority tagged, each with its best match against the
// caller's own listings. Shared-with-me requirements are flagged.
async function marketplace(user, { city, purpose, hotOnly, priorityOnly, sharedOnly, limit = 100 } = {}) {
  const where = [`r.status = 'active'`, `(r.expires_at IS NULL OR r.expires_at > now())`];
  const params = [];
  if (city) {
    params.push(city);
    where.push(`r.city ILIKE $${params.length}`);
  }
  if (purpose) {
    params.push(purpose);
    where.push(`r.purpose = $${params.length}`);
  }
  if (hotOnly === 'true' || hotOnly === true) where.push(`r.temperature = 'hot'`);
  if (priorityOnly === 'true' || priorityOnly === true) where.push(`r.mandate_type = 'exclusive'`);
  params.push(user.id);
  const meParam = params.length;
  if (sharedOnly === 'true' || sharedOnly === true) where.push(`EXISTS (SELECT 1 FROM requirement_shares sh WHERE sh.requirement_id = r.id AND sh.shared_with = $${meParam} AND sh.status IN ('pending', 'accepted'))`);
  params.push(Math.min(Number(limit) || 100, 300));
  const rows = await pool.query(
    `SELECT r.*,
            (SELECT sh.status FROM requirement_shares sh WHERE sh.requirement_id = r.id AND sh.shared_with = $${meParam} LIMIT 1) AS share_status
     FROM requirements r WHERE ${where.join(' AND ')}
     ORDER BY (r.mandate_type = 'exclusive') DESC, (r.temperature = 'hot') DESC, r.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  const s = await settings();
  const listings = await myListings(user);
  return rows.rows.map((r) => {
    let best = null;
    for (const listing of listings) {
      if (!(PURPOSE_TRANSACTION_TYPES[r.purpose] || []).includes(listing.transaction_type)) continue;
      const m = scoreOne(listing, r, s);
      if (!best || m.score > best.score) best = { score: m.score, tier: m.tier, propertyId: listing.id, title: listing.title, breakdown: m.breakdown };
    }
    return { ...maskRequirement(r), sharedWithMe: r.share_status || null, bestMatchWithMyListings: best };
  });
}

// Broker CRM: a lead's match against the broker's listed properties.
async function leadMatches(leadId, user) {
  const lead = (await pool.query('SELECT id, customer_id, assigned_to FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
  let reqs = (await pool.query(`SELECT * FROM requirements WHERE (lead_id = $1 OR customer_id = $2) AND status = 'active'`, [leadId, lead.customer_id])).rows;
  if (!reqs.length && lead.customer_id) {
    const p = (await pool.query('SELECT * FROM customer_preferences WHERE customer_id = $1', [lead.customer_id])).rows[0];
    if (p) reqs = [preferencesToRequirement(p, lead.customer_id)];
  }
  if (!reqs.length) return { requirement: null, items: [] };
  await require('./mandate.service').attachBuyerMax(reqs);
  const s = await settings();
  const listings = STAFF.includes(user.role) ? await candidatesFor(reqs[0], s, { limit: 300 }) : await myListings(user);
  const items = [];
  for (const listing of listings) {
    let best = null;
    for (const req of reqs) {
      if (!(PURPOSE_TRANSACTION_TYPES[req.purpose] || []).includes(listing.transaction_type)) continue;
      const m = scoreOne(listing, req, s);
      if (!best || m.rankScore > best.rankScore) best = m;
    }
    if (best) {
      items.push({
        property: { id: listing.id, title: listing.title, city: listing.city, locality: listing.locality, price: listing.price, price_value: listing.price_value, property_type: listing.property_type, primary_image: listing.primary_image },
        score: best.score,
        tier: best.tier,
        breakdown: best.breakdown,
        rankScore: best.rankScore,
        ...(STAFF.includes(user.role) ? { priceCompatible: best.priceCompatible } : {}),
      });
    }
  }
  items.sort((a, b) => b.rankScore - a.rankScore);
  return { requirement: maskRequirement(reqs[0]), items: items.slice(0, 30) };
}

// Smart recommendation: buyers (masked requirements) for a listing.
async function buyersForListing(propertyId, user) {
  const listing = (await pool.query('SELECT id, created_by, broker_id FROM properties WHERE id = $1', [propertyId])).rows[0];
  if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
  const staff = STAFF.includes(user.role);
  if (!staff && listing.created_by !== user.id && listing.broker_id !== user.id) {
    throw Object.assign(new Error('Only the listing broker or A R staff can see matched buyers'), { statusCode: 403 });
  }
  await refreshProperty(propertyId, { notify: false });
  const rows = await pool.query(
    `SELECT m.*, r.* , m.id AS match_id, r.id AS requirement_id
     FROM requirement_matches m JOIN requirements r ON r.id = m.requirement_id
     WHERE m.property_id = $1 ORDER BY m.rank_score DESC LIMIT 50`,
    [propertyId]
  );
  return rows.rows.map((r) => ({
    requirement: maskRequirement({ ...r, id: r.requirement_id }),
    score: r.score,
    tier: r.tier,
    breakdown: r.breakdown,
    sentAt: r.sent_at,
    ...(staff ? { priceCompatible: r.price_compatible } : {}),
  }));
}

// A broker / rep pushes a (Lukewarm or better) listing to a buyer.
async function sendToBuyer(requirementId, propertyId, user) {
  const req = (await pool.query('SELECT * FROM requirements WHERE id = $1', [requirementId])).rows[0];
  if (!req || req.status !== 'active') throw Object.assign(new Error('Requirement not active'), { statusCode: 404 });
  await require('./mandate.service').attachBuyerMax(req);
  const listing = hideSellerMin((await pool.query(`SELECT ${LISTING_COLUMNS}, p.status FROM properties p WHERE p.id = $1`, [propertyId])).rows)[0];
  if (!listing || listing.status !== 'approved') throw Object.assign(new Error('Listing is not live'), { statusCode: 404 });
  if (!STAFF.includes(user.role) && listing.created_by !== user.id && listing.broker_id !== user.id) {
    throw Object.assign(new Error('You can only send your own listings'), { statusCode: 403 });
  }
  const s = await settings();
  const owner = await requirementOwner(req);
  const variant = variantFor(s, owner);
  const m = scoreOne(listing, req, s, weightsFor(s, variant));
  if (m.score < s.thresholds.lukewarm) {
    throw Object.assign(new Error(`Match is ${m.score}% - only listings at ${s.thresholds.lukewarm}% or more can be sent`), { statusCode: 400 });
  }
  await upsertMatch(req, listing, m, variant);
  await pool.query('UPDATE requirement_matches SET sent_by = $1, sent_at = now() WHERE requirement_id = $2 AND property_id = $3', [user.id, req.id, listing.id]);
  if (owner) {
    await notificationService.createNotification({
      userId: owner,
      type: 'match_sent',
      title: `Recommended for you: ${listing.title}`,
      message: `Your A R Buildwel representative picked a listing in ${[listing.locality, listing.city].filter(Boolean).join(', ')} for your requirement (${m.score}% match).`,
      relatedEntityType: 'property',
      relatedEntityId: listing.id,
    });
  }
  await recordEvent({ userId: owner, propertyId: listing.id, requirementId: req.id, event: 'sent' });
  return { score: m.score, tier: m.tier };
}

// Mandate-verification routing: share a requirement with a partner broker.
async function shareRequirement(requirementId, withUserId, user, note) {
  const target = await pool.query(
    `SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND r.name IN ('broker', 'agency_admin') AND u.status = 'active'`,
    [withUserId]
  );
  if (!target.rows[0]) throw Object.assign(new Error('Partner must be an active broker'), { statusCode: 400 });
  if (withUserId === user.id) throw Object.assign(new Error('You cannot share with yourself'), { statusCode: 400 });
  const req = (await pool.query(`SELECT * FROM requirements WHERE id = $1 AND status = 'active'`, [requirementId])).rows[0];
  if (!req) throw Object.assign(new Error('Requirement not active'), { statusCode: 404 });
  const r = await pool.query(
    `INSERT INTO requirement_shares (requirement_id, shared_by, shared_with, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (requirement_id, shared_with) DO UPDATE SET status = 'pending', note = EXCLUDED.note, shared_by = EXCLUDED.shared_by, responded_at = NULL
     RETURNING *`,
    [requirementId, user.id, withUserId, note || null]
  );
  await notificationService.createNotification({
    userId: withUserId,
    type: 'requirement_shared',
    title: 'A buyer requirement was shared with you',
    message: `${req.purpose === 'rent' ? 'Rental' : 'Purchase'} requirement in ${req.city}${req.budget_max ? `, up to ${formatInr(req.budget_max)}` : ''} - mandate-verification routing. Accept it in the Requirement Marketplace.`,
    relatedEntityType: 'requirement',
    relatedEntityId: requirementId,
  });
  return r.rows[0];
}

async function respondShare(shareId, action, user) {
  const r = await pool.query(
    `UPDATE requirement_shares SET status = $1, responded_at = now() WHERE id = $2 AND shared_with = $3 AND status = 'pending' RETURNING *`,
    [action === 'accept' ? 'accepted' : 'declined', shareId, user.id]
  );
  if (!r.rows[0]) throw Object.assign(new Error('Share not found or already answered'), { statusCode: 404 });
  await notificationService.createNotification({
    userId: r.rows[0].shared_by,
    type: 'requirement_share_response',
    title: `Requirement share ${r.rows[0].status}`,
    message: `Your partner broker ${r.rows[0].status} the shared requirement.`,
    relatedEntityType: 'requirement',
    relatedEntityId: r.rows[0].requirement_id,
  });
  return r.rows[0];
}

async function listShares(user) {
  const r = await pool.query(
    `SELECT sh.*, r.city, r.purpose, r.budget_max, ub.full_name AS shared_by_name, uw.full_name AS shared_with_name
     FROM requirement_shares sh JOIN requirements r ON r.id = sh.requirement_id
     JOIN users ub ON ub.id = sh.shared_by JOIN users uw ON uw.id = sh.shared_with
     WHERE sh.shared_by = $1 OR sh.shared_with = $1 ORDER BY sh.created_at DESC LIMIT 100`,
    [user.id]
  );
  return r.rows;
}

// ------------------------------------------------ CRM preference matching

function preferencesToRequirement(p, customerId) {
  const tx = p.transaction_type;
  return {
    id: null,
    customer_id: customerId,
    purpose: tx === 'rent' ? 'rent' : 'buy',
    property_type: p.property_type,
    city: (p.preferred_locations || [])[0] || '',
    localities: (p.preferred_locations || []).slice(1),
    budget_min: p.budget_min,
    budget_max: p.budget_max,
    bedrooms: p.bedrooms,
    amenities: [],
    mandate_type: 'standard',
  };
}

// Properties surfaced to a buyer from their history (favourites, enquiries)
// when they have no requirement - "properties surfaced to buyers based on
// requirement history".
async function recommendationsForUser(user, { limit = 12 } = {}) {
  const customer = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [user.id])).rows[0];
  if (!customer) return { basis: null, items: [] };
  const reqs = (await pool.query(`SELECT * FROM requirements WHERE customer_id = $1 AND status = 'active'`, [customer.id])).rows;
  let profile = reqs[0] || null;
  let basis = profile ? 'requirement' : null;
  if (!profile) {
    const hist = await pool.query(
      `SELECT p.city, p.locality, p.property_type, p.transaction_type, p.price_value, p.bedrooms FROM properties p
       WHERE p.id IN (SELECT property_id FROM property_favorites WHERE customer_id = $1
                      UNION SELECT property_id FROM leads WHERE customer_id = $1 AND property_id IS NOT NULL)`,
      [customer.id]
    );
    if (!hist.rows.length) {
      const pref = (await pool.query('SELECT * FROM customer_preferences WHERE customer_id = $1', [customer.id])).rows[0];
      if (!pref || !(pref.preferred_locations || []).length) return { basis: null, items: [] };
      profile = preferencesToRequirement(pref, customer.id);
      basis = 'preferences';
    } else {
      const count = (arr) => arr.reduce((m, v) => (v ? m.set(v, (m.get(v) || 0) + 1) : m), new Map());
      const top = (arr) => [...count(arr).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const prices = hist.rows.map((h) => Number(h.price_value)).filter(Boolean).sort((a, b) => a - b);
      const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
      profile = {
        id: null,
        customer_id: customer.id,
        purpose: top(hist.rows.map((h) => (h.transaction_type === 'rent' ? 'rent' : 'buy'))) || 'buy',
        city: top(hist.rows.map((h) => h.city)) || '',
        localities: [...new Set(hist.rows.map((h) => h.locality).filter(Boolean))].slice(0, 3),
        property_type: top(hist.rows.map((h) => h.property_type)),
        budget_min: median ? median * 0.8 : null,
        budget_max: median ? median * 1.2 : null,
        bedrooms: top(hist.rows.map((h) => h.bedrooms)),
        amenities: [],
        mandate_type: 'standard',
      };
      basis = 'history';
    }
  }
  const s = await settings();
  const weights = weightsFor(s, variantFor(s, user.id));
  const seen = new Set((await pool.query('SELECT property_id FROM property_favorites WHERE customer_id = $1', [customer.id])).rows.map((r) => r.property_id));
  const listings = await candidatesFor(profile, s, { excludeCreatedBy: user.id, limit: 300 });
  const items = listings
    .filter((l) => !seen.has(l.id))
    .map((l) => ({ listing: l, ...scoreOne(l, profile, s, weights) }))
    .filter((m) => m.score >= s.thresholds.lukewarm)
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, limit)
    .map((m) => ({
      score: m.score,
      tier: m.tier,
      breakdown: m.breakdown,
      property: {
        id: m.listing.id, title: m.listing.title, property_type: m.listing.property_type, transaction_type: m.listing.transaction_type,
        price: m.listing.price, price_value: m.listing.price_value, city: m.listing.city, locality: m.listing.locality,
        area_sqft: m.listing.area_sqft, bedrooms: m.listing.bedrooms, is_verified: m.listing.is_verified, primary_image: m.listing.primary_image,
      },
    }));
  return { basis, items };
}

// ------------------------------------------------------------- nightly jobs

// Requirement expiry (Engine 5): warn N days before, then pause with
// expired_at; the buyer renews for another validity period.
async function processExpiry() {
  const warnDays = Number(await configService.getConfig('requirement.expiry_warning_days', 3)) || 3;
  const warn = await pool.query(
    `UPDATE requirements r SET expiry_warned_at = now()
     FROM customers c
     WHERE c.id = r.customer_id AND r.status = 'active' AND r.expiry_warned_at IS NULL
       AND r.expires_at <= now() + ($1 || ' days')::interval AND r.expires_at > now()
     RETURNING r.id, r.city, r.purpose, r.expires_at, c.user_id`,
    [String(warnDays)]
  );
  for (const r of warn.rows) {
    if (!r.user_id) continue;
    await notificationService.createNotification({
      userId: r.user_id,
      type: 'requirement_expiring',
      title: 'Your requirement expires soon',
      message: `Your ${r.purpose === 'rent' ? 'rental' : 'purchase'} requirement in ${r.city} expires on ${new Date(r.expires_at).toLocaleDateString('en-IN')}. Renew it to keep getting matches.`,
      relatedEntityType: 'requirement',
      relatedEntityId: r.id,
    });
  }
  const expired = await pool.query(
    `UPDATE requirements r SET status = 'paused', expired_at = now()
     FROM customers c
     WHERE c.id = r.customer_id AND r.status = 'active' AND r.expires_at <= now()
     RETURNING r.id, r.city, c.user_id`
  );
  for (const r of expired.rows) {
    await pool.query('DELETE FROM requirement_matches WHERE requirement_id = $1 AND sent_at IS NULL', [r.id]);
    if (!r.user_id) continue;
    await notificationService.createNotification({
      userId: r.user_id,
      type: 'requirement_expired',
      title: 'Requirement expired',
      message: `Your requirement in ${r.city} has expired. Renew it any time from your dashboard.`,
      relatedEntityType: 'requirement',
      relatedEntityId: r.id,
    });
  }
  return { warned: warn.rows.length, expired: expired.rows.length };
}

// Daily digest of new Warm matches (sec. 7.2).
async function sendDigests() {
  const s = await settings();
  const rows = await pool.query(
    `SELECT m.id, m.score, p.title, p.locality, p.city, c.user_id
     FROM requirement_matches m
     JOIN requirements r ON r.id = m.requirement_id JOIN customers c ON c.id = r.customer_id
     JOIN properties p ON p.id = m.property_id
     WHERE m.tier = 'warm' AND m.digest_sent_at IS NULL AND r.status = 'active' AND p.status = 'approved' AND c.user_id IS NOT NULL
       AND m.score >= $1`,
    [s.thresholds.warm]
  );
  const byUser = new Map();
  for (const r of rows.rows) (byUser.get(r.user_id) || byUser.set(r.user_id, []).get(r.user_id)).push(r);
  for (const [userId, list] of byUser) {
    const top = list.sort((a, b) => b.score - a.score).slice(0, 3);
    await notificationService.createNotification({
      userId,
      type: 'match_digest',
      title: `${list.length} new Warm match${list.length === 1 ? '' : 'es'} for you`,
      message: top.map((t) => `${t.title} (${[t.locality, t.city].filter(Boolean).join(', ')}) - ${t.score}%`).join(' · '),
      relatedEntityType: 'matches',
      relatedEntityId: null,
    });
    await pool.query('UPDATE requirement_matches SET digest_sent_at = now() WHERE id = ANY($1::uuid[])', [list.map((l) => l.id)]);
  }
  return { users: byUser.size, matches: rows.rows.length };
}

async function setSystemConfig(key, value) {
  await pool.query(
    `INSERT INTO app_config (config_key, value, category, description) VALUES ($1, $2, 'matching', 'Written by the matching engine')
     ON CONFLICT (config_key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
  configService.invalidate();
}

// Sec. 7.4 behaviour-based learning. For each component, compare its mean
// score on positively-engaged matches (weighted by event value) with its
// mean on everything shown; components that separate winners from the rest
// gain weight. Bounded to +/- max shift of the configured weight, then
// renormalised. Also learns conversion-pattern boosts per segment.
async function learnWeights({ days = 90 } = {}) {
  const s = await settings();
  const minEvents = Number(await configService.getConfig('matching.learning_min_events', 50)) || 50;
  const maxShift = (Number(await configService.getConfig('matching.learning_max_shift_percent', 30)) || 30) / 100;
  const events = await pool.query(
    `SELECT e.event, e.breakdown, e.property_id FROM match_events e
     WHERE e.created_at > now() - ($1 || ' days')::interval AND e.breakdown IS NOT NULL AND e.variant = 'A'`,
    [String(days)]
  );
  const positives = events.rows.filter((e) => POSITIVE_EVENTS.includes(e.event));
  const shown = events.rows.filter((e) => e.event === 'shown');
  if (positives.length < minEvents || shown.length < minEvents) {
    return { learned: false, reason: `Need ${minEvents} positive and shown events (have ${positives.length} / ${shown.length})` };
  }
  const mean = (list, k, weighted) => {
    let total = 0;
    let wsum = 0;
    for (const e of list) {
      const w = weighted ? EVENT_VALUE[e.event] || 1 : 1;
      total += (Number(e.breakdown?.[k]?.score) || 0) * w;
      wsum += w;
    }
    return wsum ? total / wsum : 0;
  };
  const weights = {};
  const lift = {};
  for (const k of COMPONENTS) {
    const pos = mean(positives, k, true);
    const all = mean(shown, k, false);
    lift[k] = all ? (pos - all) / all : 0;
    const factor = Math.max(1 - maxShift, Math.min(1 + maxShift, 1 + lift[k]));
    weights[k] = s.baseWeights[k] * factor;
  }
  const learned = { weights: normaliseWeights(weights), lift, positives: positives.length, shown: shown.length, learnedAt: new Date().toISOString() };
  await setSystemConfig('matching.learned_weights', learned);

  // Conversion-pattern boosts (up to +5) for segments that convert above average.
  const seg = await pool.query(
    `SELECT LOWER(p.city) || '|' || COALESCE(p.property_type::text, 'any') AS seg, p.price_value,
            COUNT(*) FILTER (WHERE e.event = 'shown')::int AS shown,
            COUNT(*) FILTER (WHERE e.event IN ('enquired', 'visited', 'converted'))::int AS wins
     FROM match_events e JOIN properties p ON p.id = e.property_id
     WHERE e.created_at > now() - ($1 || ' days')::interval
     GROUP BY 1, 2`,
    [String(days)]
  );
  const agg = new Map();
  for (const r of seg.rows) {
    const key = `${r.seg}|${budgetBand(Number(r.price_value))}`;
    const cur = agg.get(key) || { shown: 0, wins: 0 };
    cur.shown += r.shown;
    cur.wins += r.wins;
    agg.set(key, cur);
  }
  const totalShown = [...agg.values()].reduce((a, v) => a + v.shown, 0);
  const totalWins = [...agg.values()].reduce((a, v) => a + v.wins, 0);
  const baseRate = totalShown ? totalWins / totalShown : 0;
  const boosts = {};
  for (const [key, v] of agg) {
    if (v.shown < 20 || !baseRate) continue;
    const rate = v.wins / v.shown;
    if (rate > baseRate) boosts[key] = Math.min(5, Math.round(((rate - baseRate) / baseRate) * 5 * 10) / 10);
  }
  await setSystemConfig('matching.pattern_boosts', boosts);
  return { learned: true, ...learned, patternBoosts: Object.keys(boosts).length };
}

async function runNightly() {
  const expiry = await processExpiry();
  const reqs = await pool.query(`SELECT * FROM requirements WHERE status = 'active'`);
  let hot = 0;
  let matched = 0;
  for (const r of reqs.rows) {
    try {
      const out = await refreshRequirement(r);
      hot += out.hot || 0;
      matched += out.matched || 0;
    } catch (err) {
      console.error(`[matching] nightly requirement ${r.id} failed:`, err.message);
    }
  }
  let learning = { learned: false, reason: 'disabled' };
  if (await configService.getConfig('matching.learning_enabled', true)) learning = await learnWeights();
  const summary = { at: new Date().toISOString(), requirements: reqs.rows.length, matched, hot, expiry, learning: { learned: learning.learned, reason: learning.reason || null } };
  await setSystemConfig('matching.last_nightly_run', summary);
  return summary;
}

// A/B report (sec. 7.4) and promotion of the winning weight set.
async function abReport({ days = 30 } = {}) {
  const r = await pool.query(
    `SELECT variant, event, COUNT(*)::int AS n FROM match_events
     WHERE created_at > now() - ($1 || ' days')::interval GROUP BY variant, event`,
    [String(days)]
  );
  const s = await settings();
  const out = {};
  for (const v of ['A', 'B']) {
    const get = (ev) => r.rows.find((x) => x.variant === v && x.event === ev)?.n || 0;
    const shown = get('shown');
    out[v] = {
      weights: weightsFor(s, v),
      shown,
      clicked: get('clicked'),
      enquired: get('enquired'),
      visited: get('visited'),
      converted: get('converted'),
      clickRate: shown ? Math.round((get('clicked') / shown) * 1000) / 10 : 0,
      enquiryRate: shown ? Math.round((get('enquired') / shown) * 1000) / 10 : 0,
      conversionRate: shown ? Math.round((get('converted') / shown) * 1000) / 10 : 0,
    };
  }
  return { enabled: !!s.ab?.enabled, splitPercent: s.ab?.split_percent ?? 50, days, variants: out };
}

async function promoteVariantB(user, meta) {
  const s = await settings();
  if (!s.ab?.variant_b_weights) throw Object.assign(new Error('No variant B weights configured'), { statusCode: 400 });
  await configService.updateConfig('matching.weights', normaliseWeights(s.ab.variant_b_weights), { reason: 'A/B test: variant B promoted' }, user, meta);
  await configService.updateConfig('matching.ab_test', { ...s.ab, enabled: false }, { reason: 'A/B test ended - variant B promoted' }, user, meta);
  await setSystemConfig('matching.learned_weights', null);
  return abReport();
}

async function overview() {
  const s = await settings();
  const [tiers, events, lastRun, reqs] = await Promise.all([
    pool.query(`SELECT tier, COUNT(*)::int AS n FROM requirement_matches GROUP BY tier`),
    pool.query(`SELECT event, COUNT(*)::int AS n FROM match_events WHERE created_at > now() - interval '30 days' GROUP BY event`),
    configService.getConfig('matching.last_nightly_run', null),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE status = 'active' AND temperature = 'hot')::int AS hot,
              COUNT(*) FILTER (WHERE status = 'active' AND mandate_type = 'exclusive')::int AS priority,
              COUNT(*) FILTER (WHERE status = 'active' AND expires_at <= now() + interval '7 days')::int AS expiring_7d
       FROM requirements`
    ),
  ]);
  return {
    weights: s.weights,
    baseWeights: s.baseWeights,
    learned: s.learned,
    thresholds: s.thresholds,
    radiusKm: s.radiusKm,
    boosts: { mandate: s.mandateBoost, priceCompatible: s.priceBoost, patterns: Object.keys(s.patternBoosts).length },
    matchesByTier: Object.fromEntries(tiers.rows.map((r) => [r.tier, r.n])),
    events30d: Object.fromEntries(events.rows.map((r) => [r.event, r.n])),
    requirements: reqs.rows[0],
    lastNightlyRun: lastRun,
    abTest: s.ab,
  };
}

// In-process scheduler (the platform's BullMQ equivalent): nightly batch at
// 02:00 IST, Warm digest at matching.digest_hour IST, checked every 10 min.
let timer = null;
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
function startScheduler() {
  if (timer) return;
  let lastNightly = null;
  let lastDigest = null;
  timer = setInterval(async () => {
    try {
      const { date, hour } = istNow();
      if (hour >= 2 && lastNightly !== date) {
        lastNightly = date;
        await runNightly();
      }
      const digestHour = Number(await configService.getConfig('matching.digest_hour', 9));
      if (hour >= digestHour && lastDigest !== date) {
        lastDigest = date;
        await sendDigests();
      }
    } catch (err) {
      console.error('[matching] scheduler tick failed:', err.message);
    }
  }, 10 * 60 * 1000);
}

module.exports = {
  DEFAULT_WEIGHTS,
  settings,
  scoreOne,
  refreshRequirement,
  refreshProperty,
  safeRefreshProperty,
  safeRefreshRequirement,
  matchesForRequirements,
  scoresForUser,
  recordEvent,
  marketplace,
  leadMatches,
  buyersForListing,
  sendToBuyer,
  shareRequirement,
  respondShare,
  listShares,
  preferencesToRequirement,
  recommendationsForUser,
  processExpiry,
  sendDigests,
  learnWeights,
  runNightly,
  abReport,
  promoteVariantB,
  overview,
  startScheduler,
  maskRequirement,
};
