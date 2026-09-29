const pool = require('../config/db');
const configService = require('./config.service');
const portalService = require('./portal.service');
const { formatInr } = require('../utils/price');
const { forbidden } = require('../utils/httpError');

// Sec. 13.2 / 13.2A Full CRM workspace for customers - HNI investors from
// joining, NRIs and every other customer once they reach the usage
// threshold. It is the investor's own private workspace inside the CRM:
// deal pipeline (Kanban) with SLA tracking per stage, activity log, deal
// flow with investment / match scores, saved searches, portfolio and
// analytics. Everything is scoped to the caller; deal stages are moved by
// the A R Buildwel relationship manager (mandatory intermediation), so the
// pipeline is read-only for the investor.

const STAGES = ['lead', 'deal_interest', 'due_diligence', 'negotiation', 'closure', 'dropped'];
const DEFAULT_SLA = { lead: 2, deal_interest: 5, due_diligence: 14, negotiation: 10 };

async function getAccess(user) {
  if (user.role !== 'customer') {
    return { eligible: false, reason: 'The investor workspace is for customer accounts - staff and brokers use the main CRM.', tier: null, investor: null };
  }
  const customer = await portalService.resolveCustomer(user);
  const { tier, investor } = await portalService.getCrmTier(user, customer);
  const eligible = tier.current === 'full';
  return {
    eligible,
    reason: eligible
      ? null
      : `Your Full CRM workspace unlocks after ${tier.dealThreshold} completed deals or ${tier.referralThreshold} people joining with your referral code.`,
    tier,
    investor: investor
      ? { id: investor.id, isNri: investor.is_nri, isHni: investor.is_hni, verificationStatus: investor.verification_status, managerName: investor.manager_name }
      : null,
  };
}

async function requireWorkspace(user) {
  const access = await getAccess(user);
  if (!access.eligible) throw forbidden(access.reason);
  return access;
}

function slaStatus(stage, days, sla) {
  const limit = sla[stage];
  if (limit == null || ['closure', 'dropped'].includes(stage)) return { limitDays: null, status: 'none' };
  if (days > limit) return { limitDays: limit, status: 'overdue' };
  if (days >= limit * 0.75) return { limitDays: limit, status: 'due_soon' };
  return { limitDays: limit, status: 'on_track' };
}

// Kanban: every deal the investor has expressed interest in, by stage.
async function getPipeline(user) {
  await requireWorkspace(user);
  const sla = { ...DEFAULT_SLA, ...((await configService.getConfig('workspace.stage_sla_days', DEFAULT_SLA)) || {}) };
  const result = await pool.query(
    `SELECT oi.id, oi.stage, oi.intended_bid_amount, oi.financing_needed, oi.dropped_reason, oi.created_at, oi.updated_at,
            p.id AS property_id, p.title, p.city, p.locality, p.listing_category, p.investment_score, p.discount_percent,
            p.auction_date, COALESCE(p.reserve_price, p.price_value) AS ticket,
            rm.full_name AS manager_name,
            COALESCE((SELECT MAX(h.created_at) FROM opportunity_interest_history h WHERE h.interest_id = oi.id), oi.created_at) AS stage_since
     FROM opportunity_interests oi
     JOIN properties p ON p.id = oi.property_id
     LEFT JOIN users rm ON rm.id = oi.assigned_to
     WHERE oi.user_id = $1
     ORDER BY oi.updated_at DESC`,
    [user.id]
  );
  const history = await pool.query(
    `SELECT h.interest_id, h.from_stage, h.to_stage, h.notes, h.created_at
     FROM opportunity_interest_history h JOIN opportunity_interests oi ON oi.id = h.interest_id
     WHERE oi.user_id = $1 ORDER BY h.created_at ASC`,
    [user.id]
  );
  const byInterest = {};
  for (const h of history.rows) (byInterest[h.interest_id] ||= []).push(h);
  const now = Date.now();
  const items = result.rows.map((row) => {
    const days = Math.floor((now - new Date(row.stage_since).getTime()) / 86400000);
    return {
      ...row,
      ticket_display: formatInr(row.ticket),
      days_in_stage: days,
      sla: slaStatus(row.stage, days, sla),
      history: byInterest[row.id] || [],
    };
  });
  const columns = STAGES.map((stage) => ({ stage, items: items.filter((i) => i.stage === stage) }));
  return { columns, sla, total: items.length, overdue: items.filter((i) => i.sla.status === 'overdue').length };
}

