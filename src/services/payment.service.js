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

  return result.rows[0];
}

module.exports = {
  initiatePayment,
  handleWebhook,
  getPaymentById,
  getPaymentsByDeal,
  getMilestonesByDeal,
  createMilestone,
  updateMilestone,
};
