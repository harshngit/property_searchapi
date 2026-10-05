const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const assignment = require('../services/assignment.service');

// Sec. 10 / 34 - A R representatives (RM / DM / TL / TC, platform number,
// coverage) and broker -> RM mapping. Mounted at /api/representatives.

const router = express.Router();
router.use(authenticate);
const ADMIN = ['admin', 'super_admin'];
const STAFF = ['internal_sales', ...ADMIN];

/**
 * @swagger
 * tags:
 *   name: Representatives
 *   description: >
 *     Sec. 34 Universal Inquiry Assignment Cascade - representatives (designation, platform number, coverage
 *     states / cities / localities, team leader), broker -> RM mapping, cascade sweep. Load and
 *     attended / missed counts per representative feed their incentive score.
 */

/**
 * @swagger
 * /representatives:
 *   get:
 *     summary: All A R staff with representative settings, open load, attended and missed inquiries
 *     tags: [Representatives]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Representatives } }
 */
router.get('/', authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Representatives', await assignment.listReps())));

/**
 * @swagger
 * /representatives/broker-mappings:
 *   get:
 *     summary: Active brokers with their mapped RM (unmapped first)
 *     tags: [Representatives]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Mappings } }
 */
router.get('/broker-mappings', authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Broker mappings', await assignment.listBrokerMappings())));

/**
 * @swagger
 * /representatives/broker-mappings/{brokerId}:
 *   put:
 *     summary: Map a broker to an RM (one click); rmId null removes the mapping
 *     tags: [Representatives]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: brokerId, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { rmId: { type: string, format: uuid, nullable: true } } } } } }
 *     responses: { 200: { description: Mapping saved } }
 */
router.put(
  '/broker-mappings/:brokerId',
  authorize(...ADMIN),
  [param('brokerId').isUUID(), body('rmId').optional({ nullable: true }).isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Mapping saved', await assignment.mapBroker(req.params.brokerId, req.body.rmId || null, req.user)))
);

/**
 * @swagger
 * /representatives/sweep:
 *   post:
 *     summary: Run the assignment cascade now (unassigned inquiries, missed windows, departed reps, response SLA)
 *     tags: [Representatives]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Counts } }
 */
router.post('/sweep', authorize(...ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Sweep complete', await assignment.sweep())));

/**
 * @swagger
 * /representatives/{userId}:
 *   put:
 *     summary: Configure a representative - designation (rm / dm / tl / tc), platform number, coverage, team leader, accepting assignments
 *     tags: [Representatives]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: userId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Representative } }
 */
router.put(
  '/:userId',
  authorize(...ADMIN),
  [
    param('userId').isUUID(),
    body('designation').optional().isIn(['rm', 'dm', 'tl', 'tc']),
    body('platformNumber').optional({ nullable: true }).isString().isLength({ max: 20 }),
    body('assignedStates').optional().isArray({ max: 40 }),
    body('assignedCities').optional().isArray({ max: 200 }),
    body('coverageLocalities').optional().isArray({ max: 500 }),
    body('teamLeaderId').optional({ nullable: true }).isUUID(),
    body('acceptsAssignments').optional().isBoolean(),
  ],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Representative saved', await assignment.upsertRep(req.params.userId, req.body, req.user)))
);

module.exports = router;
