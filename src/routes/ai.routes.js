const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const aiController = require('../controllers/ai.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const AI_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: AI
 *   description: >
 *     AI-assisted lead qualification - extracts budget/location/property
 *     type/intent/timeline from a lead's notes via the Anthropic API,
 *     summarizes, and scores hot/warm/cold. All endpoints require
 *     authentication and are tenant-scoped (via the parent lead). An AI
 *     failure never breaks other flows - see ai.service.js.
 */

/**
 * @swagger
 * /ai/lead-summary:
 *   post:
 *     summary: Extract structured insights from a lead's notes and save them
 *     description: >
 *       Calls the Anthropic API with the lead's notes/inquiry text, extracts
 *       budget/location/property type/intent/timeline as structured JSON,
 *       and saves a new ai_lead_insights row. This same call runs
 *       automatically right after a lead is created (see lead.service.js).
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [leadId]
 *             properties:
 *               leadId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Lead summary generated successfully
 *       404:
 *         description: Lead not found
 *       422:
 *         description: Validation failed
 *       502:
 *         description: AI extraction failed
 */
router.post(
  '/lead-summary',
  authenticate,
  authorize(...AI_ROLES),
  [body('leadId').isUUID().withMessage('leadId is required')],
  validate,
  aiController.leadSummary
);

/**
 * @swagger
 * /ai/lead-score:
 *   post:
 *     summary: Score a lead hot/warm/cold, combining AI insight with a rule-based scorer
 *     description: >
 *       Re-runs insight extraction, then blends it with a simple rule-based
 *       scorer (budget-on-file, engagement recency, source quality) - 60%
 *       rule-based, 40% the AI's own hot/warm/cold read - and saves the
 *       final score.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [leadId]
 *             properties:
 *               leadId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Lead score computed successfully
 *       404:
 *         description: Lead not found
 *       422:
 *         description: Validation failed
 *       502:
 *         description: AI extraction failed
 */
router.post(
  '/lead-score',
  authenticate,
  authorize(...AI_ROLES),
  [body('leadId').isUUID().withMessage('leadId is required')],
  validate,
  aiController.leadScore
);

/**
 * @swagger
 * /ai/extract-intent:
 *   post:
 *     summary: Lightweight preview extraction - returns fields without saving
 *     description: Useful for a "preview before save" UI flow.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [leadId]
 *             properties:
 *               leadId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Intent extracted successfully
 *       404:
 *         description: Lead not found
 *       422:
 *         description: Validation failed
 *       502:
 *         description: AI extraction failed
 */
router.post(
  '/extract-intent',
  authenticate,
  authorize(...AI_ROLES),
  [body('leadId').isUUID().withMessage('leadId is required')],
  validate,
  aiController.extractIntent
);

/**
 * @swagger
 * /ai/lead/{id}/analysis:
 *   get:
 *     summary: Get the most recently saved AI insight for a lead
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lead analysis fetched successfully (null if none saved yet)
 *       404:
 *         description: Lead not found
 */
router.get(
  '/lead/:id/analysis',
  authenticate,
  [param('id').isUUID().withMessage('Invalid lead id')],
  validate,
  aiController.getAnalysis
);

/**
 * @swagger
 * /ai/insights:
 *   get:
 *     summary: Recent AI qualifications - latest insight per lead with its human review, if any
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: score, schema: { type: string, enum: [hot, warm, cold] }, description: Filters on the effective (post-review) score }
 *       - { in: query, name: reviewed, schema: { type: boolean } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses:
 *       200: { description: Paginated insights }
 */
router.get(
  '/insights',
  authenticate,
  authorize(...AI_ROLES),
  [query('score').optional().isIn(['hot', 'warm', 'cold']), query('reviewed').optional().isBoolean()],
  validate,
  aiController.listInsights
);

/**
 * @swagger
 * /ai/stats:
 *   get:
 *     summary: AI qualification headline stats (leads qualified, avg confidence, score mix, overrides, agreement rate)
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: days, schema: { type: integer, default: 7 } }
 *     responses:
 *       200: { description: Stats }
 */
router.get('/stats', authenticate, authorize(...AI_ROLES), [query('days').optional().isInt({ min: 1, max: 365 })], validate, aiController.getStats);

/**
 * @swagger
 * /ai/lead/{id}/review:
 *   post:
 *     summary: Confirm or override the latest AI score for a lead
 *     description: Recorded append-only. An override also moves a hot/warm/cold-stage lead's status to the new score, with an activity-log entry.
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action: { type: string, enum: [confirm, override] }
 *               score: { type: string, enum: [hot, warm, cold], description: Required for override }
 *               reason: { type: string }
 *     responses:
 *       201: { description: Review recorded }
 *       404: { description: Lead has no AI insight yet }
 */
router.post(
  '/lead/:id/review',
  authenticate,
  authorize(...AI_ROLES),
  [
    param('id').isUUID().withMessage('Invalid lead id'),
    body('action').isIn(['confirm', 'override']),
    body('score').optional().isIn(['hot', 'warm', 'cold']),
    body('reason').optional().isString(),
  ],
  validate,
  aiController.reviewInsight
);

module.exports = router;
