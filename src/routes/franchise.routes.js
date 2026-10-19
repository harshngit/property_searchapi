const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const franchise = require('../services/franchise.service');

// Sec. 14 White-Label Franchise Model.
//   adminRouter      /api/franchise   - A R Buildwel: organisations, territory, commission, dues, domains, support
//   franchiseeRouter /api/franchisee  - the Franchisee Admin's own dashboard (numbers only - never leads or contacts)
//   brandingRouter   /api/branding    - public: branding for the host the browser opened

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const ok = (res, message, data, code = 200) => success(res, code, message, data);

/**
 * @swagger
 * tags:
 *   - name: Franchise (A R Buildwel)
 *     description: Sec. 14 - franchisee organisations, pincode territories, commission pool and split, dues with the 3-level suspension, domains, support tickets.
 *   - name: Franchisee
 *     description: Sec. 14.5 Franchisee Partner Dashboard - aggregate metrics, commission, invoices, branding, own brokers, KYC, support. No lead or contact data.
 */

// ------------------------------------------------------------------ public
const extras = require('../services/franchiseExtras.service');
const taxService = require('../services/tax.service');
const multer = require('multer');
const invoiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const brandingRouter = express.Router();
/**
 * @swagger
 * /branding:
 *   get:
 *     summary: Public - branding for a franchisee host (logo, colours, texts). Empty when the host is not a franchisee domain.
 *     tags: [Franchisee]
 *     parameters:
 *       - { in: query, name: host, schema: { type: string }, description: Defaults to the request's own host }
 *       - { in: query, name: preview, schema: { type: boolean }, description: Franchisee Admin only - returns the unpublished draft }
 *     responses: { 200: { description: Branding or null } }
 */
/**
 * @swagger
 * /branding/tls-allowed:
 *   get:
 *     summary: For the edge server's on-demand TLS - 200 only for a host mapped to an active franchisee with its domain switched on
 *     tags: [Franchisee]
 *     parameters:
 *       - { in: query, name: domain, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Allowed }
 *       404: { description: Not a franchisee domain }
 */
brandingRouter.get('/tls-allowed', asyncHandler(async (req, res) => ((await extras.tlsAllowed(req.query.domain)) ? res.status(200).send('ok') : res.status(404).send('unknown host'))));

brandingRouter.get(
  '/',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    let host = req.query.host || req.headers['x-forwarded-host'] || '';
    if (!host && req.headers.origin) {
      try { host = new URL(req.headers.origin).hostname; } catch { host = ''; }
    }
    return ok(res, 'Branding', await franchise.brandingForHost(host, { preview: req.query.preview === 'true', user: req.user }));
  })
);

// --------------------------------------------------------------- franchisee
const franchiseeRouter = express.Router();
franchiseeRouter.use(authenticate, authorize('franchisee_admin'));
// Every query a franchisee request makes runs under Row-Level Security for that franchisee.
franchiseeRouter.use(asyncHandler(async (req, res, next) => {
  const f = await franchise.mine(req.user);
  require('../config/db').franchiseScope.run({ franchiseeId: f.id, tenantId: f.tenant_id }, () => next());
}));

/**
 * @swagger
 * /franchisee/dashboard:
 *   get:
 *     summary: Franchisee dashboard - lead counts, conversion rate, pipeline by stage, top brokers, commission, invoices, area demand, KYC queue (aggregates only)
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Dashboard } }
 */
franchiseeRouter.get('/dashboard', asyncHandler(async (req, res) => ok(res, 'Dashboard', await franchise.dashboard(req.user))));

/**
 * @swagger
 * /franchisee/invoices:
 *   get:
 *     summary: All invoices raised to this franchisee - amount, status, due date, days overdue
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Invoices } }
 */
franchiseeRouter.get('/invoices', asyncHandler(async (req, res) => ok(res, 'Invoices', { invoices: await franchise.listInvoices({ franchiseeId: (await franchise.mine(req.user)).id }) })));

/**
 * @swagger
 * /franchisee/payment-status:
 *   get:
 *     summary: Current suspension level, outstanding amount and days overdue
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: active / level_1 / level_2 / level_3 } }
 */
