const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');

function notFound(message = 'Payment not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Payments/milestones aren't broker-owned (no broker_id/created_by column),
// so the only access boundary is tenant membership - fetches the parent
// deal's tenant_id directly rather than going through deal.service.js (no
// need for its nested siteVisits/stageHistory just to check tenant access).
async function assertDealTenantAccess(dealId, user) {
  const result = await pool.query('SELECT tenant_id FROM deals WHERE id = $1', [dealId]);
  if (result.rows.length === 0) throw notFound('Deal not found');

  if (!isAdmin(user.role) && result.rows[0].tenant_id !== user.tenant_id) {
    const err = new Error('You do not have permission to access this deal');
    err.statusCode = 403;
    throw err;
  }

  return result.rows[0];
}

// No gateway here, by contract: A R Buildwel never holds customer funds and
// buyer-to-seller payments stay off-platform. Deal milestones are recorded by
// hand (updateMilestone); this table keeps any earlier rows as read-only history.

async function getPaymentById(id, user) {
  const result = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  const payment = result.rows[0];
  if (!payment) throw notFound();

  if (!isAdmin(user.role) && payment.tenant_id !== user.tenant_id) {
    throw notFound();
  }

  return payment;
}

async function getPaymentsByDeal(dealId, user) {
  await assertDealTenantAccess(dealId, user);

  const result = await pool.query(
    'SELECT * FROM payments WHERE deal_id = $1 ORDER BY created_at DESC',
    [dealId]
  );
  return result.rows;
}

async function getMilestonesByDeal(dealId, user) {
  await assertDealTenantAccess(dealId, user);

  const result = await pool.query(
    'SELECT * FROM payment_milestones WHERE deal_id = $1 ORDER BY due_date ASC',
    [dealId]
  );
  return result.rows;
}

async function createMilestone(data, user) {
  const { dealId, milestoneName, dueAmount, dueDate } = data;

  await assertDealTenantAccess(dealId, user);

  const result = await pool.query(
    `INSERT INTO payment_milestones (tenant_id, deal_id, milestone_name, due_amount, due_date, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [user.tenant_id || null, dealId, milestoneName, dueAmount, dueDate]
  );
  return result.rows[0];
}

const UPDATABLE_MILESTONE_FIELDS = {
  milestoneName: 'milestone_name',
  dueAmount: 'due_amount',
  dueDate: 'due_date',
  status: 'status',
};

async function updateMilestone(id, data, user) {
  const existing = await pool.query('SELECT * FROM payment_milestones WHERE id = $1', [id]);
  if (existing.rows.length === 0) throw notFound('Milestone not found');

  if (!isAdmin(user.role) && existing.rows[0].tenant_id !== user.tenant_id) {
    const err = new Error('You do not have permission to update this milestone');
    err.statusCode = 403;
    throw err;
  }

  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_MILESTONE_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE payment_milestones SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (result.rows[0]) require('./orchestration.service').safeEvaluate(result.rows[0].deal_id);
  return result.rows[0];
}

// GET /api/payments - every payment across the caller's visible deals, for
// the CRM Payments screen (tenant-scoped for non-admins, like every other
// payment read). Joins the human-readable context the table needs.
async function listPayments(user, filters, page, limit) {
  const where = [];
  const params = [];

  if (!isAdmin(user.role)) {
    params.push(user.tenant_id || null);
    where.push(`p.tenant_id = $${params.length}`);
  }
  for (const [key, column] of [['status', 'p.status'], ['gateway', 'p.gateway'], ['dealId', 'p.deal_id'], ['customerId', 'p.customer_id']]) {
    if (filters[key]) {
      params.push(filters[key]);
      where.push(`${column} = $${params.length}`);
    }
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`p.created_at >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`p.created_at <= $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    where.push(`(c.full_name ILIKE $${params.length} OR p.gateway_order_id ILIKE $${params.length} OR p.gateway_payment_id ILIKE $${params.length})`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM payments p
    JOIN customers c ON c.id = p.customer_id
    JOIN deals d ON d.id = p.deal_id
    LEFT JOIN payment_milestones m ON m.id = p.milestone_id
    LEFT JOIN properties pr ON pr.id = d.property_id
    LEFT JOIN users initiator ON initiator.id = p.initiated_by`;

  const countResult = await pool.query(`SELECT COUNT(*) ${from} ${whereClause}`, params);
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT p.*, c.full_name AS customer_name, m.milestone_name, d.stage AS deal_stage,
            pr.title AS property_title, initiator.full_name AS initiated_by_name
     ${from} ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows,
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

// GET /api/payments/stats - headline numbers for the Payments screen.
async function getPaymentStats(user, { from, to } = {}) {
  const where = [];
  const params = [];
  if (!isAdmin(user.role)) {
    params.push(user.tenant_id || null);
    where.push(`tenant_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at <= $${params.length}`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [payments, milestones] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_payments,
              COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0) AS collected_amount,
              COUNT(*) FILTER (WHERE status = 'success')::int AS successful,
              COUNT(*) FILTER (WHERE status = 'initiated')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'refunded')::int AS refunded
       FROM payments ${whereClause}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_milestones,
              COUNT(*) FILTER (WHERE status = 'overdue' OR (status = 'pending' AND due_date < now()))::int AS overdue_milestones,
              COALESCE(SUM(due_amount) FILTER (WHERE status IN ('pending', 'overdue')), 0) AS outstanding_amount
       FROM payment_milestones ${whereClause}`,
      params
    ),
  ]);

  return { ...payments.rows[0], ...milestones.rows[0] };
}

module.exports = {
  listPayments,
  getPaymentStats,
  getPaymentById,
  getPaymentsByDeal,
  getMilestonesByDeal,
  createMilestone,
  updateMilestone,
};
