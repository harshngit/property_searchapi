const express = require('express');
const { body, param, query } = require('express-validator');

const portal = require('../controllers/portal.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');

const router = express.Router();
router.use(authenticate);

const PROPERTY_TYPES = ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'];
const idParam = [param('id').isUUID().withMessage('Invalid id')];

/**
 * @swagger
 * tags:
 *   - name: Customer Portal
 *     description: >
 *       The website "Lite Dashboard" (Annexure A sec. 13.1 / 13.2A) for a
 *       `customer` login acting as buyer, tenant, seller and/or owner - profile
 *       and onboarding, requirements with Hot/Warm/Cold tagging, matched
 *       properties, saved searches with alerts, enquiries and site visits,
 *       self-posted listings, documents and the permanent referral code.
 *       Everything is scoped to the caller. Mandatory intermediation applies -
 *       sellers / owners never see an enquirer's contact details. Staff and
 *       brokers get 403 (they use the CRM).
 *   - name: Rentals
 *     description: >
 *       Owner / tenant rentals - leases (recorded by the owner, confirmed by the
 *       tenant), a monthly rent tracker (tenant reports, owner confirms;
 *       record-only - rent is paid directly between the parties) and
 *       maintenance requests.
 */

// ================================================================ Profile

/**
 * @swagger
 * /me/profile:
 *   get:
 *     summary: Caller's portal profile - roles, preferences, referral code, Lite / Full CRM tier
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile } }
 *   put:
 *     summary: Onboarding / profile - pick portal roles and buyer / tenant preferences
 *     description: Picking roles the first time completes onboarding and issues the permanent referral code (BU/TE/SE/OW prefix from the first role).
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               portalRoles: { type: array, items: { type: string, enum: [buyer, tenant, seller, owner] } }
 *               preferences:
 *                 type: object
 *                 properties:
 *                   budgetMin: { type: number }
 *                   budgetMax: { type: number }
 *                   preferredLocations: { type: array, items: { type: string } }
 *                   propertyType: { type: string }
 *                   transactionType: { type: string, enum: [buy, rent] }
 *                   bedrooms: { type: integer }
 *                   urgency: { type: string, enum: [immediate, 30_days, flexible] }
 *     responses: { 200: { description: Updated profile } }
 */
router.get('/profile', portal.getProfile);
router.put(
  '/profile',
  [
    body('portalRoles').optional().isArray({ min: 1 }),
    body('portalRoles.*').optional().isIn(['buyer', 'tenant', 'seller', 'owner']),
    body('preferences').optional().isObject(),
    body('preferences.budgetMin').optional({ nullable: true }).isFloat({ min: 0 }),
    body('preferences.budgetMax').optional({ nullable: true }).isFloat({ min: 0 }),
    body('preferences.preferredLocations').optional().isArray(),
    body('preferences.propertyType').optional({ nullable: true, checkFalsy: true }).isIn(PROPERTY_TYPES),
    body('preferences.transactionType').optional({ nullable: true, checkFalsy: true }).isIn(['buy', 'rent']),
    body('preferences.bedrooms').optional({ nullable: true }).isInt({ min: 0, max: 20 }),
    body('preferences.urgency').optional({ nullable: true, checkFalsy: true }).isIn(['immediate', '30_days', 'flexible']),
  ],
  validate,
  portal.saveProfile
);

/**
 * @swagger
 * /me/overview:
 *   get:
 *     summary: Home dashboard (Screen 3) - counts, listing status + renewal reminders, upcoming visits, latest notifications
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Overview } }
 */
router.get('/overview', portal.overview);

// =========================================================== Requirements

