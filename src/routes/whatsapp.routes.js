const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const whatsappController = require('../controllers/whatsapp.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const WHATSAPP_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];
const WEBHOOK_TYPES = ['message', 'status'];
const WEBHOOK_STATUSES = ['sent', 'delivered', 'read', 'failed'];

/**
 * @swagger
 * tags:
 *   name: WhatsApp
 *   description: >
 *     WhatsApp Cloud API integration - outbound template messages,
 *     property sharing, lead acknowledgement, conversation history, and
 *     the inbound webhook. Every endpoint requires authentication and is
 *     tenant-scoped, except `/whatsapp/webhook` which is the public
 *     endpoint Meta calls directly. The actual Meta Cloud API call is
 *     stubbed everywhere - see the TODO comments in whatsapp.service.js
 *     for exactly where a real integration goes.
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
  ],
  validate,
  whatsappController.sendTemplate
);

/**
 * @swagger
 * /whatsapp/webhook:
 *   post:
 *     summary: Inbound webhook for messages/delivery status from Meta
 *     description: >
 *       Public endpoint (no authentication) - this is what Meta calls
 *       directly. Signature verification (X-Hub-Signature-256) is stubbed
 *       - see the TODO in whatsapp.service.js#handleWebhook. Accepts a
 *       simplified, flattened payload shape rather than Meta's real deeply
 *       nested `entry[].changes[].value` structure.
 *     tags: [WhatsApp]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WhatsAppWebhookRequest'
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       400:
 *         description: Invalid payload
 *       404:
 *         description: No matching conversation found for a status update
 */
router.post(
  '/webhook',
  [
    body('type').isIn(WEBHOOK_TYPES).withMessage('type must be one of: message, status'),
    body('phoneNumber').optional().isString(),
    body('providerMessageId').optional().isString(),
    body('messageBody').optional().isString(),
    body('status').optional().isIn(WEBHOOK_STATUSES),
  ],
  validate,
  whatsappController.webhook
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
