const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const paymentController = require('../controllers/payment.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const GATEWAYS = ['razorpay', 'payu', 'manual'];
const MILESTONE_STATUSES = ['pending', 'paid', 'overdue', 'waived'];
const MILESTONE_ROLES = ['broker', 'agency_admin', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: Payments
 *   description: >
 *     Payment tracking against deals - initiate/webhook status updates and
 *     payment milestone scheduling. Every endpoint requires authentication
 *     except the gateway webhook. Non-admin roles are scoped to their own
 *     tenant (via the parent deal's tenant_id).
 */

/**
 * @swagger
 * /payments:
 *   get:
 *     summary: List payments across all visible deals (tenant-scoped for non-admins)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [initiated, success, failed, refunded] } }
 *       - { in: query, name: gateway, schema: { type: string, enum: [razorpay, payu, manual] } }
 *       - { in: query, name: dealId, schema: { type: string, format: uuid } }
 *       - { in: query, name: customerId, schema: { type: string, format: uuid } }
 *       - { in: query, name: dateFrom, schema: { type: string, format: date-time } }
 *       - { in: query, name: dateTo, schema: { type: string, format: date-time } }
 *       - { in: query, name: search, schema: { type: string }, description: Customer name or gateway order/payment id }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses:
 *       200: { description: Paginated payments with customer, milestone and property context }
 */
router.get(
  '/',
  authenticate,
  [
    query('status').optional().isIn(['initiated', 'success', 'failed', 'refunded']),
    query('gateway').optional().isIn(GATEWAYS),
    query('dealId').optional().isUUID(),
    query('customerId').optional().isUUID(),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  validate,
  paymentController.listPayments
);

/**
 * @swagger
 * /payments/stats:
 *   get:
 *     summary: Payment headline numbers - collected, pending, failed, outstanding and overdue milestones
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *     responses:
 *       200: { description: Stats }
 */
router.get(
  '/stats',
  authenticate,
  [query('from').optional().isISO8601(), query('to').optional().isISO8601()],
  validate,
  paymentController.getPaymentStats
);

/**
 * @swagger
 * /payments/{id}:
 *   get:
 *     summary: Get a single payment by id
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Payment fetched successfully
 *       404:
 *         description: Payment not found
 */
router.get(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid payment id')],
  validate,
  paymentController.getPayment
);

/**
 * @swagger
 * /payments/deal/{dealId}:
 *   get:
 *     summary: List all payments for a deal
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: dealId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Payments fetched successfully
 *       403:
 *         description: Deal belongs to a different tenant
 *       404:
 *         description: Deal not found
 */
router.get(
  '/deal/:dealId',
  authenticate,
  [param('dealId').isUUID().withMessage('Invalid deal id')],
  validate,
  paymentController.getPaymentsByDeal
);

/**
 * @swagger
 * /payments/milestones/{dealId}:
 *   get:
 *     summary: List all payment milestones for a deal
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: dealId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Milestones fetched successfully
 *       403:
 *         description: Deal belongs to a different tenant
 *       404:
 *         description: Deal not found
 */
router.get(
  '/milestones/:dealId',
  authenticate,
  [param('dealId').isUUID().withMessage('Invalid deal id')],
  validate,
  paymentController.getMilestonesByDeal
);

/**
 * @swagger
 * /payments/milestones:
 *   post:
 *     summary: Create a payment milestone for a deal
 *     description: Allowed roles broker, agency_admin, admin, super_admin.
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MilestoneCreateRequest'
 *     responses:
 *       201:
 *         description: Milestone created successfully
 *       403:
 *         description: Role not permitted, or deal belongs to a different tenant
 *       404:
 *         description: Deal not found
 */
router.post(
  '/milestones',
  authenticate,
  authorize(...MILESTONE_ROLES),
  [
    body('dealId').isUUID().withMessage('dealId is required'),
    body('milestoneName').notEmpty().withMessage('milestoneName is required'),
    body('dueAmount').isFloat({ min: 0 }).withMessage('dueAmount must be a positive number'),
    body('dueDate').isISO8601().withMessage('A valid dueDate is required'),
  ],
  validate,
  paymentController.createMilestone
);

/**
 * @swagger
 * /payments/milestones/{id}:
 *   put:
 *     summary: Update a payment milestone
 *     description: Tenant-scoped for non-admin roles (via the parent deal's tenant_id).
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MilestoneUpdateRequest'
 *     responses:
 *       200:
 *         description: Milestone updated successfully
 *       403:
 *         description: Milestone's deal belongs to a different tenant
 *       404:
 *         description: Milestone not found
 */
router.put(
  '/milestones/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid milestone id'),
    body('dueAmount').optional().isFloat({ min: 0 }),
    body('dueDate').optional().isISO8601(),
    body('status').optional().isIn(MILESTONE_STATUSES),
  ],
  validate,
  paymentController.updateMilestone
);

module.exports = router;
