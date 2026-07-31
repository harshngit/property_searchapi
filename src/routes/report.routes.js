const express = require('express');
const { query } = require('express-validator');
const router = express.Router();

const reportController = require('../controllers/report.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const REPORT_TYPES = ['leads', 'properties', 'brokers', 'conversion', 'payments', 'revenue'];
const MANAGER_ROLES = ['admin', 'super_admin', 'agency_admin'];
const dateRangeValidators = [query('from').optional().isISO8601(), query('to').optional().isISO8601()];

/**
 * @swagger
 * tags:
 *   name: Reports
 *   description: >
 *     Aggregation-only analytics over leads/properties/deals/tasks/payments.
 *     Restricted to admin, super_admin, and agency_admin, except
 *     GET /reports/brokers and GET /reports/export?report=brokers, which
 *     brokers may also call - always forced to their own data.
 */

/**
 * @swagger
 * /reports/leads:
 *   get:
 *     summary: Lead counts by status, source, and assigned user
 *     tags: [Reports]
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
 *         description: Report generated successfully
 *       403:
 *         description: Not authorized (admin/super_admin/agency_admin only)
 */
router.get('/leads', authenticate, authorize(...MANAGER_ROLES), dateRangeValidators, validate, reportController.getLeadsReport);

/**
 * @swagger
 * /reports/properties:
 *   get:
 *     summary: Property counts by status, type, transaction type, and inquiries per listing
 *     tags: [Reports]
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
 *         description: Report generated successfully
 *       403:
 *         description: Not authorized (admin/super_admin/agency_admin only)
 */
router.get('/properties', authenticate, authorize(...MANAGER_ROLES), dateRangeValidators, validate, reportController.getPropertiesReport);

/**
 * @swagger
 * /reports/brokers:
 *   get:
 *     summary: Leads assigned vs. converted, and tasks completed vs. overdue, per broker
 *     description: brokers may call this endpoint, but only ever see their own numbers - `brokerId` is ignored/forced to the caller when role is `broker`.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: brokerId
 *         schema: { type: string, format: uuid }
 *         description: Restrict to a single broker. Ignored (forced to self) for callers with the broker role.
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Report generated successfully
 *       403:
 *         description: Not authorized
 */
router.get(
  '/brokers',
  authenticate,
  authorize(...MANAGER_ROLES, 'broker'),
  [...dateRangeValidators, query('brokerId').optional().isUUID()],
  validate,
  reportController.getBrokersReport
);

/**
 * @swagger
 * /reports/conversion:
 *   get:
 *     summary: Conversion funnel - leads -> site visits -> negotiation -> booking -> closed_won
 *     description: Stage counts reflect deals that ever reached that stage (from deal_stage_history), plus the percentage drop-off from the previous stage.
 *     tags: [Reports]
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
 *         description: Report generated successfully
 *       403:
 *         description: Not authorized (admin/super_admin/agency_admin only)
 */
router.get('/conversion', authenticate, authorize(...MANAGER_ROLES), dateRangeValidators, validate, reportController.getConversionFunnel);

/**
 * @swagger
 * /reports/payments:
 *   get:
 *     summary: Total collected, pending, and overdue payment amounts
 *     tags: [Reports]
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
 *         description: Report generated successfully
 *       403:
 *         description: Not authorized (admin/super_admin/agency_admin only)
 */
router.get('/payments', authenticate, authorize(...MANAGER_ROLES), dateRangeValidators, validate, reportController.getPaymentsReport);

/**
 * @swagger
 * /reports/revenue:
 *   get:
 *     summary: Total closed-won deal value and commission, broken down by broker and by agency (tenant)
 *     tags: [Reports]
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
 *         description: Report generated successfully
 *       403:
 *         description: Not authorized (admin/super_admin/agency_admin only)
 */
router.get('/revenue', authenticate, authorize(...MANAGER_ROLES), dateRangeValidators, validate, reportController.getRevenueReport);

/**
 * @swagger
 * /reports/export:
 *   get:
 *     summary: Export any of the above reports as CSV
 *     description: >
 *       Returns `text/csv` with a `Content-Disposition: attachment` header -
 *       **not** the standard `success()`/`error()` JSON envelope used
 *       elsewhere in this API. The report's (possibly nested) JSON shape is
 *       flattened into generic `metric,value` rows. Brokers may only export
 *       `report=brokers`, and only ever see their own data.
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: report
 *         required: true
 *         schema: { type: string, enum: [leads, properties, brokers, conversion, payments, revenue] }
 *       - in: query
 *         name: brokerId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       403:
 *         description: Not authorized, or a broker requesting a report type other than "brokers"
 */
router.get(
  '/export',
  authenticate,
  authorize(...MANAGER_ROLES, 'broker'),
  [...dateRangeValidators, query('report').isIn(REPORT_TYPES).withMessage('Invalid report type'), query('brokerId').optional().isUUID()],
  validate,
  reportController.exportReport
);

module.exports = router;
