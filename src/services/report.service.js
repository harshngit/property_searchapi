const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');

// Every report below takes (user, { from, to }) and applies the same two
// rules: admin/super_admin see cross-tenant data, everyone else is scoped
// to their own tenant_id; from/to (ISO date-times, both optional) filter
// whichever "when did this happen" column is most meaningful per query.
function tenantClause(user, alias, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null);
  where.push(`${alias}tenant_id = $${params.length}`);
}

function dateRangeClause(column, from, to, where, params) {
  if (from) {
    params.push(from);
    where.push(`${column} >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`${column} <= $${params.length}`);
  }
}

async function getLeadsReport(user, { from, to } = {}) {
  const where = [];
  const params = [];
  tenantClause(user, '', where, params);
  dateRangeClause('created_at', from, to, where, params);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [byStatus, bySource, byAssignedUser] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) AS count FROM leads ${whereClause} GROUP BY status`, params),
    pool.query(`SELECT source, COUNT(*) AS count FROM leads ${whereClause} GROUP BY source`, params),
    pool.query(
      `SELECT assigned_to, COUNT(*) AS count FROM leads ${whereClause} GROUP BY assigned_to`,
      params
    ),
  ]);

  const toCountMap = (rows, key) => {
    const map = {};
    for (const row of rows) map[row[key] ?? 'unassigned'] = Number(row.count);
    return map;
  };

  return {
    byStatus: toCountMap(byStatus.rows, 'status'),
    bySource: toCountMap(bySource.rows, 'source'),
    byAssignedUser: toCountMap(byAssignedUser.rows, 'assigned_to'),
  };
}

