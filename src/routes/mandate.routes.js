const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const mandates = require('../services/mandate.service');

// Module 46 - Exclusive Mandate. Mounted at /api/mandates.
// The price range is returned ONLY by GET /mandates/:id/price-range (and the
// deal panel) to the assigned representative and the Super Admin.

const router = express.Router();
router.use(authenticate);
const STAFF = mandates.STAFF;
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const idParam = [param('id').isUUID()];
const pdf = (res, name, buf) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  res.send(buf);
};

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { success: false, message: 'Too many OTP requests - try again in a few minutes.' },
});

/**
 * @swagger
 * tags:
 *   name: Mandates
 *   description: >
 *     Module 46 Exclusive Mandate - OTP-verified professional fee consent, mandate records (Exclusive / Standard,
 *     fee locked at 1%), encrypted price range visible only to the assigned representative and Super Admin,
 *     acknowledgement, renewals (cap, pipeline gate), breach / cancel, benefit delivery, expiry reminders, PDFs.
 */

/**
 * @swagger
 * /mandates/consent-terms:
 *   get:
 *     summary: Professional fee consent text, fee table, mandate periods and benefit lists (Screens 4 / 5)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Consent terms } }
 */
router.get('/consent-terms', asyncHandler(async (req, res) => success(res, 200, 'Consent terms', await mandates.consentTerms())));

/**
 * @swagger
 * /mandates/consent/otp:
 *   post:
 *     summary: Step 1 - send the professional fee consent OTP to the account's mobile
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: OTP sent (echoed outside production) } }
 */
router.post('/consent/otp', otpLimiter, asyncHandler(async (req, res) => success(res, 200, 'OTP sent', await mandates.sendConsentOtp(req.user))));

/**
 * @swagger
 * /mandates/consent/verify:
 *   post:
 *     summary: Step 1 - verify the OTP; returns a one-time consentToken for the listing / requirement submit
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [otp, kind]
 *             properties:
 *               otp: { type: string }
 *               kind: { type: string, enum: [listing, requirement] }
 *     responses: { 200: { description: Consent recorded }, 400: { description: Invalid / expired OTP } }
 */
