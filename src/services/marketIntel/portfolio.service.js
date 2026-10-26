const pool = require('../../config/db');
const areaIntel = require('./areaIntel.service');
const { badRequest } = require('../../utils/httpError');

// Engine 6 - budget-based portfolio suggestions (Investment Guidance Engine,
// non-advisory). Given a budget and a risk preference, picks 1-4 live listings
// in the better-scored areas, spread across localities, within the budget:
//   conservative  favours liquidity and rental yield, at most 2 holdings
//   balanced      the area's investment potential score
//   growth        favours the area growth score and rising price trends
// Rule-based, no AI cost. Always with the non-advisory disclaimer.

const RISK = {
  conservative: { maxHoldings: 2, pick: (a) => (a.liquidity === 'high' ? 30 : a.liquidity === 'moderate' ? 15 : 0) + (a.rentalYieldPercent || 0) * 8 + (a.potentialScore || 0) * 0.5 },
  balanced: { maxHoldings: 3, pick: (a) => a.potentialScore || 0 },
  growth: { maxHoldings: 4, pick: (a) => (a.growthScore || 0) + (a.trend === 'rising' ? 15 : 0) },
};

async function suggest({ budget, city, risk = 'balanced', propertyTypes } = {}) {
  const total = Number(budget);
  if (!(total >= 500000)) throw badRequest('Give a budget of at least Rs 5 lakh');
  const r = RISK[risk] ? risk : 'balanced';
  const rule = RISK[r];
  const cities = city ? [city] : (await pool.query(`SELECT city FROM properties WHERE status = 'approved' AND city IS NOT NULL GROUP BY city ORDER BY COUNT(*) DESC LIMIT 6`)).rows.map((x) => x.city);

  const areas = [];
  for (const c of cities) {
    const rep = await areaIntel.cityReport(c);
    for (const a of rep?.areas || []) if ((a.potentialScore ?? 0) >= 40) areas.push(a);
  }
  if (!areas.length) return { budget: total, risk: r, holdings: [], note: 'Not enough market data in these areas yet to suggest a portfolio.', disclaimer: (await areaIntel.settings()).disclaimer };
  areas.sort((x, y) => rule.pick(y) - rule.pick(x));

  const types = Array.isArray(propertyTypes) && propertyTypes.length ? propertyTypes : null;
  const holdings = [];
  let left = total;
  const used = new Set();
  // One listing per area, best areas first, priced so later holdings still fit.
  for (const a of areas) {
    if (holdings.length >= rule.maxHoldings) break;
    const key = `${a.city}|${a.locality}`.toLowerCase();
    if (used.has(key)) continue;
    const cap = holdings.length === rule.maxHoldings - 1 ? left : Math.min(left, total * (r === 'conservative' ? 0.75 : 0.6));
    const p = (await pool.query(
      `SELECT p.id, p.title, p.city, p.locality, p.property_type::text AS property_type, p.price_value, p.area_sqft, p.estimated_rent_monthly
       FROM properties p
       WHERE p.status = 'approved' AND p.transaction_type = 'sell' AND COALESCE(p.listing_category::text, 'residential') <> 'institutional'
         AND lower(p.city) = lower($1) AND lower(COALESCE(p.locality, '')) = lower($2) AND p.price_value > 0 AND p.price_value <= $3
         ${types ? 'AND p.property_type::text = ANY($4::text[])' : ''}
       ORDER BY p.is_verified DESC, p.price_value DESC LIMIT 1`,
      types ? [a.city, a.locality, cap, types] : [a.city, a.locality, cap]
    )).rows[0];
    if (!p) continue;
    used.add(key);
    left -= Number(p.price_value);
    const rent = Number(p.estimated_rent_monthly) || (a.rentalYieldPercent ? (Number(p.price_value) * a.rentalYieldPercent) / 1200 : null);
    holdings.push({
      propertyId: p.id, title: p.title, city: p.city, locality: p.locality, propertyType: p.property_type, price: Number(p.price_value),
      sharePercent: null, indicativeMonthlyRent: rent ? Math.round(rent) : null,
      area: { trend: a.trend, trendPercent: a.trendPercent, growthScore: a.growthScore, potentialScore: a.potentialScore, liquidity: a.liquidity, recommendation: a.recommendation },
    });
  }
  const invested = total - left;
  for (const h of holdings) h.sharePercent = Math.round((h.price / Math.max(invested, 1)) * 100);
  const yearlyRent = holdings.reduce((n, h) => n + (h.indicativeMonthlyRent || 0) * 12, 0);
  return {
    budget: total, risk: r, invested, unallocated: left, holdings,
    indicativeYieldPercent: invested ? Math.round((yearlyRent / invested) * 1000) / 10 : null,
    note: holdings.length ? `${holdings.length} holding${holdings.length === 1 ? '' : 's'} across ${new Set(holdings.map((h) => h.locality)).size} area(s). Rents and appreciation are indicative and not guaranteed.` : 'No live listing fits this budget in the better-scored areas yet.',
    disclaimer: (await areaIntel.settings()).disclaimer,
  };
}

module.exports = { suggest, RISK: Object.keys(RISK) };
