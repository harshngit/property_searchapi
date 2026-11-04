const express = require('express');
const { body, param } = require('express-validator');

const status = require('../services/status.service');
const auditService = require('../services/audit.service');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

const router = express.Router();
const meta = (req) => auditService.requestMeta(req);
const ADMIN = ['admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: Status
 *   description: Sec. 25.5.4 incident communication - the public status page, the CRM banner, and staff posting incidents / maintenance with updates and an ETA.
 * /status:
 *   get:
 *     summary: Public status page - each part of the platform with its state, open incidents and maintenance (with updates and ETA), last 14 days resolved. No sign-in.
 *     tags: [Status]
 *     responses: { 200: { description: Status } }
 * /status/banner:
 *   get:
 *     summary: Open incidents and upcoming maintenance for the CRM banner
 *     tags: [Status]
 *     security: [{ bearerAuth: [] }]
 * /status/admin:
 *   get:
 *     summary: Incidents of the last 90 days plus automatic checks (database, storage, providers, last backup and restore test, crawler, geocoding) - admin
 *     tags: [Status]
 *     security: [{ bearerAuth: [] }]
 * /status/incidents:
 *   post:
 *     summary: Post an incident or planned maintenance - major / critical / maintenance are sent in-app to franchisees and brokers (status.notify_roles) - admin
 *     tags: [Status]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, impact, components, message]
 *             properties:
 *               title: { type: string, example: WhatsApp messages delayed }
 *               impact: { type: string, enum: [minor, major, critical, maintenance] }
 *               status: { type: string, enum: [investigating, identified, monitoring] }
 *               components: { type: array, items: { type: string }, example: [whatsapp] }
 *               message: { type: string }
 *               etaAt: { type: string, format: date-time }
 *               startsAt: { type: string, format: date-time, description: Start of planned maintenance }
 * /status/incidents/{id}/updates:
 *   post:
 *     summary: Add an update (status, message, new ETA); status resolved closes it and tells everyone who was told - admin
 *     tags: [Status]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/', handler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  return success(res, 200, 'Platform status', await status.publicStatus());
}));
router.get('/banner', authenticate, handler(async (req, res) => success(res, 200, 'Open incidents', await status.banner())));
router.get('/admin', authenticate, authorize(...ADMIN), handler(async (req, res) => success(res, 200, 'Status admin', await status.adminView())));
router.post(
  '/incidents',
  authenticate,
  authorize(...ADMIN),
  [
    body('title').isString().trim().isLength({ min: 5, max: 160 }),
    body('impact').isIn(['minor', 'major', 'critical', 'maintenance']),
    body('status').optional().isIn(['investigating', 'identified', 'monitoring']),
    body('components').isArray({ min: 1, max: 20 }),
    body('message').isString().trim().isLength({ min: 5, max: 1000 }),
    body('etaAt').optional({ nullable: true }).isISO8601(),
    body('startsAt').optional({ nullable: true }).isISO8601(),
  ],
  validate,
  handler(async (req, res) => success(res, 201, 'Incident posted', await status.createIncident(req.user, req.body, meta(req))))
);
router.post(
  '/incidents/:id/updates',
  authenticate,
  authorize(...ADMIN),
  [
    param('id').isUUID(),
    body('status').optional().isIn(['investigating', 'identified', 'monitoring', 'scheduled', 'resolved']),
    body('message').isString().trim().isLength({ min: 5, max: 1000 }),
    body('etaAt').optional({ nullable: true }).isISO8601(),
    body('components').optional().isArray({ min: 1, max: 20 }),
  ],
  validate,
  handler(async (req, res) => success(res, 200, 'Update posted', await status.addUpdate(req.user, req.params.id, req.body, meta(req))))
);

module.exports = router;
