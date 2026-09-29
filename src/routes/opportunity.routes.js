const crypto = require('crypto');
const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const opportunityController = require('../controllers/opportunity.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth');
const { uploadCsv } = require('../middlewares/upload');
const { error } = require('../utils/response');

const STAFF_ROLES = ['internal_sales', 'admin', 'super_admin'];
const ADMIN_ROLES = ['admin', 'super_admin'];
const CATEGORIES = ['auction', 'special_situation'];
const STAGES = ['lead', 'deal_interest', 'due_diligence', 'negotiation', 'closure', 'dropped'];
const SORTS = ['score', 'discount', 'auction_date', 'price_asc', 'price_desc', 'newest'];

// Crawlers (no user session) authenticate with `x-ingest-secret:
// <OPPORTUNITY_INGEST_SECRET>`; everyone else needs an admin bearer token.
// With no secret configured the header path is refused outright.
function ingestAuth(req, res, next) {
  const provided = req.headers['x-ingest-secret'];
  if (provided === undefined) {
    return authenticate(req, res, () => authorize(...ADMIN_ROLES)(req, res, next));
  }
  const expected = process.env.OPPORTUNITY_INGEST_SECRET;
  if (!expected) return error(res, 503, 'Ingest secret is not configured on the server');
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return error(res, 401, 'Invalid ingest secret');
  req.user = null;
  return next();
}

const listFilters = [
  query('listingCategory').optional().isIn(CATEGORIES),
  query('transactionType').optional().isIn(['buy', 'sell', 'rent']),
  query('purpose').optional().isIn(['buy', 'rent']),
  query('sort').optional().isIn(SORTS),
  query('minPrice').optional().isFloat({ min: 0 }),
  query('maxPrice').optional().isFloat({ min: 0 }),
  query('minScore').optional().isInt({ min: 0, max: 100 }),
  query('minDiscount').optional().isFloat(),
  query('liquidityBand').optional().isIn(['high', 'moderate', 'low']),
  query('situationTag').optional().isIn(['urgent_sale', 'financial_distress', 'investor_exit', 'time_bound_sale']),
  query('possessionType').optional().isIn(['physical', 'symbolic', 'vacant', 'occupied', 'unknown']),
  query('sourceType').optional().isString().isLength({ max: 40 }),
  query('propertyType').optional().isString().isLength({ max: 40 }),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

/**
 * @swagger
 * tags:
 *   name: Opportunity Deals
 *   description: >
 *     Engine 4 - Bank Auction & Special Situation deals ("High-Opportunity
 *     Investment Deals"). Casual visitors see masked teasers only; full details
 *     (source bank, reference, portal link, EMD, legal notes, documents) need a
 *     staff/broker role or a verified NRI/HNI investor profile. Includes the
 *     investor interest pipeline (Lead -> Deal Interest -> Due Diligence ->
 *     Negotiation -> Closure), matched-investor alerts, investment scoring, and
 *     the ingestion pipeline (crawler/CSV -> normalise -> review -> publish).
 *     Every response carries the mandatory disclaimers.
 */

/**
 * @swagger
 * /opportunities/public:
 *   get:
 *     summary: Public teaser list for the website's Bank Auction / Special Situation pages
 *     description: No login needed (a bearer token, if sent, is used to tell the caller whether they can unlock full details).
 *     tags: [Opportunity Deals]
 *     parameters:
 *       - { in: query, name: listingCategory, schema: { type: string, enum: [auction, special_situation], default: auction } }
 *       - { in: query, name: purpose, schema: { type: string, enum: [buy, rent] }, description: "buy = for sale, rent = rental / lease" }
 *       - { in: query, name: transactionType, schema: { type: string, enum: [buy, sell, rent] } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: locality, schema: { type: string } }
 *       - { in: query, name: propertyType, schema: { type: string } }
 *       - { in: query, name: sourceType, schema: { type: string } }
 *       - { in: query, name: minPrice, schema: { type: number } }
 *       - { in: query, name: maxPrice, schema: { type: number } }
 *       - { in: query, name: minScore, schema: { type: integer } }
 *       - { in: query, name: minDiscount, schema: { type: number } }
 *       - { in: query, name: liquidityBand, schema: { type: string, enum: [high, moderate, low] } }
 *       - { in: query, name: situationTag, schema: { type: string, enum: [urgent_sale, financial_distress, investor_exit, time_bound_sale] } }
 *       - { in: query, name: possessionType, schema: { type: string, enum: [physical, symbolic, vacant, occupied, unknown] } }
 *       - { in: query, name: includePast, schema: { type: boolean } }
 *       - { in: query, name: sort, schema: { type: string, enum: [score, discount, auction_date, price_asc, price_desc, newest] } }
 *     responses:
 *       200: { description: "{ items (teasers), pagination, access, disclaimers }" }
 */
router.get('/public', optionalAuthenticate, listFilters, validate, opportunityController.listPublic);

/**
 * @swagger
 * /opportunities/access:
 *   get:
 *     summary: Whether the current user can see full opportunity details (and why not)
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ full, reason, investorProfileStatus }" }
 */
router.get('/access', authenticate, opportunityController.access);

/**
 * @swagger
 * /opportunities/summary:
 *   get:
 *     summary: "[Staff] Live deals by category, pipeline by stage, ingestion queue, upcoming auctions"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Summary }
 */
router.get('/summary', authenticate, authorize(...STAFF_ROLES), opportunityController.summary);

/**
 * @swagger
 * /opportunities/interests:
 *   get:
 *     summary: Opportunity pipeline (staff see all; investors see their own)
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: stage, schema: { type: string, enum: [lead, deal_interest, due_diligence, negotiation, closure, dropped] } }
 *       - { in: query, name: propertyId, schema: { type: string, format: uuid } }
 *       - { in: query, name: assignedTo, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Paginated interests plus counts by stage }
 */
router.get(
  '/interests',
  authenticate,
  [query('stage').optional().isIn(STAGES), query('propertyId').optional().isUUID(), query('assignedTo').optional().isUUID()],
  validate,
  opportunityController.listInterests
);

/**
 * @swagger
 * /opportunities/interests/{id}:
 *   get:
 *     summary: Get one interest with its stage history
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Interest }
 */
router.get('/interests/:id', authenticate, [param('id').isUUID()], validate, opportunityController.getInterest);

/**
 * @swagger
 * /opportunities/interests/{id}/stage:
 *   put:
 *     summary: "[Staff] Move an interest to the next pipeline stage (or drop it)"
 *     description: One stage at a time. Dropping needs a reason in `notes`. Admins may step back one stage. Closure/drop also marks the linked CRM lead won/lost.
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [stage]
 *             properties:
 *               stage: { type: string, enum: [lead, deal_interest, due_diligence, negotiation, closure, dropped] }
 *               notes: { type: string }
 *     responses:
 *       200: { description: Updated }
 *       400: { description: Stage skip not allowed }
 */
router.put(
  '/interests/:id/stage',
  authenticate,
  authorize(...STAFF_ROLES),
  [param('id').isUUID(), body('stage').isIn(STAGES), body('notes').optional().isString()],
  validate,
  opportunityController.updateStage
);

/**
 * @swagger
 * /opportunities/interests/{id}/assign:
 *   put:
 *     summary: "[Admin] Assign an interest (and its CRM lead) to a representative"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [assignedTo], properties: { assignedTo: { type: string, format: uuid } } } } }
 *     responses:
 *       200: { description: Assigned }
 */
router.put(
  '/interests/:id/assign',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isUUID(), body('assignedTo').isUUID()],
  validate,
  opportunityController.assignInterest
);

