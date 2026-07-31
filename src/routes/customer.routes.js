const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const customerController = require('../controllers/customer.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const PROPERTY_TYPES = ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'];
const TRANSACTION_TYPES = ['buy', 'sell', 'rent'];
const MANAGE_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: Customers
 *   description: >
 *     Customer 360 - CRM contact records, preferences, and documents.
 *     All endpoints require authentication; non-admin roles are scoped to
 *     their own tenant's customers.
 */

/**
 * @swagger
 * /customers:
 *   get:
 *     summary: List customers (tenant-scoped for non-admin roles)
 *     tags: [Customers]
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
 *         name: search
 *         schema: { type: string }
 *         description: Matches against full_name, email, or mobile
 *     responses:
 *       200:
 *         description: Paginated list of customers
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  customerController.listCustomers
);

/**
 * @swagger
 * /customers/{id}:
 *   get:
 *     summary: Get a single customer by id
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Customer fetched successfully
 *       404:
 *         description: Customer not found
 */
router.get(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid customer id')],
  validate,
  customerController.getCustomer
);

/**
 * @swagger
 * /customers:
 *   post:
 *     summary: Create a new customer (CRM contact) record
 *     description: Allowed roles broker, agency_admin, internal_sales, admin, super_admin.
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CustomerCreateRequest'
 *     responses:
 *       201:
 *         description: Customer created successfully
 *       403:
 *         description: Role not permitted to create customers
 *       422:
 *         description: Validation failed
 */
router.post(
  '/',
  authenticate,
  authorize(...MANAGE_ROLES),
  [
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('mobile').optional().isMobilePhone().withMessage('Valid mobile number required'),
    body('userId').optional().isUUID(),
  ],
  validate,
  customerController.createCustomer
);

/**
 * @swagger
 * /customers/{id}:
 *   put:
 *     summary: Update a customer record
 *     description: Only the record's creator, an agency_admin within the same tenant, or admin/super_admin may update.
 *     tags: [Customers]
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
 *             $ref: '#/components/schemas/CustomerUpdateRequest'
 *     responses:
 *       200:
 *         description: Customer updated successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Customer not found
 */
router.put(
  '/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid customer id'),
    body('email').optional().isEmail(),
    body('mobile').optional().isMobilePhone(),
    body('userId').optional().isUUID(),
  ],
  validate,
  customerController.updateCustomer
);

/**
 * @swagger
 * /customers/{id}/preferences:
 *   get:
 *     summary: Get a customer's search/budget preferences
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Preferences fetched successfully (null if never set)
 *       404:
 *         description: Customer not found
 */
router.get(
  '/:id/preferences',
  authenticate,
  [param('id').isUUID().withMessage('Invalid customer id')],
  validate,
  customerController.getPreferences
);

/**
 * @swagger
 * /customers/{id}/preferences:
 *   put:
 *     summary: Create or update a customer's search/budget preferences
 *     tags: [Customers]
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
 *             $ref: '#/components/schemas/CustomerPreferencesRequest'
 *     responses:
 *       200:
 *         description: Preferences saved successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Customer not found
 */
router.put(
  '/:id/preferences',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid customer id'),
    body('budgetMin').optional().isFloat({ min: 0 }),
    body('budgetMax').optional().isFloat({ min: 0 }),
    body('preferredLocations').optional().isArray(),
    body('propertyType').optional().isIn(PROPERTY_TYPES),
    body('transactionType').optional().isIn(TRANSACTION_TYPES),
    body('bedrooms').optional().isInt({ min: 0 }),
  ],
  validate,
  customerController.upsertPreferences
);

/**
 * @swagger
 * /customers/{id}/documents:
 *   get:
 *     summary: List documents uploaded for a customer
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Documents fetched successfully
 *       404:
 *         description: Customer not found
 */
router.get(
  '/:id/documents',
  authenticate,
  [param('id').isUUID().withMessage('Invalid customer id')],
  validate,
  customerController.getDocuments
);

/**
 * @swagger
 * /customers/{id}/documents:
 *   post:
 *     summary: Attach a document to a customer
 *     description: >
 *       Accepts a document URL directly in the body. File upload infrastructure
 *       (multer/S3) is not wired up - the caller hosts the document elsewhere
 *       and passes the resulting URL here.
 *     tags: [Customers]
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
 *             $ref: '#/components/schemas/CustomerDocumentCreateRequest'
 *     responses:
 *       201:
 *         description: Document added successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Customer not found
 */
router.post(
  '/:id/documents',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid customer id'),
    body('documentUrl').notEmpty().withMessage('documentUrl is required'),
    body('documentType').optional().isString(),
    body('dealId').optional().isUUID(),
  ],
  validate,
  customerController.addDocument
);

/**
 * @swagger
 * /customers/{id}/conversations:
 *   get:
 *     summary: List a customer's conversations
 *     description: Placeholder - the WhatsApp module has not been built yet. Always returns an empty array for now.
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Conversations fetched (currently always empty)
 *       404:
 *         description: Customer not found
 */
router.get(
  '/:id/conversations',
  authenticate,
  [param('id').isUUID().withMessage('Invalid customer id')],
  validate,
  customerController.getConversations
);

/**
 * @swagger
 * /customers/{id}/deals:
 *   get:
 *     summary: List a customer's deals
 *     description: Placeholder - the Deal Pipeline module has not been built yet. Always returns an empty array for now.
 *     tags: [Customers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deals fetched (currently always empty)
 *       404:
 *         description: Customer not found
 */
router.get(
  '/:id/deals',
  authenticate,
  [param('id').isUUID().withMessage('Invalid customer id')],
  validate,
  customerController.getDeals
);

module.exports = router;
