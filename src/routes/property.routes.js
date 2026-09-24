const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const propertyController = require('../controllers/property.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadPropertyMedia } = require('../middlewares/upload');

const PROPERTY_TYPES = ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'];
const TRANSACTION_TYPES = ['buy', 'sell', 'rent'];
const PROPERTY_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'inactive'];
const LISTING_CATEGORIES = ['residential', 'institutional', 'special_situation', 'auction'];
const CREATE_ROLES = ['broker', 'agency_admin', 'builder', 'admin', 'super_admin'];

// Shared across POST /properties and PUT /properties/:id - the fields
// added alongside the price/rate/favorites change (rate, listing
// category, market-trend and per-category variant fields).
const EXTENDED_FIELD_VALIDATORS = [
  body('rate').optional().isFloat({ min: 0 }).withMessage('Rate must be a positive number'),
  body('listingCategory').optional().isIn(LISTING_CATEGORIES).withMessage('Invalid listing category'),
  body('annualAppreciationPercent').optional().isFloat().withMessage('annualAppreciationPercent must be a number'),
  body('estimatedRentMonthly').optional().isFloat({ min: 0 }),
  body('localityRating').optional().isFloat({ min: 0, max: 5 }),
  body('auctionDate').optional().isISO8601().withMessage('auctionDate must be a valid date/time'),
  body('sourceBank').optional().isString().isLength({ max: 150 }),
  body('occupancyPercent').optional().isFloat({ min: 0, max: 100 }),
  body('yieldPercent').optional().isFloat({ min: 0 }),
  body('yieldQualifier').optional().isString().isLength({ max: 100 }),
];

// Also shared across POST /properties and PUT /properties/:id - display
// fields the dashboard frontend already reads/writes (about section, RERA,
// floor/furnishing/parking details, tags, badge, verified flag, FAQs).
const DISPLAY_FIELD_VALIDATORS = [
  body('aboutExtended').optional().isString(),
  body('carpetAreaSqft').optional().isFloat({ min: 0 }),
  body('facing').optional().isString().isLength({ max: 50 }),
  body('tags').optional().isArray(),
  body('badge').optional().isString().isLength({ max: 50 }),
  body('verified').optional().isBoolean(),
  body('reraNumber').optional().isString().isLength({ max: 100 }),
  body('possessionStatus').optional().isString().isLength({ max: 50 }),
  body('floorNumber').optional().isInt({ min: 0 }),
  body('totalFloors').optional().isInt({ min: 0 }),
  body('furnishing').optional().isString().isLength({ max: 50 }),
  body('parkingSpots').optional().isInt({ min: 0 }),
  body('parkingType').optional().isString().isLength({ max: 50 }),
  body('ageOfProperty').optional().isString().isLength({ max: 50 }),
  body('gatedCommunity').optional().isBoolean(),
  body('faqs').optional().isArray(),
];

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
 *         name: minRate
 *         schema: { type: number }
 *         description: Minimum price per sq.ft.
 *       - in: query
 *         name: maxRate
 *         schema: { type: number }
 *         description: Maximum price per sq.ft.
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
    query('minRate').optional().isFloat({ min: 0 }),
    query('maxRate').optional().isFloat({ min: 0 }),
  ],
  validate,
  propertyController.listProperties
);

/**
 * @swagger
 * /properties/favorites:
 *   get:
 *     summary: List the authenticated customer's favorited properties
 *     description: Requires the authenticated account to have a linked customer record (every `customer`-role account has one; staff roles typically do not, and get a 403).
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
 *     responses:
 *       200:
 *         description: Paginated list of favorited properties
 *       403:
 *         description: Authenticated account has no linked customer record
 */
