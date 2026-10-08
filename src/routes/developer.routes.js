const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const apiKeys = require('../services/apiKey.service');
const webhooks = require('../services/webhook.service');

// Module 35 - managing API keys and webhooks from the CRM. Mounted at /api/developer.

const router = express.Router();
const OWNERS = ['agency_admin', 'builder', 'broker', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const idp = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   name: Developer
 *   description: Module 35 - API keys and webhooks for an organisation's own systems (agencies, builders, brokers).
 */

/**
 * @swagger
 * /developer/keys:
 *   get:
 *     summary: My API keys (admins - every key) and the permissions a key can have
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Keys } }
 *   post:
 *     summary: Create an API key - the key itself is returned once, here
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Key created } }
 * /developer/keys/{id}:
 *   delete:
 *     summary: Revoke an API key
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Revoked } }
 * /developer/webhooks:
 *   get:
 *     summary: My webhooks and the events available
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Webhooks } }
 *   post:
 *     summary: Add a webhook (https only) - the signing secret is returned once, here
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Webhook created } }
 * /developer/webhooks/{id}/test:
 *   post:
 *     summary: Send a test event now
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Whether the receiver accepted it } }
 * /developer/webhooks/{id}/deliveries:
 *   get:
 *     summary: The last 50 deliveries to a webhook
 *     tags: [Developer]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Deliveries } }
 */
router.use(authenticate, authorize(...OWNERS));

router.get('/keys', h(async (req, res) => ok(res, 'API keys', await apiKeys.list(req.user))));
router.post('/keys', [body('name').isString().isLength({ min: 3, max: 80 }), body('scopes').isArray({ min: 1 })], validate, h(async (req, res) => ok(res, 'API key created', await apiKeys.create(req.user, req.body, meta(req)), 201)));
router.delete('/keys/:id', idp, validate, h(async (req, res) => ok(res, 'API key revoked', await apiKeys.revoke(req.user, req.params.id, meta(req)))));
router.put('/keys/:id/rate-limit', authorize(...ADMIN), [...idp, body('perMin').isInt({ min: 1, max: 6000 })], validate, h(async (req, res) => ok(res, 'Rate limit saved', await apiKeys.setRateLimit(req.user, req.params.id, req.body.perMin, meta(req)))));

router.get('/webhooks', h(async (req, res) => ok(res, 'Webhooks', await webhooks.list(req.user))));
router.post('/webhooks', [body('url').isString().isLength({ max: 500 }), body('events').isArray({ min: 1 })], validate, h(async (req, res) => ok(res, 'Webhook created', await webhooks.create(req.user, req.body, meta(req)), 201)));
router.put('/webhooks/:id', idp, validate, h(async (req, res) => ok(res, 'Webhook saved', await webhooks.update(req.user, req.params.id, req.body, meta(req)))));
router.delete('/webhooks/:id', idp, validate, h(async (req, res) => ok(res, 'Webhook deleted', await webhooks.remove(req.user, req.params.id, meta(req)))));
router.post('/webhooks/:id/test', idp, validate, h(async (req, res) => ok(res, 'Test sent', await webhooks.ping(req.user, req.params.id))));
router.get('/webhooks/:id/deliveries', idp, validate, h(async (req, res) => ok(res, 'Deliveries', await webhooks.deliveries(req.user, req.params.id))));
router.post('/webhooks/run', authorize(...ADMIN), h(async (req, res) => ok(res, 'Scan complete', await webhooks.scan())));

module.exports = router;