async function getPropertiesReport(user, { from, to } = {}) {
  const where = [];
  const params = [];
  tenantClause(user, '', where, params);
  dateRangeClause('created_at', from, to, where, params);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const inquiriesWhere = ['property_id IS NOT NULL'];
  const inquiriesParams = [];
  tenantClause(user, '', inquiriesWhere, inquiriesParams);
  dateRangeClause('created_at', from, to, inquiriesWhere, inquiriesParams);

  const [byStatus, byType, byTransactionType, inquiriesPerListing] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) AS count FROM properties ${whereClause} GROUP BY status`, params),
    pool.query(
      `SELECT property_type, COUNT(*) AS count FROM properties ${whereClause} GROUP BY property_type`,
      params
    ),
    pool.query(
      `SELECT transaction_type, COUNT(*) AS count FROM properties ${whereClause} GROUP BY transaction_type`,
      params
    ),
    pool.query(
      `SELECT property_id, COUNT(*) AS inquiries FROM leads
       WHERE ${inquiriesWhere.join(' AND ')}
       GROUP BY property_id ORDER BY inquiries DESC LIMIT 20`,
      inquiriesParams
    ),
  ]);

  const toCountMap = (rows, key) => {
    const map = {};
    for (const row of rows) map[row[key]] = Number(row.count);
    return map;
  };

  return {
    byStatus: toCountMap(byStatus.rows, 'status'),
    byType: toCountMap(byType.rows, 'property_type'),
    byTransactionType: toCountMap(byTransactionType.rows, 'transaction_type'),
    inquiriesPerListing: inquiriesPerListing.rows.map((r) => ({
      propertyId: r.property_id,
      inquiries: Number(r.inquiries),
    })),
  };
}

async function getBrokersReport(user, { from, to } = {}, forcedBrokerId) {
  const leadsWhere = ['assigned_to IS NOT NULL'];
  const leadsParams = [];
  tenantClause(user, '', leadsWhere, leadsParams);
  dateRangeClause('created_at', from, to, leadsWhere, leadsParams);
  if (forcedBrokerId) {
    leadsParams.push(forcedBrokerId);
    leadsWhere.push(`assigned_to = $${leadsParams.length}`);
  }

  const tasksWhere = ['assigned_to IS NOT NULL'];
  const tasksParams = [];
  tenantClause(user, '', tasksWhere, tasksParams);
  dateRangeClause('created_at', from, to, tasksWhere, tasksParams);
  if (forcedBrokerId) {
    tasksParams.push(forcedBrokerId);
    tasksWhere.push(`assigned_to = $${tasksParams.length}`);
  }

  const [leadStats, taskStats] = await Promise.all([
    pool.query(
      `SELECT assigned_to,
              COUNT(*) AS assigned,
              COUNT(*) FILTER (WHERE status = 'won') AS converted
       FROM leads WHERE ${leadsWhere.join(' AND ')} GROUP BY assigned_to`,
      leadsParams
    ),
    pool.query(
      `SELECT assigned_to,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE status = 'overdue') AS overdue
       FROM tasks WHERE ${tasksWhere.join(' AND ')} GROUP BY assigned_to`,
      tasksParams
    ),
  ]);

  const byBroker = new Map();
  const getEntry = (brokerId) => {
    if (!byBroker.has(brokerId)) {
      byBroker.set(brokerId, {
        brokerId,
        leadsAssigned: 0,
        leadsConverted: 0,
        tasksCompleted: 0,
        tasksOverdue: 0,
      });
    }
    return byBroker.get(brokerId);
  };

  for (const row of leadStats.rows) {
    const entry = getEntry(row.assigned_to);
    entry.leadsAssigned = Number(row.assigned);
    entry.leadsConverted = Number(row.converted);
  }
  for (const row of taskStats.rows) {
    const entry = getEntry(row.assigned_to);
    entry.tasksCompleted = Number(row.completed);
    entry.tasksOverdue = Number(row.overdue);
  }

  return Array.from(byBroker.values());
}

const FUNNEL_STAGES = ['site_visit', 'negotiation', 'booking', 'closed_won'];

async function getConversionFunnel(user, { from, to } = {}) {
  const leadsWhere = [];
  const leadsParams = [];
  tenantClause(user, '', leadsWhere, leadsParams);
  dateRangeClause('created_at', from, to, leadsWhere, leadsParams);
  const leadsWhereClause = leadsWhere.length ? `WHERE ${leadsWhere.join(' AND ')}` : '';

  const leadsCountResult = await pool.query(`SELECT COUNT(*) FROM leads ${leadsWhereClause}`, leadsParams);
  const leadsCount = Number(leadsCountResult.rows[0].count);

  const stageCounts = { leads: leadsCount };
  for (const stage of FUNNEL_STAGES) {
    const where = ['dsh.to_stage = $1'];
    const params = [stage];
    tenantClause(user, 'd.', where, params);
    dateRangeClause('dsh.created_at', from, to, where, params);

    const result = await pool.query(
      `SELECT COUNT(DISTINCT dsh.deal_id) FROM deal_stage_history dsh
       JOIN deals d ON d.id = dsh.deal_id
       WHERE ${where.join(' AND ')}`,
      params
    );
    stageCounts[stage] = Number(result.rows[0].count);
  }

  const stageOrder = ['leads', ...FUNNEL_STAGES];
  const funnel = stageOrder.map((stage, index) => {
    const count = stageCounts[stage];
    const previousCount = index > 0 ? stageCounts[stageOrder[index - 1]] : null;
    const dropOffPercent =
      previousCount && previousCount > 0
        ? Number((((previousCount - count) / previousCount) * 100).toFixed(2))
        : null;
    return { stage, count, dropOffPercent };
  });

  return { funnel };
}

async function getPaymentsReport(user, { from, to } = {}) {
  const paymentsWhere = [`status = 'success'`];
  const paymentsParams = [];
  tenantClause(user, '', paymentsWhere, paymentsParams);
  dateRangeClause('created_at', from, to, paymentsWhere, paymentsParams);

  const pendingWhere = [`status = 'pending'`];
  const pendingParams = [];
  tenantClause(user, '', pendingWhere, pendingParams);
  dateRangeClause('due_date', from, to, pendingWhere, pendingParams);

  const overdueWhere = [`status = 'overdue'`];
  const overdueParams = [];
  tenantClause(user, '', overdueWhere, overdueParams);
  dateRangeClause('due_date', from, to, overdueWhere, overdueParams);

  const [collected, pending, overdue] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE ${paymentsWhere.join(' AND ')}`, paymentsParams),
    pool.query(`SELECT COALESCE(SUM(due_amount), 0) AS total FROM payment_milestones WHERE ${pendingWhere.join(' AND ')}`, pendingParams),
    pool.query(`SELECT COALESCE(SUM(due_amount), 0) AS total FROM payment_milestones WHERE ${overdueWhere.join(' AND ')}`, overdueParams),
  ]);

  return {
    totalCollected: Number(collected.rows[0].total),
    totalPending: Number(pending.rows[0].total),
    totalOverdue: Number(overdue.rows[0].total),
  };
}

