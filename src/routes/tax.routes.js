const express = require('express');
const multer = require('multer');
const { body, param, query } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const tax = require('../services/tax.service');
const extras = require('../services/franchiseExtras.service');

// Statutory TDS (unified per-PAN ledger), payee tax profiles, and a broker's
// own commission shares with their GST invoices.
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticate);

/**
 * @swagger
 * tags:
 *   - name: Tax
 *     description: Statutory TDS parameters, the per-PAN TDS ledger, payee PAN / GSTIN and commission GST invoices
 * /tax/statutory:
 *   get:
 *     summary: TDS rate, threshold and no-PAN rate - every version with its legal basis and effective date (staff)
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Parameters } }
 *   post:
 *     summary: Record a change in law as a new version from its effective date (Super Admin only; never backdated)
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, value, effectiveFrom, legalBasis]
 *             properties:
 *               key: { type: string, enum: [tds_commission_percent, tds_annual_threshold, tds_no_pan_percent] }
 *               value: { type: number }
 *               effectiveFrom: { type: string, format: date }
 *               legalBasis: { type: string }
 *     responses: { 201: { description: Parameters } }
 * /tax/ledger:
 *   get:
 *     summary: Taxable payouts by PAN for a financial year, across commission and WFH payouts (staff)
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: fy, schema: { type: string, example: 2026-27 } }
 *       - { in: query, name: q, schema: { type: string } }
 *     responses: { 200: { description: Ledger } }
 */
router.get('/statutory', authorize(...STAFF), h(async (req, res) => ok(res, 'Statutory parameters', await tax.listParams())));
router.post('/statutory', authorize('super_admin'), [body('key').isString(), body('effectiveFrom').isISO8601()], validate, h(async (req, res) => ok(res, 'Parameter recorded', await tax.setParam(req.user, req.body, meta(req)), 201)));
router.get('/ledger', authorize(...STAFF), [query('fy').optional().matches(/^\d{4}-\d{2}$/)], validate, h(async (req, res) => ok(res, 'TDS ledger', await tax.ledger(req.query))));

/**
 * @swagger
 * /tax/profile:
 *   get:
 *     summary: My PAN / GSTIN for commission payouts
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile (PAN shown as last four digits) } }
 *   put:
 *     summary: Save my legal name, PAN and GSTIN
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile } }
 * /tax/profiles/{userId}/verify:
 *   post:
 *     summary: Mark a payee's PAN as verified (staff)
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile } }
 * /tax/commission-shares:
 *   get:
 *     summary: My commission shares (broker) - invoice needed / sent / approved, and what was paid after TDS
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Shares } }
 * /tax/commission-shares/{commissionId}/invoice:
 *   post:
 *     summary: Upload my GST invoice to A R Buildwel for my share
 *     tags: [Tax]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Invoice } }
 */
router.get('/profile', h(async (req, res) => ok(res, 'Tax profile', await extras.taxProfile(req.user.id))));
router.put('/profile', [body('pan').optional({ nullable: true }).isString(), body('gstin').optional({ nullable: true }).isString()], validate, h(async (req, res) => ok(res, 'Tax profile saved', await extras.saveTaxProfile(req.user, req.body, meta(req)))));
router.post('/profiles/:userId/verify', authorize(...STAFF), [param('userId').isUUID()], validate, h(async (req, res) => ok(res, 'PAN verified', await extras.verifyPan(req.user, req.params.userId, meta(req)))));
router.get('/commission-shares', h(async (req, res) => ok(res, 'Commission shares', await extras.myShares(req.user))));
router.post('/commission-shares/:commissionId/invoice', upload.single('file'), [param('commissionId').isUUID()], validate, h(async (req, res) => ok(res, 'Invoice sent', await extras.uploadInvoice(req.user, req.params.commissionId, req.file, req.body, meta(req)), 201)));

module.exports = router;
