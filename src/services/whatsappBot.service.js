const pool = require('../config/db');
const metaWhatsappService = require('./metaWhatsapp.service');
const whatsappService = require('./whatsapp.service');

// Meta's Cloud API has no bot builder of its own - it only sends/receives
// messages. This is the question-by-question flow that used to live in
// MSG91's no-code bot, now driven by hand from whatsapp_bot_sessions.
const QUESTIONS = [
  {
    key: 'requirement',
    type: 'buttons',
    body: "Hi! Welcome to PropertySerch 👋\nWhat are you looking for?\n\nYou can also type your requirement, or your property details with photos, in one message.",
    options: [
      { id: 'buy', title: 'Buy Property' },
      { id: 'rent', title: 'Rent Property' },
      { id: 'invest', title: 'Investment' },
    ],
  },
  {
    key: 'location',
    type: 'text',
    body: "Great! What's your preferred location?",
  },
  {
    key: 'budget',
    type: 'list',
    body: "What's your budget?",
    buttonText: 'Select budget',
    options: [
      { id: 'under_50l', title: 'Under 50L' },
      { id: '50l_1cr', title: '50L - 1Cr' },
      { id: '1cr_2cr', title: '1Cr - 2Cr' },
      { id: '2cr_plus', title: '2Cr+' },
    ],
  },
  {
    key: 'propertyType',
    type: 'list',
    body: "What type of property?",
    buttonText: 'Select type',
    options: [
      { id: '1bhk', title: '1 BHK' },
      { id: '2bhk', title: '2 BHK' },
      { id: '3bhk', title: '3 BHK' },
      { id: 'villa', title: 'Villa' },
      { id: 'plot', title: 'Plot' },
      { id: 'commercial', title: 'Commercial' },
    ],
  },
  {
    key: 'name',
    type: 'text',
    body: "Almost done! What's your name?",
  },
];

// `contact` is { phoneNumber, waUserId } - phone wins when known, else the
// BSUID (always present) is used as the Graph API `recipient`.
function contactParams({ phoneNumber, waUserId }) {
  return phoneNumber ? { to: phoneNumber } : { recipient: waUserId };
}

async function sendQuestion(contact, question) {
  if (question.type === 'buttons') {
    return metaWhatsappService.sendInteractiveButtons({ ...contactParams(contact), body: question.body, buttons: question.options });
  }
  if (question.type === 'list') {
    return metaWhatsappService.sendInteractiveList({
      ...contactParams(contact),
      body: question.body,
      buttonText: question.buttonText,
      options: question.options,
    });
  }
  return metaWhatsappService.sendText({ ...contactParams(contact), body: question.body });
}

// Sessions are keyed on the WhatsApp BSUID, not phone - Meta guarantees the
// BSUID on every message but omits the phone number whenever the customer
// has hidden it behind a WhatsApp username. `phoneNumber` is carried as
// optional enrichment and backfilled onto the session if it becomes known
// mid-conversation (the customer can toggle number visibility).
async function getOrCreateSession({ phoneNumber, waUserId }) {
  const inserted = await pool.query(
    `INSERT INTO whatsapp_bot_sessions (phone_number, wa_user_id, current_step, answers, status)
     VALUES ($1, $2, $3, '{}'::jsonb, 'in_progress')
     ON CONFLICT (wa_user_id) DO NOTHING
     RETURNING *`,
    [phoneNumber, waUserId, QUESTIONS[0].key]
  );
  if (inserted.rows.length > 0) return { session: inserted.rows[0], isFresh: true };

  const existing = await pool.query('SELECT * FROM whatsapp_bot_sessions WHERE wa_user_id = $1', [waUserId]);
  let session = existing.rows[0];

  if (phoneNumber && !session.phone_number) {
    const backfilled = await pool.query(
      'UPDATE whatsapp_bot_sessions SET phone_number = $1 WHERE wa_user_id = $2 RETURNING *',
      [phoneNumber, waUserId]
    );
    session = backfilled.rows[0];
  }

  if (session.status === 'completed') {
    const reset = await pool.query(
      `UPDATE whatsapp_bot_sessions SET current_step = $1, answers = '{}'::jsonb, status = 'in_progress'
       WHERE wa_user_id = $2 RETURNING *`,
      [QUESTIONS[0].key, waUserId]
    );
    return { session: reset.rows[0], isFresh: true };
  }

  return { session, isFresh: false };
}

const intake = () => require('./messaging/chatIntake.service');

