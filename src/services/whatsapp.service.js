const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const metaWhatsappService = require('./metaWhatsapp.service');
const customerService = require('./customer.service');

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

// Template names must match templates already approved in Meta Business Manager.
const ACK_TEMPLATE = process.env.WHATSAPP_TEMPLATE_ACK || 'lead_acknowledgement';
const PROPERTY_SHARE_TEMPLATE = process.env.WHATSAPP_TEMPLATE_PROPERTY_SHARE || 'property_share';

// Stored/looked-up customer mobiles are bare 10-digit Indian numbers, while
// WhatsApp gives us the full international form (919876543210).
function toLocalMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const countryCode = process.env.WHATSAPP_COUNTRY_CODE || '91';
  if (digits.length === 10 + countryCode.length && digits.startsWith(countryCode)) {
    return digits.slice(countryCode.length);
  }
  return digits;
}

// The inverse - Meta's `to` field needs the full international number
// (919876543210), while stored customer mobiles are bare 10-digit numbers.
function toInternationalMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const countryCode = process.env.WHATSAPP_COUNTRY_CODE || '91';
  if (digits.length === 10) return `${countryCode}${digits}`;
  return digits;
}

const CRORE = 10000000;
const LAKH = 100000;

// Turns a bot's free-form budget answer ("50L-1Cr", "₹1Cr - ₹2Cr", "2Cr+",
// "50-80 lakh", "1 crore") into { min, max } rupee amounts (null = open).
function parseBudget(text) {
  if (!text) return { min: null, max: null };
  const source = String(text).toLowerCase().replace(/[,₹]|rs\.?|inr/g, '');
  const matches = [...source.matchAll(/(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|l|k)?/g)];
  if (matches.length === 0) return { min: null, max: null };

  const unitValue = (unit) => {
    if (!unit) return null;
    if (unit.startsWith('c')) return CRORE;
    if (unit.startsWith('l')) return LAKH;
    if (unit === 'k') return 1000;
    return null;
  };

  const nums = matches.slice(0, 2).map((m) => ({ value: Number(m[1]), unit: unitValue(m[2]) }));
  const fallbackUnit = nums.map((n) => n.unit).find(Boolean) || 1;
  const amounts = nums.map((n) => Math.round(n.value * (n.unit || fallbackUnit)));

  if (amounts.length === 2) return { min: Math.min(...amounts), max: Math.max(...amounts) };
  if (/\+|above|more than|over|plus/.test(source)) return { min: amounts[0], max: null };
  return { min: null, max: amounts[0] };
}

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

// Sends an approved template via Meta's WhatsApp Cloud API and logs it in
// whatsapp_conversations. A provider failure is logged as a 'failed' row
// (so it shows in the lead's conversation history) and then re-thrown.
async function sendTemplateMessage({ tenantId, leadId, customerId, phoneNumber, templateName, messageBody, variables }) {
  if (!phoneNumber) throw badRequest('No phone number available to send to');

  let providerMessageId = null;
  let status = 'sent';
  let sendError = null;
  try {
    const sent = await metaWhatsappService.sendTemplate({ to: toInternationalMobile(phoneNumber), templateName, variables });
    providerMessageId = sent.providerMessageId;
  } catch (err) {
    status = 'failed';
    sendError = err;
  }

  const result = await pool.query(
    `INSERT INTO whatsapp_conversations (
       tenant_id, lead_id, customer_id, phone_number, direction, message_type,
       template_name, message_body, provider_message_id, status
     ) VALUES ($1, $2, $3, $4, 'outbound', 'template', $5, $6, $7, $8)
     RETURNING *`,
    [tenantId || null, leadId || null, customerId || null, phoneNumber, templateName, messageBody || null, providerMessageId, status]
  );

  if (sendError) throw sendError;
  return result.rows[0];
}

