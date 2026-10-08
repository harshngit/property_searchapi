const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { forbidden } = require('../utils/httpError');
const auditService = require('../services/audit.service');
const trustService = require('../services/trust.service');
const reviewService = require('../services/review.service');

// Module 6 / sec. 8 - Trust & Reputation: trust score, badges, user
// verifications (KYC / RERA / GST / company / institutional certification)
// and reviews. Mounted at /api/trust.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);

/**
 * @swagger
 * tags:
 *   name: Trust & Reputation
 *   description: >
 *     Sec. 8 trust score (Verification 20 / Deals 30 / Response 20 / Ratings 25 / Geo 5), automatic badges with a
 *     7-day warning before revocation, award badges, user verifications and reviews after verified interactions.
 */

// ------------------------------------------------------------------ public

/**
 * @swagger
 * /trust/public/listings/{propertyId}:
 *   get:
 *     summary: Public trust card for a listing - lister type, trust score, badges, rating + published reviews, first-listed timestamp (no identity or contact)
 *     tags: [Trust & Reputation]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Trust card } }
 */
router.get(
  '/public/listings/:propertyId',
  [param('propertyId').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Trust card fetched', await trustService.publicForListing(req.params.propertyId)))
);

/**
 * @swagger
 * /trust/public/properties/{propertyId}/reviews:
 *   get:
 *     summary: Public - published reviews written about one listing, with their average rating (first name only, no contact)
 *     tags: [Trust & Reputation]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Rating summary and reviews } }
 */
router.get(
  '/public/properties/:propertyId/reviews',
  [param('propertyId').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Reviews fetched', await reviewService.forProperty(req.params.propertyId)))
);

/**
 * @swagger
 * /trust/badges/{id}/image.svg:
 *   get:
 *     summary: Shareable badge image (Featured Agent, Best Broker, Top Broker, Highly Rated, Community Champion) for social media
 *     tags: [Trust & Reputation]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: SVG image } }
 */
router.get(
  '/badges/:id/image.svg',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const svg = await trustService.badgeImage(req.params.id);
    res.set('Content-Type', 'image/svg+xml');
    res.set('Content-Disposition', 'inline; filename="propertyserch-badge.svg"');
    return res.send(svg);
  })
);

router.use(authenticate);

// ------------------------------------------------------------------- self

/**
 * @swagger
 * /trust/me:
 *   get:
 *     summary: Caller's trust score, component breakdown, badges (with warnings), verifications, history and next steps
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: refresh, schema: { type: boolean } }]
 *     responses: { 200: { description: Trust profile } }
 */
router.get('/me', asyncHandler(async (req, res) => success(res, 200, 'Trust profile fetched', await trustService.getProfile(req.user.id, { refresh: req.query.refresh === 'true' }))));

/**
 * @swagger
 * /trust/verifications:
 *   post:
 *     summary: Submit a verification - KYC (ID document; only the last 4 characters of any number are stored), RERA, GSTIN, company registration or institutional broker certification
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [kind]
 *             properties:
 *               kind: { type: string, enum: [kyc, rera, gst, company, institutional_cert] }
 *               reference: { type: string }
 *               file: { type: string, format: binary }
 *     responses: { 201: { description: Submitted - pending A R verification } }
 *   get:
 *     summary: "[Staff] Verification queue"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: status, schema: { type: string, enum: [pending, verified, rejected, all] } }]
 *     responses: { 200: { description: Verifications } }
 */
