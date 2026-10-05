const pool = require('../config/db');
const configService = require('./config.service');

// Engine 6 market intelligence base data + Engine 5 RERA enrichment, fed
// by the reference-data crawlers (crawler_portal_market.js weekly,
// crawler_nhb_rbi.js monthly, crawler_rera.js weekly).
//   - benchmarks(): average price per sq ft for a city / locality across
//     the portals' aggregated market pages, the NHB / RBI index trend and
//     the platform's own circle rate - always with the freshness label.
//     Used for analytics only: never shown as a listing, never attributed
//     to a portal publicly (the public view carries no portal names).
//   - estimateValue(): price benchmark x area when a listing has no
//     staff-entered market value (opportunity scoring).
//   - reraCheck(): a listing's RERA number against the public registry.

const cache = new Map();
const TTL_MS = 10 * 60 * 1000;
function clearCache() {
  cache.clear();
}

async function disclaimer(frequency) {
  const tpl = await configService.getConfig('market.data_disclaimer', 'Data sourced from public portal listings and public indices. Updated {frequency}. For reference only - verify independently before transacting.');
  return String(tpl).replace('{frequency}', frequency);
}

const round = (n, d = 0) => (n === null || n === undefined ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);

async function benchmarks({ city, locality, propertyType, transactionType = 'sell' } = {}, { staff = false } = {}) {
  if (!city) return null;
  const key = JSON.stringify([city, locality, propertyType, transactionType, staff]).toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  // Latest capture per portal for the most specific area that has data.
  const stats = async (loc, type) =>
    (
      await pool.query(
        `SELECT DISTINCT ON (portal_key) portal_key, avg_price_per_sqft, min_price_per_sqft, max_price_per_sqft, price_change_percent,
                demand_index, supply_count, rental_yield_percent, captured_on
         FROM market_stats
         WHERE lower(city) = lower($1) AND lower(locality) = lower($2) AND transaction_type = $3 AND property_type = ANY($4::text[])
           AND captured_on > CURRENT_DATE - 120
         ORDER BY portal_key, (property_type = $5) DESC, captured_on DESC`,
        [city, loc || '', transactionType, type ? [String(type).toLowerCase(), 'all'] : ['all'], String(type || 'all').toLowerCase()]
      )
    ).rows;
  let scope = locality ? 'locality' : 'city';
  let rows = locality ? await stats(locality, propertyType) : [];
  if (!rows.length) {
    scope = 'city';
    rows = await stats('', propertyType);
  }
  const present = (col) => rows.filter((r) => r[col] !== null).map((r) => Number(r[col]));
  const mean = (col) => {
    const v = present(col);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  const index = (
    await pool.query(
      `SELECT index_source, index_kind, period, period_start, index_value, yoy_change_percent, qoq_change_percent
       FROM price_indices WHERE lower(city) = lower($1) ORDER BY period_start DESC NULLS LAST, captured_at DESC LIMIT 16`,
      [city]
    )
  ).rows;
  const latestBySource = [];
  for (const r of index) if (!latestBySource.find((x) => x.index_source === r.index_source && x.index_kind === r.index_kind)) latestBySource.push(r);

  const circle = (
    await pool.query(
      `SELECT cr.rate_per_sqft FROM circle_rates cr JOIN cities c ON c.id = cr.city_id LEFT JOIN localities l ON l.id = cr.locality_id
       WHERE lower(c.name) = lower($1) AND (cr.effective_until IS NULL OR cr.effective_until >= CURRENT_DATE)
         AND (cr.locality_id IS NULL OR lower(l.name) = lower($2))
       ORDER BY (cr.locality_id IS NOT NULL) DESC, cr.effective_from DESC LIMIT 1`,
      [city, locality || '']
    ).catch(() => ({ rows: [] }))
  ).rows[0];

  const avg = mean('avg_price_per_sqft');
  const value = {
    city,
    locality: scope === 'locality' ? locality : null,
    scope,
    transactionType,
    hasData: rows.length > 0 || latestBySource.length > 0,
    avgPricePerSqft: round(avg),
    minPricePerSqft: round(rows.length ? Math.min(...present('min_price_per_sqft').concat(present('avg_price_per_sqft'))) : null),
    maxPricePerSqft: round(rows.length ? Math.max(...present('max_price_per_sqft').concat(present('avg_price_per_sqft'))) : null),
    priceChangePercent: round(mean('price_change_percent'), 1),
    demandIndex: round(mean('demand_index'), 1),
    supplyCount: present('supply_count').length ? Math.round(present('supply_count').reduce((a, b) => a + b, 0)) : null,
    rentalYieldPercent: round(mean('rental_yield_percent'), 2),
    sources: rows.length,
    asOf: rows.length ? rows.map((r) => r.captured_on).sort().pop() : null,
    circleRatePerSqft: circle ? Number(circle.rate_per_sqft) : null,
    priceIndex: latestBySource.map((r) => ({
      source: r.index_source === 'nhb_residex' ? 'NHB Residex' : r.index_source === 'rbi_hpi' ? 'RBI House Price Index' : r.index_source,
      kind: r.index_kind, period: r.period, value: Number(r.index_value),
      yoyChangePercent: r.yoy_change_percent === null ? null : Number(r.yoy_change_percent),
      qoqChangePercent: r.qoq_change_percent === null ? null : Number(r.qoq_change_percent),
    })),
    indexHistory: index.filter((r) => r.index_source === latestBySource[0]?.index_source && r.index_kind === latestBySource[0]?.index_kind).map((r) => ({ period: r.period, value: Number(r.index_value) })).reverse(),
    disclaimer: await disclaimer('weekly (prices) and monthly (indices)'),
  };
  if (!Number.isFinite(value.minPricePerSqft)) value.minPricePerSqft = null;
  if (!Number.isFinite(value.maxPricePerSqft)) value.maxPricePerSqft = null;
  // Portal names are internal only (never attributed publicly).
  if (staff) value.portals = rows.map((r) => ({ portal: r.portal_key, avgPricePerSqft: r.avg_price_per_sqft === null ? null : Number(r.avg_price_per_sqft), capturedOn: r.captured_on }));
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Market value estimate for a listing without a staff-entered one.
async function estimateValue(property) {
  const area = Number(property.area_sqft) || Number(property.carpet_area_sqft);
  if (!area || !property.city) return null;
  const b = await benchmarks({ city: property.city, locality: property.locality, propertyType: property.property_type }).catch(() => null);
  if (!b?.avgPricePerSqft) return null;
  return { value: Math.round(b.avgPricePerSqft * area), perSqft: b.avgPricePerSqft, scope: b.scope, asOf: b.asOf, sources: b.sources };
}

const reraKey = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function reraLookup(number) {
  const key = reraKey(number);
  if (key.length < 4) return null;
  const r = (await pool.query('SELECT * FROM rera_projects WHERE rera_number_key = $1', [key])).rows[0];
  if (!r) return null;
  return {
    reraNumber: r.rera_number, state: r.state, projectName: r.project_name, promoterName: r.promoter_name, city: r.city, district: r.district,
    status: r.project_status, approvedUnits: r.approved_units, complaintsCount: r.complaints_count, registrationDate: r.registration_date,
    proposedCompletionDate: r.proposed_completion_date, lastSeenAt: r.last_seen_at, sourceUrl: r.source_url,
  };
}

// Due-diligence enrichment: { found, project, flags: [{ category, severity, detail }] }.
async function reraCheck(reraNumber) {
  if (!reraNumber) return { provided: false, found: false, flags: [] };
  const registryRows = (await pool.query('SELECT COUNT(*)::int AS n FROM rera_projects')).rows[0].n;
  const project = await reraLookup(reraNumber);
  if (!project) {
    // Only meaningful once the registry has been crawled.
    return { provided: true, found: false, registryLoaded: registryRows > 0, flags: registryRows > 0 ? [{ category: 'compliance', severity: 'medium', detail: `RERA number ${reraNumber} not found in the crawled public registry - verify on the state RERA portal`, source: 'rera_registry' }] : [] };
  }
  const flags = [];
  if (project.status === 'delayed') flags.push({ category: 'possession', severity: 'medium', detail: `RERA registry shows this project as delayed${project.proposedCompletionDate ? ` (completion was due ${new Date(project.proposedCompletionDate).toLocaleDateString('en-IN')})` : ''}`, source: 'rera_registry' });
  if (['lapsed', 'revoked'].includes(project.status)) flags.push({ category: 'compliance', severity: 'high', detail: `RERA registration is ${project.status}`, source: 'rera_registry' });
  if ((project.complaintsCount || 0) >= 5) flags.push({ category: 'compliance', severity: project.complaintsCount >= 20 ? 'high' : 'medium', detail: `${project.complaintsCount} complaints against this project on the RERA registry`, source: 'rera_registry' });
  return { provided: true, found: true, registryLoaded: true, project, flags };
}

async function searchRera({ q, state, status, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(project_name ILIKE $${params.length} OR promoter_name ILIKE $${params.length} OR rera_number ILIKE $${params.length} OR city ILIKE $${params.length})`);
  }
  if (state) {
    params.push(state);
    where.push(`lower(state) = lower($${params.length})`);
  }
  if (status) {
    params.push(status);
    where.push(`project_status = $${params.length}`);
  }
  params.push(Math.min(200, Number(limit) || 50));
  return (await pool.query(`SELECT * FROM rera_projects ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen_at DESC LIMIT $${params.length}`, params)).rows;
}

// Staff view of everything the reference crawlers hold.
async function overview() {
  const [counts, stats, indices, promoters] = await Promise.all([
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM rera_projects) AS rera_projects,
              (SELECT COUNT(*)::int FROM rera_projects WHERE project_status IN ('delayed', 'lapsed', 'revoked')) AS rera_flagged,
              (SELECT COUNT(*)::int FROM price_indices) AS price_indices,
              (SELECT COUNT(*)::int FROM market_stats) AS market_stats,
              (SELECT MAX(captured_on) FROM market_stats) AS market_as_of,
              (SELECT MAX(captured_at) FROM price_indices) AS indices_as_of,
              (SELECT MAX(last_seen_at) FROM rera_projects) AS rera_as_of`
    ),
    pool.query(
      `SELECT DISTINCT ON (portal_key, city, locality, property_type, transaction_type) portal_key, city, locality, property_type, transaction_type,
              avg_price_per_sqft, price_change_percent, demand_index, supply_count, rental_yield_percent, captured_on
       FROM market_stats ORDER BY portal_key, city, locality, property_type, transaction_type, captured_on DESC LIMIT 300`
    ),
    pool.query(
      `SELECT DISTINCT ON (index_source, index_kind, city) index_source, index_kind, city, period, index_value, yoy_change_percent, qoq_change_percent
       FROM price_indices ORDER BY index_source, index_kind, city, period_start DESC NULLS LAST, captured_at DESC LIMIT 300`
    ),
    pool.query(
      `SELECT promoter_name, COUNT(*)::int AS projects, COUNT(*) FILTER (WHERE project_status = 'delayed')::int AS delayed,
              COALESCE(SUM(complaints_count), 0)::int AS complaints
       FROM rera_projects WHERE promoter_name IS NOT NULL GROUP BY promoter_name
       HAVING COUNT(*) FILTER (WHERE project_status = 'delayed') > 0 OR COALESCE(SUM(complaints_count), 0) > 0
       ORDER BY delayed DESC, complaints DESC LIMIT 25`
    ),
  ]);
  return { counts: counts.rows[0], marketStats: stats.rows, priceIndices: indices.rows, promotersToWatch: promoters.rows, disclaimer: await disclaimer('weekly (prices, RERA) and monthly (indices)') };
}

module.exports = { benchmarks, estimateValue, reraLookup, reraCheck, searchRera, overview, clearCache };