/**
 * @swagger
 * /me/requirements:
 *   get:
 *     summary: Caller's requirements (with CRM lead status and assigned representative)
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Requirements } }
 *   post:
 *     summary: Post a requirement (Screen 5)
 *     description: Auto-tagged Hot / Warm / Cold from urgency (admin-configurable) and routed to the CRM as a website lead with the same tag. Professional fee consent is mandatory.
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [purpose, city, feeConsent]
 *             properties:
 *               purpose: { type: string, enum: [buy, rent] }
 *               propertyType: { type: string, enum: [apartment, villa, independent_house, plot, commercial, farmhouse, other] }
 *               city: { type: string, example: Gurugram }
 *               localities: { type: array, items: { type: string }, example: [Sector 56, Golf Course Road] }
 *               budgetMin: { type: number, example: 8000000 }
 *               budgetMax: { type: number, example: 12000000 }
 *               areaMinSqft: { type: number }
 *               areaMaxSqft: { type: number }
 *               bedrooms: { type: integer, example: 3 }
 *               urgency: { type: string, enum: [immediate, 30_days, flexible] }
 *               notes: { type: string }
 *               mandateType: { type: string, enum: [standard, exclusive] }
 *               feeConsent: { type: boolean, example: true }
 *     responses: { 201: { description: Requirement }, 400: { description: Missing fee consent } }
 */
router.get('/requirements', portal.listRequirements);
router.post(
  '/requirements',
  [
    body('purpose').isIn(['buy', 'rent']).withMessage('Choose buy or rent'),
    body('city').trim().notEmpty().withMessage('City is required'),
    body('propertyType').optional({ nullable: true, checkFalsy: true }).isIn(PROPERTY_TYPES),
    body('localities').optional().isArray({ max: 10 }),
    body('budgetMin').optional({ nullable: true }).isFloat({ min: 0 }),
    body('budgetMax').optional({ nullable: true }).isFloat({ min: 0 }),
    body('areaMinSqft').optional({ nullable: true }).isFloat({ min: 0 }),
    body('areaMaxSqft').optional({ nullable: true }).isFloat({ min: 0 }),
    body('bedrooms').optional({ nullable: true }).isInt({ min: 0, max: 20 }),
    body('urgency').optional().isIn(['immediate', '30_days', 'flexible']),
    body('mandateType').optional().isIn(['standard', 'exclusive']),
    body('notes').optional().isString().isLength({ max: 2000 }),
    body('feeConsent').isBoolean().withMessage('Fee consent is required'),
  ],
  validate,
  portal.createRequirement
);

/**
 * @swagger
 * /me/requirements/{id}:
 *   put:
 *     summary: Edit a requirement or change its status (active / paused / fulfilled / closed)
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Updated requirement } }
 */
router.put(
  '/requirements/:id',
  [
    ...idParam,
    body('status').optional().isIn(['active', 'paused', 'fulfilled', 'closed']),
    body('urgency').optional().isIn(['immediate', '30_days', 'flexible']),
    body('propertyType').optional({ nullable: true, checkFalsy: true }).isIn(PROPERTY_TYPES),
    body('localities').optional().isArray({ max: 10 }),
    body('budgetMin').optional({ nullable: true }).isFloat({ min: 0 }),
    body('budgetMax').optional({ nullable: true }).isFloat({ min: 0 }),
    body('bedrooms').optional({ nullable: true }).isInt({ min: 0, max: 20 }),
  ],
  validate,
  portal.updateRequirement
);

/**
 * @swagger
 * /me/matches:
 *   get:
 *     summary: Matched properties for the caller's active requirements (Screen 6) - % score, Hot Match flag
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: requirementId, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: "{ requirements, items: [{ requirementId, score, hotMatch, reasons, property }] }" } }
 */
router.get('/matches', [query('requirementId').optional().isUUID()], validate, portal.matches);

// ============================================================= Favourites

/**
 * @swagger
 * /me/favourites:
 *   get:
 *     summary: Caller's saved (favourite) properties as public cards, plus their ids
 *     description: Add / remove with POST / DELETE /properties/{id}/favorite.
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ ids, items }" } }
 */
router.get('/favourites', portal.listFavourites);

// ========================================================= Saved searches

/**
 * @swagger
 * /me/saved-searches:
 *   get:
 *     summary: Caller's saved searches
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Saved searches } }
 *   post:
 *     summary: Save a search (alerts on new matching listings when enabled; max 20)
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: 3 BHK in Gurugram under 2 Cr }
 *               filters:
 *                 type: object
 *                 properties:
 *                   purpose: { type: string, enum: [buy, rent, all] }
 *                   city: { type: string }
 *                   q: { type: string }
 *                   propertyType: { type: string }
 *                   minPrice: { type: number }
 *                   maxPrice: { type: number }
 *                   bedrooms: { type: integer }
 *               alertsEnabled: { type: boolean }
 *     responses: { 201: { description: Saved search } }
 */
