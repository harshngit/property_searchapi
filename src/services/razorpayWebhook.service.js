const crypto = require('crypto');
const pool = require('../config/db');
const auditService = require('./audit.service');
const ai = require('./ai/orchestrator.service');
const advertising = require('./advertising.service');
const franchise = require('./franchise.service');

// Razorpay webhook (Dashboard -> Settings -> Webhooks, events payment.captured,
// order.paid and payment.failed). Checkout's handler confirms a payment from
// the browser; this is the server-to-server backup for when the browser closed
// first. Signed with RAZORPAY_WEBHOOK_SECRET over the raw body. It settles the
// three things paid through Razorpay - AI credit packs, ad invoices and
// franchise invoices - once each, and only for the amount that was ordered.

function signatureOk(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return expected.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

const paise = (inr) => Math.round(Number(inr) * 100);

async function settleOrder(orderId, paymentId, amount) {
  const p = (await pool.query('SELECT * FROM ai_credit_purchases WHERE gateway_order_id = $1', [orderId])).rows[0];
  if (p) {
    if (p.status === 'paid' || p.status === 'refunded') return ['already_paid', `AI credits ${p.receipt_number}`];
    if (amount != null && amount !== paise(p.total_inr)) return ['amount_mismatch', `AI credits ${p.receipt_number}: paid ${amount}, ordered ${paise(p.total_inr)}`];
    await ai.markPaid(p, { paymentId });
    await auditService.log({ actor: null, action: 'ai.credits_purchased', entityType: 'ai_credit_purchase', entityId: p.id, after: { credits: p.credits, totalInr: Number(p.total_inr), paymentId, via: 'webhook' } });
    return ['settled', `AI credits ${p.receipt_number}`];
  }
  const ad = (await pool.query('SELECT * FROM ad_invoices WHERE gateway_order_id = $1', [orderId])).rows[0];
  if (ad) {
    if (ad.status !== 'due') return ['already_paid', `Ad invoice ${ad.id}`];
    if (amount != null && amount !== paise(ad.total_amount)) return ['amount_mismatch', `Ad invoice ${ad.id}`];
    await advertising.markPaid(ad.campaign_id, { gateway: 'razorpay', orderId, paymentId, reference: paymentId });
    await auditService.log({ actor: null, action: 'ads.invoice_paid', entityType: 'ad_invoice', entityId: ad.id, after: { gateway: 'razorpay', paymentId, via: 'webhook' } });
    return ['settled', `Ad invoice ${ad.id}`];
  }
  const fr = (await pool.query('SELECT * FROM franchisee_payment_tracking WHERE gateway_order_id = $1', [orderId])).rows[0];
  if (fr) {
    if (!['pending', 'overdue'].includes(fr.payment_status)) return ['already_paid', `Franchise invoice ${fr.id}`];
    // The late fee can grow after the order was made, so only a short payment is refused.
    if (amount != null && amount < paise(fr.invoice_amount)) return ['amount_mismatch', `Franchise invoice ${fr.id}`];
    await franchise.settle(fr, { reference: paymentId, gateway: 'razorpay', orderId, paymentId });
    return ['settled', `Franchise invoice ${fr.id}`];
  }
  return ['unknown_order', null];
}

async function handle(rawBody, signature, eventIdHeader) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return { status: 503, outcome: 'not_configured' };
  if (!signatureOk(rawBody, signature)) return { status: 400, outcome: 'bad_signature' };
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, outcome: 'bad_json' };
  }
  const event = String(body.event || '');
  const payment = body.payload?.payment?.entity || {};
  const order = body.payload?.order?.entity || {};
  const orderId = payment.order_id || order.id || null;
  const paymentId = payment.id || null;
  const amount = payment.amount != null ? Number(payment.amount) : order.amount_paid != null ? Number(order.amount_paid) : null;
  const eventId = String(eventIdHeader || `${event}:${paymentId || orderId || crypto.randomUUID()}`).slice(0, 80);

  // A retried event is answered 200 and not applied again.
  const fresh = (await pool.query(
    `INSERT INTO razorpay_webhook_events (event_id, event, order_id, payment_id, amount_paise, outcome) VALUES ($1, $2, $3, $4, $5, 'received') ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, event.slice(0, 60), orderId, paymentId, amount]
  )).rows[0];
  if (!fresh) return { status: 200, outcome: 'duplicate' };

  let outcome = 'ignored';
  let detail = null;
  try {
    if ((event === 'payment.captured' || event === 'order.paid') && orderId) {
      [outcome, detail] = await settleOrder(orderId, paymentId, amount);
    } else if (event === 'payment.failed' && orderId) {
      const r = await pool.query(`UPDATE ai_credit_purchases SET status = 'failed' WHERE gateway_order_id = $1 AND status = 'created' RETURNING receipt_number`, [orderId]);
      outcome = r.rows[0] ? 'marked_failed' : 'ignored';
      detail = payment.error_description ? String(payment.error_description).slice(0, 200) : null;
    }
  } catch (err) {
    outcome = 'error';
    detail = err.message;
    console.error('[razorpay webhook]', event, orderId, err.message);
  }
  await pool.query('UPDATE razorpay_webhook_events SET outcome = $2, detail = $3 WHERE event_id = $1', [eventId, outcome, detail ? String(detail).slice(0, 300) : null]);
  // An error is answered 500 so Razorpay retries it; the stored row is cleared so the retry runs.
  if (outcome === 'error') {
    await pool.query('DELETE FROM razorpay_webhook_events WHERE event_id = $1', [eventId]);
    return { status: 500, outcome };
  }
  return { status: 200, outcome };
}

module.exports = { handle, signatureOk, settleOrder };
