const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const enquiries = require('../services/enquiry.service');

// CRM Enquiries desk - enquiries by type, site-visit requests and the
// dashboard "needs your attention" counts. Mounted at /api/enquiries.

const router = express.Router();
router.use(authenticate);
const CRM = ['broker', 'agency_admin', 'builder', 'internal_sales', 'admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);

/**
 * @swagger
 * tags:
 *   name: Enquiries
 *   description: >
 *     Enquiry desk - every website enquiry by type (property, home loan & financing, insurance, legal, valuation,
 *     sellers, NRI, investment, institutional, requirement responses, general), site-visit requests with a
 *     schedule / decline flow, and the dashboard attention counts. Admins see all; others see what they hold.
 */

/**
 * @swagger
 * /enquiries/summary:
 *   get:
 *     summary: Count of enquiries per type (total / new / open) and pending site-visit requests
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Summary } }
 */
router.get('/summary', authorize(...CRM), asyncHandler(async (req, res) => success(res, 200, 'Enquiry summary', await enquiries.summary(req.user))));

/**
 * @swagger
 * /enquiries/attention:
 *   get:
 *     summary: What is waiting on the caller - new enquiries, visit requests, deal-room requests, approvals, disputes, overdue invoices...
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ items: [{ key, label, count, to, hint }], total }" } }
 */
router.get('/attention', authorize(...CRM), asyncHandler(async (req, res) => success(res, 200, 'Needs attention', await enquiries.attention(req.user))));

/**
 * @swagger
 * /enquiries/visit-requests:
 *   get:
 *     summary: Site-visit requests raised by customers on the website
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: status, schema: { type: string, enum: [pending, scheduled, declined, cancelled, all] } }]
 *     responses: { 200: { description: Requests } }
 */
router.get(
  '/visit-requests',
  authorize(...CRM),
  [query('status').optional().isIn(['pending', 'scheduled', 'declined', 'cancelled', 'all'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Visit requests', await enquiries.listVisitRequests(req.user, req.query)))
);

/**
 * @swagger
 * /enquiries/visit-requests/{id}/schedule:
 *   post:
 *     summary: Schedule the requested visit - opens the deal for the lead if needed, books the site visit, notifies the customer
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { scheduledAt: { type: string, format: date-time }, notes: { type: string } } } } }
 *     responses: { 200: { description: "{ dealId, siteVisitId, scheduledAt }" } }
 */
router.post(
  '/visit-requests/:id/schedule',
  authorize(...CRM),
  [param('id').isUUID(), body('scheduledAt').optional().isISO8601(), body('notes').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Visit scheduled - customer notified', await enquiries.scheduleVisitRequest(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /enquiries/visit-requests/{id}/decline:
 *   post:
 *     summary: Decline a visit request with a reason (the customer is told)
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [reason], properties: { reason: { type: string } } } } }
 *     responses: { 200: { description: Declined } }
 */
router.post(
  '/visit-requests/:id/decline',
  authorize(...CRM),
  [param('id').isUUID(), body('reason').isString().isLength({ min: 3, max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Request declined', await enquiries.declineVisitRequest(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /enquiries/leads/{id}/journey:
 *   get:
 *     summary: Where an enquiry stands (New -> Contacted -> Qualified -> Deal -> Closed), its type and details, the linked deal and the next step
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Journey } }
 * /enquiries/leads/{id}/start-deal:
 *   post:
 *     summary: Open the deal for a qualified enquiry (marks it Qualified if it was not; returns the existing open deal if there is one)
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: "{ dealId, created }" } }
 */
router.get('/leads/:id/journey', authorize(...CRM), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Enquiry journey', await enquiries.journey(req.user, req.params.id))));
router.post('/leads/:id/start-deal', authorize(...CRM), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Deal opened', await enquiries.startDeal(req.user, req.params.id, meta(req)))));

/**
 * @swagger
 * /enquiries:
 *   get:
 *     summary: Enquiries of one type (or all) with the customer, topic, type-specific details, listing, representative and status
 *     tags: [Enquiries]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: type, schema: { type: string, enum: [property, home_loan, insurance, legal, valuation, seller, nri, investment, institutional, requirement, general] } }
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses: { 200: { description: "{ items, pagination }" } }
 */
router.get(
  '/',
  authorize(...CRM),
  [query('type').optional().isIn(enquiries.TYPES), query('status').optional().isString(), query('search').optional().isString().isLength({ max: 100 }), query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Enquiries', await enquiries.list(req.user, req.query)))
);

module.exports = router;
