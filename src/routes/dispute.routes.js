const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const disputes = require('../services/dispute.service');

// Engine 5 Dispute Resolution System + sec. 9.6 lead conflicts.
// Mounted at /api/disputes.

const router = express.Router();
router.use(authenticate);
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const BROKERS = ['broker', 'agency_admin', ...STAFF];
const TYPES = ['broker_dispute', 'duplicate_listing', 'fake_claim', 'institutional_data_access', 'lead_conflict', 'commission', 'review', 'other'];
const meta = (req) => auditService.requestMeta(req);

async function evidence(req, folder) {
  const files = req.files || [];
  if (!files.length) return [];
  const { uploadBuffer } = require('../utils/storage');
  const out = [];
  for (const f of files) out.push({ path: await uploadBuffer(f.buffer, folder, f.originalname, f.mimetype), name: f.originalname });
  return out;
}

/**
 * @swagger
 * tags:
 *   name: Disputes
 *   description: >
 *     Dispute Resolution System - cases with evidence and an append-only timeline, 48 h admin SLA with escalation,
 *     full action-trail reconstruction; sec. 9.6 lead conflicts (same buyer in two brokers' CRMs) with routing /
 *     different property / transfer and commission attribution from the immutable logs.
 */

// ------------------------------------------------------------ lead conflicts

/**
 * @swagger
 * /disputes/lead-conflicts:
 *   get:
 *     summary: Lead conflicts involving the caller (all for staff); buyer shown by first name only to brokers
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: status, schema: { type: string, enum: [open, routing_requested, resolved, escalated] } }]
 *     responses: { 200: { description: Conflicts } }
 */
