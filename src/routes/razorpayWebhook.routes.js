const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const webhook = require('../services/razorpayWebhook.service');

/**
 * @swagger
 * /webhooks/razorpay:
 *   post:
 *     summary: Razorpay webhook (payment.captured, order.paid, payment.failed) - settles AI credit packs, ad invoices and franchise invoices once each
 *     description: No login. Signed by Razorpay - the X-Razorpay-Signature header is an HMAC-SHA256 of the raw body with RAZORPAY_WEBHOOK_SECRET. A repeated event (X-Razorpay-Event-Id) is answered 200 and not applied again.
 *     tags: [Payments]
 *     responses:
 *       200: { description: Received }
 *       400: { description: Bad signature }
 *       503: { description: RAZORPAY_WEBHOOK_SECRET is not set }
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const r = await webhook.handle(req.rawBody, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id'));
    res.status(r.status).json({ success: r.status === 200, outcome: r.outcome });
  })
);

module.exports = router;