franchiseeRouter.get('/payment-status', asyncHandler(async (req, res) => ok(res, 'Payment status', await franchise.paymentStatus(req.user))));

/**
 * @swagger
 * /franchisee/pay-invoice:
 *   post:
 *     summary: Pay an invoice - "razorpay" returns a checkout order; "bank_transfer" reports the UTR for A R Buildwel to confirm
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [invoice_id, payment_method], properties: { invoice_id: { type: string, format: uuid }, payment_method: { type: string, enum: [razorpay, bank_transfer] }, reference: { type: string } } } } }
 *     responses: { 200: { description: Checkout order, or the invoice with the reported reference } }
 */
franchiseeRouter.post(
  '/pay-invoice',
  [body('invoice_id').isUUID(), body('payment_method').isIn(['razorpay', 'bank_transfer']), body('reference').optional().isString().isLength({ max: 120 })],
  validate,
  asyncHandler(async (req, res) => {
    if (req.body.payment_method === 'razorpay') return ok(res, 'Checkout order created', await franchise.createRazorpayOrder(req.user, req.body.invoice_id));
    return ok(res, 'Payment reported - access is restored as soon as it is confirmed', await franchise.claimPayment(req.user, req.body.invoice_id, req.body.reference, meta(req)));
  })
);

/**
 * @swagger
 * /franchisee/invoices/{id}/razorpay/verify:
 *   post:
 *     summary: Confirm a Razorpay payment - verified signature marks the invoice paid and reinstates access at once
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Paid invoice } }
 */
franchiseeRouter.post(
  '/invoices/:id/razorpay/verify',
  [param('id').isUUID(), body('orderId').isString(), body('paymentId').isString(), body('signature').isString()],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Service resumed', await franchise.verifyRazorpayPayment(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /franchisee/commissions:
 *   get:
 *     summary: Commission calculations for closed territory deals - deal value, pool, shares, status (no lead or contact data)
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Commissions } }
 */
franchiseeRouter.get('/commissions', asyncHandler(async (req, res) => ok(res, 'Commissions', await franchise.listCommissions({ franchiseeId: (await franchise.mine(req.user)).id }))));

/**
 * @swagger
 * /franchisee/branding:
 *   get:
 *     summary: Live branding, the saved draft and the domain A R Buildwel mapped
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Branding } }
 *   put:
 *     summary: Save a branding draft (logo, colours, font, header / footer text, legal pages) - nothing changes on the site until it is published
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Branding with the draft } }
 */
franchiseeRouter.get('/branding', asyncHandler(async (req, res) => ok(res, 'Branding', await franchise.myBranding(req.user))));
franchiseeRouter.put('/branding', asyncHandler(async (req, res) => ok(res, 'Draft saved', await franchise.saveBrandingDraft(req.user, req.body || {}, meta(req)))));
/**
 * @swagger
 * /franchisee/branding/publish:
 *   post:
 *     summary: Publish the saved branding draft
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Live branding } }
 */
franchiseeRouter.post('/branding/publish', asyncHandler(async (req, res) => ok(res, 'Branding published', await franchise.publishBranding(req.user, meta(req)))));

/**
 * @swagger
 * /franchisee/brokers:
 *   get:
 *     summary: Own brokers with performance summaries and an activity score (no lead data)
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Brokers } }
 *   post:
 *     summary: Onboard a broker into this franchise
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Broker created } }
 */
/**
 * @swagger
 * /franchisee/shares:
 *   get:
 *     summary: The franchisee's commission shares - GST invoice needed / sent / approved, and what was paid after TDS
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Shares } }
 * /franchisee/shares/{commissionId}/invoice:
 *   post:
 *     summary: Upload the franchisee's GST invoice to A R Buildwel for its share (PDF / JPG / PNG)
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, invoiceNumber, invoiceDate, supplierGstin, taxableAmount, gstAmount]
 *             properties:
 *               file: { type: string, format: binary }
 *               invoiceNumber: { type: string }
 *               invoiceDate: { type: string, format: date }
 *               supplierGstin: { type: string }
 *               taxableAmount: { type: number }
 *               gstAmount: { type: number }
 *     responses: { 201: { description: Invoice } }
 * /franchisee/email-preview:
 *   get:
 *     summary: How the franchisee's branded email looks (HTML)
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Brand and HTML } }
 */