router.get('/saved-searches', portal.listSavedSearches);
router.post(
  '/saved-searches',
  [
    body('name').trim().notEmpty().isLength({ max: 120 }).withMessage('Give the search a name'),
    body('filters').optional().isObject(),
    body('alertsEnabled').optional().isBoolean(),
  ],
  validate,
  portal.createSavedSearch
);

/**
 * @swagger
 * /me/saved-searches/{id}:
 *   put:
 *     summary: Rename a saved search or switch its alerts on / off
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Saved search } }
 *   delete:
 *     summary: Delete a saved search
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Deleted } }
 */
router.put(
  '/saved-searches/:id',
  [...idParam, body('name').optional().trim().notEmpty().isLength({ max: 120 }), body('alertsEnabled').optional().isBoolean()],
  validate,
  portal.updateSavedSearch
);
router.delete('/saved-searches/:id', idParam, validate, portal.deleteSavedSearch);

// ===================================================== Enquiries & visits

/**
 * @swagger
 * /me/enquiries:
 *   get:
 *     summary: Caller's enquiries and requirement leads - status, assigned representative, deal stage, next visit
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Enquiries } }
 */
router.get('/enquiries', portal.listEnquiries);

/**
 * @swagger
 * /me/enquiries/{id}/visit-request:
 *   post:
 *     summary: Ask the representative for a site visit on one of the caller's enquiries
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [preferredAt]
 *             properties:
 *               preferredAt: { type: string, format: date-time }
 *               note: { type: string }
 *     responses: { 200: { description: Request noted on the lead and sent to the representative } }
 */
router.post(
  '/enquiries/:id/visit-request',
  [...idParam, body('preferredAt').isISO8601().withMessage('Pick a date and time'), body('note').optional().isLength({ max: 500 })],
  validate,
  portal.requestVisit
);

/**
 * @swagger
 * /me/visits:
 *   get:
 *     summary: Caller's site visit schedule
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Visits } }
 */
router.get('/visits', portal.listVisits);

// ================================================================ Listings

const listingValidators = (creating) => [
  (creating ? body('title') : body('title').optional()).trim().isLength({ min: 5, max: 200 }).withMessage('Title must be 5-200 characters'),
  (creating ? body('propertyType') : body('propertyType').optional()).isIn(PROPERTY_TYPES),
  (creating ? body('transactionType') : body('transactionType').optional()).isIn(['sell', 'rent']).withMessage('Choose sell or rent'),
  (creating ? body('price') : body('price').optional()).trim().notEmpty().withMessage('Price is required'),
  (creating ? body('city') : body('city').optional()).trim().notEmpty().withMessage('City is required'),
  (creating ? body('locality') : body('locality').optional()).trim().notEmpty().withMessage('Locality is required'),
  body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
  body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  body('areaSqft').optional({ nullable: true }).isFloat({ min: 1 }),
  body('bedrooms').optional({ nullable: true }).isInt({ min: 0, max: 20 }),
  body('bathrooms').optional({ nullable: true }).isInt({ min: 0, max: 20 }),
  body('amenities').optional().isArray(),
  body('description').optional().isLength({ max: 5000 }),
  body('mandateType').optional().isIn(['standard', 'exclusive']),
  ...(creating ? [body('feeConsent').isBoolean().withMessage('Fee consent is required')] : []),
];

/**
 * @swagger
 * /me/listings:
 *   get:
 *     summary: Caller's own listings - status, enquiry / interested-buyer / visit / favourite counts, expiry
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Listings } }
 *   post:
 *     summary: Post a property (Screen 4) - goes to admin approval
 *     description: Text is checked by the content guard (no phone numbers / emails). Professional fee consent and mandate type are mandatory. Add photos afterwards with POST /properties/{id}/media/upload.
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, propertyType, transactionType, price, city, locality, feeConsent]
 *             properties:
 *               title: { type: string, example: 3 BHK apartment in Sector 56 }
 *               propertyType: { type: string, enum: [apartment, villa, independent_house, plot, commercial, farmhouse, other] }
 *               transactionType: { type: string, enum: [sell, rent] }
 *               price: { type: string, example: 1.45 Cr }
 *               city: { type: string, example: Gurugram }
 *               locality: { type: string, example: Sector 56 }
 *               latitude: { type: number }
 *               longitude: { type: number }
 *               areaSqft: { type: number, example: 1650 }
 *               bedrooms: { type: integer, example: 3 }
 *               bathrooms: { type: integer, example: 3 }
 *               furnishing: { type: string }
 *               description: { type: string }
 *               pg: { type: boolean, description: Tag the listing as PG / co-living }
 *               mandateType: { type: string, enum: [standard, exclusive] }
 *               feeConsent: { type: boolean, example: true }
 *     responses: { 201: { description: Listing (pending approval) } }
 */
