const whatsappService = require('../services/whatsapp.service');
const whatsappBotService = require('../services/whatsappBot.service');
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

// GET /api/whatsapp/webhook - Meta calls this once, when the webhook URL is
// registered in Meta App Dashboard -> WhatsApp -> Configuration, to prove
// this server controls the URL.
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

// POST /api/whatsapp/webhook - Meta calls this for every inbound message
// and delivery-status update (signature checked by middlewares/metaSignature.js).
// Logs everything via whatsapp.service.js, then feeds each inbound message
// into the bot's question flow.
async function webhook(req, res, next) {
  try {
    const { inboundMessages } = await whatsappService.handleWebhook(req.body);

    for (const message of inboundMessages) {
      try {
        await whatsappBotService.handleInboundMessage(message);
      } catch (err) {
        console.error(`WhatsApp bot flow failed for ${message.phoneNumber}:`, err.message);
      }
    }

    return success(res, 200, 'Webhook processed successfully', { received: inboundMessages.length });
  } catch (err) {
    next(err);
  }
}

// POST /api/whatsapp/lead-capture - structured lead capture for anything
// other than the bot flow above (e.g. a WhatsApp Flow's completion webhook),
// secret-guarded since it's not signed by Meta the way /webhook is.
async function leadCapture(req, res, next) {
  try {
    const result = await whatsappService.captureLead(req.body);
    return success(res, result.isNewLead ? 201 : 200, result.isNewLead ? 'Lead captured successfully' : 'Existing lead updated successfully', result);
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
  verifyWebhook,
  webhook,
  leadCapture,
  getConversations,
  shareProperty,
  acknowledgeLead,
};
