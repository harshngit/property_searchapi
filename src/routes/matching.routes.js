const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const matchingController = require('../controllers/matching.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const MATCHING_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];

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

module.exports = router;
