const express = require('express');
const { body, query } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const areaIntel = require('../services/marketIntel/areaIntel.service');
const portfolio = require('../services/marketIntel/portfolio.service');
const buyerIntent = require('../services/marketIntel/buyerIntent.service');
const brokerForecast = require('../services/marketIntel/brokerForecast.service');

// Engine 6 - market intelligence outputs (rule-based, non-advisory).
// Mounted at /api/market-intel.
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const PIPELINE = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   - name: Market intelligence
 *     description: Engine 6 outputs - price trend (rising / stable / declining), area growth and investment potential scores, recommended investment areas, budget-based portfolio suggestions, buyer intent and broker performance forecasts. Rule-based; every output carries the non-advisory disclaimer.
 * /market-intel/areas:
 *   get:
 *     summary: Every scored area of a city with its trend, growth score, investment potential and recommendation (public)
 *     tags: [Market intelligence]
 *     parameters: [{ in: query, name: city, required: true, schema: { type: string } }]
 * /market-intel/area:
 *   get:
 *     summary: One area's outlook (public) - used on property pages
 *     tags: [Market intelligence]
 *     parameters: [{ in: query, name: city, required: true, schema: { type: string } }, { in: query, name: locality, schema: { type: string } }]
 * /market-intel/recommended:
 *   get:
 *     summary: Recommended investment areas, in one city or across the main cities (public)
 *     tags: [Market intelligence]
 * /market-intel/portfolio:
 *   post:
 *     summary: Budget-based portfolio suggestion from live listings in the better-scored areas (signed in)
 *     tags: [Market intelligence]
 *     security: [{ bearerAuth: [] }]
 * /market-intel/buyer-intent:
 *   get:
 *     summary: Buyers most likely to transact soon - the lead score plus recent activity (brokers see their own leads)
 *     tags: [Market intelligence]
 *     security: [{ bearerAuth: [] }]
 * /market-intel/broker-forecast:
 *   get:
 *     summary: Expected closures per broker over the next N days from the open pipeline (brokers see their own)
 *     tags: [Market intelligence]
 *     security: [{ bearerAuth: [] }]
 * /market-intel/snapshots:
 *   post:
 *     summary: Take this month's area snapshot now (it also runs on its own each month) (admin)
 *     tags: [Market intelligence]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/areas', [query('city').isString().isLength({ min: 2, max: 120 }), query('limit').optional().isInt({ min: 1, max: 500 })], validate, h(async (req, res) => ok(res, 'Area intelligence', await areaIntel.cityReport(req.query.city, { limit: Number(req.query.limit) || 100 }))));
router.get('/area', [query('city').isString().isLength({ min: 2, max: 120 }), query('locality').optional().isString().isLength({ max: 160 })], validate, h(async (req, res) => ok(res, 'Area outlook', await areaIntel.areaReport(req.query.city, req.query.locality || ''))));
router.get('/recommended', [query('city').optional().isString().isLength({ max: 120 }), query('limit').optional().isInt({ min: 1, max: 50 })], validate, h(async (req, res) => ok(res, 'Recommended areas', await areaIntel.recommended({ city: req.query.city, limit: Number(req.query.limit) || 10 }))));
router.post(
  '/portfolio',
  authenticate,
  [body('budget').isFloat({ min: 500000 }), body('city').optional({ nullable: true }).isString().isLength({ max: 120 }), body('risk').optional().isIn(portfolio.RISK), body('propertyTypes').optional().isArray({ max: 6 })],
  validate,
  h(async (req, res) => ok(res, 'Portfolio suggestion', await portfolio.suggest(req.body)))
);
router.get('/buyer-intent', authenticate, authorize(...PIPELINE), [query('limit').optional().isInt({ min: 1, max: 200 }), query('minScore').optional().isInt({ min: 0, max: 100 })], validate, h(async (req, res) => ok(res, 'Buyer intent', await buyerIntent.list(req.user, req.query))));
router.get(
  '/broker-forecast',
  authenticate,
  authorize(...PIPELINE),
  [query('horizonDays').optional().isIn(['30', '60', '90']), query('brokerId').optional().isUUID()],
  validate,
  h(async (req, res) => ok(res, 'Broker forecast', await brokerForecast.forecast(req.user, { horizonDays: Number(req.query.horizonDays) || 90, brokerId: req.query.brokerId || null })))
);
router.post('/snapshots', authenticate, authorize('admin', 'super_admin'), h(async (req, res) => ok(res, 'Snapshot taken', await areaIntel.snapshot())));

module.exports = router;
