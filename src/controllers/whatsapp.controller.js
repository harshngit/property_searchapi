const whatsappService = require('../services/whatsapp.service');
const { success } = require('../utils/response');

// POST /api/whatsapp/send-template
async function sendTemplate(req, res, next) {
  try {
    const message = await whatsappService.sendTemplate(req.body, req.user);
    return success(res, 201, 'Template message sent successfully', message);
  } catch (err) {
    next(err);
  }
}

// POST /api/whatsapp/webhook (public)
async function webhook(req, res, next) {
  try {
    const result = await whatsappService.handleWebhook(req.body);
    return success(res, 200, 'Webhook processed successfully', result);
  } catch (err) {
    next(err);
  }
}

// GET /api/whatsapp/conversations/:leadId
async function getConversations(req, res, next) {
  try {
    const conversations = await whatsappService.getConversations(req.params.leadId, req.user);
    return success(res, 200, 'Conversation history fetched successfully', conversations);
  } catch (err) {
    next(err);
  }
}

// POST /api/whatsapp/share-property
async function shareProperty(req, res, next) {
  try {
    const message = await whatsappService.shareProperty(req.body, req.user);
    return success(res, 201, 'Property shared successfully', message);
  } catch (err) {
    next(err);
  }
}

// POST /api/whatsapp/acknowledge-lead
async function acknowledgeLead(req, res, next) {
  try {
    const message = await whatsappService.acknowledgeLeadEndpoint(req.body, req.user);
    return success(res, 201, 'Lead acknowledgement sent successfully', message);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  sendTemplate,
  webhook,
  getConversations,
  shareProperty,
  acknowledgeLead,
};