// Activity log: stage changes, deal actions, deal-room events and alerts.
async function getActivity(user, { limit = 100 } = {}) {
  await requireWorkspace(user);
  const n = Math.min(Number(limit) || 100, 300);
  const result = await pool.query(
    `SELECT * FROM (
       SELECT 'stage_change' AS kind, h.created_at AS at, p.id AS property_id, p.title,
              COALESCE(h.from_stage::text, '') || '>' || h.to_stage::text AS detail, h.notes
       FROM opportunity_interest_history h
       JOIN opportunity_interests oi ON oi.id = h.interest_id
       JOIN properties p ON p.id = oi.property_id
       WHERE oi.user_id = $1
       UNION ALL
       SELECT 'deal_action', i.created_at, p.id, p.title, i.action::text, NULL
       FROM investor_deal_interactions i JOIN properties p ON p.id = i.property_id
       WHERE i.user_id = $1
       UNION ALL
       SELECT 'deal_room', l.created_at, p.id, p.title, l.action::text, NULL
       FROM deal_room_access_log l JOIN properties p ON p.id = l.property_id
       WHERE l.user_id = $1
       UNION ALL
       SELECT 'alert', COALESCE(a.sent_at, a.created_at), p.id, p.title, a.status::text || CASE WHEN a.is_priority THEN ':priority' ELSE '' END, a.reason
       FROM opportunity_alert_log a JOIN properties p ON p.id = a.property_id
       WHERE a.user_id = $1 AND a.status = 'sent'
     ) t
     ORDER BY at DESC
     LIMIT $2`,
    [user.id, n]
  );
  return result.rows;
}

// Analytics for the overview page.
async function getSummary(user) {
  const access = await requireWorkspace(user);
  const [pipeline, engagement, alerts, rooms, saved, portfolio, nri] = await Promise.all([
    pool.query(
      `SELECT stage, COUNT(*)::int AS n, COALESCE(SUM(COALESCE(oi.intended_bid_amount, p.reserve_price, p.price_value)), 0) AS value
       FROM opportunity_interests oi JOIN properties p ON p.id = oi.property_id
       WHERE oi.user_id = $1 GROUP BY stage`,
      [user.id]
    ),
    pool.query(
      `SELECT action, COUNT(*)::int AS n FROM investor_deal_interactions
       WHERE user_id = $1 AND created_at > now() - interval '30 days' GROUP BY action`,
      [user.id]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'sent' AND is_priority)::int AS priority
       FROM opportunity_alert_log WHERE user_id = $1 AND created_at > now() - interval '30 days'`,
      [user.id]
    ),
    pool.query(`SELECT status, COUNT(*)::int AS n FROM deal_room_access WHERE user_id = $1 GROUP BY status`, [user.id]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM saved_searches s JOIN customers c ON c.id = s.customer_id WHERE c.user_id = $1`,
      [user.id]
    ),
    access.investor?.isHni
      ? require('./hni.service').getPortfolioSummary(user).catch(() => null)
      : Promise.resolve(null),
    access.investor?.isNri
      ? pool.query(
          `SELECT (SELECT COUNT(*)::int FROM nri_properties np WHERE np.investor_profile_id = $1) AS properties,
                  (SELECT COUNT(*)::int FROM nri_service_requests r WHERE r.investor_profile_id = $1 AND r.status NOT IN ('completed', 'cancelled')) AS open_requests`,
          [access.investor.id]
        ).then((r) => r.rows[0]).catch(() => null)
      : Promise.resolve(null),
  ]);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0 }]));
  for (const r of pipeline.rows) byStage[r.stage] = { count: r.n, value: Number(r.value) };
  const total = Object.values(byStage).reduce((s, v) => s + v.count, 0);
  const active = ['lead', 'deal_interest', 'due_diligence', 'negotiation'].reduce((s, k) => s + byStage[k].count, 0);
  const activeValue = ['lead', 'deal_interest', 'due_diligence', 'negotiation'].reduce((s, k) => s + byStage[k].value, 0);
  return {
    access,
    pipeline: {
      byStage,
      total,
      active,
      activeValue,
      activeValueDisplay: formatInr(activeValue) || '₹0',
      closed: byStage.closure.count,
      conversionPercent: total ? Math.round((byStage.closure.count / total) * 100) : 0,
    },
    engagement30d: Object.fromEntries(engagement.rows.map((r) => [r.action, r.n])),
    alerts30d: alerts.rows[0],
    dealRooms: Object.fromEntries(rooms.rows.map((r) => [r.status, r.n])),
    savedSearches: saved.rows[0].n,
    portfolio,
    nri,
  };
}

module.exports = { getAccess, getPipeline, getActivity, getSummary, STAGES };
