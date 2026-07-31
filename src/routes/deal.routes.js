const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const dealController = require('../controllers/deal.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const DEAL_STAGES = [
  'inquiry', 'site_visit', 'negotiation', 'booking',
  'documentation', 'payment', 'closed_won', 'closed_lost', 'on_hold',
];
const VISIT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const CREATE_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: Deals
 *   description: >
 *     Deal pipeline - stage-tracked deals with site visits and a full stage
 *     history audit trail. All endpoints require authentication and are
 *     tenant-scoped for non-admin roles: brokers/internal_sales see only
 *     deals where they are the assigned broker; agency_admin sees every
 *     deal in their tenant; admin/super_admin see everything.
 */

/**
 * @swagger
 * /deals:
 *   get:
 *     summary: List deals (scoped per role - see tag description)
 *     tags: [Deals]
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
 *         name: stage
 *         schema: { type: string, enum: [inquiry, site_visit, negotiation, booking, documentation, payment, closed_won, closed_lost, on_hold] }
 *       - in: query
 *         name: brokerId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Paginated list of deals
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('stage').optional().isIn(DEAL_STAGES),
    query('brokerId').optional().isUUID(),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  validate,
  dealController.listDeals
);

/**
 * @swagger
 * /deals/{id}:
 *   get:
 *     summary: Get a single deal, including its site visits and stage history
 *     tags: [Deals]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deal fetched successfully
 *       404:
 *         description: Deal not found
 */
router.get(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid deal id')],
  validate,
  dealController.getDeal
);

/**
 * @swagger
 * /deals:
 *   post:
 *     summary: Create a new deal, starting at stage 'inquiry'
 *     description: >
 *       Allowed roles broker, agency_admin, internal_sales, admin, super_admin.
 *       Pass `leadId` to auto-link `customerId`/`propertyId`/`brokerId` from
 *       that lead (explicit body fields still take priority over the lead's).
 *     tags: [Deals]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DealCreateRequest'
 *     responses:
 *       201:
 *         description: Deal created successfully
 *       400:
 *         description: customerId or brokerId could not be resolved
 *       403:
 *         description: Role not permitted to create deals
 *       422:
 *         description: Validation failed
 */
router.post(
  '/',
  authenticate,
  authorize(...CREATE_ROLES),
  [
    body('leadId').optional().isUUID(),
    body('customerId').optional().isUUID(),
    body('propertyId').optional().isUUID(),
    body('unitId').optional().isUUID(),
    body('brokerId').optional().isUUID(),
    body('dealValue').optional().isFloat({ min: 0 }),
    body('commissionAmount').optional().isFloat({ min: 0 }),
    body('commissionPercent').optional().isFloat({ min: 0 }),
  ],
  validate,
  dealController.createDeal
);

/**
 * @swagger
 * /deals/{id}:
 *   put:
 *     summary: Update a deal's linked property/unit/broker or financials
 *     description: Only the assigned broker, an agency_admin within the same tenant, or admin/super_admin may update. Does not change stage - use PUT /deals/{id}/stage for that.
 *     tags: [Deals]
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
 *             $ref: '#/components/schemas/DealUpdateRequest'
 *     responses:
 *       200:
 *         description: Deal updated successfully
 *       403:
 *         description: Not the assigned broker/tenant manager/admin
 *       404:
 *         description: Deal not found
 */
router.put(
  '/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid deal id'),
    body('propertyId').optional().isUUID(),
    body('unitId').optional().isUUID(),
    body('brokerId').optional().isUUID(),
    body('dealValue').optional().isFloat({ min: 0 }),
    body('commissionAmount').optional().isFloat({ min: 0 }),
    body('commissionPercent').optional().isFloat({ min: 0 }),
  ],
  validate,
  dealController.updateDeal
);

/**
 * @swagger
 * /deals/{id}/stage:
 *   put:
 *     summary: Move a deal to a new pipeline stage
 *     description: >
 *       Validated against a fixed allowed-transitions map (e.g. `inquiry` can
 *       only move to `site_visit`, `on_hold`, or `closed_lost` - never
 *       directly to `closed_won`). Every change is recorded in
 *       `deal_stage_history` automatically, in the same transaction.
 *     tags: [Deals]
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
 *             type: object
 *             required: [stage]
 *             properties:
 *               stage:
 *                 type: string
 *                 enum: [inquiry, site_visit, negotiation, booking, documentation, payment, closed_won, closed_lost, on_hold]
 *               notes: { type: string, example: "Customer confirmed site visit for Saturday." }
 *     responses:
 *       200:
 *         description: Deal stage updated successfully
 *       400:
 *         description: Stage transition not allowed from the deal's current stage
 *       403:
 *         description: Not the assigned broker/tenant manager/admin
 *       404:
 *         description: Deal not found
 */
