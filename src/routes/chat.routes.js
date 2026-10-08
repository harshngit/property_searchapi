const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const chat = require('../services/chat.service');

// Module 36 - In-Platform Communication Layer. Mounted at /api/chat; the two
// sec. 17.2 paths (/inquiry/send-message, /inquiry/buyer-contact) are served
// by the same router mounted at /api/inquiry.

const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const idp = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   name: Chat
 *   description: >
 *     Module 36 - messaging on an enquiry between the enquirer, the lister and the assigned A R Buildwel
 *     representative (always in the thread). Contact details cannot be shared: a message carrying a number, email,
 *     link or a request to move off the platform is rejected (422) and the account is flagged. Messages are immutable.
 */

/**
 * @swagger
 * /chat/threads:
 *   get:
 *     summary: My conversations with unread counts (staff - scope=all for every conversation)
 *     tags: [Chat]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Conversations } }
 *   post:
 *     summary: Open (or return) the conversation on an enquiry
 *     tags: [Chat]
 *     security: [{ bearerAuth: [] }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, required: [leadId], properties: { leadId: { type: string, format: uuid } } } } } }
 *     responses: { 200: { description: Conversation with its participants } }
 * /chat/threads/{id}/messages:
 *   get:
 *     summary: Messages - newest page by default; ?after=<id> for new ones, ?before=<id> for older
 *     tags: [Chat]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: '{ items, has_more, next_cursor }' } }
 *   post:
 *     summary: Send a message
 *     tags: [Chat]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Sent }, 422: { description: Contact details are not allowed } }
 * /chat/unread:
 *   get:
 *     summary: Unread message and conversation counts
 *     tags: [Chat]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Counts } }
 * /inquiry/send-message:
 *   post:
 *     summary: Send a message on an enquiry (opens the conversation if needed; the representative is always in it)
 *     tags: [Chat]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Sent } }
 * /inquiry/buyer-contact:
 *   get:
 *     summary: Masked contact of the enquirer - assigned representative / admin only, every access logged
 *     tags: [Chat]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: '{ phone_masked, email_masked }' }, 403: { description: Not the assigned representative } }
 */
const chatRouter = express.Router();
chatRouter.use(authenticate);
chatRouter.get('/threads', h(async (req, res) => ok(res, 'Conversations', await chat.list(req.user, { scope: req.query.scope }))));
chatRouter.post('/threads', [body('leadId').isUUID()], validate, h(async (req, res) => ok(res, 'Conversation', await chat.open(req.user, req.body, meta(req)))));
chatRouter.get('/startable', h(async (req, res) => ok(res, 'Enquiries without a conversation', await chat.startable(req.user))));
chatRouter.get('/unread', h(async (req, res) => ok(res, 'Unread', await chat.unreadCount(req.user))));
chatRouter.get('/threads/:id', idp, validate, h(async (req, res) => ok(res, 'Conversation', await chat.view(req.user, req.params.id))));
chatRouter.get('/threads/:id/messages', idp, validate, h(async (req, res) => ok(res, 'Messages', await chat.messages(req.user, req.params.id, req.query))));
chatRouter.post('/threads/:id/messages', [...idp, body('body').isString().isLength({ min: 1, max: 5000 })], validate, h(async (req, res) => ok(res, 'Message sent', await chat.send(req.user, req.params.id, req.body, meta(req)), 201)));
chatRouter.post('/threads/:id/read', idp, validate, h(async (req, res) => ok(res, 'Marked as read', await chat.markRead(req.user, req.params.id))));
chatRouter.put('/threads/:id/status', [...idp, body('status').isIn(['open', 'closed'])], validate, h(async (req, res) => ok(res, 'Conversation updated', await chat.setStatus(req.user, req.params.id, req.body, meta(req)))));

const inquiryRouter = express.Router();
inquiryRouter.use(authenticate);
inquiryRouter.post(
  '/send-message',
  [body('leadId').isUUID(), body('message').isString().isLength({ min: 1, max: 5000 })],
  validate,
  h(async (req, res) => {
    const thread = await chat.open(req.user, { leadId: req.body.leadId }, meta(req));
    ok(res, 'Message sent', { threadId: thread.id, representativeCopied: thread.hasRepresentative, message: await chat.send(req.user, thread.id, { body: req.body.message }, meta(req)) }, 201);
  })
);
inquiryRouter.get('/buyer-contact', h(async (req, res) => ok(res, 'Masked contact', await chat.maskedContact(req.user, String(req.query.leadId || req.query.lead_id || ''), meta(req)))));

module.exports = { chatRouter, inquiryRouter };
