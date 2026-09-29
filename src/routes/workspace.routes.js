const express = require('express');
const { query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const workspaceService = require('../services/workspace.service');

const router = express.Router();
router.use(authenticate);

/**
 * @swagger
 * tags:
 *   name: Investor Workspace
 *   description: >
 *     Sec. 13.2 / 13.2A Full CRM workspace for customers inside the CRM app -
 *     HNI investors from joining, NRIs and other customers after 5 closed
 *     deals or 15 referrals (permanent once reached). Scoped to the caller.
 */

/**
 * @swagger
 * /workspace/access:
 *   get:
 *     summary: Whether the caller has the Full CRM workspace, with tier progress
 *     tags: [Investor Workspace]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ eligible, reason, tier, investor }" } }
 */
router.get('/access', asyncHandler(async (req, res) => success(res, 200, 'Workspace access', await workspaceService.getAccess(req.user))));

/**
 * @swagger
 * /workspace/summary:
 *   get:
 *     summary: Workspace analytics - pipeline by stage and value, conversion, engagement, alerts, deal rooms, saved searches, portfolio, NRI services
 *     tags: [Investor Workspace]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Summary }
 *       403: { description: Full CRM not unlocked yet }
 */
router.get('/summary', asyncHandler(async (req, res) => success(res, 200, 'Workspace summary', await workspaceService.getSummary(req.user))));

/**
 * @swagger
 * /workspace/pipeline:
 *   get:
 *     summary: Deal pipeline (Kanban) - Lead, Deal Interest, Due Diligence, Negotiation, Closure, Dropped - with days in stage, SLA status and stage history
 *     tags: [Investor Workspace]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ columns, sla, total, overdue }" } }
 */
router.get('/pipeline', asyncHandler(async (req, res) => success(res, 200, 'Pipeline fetched', await workspaceService.getPipeline(req.user))));

/**
 * @swagger
 * /workspace/activity:
 *   get:
 *     summary: Activity log - stage changes, deal actions, deal-room events and alerts received
 *     tags: [Investor Workspace]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: limit, schema: { type: integer, default: 100 } }]
 *     responses: { 200: { description: Activity items, newest first } }
 */
router.get(
  '/activity',
  [query('limit').optional().isInt({ min: 1, max: 300 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Activity fetched', await workspaceService.getActivity(req.user, req.query)))
);

module.exports = router;
