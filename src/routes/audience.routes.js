const express = require('express');
const { body, param, query } = require('express-validator');

const audiences = require('../services/audience.service');
const auditService = require('../services/audit.service');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

// Smart Audience Engine (Module 49). Admins only - members are customers, shown masked.
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const id = [param('id').isUUID().withMessage('Invalid audience id')];
const editBody = [
  body('name').optional().isString().isLength({ min: 3, max: 100 }),
  body('description').optional({ nullable: true }).isString().isLength({ max: 500 }),
  body('active').optional().isBoolean(),
  body('rule').optional().isObject(),
  body('syncMeta').optional().isBoolean(),
  body('syncGoogle').optional().isBoolean(),
  body('metaAudienceId').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('googleUserList').optional({ nullable: true }).isString().isLength({ max: 120 }),
];

/**
 * @swagger
 * tags:
 *   name: Audiences
 *   description: >
 *     Smart Audience Engine (Module 49). Behaviour segments kept up to date from events, lead scores, requirements
 *     and investor profiles; rules are admin-editable JSON. Members with marketing consent are synced to Meta
 *     (Custom Audience) and Google Ads (Customer Match) as SHA-256 hashes only.
 * /audiences:
 *   get:
 *     summary: All segments with member counts and the last sync per platform
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 * /audiences/{id}:
 *   get:
 *     summary: One segment with its sync history
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 * /audiences/{id}/members:
 *   get:
 *     summary: Current members (contact masked)
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 * /audiences/{id}/refresh:
 *   post:
 *     summary: Recompute membership now
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 * /audiences/{id}/sync:
 *   post:
 *     summary: Push joiners / leavers to the switched-on ad platforms now
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 * /audiences/preview:
 *   post:
 *     summary: Count the members a rule would have, without saving it
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 * /admin/audiences:
 *   post:
 *     summary: Create a segment (key, name, rule, sync switches)
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 * /admin/audiences/{id}:
 *   put:
 *     summary: Change a segment's rule, name, active flag or sync settings
 *     tags: [Audiences]
 *     security: [{ bearerAuth: [] }]
 */
const router = express.Router();
router.use(authenticate, authorize(...ADMIN));
router.get('/', handler(async (req, res) => success(res, 200, 'Audiences', await audiences.list())));
router.post('/preview', [body('rule').isObject()], validate, handler(async (req, res) => success(res, 200, 'Preview', await audiences.preview(req.body.rule))));
router.get('/:id', id, validate, handler(async (req, res) => success(res, 200, 'Audience', await audiences.get(req.params.id))));
router.get('/:id/members', [...id, query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 200 })], validate, handler(async (req, res) => success(res, 200, 'Members', await audiences.members(req.params.id, req.query))));
router.post('/:id/refresh', id, validate, handler(async (req, res) => success(res, 200, 'Audience refreshed', await audiences.refresh(req.params.id))));
router.post('/:id/sync', id, validate, handler(async (req, res) => success(res, 200, 'Sync finished', await audiences.sync(req.params.id))));

const adminRouter = express.Router();
adminRouter.use(authenticate, authorize(...ADMIN));
adminRouter.post('/', [body('key').isString().matches(/^[a-z][a-z0-9_]{2,39}$/), body('name').isString().isLength({ min: 3, max: 100 }), body('rule').isObject(), ...editBody.slice(1)], validate, handler(async (req, res) => success(res, 201, 'Audience created', await audiences.create(req.user, req.body, meta(req)))));
adminRouter.put('/:id', [...id, ...editBody], validate, handler(async (req, res) => success(res, 200, 'Audience saved', await audiences.update(req.user, req.params.id, req.body, meta(req)))));

module.exports = { router, adminRouter };
