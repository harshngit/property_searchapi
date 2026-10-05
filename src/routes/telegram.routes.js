const express = require('express');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const telegram = require('../services/telegram.service');

// Sec. 25.5.3 Telegram parallel channel. Mounted at /api/telegram.
const router = express.Router();

/**
 * @swagger
 * /telegram/webhook:
 *   post:
 *     summary: Telegram bot updates (X-Telegram-Bot-Api-Secret-Token checked) - requirement flow and listing deep links into the shared ingestion pipeline
 *     tags: [Lead Ingestion]
 *     responses: { 200: { description: Handled } }
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    telegram.verifySecret(req.headers);
    const result = await telegram.handleUpdate(req.body || {}).catch((err) => {
      console.error('[telegram] update failed:', err.message);
      return { error: err.message };
    });
    // Always 200 so Telegram doesn't retry a bad update forever.
    return success(res, 200, 'OK', result);
  })
);

/**
 * @swagger
 * /telegram/link/{propertyId}:
 *   get:
 *     summary: Smart link for a listing (t.me/<bot>?start=p_<id>) - null when the bot is not configured
 *     tags: [Lead Ingestion]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Link } }
 */
router.get('/link/:propertyId', (req, res) => success(res, 200, 'Telegram link', { url: telegram.listingLink(req.params.propertyId) }));

/**
 * @swagger
 * /telegram/register-webhook:
 *   post:
 *     summary: Point the bot at this API's webhook (admin)
 *     tags: [Lead Ingestion]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Telegram response } }
 */
router.post(
  '/register-webhook',
  authenticate,
  authorize('admin', 'super_admin'),
  asyncHandler(async (req, res) => success(res, 200, 'Webhook registered', await telegram.registerWebhook(req.body?.baseUrl || process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`)))
);

module.exports = router;