// POST /api/whatsapp/send-template
async function sendTemplate(data, user) {
  const { leadId, templateName, phoneNumber, variables } = data;

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
    variables: Array.isArray(variables) ? variables : [lead.customer_full_name],
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
    variables: [lead.customer_full_name, property.rows[0].title],
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
    variables: [lead.customer_full_name],
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

// POST /api/whatsapp/webhook - Meta calls this directly. Signature is
// checked by middlewares/metaSignature.js before this runs. Meta's real
// payload is deeply nested: entry[].changes[].value.{messages[],statuses[]}.
// Logs every status update and inbound message, then returns the inbound
// messages so the controller can hand each one to whatsappBot.service.js -
// kept separate to avoid a circular require (the bot service needs
// captureLead from this file).
async function handleWebhook(payload) {
  const inboundMessages = [];

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      for (const statusUpdate of value.statuses || []) {
        // No-op if nothing matches (e.g. a status for a message this
        // server didn't send) - Meta must always get a 200 regardless.
        await pool.query(`UPDATE whatsapp_conversations SET status = $1 WHERE provider_message_id = $2`, [
          statusUpdate.status,
          statusUpdate.id,
        ]);
      }

      for (const message of value.messages || []) {
        const phoneNumber = message.from;
        let text = null;
        let buttonReplyId = null;
        let buttonReplyTitle = null;

        if (message.type === 'text') {
          text = message.text?.body || null;
        } else if (message.type === 'interactive') {
          const reply = message.interactive?.button_reply || message.interactive?.list_reply;
          buttonReplyId = reply?.id || null;
          buttonReplyTitle = reply?.title || null;
        } else if (message.type === 'button') {
          buttonReplyId = message.button?.payload || null;
          buttonReplyTitle = message.button?.text || null;
        }

        const customerResult = await pool.query('SELECT id, tenant_id FROM customers WHERE mobile = $1 LIMIT 1', [
          toLocalMobile(phoneNumber),
        ]);
        const customer = customerResult.rows[0] || null;

        let lead = null;
        if (customer) {
          const leadResult = await pool.query(
            'SELECT id, tenant_id FROM leads WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1',
            [customer.id]
          );
          lead = leadResult.rows[0] || null;
        }

        await pool.query(
          `INSERT INTO whatsapp_conversations (
             tenant_id, lead_id, customer_id, phone_number, direction, message_type,
             message_body, provider_message_id, status
           ) VALUES ($1, $2, $3, $4, 'inbound', 'text', $5, $6, 'delivered')`,
          [
            lead?.tenant_id || customer?.tenant_id || null,
            lead?.id || null,
            customer?.id || null,
            phoneNumber,
            text || buttonReplyTitle || null,
            message.id || null,
          ]
        );

        inboundMessages.push({ phoneNumber, text, buttonReplyId, buttonReplyTitle, messageId: message.id });
      }
    }
  }

  return { inboundMessages };
}

function mapTransactionType(requirement) {
  const text = String(requirement || '').toLowerCase();
  if (text.includes('rent')) return 'rent';
  if (/buy|purchase|invest/.test(text)) return 'buy';
  return null;
}

function mapPropertyType(text) {
  const value = String(text || '').toLowerCase();
  if (/farm/.test(value)) return 'farmhouse';
  if (/villa/.test(value)) return 'villa';
  if (/independent|house/.test(value)) return 'independent_house';
  if (/plot|land/.test(value)) return 'plot';
  if (/commercial|shop|office/.test(value)) return 'commercial';
  if (/bhk|flat|apartment/.test(value)) return 'apartment';
  return null;
}

function parseBedrooms(text) {
  const match = String(text || '').match(/(\d+)\s*bhk/i);
  return match ? Number(match[1]) : null;
}

