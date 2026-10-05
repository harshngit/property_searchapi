const express = require('express');
const { query, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const market = require('../services/market.service');

// Engine 6 base data + RERA registry from the reference-data crawlers.
// Mounted at /api/market.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: Market
 *   description: >
 *     Market intelligence base data - price benchmarks from public portal market pages (aggregates only, never
 *     listings; portal names are not shown publicly), NHB Residex / RBI HPI indices, and the State RERA project
 *     registry. Every response carries the freshness disclaimer.
 */

/**
 * @swagger
 * /market/benchmarks:
 *   get:
 *     summary: Price benchmark for a city / locality - average price per sq ft, change, demand, yield, index trend, circle rate
 *     tags: [Market]
 *     parameters:
 *       - { in: query, name: city, required: true, schema: { type: string } }
 *       - { in: query, name: locality, schema: { type: string } }
 *       - { in: query, name: propertyType, schema: { type: string } }
 *       - { in: query, name: transactionType, schema: { type: string, enum: [sell, rent] } }
 *     responses: { 200: { description: Benchmark with disclaimer } }
 */
router.get(
  '/benchmarks',
  [query('city').isString().isLength({ min: 2, max: 120 }), query('locality').optional().isString().isLength({ max: 160 }), query('propertyType').optional().isString().isLength({ max: 40 }), query('transactionType').optional().isIn(['sell', 'rent'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Market benchmark', await market.benchmarks(req.query)))
);

/**
 * @swagger
 * /market/rera/{number}:
 *   get:
 *     summary: Look a RERA registration number up in the crawled public registry
 *     tags: [Market]
 *     parameters: [{ in: path, name: number, required: true, schema: { type: string } }]
 *     responses: { 200: { description: "{ found, project, flags }" } }
 */
router.get(
  '/rera/:number',
  [param('number').isString().isLength({ min: 4, max: 80 })],
  validate,
  asyncHandler(async (req, res) => {
    const r = await market.reraCheck(req.params.number);
    success(res, 200, r.found ? 'RERA project' : 'Not found in the registry', { found: r.found, registryLoaded: r.registryLoaded, project: r.project || null, flags: r.flags.map((f) => ({ severity: f.severity, detail: f.detail })) });
  })
);

/**
 * @swagger
 * /market/overview:
 *   get:
 *     summary: Staff - everything the reference crawlers hold (counts, latest market stats per portal, indices, promoters to watch)
 *     tags: [Market]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Overview } }
 */
router.get('/overview', authenticate, authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Market data', await market.overview())));

/**
 * @swagger
 * /market/rera:
 *   get:
 *     summary: Staff - search the RERA project registry
 *     tags: [Market]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: state, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [ongoing, completed, delayed, lapsed, revoked, unknown] } }
 *     responses: { 200: { description: Projects } }
 */
router.get(
  '/rera',
  authenticate,
  authorize(...STAFF, 'broker', 'agency_admin', 'builder'),
  [query('q').optional().isString().isLength({ max: 120 }), query('state').optional().isString(), query('status').optional().isIn(['ongoing', 'completed', 'delayed', 'lapsed', 'revoked', 'unknown'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'RERA projects', await market.searchRera(req.query)))
);

module.exports = router;
