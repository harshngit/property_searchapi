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
  const investmentScore = Math.round(Object.values(components).reduce((a, b) => a + b, 0));

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

module.exports = { scoreOpportunity, refreshScores, OPPORTUNITY_CATEGORIES };
