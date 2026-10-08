const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const i18n = require('../services/i18n.service');

// Module 30 - Localization & Multi-Language. Mounted at /api/i18n.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data) => success(res, 200, msg, data);
const app = (where) => where('app').isIn(i18n.APPS);
const big = express.json({ limit: '5mb' });

/**
 * @swagger
 * tags:
 *   name: Localisation
 *   description: >
 *     Module 30 - interface languages. English is the source; Hindi is live at launch; regional languages are switched
 *     on by an admin after uploading a translation file. A bundle maps English interface text to its translation.
 */

/**
 * @swagger
 * /i18n/languages:
 *   get:
 *     summary: Languages a visitor can choose (public)
 *     tags: [Localisation]
 *     responses: { 200: { description: Active languages } }
 * /i18n/bundle/{language}:
 *   get:
 *     summary: Translations for one language and app (public, cached with an ETag)
 *     tags: [Localisation]
 *     parameters:
 *       - { in: path, name: language, required: true, schema: { type: string, example: hi } }
 *       - { in: query, name: app, required: true, schema: { type: string, enum: [website, crm] } }
 *     responses: { 200: { description: '{ language, app, strings }' }, 304: { description: Not modified } }
 * /i18n/me:
 *   get:
 *     summary: My saved language
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Preferred language or null } }
 *   put:
 *     summary: Save my language
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Saved } }
 * /i18n/manage/overview:
 *   get:
 *     summary: Languages with translation coverage per app (staff)
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Languages and coverage } }
 * /i18n/manage/languages:
 *   post:
 *     summary: Add a language, rename it, or switch it on / off (admin)
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Language saved } }
 * /i18n/manage/strings:
 *   get:
 *     summary: Catalogue strings with their translation - filter all / missing / translated / machine (staff)
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Strings } }
 *   put:
 *     summary: Save translations - { language, app, entries } where entries maps English text to its translation (admin)
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Saved } }
 * /i18n/manage/export:
 *   get:
 *     summary: Download the translation file for a language and app (staff)
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: JSON file } }
 * /i18n/manage/catalogue:
 *   post:
 *     summary: Import the list of interface strings produced by the extract script (admin)
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Catalogue updated } }
 * /i18n/manage/ai-draft:
 *   post:
 *     summary: Draft missing translations with the AI helper, flagged for review (admin)
 *     tags: [Localisation]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Drafted count and remaining } }
 */
router.get('/languages', h(async (req, res) => ok(res, 'Languages', await i18n.activeLanguages())));
router.get(
  '/bundle/:language',
  [param('language').isString().isLength({ max: 10 }), app(query)],
  validate,
  h(async (req, res) => {
    const b = await i18n.bundle(req.params.language.toLowerCase(), req.query.app);
    res.set({ ETag: b.etag, 'Cache-Control': 'public, max-age=300' });
    if (req.headers['if-none-match'] === b.etag) return res.status(304).end();
    return ok(res, 'Translations', b.body);
  })
);

router.use(authenticate);

router.get('/me', h(async (req, res) => ok(res, 'My language', await i18n.preference(req.user))));
router.put('/me', [body('language').isString().isLength({ max: 10 })], validate, h(async (req, res) => ok(res, 'Language saved', await i18n.setPreference(req.user, req.body.language.toLowerCase()))));

router.get('/manage/overview', authorize(...STAFF), h(async (req, res) => ok(res, 'Languages', await i18n.overview())));
router.post('/manage/languages', authorize(...ADMIN), [body('code').isString().isLength({ min: 2, max: 10 })], validate, h(async (req, res) => ok(res, 'Language saved', await i18n.saveLanguage(req.user, req.body, meta(req)))));
router.get(
  '/manage/strings',
  authorize(...STAFF),
  [query('language').isString().isLength({ max: 10 }), app(query), query('filter').optional().isIn(['all', 'missing', 'translated', 'machine'])],
  validate,
  h(async (req, res) => ok(res, 'Strings', await i18n.strings(req.query)))
);
router.put('/manage/strings', big, authorize(...ADMIN), [body('language').isString().isLength({ max: 10 }), app(body)], validate, h(async (req, res) => ok(res, 'Translations saved', await i18n.upsert(req.user, { language: req.body.language, app: req.body.app, entries: req.body.entries }, meta(req)))));
router.get(
  '/manage/export',
  authorize(...STAFF),
  [query('language').isString().isLength({ max: 10 }), app(query)],
  validate,
  h(async (req, res) => {
    const file = await i18n.exportFile({ language: req.query.language, app: req.query.app, onlyMissing: req.query.missing === 'true' });
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.query.app}.${req.query.language}.json"` }).send(JSON.stringify(file, null, 2));
  })
);
router.post('/manage/catalogue', big, authorize(...ADMIN), [app(body), body('strings').isArray({ min: 1 })], validate, h(async (req, res) => ok(res, 'Catalogue updated', await i18n.importCatalogue(req.user, req.body, meta(req)))));
router.post('/manage/ai-draft', authorize(...ADMIN), [body('language').isString().isLength({ max: 10 }), app(body)], validate, h(async (req, res) => ok(res, 'Draft translations saved', await i18n.aiDraft(req.user, req.body, meta(req)))));

module.exports = router;
