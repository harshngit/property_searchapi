const pool = require('../../config/db');
const configService = require('../config.service');

// Engine 6 - area market intelligence (rule-based, Phase 1 - no paid AI).
//
// Inputs, per city / locality:
//   - the platform's own listings: median price per sq ft (sale) and rent per
//     sq ft, live supply;
//   - demand: active buyer requirements, enquiries and listing views (last 90
//     days, compared with the 90 days before);
//   - external aggregates: portal market pages (price change, rental yield)
//     and the NHB / RBI city index (year-on-year) - analytics only;
//   - deals closed, and the liquidity score (Module 14).
// Outputs:
//   - price trend: Rising / Stable / Declining with the yearly % behind it;
//   - area growth score 0-100 and investment potential score 0-100;
//   - a recommendation in plain words ("Recommended for mid-term investment").
// Monthly snapshots (area_market_snapshots) are stored from day one, so the
// trend can compare the platform's own prices over time and Phase 2 can learn
// from the history. Every output carries the non-advisory disclaimer.

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const norm = (v, lo, hi) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : clamp01((Number(v) - lo) / (hi - lo)));
const round = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
const monthStart = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;

const DEFAULT_WEIGHTS = { growth: { trend: 40, demand_growth: 30, demand_supply: 30 }, potential: { growth: 40, yield: 25, liquidity: 20, affordability: 15 } };

async function settings() {
  const [w, band, recommend, minListings, disclaimer] = await Promise.all([
    configService.getConfig('market_intel.weights', DEFAULT_WEIGHTS),
    configService.getConfig('market_intel.trend_band_percent', 3),
    configService.getConfig('market_intel.recommend_min_score', 70),
    configService.getConfig('market_intel.min_listings', 3),
    configService.getConfig('market_intel.disclaimer', 'Indicative guidance based on available data. It is not financial advice.'),
  ]);
  return {
    weights: { growth: { ...DEFAULT_WEIGHTS.growth, ...(w?.growth || {}) }, potential: { ...DEFAULT_WEIGHTS.potential, ...(w?.potential || {}) } },
    band: Number(band) || 3,
    recommend: Number(recommend) || 70,
    minListings: Number(minListings) || 3,
    disclaimer,
  };
}

// ------------------------------------------------------------ data per area

