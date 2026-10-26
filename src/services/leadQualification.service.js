const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const metaWhatsapp = require('./metaWhatsapp.service');

// ar_lead_qualification cascade (per the client-approved WhatsApp spec):
// WhatsApp quick-reply (Buy/Rent/Sell) -> if answered, notify the rep with
// ar_lead_qualified_summary -> if unanswered twice, ar_tc_escalation to a
// Telecaller instead of a human calling through, since no AI-voice step
// exists in this codebase (decision: skip AI voice entirely).
const BUTTON_PURPOSE = { lq_buy: 'buy', lq_rent: 'rent', lq_sell: 'sell' };

async function settings() {
  const [reminderHours, escalateHours] = await Promise.all([
    configService.getConfig('lead_qualification.reminder_hours', 4),
    configService.getConfig('lead_qualification.escalate_hours', 8),
  ]);
  return { reminderHours: Number(reminderHours) || 4, escalateHours: Number(escalateHours) || 8 };
}

function last10(mobile) {
  return String(mobile || '').replace(/\D/g, '').slice(-10);
}

async function sendMessage(digits, firstName) {
  await metaWhatsapp.sendTemplate({ to: `91${digits}`, templateName: 'ar_lead_qualification', variables: [firstName] });
}

// A lead with no linked property is a general enquiry with no known
// purpose yet - this is the only case the doc's qualification cascade
// applies to (a lead tied to a specific listing already implies buy/rent).
async function sendQualification(lead) {
  if (lead.property_id || lead.qualification_sent_at) return;
  const customer = (await pool.query('SELECT full_name, mobile FROM customers WHERE id = $1', [lead.customer_id])).rows[0];
  const digits = last10(customer?.mobile);
  if (digits.length !== 10) return;
  await sendMessage(digits, (customer.full_name || '').split(' ')[0] || 'there');
  await pool.query('UPDATE leads SET qualification_sent_at = now() WHERE id = $1', [lead.id]);
}

// Called from the inbound WhatsApp webhook when the reply is one of this
// flow's own button ids (lq_buy / lq_rent / lq_sell) - returns false for any
// other button so the caller falls through to its own handling.
async function handleReply(phoneNumber, buttonId) {
  const purpose = BUTTON_PURPOSE[buttonId];
  if (!purpose) return false;
  const digits = last10(phoneNumber);
  if (digits.length !== 10) return false;
  const lead = (
    await pool.query(
      `SELECT l.* FROM leads l JOIN customers c ON c.id = l.customer_id
       WHERE right(regexp_replace(c.mobile, '\\D', '', 'g'), 10) = $1
         AND l.qualification_sent_at IS NOT NULL AND l.qualification_answered_at IS NULL
       ORDER BY l.qualification_sent_at DESC LIMIT 1`,
      [digits]
    )
  ).rows[0];
  if (!lead) return false;
  await pool.query('UPDATE leads SET qualification_answered_at = now(), qualification_purpose = $2 WHERE id = $1', [lead.id, purpose]);
  const customer = (await pool.query('SELECT full_name FROM customers WHERE id = $1', [lead.customer_id])).rows[0];
  for (const userId of new Set([lead.arb_rep_id, lead.assigned_to].filter(Boolean))) {
    await notificationService.createNotification({
      userId,
      type: 'lead_qualified_summary',
      title: `Lead qualified: ${purpose}`,
      message: `${customer?.full_name || 'The lead'} confirmed they want to ${purpose}.`,
      relatedEntityType: 'lead',
      relatedEntityId: lead.id,
      whatsappContent: { vars: [customer?.full_name || 'The lead', purpose], buttonUrl: lead.id },
    }).catch(() => {});
  }
  return true;
}

// Hourly: nudge once with the same template, then - if still unanswered -
// escalate to a Telecaller (designation 'tc') in the lead's own region,
// falling back to admins when none covers it.
async function sweep() {
  const cfg = await settings();
  const toRemind = (
    await pool.query(
      `UPDATE leads SET qualification_reminded_at = now()
       WHERE qualification_sent_at < now() - ($1 || ' hours')::interval
         AND qualification_answered_at IS NULL AND qualification_reminded_at IS NULL
       RETURNING id, customer_id`,
      [cfg.reminderHours]
    )
  ).rows;
  for (const lead of toRemind) {
    const customer = (await pool.query('SELECT full_name, mobile FROM customers WHERE id = $1', [lead.customer_id])).rows[0];
    const digits = last10(customer?.mobile);
    if (digits.length === 10) {
      await sendMessage(digits, (customer.full_name || '').split(' ')[0] || 'there').catch((err) => console.error('[lead qualification] reminder failed:', err.message));
    }
  }

  const toEscalate = (
    await pool.query(
      `UPDATE leads SET qualification_escalated_at = now()
       WHERE qualification_reminded_at < now() - ($1 || ' hours')::interval
         AND qualification_answered_at IS NULL AND qualification_escalated_at IS NULL
       RETURNING id, customer_id`,
      [cfg.escalateHours]
    )
  ).rows;
  for (const lead of toEscalate) {
    const customer = (await pool.query('SELECT full_name FROM customers WHERE id = $1', [lead.customer_id])).rows[0];
    const assignment = require('./assignment.service');
    const ctx = await assignment.leadContext(lead.id).catch(() => null);
    const tcId = ctx ? await assignment.leastBusy(['tc'], ctx, []).catch(() => null) : null;
    const admins = tcId ? [] : (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active' LIMIT 3`)).rows.map((r) => r.id);
    for (const userId of [tcId, ...admins].filter(Boolean)) {
      await notificationService.createNotification({
        userId,
        type: 'lead_tc_escalation',
        title: 'Lead needs a callback - no WhatsApp response',
        message: `${customer?.full_name || 'A lead'} hasn't responded to the WhatsApp qualification message. Please call.`,
        relatedEntityType: 'lead',
        relatedEntityId: lead.id,
        whatsappContent: { vars: [customer?.full_name || 'A lead', lead.id] },
      }).catch(() => {});
    }
  }
  return { reminded: toRemind.length, escalated: toEscalate.length };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((err) => console.error('[lead qualification] sweep failed:', err.message)), 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = { sendQualification, handleReply, sweep, startScheduler };
