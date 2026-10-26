const pool = require('../../config/db');

// Engine 6 - buyer intent: which buyers are most likely to transact soon.
// Built on the platform's existing 0-100 lead score (Module 49, behaviour
// based) - not a second score. It adds what the score does not show: the
// momentum (activity in the last 7 days against the 3 weeks before), how
// recent the last activity is, and the steps that come right before a deal
// (active requirement, site visit, offer). Rule-based, no AI cost.
// Brokers see the buyers on their own leads; A R staff see everyone.

const STAFF = ['internal_sales', 'admin', 'super_admin'];

async function list(user, { limit = 50, minScore = 0 } = {}) {
  const staff = STAFF.includes(user.role);
  const max = Math.min(200, Number(limit) || 50);
  const params = [Number(minScore) || 0];
  let scope = '';
  if (!staff) {
    params.push(user.id, user.tenant_id || null);
    scope = `AND EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = c.id AND l.status NOT IN ('won', 'lost')
               AND (l.assigned_to = $2 OR l.created_by = $2 OR (l.tenant_id IS NOT NULL AND l.tenant_id = $3::uuid)))`;
  }
  const rows = (await pool.query(
    `SELECT c.id AS customer_id, c.full_name, ls.score, ls.category, ls.last_computed_at,
            (SELECT COUNT(*)::int FROM events e WHERE e.customer_id = c.id AND e.event_timestamp > now() - interval '7 days') AS events_7d,
            (SELECT COUNT(*)::int FROM events e WHERE e.customer_id = c.id AND e.event_timestamp <= now() - interval '7 days' AND e.event_timestamp > now() - interval '28 days') AS events_prev,
            (SELECT MAX(e.event_timestamp) FROM events e WHERE e.customer_id = c.id) AS last_event,
            (SELECT COUNT(*)::int FROM requirements r WHERE r.customer_id = c.id AND r.status = 'active') AS active_requirements,
            (SELECT COUNT(*)::int FROM events e WHERE e.customer_id = c.id AND e.event_type IN ('site_visit_requested', 'site_visit_completed') AND e.event_timestamp > now() - interval '60 days') AS site_visits,
            (SELECT COUNT(*)::int FROM events e WHERE e.customer_id = c.id AND e.event_type = 'offer_made' AND e.event_timestamp > now() - interval '60 days') AS offers,
            (SELECT l.id FROM leads l WHERE l.customer_id = c.id AND l.status NOT IN ('won', 'lost') ORDER BY l.created_at DESC LIMIT 1) AS lead_id
     FROM lead_scores ls JOIN customers c ON c.id = ls.customer_id
     WHERE ls.score >= $1 ${scope}
       AND EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = c.id AND l.status NOT IN ('won', 'lost'))
     ORDER BY ls.score DESC LIMIT 500`,
    params
  )).rows;

  const out = rows.map((r) => {
    const reasons = [`Lead score ${r.score} (${r.category})`];
    let intent = r.score * 0.6;
    // Momentum: more activity this week than the weekly average of the 3 weeks before.
    const prevWeekly = r.events_prev / 3;
    if (r.events_7d && r.events_7d > prevWeekly * 1.5) {
      intent += 12;
      reasons.push(`Activity picking up (${r.events_7d} actions this week)`);
    }
    const days = r.last_event ? (Date.now() - new Date(r.last_event).getTime()) / 86400000 : null;
    if (days !== null && days <= 3) {
      intent += 10;
      reasons.push('Active in the last 3 days');
    } else if (days !== null && days > 30) {
      intent -= 15;
      reasons.push(`Quiet for ${Math.round(days)} days`);
    }
    if (r.active_requirements) {
      intent += 6;
      reasons.push('Has an active requirement');
    }
    if (r.site_visits) {
      intent += 10;
      reasons.push('Site visit in the last 60 days');
    }
    if (r.offers) {
      intent += 12;
      reasons.push('Made an offer');
    }
    const score = Math.max(0, Math.min(100, Math.round(intent)));
    return {
      customerId: r.customer_id, name: r.full_name, leadId: r.lead_id, intentScore: score,
      band: score >= 70 ? 'likely' : score >= 45 ? 'possible' : 'unlikely',
      leadScore: r.score, leadCategory: r.category, lastActiveAt: r.last_event, reasons,
    };
  });
  out.sort((a, b) => b.intentScore - a.intentScore);
  return {
    items: out.slice(0, max),
    note: 'Likelihood to transact soon, from the lead score plus recent activity. Indicative - confirm with the buyer.',
  };
}

module.exports = { list };
