const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const reputation = require('../services/reputation.service');

// Module 44 Reputation Graph. Mounted at /api/reputation.

const router = express.Router();
router.use(authenticate);
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const BROKERS = ['broker', 'agency_admin', 'builder'];
const meta = (req) => auditService.requestMeta(req);

/**
 * @swagger
 * tags:
 *   name: Reputation
 *   description: >
 *     Module 44 - broker network (co-listing, routing, shares, closed deals together, vouches), network score and
 *     a bounded (+/- 5) adjustment to the trust score, with anti-gaming exclusions.
 */

/**
 * @swagger
 * /reputation/me:
 *   get:
 *     summary: The caller's network score, confidence, trust adjustment and vouches
 *     tags: [Reputation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Summary } }
 */
router.get('/me', authorize(...BROKERS, ...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Reputation', await reputation.summary(req.user.id))));

/**
 * @swagger
 * /reputation/users/{id}:
 *   get:
 *     summary: A broker's reputation summary (staff)
 *     tags: [Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Summary } }
 */
router.get(
  '/users/:id',
  authorize(...STAFF),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Reputation', await reputation.summary(req.params.id)))
);

/**
 * @swagger
 * /reputation/graph:
 *   get:
 *     summary: Graph for visualisation - the caller's ego network, or (staff) any broker's / the whole network
 *     tags: [Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: userId, schema: { type: string, format: uuid } }
 *       - { in: query, name: scope, schema: { type: string, enum: [ego, global] } }
 *     responses: { 200: { description: "{ nodes, edges }" } }
 */
router.get(
  '/graph',
  authorize(...BROKERS, ...STAFF),
  [query('userId').optional().isUUID(), query('scope').optional().isIn(['ego', 'global'])],
  validate,
  asyncHandler(async (req, res) => {
    const staff = STAFF.includes(req.user.role);
    if (staff && req.query.scope === 'global') return success(res, 200, 'Network', await reputation.globalGraph());
    const id = staff && req.query.userId ? req.query.userId : req.user.id;
    return success(res, 200, 'Network', await reputation.egoGraph(id));
  })
);

/**
 * @swagger
 * /reputation/vouch:
 *   post:
 *     summary: Vouch for another broker (trust 60+ needed, max 10 live vouches; same-agency vouches do not count)
 *     tags: [Reputation]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [userId], properties: { userId: { type: string, format: uuid }, note: { type: string } } } } }
 *     responses: { 201: { description: Vouch recorded } }
 */
router.post(
  '/vouch',
  authorize(...BROKERS),
  [body('userId').isUUID(), body('note').optional().isString().isLength({ max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 201, 'Vouch recorded', await reputation.vouch(req.user, req.body.userId, req.body, meta(req))))
);

/**
 * @swagger
 * /reputation/vouch/{id}:
 *   delete:
 *     summary: Revoke a vouch (the voucher, or an admin)
 *     tags: [Reputation]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Revoked } }
 */
router.delete(
  '/vouch/:id',
  authorize(...BROKERS, ...ADMIN),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Vouch revoked', await reputation.revokeVouch(req.user, req.params.id, meta(req))))
);

/**
 * @swagger
 * /reputation/recompute:
 *   post:
 *     summary: Recompute the whole graph and the affected trust scores now (admin; runs nightly)
 *     tags: [Reputation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Result } }
 */
router.post('/recompute', authorize(...ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Reputation recomputed', await reputation.recomputeAll())));

module.exports = router;
