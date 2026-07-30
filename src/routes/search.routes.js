const express = require('express');
const { query } = require('express-validator');
const router = express.Router();

const searchController = require('../controllers/search.controller');
const validate = require('../middlewares/validate');

const PROPERTY_TYPES = ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'];
const TRANSACTION_TYPES = ['buy', 'sell', 'rent'];

/**
 * @swagger
 * tags:
 *   name: Search
 *   description: >
 *     Public property search. No authentication required. Only listings with
 *     status `approved` are ever returned here.
 */

/**
 * @swagger
 * /search/properties:
 *   get:
 *     summary: Search approved property listings
 *     tags: [Search]
 *     parameters:
 *       - in: query
 *         name: city
 *         schema: { type: string }
 *       - in: query
 *         name: locality
 *         schema: { type: string }
 *       - in: query
 *         name: propertyType
 *         schema: { type: string, enum: [apartment, villa, independent_house, plot, commercial, farmhouse, other] }
 *       - in: query
 *         name: transactionType
 *         schema: { type: string, enum: [buy, sell, rent] }
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: amenities
 *         schema: { type: string }
 *         description: Comma-separated list of required amenities, e.g. "parking,gym"
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [price_asc, price_desc, newest], default: newest }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated list of approved properties matching the filters
 */
router.get(
  '/properties',
  [
    query('propertyType').optional().isIn(PROPERTY_TYPES),
    query('transactionType').optional().isIn(TRANSACTION_TYPES),
    query('minPrice').optional().isFloat({ min: 0 }),
    query('maxPrice').optional().isFloat({ min: 0 }),
    query('sort').optional().isIn(['price_asc', 'price_desc', 'newest']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  searchController.searchProperties
);

/**
 * @swagger
 * /search/filters:
 *   get:
 *     summary: Get available filter options (cities, property types, price range) for building search UI
 *     tags: [Search]
 *     responses:
 *       200:
 *         description: Available filter options
 */
router.get('/filters', searchController.getFilters);

/**
 * @swagger
 * /search/suggestions:
 *   get:
 *     summary: Autocomplete suggestions for city/locality search
 *     tags: [Search]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search term to autocomplete against city/locality
 *     responses:
 *       200:
 *         description: List of matching city/locality suggestions
 *       422:
 *         description: Validation failed (missing q)
 */
router.get(
  '/suggestions',
  [query('q').notEmpty().withMessage('Query parameter "q" is required')],
  validate,
  searchController.getSuggestions
);

module.exports = router;
