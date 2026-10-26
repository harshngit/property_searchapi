const pool = require('../../config/db');
const { FLOW } = require('../dealStages');

// Engine 6 - broker performance prediction: which brokers are likely to close
// more deals in the next N days. Rule-based (no AI cost):
//   expected closures = sum over the broker's open deals of
//     P(close | stage reached)    from the platform's own closed deals, smoothed
//     x broker factor             their win rate against the platform's (0.6 - 1.4)
//     x freshness                 a deal stuck far past its stage's usual time counts less
// Forecasts are stored per day (broker_forecasts) so they can later be checked
// against what actually closed - the data Phase 2 learns from.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const idx = (s) => FLOW.indexOf(s);

// Win chance by the furthest stage a deal reached, from the last year's closed deals.
async function stageOdds() {
  const rows = (await pool.query(
    `SELECT d.id, d.stage::text AS stage,
            (SELECT array_agg(DISTINCT e.to_stage) FROM orchestration_events e WHERE e.deal_id = d.id AND e.to_stage IS NOT NULL) AS reached
     FROM deals d WHERE d.stage IN ('closed_won', 'closed_lost') AND d.updated_at > now() - interval '365 days'`
  )).rows;
  const reach = FLOW.map(() => ({ closed: 0, won: 0 }));
  for (const r of rows) {
    const won = r.stage === 'closed_won';
    const furthest = won ? idx('closed_won') : Math.max(0, ...(r.reached || []).map(idx).filter((i) => i >= 0 && i < idx('closed_won')));
    for (let i = 0; i <= Math.min(furthest, FLOW.length - 2); i += 1) {
      reach[i].closed += 1;
      if (won) reach[i].won += 1;
    }
  }
  // Smoothed towards a prior that rises along the pipeline.
  const k = 5;
  return FLOW.map((s, i) => {
    const prior = Math.min(0.9, 0.1 + (0.8 * i) / (FLOW.length - 2));
    return (reach[i].won + k * prior) / (reach[i].closed + k);
  });
}

async function forecast(user, { horizonDays = 90, brokerId = null } = {}) {
  const staff = STAFF.includes(user.role);
  const only = staff ? brokerId : user.id;
  const odds = await stageOdds();
  const brokers = (await pool.query(
    `SELECT u.id, u.full_name,
            COUNT(d.id) FILTER (WHERE d.stage NOT IN ('closed_won', 'closed_lost'))::int AS open_deals,
            COUNT(d.id) FILTER (WHERE d.stage = 'closed_won' AND d.updated_at > now() - interval '365 days')::int AS won,
            COUNT(d.id) FILTER (WHERE d.stage = 'closed_lost' AND d.updated_at > now() - interval '365 days')::int AS lost
     FROM users u JOIN roles r ON r.id = u.role_id JOIN deals d ON d.broker_id = u.id
     WHERE r.name IN ('broker', 'agency_admin', 'internal_sales') AND u.status = 'active' ${only ? 'AND u.id = $1' : ''}
     GROUP BY u.id, u.full_name HAVING COUNT(d.id) FILTER (WHERE d.stage NOT IN ('closed_won', 'closed_lost')) > 0 OR COUNT(d.id) FILTER (WHERE d.stage = 'closed_won' AND d.updated_at > now() - interval '365 days') > 0`,
    only ? [only] : []
  )).rows;
  const platform = brokers.reduce((a, b) => ({ won: a.won + b.won, lost: a.lost + b.lost }), { won: 0, lost: 0 });
  const platformRate = (platform.won + 1) / (platform.won + platform.lost + 2);

  const out = [];
  for (const b of brokers) {
    const deals = (await pool.query(
      `SELECT d.stage::text AS stage, d.deal_value, COALESCE(d.stage_entered_at, d.updated_at, d.created_at) AS since FROM deals d
       WHERE d.broker_id = $1 AND d.stage NOT IN ('closed_won', 'closed_lost')`,
      [b.id]
    )).rows;
    const rate = (b.won + 1) / (b.won + b.lost + 2);
    const factor = Math.max(0.6, Math.min(1.4, rate / platformRate));
    let expected = 0;
    let value = 0;
    let stale = 0;
    for (const d of deals) {
      const i = Math.max(0, idx(d.stage));
      const days = (Date.now() - new Date(d.since).getTime()) / 86400000;
      const fresh = days > 60 ? 0.5 : days > 30 ? 0.75 : 1;
      if (days > 30) stale += 1;
      // Deals at early stages rarely close inside the horizon.
      const reachable = horizonDays >= 90 || i >= idx('negotiation') ? 1 : 0.5;
      const p = Math.min(0.95, odds[i] * factor * fresh * reachable);
      expected += p;
      value += p * (Number(d.deal_value) || 0);
    }
    const reasons = [`${b.open_deals} open deal${b.open_deals === 1 ? '' : 's'}`, `win rate ${Math.round(rate * 100)}% (platform ${Math.round(platformRate * 100)}%)`];
    if (stale) reasons.push(`${stale} deal${stale === 1 ? '' : 's'} with no stage change for 30+ days`);
    out.push({ brokerId: b.id, name: b.full_name, openDeals: b.open_deals, wonLastYear: b.won, winRatePercent: Math.round(rate * 100), expectedClosures: Math.round(expected * 10) / 10, expectedValue: Math.round(value), reasons });
  }
  out.sort((a, b) => b.expectedClosures - a.expectedClosures);
  // Bands relative to the field: top third / middle / needs support.
  out.forEach((o, i) => {
    o.band = out.length < 3 ? (o.expectedClosures >= 1 ? 'strong' : 'steady') : i < out.length / 3 ? 'strong' : i < (2 * out.length) / 3 ? 'steady' : 'needs_support';
  });
  for (const o of out) {
    await pool.query(
      `INSERT INTO broker_forecasts (broker_id, horizon_days, open_deals, expected_closures, expected_value, win_rate, band, reasons) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (broker_id, computed_on, horizon_days) DO UPDATE SET open_deals = EXCLUDED.open_deals, expected_closures = EXCLUDED.expected_closures, expected_value = EXCLUDED.expected_value,
         win_rate = EXCLUDED.win_rate, band = EXCLUDED.band, reasons = EXCLUDED.reasons`,
      [o.brokerId, horizonDays, o.openDeals, o.expectedClosures, o.expectedValue, o.winRatePercent, o.band, JSON.stringify(o.reasons)]
    );
  }
  return {
    horizonDays,
    stageOdds: FLOW.slice(0, -1).map((s, i) => ({ stage: s, closeChancePercent: Math.round(odds[i] * 100) })),
    brokers: out,
    note: 'A forecast from each broker\'s open pipeline, the platform\'s stage-to-close rates and their own win rate. Indicative only.',
  };
}

module.exports = { forecast, stageOdds };
