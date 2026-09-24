const crypto = require('crypto');
const { error } = require('../utils/response');

// Guards POST /whatsapp/lead-capture - anything that isn't Meta's own
// signed webhook (see middlewares/metaSignature.js) must send a static
// `x-webhook-secret: <WHATSAPP_WEBHOOK_SECRET>` header instead. If the
// secret isn't configured the endpoint refuses everything rather than
// silently accepting unauthenticated posts.
function verifyWebhookSecret(req, res, next) {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) return error(res, 503, 'Webhook secret is not configured on the server');

  const provided = req.headers['x-webhook-secret'];
  if (typeof provided !== 'string') return error(res, 401, 'Invalid webhook secret');

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return error(res, 401, 'Invalid webhook secret');
  }
  next();
}

module.exports = verifyWebhookSecret;
