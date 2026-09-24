const crypto = require('crypto');

const GRAPH_VERSION = 'v19.0';

function configError() {
  const err = new Error('WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)');
  err.statusCode = 503;
  return err;
}

function apiUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function callGraphApi(body) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) throw configError();

  const response = await fetch(apiUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const err = new Error(`Meta WhatsApp API error: ${data.error?.message || response.statusText}`);
    err.statusCode = 502;
    throw err;
  }

  return { providerMessageId: data.messages?.[0]?.id || null, raw: data };
}

async function sendText({ to, body }) {
  return callGraphApi({ to, type: 'text', text: { body } });
}

// `variables` (plain strings) map 1:1 to the template's {{1}}, {{2}}, ...
// body placeholders. The template itself must already be approved in Meta
// Business Manager under this exact name.
async function sendTemplate({ to, templateName, languageCode, variables = [] }) {
  const components = variables.length
    ? [{ type: 'body', parameters: variables.map((value) => ({ type: 'text', text: String(value) })) }]
    : undefined;

  return callGraphApi({
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US' },
      ...(components ? { components } : {}),
    },
  });
}

// Up to 3 quick-reply buttons. `buttons` is [{ id, title }].
async function sendInteractiveButtons({ to, body, buttons }) {
  return callGraphApi({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  });
}

// For more than 3 options. `options` is [{ id, title }].
async function sendInteractiveList({ to, body, buttonText, options }) {
  return callGraphApi({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: {
        button: buttonText || 'Choose',
        sections: [{ title: 'Options', rows: options.map((o) => ({ id: o.id, title: o.title })) }],
      },
    },
  });
}

// Meta signs every webhook POST with the app secret - see
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
// `rawBody` must be the exact request bytes (see app.js's express.json `verify`
// option, which stashes it on req.rawBody before parsing).
function verifySignature(rawBody, signatureHeader) {
  if (!process.env.WHATSAPP_APP_SECRET || !signatureHeader || !rawBody) return false;

  const expected = `sha256=${crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  sendText,
  sendTemplate,
  sendInteractiveButtons,
  sendInteractiveList,
  verifySignature,
};
