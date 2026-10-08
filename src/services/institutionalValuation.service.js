const pool = require('../config/db');
const configService = require('./config.service');

// Module 15 - Institutional Valuation Intelligence. Everything here is
// indicative and built from the seller's self-reported figures plus
// admin-set parameters (app_config "institutional.*"):
//   - EBITDA-linked value   EBITDA x sector multiple, the multiple adjusted
//                           for the enrollment trend (growing / stable /
//                           declining)
//   - Asset-based value     land value + building replacement cost + brand
//                           value + regulatory approval value
//   - Replacement cost      what it would cost to build the same
//                           institution here from scratch
//   - Exit potential score  0-100: how easily the asset could be resold in
//                           that geography
//   - Benchmarking          asking price against comparable closed
//                           transactions (EV / EBITDA, value per student /
//                           bed / room, value per acre)
// Stored on the listing (institutional_listings.valuation) and refreshed
// whenever the listing or the comparables change.

const CR = 1e7;
const round = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

async function params() {
  const [multiples, trendAdj, buildCost, landDefault, brand, approvalValue, premium] = await Promise.all([
    configService.getConfig('institutional.sector_multiples', {}),
    configService.getConfig('institutional.enrollment_trend_adjustment', { growing: 10, stable: 0, declining: -15 }),
    configService.getConfig('institutional.replacement_cost_per_sqft', {}),
    configService.getConfig('institutional.default_land_rate_per_sqft', 2500),
    configService.getConfig('institutional.brand_value', { revenue_percent_per_decade: 8, max_revenue_percent: 40 }),
    configService.getConfig('institutional.approval_value_lakh', { valid: 50, pending: 10 }),
    configService.getConfig('institutional.setup_premium_percent', 15),
  ]);
  return { multiples, trendAdj, buildCost, landDefault: Number(landDefault) || 0, brand, approvalValue, premium: Number(premium) || 0 };
}

// growing / stable / declining from the year-by-year counts (average yearly change).
function enrollmentTrend(history, current) {
  const h = (history || []).filter((e) => e.count > 0).sort((a, b) => a.year - b.year);
  if (h.length < 2) return { trend: 'unknown', cagrPercent: null, years: h.length, series: h };
  const first = h[0];
  const last = h[h.length - 1];
  const span = Math.max(1, last.year - first.year);
  const cagr = (Math.pow(last.count / first.count, 1 / span) - 1) * 100;
  const trend = cagr >= 3 ? 'growing' : cagr <= -3 ? 'declining' : 'stable';
  return { trend, cagrPercent: round(cagr, 1), years: h.length, series: h, latest: last.count, current: current || null };
}

async function landRate(city, locality, fallback) {
  const r = (
    await pool
      .query(
        `SELECT cr.rate_per_sqft, (cr.locality_id IS NOT NULL) AS local FROM circle_rates cr JOIN cities c ON c.id = cr.city_id LEFT JOIN localities l ON l.id = cr.locality_id
         WHERE lower(c.name) = lower($1) AND (cr.effective_until IS NULL OR cr.effective_until >= CURRENT_DATE) AND (cr.locality_id IS NULL OR lower(l.name) = lower($2))
         ORDER BY (cr.locality_id IS NOT NULL) DESC, cr.effective_from DESC LIMIT 1`,
        [city || '', locality || '']
      )
      .catch(() => ({ rows: [] }))
  ).rows[0];
  if (r) return { rate: Number(r.rate_per_sqft), source: r.local ? 'Circle rate for the locality' : 'Circle rate for the city' };
  return { rate: fallback, source: 'Default land rate (no circle rate on file for this area)' };
}

// Unit the asset is priced per: students for education, beds / rooms otherwise.
function unitOf(l) {
  if (l.student_enrollment) return { count: Number(l.student_enrollment), label: 'student' };
  if (l.capacity_units) return { count: Number(l.capacity_units), label: (l.capacity_label || 'unit').replace(/s$/, '') };
  return null;
}

