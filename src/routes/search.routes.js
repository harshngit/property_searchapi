const express = require('express');
const { query, param } = require('express-validator');
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
 *     description: >
 *       Residential (and commercial) listings by default - auction, special-situation
 *       and institutional listings are excluded unless `listingCategory` asks for them,
 *       in which case they come back as masked teasers (full detail is at
 *       /opportunities/{id}). Full addresses are never returned publicly and
 *       coordinates are rounded to ~100 m. Response includes `disclaimers`.
 *     tags: [Search]
 *     parameters:
 *       - in: query
 *         name: listingCategory
 *         schema: { type: string, enum: [residential, institutional, special_situation, auction] }
 *       - in: query
 *         name: purpose
 *         schema: { type: string, enum: [buy, rent] }
 *         description: Website menu - buy = listings for sale (transaction_type sell), rent = rental/lease listings
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Free-text match on title / locality / city
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *         description: Minimum price in INR (numeric price_value)
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: bedrooms
 *         schema: { type: integer }
 *         description: Minimum bedrooms
 *       - in: query
 *         name: furnishing
 *         schema: { type: string }
 *       - in: query
 *         name: possessionStatus
 *         schema: { type: string }
 *       - in: query
 *         name: verified
 *         schema: { type: boolean }
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
 *         name: minRate
 *         schema: { type: number }
 *         description: Minimum price per sq.ft.
 *       - in: query
 *         name: maxRate
 *         schema: { type: number }
 *         description: Maximum price per sq.ft.
 *       - in: query
 *         name: amenities
 *         schema: { type: string }
 *         description: Comma-separated list of required amenities, e.g. "parking,gym"
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [rate_asc, rate_desc, price_asc, price_desc, newest, verified], default: newest }
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
    query('listingCategory').optional().isIn(['residential', 'institutional', 'special_situation', 'auction']),
    query('purpose').optional().isIn(['buy', 'rent']),
    query('minRate').optional().isFloat({ min: 0 }),
    query('maxRate').optional().isFloat({ min: 0 }),
    query('minPrice').optional().isFloat({ min: 0 }),
    query('maxPrice').optional().isFloat({ min: 0 }),
    query('bedrooms').optional().isInt({ min: 0 }),
    query('verified').optional().isBoolean(),
    query('sort').optional().isIn(['rate_asc', 'rate_desc', 'price_asc', 'price_desc', 'newest', 'verified']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  searchController.searchProperties
);

/**
 * @swagger
 * /search/properties/{id}:
 *   get:
 *     summary: Get a single approved property's full details (public, unauthenticated)
 *     description: Only returns listings with status `approved` - a pending/draft/rejected id 404s the same as a missing one, so their existence isn't leaked publicly.
 *     tags: [Search]
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
  '/properties/:id',
  [param('id').isUUID().withMessage('Invalid property id')],
  validate,
  searchController.getProperty
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
 * /search/home:
 *   get:
 *     summary: Website home page feed in one call
 *     description: Headline counts, verified + latest residential listings, top cities, auction highlights (teasers), featured articles, disclaimers.
 *     tags: [Search]
 *     responses:
 *       200:
 *         description: Home page data
 */
router.get('/home', searchController.getHome);

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