router.post(
  '/verifications',
  uploadDocumentFile.single('file'),
  [body('kind').isIn(['kyc', 'rera', 'gst', 'company', 'institutional_cert']), body('reference').optional().isString().isLength({ max: 120 })],
  validate,
  asyncHandler(async (req, res) => {
    let documentPath = null;
    if (req.file) {
      const { uploadBuffer } = require('../utils/storage');
      documentPath = await uploadBuffer(req.file.buffer, `verifications/${req.user.id}`, req.file.originalname, req.file.mimetype);
    }
    const v = await reviewService.submitVerification(req.user, { kind: req.body.kind, reference: req.body.reference, documentPath }, meta(req));
    return success(res, 201, 'Verification submitted', v);
  })
);
router.get(
  '/verifications',
  authorize(...STAFF),
  [query('status').optional().isIn(['pending', 'verified', 'rejected', 'all'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Verifications fetched', await reviewService.listVerifications({ status: req.query.status || 'pending' })))
);

/**
 * @swagger
 * /trust/verifications/{id}:
 *   put:
 *     summary: "[Staff] Verify or reject a submission (reason required to reject); the user's trust score updates immediately"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [verify, reject] }, notes: { type: string } } } } }
 *     responses: { 200: { description: Decision } }
 */
router.put(
  '/verifications/:id',
  authorize(...STAFF),
  [param('id').isUUID(), body('action').isIn(['verify', 'reject']), body('notes').optional().isString().isLength({ max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Verification decided', await reviewService.decideVerification(req.user, req.params.id, req.body.action, req.body.notes, meta(req))))
);

/**
 * @swagger
 * /trust/verifications/{id}/document:
 *   get:
 *     summary: "[Staff] 15-minute link to the submitted document"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: "{ url }" } }
 */
router.get(
  '/verifications/:id/document',
  authorize(...STAFF),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Document link', await reviewService.verificationDocumentUrl(req.params.id)))
);

// ------------------------------------------------------------------ staff

/**
 * @swagger
 * /trust/users/{id}:
 *   get:
 *     summary: Trust profile of a user (the user themselves or A R staff)
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Trust profile } }
 */
router.get(
  '/users/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    if (req.params.id !== req.user.id && !STAFF.includes(req.user.role)) throw forbidden('Not allowed');
    return success(res, 200, 'Trust profile fetched', await trustService.getProfile(req.params.id, { refresh: req.query.refresh === 'true' }));
  })
);

/**
 * @swagger
 * /trust/leaderboard:
 *   get:
 *     summary: "[Staff] Brokers / builders ranked by trust score, optionally per region"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: region, schema: { type: string } }]
 *     responses: { 200: { description: Ranked users } }
 */
router.get('/leaderboard', authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Leaderboard fetched', await trustService.leaderboard(req.query))));

/**
 * @swagger
 * /trust/jobs/{job}:
 *   post:
 *     summary: "[Admin] Run a trust job now - daily (recompute all), featured (weekly Featured Agents), best_quarter, best_year"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: job, required: true, schema: { type: string, enum: [daily, featured, best_quarter, best_year] } }]
 *     responses: { 200: { description: Result } }
 */
router.post(
  '/jobs/:job',
  authorize(...ADMIN),
  [param('job').isIn(['daily', 'featured', 'best_quarter', 'best_year'])],
  validate,
  asyncHandler(async (req, res) => {
    const run = {
      daily: () => trustService.recomputeAll(),
      featured: () => trustService.awardFeaturedAgents(),
      best_quarter: () => trustService.awardBestBroker('quarter'),
      best_year: () => trustService.awardBestBroker('year'),
    }[req.params.job];
    return success(res, 200, `Job ${req.params.job} completed`, await run());
  })
);

/**
 * @swagger
 * /trust/users/{id}/recompute:
 *   post:
 *     summary: "[Staff] Recompute a user's trust score and badges now"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Trust profile } }
 */
router.post(
  '/users/:id/recompute',
  authorize(...STAFF),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Recomputed', await trustService.getProfile(req.params.id, { refresh: true })))
);

// ---------------------------------------------------------------- reviews

/**
 * @swagger
 * /trust/reviews/eligible:
 *   get:
 *     summary: Interactions the caller can review (closed deals, completed site visits, confirmed leases) - parties described by role only
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Interactions } }
 */
router.get('/reviews/eligible', asyncHandler(async (req, res) => success(res, 200, 'Reviewable interactions', await reviewService.eligibleInteractions(req.user))));

/**
 * @swagger
 * /trust/reviews:
 *   post:
 *     summary: Review a party after a verified interaction; auto-published unless the fake-review filter flags it for moderation
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subject, rating]
 *             properties:
 *               dealId: { type: string, format: uuid }
 *               leaseId: { type: string, format: uuid }
 *               subject: { type: string, enum: [broker, owner, builder, tenant] }
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               title: { type: string }
 *               body: { type: string }
 *     responses: { 201: { description: Review (status published or pending_moderation) }, 403: { description: No verified interaction } }
 */
router.post(
  '/reviews',
  [
    body('dealId').optional().isUUID(),
    body('leaseId').optional().isUUID(),
    body('subject').isIn(['broker', 'owner', 'builder', 'tenant']),
    body('rating').isInt({ min: 1, max: 5 }),
    body('title').optional().isString().isLength({ max: 150 }),
    body('body').optional().isString().isLength({ max: 3000 }),
  ],
  validate,
  asyncHandler(async (req, res) => success(res, 201, 'Review submitted', await reviewService.createReview(req.user, req.body, meta(req))))
);

/**
 * @swagger
 * /trust/reviews/mine:
 *   get:
 *     summary: Reviews the caller has written
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Reviews } }
 */
router.get('/reviews/mine', asyncHandler(async (req, res) => success(res, 200, 'Reviews fetched', await reviewService.mine(req.user))));

/**
 * @swagger
 * /trust/reviews/about-me:
 *   get:
 *     summary: Published reviews about the caller
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Reviews } }
 */
router.get('/reviews/about-me', asyncHandler(async (req, res) => success(res, 200, 'Reviews fetched', await reviewService.aboutMe(req.user))));

/**
 * @swagger
 * /trust/reviews:
 *   get:
 *     summary: "[Staff] Reviews desk - every review in any status, with totals by status"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [published, pending_moderation, hidden, rejected] } }
 *       - { in: query, name: rating, schema: { type: integer, minimum: 1, maximum: 5 } }
 *       - { in: query, name: q, schema: { type: string }, description: Review text, reviewer, reviewed person or property title }
 *       - { in: query, name: propertyId, schema: { type: string, format: uuid } }
 *       - { in: query, name: subjectId, schema: { type: string, format: uuid } }
 *       - { in: query, name: reported, schema: { type: boolean }, description: Only reviews reported and not yet decided }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses: { 200: { description: Reviews, pagination and totals } }
 */
router.get(
  '/reviews',
  authorize(...STAFF),
  [
    query('status').optional().isIn(['published', 'pending_moderation', 'hidden', 'rejected']),
    query('rating').optional().isInt({ min: 1, max: 5 }),
    query('q').optional().isString().isLength({ max: 100 }),
    query('propertyId').optional().isUUID(),
    query('subjectId').optional().isUUID(),
    query('reported').optional().isBoolean(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Reviews fetched', await reviewService.adminList({ ...req.query, reported: req.query.reported === 'true' })))
);

/**
 * @swagger
 * /trust/reviews/moderation:
 *   get:
 *     summary: "[Staff] Moderation queue - flagged by the fraud filter or reported by the reviewed person"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Reviews with fraud score and reasons } }
 */
router.get('/reviews/moderation', authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Moderation queue', await reviewService.moderationQueue())));

/**
 * @swagger
 * /trust/reviews/users/{id}:
 *   get:
 *     summary: "[Staff] All reviews about a user, any status"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Reviews } }
 */
router.get('/reviews/users/:id', authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Reviews fetched', await reviewService.forUser(req.params.id))));

/**
 * @swagger
 * /trust/reviews/{id}/moderate:
 *   put:
 *     summary: "[Admin] Approve (publish), reject or hide a review - audit-logged; trust score updates"
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [approve, reject, hide] }, note: { type: string } } } } }
 *     responses: { 200: { description: Review } }
 */
router.put(
  '/reviews/:id/moderate',
  authorize(...ADMIN),
  [param('id').isUUID(), body('action').isIn(['approve', 'reject', 'hide']), body('note').optional().isString().isLength({ max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Review moderated', await reviewService.moderate(req.user, req.params.id, req.body.action, req.body.note, meta(req))))
);

/**
 * @swagger
 * /trust/reviews/{id}/reply:
 *   post:
 *     summary: Reply once, publicly, to a published review about you
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [reply], properties: { reply: { type: string } } } } }
 *     responses: { 200: { description: Review } }
 */
router.post(
  '/reviews/:id/reply',
  [param('id').isUUID(), body('reply').trim().isLength({ min: 2, max: 1000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Reply posted', await reviewService.reply(req.user, req.params.id, req.body.reply, meta(req))))
);

/**
 * @swagger
 * /trust/reviews/{id}/report:
 *   post:
 *     summary: Report a review about you as fake or abusive - it goes to admin moderation (stays visible until decided)
 *     tags: [Trust & Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [reason], properties: { reason: { type: string } } } } }
 *     responses: { 200: { description: Review } }
 */
router.post(
  '/reviews/:id/report',
  [param('id').isUUID(), body('reason').trim().isLength({ min: 5, max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Review reported', await reviewService.report(req.user, req.params.id, req.body.reason, meta(req))))
);

module.exports = router;