router.post(
  '/consent/verify',
  otpLimiter,
  [body('otp').isString().isLength({ min: 4, max: 10 }), body('kind').isIn(['listing', 'requirement'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Professional fee consent recorded', await mandates.verifyConsentOtp(req.user, req.body, meta(req))))
);

/**
 * @swagger
 * /mandates/mine:
 *   get:
 *     summary: The caller's own mandates (no price range)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Mandates } }
 */
router.get('/mine', asyncHandler(async (req, res) => success(res, 200, 'My mandates', await mandates.listMine(req.user))));

/**
 * @swagger
 * /mandates:
 *   get:
 *     summary: Mandate Management - active, expiring, expired, breached; benefit delivery; counts
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [pending_rep_ack, active, expired, breached, cancelled] } }
 *       - { in: query, name: type, schema: { type: string, enum: [exclusive, standard] } }
 *       - { in: query, name: party, schema: { type: string, enum: [seller, buyer] } }
 *       - { in: query, name: expiringWithin, schema: { type: integer, example: 30 } }
 *       - { in: query, name: mine, schema: { type: boolean } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses: { 200: { description: Summary + mandates } }
 */
router.get(
  '/',
  authorize(...STAFF),
  [query('status').optional().isIn(['pending_rep_ack', 'active', 'expired', 'breached', 'cancelled']), query('expiringWithin').optional().isInt({ min: 1, max: 365 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Mandates', await mandates.list(req.query, req.user)))
);

/**
 * @swagger
 * /mandates/deal/{dealId}:
 *   get:
 *     summary: Mandate Status Panel for Deal Detail - assigned representative and admins only
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: dealId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Mandates on the deal; price range only for the assigned rep / Super Admin } }
 */
router.get(
  '/deal/:dealId',
  authorize(...STAFF),
  [param('dealId').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Deal mandates', await mandates.forDeal(req.params.dealId, req.user)))
);

/**
 * @swagger
 * /mandates/sweep:
 *   post:
 *     summary: Run the expiry sweep now (reminders at 30 / 7 / 1 days, then expiry)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Counts } }
 */
router.post('/sweep', authorize(...ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Sweep complete', await mandates.sweep())));

/**
 * @swagger
 * /mandates/{id}:
 *   get:
 *     summary: One mandate - owner sees status and benefits; staff also see events, linked deals and invoices. Never the price range.
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Mandate } }
 */
router.get('/:id', idParam, validate, asyncHandler(async (req, res) => success(res, 200, 'Mandate', await mandates.get(req.params.id, req.user))));

/**
 * @swagger
 * /mandates/{id}/price-range:
 *   get:
 *     summary: Decrypted price range - assigned representative and Super Admin only; every read is logged
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Price range }, 403: { description: Not the assigned representative } }
 */
router.get(
  '/:id/price-range',
  authorize(...STAFF),
  idParam,
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Price range', await mandates.priceRange(req.params.id, req.user, meta(req))))
);

/**
 * @swagger
 * /mandates/{id}/acknowledge:
 *   put:
 *     summary: Representative acknowledgement - activates the mandate (start / end dates, benefits, featured placement)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Active mandate } }
 */
router.put(
  '/:id/acknowledge',
  authorize(...STAFF),
  idParam,
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Mandate acknowledged', await mandates.acknowledge(req.params.id, req.user, meta(req))))
);

/**
 * @swagger
 * /mandates/{id}/assign:
 *   put:
 *     summary: Assign the dedicated A R representative (admin)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, required: [repId], properties: { repId: { type: string, format: uuid } } } } } }
 *     responses: { 200: { description: Mandate } }
 */
router.put(
  '/:id/assign',
  authorize(...ADMIN),
  [...idParam, body('repId').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Representative assigned', await mandates.assignRep(req.params.id, req.body.repId, req.user, meta(req))))
);

/**
 * @swagger
 * /mandates/{id}/renew:
 *   post:
 *     summary: Renew for a deal past Site Visit Completed - assigned RM/DM; Super Admin after the renewal cap
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Renewed mandate }, 400: { description: No progressing deal }, 403: { description: Cap reached } }
 */
router.post(
  '/:id/renew',
  authorize(...STAFF),
  [...idParam, body('reason').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Mandate renewed', await mandates.renew(req.params.id, req.user, req.body, meta(req))))
);

for (const action of ['breach', 'cancel']) {
  /**
   * @swagger
   * /mandates/{id}/breach:
   *   post:
   *     summary: Flag a mandate as breached (reason required) - placement and badge are withdrawn
   *     tags: [Mandates]
   *     security: [{ bearerAuth: [] }]
   *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
   *     responses: { 200: { description: Mandate } }
   * /mandates/{id}/cancel:
   *   post:
   *     summary: Cancel a mandate (reason required)
   *     tags: [Mandates]
   *     security: [{ bearerAuth: [] }]
   *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
   *     responses: { 200: { description: Mandate } }
   */
  router.post(
    `/:id/${action}`,
    authorize(...STAFF),
    [...idParam, body('reason').isString().trim().notEmpty().withMessage('A reason is required')],
    validate,
    asyncHandler(async (req, res) =>
      success(res, 200, `Mandate ${action === 'breach' ? 'flagged as breached' : 'cancelled'}`, await mandates[action](req.params.id, req.user, req.body.reason, meta(req)))
    )
  );
}

/**
 * @swagger
 * /mandates/{id}/benefits:
 *   put:
 *     summary: Benefit delivery - valuation, legal due diligence, deed writer waiver (+ report document ids)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Mandate } }
 */
router.put(
  '/:id/benefits',
  authorize(...STAFF),
  [
    ...idParam,
    body('valuationStatus').optional().isString(),
    body('dueDiligenceStatus').optional().isString(),
    body('deedWriterWaiverStatus').optional().isString(),
    body('valuationDocumentId').optional({ nullable: true }).isUUID(),
    body('dueDiligenceDocumentId').optional({ nullable: true }).isUUID(),
  ],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Benefits updated', await mandates.updateBenefits(req.params.id, req.user, req.body, meta(req))))
);

/**
 * @swagger
 * /mandates/{id}/consent-pdf:
 *   get:
 *     summary: Professional Fee Consent Record PDF (system-generated from the immutable consent log)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: PDF } }
 * /mandates/{id}/summary-pdf:
 *   get:
 *     summary: Mandate Summary PDF (after acknowledgement; never includes the price range)
 *     tags: [Mandates]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: PDF } }
 */
router.get('/:id/consent-pdf', idParam, validate, asyncHandler(async (req, res) => pdf(res, 'fee-consent', await mandates.consentPdf(req.params.id, req.user, meta(req)))));
router.get('/:id/summary-pdf', idParam, validate, asyncHandler(async (req, res) => pdf(res, 'mandate-summary', await mandates.summaryPdf(req.params.id, req.user, meta(req)))));

module.exports = router;
