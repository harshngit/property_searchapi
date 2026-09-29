const express = require('express');
const { body, param, query } = require('express-validator');

const crawler = require('../services/crawler/crawler.service');
const auditService = require('../services/audit.service');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadNoticeFile } = require('../middlewares/upload');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate, authorize('admin', 'super_admin'));
const meta = (req) => auditService.requestMeta(req);
// Real portal URLs only in production (no localhost / internal hosts);
// local fixtures are allowed in development and tests.
const URL_RULES = { require_protocol: true, protocols: ['http', 'https'], require_tld: process.env.NODE_ENV === 'production' };

/**
 * @swagger
 * tags:
 *   name: Crawlers
 *   description: >
 *     Section 23 automated data acquisition - crawler sources (one per crawler
 *     module: SBI, IBAPI, MSTC, other banks, NBFC/ARC, DRT/NCLT, housing boards,
 *     newspaper notices), run history and health. Each source is configured in
 *     the admin panel (listing URL, adapter, field mapping, schedule), must be
 *     legally approved before it can be enabled, obeys robots.txt and a
 *     1-request-per-3-seconds limit, and moves to dead-letter after repeated
 *     failures. Parsed items flow into the opportunity intake queue. Admin only.
 */

/**
 * @swagger
 * /crawlers/health:
 *   get:
 *     summary: Crawler health summary - sources by state, last-24h runs, items awaiting legal review
 *     tags: [Crawlers]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Summary } }
 */
router.get('/health', handler(async (req, res) => success(res, 200, 'Crawler health fetched', await crawler.healthSummary())));

/**
 * @swagger
 * /crawlers/sources:
 *   get:
 *     summary: All crawler sources with status, last run and item counts
 *     tags: [Crawlers]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Sources } }
 */
router.get('/sources', handler(async (req, res) => success(res, 200, 'Crawler sources fetched', await crawler.listSources())));

/**
 * @swagger
 * /crawlers/sources/{id}:
 *   put:
 *     summary: Configure a source - URL, adapter (html_list / json_api / rss / pdf_links), field mapping, schedule, AI parser, enable
 *     description: Enabling requires legal approval first.
 *     tags: [Crawlers]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Source } }
 */
router.put(
  '/sources/:id',
  [
    param('id').isUUID(),
    body('listUrl').optional({ nullable: true, checkFalsy: true }).isURL(URL_RULES),
    body('baseUrl').optional({ nullable: true, checkFalsy: true }).isURL(URL_RULES),
    body('adapter').optional().isIn(['html_list', 'json_api', 'rss', 'pdf_links']),
    body('config').optional().isObject(),
    body('scheduleHours').optional().isInt({ min: 1, max: 720 }),
    body('maxPages').optional().isInt({ min: 1, max: 50 }),
    body('defaultListingCategory').optional().isIn(['auction', 'special_situation']),
    body('requiresLegalReview').optional().isBoolean(),
    body('useAiParser').optional().isBoolean(),
    body('isEnabled').optional().isBoolean(),
  ],
  validate,
  handler(async (req, res) => success(res, 200, 'Crawler source saved', await crawler.updateSource(req.params.id, req.body, req.user, meta(req))))
);

/**
 * @swagger
 * /crawlers/sources/{id}/legal-approval:
 *   put:
 *     summary: Record (or withdraw) counsel's approval of a source's ToS / robots.txt - required before enabling
 *     tags: [Crawlers]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [approved], properties: { approved: { type: boolean }, notes: { type: string } } }
 *     responses: { 200: { description: Source } }
 */
router.put(
  '/sources/:id/legal-approval',
  [param('id').isUUID(), body('approved').isBoolean(), body('notes').optional().isString().isLength({ max: 2000 })],
  validate,
  handler(async (req, res) => success(res, 200, 'Legal approval updated', await crawler.setLegalApproval(req.params.id, req.body, req.user, meta(req))))
);

/**
 * @swagger
 * /crawlers/sources/{id}/run:
 *   post:
 *     summary: Run a source now (mode=run ingests into the intake queue; mode=test only parses and returns a sample)
 *     tags: [Crawlers]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: mode, schema: { type: string, enum: [run, test], default: run } }
 *     responses:
 *       200: { description: "{ runId, pages, found, summary, sample }" }
 *       400: { description: Not configured / blocked by robots.txt / not approved }
 *       502: { description: The portal failed - see the run record }
 */
router.post(
  '/sources/:id/run',
  [param('id').isUUID(), query('mode').optional().isIn(['run', 'test'])],
  validate,
  handler(async (req, res) =>
    success(res, 200, 'Crawl finished', await crawler.runSource(req.params.id, { trigger: req.query.mode === 'test' ? 'test' : 'manual', user: req.user }))
  )
);

/**
 * @swagger
 * /crawlers/sources/{id}/reset:
 *   post:
 *     summary: Take a source out of dead-letter / failing and schedule it now
 *     tags: [Crawlers]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Source } }
 */
router.post('/sources/:id/reset', [param('id').isUUID()], validate, handler(async (req, res) => success(res, 200, 'Source reset', await crawler.resetSource(req.params.id, req.user))));

/**
 * @swagger
 * /crawlers/runs:
 *   get:
 *     summary: Crawl run history (optionally for one source)
 *     tags: [Crawlers]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: sourceId, schema: { type: string, format: uuid } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses: { 200: { description: Runs } }
 */
router.get(
  '/runs',
  [query('sourceId').optional().isUUID(), query('limit').optional().isInt({ min: 1, max: 200 })],
  validate,
  handler(async (req, res) => success(res, 200, 'Crawler runs fetched', await crawler.listRuns(req.query.sourceId, req.query.limit)))
);

/**
 * @swagger
 * /crawlers/parse-notice:
 *   post:
 *     summary: Upload one auction / sale notice (PDF or text) - parsed by the same regex + AI parser and queued for review
 *     tags: [Crawlers]
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
 *               sourceName: { type: string, example: Hindustan Times - public notice }
 *               listingCategory: { type: string, enum: [auction, special_situation] }
 *               legalReview: { type: boolean, description: Hold for lawyer-panel review (newspaper / legal notices) }
 *     responses: { 200: { description: "{ parsed, summary }" } }
 */
router.post(
  '/parse-notice',
  uploadNoticeFile.single('file'),
  [body('listingCategory').optional().isIn(['auction', 'special_situation'])],
  validate,
  handler(async (req, res) => success(res, 200, 'Notice parsed and queued', await crawler.parseUploadedNotice(req.file, req.body, req.user)))
);

module.exports = router;
