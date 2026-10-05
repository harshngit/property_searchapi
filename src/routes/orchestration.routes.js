const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const orchestration = require('../services/orchestration.service');
const intelligence = require('../services/intelligence.service');

// Module 40 Transaction Orchestration + professional-fee invoices + the
// Deal Intelligence Dashboard. Mounted at /api/orchestration.

const router = express.Router();
router.use(authenticate);
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const DEAL_ROLES = ['broker', 'agency_admin', 'builder', ...STAFF];
const meta = (req) => auditService.requestMeta(req);

/**
 * @swagger
 * tags:
 *   name: Orchestration
 *   description: >
 *     Module 40 - stage requirements (dependency enforcement), auto-advance, per-stage SLA with delay alerts,
 *     deal health score; professional-fee invoices (Instalment 1 at ATS execution, Instalment 2 at Sale Deed
 *     execution, lease invoice) with CGST + SGST / IGST, net-7 due and overdue alerts; Deal Intelligence Dashboard.
 */

/**
 * @swagger
 * /orchestration/deals/{id}:
 *   get:
 *     summary: Orchestration view of a deal - stage timer vs SLA, next stage requirements, health score and factors, invoices, event log
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Deal orchestration state }, 403: { description: Not your deal } }
 */
/**
 * @swagger
 * /orchestration/deals/{id}/referrals:
 *   put:
 *     summary: Legal coordination / loan referral / insurance referral status (referral-only; "not_needed" is valid) - auto-advances when met
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               loanStatus: { type: string, enum: [pending, not_needed, referred, sanctioned, disbursed] }
 *               loanLender: { type: string }
 *               insuranceStatus: { type: string, enum: [pending, not_needed, referred, issued] }
 *               insuranceProvider: { type: string }
 *               legalAdvocate: { type: string }
 *               legalNotes: { type: string }
 *     responses: { 200: { description: Evaluation after the change } }
 */
router.put(
  '/deals/:id/referrals',
  authorize(...DEAL_ROLES),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Referrals recorded', await orchestration.recordReferrals(req.user, req.params.id, req.body || {}, meta(req))))
);

router.get(
  '/deals/:id',
  authorize(...DEAL_ROLES),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Deal orchestration', await orchestration.dealView(req.user, req.params.id)))
);

/**
 * @swagger
 * /orchestration/deals/{id}/evaluate:
 *   post:
 *     summary: Re-evaluate now - issue due invoices, auto-advance while requirements are met, refresh health
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Evaluation result } }
 */
router.post(
  '/deals/:id/evaluate',
  authorize(...DEAL_ROLES),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    await orchestration.dealView(req.user, req.params.id); // access check
    success(res, 200, 'Deal evaluated', await orchestration.evaluate(req.params.id, { actor: req.user }));
  })
);

/**
 * @swagger
 * /orchestration/deals/{id}/dates:
 *   put:
 *     summary: Record execution dates - Agreement to Sell (raises Instalment 1), Sale Deed = registration (raises Instalment 2), or lease execution (raises the lease invoice)
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               atsExecutionDate: { type: string, format: date }
 *               saleDeedExecutionDate: { type: string, format: date }
 *               leaseExecutionDate: { type: string, format: date }
 *     responses: { 200: { description: Dates recorded, deal re-evaluated }, 400: { description: Invalid / future date } }
 */
router.put(
  '/deals/:id/dates',
  authorize(...DEAL_ROLES),
  [
    param('id').isUUID(),
    body('atsExecutionDate').optional({ nullable: true }).isISO8601(),
    body('saleDeedExecutionDate').optional({ nullable: true }).isISO8601(),
    body('leaseExecutionDate').optional({ nullable: true }).isISO8601(),
  ],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Execution dates recorded', await orchestration.recordDates(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /orchestration/my-deals:
 *   get:
 *     summary: Website - the signed-in buyer / tenant's deals with progress, next steps and invoices
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Deals } }
 */
router.get('/my-deals', asyncHandler(async (req, res) => success(res, 200, 'My deals', await orchestration.customerDeals(req.user))));

/**
 * @swagger
 * /orchestration/invoices:
 *   get:
 *     summary: Invoices - all for A R staff; the broker's deals or the caller's own (liable party) otherwise
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [invoiced, paid, overdue, waived] } }
 *       - { in: query, name: dealId, schema: { type: string, format: uuid } }
 *     responses: { 200: { description: Invoices } }
 */
router.get(
  '/invoices',
  [query('status').optional().isIn(['invoiced', 'paid', 'overdue', 'waived']), query('dealId').optional().isUUID()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Invoices', await orchestration.listInvoices(req.user, req.query)))
);

/**
 * @swagger
 * /orchestration/invoices/{id}/pdf:
 *   get:
 *     summary: Download the tax invoice PDF
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: PDF, content: { application/pdf: {} } } }
 */
router.get(
  '/invoices/:id/pdf',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const pdf = await orchestration.invoicePdf(req.user, req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${req.params.id}.pdf"`);
    res.send(pdf);
  })
);

/**
 * @swagger
 * /orchestration/invoices/{id}/payment:
 *   post:
 *     summary: Record payment of an invoice (staff) - re-evaluates the deal (closing needs both instalments paid)
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { reference: { type: string } } } } }
 *     responses: { 200: { description: Recorded } }
 */
router.post(
  '/invoices/:id/payment',
  authorize(...STAFF),
  [param('id').isUUID(), body('reference').optional().isString().isLength({ max: 120 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Payment recorded', await orchestration.recordInvoicePayment(req.user, req.params.id, { reference: req.body.reference }, meta(req))))
);

/**
 * @swagger
 * /orchestration/invoices/{id}/waive:
 *   post:
 *     summary: Waive an invoice (admin, with a reason)
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [note], properties: { note: { type: string } } } } }
 *     responses: { 200: { description: Waived } }
 */
router.post(
  '/invoices/:id/waive',
  authorize(...ADMIN),
  [param('id').isUUID(), body('note').isString().isLength({ min: 3, max: 120 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Invoice waived', await orchestration.recordInvoicePayment(req.user, req.params.id, { waive: true, note: req.body.note }, meta(req))))
);

/**
 * @swagger
 * /orchestration/sweep:
 *   post:
 *     summary: Run the hourly jobs now - SLA delay alerts, overdue invoices, health scores (admin)
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Sweep result } }
 */
router.post(
  '/sweep',
  authorize(...ADMIN),
  asyncHandler(async (req, res) =>
    success(res, 200, 'Sweep complete', { sla: await orchestration.slaSweep(), invoices: await orchestration.invoiceSweep(), health: await orchestration.healthSweep() })
  )
);

/**
 * @swagger
 * /orchestration/intelligence:
 *   get:
 *     summary: Deal Intelligence Dashboard - conversion by city / locality / type / broker, stage funnel and days per stage, demand trends, at-risk deals, recommendations
 *     tags: [Orchestration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: months, schema: { type: integer, minimum: 1, maximum: 24, default: 6 } }]
 *     responses: { 200: { description: Dashboard } }
 */
router.get(
  '/intelligence',
  authorize(...DEAL_ROLES),
  [query('months').optional().isInt({ min: 1, max: 24 }).toInt()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Deal intelligence', await intelligence.dashboard(req.user, { months: req.query.months || 6 })))
);

module.exports = router;
