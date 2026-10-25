const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const intake = require('../services/messaging/chatIntake.service');

// Engine 1: property posts and requirements typed into WhatsApp / Telegram.
// Staff review the parsed listings here before anything is published.
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);

router.use(authenticate, authorize('internal_sales', 'admin', 'super_admin'));

/**
 * @swagger
 * tags:
 *   - name: Chat intake
 *     description: Free-text property and requirement posts on WhatsApp and Telegram - intent detection, parsed listings waiting for approval, and the message log.
 * /chat-intake/submissions:
 *   get:
 *     summary: Listings posted on WhatsApp / Telegram (default - waiting for review), with possible duplicates
 *     tags: [Chat intake]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [pending_review, approved, rejected, all] } }
 *       - { in: query, name: intent, schema: { type: string, enum: [sell, rent_out, institutional_sale] } }
 *       - { in: query, name: channel, schema: { type: string, enum: [whatsapp, telegram] } }
 * /chat-intake/submissions/{id}:
 *   get:
 *     summary: One chat listing - the message, parsed fields, photos and possible duplicates
 *     tags: [Chat intake]
 *     security: [{ bearerAuth: [] }]
 *   put:
 *     summary: Correct the parsed fields before approving
 *     tags: [Chat intake]
 *     security: [{ bearerAuth: [] }]
 * /chat-intake/submissions/{id}/approve:
 *   post:
 *     summary: Approve - creates the listing (Sec. 9 duplicate / fraud check decides if it goes live) or, for an institutional sale, the institutional desk listing; the poster is told
 *     tags: [Chat intake]
 *     security: [{ bearerAuth: [] }]
 * /chat-intake/submissions/{id}/reject:
 *   post:
 *     summary: Reject with a reason (the poster is told unless notify is false)
 *     tags: [Chat intake]
 *     security: [{ bearerAuth: [] }]
 * /chat-intake/log:
 *   get:
 *     summary: Messages read in the last N days - intent found, rules or AI, and where each went
 *     tags: [Chat intake]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/submissions',
  [query('status').optional().isIn(['pending_review', 'approved', 'rejected', 'all']), query('intent').optional().isIn(intake.LISTING_INTENTS), query('channel').optional().isIn(['whatsapp', 'telegram'])],
  validate,
  h(async (req, res) => ok(res, 'Chat listings', await intake.listSubmissions(req.user, req.query)))
);
router.get('/submissions/:id', [param('id').isUUID()], validate, h(async (req, res) => ok(res, 'Chat listing', await intake.getSubmission(req.user, req.params.id))));

const fieldRules = [
  body('intent').optional().isIn(intake.LISTING_INTENTS),
  body('title').optional().isString().isLength({ max: 200 }),
  body('propertyType').optional({ nullable: true }).isIn(['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other']),
  body('transactionType').optional().isIn(['sell', 'rent']),
  body('price').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('city').optional({ nullable: true }).isString().isLength({ max: 100 }),
  body('locality').optional({ nullable: true }).isString().isLength({ max: 150 }),
  body('pincode').optional({ nullable: true }).isString().isLength({ max: 6 }),
  body('areaSqft').optional({ nullable: true }).isFloat({ min: 0 }),
  body('bedrooms').optional({ nullable: true }).isInt({ min: 0, max: 20 }),
  body('bathrooms').optional({ nullable: true }).isInt({ min: 0, max: 20 }),
  body('furnishing').optional({ nullable: true }).isIn(['furnished', 'semi-furnished', 'unfurnished', '']),
  body('description').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  body('institutionName').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('assetClass').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('dealType').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('askingPriceCr').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
  body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
];
router.put('/submissions/:id', [param('id').isUUID(), ...fieldRules], validate, h(async (req, res) => ok(res, 'Chat listing saved', await intake.updateSubmission(req.user, req.params.id, req.body, meta(req)))));
router.post('/submissions/:id/approve', [param('id').isUUID(), ...fieldRules], validate, h(async (req, res) => ok(res, 'Chat listing approved', await intake.approve(req.user, req.params.id, req.body, meta(req)))));
router.post(
  '/submissions/:id/reject',
  [param('id').isUUID(), body('reason').isString().isLength({ min: 3, max: 500 }), body('notify').optional().isBoolean()],
  validate,
  h(async (req, res) => ok(res, 'Chat listing rejected', await intake.reject(req.user, req.params.id, req.body, meta(req))))
);
router.get('/log', [query('days').optional().isInt({ min: 1, max: 90 })], validate, h(async (req, res) => ok(res, 'Chat intake log', await intake.intakeLog(req.user, req.query))));

module.exports = router;