async function getRevenueReport(user, { from, to } = {}) {
  const dealsWhere = [`stage = 'closed_won'`];
  const dealsParams = [];
  tenantClause(user, '', dealsWhere, dealsParams);
  dateRangeClause('closed_at', from, to, dealsWhere, dealsParams);
  const dealsWhereClause = dealsWhere.join(' AND ');

  const commissionWhere = [];
  const commissionParams = [];
  tenantClause(user, '', commissionWhere, commissionParams);
  dateRangeClause('created_at', from, to, commissionWhere, commissionParams);
  const commissionWhereClause = commissionWhere.length ? `WHERE ${commissionWhere.join(' AND ')}` : '';

  const [totalDealValue, totalCommission, dealValueByBroker, commissionByBroker, dealValueByAgency] =
    await Promise.all([
      pool.query(`SELECT COALESCE(SUM(deal_value), 0) AS total FROM deals WHERE ${dealsWhereClause}`, dealsParams),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM commission_records ${commissionWhereClause}`, commissionParams),
      pool.query(
        `SELECT broker_id, COALESCE(SUM(deal_value), 0) AS total FROM deals WHERE ${dealsWhereClause} GROUP BY broker_id`,
        dealsParams
      ),
      pool.query(
        `SELECT broker_id, COALESCE(SUM(amount), 0) AS total FROM commission_records ${commissionWhereClause} GROUP BY broker_id`,
        commissionParams
      ),
      pool.query(
        `SELECT tenant_id, COALESCE(SUM(deal_value), 0) AS total FROM deals WHERE ${dealsWhereClause} GROUP BY tenant_id`,
        dealsParams
      ),
    ]);

  const toMap = (rows, key) => {
    const map = {};
    for (const row of rows) map[row[key] ?? 'unknown'] = Number(row.total);
    return map;
  };

  return {
    totalDealValueClosedWon: Number(totalDealValue.rows[0].total),
    totalCommission: Number(totalCommission.rows[0].total),
    dealValueByBroker: toMap(dealValueByBroker.rows, 'broker_id'),
    commissionByBroker: toMap(commissionByBroker.rows, 'broker_id'),
    dealValueByAgency: toMap(dealValueByAgency.rows, 'tenant_id'),
  };
}

const REPORT_GENERATORS = {
  leads: (user, filters) => getLeadsReport(user, filters),
  properties: (user, filters) => getPropertiesReport(user, filters),
  brokers: (user, filters, forcedBrokerId) => getBrokersReport(user, filters, forcedBrokerId),
  conversion: (user, filters) => getConversionFunnel(user, filters),
  payments: (user, filters) => getPaymentsReport(user, filters),
  revenue: (user, filters) => getRevenueReport(user, filters),
};

async function getReportData(reportType, user, filters, forcedBrokerId) {
  const generator = REPORT_GENERATORS[reportType];
  if (!generator) {
    const err = new Error(`Unknown report type '${reportType}'`);
    err.statusCode = 400;
    throw err;
  }
  return generator(user, filters, forcedBrokerId);
}

module.exports = {
  getLeadsReport,
  getPropertiesReport,
  getBrokersReport,
  getConversionFunnel,
  getPaymentsReport,
  getRevenueReport,
  getReportData,
  REPORT_GENERATORS,
};
