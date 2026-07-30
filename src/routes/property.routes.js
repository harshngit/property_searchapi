const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const propertyController = require('../controllers/property.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const PROPERTY_TYPES = ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'];
const TRANSACTION_TYPES = ['buy', 'sell', 'rent'];
const PROPERTY_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'inactive'];
const CREATE_ROLES = ['broker', 'agency_admin', 'builder', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: Properties
 *   description: >
 *     Property listing management (create, update, approve, media, pricing,
 *     availability). All endpoints here require authentication; non-admin
 *     roles are scoped to their own tenant's listings. For public,
 *     unauthenticated browsing use the `/search` endpoints instead.
 */

/**
 * @swagger
 * /properties:
 *   get:
 *     summary: List properties (tenant-scoped for non-admin roles)
 *     tags: [Properties]
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
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Paginated list of properties
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('propertyType').optional().isIn(PROPERTY_TYPES),
    query('transactionType').optional().isIn(TRANSACTION_TYPES),
    query('status').optional().isIn(PROPERTY_STATUSES),
    query('minPrice').optional().isFloat({ min: 0 }),
    query('maxPrice').optional().isFloat({ min: 0 }),
  ],
  validate,
  propertyController.listProperties
);

/**
 * @swagger
 * /properties/{id}:
 *   get:
 *     summary: Get a single property by id
 *     tags: [Properties]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Property fetched successfully
 *       404:
 *         description: Property not found
 */
router.get(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  propertyController.getProperty
);

/**
 * @swagger
 * /properties:
 *   post:
 *     summary: Create a new property listing
 *     description: Allowed roles broker, agency_admin, builder, admin, super_admin. New listings start as `pending_approval`.
 *     tags: [Properties]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PropertyCreateRequest'
 *     responses:
 *       201:
 *         description: Property created successfully
 *       403:
 *         description: Role not permitted to create listings
 *       422:
 *         description: Validation failed
 */
router.post(
  '/',
  authenticate,
  authorize(...CREATE_ROLES),
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('propertyType').isIn(PROPERTY_TYPES).withMessage('Invalid property type'),
    body('transactionType').isIn(TRANSACTION_TYPES).withMessage('Invalid transaction type'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
    body('city').notEmpty().withMessage('City is required'),
    body('locality').optional().isString(),
    body('address').optional().isString(),
    body('latitude').optional().isFloat(),
    body('longitude').optional().isFloat(),
    body('areaSqft').optional().isFloat({ min: 0 }),
    body('bedrooms').optional().isInt({ min: 0 }),
    body('bathrooms').optional().isInt({ min: 0 }),
    body('amenities').optional().isArray(),
  ],
  validate,
  propertyController.createProperty
);

/**
 * @swagger
 * /properties/{id}:
 *   put:
 *     summary: Update a property listing
 *     description: Only the listing owner (creator), an agency_admin within the same tenant, or admin/super_admin may update.
 *     tags: [Properties]
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
 *             $ref: '#/components/schemas/PropertyUpdateRequest'
 *     responses:
 *       200:
 *         description: Property updated successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property not found
 */
router.put(
  '/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid property id'),
    body('propertyType').optional().isIn(PROPERTY_TYPES),
    body('transactionType').optional().isIn(TRANSACTION_TYPES),
    body('areaSqft').optional().isFloat({ min: 0 }),
    body('bedrooms').optional().isInt({ min: 0 }),
    body('bathrooms').optional().isInt({ min: 0 }),
    body('amenities').optional().isArray(),
  ],
  validate,
  propertyController.updateProperty
);

/**
 * @swagger
 * /properties/{id}:
 *   delete:
 *     summary: Delete a property listing
 *     description: Only the listing owner, an agency_admin within the same tenant, or admin/super_admin may delete.
 *     tags: [Properties]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Property deleted successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property not found
 */
router.delete(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  propertyController.deleteProperty
);

