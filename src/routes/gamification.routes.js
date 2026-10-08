const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const game = require('../services/gamification.service');

// Module 29 - Gamification & Engagement. Mounted at /api/gamification.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const PLAYERS = ['broker', 'agency_admin', 'builder', 'customer'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data) => success(res, 200, msg, data);

/**
 * @swagger
 * tags:
 *   name: Gamification
 *   description: >
 *     Module 29 - points engine, Bronze / Silver / Gold / Platinum / Elite tiers and leaderboards (platform-wide and
 *     area-wise). Points come only from recorded platform activity; rules and tier thresholds are admin-configurable.
 */

/**
 * @swagger
 * /gamification/me:
 *   get:
 *     summary: My points, tier, progress to the next tier, weekly streak, recent points and how to earn more
 *     tags: [Gamification]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Points summary } }
 * /gamification/leaderboard:
 *   get:
 *     summary: Leaderboard - platform-wide, or area-wise for a city
 *     tags: [Gamification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: scope, schema: { type: string, enum: [platform, area] } }
 *       - { in: query, name: city, schema: { type: string }, description: Required when scope is area }
 *       - { in: query, name: period, schema: { type: string, enum: [month, quarter, all] } }
 *       - { in: query, name: audience, schema: { type: string, enum: [professional, customer] }, description: Staff only - which board to view }
 *     responses: { 200: { description: Ranked list with the caller's own rank } }
 * /gamification/cities:
 *   get:
 *     summary: Cities that have an area leaderboard
 *     tags: [Gamification]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Cities } }
 * /gamification/manage/settings:
 *   get:
 *     summary: Rules, tiers and totals (staff)
 *     tags: [Gamification]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Settings } }
 * /gamification/manage/rules/{actionKey}:
 *   put:
 *     summary: Change the points for an action, or switch it off (admin)
 *     tags: [Gamification]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Rule saved } }
 * /gamification/manage/tiers:
 *   put:
 *     summary: Change tier thresholds (admin)
 *     tags: [Gamification]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Tiers saved } }
 * /gamification/manage/adjust:
 *   post:
 *     summary: Bonus or correction for a user, with a reason (admin)
 *     tags: [Gamification]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Points adjusted } }
 */
router.use(authenticate);

router.get('/me', authorize(...PLAYERS), h(async (req, res) => ok(res, 'My points', await game.me(req.user))));
router.get(
  '/leaderboard',
  authorize(...PLAYERS, ...STAFF),
  [query('scope').optional().isIn(['platform', 'area']), query('period').optional().isIn(['month', 'quarter', 'all']), query('city').optional().isString().isLength({ max: 120 })],
  validate,
  h(async (req, res) => ok(res, 'Leaderboard', await game.leaderboard(req.user, { scope: req.query.scope, city: req.query.city, period: req.query.period, audience: req.query.audience })))
);
router.get('/cities', authorize(...PLAYERS, ...STAFF), h(async (req, res) => ok(res, 'Leaderboard cities', await game.boardCities(req.user))));

router.get('/manage/settings', authorize(...STAFF), h(async (req, res) => ok(res, 'Gamification settings', await game.settings())));
router.put(
  '/manage/rules/:actionKey',
  authorize(...ADMIN),
  [param('actionKey').isString().isLength({ max: 40 }), body('points').optional().isInt({ min: 0, max: 10000 }), body('isActive').optional().isBoolean()],
  validate,
  h(async (req, res) => ok(res, 'Rule saved', await game.updateRule(req.user, req.params.actionKey, req.body, meta(req))))
);
router.put('/manage/tiers', authorize(...ADMIN), [body('tiers').isArray({ min: 1 })], validate, h(async (req, res) => ok(res, 'Tiers saved', await game.updateTiers(req.user, req.body.tiers, meta(req)))));
router.post(
  '/manage/adjust',
  authorize(...ADMIN),
  [body('userId').isUUID(), body('points').isInt({ min: -100000, max: 100000 }), body('reason').isString().isLength({ min: 5, max: 300 })],
  validate,
  h(async (req, res) => ok(res, 'Points adjusted', await game.adjust(req.user, req.body, meta(req))))
);
router.post('/manage/sync', authorize(...ADMIN), h(async (req, res) => ok(res, 'Sync complete', await game.sync())));

module.exports = router;
