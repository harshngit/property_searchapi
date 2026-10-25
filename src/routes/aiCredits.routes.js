const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const ai = require('../services/ai/orchestrator.service');
const walletService = require('../services/ai/wallet.service');

// AI credit wallet (1 credit = Rs 1) and the AI orchestration settings.
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const ADMIN = ['admin', 'super_admin'];

router.use(authenticate);

/**
 * @swagger
 * tags:
 *   - name: AI credits
 *     description: AI credit wallet (1 credit = Rs 1), credit packs, and the AI orchestration settings (which model each AI activity uses and what it costs).
 * /ai-credits/wallet:
 *   get:
 *     summary: My balance, history, packs on sale and the credit price of each AI action
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/settings:
 *   put:
 *     summary: My low-balance alert and optional daily / monthly AI spend limits (credits; empty = none)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/topups:
 *   post:
 *     summary: Report a bank transfer / UPI payment for a pack (with its reference) - credited once an admin approves it
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/purchases/{id}/invoice:
 *   get:
 *     summary: GST tax invoice (PDF) of a paid credit purchase
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/topups:
 *   get:
 *     summary: Bank / UPI payments reported by users, waiting for approval (admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/topups/{id}/decide:
 *   post:
 *     summary: Approve (credits added, GST invoice issued) or reject a reported payment (admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/users/{id}/settings:
 *   put:
 *     summary: Set a user's low-balance alert and AI spend limits (admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/purchases/{id}/refund:
 *   post:
 *     summary: Refund the unused credits of a purchase within the Terms & Conditions window (admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/purchases:
 *   post:
 *     summary: Buy a credit pack - returns a Razorpay order to open Checkout with
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, required: [packId], properties: { packId: { type: string, format: uuid } } }
 * /ai-credits/purchases/{id}/verify:
 *   post:
 *     summary: Confirm the Checkout payment (signature checked) - the credits are added once
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin:
 *   get:
 *     summary: AI settings - activities with their model and credit price, packs, 30-day usage and cost, credit sales (admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/activities/{key}:
 *   put:
 *     summary: Change an activity's provider / model / fallback / effort / credits / who pays (Super Admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/packs:
 *   post:
 *     summary: Add a credit pack (Super Admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/packs/{id}:
 *   put:
 *     summary: Edit or switch off a credit pack (Super Admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 * /ai-credits/admin/credit:
 *   post:
 *     summary: Add credits to a user - a bank-transfer purchase (packId + reference) or a grant / correction (credits + note) (admin)
 *     tags: [AI credits]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/wallet', h(async (req, res) => ok(res, 'AI credits', await walletService.view(req.user))));
const limitRules = ['lowBalanceAlert', 'dailyCap', 'monthlyCap'].map((k) => body(k).optional({ nullable: true }).custom((v) => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0)));
router.put('/settings', limitRules, validate, h(async (req, res) => ok(res, 'Settings saved', await walletService.saveSettings(req.user, req.user.id, req.body, meta(req)))));
router.post(
  '/topups',
  [body('packId').isUUID(), body('method').isIn(['bank', 'upi']), body('reference').isString().isLength({ min: 6, max: 60 }), body('paidOn').optional({ checkFalsy: true }).isISO8601(), body('note').optional({ nullable: true }).isString().isLength({ max: 300 })],
  validate,
  h(async (req, res) => ok(res, 'Payment reported - credits are added once it is checked', await walletService.requestTopup(req.user, req.body, meta(req)), 201))
);
router.get(
  '/purchases/:id/invoice',
  [param('id').isUUID()],
  validate,
  h(async (req, res) => {
    const { buffer, fileName } = await walletService.invoicePdf(req.user, req.params.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName}"` }).send(buffer);
  })
);
router.post('/purchases', [body('packId').isUUID()], validate, h(async (req, res) => ok(res, 'Payment started', await ai.startPurchase(req.user, req.body.packId), 201)));
router.post(
  '/purchases/:id/verify',
  [param('id').isUUID(), body('orderId').isString().isLength({ max: 60 }), body('paymentId').isString().isLength({ max: 60 }), body('signature').isString().isLength({ max: 200 })],
  validate,
  h(async (req, res) => ok(res, 'Credits added', await ai.verifyPurchase(req.user, req.params.id, req.body, meta(req))))
);

router.get('/admin', authorize(...ADMIN), h(async (req, res) => ok(res, 'AI settings', await ai.adminOverview(req.user))));
router.get('/admin/topups', authorize(...ADMIN), [query('status').optional().isIn(['pending', 'approved', 'rejected', 'all'])], validate, h(async (req, res) => ok(res, 'Reported payments', await walletService.listTopups(req.user, req.query))));
router.post(
  '/admin/topups/:id/decide',
  authorize(...ADMIN),
  [param('id').isUUID(), body('action').isIn(['approve', 'reject']), body('note').optional({ nullable: true }).isString().isLength({ max: 300 })],
  validate,
  h(async (req, res) => ok(res, 'Payment decided', await walletService.decideTopup(req.user, req.params.id, req.body, meta(req))))
);
router.put('/admin/users/:id/settings', authorize(...ADMIN), [param('id').isUUID(), ...limitRules], validate, h(async (req, res) => ok(res, 'Settings saved', await walletService.saveSettings(req.user, req.params.id, req.body, meta(req)))));
router.post(
  '/admin/purchases/:id/refund',
  authorize(...ADMIN),
  [param('id').isUUID(), body('note').isString().isLength({ min: 5, max: 300 })],
  validate,
  h(async (req, res) => ok(res, 'Unused credits refunded', await walletService.refundPurchase(req.user, req.params.id, req.body, meta(req))))
);
router.put(
  '/admin/activities/:key',
  authorize('super_admin'),
  [
    param('key').isString().isLength({ min: 2, max: 60 }),
    body('provider').optional().isIn(['openai', 'claude']),
    body('model').optional().isString().isLength({ max: 60 }),
    body('fallbackProvider').optional({ nullable: true }).isIn(['openai', 'claude', null]),
    body('fallbackModel').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('effort').optional().isIn(['low', 'medium', 'high', 'xhigh', 'max']),
    body('maxOutputTokens').optional().isInt({ min: 50, max: 64000 }),
    body('credits').optional().isInt({ min: 0, max: 100000 }),
    body('active').optional().isBoolean(),
  ],
  validate,
  h(async (req, res) => ok(res, 'Activity saved', await ai.updateActivity(req.user, req.params.key, req.body, meta(req))))
);
const packRules = [body('name').isString().isLength({ min: 2, max: 80 }), body('priceInr').isFloat({ gt: 0 }), body('credits').isInt({ min: 1 }), body('bonusCredits').optional().isInt({ min: 0 }), body('active').optional().isBoolean(), body('sortOrder').optional().isInt()];
router.post('/admin/packs', authorize('super_admin'), packRules, validate, h(async (req, res) => ok(res, 'Pack saved', await ai.savePack(req.user, null, req.body, meta(req)), 201)));
router.put('/admin/packs/:id', authorize('super_admin'), [param('id').isUUID(), ...packRules], validate, h(async (req, res) => ok(res, 'Pack saved', await ai.savePack(req.user, req.params.id, req.body, meta(req)))));
router.post(
  '/admin/credit',
  authorize(...ADMIN),
  [body('userId').isUUID(), body('packId').optional({ nullable: true }).isUUID(), body('reference').optional({ nullable: true }).isString().isLength({ max: 120 }), body('credits').optional({ nullable: true }).isInt(), body('note').optional({ nullable: true }).isString().isLength({ max: 300 })],
  validate,
  h(async (req, res) => ok(res, 'Credits updated', await ai.adminCredit(req.user, req.body, meta(req))))
);

module.exports = router;
