const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const ingestion = require('../services/ingestion/ingestion.service');

// Settings > Lead Sources (self-serve activation per org), the Super Admin
// source catalogue + master view, and the ingestion review queue.
// Mounted at /api/lead-sources.

const router = express.Router();
router.use(authenticate);
const ORG_ADMIN = ingestion.ORG_ADMIN;
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const tenantParam = (v) => (v === undefined ? undefined : v === '' || v === 'arb' ? null : v);

/**
 * @swagger
 * tags:
 *   name: Lead Sources
 *   description: >
 *     Self-serve lead source activation (no developer per tenant): source catalogue (Super Admin), per-org connections
 *     with encrypted credentials + webhook URL, pull reconciliation, master view, ingestion review queue.
 */

/**
 * @swagger
 * /lead-sources:
 *   get:
 *     summary: Source catalogue (lead_sources)
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Sources } }
 *   post:
 *     summary: Add a source (Super Admin) - a new portal / ad platform is a row, not code
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Source } }
 */
router.get('/', authorize(...ORG_ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Lead sources', await ingestion.listSources())));
router.post(
  '/',
  authorize('super_admin'),
  [body('sourceKey').isString().notEmpty(), body('sourceName').isString().notEmpty(), body('sourceTag').isString().matches(/^[A-Za-z0-9-]{3,60}$/)],
  validate,
  asyncHandler(async (req, res) => success(res, 201, 'Source added', await ingestion.createSource(req.body, req.user)))
);

/**
 * @swagger
 * /lead-sources/master:
 *   get:
 *     summary: Super Admin master view - every source, which orgs activated it, lead volume this month, failures
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Rows } }
 */
router.get('/master', authorize(...ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Master view', await ingestion.masterView())));

/**
 * @swagger
 * /lead-sources/connections:
 *   get:
 *     summary: Settings > Lead Sources for an org - status, webhook URL, masked credentials, counts (tenantId = arb for A R Buildwel; org admins see their own)
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: tenantId, schema: { type: string } }]
 *     responses: { 200: { description: Connections + lead mailbox } }
 */
router.get('/connections', authorize(...ORG_ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Connections', await ingestion.listConnections(req.user, tenantParam(req.query.tenantId)))));

/**
 * @swagger
 * /lead-sources/connections/{source}:
 *   put:
 *     summary: Connect / reconfigure a source for an org (credentials stored encrypted; masked values are kept)
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: source, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Connection } }
 *   delete:
 *     summary: Deactivate a source for an org
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: source, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Deactivated } }
 */
router.put(
  '/connections/:source',
  authorize(...ORG_ADMIN),
  [param('source').isString(), body('credentials').optional().isObject(), body('status').optional().isIn(['active', 'inactive'])],
  validate,
  asyncHandler(async (req, res) =>
    success(res, 200, 'Connection saved', await ingestion.saveConnection(req.user, req.params.source, { ...req.body, tenantId: tenantParam(req.body.tenantId) }, meta(req)))
  )
);
router.delete('/connections/:source', authorize(...ORG_ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Deactivated', await ingestion.deleteConnection(req.user, req.params.source, tenantParam(req.query.tenantId)))));

/**
 * @swagger
 * /lead-sources/connections/{connectionId}/pull:
 *   post:
 *     summary: Pull now (reconciliation) for one connection
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: connectionId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: fetched / created / duplicates } }
 */
router.post(
  '/connections/:connectionId/pull',
  authorize(...ORG_ADMIN),
  [param('connectionId').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    if (!ADMIN.includes(req.user.role)) {
      const own = await require('../config/db').query('SELECT 1 FROM lead_source_connections WHERE id = $1 AND tenant_id = $2', [req.params.connectionId, req.user.tenant_id]);
      if (!own.rows.length) return res.status(404).json({ success: false, message: 'Connection not found' });
    }
    return success(res, 200, 'Pull complete', await ingestion.pullConnection(req.params.connectionId, { manual: true }));
  })
);

/**
 * @swagger
 * /lead-sources/pull-sweep:
 *   post:
 *     summary: Run every due pull now (admin)
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Results } }
 */
router.post('/pull-sweep', authorize(...ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Sweep complete', await ingestion.sweepPulls())));

/**
 * @swagger
 * /lead-sources/inbox:
 *   get:
 *     summary: Ingestion inbox - every inbound payload with parse status, confidence, dedupe result; review queue = parse_failed
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: source, schema: { type: string } }
 *     responses: { 200: { description: Counts + items } }
 */
router.get('/inbox', authorize(...ORG_ADMIN), [query('limit').optional().isInt({ min: 1, max: 300 })], validate, asyncHandler(async (req, res) => success(res, 200, 'Inbox', await ingestion.listInbox(req.user, req.query))));
router.get('/inbox/:id', authorize(...ORG_ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Inbox item', await ingestion.getInboxItem(req.user, req.params.id))));

/**
 * @swagger
 * /lead-sources/inbox/{id}/resolve:
 *   post:
 *     summary: Complete a failed parse by hand and create the lead
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Lead created / merged } }
 * /lead-sources/inbox/{id}/reject:
 *   post:
 *     summary: Reject an inbox item (spam / not a lead)
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Rejected } }
 */
router.post('/inbox/:id/resolve', authorize(...ORG_ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Lead created', await ingestion.resolveInbox(req.user, req.params.id, req.body || {}))));
router.post('/inbox/:id/reject', authorize(...ORG_ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Rejected', await ingestion.rejectInbox(req.user, req.params.id, req.body?.reason))));

/**
 * @swagger
 * /lead-sources/{source}:
 *   put:
 *     summary: Update a source (Super Admin) - active, sync mode (push / pull / push+pull), poll interval, field mapping, label. Tag and key are immutable.
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: source, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Source } }
 */
router.put('/:source', authorize('super_admin'), asyncHandler(async (req, res) => success(res, 200, 'Source updated', await ingestion.updateSource(req.params.source, req.body || {}, req.user))));

/**
 * @swagger
 * /lead-sources/{source}/test-parse:
 *   post:
 *     summary: Dry run - normalise a sample payload with this source's normaliser and field mapping
 *     tags: [Lead Sources]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: source, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Parsed fields + confidence } }
 */
router.post('/:source/test-parse', authorize(...ORG_ADMIN), asyncHandler(async (req, res) => success(res, 200, 'Parsed', await ingestion.testParse(req.params.source, req.body?.payload))));

module.exports = router;
