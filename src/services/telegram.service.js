const pool = require('../config/db');
const ingestion = require('./ingestion/ingestion.service');
const N = require('./ingestion/normalisers');
const { badRequest, forbidden } = require('../utils/httpError');

// Sec. 25.5.3 - Telegram runs as a second, fully parallel entry channel next
// to WhatsApp (outside Meta's infrastructure). Same question flow, same
// ingestion pipeline (dedupe, source tag, assignment cascade):
//   /start            -> buyer requirement      (Telegram-Requirement)
//   /start p_<uuid>   -> listing inquiry        (Telegram-Listing-Inquiry)
//                        (smart link t.me/<bot>?start=p_<listing id>)
// Bot token / webhook secret / username come from the environment
// (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME).

const REQUIREMENT_STEPS = [
  { key: 'purpose', text: 'Hi! Welcome to PropertySerch. What are you looking for?', options: [['buy', 'Buy property'], ['rent', 'Rent property'], ['invest', 'Investment']] },
  { key: 'location', text: 'Which city and area are you looking in?' },
  { key: 'budget', text: "What's your budget?", options: [['under 50 lakh', 'Under 50L'], ['50 lakh - 1 cr', '50L - 1Cr'], ['1 cr - 2 cr', '1Cr - 2Cr'], ['2 cr - 5 cr', '2Cr+']] },
  { key: 'propertyType', text: 'What type of property?', options: [['apartment', 'Apartment / flat'], ['independent house', 'House / floor'], ['villa', 'Villa'], ['plot', 'Plot'], ['commercial', 'Commercial']] },
  { key: 'name', text: "Almost done - what's your name?" },
  { key: 'phone', text: 'Please share your mobile number so your A R Buildwel representative can call you.', contact: true },
];
const LISTING_STEPS = [
  { key: 'name', text: 'Thanks for your interest in this property. What is your name?' },
  { key: 'phone', text: 'Please share your mobile number so your A R Buildwel representative can call you.', contact: true },
];

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

async function api(method, payload) {
  if (!token()) return null; // not configured - flow still records the lead
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error(`[telegram] ${method} failed:`, json.description || res.status);
  return json;
}

