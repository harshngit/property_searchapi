const express = require('express');
const rateLimit = require('express-rate-limit');
const { param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const events = require('../services/events.service');

// Engine 9 Module 48 / 49 - event capture, Customer 360, lead scoring.
// Mounted at /api (paths /events/*, /c360/*, /scoring/*).
const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });
const STAFF = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];
const opt = optionalAuthenticate || ((req, res, next) => next());

/**
 * @swagger
 * /events/track:
 *   post:
 *     summary: Browser event batch (page_view, property_view, search_performed, whatsapp_click, call_click, shortlist_added, ...) - auth optional
 *     tags: [Customer 360]
 *     responses: { 200: { description: Accepted count } }
 * /events/identify:
 *   post:
 *     summary: Link this browser's anonymousId to the signed-in user
 *     tags: [Customer 360]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Linked } }
 */
router.post('/events/track', limiter, opt, asyncHandler(async (req, res) => success(res, 200, 'Tracked', await events.track(req.body || {}, { user: req.user || null, userAgent: req.headers['user-agent'] }))));
router.post('/events/identify', authenticate, asyncHandler(async (req, res) => success(res, 200, 'Identified', await events.identify({ anonymousId: req.body?.anonymousId, userId: req.user.id }))));

/**
 * @swagger
 * /c360/customers/{id}:
 *   get:
 *     summary: Customer 360 profile - identity, behaviour, attribution, transactions, lead score
 *     tags: [Customer 360]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Profile } }
 * /c360/customers/{id}/timeline:
 *   get:
 *     summary: Reverse-chronological event timeline for the person
 *     tags: [Customer 360]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Events } }
 * /c360/leads/{id}:
 *   get:
 *     summary: Customer 360 for a lead's person
 *     tags: [Customer 360]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Profile } }
 */
router.get('/c360/customers/:id', authenticate, authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Customer 360', await events.c360(req.user, req.params.id))));
router.get('/c360/customers/:id/timeline', authenticate, authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Timeline', await events.timeline(req.user, req.params.id, req.query))));
router.get('/c360/leads/:id', authenticate, authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Customer 360', await events.c360ForLead(req.user, req.params.id))));

/**
 * @swagger
 * /scoring/leads/{id}:
 *   get:
 *     summary: Recompute and return the 0-100 lead score with its factor breakdown
 *     tags: [Customer 360]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Score } }
 * /scoring/config:
 *   get:
 *     summary: Lead scoring factors (admin-editable)
 *     tags: [Customer 360]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Factors } }
 *   put:
 *     summary: Update factor points / active (admins) - body { items [{ factorKey, points, active }] }
 *     tags: [Customer 360]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Factors } }
 */
router.get('/scoring/leads/:id', authenticate, authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Lead score', await events.scoreForLead(req.user, req.params.id))));
router.get('/scoring/config', authenticate, authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Scoring config', await events.scoringConfig())));
router.put('/scoring/config', authenticate, authorize('admin', 'super_admin'), asyncHandler(async (req, res) => success(res, 200, 'Scoring config saved', await events.updateScoringConfig(req.body?.items, req.user))));

module.exports = router;