router.get(
  '/favorites',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  propertyController.listFavorites
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
    body('price').notEmpty().withMessage('Price is required').isString().isLength({ max: 100 }),
    body('city').notEmpty().withMessage('City is required'),
    body('locality').optional().isString(),
    body('address').optional().isString(),
    body('latitude').optional().isFloat(),
    body('longitude').optional().isFloat(),
    body('areaSqft').optional().isFloat({ min: 0 }),
    body('bedrooms').optional().isInt({ min: 0 }),
    body('bathrooms').optional().isInt({ min: 0 }),
    body('amenities').optional().isArray(),
    ...EXTENDED_FIELD_VALIDATORS,
    ...DISPLAY_FIELD_VALIDATORS,
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
    ...EXTENDED_FIELD_VALIDATORS,
    ...DISPLAY_FIELD_VALIDATORS,
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
 * /properties/bulk-delete:
 *   post:
 *     summary: Delete multiple property listings at once
 *     description: Runs the same per-listing ownership check as DELETE /properties/{id} for each id - ids that fail that check are skipped and reported back, not treated as a fatal error for the whole batch.
 *     tags: [Properties]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Returns deletedCount, deletedIds, and failed (array of {id, reason})
 */
router.post(
  '/bulk-delete',
  authenticate,
  [
    body('ids').isArray({ min: 1 }).withMessage('ids must be a non-empty array'),
    body('ids.*').isUUID().withMessage('Each id must be a valid UUID'),
  ],
  validate,
  propertyController.bulkDeleteProperties
);

/**
 * @swagger
 * /properties/{id}/media:
 *   post:
 *     summary: Attach media (images/videos) to a property via pre-hosted URLs
 *     description: >
 *       Accepts media URLs directly in the body, for media already hosted
 *       elsewhere. To upload a file to this app's own storage instead, use
 *       `POST /properties/{id}/media/upload`.
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
 * /properties/{id}/media/upload:
 *   post:
 *     summary: Upload an image or video file for a property to Cloud Storage
 *     description: >
 *       Uploads the file to `properties/{id}/images/...` or
 *       `properties/{id}/videos/...` in the GCS bucket (media type is
 *       inferred from the file's content type) and records the resulting
 *       public URL in property_media. Postgres stores only the URL, never
 *       the file itself.
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *               displayOrder: { type: integer, example: 0 }
 *               isPrimary: { type: boolean, example: true }
 *     responses:
 *       201:
 *         description: Media uploaded successfully
 *       400:
 *         description: Missing/oversized/unsupported file
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property not found
 */
router.post(
  '/:id/media/upload',
  authenticate,
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  uploadPropertyMedia.single('file'),
  propertyController.uploadMedia
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
 * /properties/{id}/media/{mediaId}/primary:
 *   put:
 *     summary: Set a media item as the property's cover photo
 *     description: Mutually exclusive - clears is_primary on every other media item for this property.
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
 *         description: Cover photo updated successfully
 *       403:
 *         description: Not the owner/tenant manager/admin
 *       404:
 *         description: Property or media not found
 */
router.put(
  '/:id/media/:mediaId/primary',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid property id'),
    param('mediaId').isUUID().withMessage('Invalid media id'),
  ],
  validate,
  propertyController.setPrimaryMedia
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
 *               price: { type: string, example: "2.1 Cr" }
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
    body('price').notEmpty().withMessage('Price is required').isString().isLength({ max: 100 }),
  ],
  validate,
  propertyController.updatePricing
);

/**
 * @swagger
 * /properties/{id}/favorite:
 *   post:
 *     summary: Save a property to the authenticated customer's favorites
 *     description: >
 *       Requires the authenticated account to have a linked customer record
 *       (every `customer`-role account has one; staff roles typically do
 *       not, and get a 403). Idempotent - favoriting an already-favorited
 *       property is a no-op. Only `approved` listings can be favorited.
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
 *         description: Property added to favorites
 *       400:
 *         description: Property is not approved
 *       403:
 *         description: Authenticated account has no linked customer record
 *       404:
 *         description: Property not found
 */
router.post(
  '/:id/favorite',
  authenticate,
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  propertyController.addFavorite
);

/**
 * @swagger
 * /properties/{id}/favorite:
 *   delete:
 *     summary: Remove a property from the authenticated customer's favorites
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
 *         description: Property removed from favorites
 *       403:
 *         description: Authenticated account has no linked customer record
 */
router.delete(
  '/:id/favorite',
  authenticate,
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  propertyController.removeFavorite
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
