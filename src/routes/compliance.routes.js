const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const compliance = require('../services/compliance.service');
const privacy = require('../services/privacy.service');

// Module 32 - Compliance & Risk Alerts, and the staff side of Module 33
// (data requests). Mounted at /api/compliance.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data) => success(res, 200, msg, data);
const idp = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   name: Compliance
 *   description: >
 *     Module 32 - compliance and risk alerts (RERA, KYC, fraud, GST invoices, mandates, disputes, response SLA, DPDP,
 *     data sources). Alerts open and close automatically as the underlying record changes; staff acknowledge or
 *     dismiss them. Also the staff queue for DPDP data requests.
 */

/**
 * @swagger
 * /compliance/summary:
 *   get:
 *     summary: Open alerts by severity and by rule (staff)
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Totals and rules } }
 * /compliance/alerts:
 *   get:
 *     summary: Alerts - filter by status (active / open / acknowledged / dismissed / resolved / all), severity, area, rule (staff)
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Alerts, most severe and oldest first } }
 * /compliance/alerts/{id}:
 *   post:
 *     summary: Acknowledge, dismiss (admin, with a reason) or reopen an alert
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Alert updated } }
 * /compliance/rules/{ruleKey}:
 *   put:
 *     summary: Switch a rule on / off, change its severity or thresholds (admin)
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Rule saved and checks re-run } }
 * /compliance/run:
 *   post:
 *     summary: Run the checks now (staff)
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Alerts opened and resolved } }
 * /compliance/data-requests:
 *   get:
 *     summary: DPDP data requests with days left on the 30-day clock (staff)
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Requests and totals } }
 * /compliance/data-requests/{id}:
 *   post:
 *     summary: Process a deletion request now (after the notice; a Super Admin may do it earlier) or reject it with a reason (admin)
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Request updated } }
 * /compliance/users/{id}/data:
 *   get:
 *     summary: Export a person's data for a legal or regulator request (Super Admin; audit-logged)
 *     tags: [Compliance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: The data as JSON or CSV } }
 */
router.use(authenticate, authorize(...STAFF));

router.get('/summary', h(async (req, res) => ok(res, 'Compliance summary', await compliance.summary())));
router.get('/alerts', h(async (req, res) => ok(res, 'Compliance alerts', await compliance.list(req.query))));
router.post('/alerts/:id', [...idp, body('action').isIn(['acknowledge', 'dismiss', 'reopen']), body('note').optional({ checkFalsy: true }).isString().isLength({ max: 1000 })], validate, h(async (req, res) => ok(res, 'Alert updated', await compliance.act(req.user, req.params.id, req.body, meta(req)))));
router.put('/rules/:ruleKey', authorize(...ADMIN), [param('ruleKey').isString().isLength({ max: 40 })], validate, h(async (req, res) => ok(res, 'Rule saved', await compliance.updateRule(req.user, req.params.ruleKey, req.body, meta(req)))));
router.post('/run', h(async (req, res) => ok(res, 'Checks complete', { ...(await compliance.sweep()), privacy: await privacy.sweep() })));

router.get('/data-requests', h(async (req, res) => ok(res, 'Data requests', await privacy.listRequests(req.query))));
router.post('/data-requests/:id', authorize(...ADMIN), [...idp, body('action').isIn(['process', 'reject'])], validate, h(async (req, res) => ok(res, 'Request updated', await privacy.decide(req.user, req.params.id, req.body, meta(req)))));
router.get(
  '/users/:id/data',
  authorize('super_admin'),
  [...idp, query('format').optional().isIn(['json', 'csv'])],
  validate,
  h(async (req, res) => {
    const out = await privacy.exportFor(req.user, req.params.id, req.query.format || 'json', meta(req));
    if (out.csv) return res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="user-data.csv"' }).send(out.csv);
    return ok(res, 'User data', out.data);
  })
);

module.exports = router;