/**
 * @swagger
 * /properties/{id}/media:
 *   post:
 *     summary: Attach media (images/videos) to a property
 *     description: >
 *       Accepts media URLs directly in the body. File upload infrastructure
 *       (multer/S3) is not wired up yet - the caller is expected to host the
 *       media elsewhere and pass the resulting URLs here.
 *     tags: [Properties]
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
 *             required: [media]
 *             properties:
 *               media:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [url]
 *                   properties:
 *                     url: { type: string, example: "https://cdn.example.com/property1.jpg" }
 *                     mediaType: { type: string, enum: [image, video], example: image }
 *                     displayOrder: { type: integer, example: 0 }
 *                     isPrimary: { type: boolean, example: true }
 *     responses:
 *       201:
 *         description: Media attached successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property not found
 */
router.post(
  '/:id/media',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid property id'),
    body('media').isArray({ min: 1 }).withMessage('media must be a non-empty array'),
    body('media.*.url').notEmpty().withMessage('Each media item requires a url'),
    body('media.*.mediaType').optional().isIn(['image', 'video']),
  ],
  validate,
  propertyController.addMedia
);

/**
 * @swagger
 * /properties/{id}/media/{mediaId}:
 *   delete:
 *     summary: Remove a media item from a property
 *     tags: [Properties]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: mediaId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Media removed successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property or media not found
 */
router.delete(
  '/:id/media/:mediaId',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid property id'),
    param('mediaId').isUUID().withMessage('Invalid media id'),
  ],
  validate,
  propertyController.deleteMedia
);

/**
 * @swagger
 * /properties/{id}/availability:
 *   put:
 *     summary: Toggle whether an approved property is currently available/live
 *     description: Can only be used once a property has been approved at least once (toggles between `approved` and `inactive`).
 *     tags: [Properties]
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
 *             required: [isAvailable]
 *             properties:
 *               isAvailable: { type: boolean, example: true }
 *     responses:
 *       200:
 *         description: Availability updated
 *       400:
 *         description: Property has not been approved yet
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property not found
 */
router.put(
  '/:id/availability',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid property id'),
    body('isAvailable').isBoolean().withMessage('isAvailable must be a boolean'),
  ],
  validate,
  propertyController.updateAvailability
);

/**
 * @swagger
 * /properties/{id}/pricing:
 *   put:
 *     summary: Update the price of a property
 *     tags: [Properties]
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
 *             required: [price]
 *             properties:
 *               price: { type: number, example: 8500000 }
 *     responses:
 *       200:
 *         description: Pricing updated
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property not found
 */
router.put(
  '/:id/pricing',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid property id'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  ],
  validate,
  propertyController.updatePricing
);

/**
 * @swagger
 * /properties/{id}/approve:
 *   put:
 *     summary: Approve a pending property listing
 *     tags: [Properties]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Property approved
 *       403:
 *         description: Not authorized (admin/super_admin only)
 *       404:
 *         description: Property not found
 */
router.put(
  '/:id/approve',
  authenticate,
  authorize('admin', 'super_admin'),
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  propertyController.approveProperty
);

/**
 * @swagger
 * /properties/{id}/reject:
 *   put:
 *     summary: Reject a pending property listing
 *     tags: [Properties]
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
 *             required: [reason]
 *             properties:
 *               reason: { type: string, example: "Listing photos do not match the address provided" }
 *     responses:
 *       200:
 *         description: Property rejected
 *       403:
 *         description: Not authorized (admin/super_admin only)
 *       404:
 *         description: Property not found
 */
router.put(
  '/:id/reject',
  authenticate,
  authorize('admin', 'super_admin'),
  [
    param('id').isUUID().withMessage('Invalid property id'),
    body('reason').notEmpty().withMessage('A rejection reason is required'),
  ],
  validate,
  propertyController.rejectProperty
);

/**
 * @swagger
 * /properties/{id}/inquiries:
 *   get:
 *     summary: List inquiries raised against a property
 *     description: Placeholder - the Lead/Inquiry module has not been built yet. Always returns an empty array for now.
 *     tags: [Properties]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Inquiries fetched (currently always empty)
 */
router.get(
  '/:id/inquiries',
  authenticate,
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  propertyController.getPropertyInquiries
);

module.exports = router;
