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

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Every send accepts EITHER a phone number (`to`) OR a BSUID (`recipient`) -
// Meta's Business-Scoped User ID, the identity it guarantees on every
// contact even when the customer has hidden their number behind a WhatsApp
// username. Phone wins when both are known (matches Meta's own documented
// precedence); `recipient_type` is only needed on the BSUID path.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
function addRecipient(body, { to, recipient }) {
  if (to) return { ...body, to };
  if (recipient) return { ...body, recipient_type: 'individual', recipient };
  throw badRequest('A phone number or BSUID recipient is required');
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

async function sendText({ to, recipient, body }) {
  return callGraphApi(addRecipient({ type: 'text', text: { body } }, { to, recipient }));
}

// `variables` (plain strings) map 1:1 to the template's {{1}}, {{2}}, ...
// body placeholders. The template itself must already be approved in Meta
// Business Manager under this exact name.
//
// `buttonUrlSuffix`: for a template whose one button is "Visit website" with
// a dynamic URL (e.g. https://propertyserch.com/p/{{1}}), the value to fill
// in for that button's own {{1}} - a separate placeholder namespace from the
// body's, per Meta's template format.
// `headerDocument`/`headerImage`: for a template with a document (PDF) or
// image header - `{ link, filename? }`. Exactly one should be set, matching
// however the template itself was approved.
async function sendTemplate({ to, recipient, templateName, languageCode, variables = [], buttonUrlSuffix, headerDocument, headerImage }) {
  const components = [];
  if (headerDocument) {
    components.push({ type: 'header', parameters: [{ type: 'document', document: { link: headerDocument.link, filename: headerDocument.filename || undefined } }] });
  } else if (headerImage) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImage.link } }] });
  }
  if (variables.length) {
    components.push({ type: 'body', parameters: variables.map((value) => ({ type: 'text', text: String(value) })) });
  }
  if (buttonUrlSuffix) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(buttonUrlSuffix) }] });
  }

  return callGraphApi(
    addRecipient(
      {
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US' },
          ...(components.length ? { components } : {}),
        },
      },
      { to, recipient }
    )
  );
}

// Up to 3 quick-reply buttons. `buttons` is [{ id, title }].
async function sendInteractiveButtons({ to, recipient, body, buttons }) {
  return callGraphApi(
    addRecipient(
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
        },
      },
      { to, recipient }
    )
  );
}

// For more than 3 options. `options` is [{ id, title }].
async function sendInteractiveList({ to, recipient, body, buttonText, options }) {
  return callGraphApi(
    addRecipient(
      {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: body },
          action: {
            button: buttonText || 'Choose',
            sections: [{ title: 'Options', rows: options.map((o) => ({ id: o.id, title: o.title })) }],
          },
        },
      },
      { to, recipient }
    )
  );
}

// Inbound media (a photo sent to the bot): look up its short-lived URL by id,
// then download it with the same access token. Returns { buffer, mimetype }.
async function downloadMedia(mediaId) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) throw configError();
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` };
  const meta = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, { headers: auth });
  const info = await meta.json().catch(() => ({}));
  if (!meta.ok || !info.url) throw new Error(`Meta WhatsApp media lookup failed: ${info.error?.message || meta.statusText}`);
  const file = await fetch(info.url, { headers: auth });
  if (!file.ok) throw new Error(`Meta WhatsApp media download failed: ${file.statusText}`);
  return { buffer: Buffer.from(await file.arrayBuffer()), mimetype: info.mime_type || 'image/jpeg', filename: 'whatsapp.jpg' };
}

// Current approval status of every template on this WABA (name, status,
// category) - the same read-only call WhatsApp Manager itself shows.
async function listTemplates() {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) throw configError();
  const out = [];
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?fields=name,status,category,language&limit=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(`Meta WhatsApp API error: ${data.error?.message || res.statusText}`);
    out.push(...(data.data || []));
    url = data.paging?.next || null;
  }
  return out;
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
  downloadMedia,
  verifySignature,
  listTemplates,
};
