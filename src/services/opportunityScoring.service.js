const pool = require('../config/db');
const configService = require('./config.service');
const liquidityService = require('./liquidity.service');

// Engine 4 - "Market comparison: estimated market value, discount
// percentage, investment score (0-100)" and "Liquidity and exit score".
// Rule-based and fully configurable (opportunity.* in app_config):
//   discount  - discount of asking/reserve price to estimated market value
//   liquidity - Module 14 band for the locality
//   risk      - loses a quarter of its weight per risk indicator flagged
//   yield     - stated yield, else estimated rent / asking price
// Unknown inputs score a neutral fraction rather than zero, so a deal with
// missing data isn't ranked below a deal with known-bad data.
//
// Learning from outcomes ("AI deal scoring refines deal scores based on
// historical conversion data"): deals are grouped into segments (category x
// discount band x liquidity band); each segment's interest -> closure rate,
// smoothed towards the overall rate, nudges the score up or down by at most
// opportunity.learning_max_adjustment points once enough history exists.
// The adjustment and the data behind it are kept in score_breakdown.

const DEFAULT_WEIGHTS = { discount: 40, liquidity: 25, risk: 20, yield: 15 };
const LIQUIDITY_FRACTION = { high: 1, moderate: 0.6, low: 0.2 };
const UNKNOWN_FRACTION = 0.4;
const OPPORTUNITY_CATEGORIES = ['auction', 'special_situation'];

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function toNumber(v) {
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function discountBand(discountPercent) {
  if (discountPercent === null || discountPercent === undefined) return 'unknown';
  if (discountPercent < 10) return 'under_10';
  if (discountPercent < 25) return '10_to_25';
  return 'over_25';
}

const BAND_SQL = `CASE WHEN p.discount_percent IS NULL THEN 'unknown' WHEN p.discount_percent < 10 THEN 'under_10'
                       WHEN p.discount_percent < 25 THEN '10_to_25' ELSE 'over_25' END`;

// Conversion history for a deal's segment vs all opportunity deals.
async function conversionAdjustment(property, discountPercent, liquidityBand) {
  const [maxPoints, minHistory, prior] = await Promise.all([
    configService.getConfig('opportunity.learning_max_adjustment', 10),
    configService.getConfig('opportunity.learning_min_interests', 20),
    configService.getConfig('opportunity.learning_prior_weight', 10),
  ]);
  const segment = { category: property.listing_category, discountBand: discountBand(discountPercent), liquidityBand: liquidityBand || 'unknown' };
  const result = await pool.query(
    `SELECT COUNT(*)::int AS interests,
            COUNT(*) FILTER (WHERE oi.stage = 'closure')::int AS closures,
            COUNT(*) FILTER (WHERE p.listing_category = $1 AND ${BAND_SQL} = $2 AND COALESCE(p.liquidity_band, 'unknown') = $3)::int AS seg_interests,
            COUNT(*) FILTER (WHERE p.listing_category = $1 AND ${BAND_SQL} = $2 AND COALESCE(p.liquidity_band, 'unknown') = $3 AND oi.stage = 'closure')::int AS seg_closures
     FROM opportunity_interests oi JOIN properties p ON p.id = oi.property_id
     WHERE p.id <> $4`,
    [segment.category, segment.discountBand, segment.liquidityBand, property.id]
  );
  const r = result.rows[0];
  const learning = { segment, interests: r.interests, closures: r.closures, segmentInterests: r.seg_interests, segmentClosures: r.seg_closures, adjustment: 0 };
  if (r.interests < Number(minHistory) || r.closures === 0) {
    learning.note = 'Not enough closed deals yet to learn from';
    return learning;
  }
  const globalRate = r.closures / r.interests;
  const k = Number(prior) || 10;
  const segmentRate = (r.seg_closures + k * globalRate) / (r.seg_interests + k);
  const max = Number(maxPoints) || 10;
  learning.globalRate = Math.round(globalRate * 1000) / 1000;
  learning.segmentRate = Math.round(segmentRate * 1000) / 1000;
  learning.adjustment = Math.round(Math.max(-max, Math.min(max, (segmentRate / globalRate - 1) * max)) * 10) / 10;
  return learning;
}

async function scoreOpportunity(property) {
  const [weights, fullDiscount, fullYield] = await Promise.all([
    configService.getConfig('opportunity.scoring_weights', DEFAULT_WEIGHTS),
    configService.getConfig('opportunity.discount_full_score_percent', 40),
    configService.getConfig('opportunity.yield_full_score_percent', 12),
  ]);

  const asking = toNumber(property.reserve_price) ?? toNumber(property.price_value);
  const marketValue = toNumber(property.estimated_market_value);
  const discountPercent =
    asking !== null && marketValue ? Math.round(((marketValue - asking) / marketValue) * 10000) / 100 : null;

  const liquidity = await liquidityService.computeLiquidity({
    city: property.city,
    locality: property.locality,
    propertyType: property.property_type,
    priceValue: asking,
  });

  const riskCount = Array.isArray(property.risk_indicators) ? property.risk_indicators.length : 0;
  const statedYield = toNumber(property.yield_percent);
  const rent = toNumber(property.estimated_rent_monthly);
  const yieldPercent = statedYield ?? (rent && asking ? Math.round(((rent * 12) / asking) * 10000) / 100 : null);

  const fractions = {
    discount: discountPercent === null ? UNKNOWN_FRACTION : clamp01(discountPercent / Number(fullDiscount)),
    liquidity: liquidity.band ? LIQUIDITY_FRACTION[liquidity.band] : UNKNOWN_FRACTION,
    risk: clamp01(1 - 0.25 * riskCount),
    yield: yieldPercent === null ? UNKNOWN_FRACTION : clamp01(yieldPercent / Number(fullYield)),
  };

  const totalWeight = Object.values(weights).reduce((a, b) => a + Number(b), 0) || 1;
  const components = Object.fromEntries(
    Object.entries(fractions).map(([k, f]) => [k, Math.round(f * Number(weights[k] || 0) * (100 / totalWeight) * 10) / 10])
  );
  const learning = await conversionAdjustment(property, discountPercent, liquidity.band);
  const ruleScore = Object.values(components).reduce((a, b) => a + b, 0);
  const investmentScore = Math.max(0, Math.min(100, Math.round(ruleScore + learning.adjustment)));

  return {
    discountPercent,
    investmentScore,
    liquidityScore: liquidity.score,
    liquidityBand: liquidity.band,
    breakdown: {
      components,
      inputs: { askingPrice: asking, estimatedMarketValue: marketValue, discountPercent, yieldPercent, riskCount },
      liquidity: { score: liquidity.score, band: liquidity.band, scope: liquidity.scope },
      weights,
      ruleScore: Math.round(ruleScore),
      learning,
    },
  };
}

// Recomputes and stores the score for one listing. Non-opportunity
// listings only get their liquidity refreshed. Never throws - scoring must
// not break a listing save.
async function refreshScores(propertyId) {
  try {
    const result = await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId]);
    const property = result.rows[0];
    if (!property) return null;

    if (!OPPORTUNITY_CATEGORIES.includes(property.listing_category)) {
      const liquidity = await liquidityService.computeLiquidity({
        city: property.city,
        locality: property.locality,
        propertyType: property.property_type,
        priceValue: property.price_value,
      });
      await pool.query(
        'UPDATE properties SET liquidity_score = $1, liquidity_band = $2, scored_at = now() WHERE id = $3',
        [liquidity.score, liquidity.band, propertyId]
      );
      return { liquidityScore: liquidity.score, liquidityBand: liquidity.band };
    }

    const scored = await scoreOpportunity(property);
    await pool.query(
      `UPDATE properties SET discount_percent = $1, investment_score = $2, liquidity_score = $3,
              liquidity_band = $4, score_breakdown = $5, scored_at = now()
       WHERE id = $6`,
      [scored.discountPercent, scored.investmentScore, scored.liquidityScore, scored.liquidityBand, JSON.stringify(scored.breakdown), propertyId]
    );
    return scored;
  } catch (err) {
    console.error(`Scoring failed for property ${propertyId}:`, err.message);
    return null;
  }
}

// Re-score every live opportunity (run daily so scores keep learning from
// new closures).
async function rescoreAll() {
  const result = await pool.query(
    `SELECT id FROM properties WHERE status = 'approved' AND listing_category::text = ANY($1::text[])`,
    [OPPORTUNITY_CATEGORIES]
  );
  let n = 0;
  for (const { id } of result.rows) if (await refreshScores(id)) n += 1;
  return { rescored: n };
}

module.exports = { scoreOpportunity, refreshScores, rescoreAll, OPPORTUNITY_CATEGORIES };
