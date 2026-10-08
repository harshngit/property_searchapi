const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const exchange = require('../services/exchange.service');

// Module 45 - Property Exchange Engine. Mounted at /api/exchange.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const idp = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   name: Exchange
 *   description: >
 *     Module 45 - exchange an old or stuck-up property for a new one. Model A direct swap between two owners, Model B
 *     trade-in against builder stock, plus upgrade, reinvest, downsize and hold-and-rent paths. Valuations and guidance
 *     are indicative and carry the disclaimer. An exchange is two linked deals; each leg has its own 1% + GST fee and
 *     both close together. Owners never see each other's identity or contact.
 */

/**
 * @swagger
 * /exchange/requests:
 *   get:
 *     summary: My exchange requests (staff - all; status filter)
 *     tags: [Exchange]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Requests } }
 *   post:
 *     summary: Raise an exchange request on one of my listings (sets exchange_intent, values the property, assigns a representative)
 *     tags: [Exchange]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oldPropertyId]
 *             properties:
 *               oldPropertyId: { type: string, format: uuid }
 *               reinvestmentIntent: { type: string, enum: [buy_another, invest_auction, downsize, direct_swap, guidance] }
 *               wantedCity: { type: string }
 *               wantedLocalities: { type: array, items: { type: string } }
 *               wantedPropertyType: { type: string }
 *               wantedBedroomsMin: { type: integer }
 *               wantedBudgetMax: { type: number }
 *               notes: { type: string }
 *     responses: { 201: { description: Request with its guidance panel and options } }
 * /exchange/requests/{id}:
 *   get:
 *     summary: One request - valuation, reinvestment guidance, options with value gaps, linked deals
 *     tags: [Exchange]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Request detail } }
 * /exchange/requests/{id}/interest:
 *   post:
 *     summary: Owner marks the option they want (their representative then confirms it)
 *     tags: [Exchange]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Interest recorded } }
 * /exchange/requests/{id}/valuation:
 *   put:
 *     summary: Staff set the indicative valuation with its basis
 *     tags: [Exchange]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Valuation saved } }
 * /exchange/interests/{id}/confirm:
 *   post:
 *     summary: Staff confirm the chosen option - opens the linked deals
 *     tags: [Exchange]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Deals opened } }
 * /exchange/requests/{id}/close:
 *   post:
 *     summary: Staff close both legs of the exchange together
 *     tags: [Exchange]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Exchange closed }, 400: { description: A leg is not ready } }
 */
router.use(authenticate);

router.get('/meta', h(async (req, res) => ok(res, 'Exchange options', { intents: Object.entries(exchange.INTENTS).map(([value, label]) => ({ value, label })), options: exchange.OPTION_LABEL })));
router.get('/my-listings', h(async (req, res) => ok(res, 'My listings', await exchange.myListings(req.user))));
router.get('/summary', authorize(...STAFF), h(async (req, res) => ok(res, 'Exchange summary', await exchange.summary())));
router.get('/requests', h(async (req, res) => ok(res, 'Exchange requests', await exchange.list(req.user, { status: req.query.status }))));
router.post(
  '/requests',
  [body('oldPropertyId').isUUID(), body('reinvestmentIntent').optional().isIn(Object.keys(exchange.INTENTS)), body('wantedBudgetMax').optional({ checkFalsy: true }).isFloat({ min: 0 }), body('wantedBedroomsMin').optional({ checkFalsy: true }).isInt({ min: 0, max: 20 })],
  validate,
  h(async (req, res) => ok(res, 'Exchange request raised', await exchange.create(req.user, req.body, meta(req)), 201))
);
router.get('/requests/:id', idp, validate, h(async (req, res) => ok(res, 'Exchange request', await exchange.detail(req.user, req.params.id))));
router.post('/requests/:id/interest', [...idp, body('optionKind').isIn(Object.keys(exchange.OPTION_LABEL)), body('propertyId').optional({ checkFalsy: true }).isUUID()], validate, h(async (req, res) => ok(res, 'Interest recorded', await exchange.expressInterest(req.user, req.params.id, req.body, meta(req)), 201)));
router.post('/requests/:id/cancel', idp, validate, h(async (req, res) => ok(res, 'Exchange request cancelled', await exchange.cancel(req.user, req.params.id, req.body, meta(req)))));
router.put('/requests/:id/valuation', authorize(...STAFF), [...idp, body('value').isFloat({ gt: 0 }), body('note').isString().isLength({ min: 5, max: 500 })], validate, h(async (req, res) => ok(res, 'Valuation saved', await exchange.setValuation(req.user, req.params.id, req.body, meta(req)))));
router.post('/requests/:id/close', authorize(...STAFF), idp, validate, h(async (req, res) => ok(res, 'Exchange closed', await exchange.closeLinked(req.user, req.params.id, meta(req)))));
router.post('/interests/:id/confirm', authorize(...STAFF), idp, validate, h(async (req, res) => ok(res, 'Option confirmed', await exchange.confirmInterest(req.user, req.params.id, meta(req)))));
router.post('/interests/:id/decline', authorize(...STAFF), [...idp, body('note').isString().isLength({ min: 5, max: 500 })], validate, h(async (req, res) => ok(res, 'Option declined', await exchange.declineInterest(req.user, req.params.id, req.body, meta(req)))));

module.exports = router;