/**
 * @swagger
 * /opportunities/ingest:
 *   post:
 *     summary: "[Admin / crawler] Ingest raw auction or special-situation records"
 *     description: >
 *       Auth: admin bearer token, or header `x-ingest-secret` (crawlers). Each raw
 *       record is normalised (prices like "85 Lakh", Indian dates, sq.yd/acre
 *       areas, property types, source type), contact details are stripped,
 *       confidence-scored (0-100), de-duplicated against live listings, and queued
 *       as needs_review - or auto-published when `opportunity.auto_publish_enabled`
 *       is on and confidence is at or above the threshold (never for legal notices).
 *       Records already seen (same source + reference id) are skipped.
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sourceName, items]
 *             properties:
 *               sourceName: { type: string, example: crawler_sbi }
 *               listingCategory: { type: string, enum: [auction, special_situation] }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   example: { title: "3 BHK flat, Rajouri Garden", bank: "State Bank of India", reserve_price: "1.2 Cr", emd: "12 Lakh", auction_date: "28/10/2026 11:30 AM", city: "Delhi", locality: "Rajouri Garden", area: "1450 sq ft", possession: "Physical", auction_id: "SBI-DL-2291" }
 *     responses:
 *       201: { description: Per-item outcome summary }
 */
router.post(
  '/ingest',
  ingestAuth,
  [
    body('sourceName').isString().notEmpty().withMessage('sourceName is required'),
    body('items').isArray({ min: 1, max: 1000 }).withMessage('items must be an array of 1-1000 records'),
    body('listingCategory').optional().isIn(CATEGORIES),
  ],
  validate,
  opportunityController.ingest
);

