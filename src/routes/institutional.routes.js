const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const institutional = require('../services/institutional.service');
const valuation = require('../services/institutionalValuation.service');

// Engine 7 - Institutional. Mounted at /api/institutional.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const idp = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   name: Institutional
 *   description: >
 *     Engine 7 - institutional assets (schools, colleges, universities, hospitals, hotels, campuses). Listings are
 *     confidential: the public sees type, locality, an enrollment range and a price range; the name and figures are
 *     returned only to staff, the lister, or a buyer who is qualified + has signed the NDA + has admin approval.
 *     Nine-stage deal pipeline, buyer qualification, institutional due diligence and valuation intelligence.
 */

/**
 * @swagger
 * /institutional/meta:
 *   get:
 *     summary: Asset classes, deal types, buyer types, the nine stages and the mandatory disclaimer
 *     tags: [Institutional]
 *     responses: { 200: { description: Reference data } }
 * /institutional/listings:
 *   get:
 *     summary: Public masked listings with the institutional filters
 *     tags: [Institutional]
 *     parameters:
 *       - { in: query, name: assetClass, schema: { type: string } }
 *       - { in: query, name: sector, schema: { type: string, enum: [education, healthcare, hospitality, other] } }
 *       - { in: query, name: board, schema: { type: string } }
 *       - { in: query, name: dealType, schema: { type: string, enum: [full_sale, stake_sale, lease, jv, management_takeover] } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: budgetMinCr, schema: { type: number } }
 *       - { in: query, name: budgetMaxCr, schema: { type: number } }
 *       - { in: query, name: campusMinAcres, schema: { type: number } }
 *       - { in: query, name: campusMaxAcres, schema: { type: number } }
 *     responses: { 200: { description: Masked listings } }
 *   post:
 *     summary: Create an institutional listing (staff, certified institutional brokers, or the institution's own seller). Latitude / longitude are mandatory.
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Listing (pending approval unless created by staff) } }
 * /institutional/listings/{id}:
 *   get:
 *     summary: One listing - masked, or full (with valuation, due diligence and the representative) when the caller has passed all three gates
 *     tags: [Institutional]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: "{ access, listing, valuation?, dueDiligence?, representative?, myDeal }" } }
 *   put:
 *     summary: Update a listing (lister or staff)
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Listing } }
 */
router.get('/meta', h(async (req, res) => ok(res, 'Institutional reference data', await institutional.meta())));
router.get(
  '/listings',
  [query('dealType').optional().isIn(Object.keys(institutional.DEAL_TYPES)), query('assetClass').optional().isIn(Object.keys(institutional.ASSET_CLASSES)), query('sector').optional().isIn(['education', 'healthcare', 'hospitality', 'other'])],
  validate,
  h(async (req, res) => ok(res, 'Institutional listings', await institutional.listPublic(req.query)))
);

