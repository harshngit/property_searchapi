const express = require('express');
const multer = require('multer');
const { body, param, query } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const siteConfig = require('../services/siteConfig.service');

// Super Admin site configuration: dropdown lists and editable content of the
// dashboard and the website (migration 076).
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data) => success(res, 200, msg, data);
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const keyParam = [param('key').isString().isLength({ min: 3, max: 120 })];

/**
 * @swagger
 * tags:
 *   - name: Site configuration
 *     description: Dropdown lists and editable content of the dashboard and the website, set by the Super Admin.
 * /site-config:
 *   get:
 *     summary: The visible dropdown options and content values for one app (public, cached for a minute)
 *     tags: [Site configuration]
 *     parameters:
 *       - in: query
 *         name: app
 *         required: true
 *         schema: { type: string, enum: [dashboard, website] }
 *     responses:
 *       200:
 *         description: "{ app, options: { listKey: [{ value, label, min?, max? }] }, content: { contentKey: value } }"
 */
router.get(
  '/',
  [query('app').isIn(siteConfig.APPS)],
  validate,
  h(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    ok(res, 'Site configuration', await siteConfig.publicConfig(req.query.app));
  })
);

router.use('/manage', authenticate, authorize('super_admin'));

/**
 * @swagger
 * /site-config/manage:
 *   get:
 *     summary: Every list and content item with its defaults (Super Admin)
 *     tags: [Site configuration]
 *     security: [{ bearerAuth: [] }]
 * /site-config/manage/lists/{key}:
 *   put:
 *     summary: Replace a list's options - labels, visibility, order (and values, when the list is extensible)
 *     tags: [Site configuration]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               options:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties: { value: { type: string }, label: { type: string }, active: { type: boolean }, min: { type: number }, max: { type: number } }
 * /site-config/manage/lists/{key}/reset:
 *   post:
 *     summary: Put a list back to its original options
 *     tags: [Site configuration]
 *     security: [{ bearerAuth: [] }]
 * /site-config/manage/content/{key}:
 *   put:
 *     summary: Set a content value (empty = back to the default)
 *     tags: [Site configuration]
 *     security: [{ bearerAuth: [] }]
 * /site-config/manage/content/{key}/image:
 *   post:
 *     summary: Upload the image for an image content item (multipart field "file", 5 MB)
 *     tags: [Site configuration]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/manage', h(async (req, res) => ok(res, 'Site configuration', await siteConfig.manage())));

router.put(
  '/manage/lists/:key',
  [...keyParam, body('options').isArray({ min: 1, max: 200 })],
  validate,
  h(async (req, res) => ok(res, 'List saved', await siteConfig.saveList(req.user, req.params.key, req.body.options, meta(req))))
);

router.post(
  '/manage/lists/:key/reset',
  keyParam,
  validate,
  h(async (req, res) => ok(res, 'List reset', await siteConfig.resetList(req.user, req.params.key, meta(req))))
);

router.put(
  '/manage/content/:key',
  [...keyParam, body('value').optional({ nullable: true }).isString()],
  validate,
  h(async (req, res) => ok(res, 'Content saved', await siteConfig.saveContent(req.user, req.params.key, req.body.value, meta(req))))
);

router.post(
  '/manage/content/:key/image',
  imageUpload.single('file'),
  keyParam,
  validate,
  h(async (req, res) => ok(res, 'Image uploaded', await siteConfig.uploadContentImage(req.user, req.params.key, req.file, meta(req))))
);

module.exports = router;
