const crypto = require('crypto');
const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');

function notFound(message = 'Not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const ACK_TEMPLATE = 'lead_acknowledgement';
const PROPERTY_SHARE_TEMPLATE = 'property_share';

async function getLeadWithCustomer(leadId) {
  const result = await pool.query(
    `SELECT l.*, c.mobile AS customer_mobile, c.full_name AS customer_full_name
     FROM leads l JOIN customers c ON c.id = l.customer_id
     WHERE l.id = $1`,
    [leadId]
  );
  if (result.rows.length === 0) throw notFound('Lead not found');
  return result.rows[0];
}

// Sends via the Meta Cloud API. Stubbed for now - inserts the outbound
// whatsapp_conversations row and returns it, but makes no real HTTP call.
//
// TODO: replace the block below with a real Meta Cloud API call, e.g.:
//   const resp = await axios.post(
//     `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
//     { messaging_product: 'whatsapp', to: phoneNumber, type: 'template',
//       template: { name: templateName, language: { code: 'en_US' } } },
//     { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
//   );
//   const providerMessageId = resp.data.messages[0].id;
// and use `providerMessageId` below instead of the stubbed value.
async function sendTemplateMessage({ tenantId, leadId, customerId, phoneNumber, templateName, messageBody }) {
  if (!phoneNumber) throw badRequest('No phone number available to send to');

  const providerMessageId = `stub_wamid_${crypto.randomBytes(10).toString('hex')}`;

  const result = await pool.query(
    `INSERT INTO whatsapp_conversations (
       tenant_id, lead_id, customer_id, phone_number, direction, message_type,
       template_name, message_body, provider_message_id, status
     ) VALUES ($1, $2, $3, $4, 'outbound', 'template', $5, $6, $7, 'sent')
     RETURNING *`,
    [tenantId || null, leadId || null, customerId || null, phoneNumber, templateName, messageBody || null, providerMessageId]
  );

  return result.rows[0];
}

// POST /api/whatsapp/send-template
async function sendTemplate(data, user) {
  const { leadId, templateName, phoneNumber } = data;

  const lead = await getLeadWithCustomer(leadId);
  if (!isAdmin(user.role) && lead.tenant_id !== user.tenant_id) {
    throw notFound('Lead not found');
  }

  const toNumber = phoneNumber || lead.customer_mobile;
  const message = await sendTemplateMessage({
    tenantId: lead.tenant_id,
    leadId: lead.id,
    customerId: lead.customer_id,
    phoneNumber: toNumber,
    templateName,
  });

  await pool.query(
    `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'whatsapp_sent', $3)`,
    [lead.id, user.id, JSON.stringify({ templateName, phoneNumber: toNumber })]
  );

  return message;
}

// POST /api/whatsapp/share-property
async function shareProperty(data, user) {
  const { leadId, propertyId, phoneNumber } = data;

  const lead = await getLeadWithCustomer(leadId);
  if (!isAdmin(user.role) && lead.tenant_id !== user.tenant_id) {
    throw notFound('Lead not found');
  }

  const property = await pool.query('SELECT id, title FROM properties WHERE id = $1', [propertyId]);
  if (property.rows.length === 0) throw notFound('Property not found');

  const toNumber = phoneNumber || lead.customer_mobile;
  const message = await sendTemplateMessage({
    tenantId: lead.tenant_id,
    leadId: lead.id,
    customerId: lead.customer_id,
    phoneNumber: toNumber,
    templateName: PROPERTY_SHARE_TEMPLATE,
    messageBody: `Shared property: ${property.rows[0].title}`,
  });

  await pool.query(
    `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'property_shared', $3)`,
    [lead.id, user.id, JSON.stringify({ propertyId, phoneNumber: toNumber })]
  );

  return message;
}

// Internal function - called both from POST /api/whatsapp/acknowledge-lead
// and directly from lead.service.js right after a lead is created. Never
// throws for a missing phone number; it just no-ops, since a lead with no
// contact number on file simply can't be acknowledged over WhatsApp.
//
// `actingUser` is optional - when called automatically from lead creation
// there's no HTTP-request user to attribute the activity-log entry to.
async function acknowledgeLead(leadId, { phoneNumber, actingUser } = {}) {
  const lead = await getLeadWithCustomer(leadId);

  const toNumber = phoneNumber || lead.customer_mobile;
  if (!toNumber) return null;

  const message = await sendTemplateMessage({
    tenantId: lead.tenant_id,
    leadId: lead.id,
    customerId: lead.customer_id,
    phoneNumber: toNumber,
    templateName: ACK_TEMPLATE,
    messageBody: `Hi ${lead.customer_full_name}, thanks for reaching out to PropertySerch - our team will get in touch shortly.`,
  });

  await pool.query(
    `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'whatsapp_acknowledged', $3)`,
    [lead.id, actingUser?.id || null, JSON.stringify({ phoneNumber: toNumber })]
  );

  return message;
}

// POST /api/whatsapp/acknowledge-lead (HTTP wrapper around the function above)
async function acknowledgeLeadEndpoint(data, user) {
  const { leadId, phoneNumber } = data;

  const lead = await getLeadWithCustomer(leadId);
  if (!isAdmin(user.role) && lead.tenant_id !== user.tenant_id) {
    throw notFound('Lead not found');
  }

  const message = await acknowledgeLead(leadId, { phoneNumber, actingUser: user });
  if (!message) throw badRequest('Lead has no phone number on file and none was provided');
  return message;
}

// GET /api/whatsapp/conversations/:leadId
async function getConversations(leadId, user) {
  const lead = await getLeadWithCustomer(leadId);
  if (!isAdmin(user.role) && lead.tenant_id !== user.tenant_id && lead.created_by !== user.id && lead.assigned_to !== user.id) {
    throw notFound('Lead not found');
  }

  const result = await pool.query(
    'SELECT * FROM whatsapp_conversations WHERE lead_id = $1 ORDER BY created_at ASC',
    [leadId]
  );
  return result.rows;
}

// POST /api/whatsapp/webhook (public, no auth)
// Simplified webhook body - real Meta payloads are deeply nested
// (entry[].changes[].value.messages[]/statuses[]); this stub accepts a
// flattened shape and the TODO below shows where real payload parsing +
// signature verification (X-Hub-Signature-256) would go.
//
// TODO: verify the request signature before trusting the payload, e.g.:
//   const expected = crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
//     .update(rawRequestBody).digest('hex');
//   if (`sha256=${expected}` !== req.headers['x-hub-signature-256']) throw 401
async function handleWebhook(payload) {
  const { type, phoneNumber, providerMessageId, messageBody, status } = payload;

  if (type === 'status') {
    if (!providerMessageId) throw badRequest('providerMessageId is required for a status update');
    const result = await pool.query(
      `UPDATE whatsapp_conversations SET status = $1 WHERE provider_message_id = $2 RETURNING *`,
      [status, providerMessageId]
    );
    if (result.rows.length === 0) throw notFound('No conversation found for this providerMessageId');
    return result.rows[0];
  }

  // type === 'message' (inbound). Try to resolve an existing customer/lead
  // by phone number; if none is found the message is still logged, just
  // unlinked (lead_id/customer_id stay NULL).
  const customerResult = await pool.query('SELECT id, tenant_id FROM customers WHERE mobile = $1 LIMIT 1', [phoneNumber]);
  const customer = customerResult.rows[0] || null;

  let lead = null;
  if (customer) {
    const leadResult = await pool.query(
      'SELECT id, tenant_id FROM leads WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1',
      [customer.id]
    );
    lead = leadResult.rows[0] || null;
  }

  const result = await pool.query(
    `INSERT INTO whatsapp_conversations (
       tenant_id, lead_id, customer_id, phone_number, direction, message_type,
       message_body, provider_message_id, status
     ) VALUES ($1, $2, $3, $4, 'inbound', 'text', $5, $6, 'delivered')
     RETURNING *`,
    [lead?.tenant_id || customer?.tenant_id || null, lead?.id || null, customer?.id || null, phoneNumber, messageBody || null, providerMessageId || null]
  );

  return result.rows[0];
}

module.exports = {
  sendTemplate,
  shareProperty,
  acknowledgeLead,
  acknowledgeLeadEndpoint,
  getConversations,
  handleWebhook,
};