const listingRules = (create) => [
  (create ? body('institutionName').isString().trim().isLength({ min: 2, max: 200 }) : body('institutionName').optional().isString().trim().isLength({ min: 2, max: 200 })),
  (create ? body('assetClass').isIn(Object.keys(institutional.ASSET_CLASSES)) : body('assetClass').optional().isIn(Object.keys(institutional.ASSET_CLASSES))),
  (create ? body('city').isString().trim().isLength({ min: 2, max: 120 }) : body('city').optional().isString().trim().isLength({ min: 2, max: 120 })),
  body('locality').optional({ nullable: true }).isString().isLength({ max: 160 }),
  body('address').optional({ nullable: true }).isString().isLength({ max: 400 }),
  body('latitude').optional().isFloat({ min: -90, max: 90 }),
  body('longitude').optional().isFloat({ min: -180, max: 180 }),
  body('dealType').optional().isIn(Object.keys(institutional.DEAL_TYPES)),
  body('nocStatus').optional().isIn(['valid', 'pending', 'expired', 'not_applicable']),
  body('landOwnership').optional().isIn(['owned', 'leased', 'trust_held', 'mixed']),
  body('yearEstablished').optional({ nullable: true }).isInt({ min: 1800, max: 2100 }),
  ...['campusAreaSqft', 'campusAreaAcres', 'builtUpAreaSqft', 'askingPriceCr', 'annualRevenueCr', 'ebitdaCr', 'revenueMultiple', 'ebitdaMultiple'].map((f) => body(f).optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0 })),
  ...['buildingCount', 'studentEnrollment', 'facultyCount', 'capacityUnits'].map((f) => body(f).optional({ nullable: true, checkFalsy: true }).isInt({ min: 0 })),
  body('approvals').optional().isArray({ max: 20 }),
  body('enrollmentHistory').optional().isArray({ max: 15 }),
  body('infrastructure').optional({ nullable: true }).isString().isLength({ max: 4000 }),
  body('isConfidential').optional().isBoolean(),
];
router.post('/listings', authenticate, listingRules(true), validate, h(async (req, res) => ok(res, 'Institutional listing saved', await institutional.createListing(req.user, req.body, meta(req)), 201)));
router.get('/listings/:id', optionalAuthenticate, idp, validate, h(async (req, res) => ok(res, 'Institutional listing', await institutional.getListing(req.user || null, req.params.id))));
router.put('/listings/:id', authenticate, idp, listingRules(false), validate, h(async (req, res) => ok(res, 'Institutional listing updated', await institutional.updateListing(req.user, req.params.id, req.body, meta(req)))));

/**
 * @swagger
 * /institutional/listings/{id}/interest:
 *   post:
 *     summary: Express interest (Stage 1 - Intent Received). Creates the CRM lead through the assignment cascade and the pipeline record.
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: The buyer's deal tracker } }
 * /institutional/my/listings:
 *   get:
 *     summary: The caller's institutional listings with interest counts
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Listings } }
 * /institutional/my/deals:
 *   get:
 *     summary: The caller's institutional deals - stage tracker, NDA status, next step, offers
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Deals } }
 * /institutional/buyer-profile:
 *   get:
 *     summary: The caller's institutional buyer profile and qualification status
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile or null } }
 *   put:
 *     summary: Submit / update the buyer profile (multipart; optional proof-of-funds file "capacityDocument") - goes to staff for qualification
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile } }
 */
router.post('/listings/:id/interest', authenticate, idp, [body('message').optional({ checkFalsy: true }).isString().isLength({ max: 1000 })], validate, h(async (req, res) => ok(res, 'Interest registered', await institutional.expressInterest(req.user, req.params.id, req.body, meta(req)), 201)));
router.get('/my/listings', authenticate, h(async (req, res) => ok(res, 'My institutional listings', await institutional.myListings(req.user))));
router.get('/my/deals', authenticate, h(async (req, res) => ok(res, 'My institutional deals', await institutional.myDeals(req.user))));
router.get('/buyer-profile', authenticate, h(async (req, res) => ok(res, 'Institutional buyer profile', await institutional.getBuyerProfile(req.user.id))));
router.put(
  '/buyer-profile',
  authenticate,
  uploadDocumentFile.single('capacityDocument'),
  [body('buyerType').isString(), body('budgetMinCr').optional({ checkFalsy: true }).isFloat({ min: 0 }), body('budgetMaxCr').optional({ checkFalsy: true }).isFloat({ min: 0 }), body('intent').optional({ checkFalsy: true }).isString().isLength({ max: 2000 }), body('capacityNote').optional({ checkFalsy: true }).isString().isLength({ max: 2000 })],
  validate,
  h(async (req, res) => {
    const b = { ...req.body };
    for (const k of ['geographies', 'assetClasses']) if (typeof b[k] === 'string' && b[k].trim().startsWith('[')) b[k] = JSON.parse(b[k]);
    ok(res, 'Buyer profile submitted', await institutional.saveBuyerProfile(req.user, b, req.file, meta(req)));
  })
);

