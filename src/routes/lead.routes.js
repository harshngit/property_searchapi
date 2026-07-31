const express = require('express');
const { body, param, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const leadController = require('../controllers/lead.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const LEAD_SOURCES = ['website', 'whatsapp', 'manual', 'campaign'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'hot', 'warm', 'cold', 'won', 'lost'];
const CREATE_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];
const ASSIGN_ROLES = ['agency_admin', 'internal_sales', 'admin', 'super_admin'];

// Public lead capture is unauthenticated, so it's the one endpoint in this
// module exposed directly to the internet - keep it tightly rate limited.
const publicInquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/**
 * @swagger
 * tags:
 *   name: Leads
 *   description: >
 *     Lead management - capture, assignment, status workflow, notes, and
 *     activity audit trail. All endpoints require authentication and are
 *     tenant-scoped for non-admin roles, except `/leads/public-inquiry`
 *     which is the public, unauthenticated capture endpoint.
 */

/**
 * @swagger
 * /leads:
 *   get:
 *     summary: List leads (tenant-scoped for non-admin roles)
 *     tags: [Leads]
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
 *         name: assignedTo
 *         schema: { type: string, format: uuid }
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
 *         description: Paginated list of leads
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(LEAD_STATUSES),
    query('assignedTo').optional().isUUID(),
    query('source').optional().isIn(LEAD_SOURCES),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  validate,
  leadController.listLeads
);

/**
 * @swagger
 * /leads/public-inquiry:
 *   post:
 *     summary: Public lead capture from the website/other public channels
 *     description: >
 *       No authentication required. Rate limited to 10 requests per 15
 *       minutes per IP. Finds-or-creates a customer record by email/mobile
 *       and opens a new lead against it with status `new`.
 *     tags: [Leads]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PublicInquiryRequest'
 *     responses:
 *       201:
 *         description: Inquiry received successfully
 *       422:
 *         description: Validation failed
 *       429:
 *         description: Too many requests
 */
router.post(
  '/public-inquiry',
  publicInquiryLimiter,
  [
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('mobile').optional().isMobilePhone().withMessage('Valid mobile number required'),
    body().custom((value) => {
      if (!value.email && !value.mobile) {
        throw new Error('Either email or mobile is required');
      }
      return true;
    }),
    body('propertyId').optional().isUUID(),
    body('message').optional().isString().isLength({ max: 2000 }),
    body('source').optional().isIn(LEAD_SOURCES),
  ],
  validate,
  leadController.createPublicInquiry
);

/**
 * @swagger
 * /leads/{id}:
 *   get:
 *     summary: Get a single lead by id
 *     tags: [Leads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lead fetched successfully
 *       404:
 *         description: Lead not found
 */
router.get(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid lead id')],
  validate,
  leadController.getLead
);

/**
 * @swagger
 * /leads:
 *   post:
 *     summary: Create a new lead against an existing customer
 *     description: Allowed roles broker, agency_admin, internal_sales, admin, super_admin.
 *     tags: [Leads]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LeadCreateRequest'
 *     responses:
 *       201:
 *         description: Lead created successfully
 *       403:
 *         description: Role not permitted to create leads
 *       422:
 *         description: Validation failed
 */
router.post(
  '/',
  authenticate,
  authorize(...CREATE_ROLES),
  [
    body('customerId').isUUID().withMessage('customerId is required'),
    body('source').optional().isIn(LEAD_SOURCES),
    body('propertyId').optional().isUUID(),
    body('assignedTo').optional().isUUID(),
  ],
  validate,
  leadController.createLead
);

/**
 * @swagger
 * /leads/{id}:
 *   put:
 *     summary: Update a lead's source/property association
 *     description: Only the lead's creator, assignee, an agency_admin within the same tenant, or admin/super_admin may update.
 *     tags: [Leads]
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
 *             $ref: '#/components/schemas/LeadUpdateRequest'
 *     responses:
 *       200:
 *         description: Lead updated successfully
 *       403:
 *         description: Not the owner/assignee/tenant manager/admin
 *       404:
 *         description: Lead not found
 */
router.put(
  '/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid lead id'),
    body('source').optional().isIn(LEAD_SOURCES),
    body('propertyId').optional().isUUID(),
  ],
  validate,
  leadController.updateLead
);

/**
 * @swagger
 * /leads/{id}/assign:
 *   put:
 *     summary: Assign or reassign a lead to a user
 *     description: Allowed roles agency_admin, internal_sales, admin, super_admin. The assignee must belong to the caller's tenant (unless the caller is admin/super_admin).
 *     tags: [Leads]
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
 *             required: [assignedTo]
 *             properties:
 *               assignedTo: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Lead assigned successfully
 *       400:
 *         description: Assignee not found or outside the caller's tenant
 *       403:
 *         description: Role not permitted to (re)assign leads
 *       404:
 *         description: Lead not found
 */
router.put(
  '/:id/assign',
  authenticate,
  authorize(...ASSIGN_ROLES),
  [
    param('id').isUUID().withMessage('Invalid lead id'),
    body('assignedTo').isUUID().withMessage('assignedTo is required'),
  ],
  validate,
  leadController.assignLead
);

/**
 * @swagger
 * /leads/{id}/status:
 *   put:
 *     summary: Update a lead's status
 *     description: Only the lead's creator, assignee, an agency_admin within the same tenant, or admin/super_admin may update. Every change is recorded in the activity log automatically.
 *     tags: [Leads]
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
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [new, contacted, qualified, hot, warm, cold, won, lost]
 *                 example: contacted
 *     responses:
 *       200:
 *         description: Lead status updated successfully
 *       403:
 *         description: Not the owner/assignee/tenant manager/admin
 *       404:
 *         description: Lead not found
 */
router.put(
  '/:id/status',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid lead id'),
    body('status').isIn(LEAD_STATUSES).withMessage('Invalid lead status'),
  ],
  validate,
  leadController.updateStatus
);

/**
 * @swagger
 * /leads/{id}/notes:
 *   post:
 *     summary: Add a note to a lead
 *     tags: [Leads]
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
 *             required: [note]
 *             properties:
 *               note: { type: string, example: "Called customer, interested in a site visit next weekend." }
 *     responses:
 *       201:
 *         description: Note added successfully
 *       403:
 *         description: Not the owner/assignee/tenant manager/admin
 *       404:
 *         description: Lead not found
 */
router.post(
  '/:id/notes',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid lead id'),
    body('note').notEmpty().withMessage('Note text is required'),
  ],
  validate,
  leadController.addNote
);

/**
 * @swagger
 * /leads/{id}/timeline:
 *   get:
 *     summary: Get a lead's combined notes + activity log, in chronological order
 *     tags: [Leads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Timeline fetched successfully
 *       404:
 *         description: Lead not found
 */
router.get(
  '/:id/timeline',
  authenticate,
  [param('id').isUUID().withMessage('Invalid lead id')],
  validate,
  leadController.getTimeline
);

/**
 * @swagger
 * /leads/{id}/activity:
 *   get:
 *     summary: Get a lead's activity log only (status changes, assignments, creation)
 *     tags: [Leads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Activity log fetched successfully
 *       404:
 *         description: Lead not found
 */
router.get(
  '/:id/activity',
  authenticate,
  [param('id').isUUID().withMessage('Invalid lead id')],
  validate,
  leadController.getActivity
);

module.exports = router;