async function benchmark(l) {
  const comps = (
    await pool.query(
      `SELECT * FROM institutional_comparables WHERE asset_class = $1 ORDER BY (lower(city) = lower($2)) DESC NULLS LAST, deal_year DESC NULLS LAST LIMIT 40`,
      [l.asset_class, l.city || '']
    )
  ).rows;
  if (!comps.length) return { comparables: 0, sameCity: 0, note: 'No comparable transactions on file for this asset class yet.' };
  const unit = unitOf(l);
  const evEbitda = median(comps.filter((c) => Number(c.ebitda_cr) > 0).map((c) => Number(c.deal_value_cr) / Number(c.ebitda_cr)));
  const perUnit = median(comps.map((c) => (unit?.label === 'student' ? Number(c.enrollment) : Number(c.capacity_units))).map((n, i) => (n > 0 ? (Number(comps[i].deal_value_cr) * CR) / n : NaN)));
  const perAcre = median(comps.filter((c) => Number(c.area_acres) > 0).map((c) => Number(c.deal_value_cr) / Number(c.area_acres)));
  const asking = Number(l.asking_price_cr) || null;
  const implied = [];
  if (evEbitda && Number(l.ebitda_cr) > 0) implied.push({ basis: 'EV / EBITDA', multiple: round(evEbitda, 1), valueCr: round(evEbitda * Number(l.ebitda_cr)) });
  if (perUnit && unit) implied.push({ basis: `Value per ${unit.label}`, perUnit: Math.round(perUnit), valueCr: round((perUnit * unit.count) / CR) });
  if (perAcre && Number(l.campus_area_acres) > 0) implied.push({ basis: 'Value per acre', perAcreCr: round(perAcre), valueCr: round(perAcre * Number(l.campus_area_acres)) });
  const mid = median(implied.map((i) => i.valueCr));
  const diff = asking && mid ? round(((asking - mid) / mid) * 100, 1) : null;
  return {
    comparables: comps.length,
    sameCity: comps.filter((c) => c.city && l.city && c.city.toLowerCase() === l.city.toLowerCase()).length,
    medianEvEbitda: round(evEbitda, 1), medianValuePerUnit: perUnit ? Math.round(perUnit) : null, unitLabel: unit?.label || null, medianValuePerAcreCr: round(perAcre),
    implied, impliedValueCr: mid, askingVsComparablesPercent: diff,
    verdict: diff === null ? null : diff > 15 ? 'Asking price is above comparable transactions' : diff < -15 ? 'Asking price is below comparable transactions' : 'Asking price is in line with comparable transactions',
    recent: comps.slice(0, 6).map((c) => ({ city: c.city, year: c.deal_year, dealType: c.deal_type, dealValueCr: Number(c.deal_value_cr), enrollment: c.enrollment, capacityUnits: c.capacity_units, areaAcres: c.area_acres === null ? null : Number(c.area_acres), source: c.source })),
  };
}

// 0-100: how liquid a resale of this asset would be in its geography.
async function exitPotential(l, bench) {
  const factors = [];
  const add = (label, points, max) => factors.push({ label, points: Math.round(points), max });
  // Buyers on the platform qualified for this asset class / geography.
  const buyers = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM institutional_buyers
       WHERE status = 'qualified' AND (asset_classes = '[]'::jsonb OR asset_classes ? $1)
         AND (geographies = '[]'::jsonb OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(geographies) g WHERE lower(g) = lower($2) OR lower(g) IN ('india', 'pan india', 'any')))
         AND (budget_max_cr IS NULL OR $3::numeric IS NULL OR budget_max_cr >= $3::numeric * 0.7)`,
      [l.asset_class, l.city || '', l.asking_price_cr]
    )
  ).rows[0].n;
  add(`${buyers} qualified buyer(s) for this asset class and city`, Math.min(30, buyers * 10), 30);
  add(`${bench.comparables || 0} comparable transaction(s), ${bench.sameCity || 0} in the same city`, Math.min(20, (bench.comparables || 0) * 3 + (bench.sameCity || 0) * 4), 20);
  // City depth: live listings and closed deals of any kind in the city.
  const depth = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'approved')::int AS live FROM properties WHERE lower(city) = lower($1)`, [l.city || ''])).rows[0].live;
  add(`Market depth in ${l.city || 'the city'} (${depth} live listings)`, Math.min(15, Math.log10(depth + 1) * 6), 15);
  const approvals = l.approvals || [];
  const valid = approvals.filter((a) => a.status === 'valid').length;
  const bad = approvals.filter((a) => a.status === 'expired').length + (l.noc_status === 'expired' ? 1 : 0);
  add('Regulatory approvals in good standing', Math.max(0, Math.min(15, valid * 5 + (l.noc_status === 'valid' ? 5 : 0) - bad * 6)), 15);
  add({ owned: 'Land is owned outright', mixed: 'Mixed land ownership', trust_held: 'Land held by a trust', leased: 'Land is leased' }[l.land_ownership], { owned: 10, mixed: 6, trust_held: 4, leased: 2 }[l.land_ownership] ?? 5, 10);
  add({ full_sale: 'Full sale - clean exit', stake_sale: 'Stake sale', lease: 'Lease', jv: 'Joint venture', management_takeover: 'Management takeover' }[l.deal_type], { full_sale: 10, stake_sale: 6, lease: 5, jv: 4, management_takeover: 4 }[l.deal_type] ?? 5, 10);
  const score = Math.max(0, Math.min(100, factors.reduce((s, f) => s + f.points, 0)));
  return { score, band: score >= 70 ? 'high' : score >= 45 ? 'moderate' : 'low', factors };
}