/**
 * @swagger
 * /institutional/deals/{id}:
 *   get:
 *     summary: Pipeline tracker for one deal (staff, the buyer, or the lister)
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Deal view } }
 * /institutional/deals/{id}/offers:
 *   post:
 *     summary: Add a term sheet / offer / counter-offer (stage 8). Buyers add offers on their own deal; staff record any party's.
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Deal view } }
 */
router.get('/deals/:id', authenticate, idp, validate, h(async (req, res) => ok(res, 'Institutional deal', await institutional.dealView(req.user, req.params.id))));
router.post(
  '/deals/:id/offers',
  authenticate,
  idp,
  [body('amountCr').isFloat({ gt: 0 }), body('kind').optional().isIn(['term_sheet', 'offer', 'counter_offer']), body('byParty').optional().isIn(['buyer', 'seller', 'platform']), body('terms').optional({ checkFalsy: true }).isString().isLength({ max: 4000 })],
  validate,
  h(async (req, res) => ok(res, 'Offer recorded', await institutional.addOffer(req.user, req.params.id, req.body, meta(req)), 201))
);

// ------------------------------------------------------------ staff
/**
 * @swagger
 * /institutional/manage/summary:
 *   get: { summary: "Staff - counts for the institutional desk", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Summary } } }
 * /institutional/manage/listings:
 *   get: { summary: "Staff - all institutional listings with full details", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Listings } } }
 * /institutional/manage/deals:
 *   get: { summary: "Staff - the nine-stage pipeline (filter by stage / status)", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: "{ items, stages }" } } }
 *   post: { summary: "Staff - open a deal for a buyer on an asset", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 201: { description: Deal view } } }
 * /institutional/manage/deals/{id}/{action}:
 *   post:
 *     summary: "Staff action: screen, schedule_visit, complete_visit, share_valuation, clear_legal, note, hold, resume, drop, assign, move (admin override with reason)"
 *     tags: [Institutional]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Deal view after the action (the stage advances by itself when its requirement is met) } }
 * /institutional/manage/deals/{id}/close:
 *   post: { summary: "Stage 9 - record agreement execution + payment confirmation; closes the deal and adds it to comparables", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Deal view } } }
 * /institutional/manage/offers/{id}:
 *   put: { summary: "Accept / reject / withdraw an open offer", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Deal view } } }
 * /institutional/manage/buyers:
 *   get: { summary: "Buyer qualification queue", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Buyers } } }
 * /institutional/manage/buyers/{id}:
 *   put: { summary: "Qualify or reject a buyer", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Buyer } } }
 * /institutional/manage/listings/{id}/valuation:
 *   post: { summary: "Recompute the valuation for a listing", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Valuation } } }
 * /institutional/manage/listings/{id}/due-diligence:
 *   get: { summary: "Due-diligence report with staff notes", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Report } } }
 *   put: { summary: "Record a review item (ownershipChain, encumbrance, enrollmentAudit, municipalCompliance)", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Report } } }
 * /institutional/manage/comparables:
 *   get: { summary: "Comparable transactions", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 200: { description: Comparables } } }
 *   post: { summary: "Add a comparable transaction (re-benchmarks that asset class)", tags: [Institutional], security: [{ bearerAuth: [] }], responses: { 201: { description: Comparable } } }
 */
