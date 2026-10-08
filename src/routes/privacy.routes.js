const express = require('express');
const { body, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const privacy = require('../services/privacy.service');

// Module 33 - the person's own data rights (DPDP Act 2023). Mounted at
// /api/user, so the paths match sec. 16: GET /user/my-data and
// POST /user/request-deletion.

const router = express.Router();
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);

/**
 * @swagger
 * tags:
 *   name: Privacy
 *   description: >
 *     Module 33 - DPDP Act 2023. A person can download everything held about them, see and record their consent, and
 *     ask for deletion. Deletion means anonymisation after a 30-day notice; records the law requires (invoices, fee
 *     consents, audit log) are kept, and an open deal, unpaid invoice or active mandate puts it on hold.
 */

/**
 * @swagger
 * /user/my-data:
 *   get:
 *     summary: Download all personal data held about me (JSON or CSV)
 *     tags: [Privacy]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: format, schema: { type: string, enum: [json, csv] } }]
 *     responses: { 200: { description: The data, as JSON or a CSV file } }
 * /user/request-deletion:
 *   post:
 *     summary: Ask for my personal data to be deleted (anonymised after a 30-day notice)
 *     tags: [Privacy]
 *     security: [{ bearerAuth: [] }]
 *     requestBody: { content: { application/json: { schema: { type: object, properties: { reason: { type: string } } } } } }
 *     responses: { 201: { description: Request recorded with its due date } }
 *   delete:
 *     summary: Cancel my deletion request during the notice period
 *     tags: [Privacy]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Cancelled } }
 * /user/privacy:
 *   get:
 *     summary: My consents and my data requests
 *     tags: [Privacy]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Consents, requests and any open deletion } }
 * /user/consent:
 *   post:
 *     summary: Record consent (the six statutory categories together, or an optional one such as marketing)
 *     tags: [Privacy]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Current consents } }
 */
router.use(authenticate);

router.get(
  '/my-data',
  [query('format').optional().isIn(['json', 'csv'])],
  validate,
  h(async (req, res) => {
    const out = await privacy.myData(req.user, { format: req.query.format || 'json' }, meta(req));
    if (out.csv) return res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="propertyserch-my-data.csv"' }).send(out.csv);
    return ok(res, 'Your data', out.data);
  })
);
router.post('/request-deletion', [body('reason').optional({ checkFalsy: true }).isString().isLength({ max: 1000 })], validate, h(async (req, res) => ok(res, 'Deletion request recorded', await privacy.requestDeletion(req.user, req.body, meta(req)), 201)));
router.delete('/request-deletion', h(async (req, res) => ok(res, 'Deletion request cancelled', await privacy.cancelDeletion(req.user, meta(req)))));
router.get('/privacy', h(async (req, res) => ok(res, 'Privacy', await privacy.myRequests(req.user))));
router.post(
  '/consent',
  [body('categories').optional().isArray({ min: 1 }), body('granted').optional().isBoolean()],
  validate,
  h(async (req, res) => ok(res, 'Consent recorded', await privacy.recordConsent(req.user.id, { categories: req.body.categories, granted: req.body.granted !== false, source: req.body.source === 'registration' ? 'registration' : 'settings', ...meta(req) })))
);

module.exports = router;
