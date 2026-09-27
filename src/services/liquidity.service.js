const pool = require('../config/db');
const configService = require('./config.service');

// Module 14 - Liquidity / Saleability Score: "how easy will it be to sell
// this property when I want to exit?" Computed from the platform's own
// data for the property's locality (falling back to the city):
//   demand_supply - buyer requirements + fresh leads vs. live listings
//   velocity      - deals closed in the window relative to live supply
//   engagement    - favourites / investor views & shortlists per listing
// Weights, band thresholds and the look-back window are admin-configurable.
// Output: 0-100 plus High / Moderate / Low (null when there is no data at
// all for the area - "unknown" is more honest than a made-up Low).

const DEFAULT_WEIGHTS = { demand_supply: 45, velocity: 35, engagement: 20 };
const DEFAULT_BANDS = { high: 70, moderate: 40 };

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

async function gatherSignals({ city, locality, propertyType, priceValue, lookbackDays }) {
  const areaParams = [city || '', locality || ''];
  // Locality match when we have one, otherwise the whole city.
  const areaFilter = locality
    ? 'LOWER(p.city) = LOWER($1) AND LOWER(p.locality) = LOWER($2)'
    : 'LOWER(p.city) = LOWER($1) AND $2 = $2';

  const typeParamIndex = 3;
  const typeFilter = propertyType ? `AND p.property_type::text = $${typeParamIndex}` : `AND $${typeParamIndex}::text IS NULL`;
  const baseParams = [...areaParams, propertyType || null];

  const [supply, velocity, leads, engagement, requirements] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n FROM properties p WHERE p.status = 'approved' AND ${areaFilter} ${typeFilter}`,
      baseParams
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM deals d JOIN properties p ON p.id = d.property_id
       WHERE d.stage = 'closed_won' AND d.closed_at > now() - ($4 || ' days')::interval
         AND ${areaFilter} ${typeFilter}`,
      [...baseParams, lookbackDays]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM leads l JOIN properties p ON p.id = l.property_id
       WHERE l.created_at > now() - ($4 || ' days')::interval AND ${areaFilter} ${typeFilter}`,
      [...baseParams, lookbackDays]
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM property_favorites f JOIN properties p ON p.id = f.property_id
          WHERE f.created_at > now() - ($4 || ' days')::interval AND ${areaFilter} ${typeFilter})::int
       + (SELECT COUNT(*) FROM investor_deal_interactions i JOIN properties p ON p.id = i.property_id
          WHERE i.action IN ('viewed', 'shortlisted', 'interest_expressed')
            AND i.created_at > now() - ($4 || ' days')::interval AND ${areaFilter} ${typeFilter})::int AS n`,
      [...baseParams, lookbackDays]
    ),
    // Buyer requirements (customer preferences) naming this locality or
    // city, of a compatible type, whose budget covers the asking price.
    pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_preferences cp
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(cp.preferred_locations) loc
                     WHERE LOWER(loc) IN (LOWER($1), LOWER(NULLIF($2, ''))))
         AND ($3::text IS NULL OR cp.property_type IS NULL OR cp.property_type::text = $3)
         AND ($4::numeric IS NULL OR cp.budget_max IS NULL OR cp.budget_max >= $4 * 0.8)
         AND cp.updated_at > now() - ($5 || ' days')::interval`,
      [city || '', locality || '', propertyType || null, priceValue ?? null, lookbackDays]
    ),
  ]);

  return {
    liveListings: supply.rows[0].n,
    closedDeals: velocity.rows[0].n,
    recentLeads: leads.rows[0].n,
    engagementEvents: engagement.rows[0].n,
    buyerRequirements: requirements.rows[0].n,
  };
}

async function computeLiquidity({ city, locality, propertyType, priceValue } = {}) {
  if (!city) return { score: null, band: null, reason: 'city is required' };

  const [weights, bands, lookbackDays] = await Promise.all([
    configService.getConfig('liquidity.weights', DEFAULT_WEIGHTS),
    configService.getConfig('liquidity.bands', DEFAULT_BANDS),
    configService.getConfig('liquidity.lookback_days', 180),
  ]);

  let signals = await gatherSignals({ city, locality, propertyType, priceValue, lookbackDays });
  let scope = locality ? 'locality' : 'city';
  // Thin locality data -> widen to the city rather than score on nothing.
  if (locality && signals.liveListings + signals.buyerRequirements + signals.recentLeads === 0) {
    signals = await gatherSignals({ city, locality: null, propertyType, priceValue, lookbackDays });
    scope = 'city';
  }

  const totalSignal = signals.liveListings + signals.buyerRequirements + signals.recentLeads + signals.closedDeals;
  if (totalSignal === 0) {
    return { score: null, band: null, scope, signals, reason: 'Not enough platform data for this area yet' };
  }

  const supply = Math.max(signals.liveListings, 1);
  const demand = signals.buyerRequirements + signals.recentLeads;
  // Full marks at 2+ active buyers per live listing; 25% of supply closing
  // within the window; 10 engagement events per listing.
  const factors = {
    demand_supply: clamp01(demand / supply / 2),
    velocity: clamp01(signals.closedDeals / supply / 0.25),
    engagement: clamp01(signals.engagementEvents / supply / 10),
  };

  const totalWeight = Object.values(weights).reduce((a, b) => a + Number(b), 0) || 1;
  const score = Math.round(
    Object.entries(factors).reduce((sum, [key, value]) => sum + value * Number(weights[key] || 0), 0) * (100 / totalWeight)
  );
  const band = score >= bands.high ? 'high' : score >= bands.moderate ? 'moderate' : 'low';

  return {
    score,
    band,
    label: { high: 'High Liquidity (fast sale expected)', moderate: 'Moderate Liquidity', low: 'Low Liquidity (slow exit risk)' }[band],
    scope,
    lookbackDays: Number(lookbackDays),
    factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, Math.round(v * 100)])),
    signals,
  };
}

module.exports = { computeLiquidity };