/**
 * @swagger
 * /opportunities/ingest/csv:
 *   post:
 *     summary: "[Admin] Ingest an auction list from CSV (same pipeline as /ingest)"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *               sourceName: { type: string }
 *               listingCategory: { type: string, enum: [auction, special_situation] }
 *     responses:
 *       201: { description: Per-item outcome summary }
 */
router.post(
  '/ingest/csv',
  authenticate,
  authorize(...ADMIN_ROLES),
  uploadCsv.single('file'),
  [body('listingCategory').optional().isIn(CATEGORIES)],
  validate,
  opportunityController.ingestCsv
);

/**
 * @swagger
 * /opportunities/ingest/queue:
 *   get:
 *     summary: "[Admin] Ingestion review queue"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [pending, needs_review, duplicate, published, rejected, failed] } }
 *       - { in: query, name: sourceName, schema: { type: string } }
 *     responses:
 *       200: { description: Paginated queue plus counts by status }
 */
router.get(
  '/ingest/queue',
  authenticate,
  authorize(...ADMIN_ROLES),
  [query('status').optional().isIn(['pending', 'needs_review', 'duplicate', 'published', 'rejected', 'failed'])],
  validate,
  opportunityController.listQueue
);

/**
 * @swagger
 * /opportunities/ingest/{id}:
 *   get:
 *     summary: "[Admin] Get one ingestion item (raw payload, normalised record, issues)"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Item }
 */
router.get('/ingest/:id', authenticate, authorize(...ADMIN_ROLES), [param('id').isUUID()], validate, opportunityController.getQueueItem);

/**
 * @swagger
 * /opportunities/ingest/{id}/publish:
 *   post:
 *     summary: "[Admin] Publish a reviewed item as a live, approved opportunity (sends investor alerts)"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               normalised: { type: object, description: Field corrections applied over the normalised record (snake_case keys) }
 *               notes: { type: string }
 *               forceDespiteDuplicate: { type: boolean }
 *     responses:
 *       201: { description: Published listing }
 *       400: { description: Missing required fields / duplicate / already handled }
 *       422: { description: Listing text failed content validation }
 */
router.post(
  '/ingest/:id/publish',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isUUID(), body('normalised').optional().isObject(), body('forceDespiteDuplicate').optional().isBoolean()],
  validate,
  opportunityController.publish
);

/**
 * @swagger
 * /opportunities/ingest/{id}/reject:
 *   post:
 *     summary: "[Admin] Reject an ingestion item"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { notes: { type: string } } } } }
 *     responses:
 *       200: { description: Rejected }
 */
router.post('/ingest/:id/reject', authenticate, authorize(...ADMIN_ROLES), [param('id').isUUID()], validate, opportunityController.reject);

/**
 * @swagger
 * /opportunities/alerts:
 *   get:
 *     summary: Investor deal-alert queue and history - pending (waiting for the investor's window), sent, suppressed (daily cap / repeatedly dismissed) (staff)
 *     tags: [Opportunities]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [pending, sent, suppressed] } }
 *       - { in: query, name: propertyId, schema: { type: string, format: uuid } }
 *     responses: { 200: { description: "{ items, last30Days }" } }
 */
router.get(
  '/alerts',
  authenticate,
  authorize('internal_sales', ...ADMIN_ROLES),
  [query('status').optional().isIn(['pending', 'sent', 'suppressed']), query('propertyId').optional().isUUID()],
  validate,
  require('../utils/asyncHandler')(async (req, res) =>
    require('../utils/response').success(res, 200, 'Alerts fetched', await require('../services/investorAlert.service').listAlerts(req.query))
  )
);

/**
 * @swagger
 * /opportunities/alerts/dispatch:
 *   post:
 *     summary: Deliver every pending alert that is due now (normally done by the background dispatcher every 5 minutes) (admin)
 *     tags: [Opportunities]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ due, sent, capped }" } }
 */
router.post(
  '/alerts/dispatch',
  authenticate,
  authorize(...ADMIN_ROLES),
  require('../utils/asyncHandler')(async (req, res) =>
    require('../utils/response').success(res, 200, 'Due alerts dispatched', await require('../services/investorAlert.service').dispatchDue())
  )
);