router.get('/listings', portal.listListings);
router.post('/listings', listingValidators(true), validate, portal.createListing);

/**
 * @swagger
 * /me/listings/{id}:
 *   put:
 *     summary: Edit one of the caller's listings - a live listing goes back to approval
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Listing } }
 */
router.put('/listings/:id', [...idParam, ...listingValidators(false)], validate, portal.updateListing);

/**
 * @swagger
 * /me/listings/{id}/{action}:
 *   post:
 *     summary: "Renew a live listing, close it (sold / rented) or reopen a closed one"
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: action, required: true, schema: { type: string, enum: [renew, close, reopen] } }
 *     responses: { 200: { description: Listing } }
 */
router.post('/listings/:id/:action(renew|close|reopen)', idParam, validate, portal.listingAction);

/**
 * @swagger
 * /me/listings/{id}/enquiries:
 *   get:
 *     summary: Enquiries on one of the caller's listings - first name and status only (contact stays with the representative)
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Enquiries } }
 */
router.get('/listings/:id/enquiries', idParam, validate, portal.listingEnquiries);

// =============================================================== Documents

/**
 * @swagger
 * /me/documents:
 *   get:
 *     summary: Caller's documents with review status
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Documents (signed URLs) } }
 *   post:
 *     summary: Upload a document (KYC, agreement, receipt, NOC, other) - max 20 MB
 *     tags: [Customer Portal]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *               documentType: { type: string, enum: [kyc, agreement, payment_receipt, noc, other] }
 *     responses: { 201: { description: Document (pending review) } }
 */
router.get('/documents', portal.listDocuments);
router.post(
  '/documents',
  uploadDocumentFile.single('file'),
  [body('documentType').optional().isIn(['kyc', 'agreement', 'payment_receipt', 'noc', 'other'])],
  validate,
  portal.uploadDocument
);

// ================================================================= Rentals

/**
 * @swagger
 * /me/rentals:
 *   get:
 *     summary: Leases the caller is party to (as owner or tenant) with rent-due / to-confirm / open-maintenance counts
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Leases } }
 *   post:
 *     summary: Owner records a lease with their tenant
 *     description: The tenant is matched by mobile / email; the lease appears in their dashboard when they sign in with it, and they are asked to confirm it.
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tenantName, monthlyRent, startDate]
 *             properties:
 *               propertyId: { type: string, format: uuid, description: One of the owner's own listings (optional) }
 *               propertyLabel: { type: string, example: "Flat 402, Palm Heights, Sector 56, Gurugram" }
 *               tenantName: { type: string }
 *               tenantMobile: { type: string }
 *               tenantEmail: { type: string }
 *               monthlyRent: { type: number, example: 45000 }
 *               securityDeposit: { type: number, example: 90000 }
 *               rentDueDay: { type: integer, example: 5 }
 *               startDate: { type: string, format: date }
 *               endDate: { type: string, format: date }
 *     responses: { 201: { description: Lease with rent schedule } }
 */
router.get('/rentals', portal.listLeases);
router.post(
  '/rentals',
  [
    body('propertyId').optional({ nullable: true, checkFalsy: true }).isUUID(),
    body('propertyLabel').optional().isLength({ max: 255 }),
    body('tenantName').trim().notEmpty().withMessage("Tenant's name is required"),
    body('tenantMobile').optional({ checkFalsy: true }).isMobilePhone().withMessage('Valid mobile number required'),
    body('tenantEmail').optional({ checkFalsy: true }).isEmail().withMessage('Valid email required'),
    body('monthlyRent').isFloat({ gt: 0 }).withMessage('Monthly rent is required'),
    body('securityDeposit').optional({ nullable: true }).isFloat({ min: 0 }),
    body('rentDueDay').optional().isInt({ min: 1, max: 28 }),
    body('startDate').isISO8601().withMessage('Start date is required'),
    body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  ],
  validate,
  portal.createLease
);

