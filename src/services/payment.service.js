const crypto = require('crypto');
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

// POST /api/payments/initiate
// Creates a `payments` row (status='initiated') and returns a stubbed
// gateway order payload. No live gateway call is made here.
async function initiatePayment(data, user) {
  const { dealId, milestoneId, customerId, amount, currency, gateway } = data;

  await assertDealTenantAccess(dealId, user);

  // TODO: replace this stub with a real gateway order-creation call, e.g.:
  //   Razorpay: const order = await razorpayInstance.orders.create({ amount: amount * 100, currency, receipt: ... });
  //   PayU:     const order = await payuClient.createTransaction({ amount, productinfo: ..., ... });
  // and store order.id below instead of the mocked value.
  const gatewayOrderId = `stub_order_${crypto.randomBytes(10).toString('hex')}`;

  const result = await pool.query(
    `INSERT INTO payments (
       tenant_id, deal_id, milestone_id, customer_id, amount, currency,
       gateway, gateway_order_id, status, initiated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'initiated', $9)
     RETURNING *`,
    [
      user.tenant_id || null,
      dealId,
      milestoneId || null,
      customerId,
      amount,
      currency || 'INR',
      gateway || 'manual',
      gatewayOrderId,
      user.id,
    ]
  );
  const payment = result.rows[0];

  // Stubbed gateway order details - shape mirrors what a real Razorpay/PayU
  // order-creation response would give the frontend to open its checkout.
  return {
    payment,
    gatewayOrder: {
      gateway: payment.gateway,
      orderId: payment.gateway_order_id,
      amount: payment.amount,
      currency: payment.currency,
      keyId: 'stub_key_id', // TODO: real publishable/merchant key from env config
    },
  };
}

// POST /api/payments/webhook (public)
// Updates payments.status and cascades to payment_milestones.status inside
// a single transaction, so the two can never drift out of sync.
async function handleWebhook(payload) {
  const { gatewayOrderId, gatewayPaymentId, gatewaySignature, status } = payload;

  // TODO: replace this stub with real signature verification, e.g.:
  //   Razorpay: crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(orderId + '|' + paymentId).digest('hex') === gatewaySignature
  //   PayU:     verify the posted hash against the PayU merchant salt
  // For now we just require a signature to be present at all.
  if (!gatewaySignature) {
    const err = new Error('Missing gateway signature');
    err.statusCode = 400;
    throw err;
  }

  if (!['success', 'failed', 'refunded'].includes(status)) {
    throw badRequest('status must be one of: success, failed, refunded');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT * FROM payments WHERE gateway_order_id = $1 FOR UPDATE',
      [gatewayOrderId]
    );
    if (current.rows.length === 0) throw notFound('Payment not found for this gateway order id');
    const payment = current.rows[0];

    const updated = await client.query(
      `UPDATE payments
       SET status = $1, gateway_payment_id = $2, gateway_signature = $3
       WHERE id = $4 RETURNING *`,
      [status, gatewayPaymentId || null, gatewaySignature, payment.id]
    );

    if (status === 'success' && payment.milestone_id) {
      await client.query(
        `UPDATE payment_milestones SET status = 'paid' WHERE id = $1`,
        [payment.milestone_id]
      );
    }

    await client.query('COMMIT');
    if (status === 'success') require('./orchestration.service').safeEvaluate(payment.deal_id);
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

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
  initiatePayment,
  handleWebhook,
  getPaymentById,
  getPaymentsByDeal,
  getMilestonesByDeal,
  createMilestone,
  updateMilestone,
};
