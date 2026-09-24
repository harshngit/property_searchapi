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
    body: "Hi! Welcome to PropertySerch 👋\nWhat are you looking for?",
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

async function sendQuestion(phoneNumber, question) {
  if (question.type === 'buttons') {
    return metaWhatsappService.sendInteractiveButtons({ to: phoneNumber, body: question.body, buttons: question.options });
  }
  if (question.type === 'list') {
    return metaWhatsappService.sendInteractiveList({
      to: phoneNumber,
      body: question.body,
      buttonText: question.buttonText,
      options: question.options,
    });
  }
  return metaWhatsappService.sendText({ to: phoneNumber, body: question.body });
}

async function getOrCreateSession(phoneNumber) {
  const inserted = await pool.query(
    `INSERT INTO whatsapp_bot_sessions (phone_number, current_step, answers, status)
     VALUES ($1, $2, '{}'::jsonb, 'in_progress')
     ON CONFLICT (phone_number) DO NOTHING
     RETURNING *`,
    [phoneNumber, QUESTIONS[0].key]
  );
  if (inserted.rows.length > 0) return { session: inserted.rows[0], isFresh: true };

  const existing = await pool.query('SELECT * FROM whatsapp_bot_sessions WHERE phone_number = $1', [phoneNumber]);
  const session = existing.rows[0];

  if (session.status === 'completed') {
    const reset = await pool.query(
      `UPDATE whatsapp_bot_sessions SET current_step = $1, answers = '{}'::jsonb, status = 'in_progress'
       WHERE phone_number = $2 RETURNING *`,
      [QUESTIONS[0].key, phoneNumber]
    );
    return { session: reset.rows[0], isFresh: true };
  }

  return { session, isFresh: false };
}

// Called once per inbound WhatsApp message (from the webhook controller,
// after whatsapp.service.js has logged/parsed it). Advances that phone
// number's question flow by exactly one step, or - once every question is
// answered - hands the collected answers to whatsapp.service.js's
// captureLead() (same lead-creation logic the MSG91 build used) and sends a
// closing message.
async function handleInboundMessage({ phoneNumber, text, buttonReplyId, buttonReplyTitle }) {
  const { session, isFresh } = await getOrCreateSession(phoneNumber);

  if (isFresh) {
    await sendQuestion(phoneNumber, QUESTIONS[0]);
    return { phoneNumber, step: QUESTIONS[0].key, completed: false };
  }

  const currentIndex = QUESTIONS.findIndex((q) => q.key === session.current_step);
  const current = QUESTIONS[currentIndex];
  const answerValue = buttonReplyTitle || buttonReplyId || text || '';
  const answers = { ...session.answers, [current.key]: answerValue };

  const next = QUESTIONS[currentIndex + 1];
  if (next) {
    await pool.query('UPDATE whatsapp_bot_sessions SET current_step = $1, answers = $2::jsonb WHERE phone_number = $3', [
      next.key,
      JSON.stringify(answers),
      phoneNumber,
    ]);
    await sendQuestion(phoneNumber, next);
    return { phoneNumber, step: next.key, completed: false };
  }

  await pool.query(`UPDATE whatsapp_bot_sessions SET answers = $1::jsonb, status = 'completed' WHERE phone_number = $2`, [
    JSON.stringify(answers),
    phoneNumber,
  ]);

  const result = await whatsappService.captureLead({
    phone: phoneNumber,
    name: answers.name,
    requirement: answers.requirement,
    location: answers.location,
    budget: answers.budget,
    propertyType: answers.propertyType,
  });

  await metaWhatsappService.sendText({
    to: phoneNumber,
    body: `Thanks${answers.name ? ` ${answers.name}` : ''}! We've got your requirement and our team will reach out to you shortly.`,
  });

  return { phoneNumber, completed: true, ...result };
}

module.exports = { handleInboundMessage, QUESTIONS };
