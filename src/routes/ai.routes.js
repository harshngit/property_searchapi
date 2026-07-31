const express = require('express');
const { body, param } = require('express-validator');
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

module.exports = router;