// Platform figures for every area of a city (or one area) in one pass.
async function gather(city, locality = null) {
  const params = [city];
  const locFilter = locality ? ` AND lower(COALESCE(p.locality, '')) = lower($2)` : '';
  if (locality) params.push(locality);
  const listings = (await pool.query(
    `SELECT COALESCE(p.locality, '') AS locality,
            COUNT(*) FILTER (WHERE p.transaction_type = 'sell')::int AS sell,
            COUNT(*) FILTER (WHERE p.transaction_type = 'rent')::int AS rent,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY p.price_value / NULLIF(p.area_sqft, 0)) FILTER (WHERE p.transaction_type = 'sell' AND p.area_sqft > 0 AND p.price_value > 0) AS price_sqft,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY p.price_value / NULLIF(p.area_sqft, 0)) FILTER (WHERE p.transaction_type = 'rent' AND p.area_sqft > 0 AND p.price_value > 0) AS rent_sqft
     FROM properties p WHERE p.status = 'approved' AND lower(p.city) = lower($1)${locFilter}
     GROUP BY 1`,
    params
  )).rows;
  const demand = (await pool.query(
    `WITH req AS (
       SELECT COALESCE(lower(x.l), '') AS loc,
              COUNT(*) FILTER (WHERE r.created_at > now() - interval '90 days')::int AS now_n,
              COUNT(*) FILTER (WHERE r.created_at <= now() - interval '90 days' AND r.created_at > now() - interval '180 days')::int AS prev_n
       FROM requirements r
       LEFT JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(r.localities) = 'array' AND jsonb_array_length(r.localities) > 0 THEN r.localities ELSE '[""]'::jsonb END
       ) AS x(l) ON true
       WHERE lower(r.city) = lower($1) AND r.created_at > now() - interval '180 days' AND r.purpose IN ('buy', 'rent', 'invest')
       GROUP BY 1),
     enq AS (
       SELECT lower(COALESCE(p.locality, '')) AS loc,
              COUNT(*) FILTER (WHERE ld.created_at > now() - interval '90 days')::int AS now_n,
              COUNT(*) FILTER (WHERE ld.created_at <= now() - interval '90 days')::int AS prev_n
       FROM leads ld JOIN properties p ON p.id = ld.property_id
       WHERE lower(p.city) = lower($1) AND ld.created_at > now() - interval '180 days'
       GROUP BY 1),
     views AS (
       SELECT lower(COALESCE(p.locality, '')) AS loc,
              COUNT(*) FILTER (WHERE e.event_timestamp > now() - interval '90 days')::int AS now_n,
              COUNT(*) FILTER (WHERE e.event_timestamp <= now() - interval '90 days')::int AS prev_n
       FROM events e JOIN properties p ON p.id::text = e.properties_json->>'propertyId'
       WHERE e.event_type IN ('property_view', 'property_enquiry', 'shortlist_added') AND e.event_timestamp > now() - interval '180 days' AND lower(p.city) = lower($1)
       GROUP BY 1),
     closed AS (
       SELECT lower(COALESCE(p.locality, '')) AS loc, COUNT(*)::int AS n
       FROM deals d JOIN properties p ON p.id = d.property_id
       WHERE d.stage = 'closed_won' AND d.updated_at > now() - interval '180 days' AND lower(p.city) = lower($1)
       GROUP BY 1)
     SELECT COALESCE(req.loc, enq.loc, views.loc, closed.loc) AS loc,
            COALESCE(req.now_n, 0) AS req_now, COALESCE(req.prev_n, 0) AS req_prev,
            COALESCE(enq.now_n, 0) AS enq_now, COALESCE(enq.prev_n, 0) AS enq_prev,
            COALESCE(views.now_n, 0) AS views_now, COALESCE(views.prev_n, 0) AS views_prev,
            COALESCE(closed.n, 0) AS closed
     FROM req FULL JOIN enq ON enq.loc = req.loc FULL JOIN views ON views.loc = COALESCE(req.loc, enq.loc)
     FULL JOIN closed ON closed.loc = COALESCE(req.loc, enq.loc, views.loc)`,
    [city]
  )).rows;
  const external = (await pool.query(
    `SELECT lower(locality) AS loc, AVG(avg_price_per_sqft)::float AS price_sqft, AVG(price_change_percent)::float AS change_pct, AVG(rental_yield_percent)::float AS yield_pct
     FROM (SELECT DISTINCT ON (portal_key, locality) * FROM market_stats WHERE lower(city) = lower($1) AND captured_on > CURRENT_DATE - 120 AND transaction_type = 'sell'
           ORDER BY portal_key, locality, captured_on DESC) x
     GROUP BY 1`,
    [city]
  )).rows;
  const index = (await pool.query(
    `SELECT yoy_change_percent::float AS yoy FROM price_indices WHERE lower(city) = lower($1) AND yoy_change_percent IS NOT NULL ORDER BY period_start DESC NULLS LAST, captured_at DESC LIMIT 1`,
    [city]
  )).rows[0]?.yoy ?? null;

  const byLoc = new Map();
  const get = (loc) => {
    const k = String(loc || '').toLowerCase();
    if (!byLoc.has(k)) byLoc.set(k, { locality: loc || '', sell: 0, rent: 0, priceSqft: null, rentSqft: null, reqNow: 0, enqNow: 0, viewsNow: 0, prevDemand: 0, closed: 0, extPrice: null, extChange: null, yield: null });
    return byLoc.get(k);
  };
  for (const r of listings) Object.assign(get(r.locality), { locality: r.locality, sell: r.sell, rent: r.rent, priceSqft: r.price_sqft === null ? null : Number(r.price_sqft), rentSqft: r.rent_sqft === null ? null : Number(r.rent_sqft) });
  for (const d of demand) {
    if (locality && d.loc !== String(locality).toLowerCase()) continue;
    const a = get(byLoc.get(d.loc)?.locality ?? d.loc);
    Object.assign(a, { reqNow: d.req_now, enqNow: d.enq_now, viewsNow: d.views_now, prevDemand: d.req_prev + d.enq_prev + d.views_prev, closed: d.closed });
  }
  for (const e of external) {
    if (locality && e.loc !== String(locality).toLowerCase()) continue;
    const a = byLoc.get(e.loc) || (e.loc ? get(e.loc) : null);
    if (a) Object.assign(a, { extPrice: e.price_sqft, extChange: e.change_pct, yield: e.yield_pct });
  }
  const cityExt = external.find((e) => e.loc === '');
  return { areas: [...byLoc.values()].filter((a) => a.locality), indexYoy: index, cityChange: cityExt?.change_pct ?? null, cityYield: cityExt?.yield_pct ?? null };
}