const manage = express.Router();
manage.use(authenticate, authorize(...STAFF));
manage.get('/summary', h(async (req, res) => ok(res, 'Institutional summary', await institutional.summary())));
manage.get('/listings', h(async (req, res) => ok(res, 'Institutional listings', await institutional.listForStaff(req.query))));
manage.get('/deals', h(async (req, res) => ok(res, 'Institutional pipeline', await institutional.listDeals(req.user, req.query))));
manage.post('/deals', [body('propertyId').isUUID(), body('buyerUserId').optional({ checkFalsy: true }).isUUID(), body('customerId').optional({ checkFalsy: true }).isUUID()], validate, h(async (req, res) => ok(res, 'Institutional deal opened', await institutional.staffCreateDeal(req.user, req.body, meta(req)), 201)));
manage.post(
  '/deals/:id/close',
  idp,
  [body('agreementDate').isISO8601(), body('paymentConfirmed').isBoolean(), body('agreedValueCr').optional({ checkFalsy: true }).isFloat({ gt: 0 })],
  validate,
  h(async (req, res) => ok(res, 'Institutional deal closed', await institutional.closeDeal(req.user, req.params.id, { ...req.body, paymentConfirmed: req.body.paymentConfirmed === true || req.body.paymentConfirmed === 'true' }, meta(req))))
);
manage.post(
  '/deals/:id/:action',
  idp,
  [param('action').isIn(['screen', 'schedule_visit', 'complete_visit', 'share_valuation', 'clear_legal', 'note', 'hold', 'resume', 'drop', 'assign', 'move']), body('note').optional({ checkFalsy: true }).isString().isLength({ max: 4000 }), body('at').optional().isISO8601(), body('repId').optional().isUUID(), body('stage').optional().isIn(institutional.STAGES)],
  validate,
  h(async (req, res) => ok(res, 'Done', await institutional.act(req.user, req.params.id, req.params.action, req.body, meta(req))))
);
manage.put('/offers/:id', idp, [body('decision').isIn(['accepted', 'rejected', 'withdrawn'])], validate, h(async (req, res) => ok(res, 'Offer updated', await institutional.decideOffer(req.user, req.params.id, req.body, meta(req)))));
manage.get('/buyers', [query('status').optional().isIn(['pending', 'qualified', 'rejected'])], validate, h(async (req, res) => ok(res, 'Institutional buyers', await institutional.listBuyers(req.query))));
manage.put('/buyers/:id', idp, [body('decision').isIn(['qualified', 'rejected']), body('note').optional({ checkFalsy: true }).isString().isLength({ max: 1000 })], validate, h(async (req, res) => ok(res, 'Buyer updated', await institutional.decideBuyer(req.user, req.params.id, req.body, meta(req)))));
manage.get('/buyers/:id/capacity-document', idp, validate, h(async (req, res) => ok(res, 'Document link', await institutional.buyerCapacityDocumentUrl(req.params.id))));
manage.post('/listings/:id/valuation', idp, validate, h(async (req, res) => ok(res, 'Valuation recomputed', await valuation.refresh(req.params.id))));
manage.get('/listings/:id/due-diligence', idp, validate, h(async (req, res) => ok(res, 'Institutional due diligence', await institutional.dueDiligence(req.params.id, { internal: true }))));
manage.put('/listings/:id/due-diligence', idp, [body('key').isString(), body('status').isIn(['ok', 'issue', 'pending']), body('note').optional({ checkFalsy: true }).isString().isLength({ max: 2000 })], validate, h(async (req, res) => ok(res, 'Review recorded', await institutional.reviewDueDiligence(req.user, req.params.id, req.body, meta(req)))));
manage.get('/comparables', h(async (req, res) => ok(res, 'Comparables', await institutional.listComparables(req.query))));
manage.post('/comparables', [body('assetClass').isIn(Object.keys(institutional.ASSET_CLASSES)), body('dealValueCr').isFloat({ gt: 0 })], validate, h(async (req, res) => ok(res, 'Comparable added', await institutional.addComparable(req.user, req.body, meta(req)), 201)));
manage.delete('/comparables/:id', idp, validate, h(async (req, res) => ok(res, 'Comparable removed', await institutional.removeComparable(req.user, req.params.id, meta(req)))));
router.use('/manage', manage);

module.exports = router;
