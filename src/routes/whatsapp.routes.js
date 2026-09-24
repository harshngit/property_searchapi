const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const whatsappController = require('../controllers/whatsapp.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const verifyWebhookSecret = require('../middlewares/webhookSecret');
const verifyMetaSignature = require('../middlewares/metaSignature');

const WHATSAPP_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: WhatsApp
 *   description: >
 *     WhatsApp via Meta's Cloud API (direct - no MSG91 or other BSP in the
 *     path) - outbound template messages, property sharing, lead
 *     acknowledgement, conversation history, a question-by-question bot
 *     flow, and the inbound webhook. CRM endpoints require authentication
 *     and are tenant-scoped. `/whatsapp/webhook` is called by Meta and is
 *     verified via its X-Hub-Signature-256 header (env WHATSAPP_APP_SECRET);
 *     `/whatsapp/lead-capture` is a separate, secret-guarded entry point
 *     (env WHATSAPP_WEBHOOK_SECRET) for anything that isn't the bot itself.
 */

/**
 * @swagger
 * /whatsapp/send-template:
 *   post:
 *     summary: Send a WhatsApp template message to a lead's contact number
 *     description: Allowed roles broker, agency_admin, internal_sales, admin, super_admin.
 *     tags: [WhatsApp]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WhatsAppSendTemplateRequest'
 *     responses:
 *       201:
 *         description: Template message sent successfully
 *       403:
 *         description: Role not permitted, or lead belongs to a different tenant
 *       404:
 *         description: Lead not found
 *       422:
 *         description: Validation failed
 */
router.post(
  '/send-template',
  authenticate,
  authorize(...WHATSAPP_ROLES),
  [
    body('leadId').isUUID().withMessage('leadId is required'),
    body('templateName').notEmpty().withMessage('templateName is required'),
    body('phoneNumber').optional().isString(),
    body('variables').optional().isArray(),
  ],
  validate,
  whatsappController.sendTemplate
);

/**
 * @swagger
 * /whatsapp/webhook:
 *   get:
 *     summary: Webhook verification challenge (Meta calls this once, during setup)
 *     description: >
 *       Register this URL in Meta App Dashboard -> WhatsApp -> Configuration
 *       with a verify token matching WHATSAPP_VERIFY_TOKEN.
 *     tags: [WhatsApp]
 *     parameters:
 *       - in: query
 *         name: hub.mode
 *         schema: { type: string }
 *       - in: query
 *         name: hub.verify_token
 *         schema: { type: string }
 *       - in: query
 *         name: hub.challenge
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Echoes hub.challenge back to Meta
 *       403:
 *         description: Token mismatch
 *   post:
 *     summary: Inbound webhook for messages/delivery status from Meta
 *     description: >
 *       Called directly by Meta's WhatsApp Cloud API. Verified via the
 *       X-Hub-Signature-256 header against WHATSAPP_APP_SECRET. Every
 *       inbound message is also fed into the question-by-question bot flow.
 *     tags: [WhatsApp]
 *     parameters:
 *       - in: header
 *         name: x-hub-signature-256
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WhatsAppWebhookRequest'
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       401:
 *         description: Invalid or missing signature
 *       503:
 *         description: WHATSAPP_APP_SECRET is not configured
 */
router.get('/webhook', whatsappController.verifyWebhook);

router.post('/webhook', verifyMetaSignature, whatsappController.webhook);

/**
 * @swagger
 * /whatsapp/lead-capture:
 *   post:
 *     summary: Create/update a lead from structured WhatsApp answers
 *     description: >
 *       An alternative entry point to the bot flow, for anything that isn't
 *       Meta's own webhook (e.g. a WhatsApp Flow's completion callback).
 *       Finds-or-creates the customer by phone, saves budget/location/
 *       property type as their preferences, and opens a `whatsapp` lead -
 *       or adds to the customer's existing open lead instead of duplicating
 *       it. Requires the `x-webhook-secret` header to match WHATSAPP_WEBHOOK_SECRET.
 *     tags: [WhatsApp]
 *     parameters:
 *       - in: header
 *         name: x-webhook-secret
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WhatsAppLeadCaptureRequest'
 *     responses:
 *       201:
 *         description: New lead created
 *       200:
 *         description: Customer already had an open lead - answers added to it
 *       401:
 *         description: Missing or wrong webhook secret
 *       422:
 *         description: Validation failed
 *       503:
 *         description: WHATSAPP_WEBHOOK_SECRET is not configured
 */
router.post(
  '/lead-capture',
  verifyWebhookSecret,
  [
    body('phone').isString().notEmpty().isLength({ max: 20 }).withMessage('phone is required'),
    body('name').optional({ nullable: true }).isString().isLength({ max: 150 }),
    body('requirement').optional({ nullable: true }).isString().isLength({ max: 100 }),
    body('location').optional({ nullable: true }).isString().isLength({ max: 150 }),
    body('budget').optional({ nullable: true }).isString().isLength({ max: 100 }),
    body('propertyType').optional({ nullable: true }).isString().isLength({ max: 100 }),
    body('notes').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ],
  validate,
  whatsappController.leadCapture
);

/**
 * @swagger
 * /whatsapp/conversations/{leadId}:
 *   get:
 *     summary: Get a lead's WhatsApp conversation history, chronologically
 *     tags: [WhatsApp]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: leadId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Conversation history fetched successfully
 *       404:
 *         description: Lead not found
 */
router.get(
  '/conversations/:leadId',
  authenticate,
  [param('leadId').isUUID().withMessage('Invalid lead id')],
  validate,
  whatsappController.getConversations
);

/**
 * @swagger
 * /whatsapp/share-property:
 *   post:
 *     summary: Send a property-share template message to a lead's contact number
 *     description: Allowed roles broker, agency_admin, internal_sales, admin, super_admin.
 *     tags: [WhatsApp]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WhatsAppSharePropertyRequest'
 *     responses:
 *       201:
 *         description: Property shared successfully
 *       403:
 *         description: Role not permitted, or lead belongs to a different tenant
 *       404:
 *         description: Lead or property not found
 *       422:
 *         description: Validation failed
 */
router.post(
  '/share-property',
  authenticate,
  authorize(...WHATSAPP_ROLES),
  [
    body('leadId').isUUID().withMessage('leadId is required'),
    body('propertyId').isUUID().withMessage('propertyId is required'),
    body('phoneNumber').optional().isString(),
  ],
  validate,
  whatsappController.shareProperty
);

/**
 * @swagger
 * /whatsapp/acknowledge-lead:
 *   post:
 *     summary: Manually (re)send the automatic lead-acknowledgement template
 *     description: >
 *       Allowed roles broker, agency_admin, internal_sales, admin,
 *       super_admin. This same logic runs automatically right after a lead
 *       is created (see lead.service.js) - this endpoint exists to resend
 *       it manually, e.g. if the first attempt failed.
 *     tags: [WhatsApp]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WhatsAppAcknowledgeLeadRequest'
 *     responses:
 *       201:
 *         description: Lead acknowledgement sent successfully
 *       400:
 *         description: Lead has no phone number on file and none was provided
 *       403:
 *         description: Role not permitted, or lead belongs to a different tenant
 *       404:
 *         description: Lead not found
 *       422:
 *         description: Validation failed
 */
router.post(
  '/acknowledge-lead',
  authenticate,
  authorize(...WHATSAPP_ROLES),
  [
    body('leadId').isUUID().withMessage('leadId is required'),
    body('phoneNumber').optional().isString(),
  ],
  validate,
  whatsappController.acknowledgeLead
);

module.exports = router;