// The platform's own price change per year, from snapshots 6-12 months back.
async function ownTrend(city, locality, priceSqft) {
  if (!priceSqft) return null;
  const old = (await pool.query(
    `SELECT median_price_sqft::float AS p, period FROM area_market_snapshots
     WHERE lower(city) = lower($1) AND lower(locality) = lower($2) AND median_price_sqft IS NOT NULL
       AND period <= (date_trunc('month', now()) - interval '6 months')::date
     ORDER BY period DESC LIMIT 1`,
    [city, locality || '']
  )).rows[0];
  if (!old?.p) return null;
  const months = Math.max(6, Math.round((Date.now() - new Date(old.period).getTime()) / (30.4 * 86400000)));
  return ((priceSqft / old.p - 1) * 12 * 100) / months;
}

// ------------------------------------------------------------ scoring

function score(a, ctx, s) {
  const reasons = [];
  // Price trend: the platform's own (from snapshots), the portal figure and the city index.
  const parts = [[a.ownTrend, 0.4], [a.extChange ?? ctx.cityChange, 0.4], [ctx.indexYoy, 0.2]].filter(([v]) => v !== null && v !== undefined && Number.isFinite(Number(v)));
  const weightSum = parts.reduce((n, [, w]) => n + w, 0);
  const trendPct = weightSum ? parts.reduce((n, [v, w]) => n + Number(v) * w, 0) / weightSum : null;
  const trend = trendPct === null ? 'unknown' : trendPct > s.band ? 'rising' : trendPct < -s.band ? 'declining' : 'stable';

  const demandNow = a.reqNow + a.enqNow + a.viewsNow / 10;
  const demandPrev = a.prevDemand ? a.prevDemand : null;
  const demandGrowthPct = demandPrev ? ((demandNow - demandPrev) / demandPrev) * 100 : demandNow > 0 ? 50 : null;
  const supply = Math.max(a.sell + a.rent, 1);
  const dsRatio = (a.reqNow + a.enqNow) / supply;

  const g = s.weights.growth;
  const gParts = [[norm(trendPct, -10, 15), g.trend], [norm(demandGrowthPct, -50, 100), g.demand_growth], [norm(dsRatio, 0, 3), g.demand_supply]].filter(([v]) => v !== null);
  const gW = gParts.reduce((n, [, w]) => n + Number(w), 0);
  const growthScore = gW ? Math.round((gParts.reduce((n, [v, w]) => n + v * Number(w), 0) / gW) * 100) : null;

  // Rental yield: external if known, else the platform's own rent vs price.
  const ownYield = a.rentSqft && a.priceSqft ? ((a.rentSqft * 12) / a.priceSqft) * 100 : null;
  const yieldPct = a.yield ?? ctx.cityYield ?? ownYield;
  const priceSqft = a.priceSqft ?? a.extPrice;
  const affordability = ctx.cityPrice && priceSqft ? (ctx.cityPrice - priceSqft) / ctx.cityPrice : null;
  const liquidity = { high: 1, moderate: 0.6, low: 0.2 }[a.liquidityBand] ?? null;
  const p = s.weights.potential;
  const pParts = [[growthScore === null ? null : growthScore / 100, p.growth], [norm(yieldPct, 1, 6), p.yield], [liquidity, p.liquidity], [norm(affordability, -0.5, 0.5), p.affordability]].filter(([v]) => v !== null);
  const pW = pParts.reduce((n, [, w]) => n + Number(w), 0);
  const potentialScore = pW ? Math.round((pParts.reduce((n, [v, w]) => n + v * Number(w), 0) / pW) * 100) : null;

  if (trendPct !== null) reasons.push(`${trendPct >= 0 ? '+' : ''}${round(trendPct, 1)}% price trend a year`);
  if (demandGrowthPct !== null) reasons.push(`buyer interest ${demandGrowthPct >= 0 ? 'up' : 'down'} ${Math.abs(round(demandGrowthPct))}% on the previous 3 months`);
  if (a.reqNow + a.enqNow) reasons.push(`${round(dsRatio, 1)} active buyers per live listing`);
  if (yieldPct !== null) reasons.push(`${round(yieldPct, 1)}% rental yield`);
  if (a.liquidityBand) reasons.push(`${a.liquidityBand} liquidity`);
  if (affordability !== null && Math.abs(affordability) >= 0.1) reasons.push(`${Math.abs(round(affordability * 100))}% ${affordability > 0 ? 'below' : 'above'} the city average price`);

  const demandLabel = demandGrowthPct === null ? null : demandGrowthPct >= 25 ? 'High demand growth' : demandGrowthPct >= 0 ? 'Steady demand' : 'Falling demand';
  const yieldLabel = yieldPct === null ? null : yieldPct >= 4 ? 'strong rental yield' : yieldPct >= 2.5 ? 'moderate rental yield' : 'low rental yield';
  let recommendation;
  if (potentialScore === null) recommendation = 'Not enough data yet';
  else if (potentialScore >= s.recommend) recommendation = trend === 'rising' ? 'Recommended for mid-term investment' : 'Recommended for long-term investment';
  else if (potentialScore >= s.recommend - 20) recommendation = 'Worth watching';
  else recommendation = 'Not a priority now';
  const summary = [demandLabel, trendPct !== null ? `${round(trendPct, 1)}% price ${trendPct >= 0 ? 'appreciation' : 'change'} trend` : null, yieldLabel].filter(Boolean).join(', ');

  return {
    trend, trendPercent: round(trendPct, 1), demandGrowthPercent: round(demandGrowthPct), demandSupplyRatio: round(dsRatio, 2), rentalYieldPercent: round(yieldPct, 2),
    growthScore, potentialScore, recommendation, summary: summary ? `${summary} - ${recommendation}` : recommendation, reasons,
  };
}