async function compute(l) {
  const p = await params();
  const trend = enrollmentTrend(l.enrollment_history, l.student_enrollment);

  // --- EBITDA-linked
  const baseMultiple = Number(p.multiples[l.asset_class]) || null;
  const adj = trend.trend === 'unknown' ? 0 : Number(p.trendAdj[trend.trend]) || 0;
  const multiple = baseMultiple ? round(baseMultiple * (1 + adj / 100), 2) : null;
  const ebitda = Number(l.ebitda_cr) > 0 ? Number(l.ebitda_cr) : null;
  const ebitdaLinked = ebitda && multiple
    ? { valueCr: round(ebitda * multiple), ebitdaCr: ebitda, sectorMultiple: baseMultiple, trendAdjustmentPercent: adj, appliedMultiple: multiple }
    : { valueCr: null, note: ebitda ? 'No sector multiple configured for this asset class' : 'EBITDA not reported - earnings-based value not available' };

  // --- Asset-based
  const land = await landRate(l.city, l.locality, p.landDefault);
  const landSqft = Number(l.campus_area_sqft) || (Number(l.campus_area_acres) ? Number(l.campus_area_acres) * 43560 : 0);
  const landValue = landSqft ? (landSqft * land.rate) / CR : null;
  const costPerSqft = Number(p.buildCost[l.asset_class]) || 0;
  const builtUp = Number(l.built_up_area_sqft) || 0;
  const buildingValue = builtUp && costPerSqft ? (builtUp * costPerSqft) / CR : null;
  const age = l.year_established ? Math.max(0, new Date().getFullYear() - l.year_established) : null;
  const revenue = Number(l.annual_revenue_cr) > 0 ? Number(l.annual_revenue_cr) : null;
  const brandPct = age !== null ? Math.min(Number(p.brand.max_revenue_percent) || 40, (age / 10) * (Number(p.brand.revenue_percent_per_decade) || 8)) : 0;
  const brandValue = revenue && brandPct ? (revenue * brandPct) / 100 : null;
  const approvals = l.approvals || [];
  const approvalValue = approvals.reduce((s, a) => s + (Number(p.approvalValue[a.status]) || 0), 0) / 100; // lakh -> crore
  const parts = [landValue, buildingValue, brandValue, approvalValue || null].filter((x) => x !== null);
  const assetBased = {
    valueCr: parts.length && (landValue !== null || buildingValue !== null) ? round(parts.reduce((a, b) => a + b, 0)) : null,
    landValueCr: round(landValue), landRatePerSqft: land.rate, landRateSource: land.source, landAreaSqft: landSqft || null,
    buildingReplacementCr: round(buildingValue), buildCostPerSqft: costPerSqft || null, builtUpAreaSqft: builtUp || null,
    brandValueCr: round(brandValue), brandPercentOfRevenue: round(brandPct, 1), ageYears: age,
    approvalValueCr: round(approvalValue), approvalsCounted: approvals.length,
    note: landValue === null && buildingValue === null ? 'Campus area and built-up area are needed for an asset-based value' : buildingValue === null ? 'Built-up area not given - building value left out' : null,
  };

  // --- Replacement cost: land + building + setup premium (approvals, time, pre-operative cost)
  const replBase = (landValue || 0) + (buildingValue || 0);
  const replacement = replBase ? { valueCr: round(replBase * (1 + p.premium / 100)), landCr: round(landValue), buildingCr: round(buildingValue), setupPremiumPercent: p.premium } : { valueCr: null, note: 'Campus and built-up area are needed to estimate replacement cost' };

  const bench = await benchmark(l);
  const exit = await exitPotential(l, bench);

  const values = [ebitdaLinked.valueCr, assetBased.valueCr, bench.impliedValueCr].filter((v) => v > 0);
  const asking = Number(l.asking_price_cr) || null;
  const low = values.length ? Math.min(...values) : null;
  const high = values.length ? Math.max(...values) : null;
  return {
    askingPriceCr: asking,
    indicativeRange: low !== null ? { lowCr: round(low), highCr: round(high) } : null,
    askingPosition: asking && low !== null ? (asking > high * 1.1 ? 'above_range' : asking < low * 0.9 ? 'below_range' : 'within_range') : null,
    impliedEbitdaMultiple: asking && ebitda ? round(asking / ebitda, 1) : null,
    impliedRevenueMultiple: asking && revenue ? round(asking / revenue, 1) : null,
    ebitdaLinked, assetBased, replacementCost: replacement, enrollmentTrend: trend, exitPotential: exit, benchmarking: bench,
    basis: 'Self-reported figures and platform parameters. Indicative only - not a certified valuation.',
    computedAt: new Date().toISOString(),
  };
}

async function refresh(propertyId) {
  const l = (await pool.query(`SELECT il.*, p.city, p.locality FROM institutional_listings il JOIN properties p ON p.id = il.property_id WHERE il.property_id = $1`, [propertyId])).rows[0];
  if (!l) return null;
  const v = await compute(l);
  await pool.query('UPDATE institutional_listings SET valuation = $1, valuation_at = now() WHERE property_id = $2', [JSON.stringify(v), propertyId]);
  return v;
}

// Comparables changed -> every listing of that asset class is re-benchmarked.
async function refreshClass(assetClass) {
  const r = await pool.query('SELECT property_id FROM institutional_listings WHERE asset_class = $1', [assetClass]);
  for (const x of r.rows) await refresh(x.property_id).catch(() => {});
  return { refreshed: r.rows.length };
}

module.exports = { compute, refresh, refreshClass, enrollmentTrend };