router.put(
  '/:id/stage',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid deal id'),
    body('stage').isIn(DEAL_STAGES).withMessage('Invalid deal stage'),
    body('notes').optional().isString(),
  ],
  validate,
  dealController.changeStage
);

/**
 * @swagger
 * /deals/{id}/site-visit:
 *   post:
 *     summary: Schedule a site visit for a deal
 *     tags: [Deals]
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
 *             type: object
 *             required: [scheduledAt]
 *             properties:
 *               scheduledAt: { type: string, format: date-time }
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Site visit scheduled successfully
 *       403:
 *         description: Not the assigned broker/tenant manager/admin
 *       404:
 *         description: Deal not found
 */
router.post(
  '/:id/site-visit',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid deal id'),
    body('scheduledAt').isISO8601().withMessage('A valid scheduledAt is required'),
    body('notes').optional().isString(),
  ],
  validate,
  dealController.scheduleSiteVisit
);

/**
 * @swagger
 * /deals/{id}/site-visit/{visitId}:
 *   put:
 *     summary: Update a site visit's status/notes/actual visit time
 *     tags: [Deals]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: visitId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               scheduledAt: { type: string, format: date-time }
 *               actualVisitAt: { type: string, format: date-time }
 *               status: { type: string, enum: [scheduled, completed, cancelled, no_show] }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Site visit updated successfully
 *       403:
 *         description: Not the assigned broker/tenant manager/admin
 *       404:
 *         description: Deal or site visit not found
 */
router.put(
  '/:id/site-visit/:visitId',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid deal id'),
    param('visitId').isUUID().withMessage('Invalid site visit id'),
    body('scheduledAt').optional().isISO8601(),
    body('actualVisitAt').optional().isISO8601(),
    body('status').optional().isIn(VISIT_STATUSES),
    body('notes').optional().isString(),
  ],
  validate,
  dealController.updateSiteVisit
);

/**
 * @swagger
 * /deals/{id}/negotiation:
 *   post:
 *     summary: Log a negotiation round (offer amount/notes) against a deal
 *     description: Adds a same-stage entry to deal_stage_history - does not itself change the deal's stage. Use PUT /deals/{id}/stage to actually move into/out of the negotiation stage.
 *     tags: [Deals]
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
 *             type: object
 *             properties:
 *               offerAmount: { type: number, example: 8200000 }
 *               notes: { type: string, example: "Buyer countered at 82L, seller reviewing." }
 *     responses:
 *       201:
 *         description: Negotiation logged successfully
 *       403:
 *         description: Not the assigned broker/tenant manager/admin
 *       404:
 *         description: Deal not found
 */
router.post(
  '/:id/negotiation',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid deal id'),
    body('offerAmount').optional().isFloat({ min: 0 }),
    body('notes').optional().isString(),
  ],
  validate,
  dealController.logNegotiation
);

/**
 * @swagger
 * /deals/{id}/booking:
 *   post:
 *     summary: Record booking details and move the deal to the 'booking' stage
 *     description: Only valid from stages that allow a transition to 'booking' (normally 'negotiation') - see the deal stage transition map.
 *     tags: [Deals]
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
 *             type: object
 *             properties:
 *               bookingAmount: { type: number, example: 500000 }
 *               notes: { type: string, example: "Token amount received via bank transfer." }
 *     responses:
 *       200:
 *         description: Booking recorded, deal moved to booking stage
 *       400:
 *         description: Stage transition not allowed from the deal's current stage
 *       403:
 *         description: Not the assigned broker/tenant manager/admin
 *       404:
 *         description: Deal not found
 */
router.post(
  '/:id/booking',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid deal id'),
    body('bookingAmount').optional().isFloat({ min: 0 }),
    body('notes').optional().isString(),
  ],
  validate,
  dealController.recordBooking
);

/**
 * @swagger
 * /deals/{id}/close:
 *   put:
 *     summary: Close a deal as won or lost
 *     description: Sets closed_at and moves stage to closed_won or closed_lost, validated against the same stage transition map as PUT /deals/{id}/stage.
 *     tags: [Deals]
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
 *             type: object
 *             required: [outcome]
 *             properties:
 *               outcome: { type: string, enum: [won, lost] }
 *               reason: { type: string, example: "Buyer backed out due to loan rejection." }
 *     responses:
 *       200:
 *         description: Deal closed successfully
 *       400:
 *         description: Stage transition not allowed from the deal's current stage
 *       403:
 *         description: Not the assigned broker/tenant manager/admin
 *       404:
 *         description: Deal not found
 */
router.put(
  '/:id/close',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid deal id'),
    body('outcome').isIn(['won', 'lost']).withMessage('outcome must be "won" or "lost"'),
    body('reason').optional().isString(),
  ],
  validate,
  dealController.closeDeal
);

module.exports = router;