async function liquidityBand(city, locality, priceSqft) {
  const l = await require('../liquidity.service').computeLiquidity({ city, locality, priceValue: priceSqft ? priceSqft * 1000 : null }).catch(() => null);
  return l?.band || null;
}

// ------------------------------------------------------------ public API

// All scored areas of a city (sorted by investment potential).
async function cityReport(city, { limit = 100 } = {}) {
  if (!city) return null;
  const s = await settings();
  const data = await gather(city);
  const prices = data.areas.filter((a) => a.priceSqft).map((a) => a.priceSqft).sort((x, y) => x - y);
  const mid = Math.floor(prices.length / 2);
  const cityPrice = !prices.length ? null : prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  const ctx = { indexYoy: data.indexYoy, cityChange: data.cityChange, cityYield: data.cityYield, cityPrice };
  const out = [];
  for (const a of data.areas) {
    const enough = a.sell + a.rent >= s.minListings || a.extPrice !== null;
    if (!enough) continue;
    a.ownTrend = await ownTrend(city, a.locality, a.priceSqft);
    a.liquidityBand = await liquidityBand(city, a.locality, a.priceSqft);
    out.push({
      city, locality: a.locality, liveListings: a.sell + a.rent, medianPricePerSqft: round(a.priceSqft ?? a.extPrice), medianRentPerSqft: round(a.rentSqft, 1),
      buyerRequirements: a.reqNow, enquiries: a.enqNow, views: a.viewsNow, dealsClosed: a.closed, liquidity: a.liquidityBand,
      ...score(a, ctx, s),
    });
  }
  out.sort((x, y) => (y.potentialScore ?? -1) - (x.potentialScore ?? -1));
  return { city, cityMedianPricePerSqft: round(cityPrice), indexYoyPercent: round(data.indexYoy, 1), areas: out.slice(0, limit), disclaimer: s.disclaimer };
}