router.get(
  '/lead-conflicts',
  authorize(...BROKERS),
  [query('status').optional().isIn(['open', 'routing_requested', 'resolved', 'escalated'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Lead conflicts', await disputes.listConflicts(req.user, req.query)))
);

/**
 * @swagger
 * /disputes/lead-conflicts/{id}:
 *   put:
 *     summary: "Later broker: request_routing | different_property (propertyId) | transfer. First broker: accept_routing | decline_routing"
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [request_routing, different_property, transfer, accept_routing, decline_routing] }, propertyId: { type: string, format: uuid }, note: { type: string } } } } }
 *     responses: { 200: { description: Conflict } }
 */
router.put(
  '/lead-conflicts/:id',
  authorize(...BROKERS),
  [param('id').isUUID(), body('action').isIn(['request_routing', 'different_property', 'transfer', 'accept_routing', 'decline_routing']), body('propertyId').optional().isUUID(), body('note').optional().isString().isLength({ max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Conflict updated', await disputes.resolveConflict(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /disputes/lead-conflicts/{id}/attribution:
 *   get:
 *     summary: Commission attribution from the immutable logs - first contact, site visit scheduled, negotiation - with a suggested split
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Attribution } }
 */
router.get('/lead-conflicts/:id/attribution', authorize(...BROKERS), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Attribution', await disputes.attribution(req.user, req.params.id))));

/**
 * @swagger
 * /disputes/lead-conflicts/{id}/escalate:
 *   post:
 *     summary: Escalate a lead conflict to an A R admin as a dispute (48 h SLA)
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { reason: { type: string } } } } }
 *     responses: { 201: { description: Dispute } }
 */
router.post(
  '/lead-conflicts/:id/escalate',
  authorize(...BROKERS),
  [param('id').isUUID(), body('reason').optional().isString().isLength({ max: 2000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 201, 'Escalated', await disputes.escalateConflict(req.user, req.params.id, req.body, meta(req))))
);

// ------------------------------------------------------------------ cases

/**
 * @swagger
 * /disputes:
 *   get:
 *     summary: Disputes - staff see all (status open = every unresolved case); others see cases they raised or are named in
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: type, schema: { type: string } }
 *       - { in: query, name: mine, schema: { type: boolean } }
 *     responses: { 200: { description: Disputes with overdue flag } }
 *   post:
 *     summary: Open a dispute with evidence (broker dispute, duplicate listing, fake claim, institutional data access, commission, review, other)
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [type, title, description]
 *             properties:
 *               type: { type: string }
 *               title: { type: string }
 *               description: { type: string }
 *               againstUserId: { type: string, format: uuid }
 *               propertyId: { type: string, format: uuid }
 *               dealId: { type: string, format: uuid }
 *               leadId: { type: string, format: uuid }
 *               files: { type: array, items: { type: string, format: binary } }
 *     responses: { 201: { description: Dispute } }
 */
router.get('/', asyncHandler(async (req, res) => success(res, 200, 'Disputes', await disputes.listDisputes(req.user, req.query))));
router.post(
  '/',
  uploadDocumentFile.array('files', 10),
  [
    body('type').isIn(TYPES.filter((t) => t !== 'lead_conflict')),
    body('title').trim().isLength({ min: 5, max: 200 }),
    body('description').trim().isLength({ min: 10, max: 5000 }),
    body('againstUserId').optional({ checkFalsy: true }).isUUID(),
    body('propertyId').optional({ checkFalsy: true }).isUUID(),
    body('dealId').optional({ checkFalsy: true }).isUUID(),
    body('leadId').optional({ checkFalsy: true }).isUUID(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const attachments = await evidence(req, `disputes/${req.user.id}`);
    return success(res, 201, 'Dispute opened', await disputes.openDispute(req.user, { ...req.body, attachments }, meta(req)));
  })
);

/**
 * @swagger
 * /disputes/{id}:
 *   get:
 *     summary: Case with its timeline (internal notes for staff only)
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Dispute } }
 *   put:
 *     summary: "[Staff] Move to under_review / awaiting_info / closed, assign, change priority"
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { status: { type: string, enum: [under_review, awaiting_info, closed] }, assignedTo: { type: string, format: uuid }, priority: { type: string, enum: [low, normal, high, urgent] }, note: { type: string } } } } }
 *     responses: { 200: { description: Dispute } }
 */
router.get('/:id', [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Dispute', await disputes.getDispute(req.user, req.params.id))));
router.put(
  '/:id',
  authorize(...STAFF),
  [param('id').isUUID(), body('status').optional().isIn(['under_review', 'awaiting_info', 'closed']), body('assignedTo').optional().isUUID(), body('priority').optional().isIn(['low', 'normal', 'high', 'urgent']), body('note').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Dispute updated', await disputes.update(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /disputes/{id}/comments:
 *   post:
 *     summary: Add a comment / evidence (parties and staff); staff can post internal notes
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { multipart/form-data: { schema: { type: object, properties: { body: { type: string }, internal: { type: boolean }, files: { type: array, items: { type: string, format: binary } } } } } }
 *     responses: { 200: { description: Dispute } }
 */
router.post(
  '/:id/comments',
  uploadDocumentFile.array('files', 10),
  [param('id').isUUID(), body('body').optional().isString().isLength({ max: 5000 }), body('internal').optional().isBoolean().toBoolean()],
  validate,
  asyncHandler(async (req, res) => {
    const attachments = await evidence(req, `disputes/${req.params.id}`);
    if (!req.body.body && !attachments.length) throw require('../utils/httpError').badRequest('Write a comment or attach evidence');
    return success(res, 200, 'Added', await disputes.comment(req.user, req.params.id, { body: req.body.body, attachments, internal: !!req.body.internal }, meta(req)));
  })
);

/**
 * @swagger
 * /disputes/{id}/resolve:
 *   post:
 *     summary: "[Admin] Resolve or dismiss with the written resolution, who it favours and any outcome (e.g. commission split)"
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [decision, resolution], properties: { decision: { type: string, enum: [resolve, dismiss] }, resolution: { type: string }, inFavourOf: { type: string, format: uuid }, outcome: { type: object } } } } }
 *     responses: { 200: { description: Dispute } }
 */
router.post(
  '/:id/resolve',
  authorize(...ADMIN),
  [param('id').isUUID(), body('decision').isIn(['resolve', 'dismiss']), body('resolution').trim().isLength({ min: 5, max: 5000 }), body('inFavourOf').optional({ checkFalsy: true }).isUUID(), body('outcome').optional().isObject()],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Dispute closed', await disputes.resolve(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /disputes/{id}/reconstruction:
 *   get:
 *     summary: "[Staff] Full action trail - case timeline + audit logs + lead activity, notes, WhatsApp messages, deal stages and site visits"
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Chronological events } }
 */
router.get('/:id/reconstruction', authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Reconstruction', await disputes.reconstruct(req.user, req.params.id))));

/**
 * @swagger
 * /disputes/{id}/evidence:
 *   get:
 *     summary: 15-minute link to an evidence file on the case (parties and staff)
 *     tags: [Disputes]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: path, required: true, schema: { type: string } }
 *     responses: { 200: { description: "{ url }" } }
 */
router.get(
  '/:id/evidence',
  [param('id').isUUID(), query('path').isString()],
  validate,
  asyncHandler(async (req, res) => {
    const d = await disputes.getDispute(req.user, req.params.id);
    const ok = d.timeline.some((e) => (e.attachments || []).some((a) => a.path === req.query.path));
    if (!ok) throw require('../utils/httpError').notFound('Evidence not found on this case');
    const { generateSignedReadUrl } = require('../utils/storage');
    return success(res, 200, 'Evidence link', { url: await generateSignedReadUrl(req.query.path, 15 * 60 * 1000) });
  })
);

module.exports = router;
