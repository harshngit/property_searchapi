const metaWhatsappService = require('../services/metaWhatsapp.service');
const { error } = require('../utils/response');

// Guards POST /whatsapp/webhook. Meta signs the raw request body with the
// app secret (X-Hub-Signature-256) instead of a static header, so this
// needs the exact request bytes - see app.js's express.json `verify` option.
function verifyMetaSignature(req, res, next) {
  if (!process.env.WHATSAPP_APP_SECRET) return error(res, 503, 'WHATSAPP_APP_SECRET is not configured on the server');

  const signature = req.headers['x-hub-signature-256'];
  if (!metaWhatsappService.verifySignature(req.rawBody, signature)) {
    return error(res, 401, 'Invalid webhook signature');
  }
  next();
}

module.exports = verifyMetaSignature;