// One area (falls back to its city row when the area has no data of its own).
async function areaReport(city, locality) {
  const r = await cityReport(city, { limit: 1000 });
  if (!r) return null;
  const hit = r.areas.find((a) => a.locality.toLowerCase() === String(locality || '').toLowerCase());
  return { ...(hit || { city, locality, recommendation: 'Not enough data yet', reasons: [], potentialScore: null, growthScore: null, trend: 'unknown' }), cityMedianPricePerSqft: r.cityMedianPricePerSqft, disclaimer: r.disclaimer };
}

// Recommended investment areas: across the given city, or every city with listings.
async function recommended({ city, limit = 10 } = {}) {
  const s = await settings();
  const cities = city ? [city] : (await pool.query(`SELECT city FROM properties WHERE status = 'approved' AND city IS NOT NULL GROUP BY city ORDER BY COUNT(*) DESC LIMIT 8`)).rows.map((r) => r.city);
  const all = [];
  for (const c of cities) {
    const r = await cityReport(c);
    for (const a of r?.areas || []) if ((a.potentialScore ?? 0) >= s.recommend - 20) all.push(a);
  }
  all.sort((x, y) => y.potentialScore - x.potentialScore);
  return { areas: all.slice(0, limit), recommendMinScore: s.recommend, disclaimer: s.disclaimer };
}

// Monthly snapshot of every area (the history Phase 2 learns from).
async function snapshot({ period = monthStart() } = {}) {
  const cities = (await pool.query(`SELECT city FROM properties WHERE status = 'approved' AND city IS NOT NULL GROUP BY city`)).rows.map((r) => r.city);
  let n = 0;
  for (const city of cities) {
    const d = await gather(city);
    for (const a of d.areas) {
      await pool.query(
        `INSERT INTO area_market_snapshots (city, locality, period, listings_sell, listings_rent, median_price_sqft, median_rent_sqft, demand_requirements, demand_enquiries, demand_views,
           prev_demand, deals_closed, external_price_sqft, external_change_pct, rental_yield_pct, index_yoy_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (city, locality, period) DO UPDATE SET listings_sell = EXCLUDED.listings_sell, listings_rent = EXCLUDED.listings_rent, median_price_sqft = EXCLUDED.median_price_sqft,
           median_rent_sqft = EXCLUDED.median_rent_sqft, demand_requirements = EXCLUDED.demand_requirements, demand_enquiries = EXCLUDED.demand_enquiries, demand_views = EXCLUDED.demand_views,
           prev_demand = EXCLUDED.prev_demand, deals_closed = EXCLUDED.deals_closed, external_price_sqft = EXCLUDED.external_price_sqft, external_change_pct = EXCLUDED.external_change_pct,
           rental_yield_pct = EXCLUDED.rental_yield_pct, index_yoy_pct = EXCLUDED.index_yoy_pct, computed_at = now()`,
        [city, a.locality, period, a.sell, a.rent, a.priceSqft, a.rentSqft, a.reqNow, a.enqNow, a.viewsNow, a.prevDemand, a.closed, a.extPrice, a.extChange, a.yield, d.indexYoy]
      );
      n += 1;
    }
  }
  return { period, cities: cities.length, areas: n };
}

// Once a day: take this month's snapshot if it has not been taken yet.
let timer = null;
function startScheduler() {
  if (timer) return;
  const tick = async () => {
    const done = (await pool.query('SELECT 1 FROM area_market_snapshots WHERE period = $1 LIMIT 1', [monthStart()])).rows.length;
    if (!done) await snapshot();
  };
  timer = setInterval(() => tick().catch((err) => console.error('[market-intel] snapshot failed:', err.message)), 24 * 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(() => tick().catch((err) => console.error('[market-intel] snapshot failed:', err.message)), 60 * 1000).unref?.();
}

module.exports = { cityReport, areaReport, recommended, snapshot, settings, score, monthStart, startScheduler };
