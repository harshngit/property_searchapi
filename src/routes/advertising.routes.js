const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth');
const { uploadProfilePicture } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const ads = require('../services/advertising.service');

// Module 17 - Advertiser & Monetization. Mounted at /api/ads.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const PORTAL = ['advertiser', ...STAFF];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const idp = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   name: Advertising
 *   description: >
 *     Module 17 - native advertising. Advertisers are approved by an admin (no self-signup) and get an AV code and an
 *     Advertiser Portal login. A campaign is priced from the admin rate card, invoiced with GST, paid, then reviewed
 *     by an admin before it serves. /ads/serve returns the ads for a placement (targeting, frequency cap, rotation).
 */

/**
 * @swagger
 * /ads/serve:
 *   get:
 *     summary: Ads for a placement (public; logs impressions)
 *     tags: [Advertising]
 *     parameters:
 *       - { in: query, name: placement, required: true, schema: { type: string, enum: [home_hero, home_sidebar, search_sponsored, city_banner, crm_dashboard, featured_listing, institutional_featured, login_splash] } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: locality, schema: { type: string } }
 *       - { in: query, name: propertyType, schema: { type: string } }
 *       - { in: query, name: device, schema: { type: string, enum: [mobile, desktop] } }
 *       - { in: query, name: viewer, schema: { type: string }, description: Anonymous visitor id (hashed) for the frequency cap }
 *       - { in: query, name: view, schema: { type: string }, description: Page-view id - repeat calls in the same view return the same ad without a second impression }
 *     responses: { 200: { description: Ads to show - empty when nothing is booked } }
 * /ads/click/{id}:
 *   post:
 *     summary: Record a click on an ad
 *     tags: [Advertising]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Click logged; returns the destination } }
 * /ads/rate-card:
 *   get:
 *     summary: Ad formats and rates (advertisers and staff)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Rate card } }
 */
router.get(
  '/serve',
  optionalAuthenticate,
  [query('placement').isIn(ads.PLACEMENTS.filter((p) => p !== 'digest_sponsored')), query('viewer').optional().isString().isLength({ max: 80 })],
  validate,
  h(async (req, res) => ok(res, 'Ads', await ads.serve({ placement: req.query.placement, city: req.query.city, locality: req.query.locality, propertyType: req.query.propertyType, device: req.query.device, viewerKey: req.query.viewer, viewId: req.query.view, limit: req.query.limit }, req.user)))
);
router.post(
  '/click/:id',
  optionalAuthenticate,
  idp,
  validate,
  h(async (req, res) => ok(res, 'Click recorded', await ads.click({ campaignId: req.params.id, placement: req.body.placement, variant: req.body.variant, viewerKey: req.body.viewer, city: req.body.city, device: req.body.device }, req.user)))
);

router.use(authenticate);

router.get('/rate-card', authorize(...PORTAL), h(async (req, res) => ok(res, 'Rate card', await ads.rateCard({ includeInactive: ADMIN.includes(req.user.role) }))));
router.post(
  '/quote',
  authorize(...PORTAL),
  [body('formatKey').isString().notEmpty(), body('units').optional().isInt({ min: 1, max: 520 })],
  validate,
  h(async (req, res) => ok(res, 'Quote', await ads.quote(req.body)))
);

/**
 * @swagger
 * /ads/portal:
 *   get:
 *     summary: Advertiser Portal home - the advertiser, totals and whether online payment is available
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Portal summary } }
 * /ads/campaigns:
 *   get:
 *     summary: Campaigns - the advertiser's own, or all for staff (status / advertiserId filters)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Campaigns with impressions, clicks, CTR, spend } }
 *   post:
 *     summary: Create a campaign (priced from the rate card; an invoice is raised and it waits for payment)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, formatKey, startDate]
 *             properties:
 *               name: { type: string }
 *               formatKey: { type: string, example: home_hero }
 *               units: { type: integer, description: Weeks / months / sends, per the format }
 *               startDate: { type: string, format: date }
 *               headline: { type: string }
 *               body: { type: string }
 *               imageUrl: { type: string, description: Path returned by /ads/creative }
 *               ctaLabel: { type: string }
 *               ctaUrl: { type: string, description: https link }
 *               reraNumber: { type: string }
 *               propertyId: { type: string, format: uuid, description: For sponsored / featured listing formats }
 *               variantB: { type: object, description: Optional second creative for A/B testing }
 *               targeting: { type: object, properties: { cities: { type: array, items: { type: string } }, localities: { type: array, items: { type: string } }, roles: { type: array, items: { type: string } }, propertyTypes: { type: array, items: { type: string } }, budgetMin: { type: number }, budgetMax: { type: number }, device: { type: string } } }
 *               advertiserId: { type: string, format: uuid, description: Staff only - book on behalf of an advertiser }
 *     responses: { 201: { description: Campaign created } }
 * /ads/campaigns/{id}/review:
 *   post:
 *     summary: Approve or reject a paid campaign (admin)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Campaign reviewed }, 400: { description: Blocking checks failed } }
 * /ads/invoices/{id}/pay/order:
 *   post:
 *     summary: Start an online payment (Razorpay order)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Order for Razorpay Checkout } }
 * /ads/invoices/{id}/pay/record:
 *   post:
 *     summary: Record an offline payment (staff)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Invoice paid; campaign moves to review } }
 */
router.get('/portal', authorize('advertiser'), h(async (req, res) => ok(res, 'Advertiser portal', await ads.portalHome(req.user))));
router.post('/creative', authorize(...PORTAL), uploadProfilePicture.single('file'), h(async (req, res) => ok(res, 'Image uploaded', await ads.uploadCreative(req.user, req.file), 201)));

