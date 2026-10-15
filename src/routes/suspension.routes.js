const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const suspension = require('../services/userSuspension.service');

// Section 35 - User Suspension & Removal (Public Erasure Policy).
const ADMIN = ['admin', 'super_admin'];
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const uid = [param('id').isUUID()];

router.use(authenticate);

/**
 * @swagger
 * tags:
 *   - name: Suspension
 *     description: Section 35 - suspend or remove a user with immediate public erasure; Super Admin decisions and reinstatement
 * /suspensions:
 *   get:
 *     summary: Every suspended or removed account, with the latest reason and acting authority (Super Admin)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Accounts }
 * /suspensions/review-queue:
 *   get:
 *     summary: Requirements waiting for a fresh review after a reinstatement (staff)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Requirements }
 * /suspensions/requirements/{id}/republish:
 *   post:
 *     summary: Put a reviewed requirement back live (staff)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Republished }
 */
router.get('/', authorize('super_admin'), h(async (req, res) => ok(res, 'Suspended and removed accounts', await suspension.list(req.user))));
router.get('/review-queue', authorize(...STAFF), h(async (req, res) => ok(res, 'Waiting for review', await suspension.reviewQueue())));
router.post('/requirements/:id/republish', authorize(...STAFF), uid, validate, h(async (req, res) => ok(res, 'Requirement republished', await suspension.republishRequirement(req.user, req.params.id, meta(req)))));

/**
 * @swagger
 * /suspensions/users/{id}:
 *   get:
 *     summary: The suspension record of an account - events, frozen commission, active deals (Super Admin; admins see only the remark)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Record }
 *   post:
 *     summary: Suspend or remove an account - one atomic action that erases it from public view (admin)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               action: { type: string, enum: [suspended, removed] }
 *               reason: { type: string, description: Optional - the platform may act without assigning a reason }
 *               note: { type: string, description: Internal note, never shown to the person }
 *     responses:
 *       200: { description: Record }
 * /suspensions/users/{id}/impact:
 *   get:
 *     summary: What a suspension would take out of view (admin)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Counts }
 * /suspensions/users/{id}/reinstate:
 *   post:
 *     summary: Make the account live again on the person's clarification (Super Admin). Listings and requirements return only after review.
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [clarification], properties: { clarification: { type: string } } }
 *     responses:
 *       200: { description: Record }
 * /suspensions/users/{id}/deals/{dealId}:
 *   post:
 *     summary: Decide how a deal the person was in continues - continue, reassign or close (Super Admin)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Record }
 * /suspensions/commissions/{id}:
 *   post:
 *     summary: Release or forfeit a frozen commission share (Super Admin)
 *     tags: [Suspension]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Record }
 */
router.get('/users/:id', authorize(...ADMIN), uid, validate, h(async (req, res) => ok(res, 'Suspension record', await suspension.view(req.user, req.params.id))));
router.get('/users/:id/impact', authorize(...ADMIN), uid, validate, h(async (req, res) => ok(res, 'What would be hidden', await suspension.impact(req.params.id))));
router.post(
  '/users/:id',
  authorize(...ADMIN),
  [...uid, body('action').isIn(['suspended', 'removed']), body('reason').optional({ nullable: true }).isString().isLength({ max: 2000 }), body('note').optional({ nullable: true }).isString().isLength({ max: 2000 })],
  validate,
  h(async (req, res) => ok(res, req.body.action === 'removed' ? 'Account removed' : 'Account suspended', await suspension.suspend(req.user, req.params.id, req.body, meta(req))))
);
router.post('/users/:id/reinstate', authorize('super_admin'), [...uid, body('clarification').isString()], validate, h(async (req, res) => ok(res, 'Account reinstated', await suspension.reinstate(req.user, req.params.id, req.body, meta(req)))));
router.post(
  '/users/:id/deals/:dealId',
  authorize('super_admin'),
  [...uid, param('dealId').isUUID(), body('decision').isIn(['continue', 'reassign', 'close']), body('newBrokerId').optional({ nullable: true }).isUUID()],
  validate,
  h(async (req, res) => ok(res, 'Decision recorded', await suspension.decideDeal(req.user, req.params.id, req.params.dealId, req.body, meta(req))))
);
router.post('/commissions/:id', authorize('super_admin'), [...uid, body('decision').isIn(['release', 'forfeit'])], validate, h(async (req, res) => ok(res, 'Decision recorded', await suspension.decideCommission(req.user, req.params.id, req.body, meta(req)))));

module.exports = router;
