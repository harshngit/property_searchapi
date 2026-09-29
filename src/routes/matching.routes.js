const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const matchingController = require('../controllers/matching.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const MATCHING_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];
const ADMIN_ROLES = ['admin', 'super_admin'];
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const pool = require('../config/db');
const engine = () => require('../services/matchEngine.service');

/**
 * @swagger
 * tags:
 *   name: Matching
 *   description: >
 *     Property Matching - ranks approved, tenant-scoped properties against a
 *     customer's preferences (budget/location/type) and saves the top
 *     results. All endpoints require authentication and are tenant-scoped
 *     (via the parent customer or lead).
 */

/**
 * @swagger
 * /matching/properties/{customerId}:
 *   get:
 *     summary: Get ranked property matches for a customer, based on their saved preferences
 *     description: >
 *       Filters approved properties (tenant-scoped) by budget/location/type/
 *       transaction type, ranks by a weighted relevance score, and saves the
 *       top 20 to property_match_results, overwriting any previous
 *       customer-level results.
 *     tags: [Matching]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: customerId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Property matches fetched successfully
 *       404:
 *         description: Customer not found
 */
router.get(
  '/properties/:customerId',
  authenticate,
  authorize(...MATCHING_ROLES),
  [param('customerId').isUUID().withMessage('Invalid customer id')],
  validate,
  matchingController.getMatchesForCustomer
);

/**
 * @swagger
 * /matching/rerun:
 *   post:
 *     summary: Re-run property matching for a customer, overwriting previous results
 *     tags: [Matching]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerId]
 *             properties:
 *               customerId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Property matches re-run successfully
 *       404:
 *         description: Customer not found
 *       422:
 *         description: Validation failed
 */
router.post(
  '/rerun',
  authenticate,
  authorize(...MATCHING_ROLES),
  [body('customerId').isUUID().withMessage('customerId is required')],
  validate,
  matchingController.rerun
);

/**
 * @swagger
 * /matching/recommendations/{leadId}:
 *   get:
 *     summary: Get ranked property recommendations for a lead (via its linked customer)
 *     description: Same ranking as GET /matching/properties/{customerId}, keyed off a lead and saved against that lead specifically (does not overwrite the customer-level view).
 *     tags: [Matching]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: leadId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Property recommendations fetched successfully
 *       404:
 *         description: Lead not found
 */
router.get(
  '/recommendations/:leadId',
  authenticate,
  authorize(...MATCHING_ROLES),
  [param('leadId').isUUID().withMessage('Invalid lead id')],
  validate,
  matchingController.getRecommendationsForLead
);

/**
 * @swagger
 * /matching/marketplace:
 *   get:
 *     summary: Requirement Marketplace - active buyer requirements (identity masked), Hot and Priority tagged, each with its best match against the caller's listings
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: purpose, schema: { type: string, enum: [buy, rent] } }
 *       - { in: query, name: hotOnly, schema: { type: boolean } }
 *       - { in: query, name: priorityOnly, schema: { type: boolean } }
 *       - { in: query, name: sharedOnly, schema: { type: boolean } }
 *     responses: { 200: { description: Requirements } }
 */
router.get(
  '/marketplace',
  authenticate,
  authorize(...MATCHING_ROLES),
  [query('purpose').optional().isIn(['buy', 'rent'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Marketplace fetched', await engine().marketplace(req.user, req.query)))
);

/**
 * @swagger
 * /matching/leads/{leadId}:
 *   get:
 *     summary: Broker CRM - the lead's requirement scored against the broker's own listed properties (staff - all live listings), with breakdown
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: leadId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: "{ requirement, items }" } }
 */
router.get(
  '/leads/:leadId',
  authenticate,
  authorize(...MATCHING_ROLES),
  [param('leadId').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Lead matches fetched', await engine().leadMatches(req.params.leadId, req.user)))
);

/**
 * @swagger
 * /matching/listings/{propertyId}/buyers:
 *   get:
 *     summary: Smart recommendation - buyers (masked requirements) matching a listing; listing broker or A R staff
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Matched buyers } }
 */
router.get(
  '/listings/:propertyId/buyers',
  authenticate,
  authorize(...MATCHING_ROLES, 'builder'),
  [param('propertyId').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Matched buyers fetched', await engine().buyersForListing(req.params.propertyId, req.user)))
);

/**
 * @swagger
 * /matching/requirements/{id}/send:
 *   post:
 *     summary: Send a listing (Lukewarm or better) to a buyer's requirement - appears in their matches as recommended by the representative
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [propertyId], properties: { propertyId: { type: string, format: uuid } } } } }
 *     responses: { 200: { description: "{ score, tier }" }, 400: { description: Below the Lukewarm threshold } }
 */
router.post(
  '/requirements/:id/send',
  authenticate,
  authorize(...MATCHING_ROLES),
  [param('id').isUUID(), body('propertyId').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Listing sent to the buyer', await engine().sendToBuyer(req.params.id, req.body.propertyId, req.user)))
);

/**
 * @swagger
 * /matching/requirements/{id}/share:
 *   post:
 *     summary: Mandate-verification routing - share a requirement with a partner broker
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [brokerId], properties: { brokerId: { type: string, format: uuid }, note: { type: string } } } } }
 *     responses: { 200: { description: Share } }
 */
router.post(
  '/requirements/:id/share',
  authenticate,
  authorize(...MATCHING_ROLES),
  [param('id').isUUID(), body('brokerId').isUUID(), body('note').optional().isString().isLength({ max: 500 })],
  validate,
  asyncHandler(async (req, res) => {
    const share = await engine().shareRequirement(req.params.id, req.body.brokerId, req.user, req.body.note);
    await auditService.log({ actor: req.user, action: 'requirement.shared', entityType: 'requirement', entityId: req.params.id, after: share, ...auditService.requestMeta(req) });
    return success(res, 200, 'Requirement shared', share);
  })
);

/**
 * @swagger
 * /matching/shares:
 *   get:
 *     summary: Requirement shares sent by or to the caller
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Shares } }
 */
router.get('/shares', authenticate, authorize(...MATCHING_ROLES), asyncHandler(async (req, res) => success(res, 200, 'Shares fetched', await engine().listShares(req.user))));

/**
 * @swagger
 * /matching/shares/{id}:
 *   put:
 *     summary: Accept or decline a requirement shared with you
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [accept, decline] } } } } }
 *     responses: { 200: { description: Share } }
 */
router.put(
  '/shares/:id',
  authenticate,
  authorize(...MATCHING_ROLES),
  [param('id').isUUID(), body('action').isIn(['accept', 'decline'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Share updated', await engine().respondShare(req.params.id, req.body.action, req.user)))
);

/**
 * @swagger
 * /matching/partners:
 *   get:
 *     summary: Active brokers to share a requirement with
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: q, schema: { type: string } }]
 *     responses: { 200: { description: Brokers } }
 */
router.get(
  '/partners',
  authenticate,
  authorize(...MATCHING_ROLES),
  asyncHandler(async (req, res) => {
    const r = await pool.query(
      `SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name IN ('broker', 'agency_admin') AND u.status = 'active' AND u.id <> $1 AND ($2 = '' OR u.full_name ILIKE '%' || $2 || '%')
       ORDER BY u.full_name LIMIT 50`,
      [req.user.id, String(req.query.q || '')]
    );
    return success(res, 200, 'Partners fetched', r.rows);
  })
);

/**
 * @swagger
 * /matching/overview:
 *   get:
 *     summary: Matching engine overview - live weights (configured / learned), thresholds, matches by tier, 30-day events, last nightly run, A/B test (admin)
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Overview } }
 */
router.get('/overview', authenticate, authorize(...ADMIN_ROLES, 'internal_sales'), asyncHandler(async (req, res) => success(res, 200, 'Matching overview', await engine().overview())));

/**
 * @swagger
 * /matching/ab-report:
 *   get:
 *     summary: A/B test report - shown / clicked / enquired / visited / converted and rates per variant (admin)
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: days, schema: { type: integer, default: 30 } }]
 *     responses: { 200: { description: Report } }
 */
router.get('/ab-report', authenticate, authorize(...ADMIN_ROLES), asyncHandler(async (req, res) => success(res, 200, 'A/B report', await engine().abReport({ days: Number(req.query.days) || 30 }))));

/**
 * @swagger
 * /matching/ab/promote:
 *   post:
 *     summary: Promote variant B's weights to the live weights and end the test (super admin; audit-logged)
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Report after promotion } }
 */
router.post('/ab/promote', authenticate, authorize('super_admin'), asyncHandler(async (req, res) => success(res, 200, 'Variant B promoted', await engine().promoteVariantB(req.user, auditService.requestMeta(req)))));

/**
 * @swagger
 * /matching/jobs/{job}:
 *   post:
 *     summary: Run a matching job now - nightly (re-match all + expiry + learning), learn, digest, expiry (admin)
 *     tags: [Matching]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: job, required: true, schema: { type: string, enum: [nightly, learn, digest, expiry] } }]
 *     responses: { 200: { description: Job result } }
 */
router.post(
  '/jobs/:job',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('job').isIn(['nightly', 'learn', 'digest', 'expiry'])],
  validate,
  asyncHandler(async (req, res) => {
    const e = engine();
    const run = { nightly: e.runNightly, learn: e.learnWeights, digest: e.sendDigests, expiry: e.processExpiry }[req.params.job];
    return success(res, 200, `Job ${req.params.job} completed`, await run());
  })
);

module.exports = router;