// Free text and photos go to the shared chat intake (intent detection,
// requirement leads, property posting) when the customer is not mid-way
// through the question flow - or sends a photo, or types a long message where
// the flow expected a button. Null when the question flow should answer.
async function tryIntake({ phoneNumber, waUserId, text, mediaId, messageId, profileName }) {
  if (!text && !mediaId) return null;
  const existing = (await pool.query('SELECT current_step, status FROM whatsapp_bot_sessions WHERE wa_user_id = $1', [waUserId])).rows[0];
  const active = existing?.status === 'in_progress';
  const step = active ? QUESTIONS.find((q) => q.key === existing.current_step) : null;
  const free = !active || mediaId || (step && step.type !== 'text' && String(text || '').trim().length >= 25);
  if (!free) return null;
  const photos = [];
  if (mediaId) {
    const photo = await metaWhatsappService.downloadMedia(mediaId).catch((err) => {
      console.error('[whatsapp] photo download failed:', err.message);
      return null;
    });
    if (photo) photos.push(photo);
    else if (!text) return { handled: true, ignored: 'photo' };
  }
  const contact = { channel: 'whatsapp', phone: phoneNumber ? whatsappService.toLocalMobile(phoneNumber) : null, waUserId, name: profileName || null, messageId };
  const r = await intake().handleMessage(contact, { text: text || '', photos });
  if (!r.handled) return null;
  if (existing) await pool.query(`UPDATE whatsapp_bot_sessions SET status = 'completed' WHERE wa_user_id = $1`, [waUserId]);
  return r;
}

// Called once per inbound WhatsApp message (from the webhook controller,
// after whatsapp.service.js has logged/parsed it). Advances that contact's
// question flow by exactly one step, or - once every question is answered -
// hands the collected answers to whatsapp.service.js's captureLead() and
// sends a closing message. `waUserId` (the BSUID) is required - Meta always
// provides it; `phoneNumber` may be null when the customer's number is hidden.
async function handleInboundMessage({ phoneNumber, waUserId, text, buttonReplyId, buttonReplyTitle, mediaId = null, messageId = null, profileName = null }) {
  if (!waUserId) throw new Error('waUserId is required to run the WhatsApp bot flow');
  if (!buttonReplyId) {
    const taken = await tryIntake({ phoneNumber, waUserId, text, mediaId, messageId, profileName });
    if (taken) return { phoneNumber, waUserId, intake: taken };
  }
  const contact = { phoneNumber, waUserId };
  const { session, isFresh } = await getOrCreateSession(contact);

  if (isFresh) {
    await sendQuestion(contact, QUESTIONS[0]);
    return { phoneNumber, waUserId, step: QUESTIONS[0].key, completed: false };
  }

  // The session may have picked up a phone number since it started
  // (backfilled in getOrCreateSession) - prefer it for sending from here on.
  const liveContact = { phoneNumber: phoneNumber || session.phone_number, waUserId };

  const currentIndex = QUESTIONS.findIndex((q) => q.key === session.current_step);
  const current = QUESTIONS[currentIndex];
  const answerValue = buttonReplyTitle || buttonReplyId || text || '';
  const answers = { ...session.answers, [current.key]: answerValue };

  const next = QUESTIONS[currentIndex + 1];
  if (next) {
    await pool.query('UPDATE whatsapp_bot_sessions SET current_step = $1, answers = $2::jsonb WHERE wa_user_id = $3', [
      next.key,
      JSON.stringify(answers),
      waUserId,
    ]);
    await sendQuestion(liveContact, next);
    return { phoneNumber: liveContact.phoneNumber, waUserId, step: next.key, completed: false };
  }

  await pool.query(`UPDATE whatsapp_bot_sessions SET answers = $1::jsonb, status = 'completed' WHERE wa_user_id = $2`, [
    JSON.stringify(answers),
    waUserId,
  ]);

  const result = await whatsappService.captureLead({
    phone: liveContact.phoneNumber,
    waUserId,
    name: answers.name,
    requirement: answers.requirement,
    location: answers.location,
    budget: answers.budget,
    propertyType: answers.propertyType,
  });

  await metaWhatsappService.sendText({
    ...contactParams(liveContact),
    body: `Thanks${answers.name ? ` ${answers.name}` : ''}! We've got your requirement and our team will reach out to you shortly.`,
  });

  return { phoneNumber: liveContact.phoneNumber, waUserId, completed: true, ...result };
}

module.exports = { handleInboundMessage, QUESTIONS };
