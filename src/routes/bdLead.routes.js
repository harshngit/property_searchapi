const express = require('express');
const { body, param, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const bdLeadController = require('../controllers/bdLead.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadResume } = require('../middlewares/upload');

const CATEGORIES = ['city_addition', 'careers', 'broker', 'builder', 'franchisee', 'advertiser'];
const STATUSES = ['new', 'under_review', 'assigned', 'contacted', 'converted', 'rejected', 'closed'];
const ADMIN_ROLES = ['admin', 'super_admin'];
const STAFF_ROLES = ['admin', 'super_admin', 'internal_sales', 'agency_admin'];

// Public form endpoint - same tight limit as the public property inquiry
// (10 per 15 min per IP). PUBLIC_FORM_RATE_LIMIT_MAX exists so automated
// test runs can raise it; leave it unset in production.
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PUBLIC_FORM_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/**
 * @swagger
 * tags:
 *   name: Business Leads
 *   description: >
 *     "Get Involved" (Request City Addition, Work With Us, Join as Broker,
 *     Builder partner, Become a Franchisee) and "Advertise With Us" enquiries.
 *     Separate from property leads - every enquiry goes to Super Admin first,
 *     who may assign it onward; each assignment is audit-logged.
 */

/**
 * @swagger
 * /bd-leads:
 *   post:
 *     summary: Submit a Get Involved / Advertise With Us enquiry (public, no login)
 *     description: >
 *       Rate limited to 10 per 15 min per IP. Per-category required fields:
 *       city_addition -> cityName; careers -> positionOfInterest (optional multipart `resume` PDF/DOC);
 *       broker -> cityName; builder -> businessName; franchisee -> territoryOfInterest;
 *       advertiser -> businessName + businessCategory (must be a real-estate-ecosystem
 *       category from app_config bd_leads.advertiser_eligible_categories).
 *       Re-submitting the same form within 24h returns the existing enquiry.
 *     tags: [Business Leads]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category, fullName]
 *             properties:
 *               category: { type: string, enum: [city_addition, careers, broker, builder, franchisee, advertiser] }
 *               fullName: { type: string }
 *               mobile: { type: string }
 *               email: { type: string }
 *               cityName: { type: string }
 *               areaName: { type: string }
 *               territoryOfInterest: { type: string }
 *               positionOfInterest: { type: string }
 *               businessBackground: { type: string }
 *               businessName: { type: string }
 *               businessCategory: { type: string, example: bank }
 *               desiredPlacement: { type: string }
 *               budgetRange: { type: string }
 *               message: { type: string }
 *               sourcePage: { type: string }
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               resume: { type: string, format: binary }
 *     responses:
 *       201: { description: Enquiry received }
 *       200: { description: Duplicate within 24h - existing enquiry returned }
 *       422: { description: Validation failed / advertiser category not eligible }
 */
router.post(
  '/',
  publicLimiter,
  uploadResume.single('resume'),
  [
    body('category').isIn(CATEGORIES).withMessage(`category must be one of: ${CATEGORIES.join(', ')}`),
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Valid email required'),
    body('mobile').optional({ checkFalsy: true }).isMobilePhone().withMessage('Valid mobile number required'),
    body().custom((value) => {
      if (!value.email && !value.mobile) throw new Error('Either email or mobile is required');
      return true;
    }),
    body('message').optional().isString().isLength({ max: 2000 }),
  ],
  validate,
  bdLeadController.create
);

/**
 * @swagger
 * /bd-leads:
 *   get:
 *     summary: List enquiries (admins see all; other staff see only those assigned to them)
 *     tags: [Business Leads]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: category, schema: { type: string, enum: [city_addition, careers, broker, builder, franchisee, advertiser] } }
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: assignedTo, schema: { type: string, format: uuid } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: dateFrom, schema: { type: string, format: date-time } }
 *       - { in: query, name: dateTo, schema: { type: string, format: date-time } }
 *     responses:
 *       200: { description: Paginated enquiries plus counts by category }
 */
router.get(
  '/',
  authenticate,
  authorize(...STAFF_ROLES),
  [
    query('category').optional().isIn(CATEGORIES),
    query('status').optional().isIn(STATUSES),
    query('assignedTo').optional().isUUID(),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  validate,
  bdLeadController.list
);

/**
 * @swagger
 * /bd-leads/city-demand:
 *   get:
 *     summary: Ranked most-requested cities from City Addition requests (Multi-Geography dashboard)
 *     tags: [Business Leads]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: days, schema: { type: integer }, description: Only count requests from the last N days }
 *     responses:
 *       200: { description: Cities with request counts and current platform status }
 */
router.get(
  '/city-demand',
  authenticate,
  authorize(...ADMIN_ROLES),
  [query('days').optional().isInt({ min: 1 })],
  validate,
  bdLeadController.cityDemand
);

/**
 * @swagger
 * /bd-leads/{id}:
 *   get:
 *     summary: Get one enquiry
 *     tags: [Business Leads]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Enquiry }
 *       404: { description: Not found / not assigned to you }
 */
router.get(
  '/:id',
  authenticate,
  authorize(...STAFF_ROLES),
  [param('id').isUUID()],
  validate,
  bdLeadController.get
);

/**
 * @swagger
 * /bd-leads/{id}/assign:
 *   put:
 *     summary: "[Super Admin / Admin] Assign an enquiry to a City Head / Area Head / Franchisee Admin / staff user"
 *     tags: [Business Leads]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assignedTo]
 *             properties:
 *               assignedTo: { type: string, format: uuid }
 *               notes: { type: string }
 *     responses:
 *       200: { description: Assigned (audit-logged, assignee notified) }
 */
router.put(
  '/:id/assign',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isUUID(), body('assignedTo').isUUID().withMessage('assignedTo is required'), body('notes').optional().isString()],
  validate,
  bdLeadController.assign
);

/**
 * @swagger
 * /bd-leads/{id}/status:
 *   put:
 *     summary: Update an enquiry's status (admin or the assignee)
 *     tags: [Business Leads]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [new, under_review, assigned, contacted, converted, rejected, closed] }
 *               notes: { type: string }
 *     responses:
 *       200: { description: Updated }
 */
router.put(
  '/:id/status',
  authenticate,
  authorize(...STAFF_ROLES),
  [param('id').isUUID(), body('status').isIn(STATUSES), body('notes').optional().isString()],
  validate,
  bdLeadController.updateStatus
);

module.exports = router;