/**
 * @swagger
 * /me/rentals/{id}:
 *   get:
 *     summary: One lease with its rent schedule and maintenance requests
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Lease } }
 *   put:
 *     summary: Owner updates status (active / notice / ended), end date, rent or due day
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Lease } }
 */
router.get('/rentals/:id', idParam, validate, portal.getLease);
router.put(
  '/rentals/:id',
  [
    ...idParam,
    body('status').optional().isIn(['active', 'notice', 'ended']),
    body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('monthlyRent').optional().isFloat({ gt: 0 }),
    body('rentDueDay').optional().isInt({ min: 1, max: 28 }),
  ],
  validate,
  portal.updateLease
);

/**
 * @swagger
 * /me/rentals/{id}/confirm:
 *   post:
 *     summary: Tenant confirms the lease terms recorded by the owner
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Lease } }
 */
router.post('/rentals/:id/confirm', idParam, validate, portal.confirmLease);

/**
 * @swagger
 * /me/rentals/{id}/rent/{paymentId}/report:
 *   post:
 *     summary: Tenant reports a month's rent as paid (record only - paid directly to the owner)
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: paymentId, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paidOn]
 *             properties:
 *               paidOn: { type: string, format: date }
 *               paymentMode: { type: string, enum: [upi, bank_transfer, cheque, cash, other] }
 *               reference: { type: string, example: UPI ref 4192 8830 1123 }
 *               note: { type: string }
 *     responses: { 200: { description: Payment row } }
 */
router.post(
  '/rentals/:id/rent/:paymentId/report',
  [
    ...idParam,
    param('paymentId').isUUID(),
    body('paidOn').isISO8601().withMessage('Payment date is required'),
    body('paymentMode').optional().isIn(['upi', 'bank_transfer', 'cheque', 'cash', 'other']),
    body('reference').optional().isLength({ max: 100 }),
    body('note').optional().isLength({ max: 500 }),
  ],
  validate,
  portal.reportRent
);

/**
 * @swagger
 * /me/rentals/{id}/rent/{paymentId}/review:
 *   post:
 *     summary: Owner confirms or disputes a rent payment
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: paymentId, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action: { type: string, enum: [confirm, dispute] }
 *               note: { type: string }
 *     responses: { 200: { description: Payment row } }
 */
router.post(
  '/rentals/:id/rent/:paymentId/review',
  [...idParam, param('paymentId').isUUID(), body('action').isIn(['confirm', 'dispute']), body('note').optional().isLength({ max: 500 })],
  validate,
  portal.reviewRent
);

/**
 * @swagger
 * /me/rentals/{id}/maintenance:
 *   post:
 *     summary: Raise a maintenance request on a lease (tenant or owner)
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string, example: Kitchen tap leaking }
 *               description: { type: string }
 *               category: { type: string, enum: [plumbing, electrical, appliance, carpentry, painting, pest_control, other] }
 *               priority: { type: string, enum: [low, medium, high, urgent] }
 *     responses: { 201: { description: Request } }
 */
router.post(
  '/rentals/:id/maintenance',
  [
    ...idParam,
    body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Describe the issue in a few words'),
    body('description').optional().isLength({ max: 2000 }),
    body('category').optional().isIn(['plumbing', 'electrical', 'appliance', 'carpentry', 'painting', 'pest_control', 'other']),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  ],
  validate,
  portal.createMaintenance
);

/**
 * @swagger
 * /me/rentals/{id}/maintenance/{requestId}:
 *   put:
 *     summary: Owner updates progress (in_progress / resolved + note); either side can close a resolved request
 *     tags: [Rentals]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: requestId, required: true, schema: { type: string, format: uuid } }
 *     responses: { 200: { description: Request } }
 */
router.put(
  '/rentals/:id/maintenance/:requestId',
  [
    ...idParam,
    param('requestId').isUUID(),
    body('status').optional().isIn(['open', 'in_progress', 'resolved', 'closed']),
    body('ownerNote').optional().isLength({ max: 1000 }),
  ],
  validate,
  portal.updateMaintenance
);

module.exports = router;
