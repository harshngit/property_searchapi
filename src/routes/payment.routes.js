const express = require('express');
const { body, param } = require('express-validator');
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
 * /payments/initiate:
 *   post:
 *     summary: Initiate a payment against a deal
 *     description: >
 *       Creates a `payments` row with status `initiated` and returns a
 *       stubbed gateway order payload - no live Razorpay/PayU call is made.
 *       See the TODO comments in payment.service.js for exactly where a
 *       real gateway SDK call would replace the stub.
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PaymentInitiateRequest'
 *     responses:
 *       201:
 *         description: Payment initiated successfully
 *       403:
 *         description: Deal belongs to a different tenant
 *       404:
 *         description: Deal not found
 *       422:
 *         description: Validation failed
 */
router.post(
  '/initiate',
  authenticate,
  [
    body('dealId').isUUID().withMessage('dealId is required'),
    body('customerId').isUUID().withMessage('customerId is required'),
    body('amount').isFloat({ min: 0 }).withMessage('amount must be a positive number'),
    body('milestoneId').optional().isUUID(),
    body('currency').optional().isString().isLength({ min: 3, max: 3 }),
    body('gateway').optional().isIn(GATEWAYS),
  ],
  validate,
  paymentController.initiatePayment
);

/**
 * @swagger
 * /payments/webhook:
 *   post:
 *     summary: Gateway webhook - updates payment status and cascades to its milestone
 *     description: >
 *       Public endpoint (no authentication) - this is what a payment
 *       gateway calls directly. Signature verification is stubbed (see the
 *       TODO in payment.service.js#handleWebhook) - only presence of a
 *       `gatewaySignature` is currently checked, not its validity. Updates
 *       `payments.status` and, on success with a linked milestone, sets
 *       `payment_milestones.status = 'paid'` in the same transaction.
 *     tags: [Payments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PaymentWebhookRequest'
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       400:
 *         description: Missing signature or invalid status value
 *       404:
 *         description: No payment found for the given gatewayOrderId
 */
router.post(
  '/webhook',
  [
    body('gatewayOrderId').notEmpty().withMessage('gatewayOrderId is required'),
    body('gatewaySignature').notEmpty().withMessage('gatewaySignature is required'),
    body('status').isIn(['success', 'failed', 'refunded']).withMessage('Invalid status'),
    body('gatewayPaymentId').optional().isString(),
  ],
  validate,
  paymentController.handleWebhook
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