// POST /api/whatsapp/lead-capture (called by the MSG91 bot / WhatsApp Flow
// once the customer has answered every question). Finds-or-creates the
// customer by phone, stores their answers as preferences, and opens a
// 'whatsapp' lead - or, if that customer already has an open lead, adds the
// new answers to it instead of creating a duplicate.
async function captureLead(data) {
  const { phone, name, requirement, location, budget, propertyType, notes } = data;

  const mobile = toLocalMobile(phone);
  if (mobile.length < 8) throw badRequest('A valid phone number is required');

  const defaultTenantId = process.env.WHATSAPP_DEFAULT_TENANT_ID || null;
  const cleanName = name && name.trim() ? name.trim() : null;

  let customer = await customerService.findOrCreateCustomerByContact({
    fullName: cleanName || `WhatsApp ${mobile}`,
    mobile,
  });
  if (cleanName && /^WhatsApp \d+$/.test(customer.full_name)) {
    const updated = await pool.query('UPDATE customers SET full_name = $1 WHERE id = $2 RETURNING *', [cleanName, customer.id]);
    customer = updated.rows[0];
  }
  if (!customer.tenant_id && defaultTenantId) {
    const updated = await pool.query('UPDATE customers SET tenant_id = $1 WHERE id = $2 RETURNING *', [defaultTenantId, customer.id]);
    customer = updated.rows[0];
  }

  const { min: budgetMin, max: budgetMax } = parseBudget(budget);
  const summaryLines = [
    requirement && `Requirement: ${requirement}`,
    location && `Location: ${location}`,
    budget && `Budget: ${budget}`,
    propertyType && `Property type: ${propertyType}`,
    notes && `Notes: ${notes}`,
  ].filter(Boolean);
  const summary = summaryLines.join('\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO customer_preferences (
         customer_id, budget_min, budget_max, preferred_locations, property_type,
         transaction_type, bedrooms, notes
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (customer_id) DO UPDATE SET
         budget_min = COALESCE(EXCLUDED.budget_min, customer_preferences.budget_min),
         budget_max = COALESCE(EXCLUDED.budget_max, customer_preferences.budget_max),
         preferred_locations = CASE WHEN EXCLUDED.preferred_locations = '[]'::jsonb
                                    THEN customer_preferences.preferred_locations
                                    ELSE EXCLUDED.preferred_locations END,
         property_type = COALESCE(EXCLUDED.property_type, customer_preferences.property_type),
         transaction_type = COALESCE(EXCLUDED.transaction_type, customer_preferences.transaction_type),
         bedrooms = COALESCE(EXCLUDED.bedrooms, customer_preferences.bedrooms),
         notes = COALESCE(EXCLUDED.notes, customer_preferences.notes)`,
      [
        customer.id,
        budgetMin,
        budgetMax,
        JSON.stringify(location ? [location] : []),
        mapPropertyType(propertyType),
        mapTransactionType(requirement),
        parseBedrooms(propertyType),
        summary ? `Captured via WhatsApp bot\n${summary}` : null,
      ]
    );

    const existing = await client.query(
      `SELECT id FROM leads WHERE customer_id = $1 AND status NOT IN ('won', 'lost')
       ORDER BY created_at DESC LIMIT 1`,
      [customer.id]
    );

    let leadId;
    let isNewLead = false;
    if (existing.rows.length > 0) {
      leadId = existing.rows[0].id;
    } else {
      const inserted = await client.query(
        `INSERT INTO leads (tenant_id, source, customer_id, status)
         VALUES ($1, 'whatsapp', $2, 'new') RETURNING id`,
        [customer.tenant_id || defaultTenantId, customer.id]
      );
      leadId = inserted.rows[0].id;
      isNewLead = true;
      await client.query(
        `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, NULL, 'lead_created', $2)`,
        [leadId, JSON.stringify({ source: 'whatsapp', channel: 'whatsapp_bot' })]
      );
    }

    await client.query(
      `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, NULL, 'whatsapp_lead_captured', $2)`,
      [leadId, JSON.stringify({ requirement, location, budget, propertyType, notes, phone: mobile })]
    );

    await client.query(
      `INSERT INTO whatsapp_conversations (
         tenant_id, lead_id, customer_id, phone_number, direction, message_type, message_body, status
       ) VALUES ($1, $2, $3, $4, 'inbound', 'text', $5, 'delivered')`,
      [customer.tenant_id || defaultTenantId, leadId, customer.id, String(phone).replace(/\D/g, '').slice(0, 20), summary || 'WhatsApp bot lead capture']
    );

    await client.query('COMMIT');
    return { leadId, customerId: customer.id, isNewLead };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  captureLead,
  parseBudget,
  toLocalMobile,
  toInternationalMobile,
  sendTemplate,
  shareProperty,
  acknowledgeLead,
  acknowledgeLeadEndpoint,
  getConversations,
  handleWebhook,
};
