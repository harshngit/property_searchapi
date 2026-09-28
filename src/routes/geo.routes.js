const express = require('express');
const { param, query } = require('express-validator');

const geoController = require('../controllers/geo.controller');
const validate = require('../middlewares/validate');

const geoRouter = express.Router();
const disclaimerRouter = express.Router();

/**
 * @swagger
 * tags:
 *   - name: Geography
 *     description: >
 *       Public, read-only geographic master data - states, cities, localities,
 *       pincodes, stamp duty and circle rates. Only geography an admin has
 *       activated is returned. Managed via /admin/master/*.
 *   - name: Disclaimers
 *     description: Admin-editable disclaimer library, rendered by content type and state (sec. 19.4).
 */

/**
 * @swagger
 * /geo/states:
 *   get:
 *     summary: List active states / UTs (with active city counts)
 *     tags: [Geography]
 *     parameters:
 *       - { in: query, name: includeInactive, schema: { type: boolean } }
 *     responses:
 *       200: { description: States }
 */
geoRouter.get('/states', geoController.listStates);

/**
 * @swagger
 * /geo/cities:
 *   get:
 *     summary: List live (active + coming soon) cities
 *     tags: [Geography]
 *     parameters:
 *       - { in: query, name: stateCode, schema: { type: string, example: DL } }
 *       - { in: query, name: status, schema: { type: string, enum: [active, coming_soon] } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses:
 *       200: { description: Cities }
 */
geoRouter.get(
  '/cities',
  [query('status').optional().isIn(['active', 'coming_soon'])],
  validate,
  geoController.listCities
);

/**
 * @swagger
 * /geo/nearest-city:
 *   get:
 *     summary: Resolve a visitor's coordinates to the nearest city (and the nearest city with live listings)
 *     description: >
 *       Uses the seeded city centres - no third-party geocoding. `city` is the
 *       nearest city when the point is inside its match radius; `listingCity`
 *       is the nearest city within 150 km that has live residential listings,
 *       with `searchName` being the spelling to pass to /search/properties.
 *       Clients should round coordinates (2 decimals is ~1 km) before sending.
 *     tags: [Geography]
 *     parameters:
 *       - { in: query, name: lat, required: true, schema: { type: number, example: 28.46 } }
 *       - { in: query, name: lng, required: true, schema: { type: number, example: 77.03 } }
 *     responses:
 *       200: { description: "{ city, listingCity } - either may be null" }
 */
geoRouter.get(
  '/nearest-city',
  [query('lat').isFloat({ min: -90, max: 90 }), query('lng').isFloat({ min: -180, max: 180 })],
  validate,
  geoController.nearestCity
);

/**
 * @swagger
 * /geo/cities/{slug}:
 *   get:
 *     summary: Get one live city by slug
 *     tags: [Geography]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, example: gurugram } }
 *     responses:
 *       200: { description: City }
 *       404: { description: Not found or not active }
 */
geoRouter.get('/cities/:slug', geoController.getCity);

/**
 * @swagger
 * /geo/localities:
 *   get:
 *     summary: List active localities of a city (for area/locality selectors - never free text)
 *     tags: [Geography]
 *     parameters:
 *       - { in: query, name: cityId, schema: { type: string, format: uuid } }
 *       - { in: query, name: citySlug, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 200 } }
 *     responses:
 *       200: { description: Localities }
 */
geoRouter.get(
  '/localities',
  [query('cityId').optional().isUUID(), query('limit').optional().isInt({ min: 1, max: 1000 })],
  validate,
  geoController.listLocalities
);

/**
 * @swagger
 * /geo/pincodes/{pincode}:
 *   get:
 *     summary: Resolve a pincode to its locality / city / state
 *     tags: [Geography]
 *     parameters:
 *       - { in: path, name: pincode, required: true, schema: { type: string, example: "110027" } }
 *     responses:
 *       200: { description: Matches }
 *       404: { description: Unknown pincode }
 */
geoRouter.get(
  '/pincodes/:pincode',
  [param('pincode').matches(/^[0-9]{6}$/).withMessage('Pincode must be 6 digits')],
  validate,
  geoController.lookupPincode
);

/**
 * @swagger
 * /geo/stamp-duty:
 *   get:
 *     summary: Current stamp duty & registration rules for a state (city-specific rules first)
 *     tags: [Geography]
 *     parameters:
 *       - { in: query, name: stateCode, required: true, schema: { type: string, example: DL } }
 *       - { in: query, name: cityId, schema: { type: string, format: uuid } }
 *       - { in: query, name: transactionType, schema: { type: string, example: sale } }
 *     responses:
 *       200: { description: Rules plus the tax/legal disclaimer }
 */
geoRouter.get(
  '/stamp-duty',
  [query('stateCode').notEmpty().withMessage('stateCode is required'), query('cityId').optional().isUUID()],
  validate,
  geoController.getStampDuty
);

/**
 * @swagger
 * /geo/circle-rate:
 *   get:
 *     summary: Current circle rate (Rs/sq.ft) for a locality and property type
 *     tags: [Geography]
 *     parameters:
 *       - { in: query, name: cityId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: localityId, schema: { type: string, format: uuid } }
 *       - { in: query, name: propertyType, schema: { type: string } }
 *     responses:
 *       200: { description: Circle rate or null }
 */
geoRouter.get(
  '/circle-rate',
  [query('cityId').isUUID().withMessage('cityId is required'), query('localityId').optional().isUUID()],
  validate,
  geoController.getCircleRate
);

/**
 * @swagger
 * /disclaimers:
 *   get:
 *     summary: Disclaimers for one or more content types
 *     tags: [Disclaimers]
 *     parameters:
 *       - in: query
 *         name: contentType
 *         description: Comma-separated - all_listings, special_situation, auction, ai_output, loan, tax_legal, document_draft, investment_guidance, institutional, mandate, nri_guidance, hni_portfolio, liquidity_score
 *         schema: { type: string, example: "auction,investment_guidance" }
 *       - { in: query, name: stateCode, schema: { type: string, example: DL } }
 *     responses:
 *       200: { description: Disclaimers, ordered }
 */
disclaimerRouter.get('/', geoController.listDisclaimers);

module.exports = { geoRouter, disclaimerRouter };
