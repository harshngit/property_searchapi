const express = require('express');
const { query } = require('express-validator');
const router = express.Router();

const brokerController = require('../controllers/broker.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');

const PROPERTY_TYPES = ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'];
const TRANSACTION_TYPES = ['buy', 'sell', 'rent'];
const PROPERTY_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'inactive'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'hot', 'warm', 'cold', 'won', 'lost'];
const LEAD_SOURCES = ['website', 'whatsapp', 'manual', 'campaign'];

/**
 * @swagger
 * tags:
 *   name: Broker Dashboard
 *   description: >
 *     Aggregation layer over leads/properties/tasks for the currently
 *     logged-in user, i.e. "my dashboard/inventory/leads". Every endpoint
 *     here is read-only and reuses lead.service.js/property.service.js/
 *     task.service.js rather than duplicating query logic.
 */

/**
 * @swagger
 * /broker/dashboard:
 *   get:
 *     summary: Summary dashboard for the logged-in broker
 *     description: Assigned lead counts by status, tasks due today, overdue task count, properties listed, and leads won this month.
 *     tags: [Broker Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard fetched successfully
 *       401:
 *         description: Not authenticated
 */
router.get('/dashboard', authenticate, brokerController.getDashboard);

/**
 * @swagger
 * /broker/leads:
 *   get:
 *     summary: Leads assigned to the logged-in user
 *     description: Shortcut over GET /api/leads with assignedTo forced to the caller.
 *     tags: [Broker Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [new, contacted, qualified, hot, warm, cold, won, lost] }
 *       - in: query
 *         name: source
 *         schema: { type: string, enum: [website, whatsapp, manual, campaign] }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Paginated list of the caller's assigned leads
 */
router.get(
  '/leads',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(LEAD_STATUSES),
    query('source').optional().isIn(LEAD_SOURCES),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  validate,
  brokerController.getLeads
);

/**
 * @swagger
 * /broker/inventory:
 *   get:
 *     summary: Properties created by or assigned (as broker) to the logged-in user
 *     description: Shortcut over GET /api/properties filtered to created_by/broker_id = caller.
 *     tags: [Broker Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: city
 *         schema: { type: string }
 *       - in: query
 *         name: propertyType
 *         schema: { type: string, enum: [apartment, villa, independent_house, plot, commercial, farmhouse, other] }
 *       - in: query
 *         name: transactionType
 *         schema: { type: string, enum: [buy, sell, rent] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, pending_approval, approved, rejected, inactive] }
 *     responses:
 *       200:
 *         description: Paginated list of the caller's properties
 */
router.get(
  '/inventory',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('propertyType').optional().isIn(PROPERTY_TYPES),
    query('transactionType').optional().isIn(TRANSACTION_TYPES),
    query('status').optional().isIn(PROPERTY_STATUSES),
  ],
  validate,
  brokerController.getInventory
);

/**
 * @swagger
 * /broker/followups:
 *   get:
 *     summary: Lead follow-up tasks assigned to the logged-in user, due today or overdue
 *     tags: [Broker Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Follow-ups fetched successfully
 */
router.get('/followups', authenticate, brokerController.getFollowups);

/**
 * @swagger
 * /broker/performance-report:
 *   get:
 *     summary: Leads assigned vs. converted (won) and conversion rate for the logged-in user
 *     description: assigned/converted are both scoped by lead creation date via from/to when provided.
 *     tags: [Broker Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Performance report fetched successfully
 */
router.get(
  '/performance-report',
  authenticate,
  [
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
  ],
  validate,
  brokerController.getPerformanceReport
);

module.exports = router;