function ask(chatId, step) {
  let reply_markup;
  if (step.options) reply_markup = { inline_keyboard: step.options.map(([value, label]) => [{ text: label, callback_data: `${step.key}:${value}` }]) };
  if (step.contact) reply_markup = { keyboard: [[{ text: 'Share my number', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true };
  return api('sendMessage', { chat_id: chatId, text: step.text, ...(reply_markup ? { reply_markup } : {}) });
}

function verifySecret(headers) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) throw forbidden('Telegram webhook secret not configured');
  if (headers['x-telegram-bot-api-secret-token'] !== expected) throw forbidden('Invalid Telegram secret');
}

async function session(chatId) {
  return (await pool.query('SELECT * FROM telegram_bot_sessions WHERE chat_id = $1', [chatId])).rows[0] || null;
}

async function start(chatId, payload) {
  let propertyId = null;
  const m = String(payload || '').match(/^p_([0-9a-f-]{36})$/i);
  if (m) propertyId = (await pool.query(`SELECT id FROM properties WHERE id = $1 AND status = 'approved'`, [m[1]])).rows[0]?.id || null;
  const steps = propertyId ? LISTING_STEPS : REQUIREMENT_STEPS;
  await pool.query(
    `INSERT INTO telegram_bot_sessions (chat_id, current_step, answers, property_id, status, updated_at) VALUES ($1, $2, '{}'::jsonb, $3, 'in_progress', now())
     ON CONFLICT (chat_id) DO UPDATE SET current_step = EXCLUDED.current_step, answers = '{}'::jsonb, property_id = EXCLUDED.property_id, status = 'in_progress', updated_at = now()`,
    [chatId, steps[0].key, propertyId]
  );
  if (propertyId) {
    const p = (await pool.query('SELECT title, locality, city FROM properties WHERE id = $1', [propertyId])).rows[0];
    await api('sendMessage', { chat_id: chatId, text: `Property: ${p.title}${p.locality ? `, ${p.locality}` : ''}${p.city ? `, ${p.city}` : ''}` });
  }
  await ask(chatId, steps[0]);
  return { chatId, step: steps[0].key, listing: Boolean(propertyId) };
}

async function finish(chatId, s, answers) {
  await pool.query(`UPDATE telegram_bot_sessions SET answers = $2, status = 'completed', updated_at = now() WHERE chat_id = $1`, [chatId, JSON.stringify(answers)]);
  const listing = Boolean(s.property_id);
  const source = await ingestion.getSource(listing ? 'telegram_listing' : 'telegram_requirement');
  const [city, ...rest] = String(answers.location || '').split(',').map((x) => x.trim()).filter(Boolean).reverse();
  const parsed = {
    externalId: `tg-${chatId}-${Date.now()}`,
    name: answers.name || null,
    phone: N.cleanPhone(answers.phone),
    email: null,
    city: listing ? null : city || null,
    locality: listing ? null : rest.reverse().join(', ') || null,
    budget: N.parseBudget(answers.budget),
    propertyType: N.mapPropertyType(answers.propertyType),
    purpose: answers.purpose === 'rent' ? 'rent' : listing ? null : 'buy',
    message: listing ? 'Telegram listing enquiry' : `Telegram requirement: ${[answers.purpose, answers.location, answers.budget, answers.propertyType].filter(Boolean).join(' | ')}`,
    propertyId: s.property_id || null,
  };
  const tenantId = process.env.TELEGRAM_DEFAULT_TENANT_ID || null;
  const result = await ingestion.ingest({ source, tenantId, method: 'bot', mode: 'push', raw: { chat_id: chatId, answers, property_id: s.property_id }, parsed });
  let repLine = 'Your A R Buildwel representative will call you shortly.';
  if (result.leadId) {
    const rep = (await pool.query(`SELECT arb_rep_id FROM leads WHERE id = $1`, [result.leadId])).rows[0]?.arb_rep_id;
    const card = rep ? await require('./assignment.service').repCard(rep) : null;
    if (card) repLine = `Your A R Buildwel representative ${card.name}${card.platformNumber ? ` (${card.platformNumber})` : ''} will call you shortly.`;
  }
  await api('sendMessage', { chat_id: chatId, text: `Thank you${answers.name ? `, ${answers.name}` : ''}! ${repLine}`, reply_markup: { remove_keyboard: true } });
  return { chatId, completed: true, ...result };
}

// One Telegram update (message or button press).
async function handleUpdate(update) {
  const msg = update.message;
  const cb = update.callback_query;
  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chatId) return { ignored: true };
  if (cb) await api('answerCallbackQuery', { callback_query_id: cb.id });
  const text = msg?.text?.trim();
  if (text && /^\/start\b/.test(text)) return start(chatId, text.split(/\s+/)[1]);

  const s = await session(chatId);
  if (!s || s.status !== 'in_progress') return start(chatId, null);
  const steps = s.property_id ? LISTING_STEPS : REQUIREMENT_STEPS;
  const idx = steps.findIndex((x) => x.key === s.current_step);
  const step = steps[idx];
  let value = null;
  if (cb?.data && cb.data.startsWith(`${step.key}:`)) value = cb.data.slice(step.key.length + 1);
  else if (step.contact && msg?.contact?.phone_number) value = msg.contact.phone_number;
  else if (text) value = text;
  if (value === null) {
    await ask(chatId, step);
    return { chatId, step: step.key, waiting: true };
  }
  if (step.key === 'phone' && !N.cleanPhone(value)) {
    await api('sendMessage', { chat_id: chatId, text: 'That does not look like a 10-digit Indian mobile number - please try again.' });
    return { chatId, step: step.key, invalid: true };
  }
  const answers = { ...s.answers, [step.key]: value };
  const next = steps[idx + 1];
  if (!next) return finish(chatId, s, answers);
  await pool.query(`UPDATE telegram_bot_sessions SET current_step = $2, answers = $3, updated_at = now() WHERE chat_id = $1`, [chatId, next.key, JSON.stringify(answers)]);
  await ask(chatId, next);
  return { chatId, step: next.key };
}

// Admin: point Telegram at our webhook (with the secret header).
async function registerWebhook(publicBaseUrl) {
  if (!token()) throw badRequest('Set TELEGRAM_BOT_TOKEN first');
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) throw badRequest('Set TELEGRAM_WEBHOOK_SECRET first');
  const res = await api('setWebhook', {
    url: `${String(publicBaseUrl).replace(/\/$/, '')}/api/telegram/webhook`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  return { ok: Boolean(res?.ok), description: res?.description || null };
}

function listingLink(propertyId) {
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  return bot ? `https://t.me/${bot}?start=p_${propertyId}` : null;
}

module.exports = { handleUpdate, verifySecret, registerWebhook, listingLink, REQUIREMENT_STEPS, LISTING_STEPS };
