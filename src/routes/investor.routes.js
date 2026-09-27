const express = require('express');
const { body, param, query } = require('express-validator');

const { investors, nri, hni, tools } = require('../controllers/investor.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const investorRouter = express.Router();
const nriRouter = express.Router();
const hniRouter = express.Router();
const toolsRouter = express.Router();

const STAFF_ROLES = ['internal_sales', 'admin', 'super_admin'];
const ADMIN_ROLES = ['admin', 'super_admin'];
const ASSET_CLASSES = ['residential', 'commercial', 'institutional', 'land', 'special_situation', 'auction', 'hospitality', 'other'];
const REQUEST_TYPES = [
  'buy', 'sell', 'rent_out', 'property_management', 'rent_collection', 'tenant_management', 'maintenance',
  'document_coordination', 'legal_guidance', 'tax_guidance', 'repatriation', 'institutional_acquisition', 'other',
];
const REQUEST_STATUSES = ['submitted', 'acknowledged', 'in_progress', 'awaiting_customer', 'completed', 'cancelled'];
const idParam = [param('id').isUUID().withMessage('Invalid id')];
const investorIdQuery = [query('investorId').optional().isUUID()];

/**
 * @swagger
 * tags:
 *   - name: Investors
 *     description: >
 *       NRI / OCI and HNI investor profiles (Engine 3). One profile per user - a
 *       person can be both NRI and HNI. Staff (internal_sales/admin/super_admin)
 *       verify profiles and assign a relationship manager; a verified profile
 *       unlocks full auction / special-situation deal details.
 *   - name: NRI
 *     description: >
 *       NRI Management - dashboard, owned properties under management (tenant
 *       phone encrypted, returned masked), rent collection ledger, service
 *       requests with SLA and timeline, repatriation tracking vs the FEMA annual
 *       limit, and indicative TDS / FEMA guidance. The investor uses their own
 *       profile; staff / the assigned manager pass `investorId`.
 *   - name: HNI
 *     description: >
 *       HNI Investment - curated deal flow matched to the investor's profile,
 *       portfolio with ROI / yield / CAGR / liquidity computed on read, exit
 *       tracking, shortlist and behaviour tracking.
 *   - name: Investment Tools
 *     description: Public, non-advisory calculators (ROI, rental yield, appreciation) and area liquidity score. Every result carries disclaimers.
 */

// ============================== Investors ==============================

const profileValidators = [
  body('isNri').optional().isBoolean(),
  body('isHni').optional().isBoolean(),
  body('residencyStatus').optional().isIn(['nri', 'oci', 'pio', 'resident']),
  body('investorCategory').optional().isIn(['individual', 'family_office', 'trust', 'pe_fund', 'corporate', 'education_group']),
  body('assetClassPreferences').optional().isArray(),
  body('assetClassPreferences.*').optional().isIn(ASSET_CLASSES),
  body('preferredCities').optional().isArray(),
  body('preferredPropertyTypes').optional().isArray(),
  body('ticketSizeMin').optional({ nullable: true }).isFloat({ min: 0 }),
  body('ticketSizeMax').optional({ nullable: true }).isFloat({ min: 0 }),
  body('riskAppetite').optional().isIn(['conservative', 'moderate', 'aggressive']),
  body('investmentHorizonYears').optional().isInt({ min: 1, max: 50 }),
  body('institutionalInterest').optional().isBoolean(),
  body('alertsEnabled').optional().isBoolean(),
];

/**
 * @swagger
 * /investors/me:
 *   get:
 *     summary: The caller's own investor profile (null if none yet)
 *     tags: [Investors]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile or null } }
 *   put:
 *     summary: Create or update the caller's investor profile
 *     description: Creating needs isNri and/or isHni. Changing NRI/HNI status or the max ticket size sends a verified profile back to pending verification.
 *     tags: [Investors]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isNri: { type: boolean }
 *               isHni: { type: boolean }
 *               residencyStatus: { type: string, enum: [nri, oci, pio, resident] }
 *               countryOfResidence: { type: string, example: United Arab Emirates }
 *               cityOfResidence: { type: string }
 *               timeZone: { type: string, example: Asia/Dubai }
 *               preferredContactWindow: { type: string }
 *               investorCategory: { type: string, enum: [individual, family_office, trust, pe_fund, corporate, education_group] }
 *               assetClassPreferences: { type: array, items: { type: string, enum: [residential, commercial, institutional, land, special_situation, auction, hospitality, other] } }
 *               preferredCities: { type: array, items: { type: string } }
 *               preferredPropertyTypes: { type: array, items: { type: string } }
 *               ticketSizeMin: { type: number }
 *               ticketSizeMax: { type: number }
 *               riskAppetite: { type: string, enum: [conservative, moderate, aggressive] }
 *               investmentHorizonYears: { type: integer }
 *               institutionalInterest: { type: boolean }
 *               alertsEnabled: { type: boolean }
 *     responses: { 200: { description: Saved profile } }
 */
investorRouter.get('/me', authenticate, investors.getMe);
investorRouter.put('/me', authenticate, profileValidators, validate, investors.upsertMe);

/**
 * @swagger
 * /investors:
 *   get:
 *     summary: "[Staff] List investor profiles"
 *     tags: [Investors]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: type, schema: { type: string, enum: [nri, hni] } }
 *       - { in: query, name: verificationStatus, schema: { type: string, enum: [pending, verified, rejected] } }
 *       - { in: query, name: managerId, schema: { type: string, format: uuid } }
 *       - { in: query, name: unassigned, schema: { type: boolean } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses: { 200: { description: Paginated profiles } }
 */
investorRouter.get(
  '/',
  authenticate,
  authorize(...STAFF_ROLES),
  [query('type').optional().isIn(['nri', 'hni']), query('verificationStatus').optional().isIn(['pending', 'verified', 'rejected']), query('managerId').optional().isUUID()],
  validate,
  investors.list
);

/**
 * @swagger
 * /investors/{id}:
 *   get:
 *     summary: Get an investor profile (owner, assigned manager or staff)
 *     tags: [Investors]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Profile } }
 */
investorRouter.get('/:id', authenticate, idParam, validate, investors.get);

/**
 * @swagger
 * /investors/{id}/verify:
 *   put:
 *     summary: "[Staff] Verify / reject an investor profile (audit-logged, investor notified)"
 *     tags: [Investors]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [verified, rejected, pending] }
 *               notes: { type: string }
 *     responses: { 200: { description: Updated profile } }
 */
investorRouter.put(
  '/:id/verify',
  authenticate,
  authorize(...STAFF_ROLES),
  [...idParam, body('status').isIn(['verified', 'rejected', 'pending']), body('notes').optional().isString()],
  validate,
  investors.verify
);

/**
 * @swagger
 * /investors/{id}/assign-manager:
 *   put:
 *     summary: "[Admin] Assign the investor's relationship manager (open NRI requests follow)"
 *     tags: [Investors]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [managerId], properties: { managerId: { type: string, format: uuid } } } } }
 *     responses: { 200: { description: Updated profile } }
 */
investorRouter.put(
  '/:id/assign-manager',
  authenticate,
  authorize(...ADMIN_ROLES),
  [...idParam, body('managerId').isUUID()],
  validate,
  investors.assignManager
);

/**
 * @swagger
 * /investors/{id}/behaviour:
 *   get:
 *     summary: Investor behaviour - deal types, cities and ticket sizes engaged with
 *     tags: [Investors]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: days, schema: { type: integer, default: 90 } }
 *     responses: { 200: { description: Behaviour summary } }
 */
investorRouter.get('/:id/behaviour', authenticate, [...idParam, query('days').optional().isInt({ min: 1 })], validate, investors.behaviour);

// ================================ NRI ================================

/**
 * @swagger
 * /nri/dashboard:
 *   get:
 *     summary: NRI dashboard - portfolio, occupancy, rent this FY, open requests, SLA breaches, repatriation vs limit, assigned manager
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: investorId, schema: { type: string, format: uuid }, description: Staff / manager only }]
 *     responses: { 200: { description: Dashboard } }
 */
nriRouter.get('/dashboard', authenticate, investorIdQuery, validate, nri.dashboard);

/**
 * @swagger
 * /nri/guidance/fema:
 *   get:
 *     summary: FEMA / RBI basics for NRIs (non-advisory, admin-editable) + repatriation limit
 *     tags: [NRI]
 *     responses: { 200: { description: Guidance points + disclaimers } }
 */
nriRouter.get('/guidance/fema', nri.fema);

/**
 * @swagger
 * /nri/guidance/tds-on-sale:
 *   post:
 *     summary: Indicative TDS when an NRI sells property (on the gain and on full consideration)
 *     tags: [NRI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [salePrice, purchasePrice]
 *             properties:
 *               salePrice: { type: number, example: 15000000 }
 *               purchasePrice: { type: number, example: 9000000 }
 *               purchaseDate: { type: string, format: date }
 *               saleDate: { type: string, format: date }
 *               holdingMonths: { type: integer }
 *               improvementCost: { type: number }
 *               transferExpenses: { type: number }
 *     responses: { 200: { description: Indicative figures + disclaimers } }
 */
nriRouter.post(
  '/guidance/tds-on-sale',
  [
    body('salePrice').isFloat({ min: 0 }),
    body('purchasePrice').isFloat({ min: 0 }),
    body('purchaseDate').optional().isISO8601(),
    body('saleDate').optional().isISO8601(),
    body('holdingMonths').optional().isInt({ min: 0 }),
    body('improvementCost').optional().isFloat({ min: 0 }),
    body('transferExpenses').optional().isFloat({ min: 0 }),
  ],
  validate,
  nri.tdsOnSale
);

/**
 * @swagger
 * /nri/guidance/rent-tds:
 *   post:
 *     summary: Indicative TDS a tenant deducts on rent paid to an NRI
 *     tags: [NRI]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [monthlyRent], properties: { monthlyRent: { type: number } } } } }
 *     responses: { 200: { description: Indicative figures + disclaimers } }
 */
nriRouter.post('/guidance/rent-tds', [body('monthlyRent').isFloat({ min: 0 })], validate, nri.rentTds);

const nriPropertyValidators = [
  body('title').optional().isString().notEmpty(),
  body('propertyId').optional({ nullable: true }).isUUID(),
  body('areaSqft').optional({ nullable: true }).isFloat({ min: 0 }),
  body('ownershipType').optional().isIn(['sole', 'joint', 'inherited', 'company']),
  body('purchasePrice').optional({ nullable: true }).isFloat({ min: 0 }),
  body('purchaseDate').optional({ nullable: true }).isISO8601(),
  body('currentEstimatedValue').optional({ nullable: true }).isFloat({ min: 0 }),
  body('valuationDate').optional({ nullable: true }).isISO8601(),
  body('managementStatus').optional().isIn(['self_managed', 'platform_managed', 'management_requested']),
  body('occupancyStatus').optional().isIn(['vacant', 'tenant_occupied', 'owner_occupied', 'under_maintenance']),
  body('monthlyRentExpected').optional({ nullable: true }).isFloat({ min: 0 }),
  body('tenantPhone').optional({ nullable: true }).isMobilePhone(),
  body('leaseStartDate').optional({ nullable: true }).isISO8601(),
  body('leaseEndDate').optional({ nullable: true }).isISO8601(),
];

/**
 * @swagger
 * /nri/properties:
 *   get:
 *     summary: Properties the NRI owns (with open requests and outstanding rent)
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: investorId, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Properties (tenant phone masked) } }
 *   post:
 *     summary: Add an owned property for monitoring / management
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, city]
 *             properties:
 *               investorId: { type: string, format: uuid, description: Staff only }
 *               title: { type: string }
 *               propertyType: { type: string }
 *               city: { type: string }
 *               locality: { type: string }
 *               address: { type: string, description: Private - never shown publicly }
 *               areaSqft: { type: number }
 *               ownershipType: { type: string, enum: [sole, joint, inherited, company] }
 *               purchasePrice: { type: number }
 *               purchaseDate: { type: string, format: date }
 *               currentEstimatedValue: { type: number }
 *               managementStatus: { type: string, enum: [self_managed, platform_managed, management_requested] }
 *               occupancyStatus: { type: string, enum: [vacant, tenant_occupied, owner_occupied, under_maintenance] }
 *               monthlyRentExpected: { type: number }
 *               tenantName: { type: string }
 *               tenantPhone: { type: string, description: Stored AES-256-GCM encrypted, returned masked }
 *               leaseStartDate: { type: string, format: date }
 *               leaseEndDate: { type: string, format: date }
 *     responses: { 201: { description: Created } }
 */
nriRouter.get('/properties', authenticate, investorIdQuery, validate, nri.listProperties);
nriRouter.post(
  '/properties',
  authenticate,
  [body('title').isString().notEmpty().withMessage('title is required'), body('city').isString().notEmpty().withMessage('city is required'), body('investorId').optional().isUUID(), ...nriPropertyValidators],
  validate,
  nri.createProperty
);

/**
 * @swagger
 * /nri/properties/{id}:
 *   get:
 *     summary: Property with last 12 rent records and recent service requests
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Property } }
 *   put:
 *     summary: Update a managed property
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { content: { application/json: { schema: { type: object } } } }
 *     responses: { 200: { description: Updated } }
 *   delete:
 *     summary: Remove a managed property
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Removed } }
 */
nriRouter.get('/properties/:id', authenticate, idParam, validate, nri.getProperty);
nriRouter.put('/properties/:id', authenticate, [...idParam, ...nriPropertyValidators], validate, nri.updateProperty);
nriRouter.delete('/properties/:id', authenticate, idParam, validate, nri.deleteProperty);

/**
 * @swagger
 * /nri/properties/{id}/rent:
 *   get:
 *     summary: Rent ledger for a property
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Rent records, newest month first } }
 *   post:
 *     summary: Record rent for a month (upsert - one record per property per month; status derived)
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [periodMonth]
 *             properties:
 *               periodMonth: { type: string, format: date, example: "2026-09-01" }
 *               rentDue: { type: number, description: Defaults to the property's expected monthly rent }
 *               rentReceived: { type: number }
 *               tdsDeducted: { type: number }
 *               receivedOn: { type: string, format: date }
 *               status: { type: string, enum: [waived], description: Only needed to waive; otherwise derived (due/partial/received/overdue) }
 *               notes: { type: string }
 *     responses: { 200: { description: Rent record } }
 */
nriRouter.get('/properties/:id/rent', authenticate, idParam, validate, nri.listRent);
nriRouter.post(
  '/properties/:id/rent',
  authenticate,
  [
    ...idParam,
    body('periodMonth').isISO8601().withMessage('periodMonth is required'),
    body('rentDue').optional().isFloat({ min: 0 }),
    body('rentReceived').optional().isFloat({ min: 0 }),
    body('tdsDeducted').optional().isFloat({ min: 0 }),
    body('receivedOn').optional({ nullable: true }).isISO8601(),
    body('status').optional().isIn(['waived']),
  ],
  validate,
  nri.recordRent
);

/**
 * @swagger
 * /nri/service-requests:
 *   get:
 *     summary: Service requests (investor sees own; staff see all or one investor's)
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: investorId, schema: { type: string, format: uuid } }
 *       - { in: query, name: status, schema: { type: string, enum: [submitted, acknowledged, in_progress, awaiting_customer, completed, cancelled] } }
 *       - { in: query, name: requestType, schema: { type: string } }
 *       - { in: query, name: priority, schema: { type: string, enum: [low, medium, high, urgent] } }
 *       - { in: query, name: managerId, schema: { type: string, format: uuid } }
 *       - { in: query, name: open, schema: { type: boolean } }
 *       - { in: query, name: slaBreached, schema: { type: boolean } }
 *     responses: { 200: { description: Paginated requests } }
 *   post:
 *     summary: Raise a service request (buy / sell / rent out / management / rent collection / legal / tax / repatriation ...)
 *     description: SLA due time is set from app_config nri.service_request_sla_hours by priority; the investor's manager is notified.
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [requestType, title]
 *             properties:
 *               investorId: { type: string, format: uuid }
 *               nriPropertyId: { type: string, format: uuid }
 *               requestType: { type: string, enum: [buy, sell, rent_out, property_management, rent_collection, tenant_management, maintenance, document_coordination, legal_guidance, tax_guidance, repatriation, institutional_acquisition, other] }
 *               title: { type: string }
 *               description: { type: string }
 *               priority: { type: string, enum: [low, medium, high, urgent] }
 *     responses: { 201: { description: Created with timeline } }
 */
nriRouter.get(
  '/service-requests',
  authenticate,
  [...investorIdQuery, query('status').optional().isIn(REQUEST_STATUSES), query('requestType').optional().isIn(REQUEST_TYPES), query('managerId').optional().isUUID()],
  validate,
  nri.listRequests
);
nriRouter.post(
  '/service-requests',
  authenticate,
  [
    body('investorId').optional().isUUID(),
    body('nriPropertyId').optional({ nullable: true }).isUUID(),
    body('requestType').isIn(REQUEST_TYPES).withMessage(`requestType must be one of: ${REQUEST_TYPES.join(', ')}`),
    body('title').isString().notEmpty().withMessage('title is required'),
    body('description').optional().isString(),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  ],
  validate,
  nri.createRequest
);

/**
 * @swagger
 * /nri/service-requests/{id}:
 *   get:
 *     summary: Service request with timeline (internal staff notes hidden from the investor)
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Request } }
 */
nriRouter.get('/service-requests/:id', authenticate, idParam, validate, nri.getRequest);

/**
 * @swagger
 * /nri/service-requests/{id}/updates:
 *   post:
 *     summary: Add a timeline update (staff may mark it internal)
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [message], properties: { message: { type: string }, isInternal: { type: boolean } } } } }
 *     responses: { 201: { description: Updated request } }
 */
nriRouter.post(
  '/service-requests/:id/updates',
  authenticate,
  [...idParam, body('message').isString().notEmpty(), body('isInternal').optional().isBoolean()],
  validate,
  nri.addUpdate
);

/**
 * @swagger
 * /nri/service-requests/{id}/status:
 *   put:
 *     summary: Change request status (representative; the investor may only cancel)
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [acknowledged, in_progress, awaiting_customer, completed, cancelled] }
 *               message: { type: string }
 *     responses: { 200: { description: Updated request } }
 */
nriRouter.put(
  '/service-requests/:id/status',
  authenticate,
  [...idParam, body('status').isIn(REQUEST_STATUSES.filter((s) => s !== 'submitted')), body('message').optional().isString()],
  validate,
  nri.updateStatus
);

/**
 * @swagger
 * /nri/service-requests/{id}/assign:
 *   put:
 *     summary: "[Staff] Reassign a request to another manager"
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [managerId], properties: { managerId: { type: string, format: uuid } } } } }
 *     responses: { 200: { description: Updated request } }
 */
nriRouter.put(
  '/service-requests/:id/assign',
  authenticate,
  authorize(...STAFF_ROLES),
  [...idParam, body('managerId').isUUID()],
  validate,
  nri.assignRequest
);

const repatriationValidators = [
  body('nriPropertyId').optional({ nullable: true }).isUUID(),
  body('amountInr').optional().isFloat({ min: 0 }),
  body('amountFx').optional({ nullable: true }).isFloat({ min: 0 }),
  body('amountUsdEquivalent').optional({ nullable: true }).isFloat({ min: 0 }),
  body('fxCurrency').optional({ nullable: true }).isLength({ min: 3, max: 3 }),
  body('financialYear').optional().matches(/^\d{4}-\d{2}$/).withMessage('financialYear must look like 2026-27'),
  body('form15caCbStatus').optional().isIn(['not_started', 'in_progress', 'filed', 'not_applicable']),
  body('status').optional().isIn(['planned', 'in_process', 'completed', 'cancelled']),
  body('completedOn').optional({ nullable: true }).isISO8601(),
];

/**
 * @swagger
 * /nri/repatriation:
 *   get:
 *     summary: Repatriation records with the financial-year summary vs the FEMA annual limit
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: investorId, schema: { type: string, format: uuid } }
 *       - { in: query, name: financialYear, schema: { type: string, example: 2026-27 } }
 *     responses: { 200: { description: Records + summary + disclaimers } }
 *   post:
 *     summary: Record a planned / in-process / completed repatriation
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source, amountInr]
 *             properties:
 *               investorId: { type: string, format: uuid }
 *               nriPropertyId: { type: string, format: uuid }
 *               source: { type: string, enum: [sale_proceeds, rental_income, other] }
 *               amountInr: { type: number }
 *               fxCurrency: { type: string, example: USD }
 *               amountFx: { type: number }
 *               amountUsdEquivalent: { type: number }
 *               financialYear: { type: string, example: 2026-27 }
 *               form15caCbStatus: { type: string, enum: [not_started, in_progress, filed, not_applicable] }
 *               bankName: { type: string }
 *               status: { type: string, enum: [planned, in_process, completed, cancelled] }
 *     responses: { 201: { description: "{ record, summary, withinLimit }" } }
 */
nriRouter.get('/repatriation', authenticate, [...investorIdQuery, query('financialYear').optional().matches(/^\d{4}-\d{2}$/)], validate, nri.listRepatriation);
nriRouter.post(
  '/repatriation',
  authenticate,
  [body('investorId').optional().isUUID(), body('source').isIn(['sale_proceeds', 'rental_income', 'other']), body('amountInr').isFloat({ min: 0 }), ...repatriationValidators],
  validate,
  nri.createRepatriation
);

/**
 * @swagger
 * /nri/repatriation/{id}:
 *   put:
 *     summary: Update a repatriation record (e.g. mark completed, 15CA/CB filed)
 *     tags: [NRI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { content: { application/json: { schema: { type: object } } } }
 *     responses: { 200: { description: "{ record, summary }" } }
 */
nriRouter.put('/repatriation/:id', authenticate, [...idParam, ...repatriationValidators], validate, nri.updateRepatriation);

// ================================ HNI ================================

/**
 * @swagger
 * /hni/dashboard:
 *   get:
 *     summary: HNI dashboard - portfolio summary, curated deals, active deal interests, shortlist, manager
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: investorId, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Dashboard } }
 */
hniRouter.get('/dashboard', authenticate, investorIdQuery, validate, hni.dashboard);

/**
 * @swagger
 * /hni/deals:
 *   get:
 *     summary: Curated deal flow - special situation, auctions, institutional and high-ticket commercial, matched to the investor's profile
 *     description: Full details for verified investors / staff, masked teasers otherwise. Institutional names stay masked.
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: investorId, schema: { type: string, format: uuid } }
 *       - { in: query, name: listingCategory, schema: { type: string, enum: [special_situation, auction, institutional, residential] } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: matchProfile, schema: { type: boolean, default: true } }
 *       - { in: query, name: includePast, schema: { type: boolean } }
 *     responses: { 200: { description: Paginated deals + access + disclaimers } }
 */
hniRouter.get(
  '/deals',
  authenticate,
  [...investorIdQuery, query('listingCategory').optional().isIn(['special_situation', 'auction', 'institutional', 'residential'])],
  validate,
  hni.deals
);

/**
 * @swagger
 * /hni/deals/{propertyId}/track:
 *   post:
 *     summary: Record an investor action on a deal (shortlist, unshortlist, dismiss, share, document request)
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [shortlisted, unshortlisted, dismissed, shared, document_requested] } } } } }
 *     responses: { 201: { description: Recorded } }
 */
hniRouter.post(
  '/deals/:propertyId/track',
  authenticate,
  [param('propertyId').isUUID(), body('action').isIn(['shortlisted', 'unshortlisted', 'dismissed', 'shared', 'document_requested'])],
  validate,
  hni.trackDeal
);

/**
 * @swagger
 * /hni/shortlist:
 *   get:
 *     summary: Deals the caller has shortlisted
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Shortlisted deals } }
 */
hniRouter.get('/shortlist', authenticate, hni.shortlist);

const investmentValidators = [
  body('propertyId').optional({ nullable: true }).isUUID(),
  body('assetClass').optional().isIn(ASSET_CLASSES),
  body('acquisitionDate').optional({ nullable: true }).isISO8601(),
  body('acquisitionCost').optional().isFloat({ min: 0 }),
  body('additionalCosts').optional().isFloat({ min: 0 }),
  body('currentValuation').optional({ nullable: true }).isFloat({ min: 0 }),
  body('valuationDate').optional({ nullable: true }).isISO8601(),
  body('monthlyRentalIncome').optional().isFloat({ min: 0 }),
  body('annualExpenses').optional().isFloat({ min: 0 }),
  body('status').optional().isIn(['active', 'exit_planned', 'exited']),
  body('targetExitDate').optional({ nullable: true }).isISO8601(),
  body('targetExitValue').optional({ nullable: true }).isFloat({ min: 0 }),
  body('exitDate').optional({ nullable: true }).isISO8601(),
  body('exitValue').optional({ nullable: true }).isFloat({ min: 0 }),
];

/**
 * @swagger
 * /hni/portfolio:
 *   get:
 *     summary: Portfolio positions with computed metrics (ROI, gross/net yield, CAGR) and liquidity
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: investorId, schema: { type: string, format: uuid } }
 *       - { in: query, name: status, schema: { type: string, enum: [active, exit_planned, exited] } }
 *     responses: { 200: { description: Positions + disclaimers } }
 *   post:
 *     summary: Add a portfolio position
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, acquisitionCost]
 *             properties:
 *               investorId: { type: string, format: uuid }
 *               propertyId: { type: string, format: uuid }
 *               title: { type: string }
 *               assetClass: { type: string, enum: [residential, commercial, institutional, land, special_situation, auction, hospitality, other] }
 *               city: { type: string }
 *               locality: { type: string }
 *               propertyType: { type: string }
 *               acquisitionDate: { type: string, format: date }
 *               acquisitionCost: { type: number }
 *               additionalCosts: { type: number }
 *               currentValuation: { type: number }
 *               monthlyRentalIncome: { type: number }
 *               annualExpenses: { type: number }
 *               status: { type: string, enum: [active, exit_planned, exited] }
 *               targetExitDate: { type: string, format: date }
 *               targetExitValue: { type: number }
 *     responses: { 201: { description: Position with metrics } }
 */
hniRouter.get('/portfolio', authenticate, [...investorIdQuery, query('status').optional().isIn(['active', 'exit_planned', 'exited'])], validate, hni.listPortfolio);
hniRouter.post(
  '/portfolio',
  authenticate,
  [body('investorId').optional().isUUID(), body('title').isString().notEmpty(), body('acquisitionCost').isFloat({ min: 0 }), ...investmentValidators],
  validate,
  hni.createInvestment
);

/**
 * @swagger
 * /hni/portfolio/summary:
 *   get:
 *     summary: Portfolio totals, yields, allocation by asset class / city, liquidity mix and exit pipeline
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: investorId, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Summary } }
 */
hniRouter.get('/portfolio/summary', authenticate, investorIdQuery, validate, hni.summary);

/**
 * @swagger
 * /hni/portfolio/{id}:
 *   get:
 *     summary: One position with metrics
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Position } }
 *   put:
 *     summary: Update a position (revaluation, exit planning, mark exited - exitDate + exitValue required)
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { content: { application/json: { schema: { type: object } } } }
 *     responses: { 200: { description: Position } }
 *   delete:
 *     summary: Remove a position
 *     tags: [HNI]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Removed } }
 */
hniRouter.get('/portfolio/:id', authenticate, idParam, validate, hni.getInvestment);
hniRouter.put('/portfolio/:id', authenticate, [...idParam, body('title').optional().isString().notEmpty(), ...investmentValidators], validate, hni.updateInvestment);
hniRouter.delete('/portfolio/:id', authenticate, idParam, validate, hni.deleteInvestment);

// =============================== Tools ===============================

/**
 * @swagger
 * /tools/roi:
 *   post:
 *     summary: Indicative ROI over a holding period (appreciation + net rent - costs, optional loan)
 *     tags: [Investment Tools]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [purchasePrice]
 *             properties:
 *               purchasePrice: { type: number }
 *               acquisitionCosts: { type: number }
 *               monthlyRent: { type: number }
 *               annualExpenses: { type: number }
 *               annualAppreciationPercent: { type: number }
 *               holdingYears: { type: number }
 *               exitCostPercent: { type: number }
 *               loanAmount: { type: number }
 *               loanInterestPercent: { type: number }
 *     responses: { 200: { description: ROI, annualised ROI, equity multiple + disclaimers } }
 */
toolsRouter.post(
  '/roi',
  [
    body('purchasePrice').isFloat({ gt: 0 }),
    body(['acquisitionCosts', 'monthlyRent', 'annualExpenses', 'exitCostPercent', 'loanAmount', 'loanInterestPercent']).optional().isFloat({ min: 0 }),
    body('annualAppreciationPercent').optional().isFloat({ min: -50, max: 100 }),
    body('holdingYears').optional().isFloat({ min: 0.5, max: 30 }),
  ],
  validate,
  tools.roi
);

/**
 * @swagger
 * /tools/rental-yield:
 *   post:
 *     summary: Indicative gross / net rental yield and payback period
 *     tags: [Investment Tools]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [propertyPrice, monthlyRent]
 *             properties:
 *               propertyPrice: { type: number }
 *               monthlyRent: { type: number }
 *               annualExpenses: { type: number }
 *               vacancyMonths: { type: number }
 *               acquisitionCosts: { type: number }
 *     responses: { 200: { description: Yields + disclaimers } }
 */
toolsRouter.post(
  '/rental-yield',
  [
    body('propertyPrice').isFloat({ gt: 0 }),
    body('monthlyRent').isFloat({ min: 0 }),
    body(['annualExpenses', 'acquisitionCosts']).optional().isFloat({ min: 0 }),
    body('vacancyMonths').optional().isFloat({ min: 0, max: 12 }),
  ],
  validate,
  tools.rentalYield
);

/**
 * @swagger
 * /tools/appreciation:
 *   post:
 *     summary: Indicative capital appreciation projection (year-by-year)
 *     tags: [Investment Tools]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentValue, annualAppreciationPercent]
 *             properties:
 *               currentValue: { type: number }
 *               annualAppreciationPercent: { type: number }
 *               years: { type: integer, default: 5 }
 *     responses: { 200: { description: Projection + disclaimers } }
 */
toolsRouter.post(
  '/appreciation',
  [body('currentValue').isFloat({ gt: 0 }), body('annualAppreciationPercent').isFloat({ min: -50, max: 100 }), body('years').optional().isInt({ min: 1, max: 30 })],
  validate,
  tools.appreciation
);

/**
 * @swagger
 * /tools/liquidity-score:
 *   get:
 *     summary: Liquidity / Saleability score for an area (High / Moderate / Low) from platform demand, supply and deal velocity
 *     tags: [Investment Tools]
 *     parameters:
 *       - { in: query, name: city, required: true, schema: { type: string } }
 *       - { in: query, name: locality, schema: { type: string } }
 *       - { in: query, name: propertyType, schema: { type: string } }
 *       - { in: query, name: price, schema: { type: number } }
 *     responses: { 200: { description: Score, band, factors, signals + disclaimers } }
 */
toolsRouter.get('/liquidity-score', [query('city').notEmpty().withMessage('city is required'), query('price').optional().isFloat({ min: 0 })], validate, tools.liquidity);

module.exports = { investorRouter, nriRouter, hniRouter, toolsRouter };