router.get('/campaigns', authorize(...PORTAL), h(async (req, res) => ok(res, 'Campaigns', await ads.listCampaigns(req.user, { status: req.query.status, advertiserId: req.query.advertiserId }))));
router.post(
  '/campaigns',
  authorize(...PORTAL),
  [body('name').isString().isLength({ min: 3, max: 160 }), body('formatKey').isString().notEmpty(), body('startDate').isISO8601(), body('units').optional().isInt({ min: 1, max: 520 }), body('propertyId').optional({ checkFalsy: true }).isUUID(), body('advertiserId').optional({ checkFalsy: true }).isUUID()],
  validate,
  h(async (req, res) => ok(res, 'Campaign created', await ads.createCampaign(req.user, req.body, meta(req)), 201))
);
router.get('/campaigns/:id', authorize(...PORTAL), idp, validate, h(async (req, res) => ok(res, 'Campaign', await ads.campaignView(req.user, req.params.id))));
router.patch('/campaigns/:id', authorize(...PORTAL), idp, validate, h(async (req, res) => ok(res, 'Campaign updated', await ads.updateCampaign(req.user, req.params.id, req.body, meta(req)))));
router.post(
  '/campaigns/:id/:action(pause|resume|cancel)',
  authorize(...PORTAL),
  idp,
  validate,
  h(async (req, res) => ok(res, 'Campaign updated', await ads.setCampaignState(req.user, req.params.id, req.params.action, meta(req))))
);
router.post(
  '/campaigns/:id/review',
  authorize(...ADMIN),
  [...idp, body('decision').isIn(['approve', 'reject']), body('note').optional({ checkFalsy: true }).isString().isLength({ max: 1000 })],
  validate,
  h(async (req, res) => ok(res, 'Campaign reviewed', await ads.reviewCampaign(req.user, req.params.id, req.body, meta(req))))
);

router.get('/invoices', authorize(...PORTAL), h(async (req, res) => ok(res, 'Invoices', await ads.listInvoices(req.user))));
router.get(
  '/invoices/:id/pdf',
  authorize(...PORTAL),
  idp,
  validate,
  h(async (req, res) => {
    const pdf = await ads.invoicePdf(req.user, req.params.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="ad-invoice.pdf"' }).send(pdf);
  })
);
router.post('/invoices/:id/pay/order', authorize(...PORTAL), idp, validate, h(async (req, res) => ok(res, 'Payment started', await ads.createRazorpayOrder(req.user, req.params.id))));
router.post(
  '/invoices/:id/pay/verify',
  authorize(...PORTAL),
  [...idp, body('orderId').isString().notEmpty(), body('paymentId').isString().notEmpty(), body('signature').isString().notEmpty()],
  validate,
  h(async (req, res) => ok(res, 'Payment received', await ads.verifyRazorpayPayment(req.user, req.params.id, req.body, meta(req))))
);
router.post(
  '/invoices/:id/pay/record',
  authorize(...STAFF),
  [...idp, body('reference').isString().isLength({ min: 3, max: 120 })],
  validate,
  h(async (req, res) => ok(res, 'Payment recorded', await ads.recordPayment(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /ads/manage/advertisers:
 *   get:
 *     summary: Approved advertisers with campaign counts and spend (staff)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Advertisers } }
 *   post:
 *     summary: Approve an advertiser - from an "Advertise With Us" enquiry (bdLeadId) or outbound - issues the AV code and portal login (admin)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Advertiser created } }
 * /ads/manage/enquiries:
 *   get:
 *     summary: Advertiser enquiries waiting for the eligibility decision (staff)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Enquiries } }
 * /ads/manage/revenue:
 *   get:
 *     summary: Revenue dashboard - month, YTD, by format, top advertisers, renewals, pending approvals (staff)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Revenue } }
 * /ads/manage/suggestions:
 *   get:
 *     summary: Suggested advertiser candidates from platform activity (staff)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Candidates } }
 * /ads/manage/rates:
 *   post:
 *     summary: Change a rate, or add a city-specific rate (admin)
 *     tags: [Advertising]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Rate saved } }
 */
router.get('/manage/advertisers', authorize(...STAFF), h(async (req, res) => ok(res, 'Advertisers', { items: await ads.listAdvertisers(), eligibleCategories: await ads.eligibleCategories() })));
router.post(
  '/manage/advertisers',
  authorize(...ADMIN),
  [body('bdLeadId').optional({ checkFalsy: true }).isUUID(), body('loginEmail').optional({ checkFalsy: true }).isEmail(), body('password').isString().isLength({ min: 8, max: 100 })],
  validate,
  h(async (req, res) => ok(res, 'Advertiser approved', await ads.approveAdvertiser(req.user, req.body, meta(req)), 201))
);
router.patch('/manage/advertisers/:id', authorize(...ADMIN), idp, validate, h(async (req, res) => ok(res, 'Advertiser updated', await ads.updateAdvertiser(req.user, req.params.id, req.body, meta(req)))));
router.get('/manage/enquiries', authorize(...STAFF), h(async (req, res) => ok(res, 'Advertiser enquiries', await ads.pendingEnquiries())));
router.get('/manage/revenue', authorize(...STAFF), h(async (req, res) => ok(res, 'Advertising revenue', await ads.revenue())));
router.get('/manage/suggestions', authorize(...STAFF), h(async (req, res) => ok(res, 'Suggested advertisers', await ads.suggestions())));
router.post('/manage/rates', authorize(...ADMIN), [body('rate').isFloat({ min: 0 })], validate, h(async (req, res) => ok(res, 'Rate saved', await ads.saveRate(req.user, req.body, meta(req)))));
router.post('/manage/sweep', authorize(...ADMIN), h(async (req, res) => ok(res, 'Sweep complete', await ads.sweep())));

module.exports = router;