franchiseeRouter.get('/shares', asyncHandler(async (req, res) => ok(res, 'Commission shares', await extras.myShares(req.user))));
franchiseeRouter.post('/shares/:commissionId/invoice', invoiceUpload.single('file'), [param('commissionId').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Invoice sent', await extras.uploadInvoice(req.user, req.params.commissionId, req.file, req.body, meta(req)), 201)));
franchiseeRouter.get('/email-preview', asyncHandler(async (req, res) => ok(res, 'Email preview', await extras.emailPreview(req.user))));

franchiseeRouter.get('/brokers', asyncHandler(async (req, res) => ok(res, 'Brokers', await franchise.myBrokers(req.user))));
franchiseeRouter.post(
  '/brokers',
  [body('fullName').trim().isLength({ min: 2, max: 150 }), body('email').isEmail(), body('password').isLength({ min: 8 }), body('mobile').optional({ nullable: true }).isString()],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Broker added', await franchise.addBroker(req.user, req.body, meta(req)), 201))
);
/**
 * @swagger
 * /franchisee/brokers/{id}/status:
 *   put:
 *     summary: Activate or deactivate one of the franchise's brokers
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Status } }
 */
franchiseeRouter.put('/brokers/:id/status', [param('id').isUUID(), body('status').isIn(['active', 'inactive'])], validate, asyncHandler(async (req, res) => ok(res, 'Broker updated', await franchise.setBrokerStatus(req.user, req.params.id, req.body.status, meta(req)))));

/**
 * @swagger
 * /franchisee/kyc:
 *   get:
 *     summary: KYC / RERA / GST verifications waiting for the franchise's own brokers
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Queue } }
 */
franchiseeRouter.get('/kyc', asyncHandler(async (req, res) => ok(res, 'KYC queue', await franchise.kycQueue(req.user))));
/**
 * @swagger
 * /franchisee/kyc/{id}:
 *   put:
 *     summary: Verify or reject a verification of one of the franchise's brokers (a reason is required to reject)
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Decision } }
 */
franchiseeRouter.put('/kyc/:id', [param('id').isUUID(), body('action').isIn(['verify', 'reject']), body('notes').optional().isString().isLength({ max: 500 })], validate, asyncHandler(async (req, res) => ok(res, 'Verification decided', await franchise.decideKyc(req.user, req.params.id, req.body.action, req.body.notes, meta(req)))));

/**
 * @swagger
 * /franchisee/tickets:
 *   get:
 *     summary: Support tickets raised by this franchise
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Tickets } }
 *   post:
 *     summary: Raise a support ticket with A R Buildwel
 *     tags: [Franchisee]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Ticket } }
 */
franchiseeRouter.get('/tickets', asyncHandler(async (req, res) => ok(res, 'Tickets', await franchise.listTickets({ user: req.user }))));
franchiseeRouter.post('/tickets', [body('subject').trim().isLength({ min: 3, max: 200 }), body('body').trim().isLength({ min: 5, max: 4000 }), body('category').optional().isString()], validate, asyncHandler(async (req, res) => ok(res, 'Ticket raised', await franchise.openTicket(req.user, req.body, meta(req)), 201)));
franchiseeRouter.get('/tickets/:id', [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Ticket', await franchise.getTicket(req.user, req.params.id))));
franchiseeRouter.post('/tickets/:id/reply', [param('id').isUUID(), body('body').optional().isString().isLength({ max: 4000 }), body('status').optional().isIn(['open', 'closed'])], validate, asyncHandler(async (req, res) => ok(res, 'Reply posted', await franchise.replyTicket(req.user, req.params.id, req.body, meta(req)))));

// -------------------------------------------------------------------- admin
const adminRouter = express.Router();
adminRouter.use(authenticate);

/**
 * @swagger
 * /franchise:
 *   get:
 *     summary: "[Staff] All franchisees - code, status, suspension level, outstanding, territories, brokers, domain"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Franchisees } }
 *   post:
 *     summary: "[Admin] Create a franchisee - organisation (FR code), Franchisee Admin login, optional Franchisee Manager"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Franchisee } }
 */
adminRouter.get('/', authorize(...STAFF), asyncHandler(async (req, res) => ok(res, 'Franchisees', await franchise.list())));
adminRouter.post(
  '/',
  authorize(...ADMIN),
  [body('legalName').trim().isLength({ min: 2, max: 200 }), body('adminEmail').isEmail(), body('adminPassword').isLength({ min: 8 }), body('managerUserId').optional({ nullable: true }).isUUID(), body('deploymentTier').optional().isIn(['shared', 'dedicated', 'hybrid'])],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Franchisee created', await franchise.create(req.user, req.body, meta(req)), 201))
);

/**
 * @swagger
 * /franchise/territories:
 *   get:
 *     summary: "[Staff] Every territory - granted, open and reserved for expansion"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Territories } }
 *   post:
 *     summary: "[Admin] Grant a territory by pincode (exclusive / open) or hold one in reserve with right of first refusal"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Territory } }
 */
adminRouter.get('/territories', authorize(...STAFF), asyncHandler(async (req, res) => ok(res, 'Territories', await franchise.listTerritories())));
const territoryRules = [body('name').trim().isLength({ min: 2, max: 150 }), body('grantType').isIn(['exclusive', 'open', 'reserved']), body('franchiseeId').optional({ nullable: true }).isUUID(), body('firstRefusalFranchiseeId').optional({ nullable: true }).isUUID()];
adminRouter.post('/territories', authorize(...ADMIN), territoryRules, validate, asyncHandler(async (req, res) => ok(res, 'Territory saved', await franchise.saveTerritory(req.user, req.body, meta(req)), 201)));
adminRouter.put('/territories/:id', authorize(...ADMIN), [param('id').isUUID(), ...territoryRules], validate, asyncHandler(async (req, res) => ok(res, 'Territory saved', await franchise.saveTerritory(req.user, { ...req.body, id: req.params.id }, meta(req)))));
/**
 * @swagger
 * /franchise/territories/{id}/grant:
 *   post:
 *     summary: "[Admin] Grant a reserved territory - the franchisee with right of first refusal comes first"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Territory } }
 */
adminRouter.post('/territories/:id/grant', authorize(...ADMIN), [param('id').isUUID(), body('franchiseeId').isUUID(), body('grantType').optional().isIn(['exclusive', 'open'])], validate, asyncHandler(async (req, res) => ok(res, 'Territory granted', await franchise.grantReserved(req.user, req.params.id, req.body, meta(req)))));
adminRouter.post('/territories/:id/withdraw', authorize(...ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Territory withdrawn', await franchise.withdrawTerritory(req.user, req.params.id, req.body.reason, meta(req)))));

/**
 * @swagger
 * /franchise/conflicts:
 *   get:
 *     summary: "[Staff] Territory Conflict Check - cross-territory listings and inquiries, boundary cases"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Conflicts } }
 */
adminRouter.get('/conflicts', authorize(...STAFF), [query('status').optional().isIn(['open', 'resolved', 'all'])], validate, asyncHandler(async (req, res) => ok(res, 'Conflicts', await franchise.listConflicts({ status: req.query.status || 'open' }))));
adminRouter.put('/conflicts/:id/resolve', authorize(...ADMIN), [param('id').isUUID(), body('resolution').trim().isLength({ min: 3, max: 1000 })], validate, asyncHandler(async (req, res) => ok(res, 'Conflict resolved', await franchise.resolveConflict(req.user, req.params.id, req.body.resolution, meta(req)))));

/**
 * @swagger
 * /franchise/commissions:
 *   get:
 *     summary: "[Staff] Commission calculations - pool, shares per recipient with GST, status (calculated / releasable / released)"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Commissions } }
 */
adminRouter.get('/commissions', authorize(...STAFF), [query('franchiseeId').optional().isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Commissions', await franchise.listCommissions({ franchiseeId: req.query.franchiseeId || null }))));
/**
 * @swagger
 * /franchise/commissions/{id}/release:
 *   post:
 *     summary: "[Admin] Release the shares - only after A R Buildwel has collected the client invoices"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Commission } }
 */
adminRouter.post('/commissions/:id/release', authorize(...ADMIN), [param('id').isUUID(), body('payoutReference').trim().isLength({ min: 3, max: 120 })], validate, asyncHandler(async (req, res) => ok(res, 'Commission released', await franchise.releaseCommission(req.user, req.params.id, req.body.payoutReference, meta(req)))));
/**
 * @swagger
 * /franchise/commissions/{id}:
 *   delete:
 *     summary: "[Super Admin] Delete a commission calculation to correct it - the deletion is audit-logged"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Deleted } }
 */
adminRouter.delete('/commissions/:id', authorize('super_admin'), [param('id').isUUID(), body('reason').trim().isLength({ min: 5, max: 500 })], validate, asyncHandler(async (req, res) => ok(res, 'Calculation deleted', await franchise.deleteCommission(req.user, req.params.id, req.body.reason, meta(req)))));
adminRouter.post('/commissions/calculate/:dealId', authorize(...ADMIN), [param('dealId').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Calculated', await franchise.calculateForDeal(req.params.dealId, { actor: req.user }))));

/**
 * @swagger
 * /franchise/invoices:
 *   get:
 *     summary: "[Staff] Invoices raised to franchisees with the suspension level each one has reached"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Invoices } }
 */
adminRouter.get('/invoices', authorize(...STAFF), [query('franchiseeId').optional().isUUID(), query('status').optional().isIn(['pending', 'paid', 'overdue', 'written_off'])], validate, asyncHandler(async (req, res) => ok(res, 'Invoices', await franchise.listInvoices({ franchiseeId: req.query.franchiseeId || null, status: req.query.status || null }))));
/**
 * @swagger
 * /franchise/invoices/{id}/payment:
 *   post:
 *     summary: "[Admin] Record a payment received - suspension resets and access is restored at once"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Paid invoice } }
 */
adminRouter.post('/invoices/:id/payment', authorize(...ADMIN), [param('id').isUUID(), body('reference').trim().isLength({ min: 3, max: 120 })], validate, asyncHandler(async (req, res) => ok(res, 'Payment recorded', await franchise.recordPayment(req.user, req.params.id, req.body.reference, meta(req)))));
adminRouter.post('/invoices/:id/write-off', authorize(...ADMIN), [param('id').isUUID(), body('reason').trim().isLength({ min: 5, max: 500 })], validate, asyncHandler(async (req, res) => ok(res, 'Invoice written off', await franchise.writeOff(req.user, req.params.id, req.body.reason, meta(req)))));

/**
 * @swagger
 * /franchise/jobs/sweep:
 *   post:
 *     summary: "[Admin] Run the payment ladder now (reminders, notices, suspension levels, late fees, reach)"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Result } }
 */
adminRouter.post('/jobs/sweep', authorize(...ADMIN), asyncHandler(async (req, res) => ok(res, 'Sweep run', await franchise.sweep())));

adminRouter.get('/tickets', authorize(...ADMIN), asyncHandler(async (req, res) => ok(res, 'Tickets', await franchise.listTickets({ status: req.query.status || null }))));
adminRouter.get('/tickets/:id', authorize(...ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Ticket', await franchise.getTicket(req.user, req.params.id))));
adminRouter.post('/tickets/:id/reply', authorize(...ADMIN), [param('id').isUUID(), body('body').optional().isString().isLength({ max: 4000 }), body('status').optional().isIn(['open', 'in_progress', 'resolved', 'closed'])], validate, asyncHandler(async (req, res) => ok(res, 'Reply posted', await franchise.replyTicket(req.user, req.params.id, req.body, meta(req)))));

/**
 * @swagger
 * /franchise/{id}:
 *   get:
 *     summary: "[Staff] One franchisee - profile, admin, manager, branding, territories, reach"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Franchisee } }
 *   put:
 *     summary: "[Admin] Update a franchisee - details, Franchisee Manager, status, branding compliance"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Franchisee } }
 */
/**
 * @swagger
 * /franchise/commission-invoices:
 *   get:
 *     summary: GST invoices from franchisees and brokers for their commission shares (staff)
 *     tags: [Franchise]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: status, schema: { type: string, enum: [submitted, approved, rejected] } }]
 *     responses: { 200: { description: Invoices } }
 * /franchise/commission-invoices/{id}/review:
 *   post:
 *     summary: Approve or reject a commission GST invoice (admin)
 *     tags: [Franchise]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Invoice } }
 * /franchise/commissions/{id}/release-plan:
 *   get:
 *     summary: Before releasing - invoices still missing, and each person's gross, TDS and net (staff)
 *     tags: [Franchise]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Plan } }
 * /franchise/{id}/domain/check:
 *   post:
 *     summary: Check the franchisee domain now - DNS record and live certificate (admin)
 *     tags: [Franchise]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Domain status } }
 * /franchise/{id}/email-sender:
 *   put:
 *     summary: Set the branded email sending address and reply-to (admin; on a domain the email provider has verified)
 *     tags: [Franchise]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Sender } }
 */
adminRouter.get('/commission-invoices', authorize(...STAFF), [query('status').optional().isIn(['submitted', 'approved', 'rejected'])], validate, asyncHandler(async (req, res) => ok(res, 'Commission invoices', await extras.listInvoices(req.query))));
adminRouter.post('/commission-invoices/:id/review', authorize(...ADMIN), [param('id').isUUID(), body('decision').isIn(['approve', 'reject'])], validate, asyncHandler(async (req, res) => ok(res, 'Invoice reviewed', await extras.reviewInvoice(req.user, req.params.id, req.body, meta(req)))));
adminRouter.get('/commissions/:id/release-plan', authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => {
  const c = (await require('../config/db').query('SELECT * FROM franchisee_commissions WHERE id = $1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ success: false, message: 'Commission not found' });
  const plan = await extras.releasePlan(c);
  return ok(res, 'Release plan', { missingInvoices: plan.missingInvoices, lines: plan.lines.map(({ panHash, ...l }) => l) });
}));
adminRouter.post('/:id/domain/check', authorize(...ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Domain checked', await extras.checkDomain(req.params.id, { actor: req.user }))));
adminRouter.put('/:id/email-sender', authorize(...ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Sender saved', await extras.setEmailSender(req.user, req.params.id, req.body, meta(req)))));

adminRouter.get('/:id', authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Franchisee', await franchise.get(req.params.id))));
adminRouter.put('/:id', authorize(...ADMIN), [param('id').isUUID(), body('managerUserId').optional({ nullable: true }).isUUID(), body('status').optional().isIn(['pending', 'active', 'terminated'])], validate, asyncHandler(async (req, res) => ok(res, 'Franchisee updated', await franchise.update(req.user, req.params.id, req.body, meta(req)))));
/**
 * @swagger
 * /franchise/{id}/domain:
 *   put:
 *     summary: "[Admin] Map the franchisee's host (subdomain or a domain A R Buildwel holds), switch it on and set the brand mode"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Franchisee } }
 */
adminRouter.put('/:id/domain', authorize(...ADMIN), [param('id').isUUID(), body('domainModel').optional({ nullable: true }).isIn(['subdomain', 'own_domain']), body('brandMode').optional().isIn(['arb_representative', 'white_label'])], validate, asyncHandler(async (req, res) => ok(res, 'Domain saved', await franchise.setDomain(req.user, req.params.id, req.body, meta(req)))));
/**
 * @swagger
 * /franchise/{id}/invoices:
 *   post:
 *     summary: "[Admin] Raise an invoice to the franchisee (commission, setup fee, annual fee, domain, other) - GST added, Day 0 of the payment ladder"
 *     tags: [Franchise (A R Buildwel)]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 201: { description: Invoice } }
 */
adminRouter.post(
  '/:id/invoices',
  authorize(...ADMIN),
  [param('id').isUUID(), body('baseAmount').isFloat({ gt: 0 }), body('kind').optional().isIn(['commission', 'setup_fee', 'annual_fee', 'domain', 'other']), body('dealId').optional({ nullable: true }).isUUID(), body('description').optional().isString().isLength({ max: 250 }), body('invoiceDate').optional({ nullable: true }).isISO8601()],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Invoice raised', await franchise.raiseInvoice(req.user, req.params.id, req.body, meta(req)), 201))
);

module.exports = { adminRouter, franchiseeRouter, brandingRouter };
