const pool = require('../config/db');

// Deal Intelligence Dashboard (Engine 5): conversion by city / locality /
// property type / broker, stage funnel with drop-off and average days per
// stage, demand trends (buyer requirements vs live supply per locality),
// deals at risk (health score) and recommended next actions. Brokers see
// their own deals; A R staff see everything (plus the broker league).

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const { FLOW, NEXT_ACTION } = require('./dealStages');

function scope(user, alias = 'd') {
  if (STAFF.includes(user.role)) return { sql: 'TRUE', params: [] };
  return { sql: `(${alias}.broker_id = $1 OR ${alias}.tenant_id = $2)`, params: [user.id, user.role === 'agency_admin' ? user.tenant_id : null] };
}

async function dashboard(user, { months = 6 } = {}) {
  const s = scope(user);
  const p = s.params;
  const n = p.length;
  const since = `now() - ($${n + 1}::int || ' months')::interval`;
  // Pass only as many params as the statement references ($1..$n).
  const q = (sql) => {
    const used = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    return pool.query(sql, [...p, months].slice(0, used)).then((r) => r.rows);
  };

  const conv = (groupExpr, join = '') =>
    q(`SELECT ${groupExpr} AS key,
              COUNT(*)::int AS deals,
              COUNT(*) FILTER (WHERE d.stage = 'closed_won')::int AS won,
              COUNT(*) FILTER (WHERE d.stage = 'closed_lost')::int AS lost,
              COALESCE(SUM(d.deal_value) FILTER (WHERE d.stage = 'closed_won'), 0)::float AS won_value
       FROM deals d LEFT JOIN properties p ON p.id = d.property_id ${join}
       WHERE ${s.sql} AND d.created_at >= ${since}
       GROUP BY 1 HAVING ${groupExpr} IS NOT NULL ORDER BY deals DESC LIMIT 15`);

  const [summary, byCity, byLocality, byType, byBroker, reached, stageDays, demand, supply, atRisk, hotUnsent] = await Promise.all([
    q(`SELECT COUNT(*) FILTER (WHERE d.stage NOT IN ('closed_won', 'closed_lost'))::int AS open,
              COALESCE(SUM(d.deal_value) FILTER (WHERE d.stage NOT IN ('closed_won', 'closed_lost')), 0)::float AS pipeline_value,
              COUNT(*) FILTER (WHERE d.stage = 'closed_won' AND d.closed_at >= ${since})::int AS won,
              COUNT(*) FILTER (WHERE d.stage = 'closed_lost' AND d.closed_at >= ${since})::int AS lost,
              COALESCE(SUM(d.deal_value) FILTER (WHERE d.stage = 'closed_won' AND d.closed_at >= ${since}), 0)::float AS won_value,
              AVG(EXTRACT(EPOCH FROM (d.closed_at - d.created_at)) / 86400) FILTER (WHERE d.stage = 'closed_won' AND d.closed_at >= ${since})::float AS avg_cycle_days,
              COUNT(*) FILTER (WHERE d.health_band = 'at_risk')::int AS at_risk,
              COUNT(*) FILTER (WHERE d.health_band = 'critical')::int AS critical
       FROM deals d WHERE ${s.sql}`),
    conv('p.city'),
    conv(`COALESCE(p.locality || ', ' || p.city, NULL)`),
    conv('p.property_type::text'),
    STAFF.includes(user.role) ? conv('b.full_name', 'LEFT JOIN users b ON b.id = d.broker_id') : Promise.resolve([]),
    // Funnel: how many deals ever reached each stage.
    q(`SELECT h.to_stage::text AS stage, COUNT(DISTINCT h.deal_id)::int AS n
       FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id
       WHERE ${s.sql} AND d.created_at >= ${since} GROUP BY 1
       UNION ALL
       SELECT 'inquiry', COUNT(*)::int FROM deals d WHERE ${s.sql} AND d.created_at >= ${since}`),
    // Average days spent in each stage (time between entering it and the next change).
    q(`WITH h AS (
         SELECT h.deal_id, h.to_stage::text AS stage, h.created_at,
                LEAD(h.created_at) OVER (PARTITION BY h.deal_id ORDER BY h.created_at) AS left_at
         FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id
         WHERE ${s.sql} AND d.created_at >= ${since} AND (h.from_stage IS NULL OR h.from_stage <> h.to_stage))
       SELECT stage, AVG(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - created_at)) / 86400)::float AS avg_days, COUNT(*)::int AS n
       FROM h GROUP BY stage`),
    // Demand: active buyer requirements per locality by month.
    pool.query(
      `SELECT COALESCE(loc, r.city) AS locality, r.city, to_char(date_trunc('month', r.created_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
       FROM requirements r LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(r.localities, '[]'::jsonb)) loc ON TRUE
       WHERE r.created_at >= now() - ($1::int || ' months')::interval
       GROUP BY 1, 2, 3`,
      [months]
    ).then((r) => r.rows),
    pool.query(`SELECT COALESCE(locality, city) AS locality, COUNT(*)::int AS n FROM properties WHERE status = 'approved' GROUP BY 1`).then((r) => r.rows),
    q(`SELECT d.id, d.stage, d.health_score, d.health_band, d.health_factors, d.deal_value::float, d.stage_entered_at,
              p.title AS property_title, c.full_name AS customer_name, b.full_name AS broker_name
       FROM deals d LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN users b ON b.id = d.broker_id
       WHERE ${s.sql} AND d.health_band IN ('at_risk', 'critical') AND d.stage NOT IN ('closed_won', 'closed_lost')
       ORDER BY d.health_score ASC NULLS LAST LIMIT 25`),
    // Hot / warm matches never sent to the buyer - the easiest wins.
    pool.query(
      `SELECT m.requirement_id, m.property_id, m.score, m.tier, p.title AS property_title, COALESCE(p.locality, p.city) AS locality
       FROM requirement_matches m JOIN properties p ON p.id = m.property_id JOIN requirements r ON r.id = m.requirement_id
       WHERE m.sent_at IS NULL AND m.tier IN ('hot', 'warm') AND r.status = 'active' AND p.status = 'approved'
         AND ($1::boolean OR p.created_by = $2 OR p.broker_id = $2)
       ORDER BY m.rank_score DESC LIMIT 10`,
      [STAFF.includes(user.role), user.id]
    ).then((r) => r.rows),
  ]);

  const rate = (row) => ({ ...row, conversion: row.won + row.lost ? Math.round((row.won / (row.won + row.lost)) * 1000) / 10 : null });

  const reachedMap = {};
  for (const r of reached) reachedMap[r.stage] = Math.max(reachedMap[r.stage] || 0, r.n);
  // A deal that reached a later stage also passed the earlier ones.
  const funnel = [];
  let carry = 0;
  for (let i = FLOW.length - 1; i >= 0; i -= 1) {
    carry = Math.max(carry, reachedMap[FLOW[i]] || 0);
    funnel.unshift({ stage: FLOW[i], reached: carry });
  }
  funnel.forEach((f, i) => {
    const prev = i ? funnel[i - 1].reached : null;
    f.dropOffPercent = prev ? Math.round(((prev - f.reached) / prev) * 1000) / 10 : null;
    const d = stageDays.find((x) => x.stage === f.stage);
    f.avgDays = d ? Math.round(d.avg_days * 10) / 10 : null;
  });
  const worst = funnel.filter((f) => f.dropOffPercent != null).sort((a, b) => b.dropOffPercent - a.dropOffPercent)[0];

  // Demand trends: per locality, monthly series + demand / supply ratio + growth.
  const monthsList = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    monthsList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const byLoc = new Map();
  for (const r of demand) {
    const k = r.locality;
    if (!k) continue;
    const e = byLoc.get(k) || { locality: k, city: r.city, series: Object.fromEntries(monthsList.map((m) => [m, 0])), total: 0 };
    if (e.series[r.month] != null) e.series[r.month] += r.n;
    e.total += r.n;
    byLoc.set(k, e);
  }
  const supplyMap = new Map(supply.map((s2) => [String(s2.locality).toLowerCase(), s2.n]));
  const half = Math.floor(months / 2);
  const trends = [...byLoc.values()]
    .map((e) => {
      const vals = monthsList.map((m) => e.series[m]);
      const early = vals.slice(0, half).reduce((a, b) => a + b, 0);
      const late = vals.slice(half).reduce((a, b) => a + b, 0);
      const listings = supplyMap.get(String(e.locality).toLowerCase()) || 0;
      return {
        locality: e.locality,
        city: e.city,
        months: monthsList,
        series: vals,
        requirements: e.total,
        listings,
        demandSupplyRatio: listings ? Math.round((e.total / listings) * 100) / 100 : null,
        growthPercent: early ? Math.round(((late - early) / early) * 1000) / 10 : late ? 100 : 0,
      };
    })
    .sort((a, b) => b.requirements - a.requirements)
    .slice(0, 15);

  // Recommendations.
  const recs = [];
  for (const d of atRisk.slice(0, 8)) {
    const idx = FLOW.indexOf(d.stage);
    const next = idx >= 0 ? FLOW[idx + 1] : null;
    const top = (d.health_factors || []).slice().sort((a, b) => a.points - b.points)[0];
    recs.push({
      kind: 'deal',
      dealId: d.id,
      priority: d.health_band === 'critical' ? 'high' : 'medium',
      text: `${d.property_title || 'Deal'}${d.customer_name ? ` (${d.customer_name})` : ''}: ${top ? `${top.label}. ` : ''}${next ? NEXT_ACTION[next] : 'Take it off hold or close it'}.`,
    });
  }
  for (const m of hotUnsent.slice(0, 5)) {
    recs.push({ kind: 'match', propertyId: m.property_id, requirementId: m.requirement_id, priority: m.tier === 'hot' ? 'high' : 'medium', text: `${m.tier === 'hot' ? 'Hot' : 'Warm'} ${m.score}% buyer match for ${m.property_title} not sent yet - send it.` });
  }
  for (const t of trends.filter((x) => x.demandSupplyRatio != null && x.demandSupplyRatio >= 2).slice(0, 3)) {
    recs.push({ kind: 'supply', priority: 'low', text: `${t.locality}: ${t.requirements} buyer requirements for ${t.listings} listing(s) - source more inventory here.` });
  }
  for (const t of trends.filter((x) => x.listings === 0 && x.requirements >= 3).slice(0, 2)) {
    recs.push({ kind: 'supply', priority: 'low', text: `${t.locality}: ${t.requirements} buyers looking and no live listings.` });
  }
  if (worst && worst.dropOffPercent >= 40) {
    recs.push({ kind: 'funnel', priority: 'medium', text: `Biggest drop-off is into ${worst.stage.replace('_', ' ')} (${worst.dropOffPercent}% lost) - review deals stuck just before it.` });
  }

  const sm = summary[0];
  return {
    scope: STAFF.includes(user.role) ? 'all' : 'mine',
    months,
    summary: { ...sm, conversion: sm.won + sm.lost ? Math.round((sm.won / (sm.won + sm.lost)) * 1000) / 10 : null, avg_cycle_days: sm.avg_cycle_days != null ? Math.round(sm.avg_cycle_days) : null },
    conversion: { byCity: byCity.map(rate), byLocality: byLocality.map(rate), byType: byType.map(rate), byBroker: byBroker.map(rate) },
    funnel,
    demandTrends: trends,
    atRisk,
    recommendations: recs,
  };
}

module.exports = { dashboard };