/**
 * @swagger
 * /opportunities/rescore-all:
 *   post:
 *     summary: Re-score every live deal (picks up the conversion-history learning adjustment; also runs daily) (admin)
 *     tags: [Opportunities]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ rescored }" } }
 */
router.post(
  '/rescore-all',
  authenticate,
  authorize(...ADMIN_ROLES),
  require('../utils/asyncHandler')(async (req, res) =>
    require('../utils/response').success(res, 200, 'Deals rescored', await require('../services/opportunityScoring.service').rescoreAll())
  )
);

/**
 * @swagger
 * /opportunities/{id}/matched-investors:
 *   get:
 *     summary: "[Staff] AI investor-deal matching - verified investors ranked by fit for this deal, with reasons"
 *     tags: [Opportunities]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: limit, schema: { type: integer, default: 20 } }
 *     responses: { 200: { description: Ranked investors } }
 */
router.get(
  '/:id/matched-investors',
  authenticate,
  authorize(...STAFF_ROLES),
  [param('id').isUUID(), query('limit').optional().isInt({ min: 1, max: 100 })],
  validate,
  require('../utils/asyncHandler')(async (req, res) =>
    require('../utils/response').success(
      res,
      200,
      'Matched investors fetched',
      await require('../services/irm.service').matchInvestorsForDeal(req.params.id, { limit: Number(req.query.limit) || 20 })
    )
  )
);

/**
 * @swagger
 * /opportunities/ingest/{id}/legal-review:
 *   post:
 *     summary: Lawyer-panel sign-off for an item from a legal / newspaper notice (required before it can be published)
 *     tags: [Opportunities]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { notes: { type: string } } }
 *     responses: { 200: { description: Queue item } }
 */
router.post(
  '/ingest/:id/legal-review',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isUUID(), body('notes').optional().isString().isLength({ max: 1000 })],
  validate,
  require('../utils/asyncHandler')(async (req, res) =>
    require('../utils/response').success(res, 200, 'Legal review recorded', await require('../services/opportunity.service').markLegalReviewed(req.params.id, req.body.notes, req.user))
  )
);

/**
 * @swagger
 * /opportunities:
 *   get:
 *     summary: Full opportunity list with scores and source details (staff, brokers, verified NRI/HNI investors)
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: listingCategory, schema: { type: string, enum: [auction, special_situation] } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: sort, schema: { type: string, enum: [score, discount, auction_date, price_asc, price_desc, newest] } }
 *     responses:
 *       200: { description: Paginated opportunities + disclaimers }
 *       403: { description: Investor profile missing or not yet verified }
 */
router.get('/', authenticate, listFilters, validate, opportunityController.list);

/**
 * @swagger
 * /opportunities/{id}:
 *   get:
 *     summary: Opportunity detail - full for eligible users, masked teaser otherwise
 *     tags: [Opportunity Deals]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Detail with media, score breakdown, my_interest, disclaimers }
 *       404: { description: Not found / not live }
 */
router.get('/:id', optionalAuthenticate, [param('id').isUUID()], validate, opportunityController.get);

/**
 * @swagger
 * /opportunities/{id}/interest:
 *   post:
 *     summary: Express interest in a deal - opens a CRM lead and a pipeline entry for the investor's representative
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               intendedBidAmount: { type: number }
 *               financingNeeded: { type: boolean }
 *               message: { type: string }
 *     responses:
 *       201: { description: Interest registered }
 *       200: { description: Already registered - existing interest returned }
 *       403: { description: Not eligible (profile missing / unverified) }
 */
router.post(
  '/:id/interest',
  authenticate,
  [
    param('id').isUUID(),
    body('intendedBidAmount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('financingNeeded').optional().isBoolean(),
    body('message').optional().isString().isLength({ max: 2000 }),
  ],
  validate,
  opportunityController.expressInterest
);

/**
 * @swagger
 * /opportunities/{id}/rescore:
 *   post:
 *     summary: "[Staff] Recompute investment score, discount and liquidity for a listing"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Scores with breakdown }
 */
router.post('/:id/rescore', authenticate, authorize(...STAFF_ROLES), [param('id').isUUID()], validate, opportunityController.rescore);

/**
 * @swagger
 * /opportunities/{id}/send-alerts:
 *   post:
 *     summary: "[Admin] (Re)send alerts for a live deal to matched verified investors (each investor alerted once per deal)"
 *     tags: [Opportunity Deals]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: "{ sent, matched, priority }" }
 */
router.post('/:id/send-alerts', authenticate, authorize(...ADMIN_ROLES), [param('id').isUUID()], validate, opportunityController.sendAlerts);

module.exports = router;
