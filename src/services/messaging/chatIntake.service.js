const pool = require('../../config/db');
const configService = require('../config.service');
const auditService = require('../audit.service');
const notificationService = require('../notification.service');
const customerService = require('../customer.service');
const N = require('../ingestion/normalisers');
const { uploadBuffer, getReadUrl } = require('../../utils/storage');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');

// Engine 1 - the shared channel adapter for free-text posts on WhatsApp and
// Telegram. One message (text and/or photos) is read the same way on both:
//
//   1. Intent: buy / rent (a requirement), sell / rent out (a listing),
//      institutional sale / purchase - rules only (no AI cost: the poster has
//      no wallet to pay for it). Unclear messages go to the bots' questions.
//   2. Fields: type, BHK, area, price / budget, city, locality, name, phone.
//   3. Route: a requirement becomes a lead through the ingestion pipeline
//      (WhatsApp-Requirement / Telegram-Requirement source tags); a listing
//      becomes a submission that staff approve before anything is published
//      (duplicate check on arrival); an institutional sale is approved into
//      the institutional desk (Engine 7).
//
// Greetings and one-word answers are left to the bots' question flows.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const CHANNEL_NAME = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
const LISTING_INTENTS = ['sell', 'rent_out', 'institutional_sale'];
const REQUIREMENT_INTENTS = ['buy', 'rent', 'institutional_buy'];

const isStaff = (user) => STAFF.includes(user?.role);
const ingestion = () => require('../ingestion/ingestion.service');

// ------------------------------------------------------------- reading

const GREETING = /^(hi+|hello+|hey+|hii+|namaste|namaskar|start|menu|help|ok|okay|thanks?|thank you|yes|no)\W*$/i;
const INSTITUTION = '(school|college|universit(?:y|ies)|institute|coaching (?:centre|center|institute)|hospital|nursing home|hotel|resort|campus|tech park|senior living)';
const INSTITUTION_DEAL = new RegExp(`\\b(sell|sale|selling|bechna|lease|buy|purchase|acquire|takeover|stake)\\b.{0,50}\\b${INSTITUTION}\\b|\\b${INSTITUTION}\\b.{0,50}\\b(for sale|on sale|sell|selling|on lease|for lease|bechna|to buy|wanted)\\b`, 'i');
const RENT_OUT = /(to[- ]let\b|\brent(ing)? out\b|\blease out\b|kiraye? (pe|par) (dena|deni|dene)|\btenants? (chahiye|wanted|required|needed)\b|looking for (a )?tenants?\b|available (for|on) rent|for rent available)/i;
const SELL = /\b(sell|selling|for sale|on sale|resale|bechna|bechni|bechne|sale karna|looking for (a )?buyers?|owner selling)\b/i;
const BUY = /\b(buy|buying|purchase|kharidna|kharidni|kharid)\b/i;
const SEEK = /\b(looking for|look for|need|needed|want|wanted|require|required|requirement|searching|chahiye|interested in)\b/i;
const RENTISH = /\b(rent|rental|kiraye?|kiraya|pg|lease)\b/i;
const PHONE_RE = /(?:\+?91[\s-]?|\b0)?\b([6-9]\d{4}[\s-]?\d{5})\b/;

// Rule-based intent with a 0-100 strength.
function detectIntent(text) {
  const t = String(text || '').trim();
  if (!t || GREETING.test(t)) return { intent: 'greeting', strength: 0 };
  const institutional = INSTITUTION_DEAL.test(t);
  let intent = 'other';
  let strength = 0;
  if (RENT_OUT.test(t)) [intent, strength] = ['rent_out', 60];
  else if (SELL.test(t) && !BUY.test(t)) [intent, strength] = ['sell', 60];
  else if (BUY.test(t)) [intent, strength] = ['buy', 60];
  else if (SEEK.test(t) && RENTISH.test(t)) [intent, strength] = ['rent', 60];
  else if (SEEK.test(t)) [intent, strength] = ['buy', 45];
  else if (/\b(for rent|on rent)\b/i.test(t)) [intent, strength] = ['rent_out', 45];
  if (institutional) {
    if (['sell', 'rent_out'].includes(intent)) intent = 'institutional_sale';
    else if (['buy', 'rent'].includes(intent)) intent = 'institutional_buy';
  }
  return { intent, strength };
}

let cityCache = { at: 0, rows: [] };
const CITY_ALIASES = { gurgaon: 'gurugram', bangalore: 'bengaluru', bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai', 'new delhi': 'delhi', poona: 'pune' };
async function cities() {
  if (Date.now() - cityCache.at < 10 * 60 * 1000) return cityCache.rows;
  const rows = (await pool.query('SELECT city_name FROM cities')).rows.map((r) => r.city_name);
  cityCache = { at: Date.now(), rows };
  return rows;
}

// A locality of the city named in the message (longest name first, so
// "Laxmi Nagar" wins over "Nagar").
async function knownLocality(city, lower) {
  const rows = (
    await pool.query(
      `SELECT l.locality_name FROM localities l JOIN cities c ON c.id = l.city_id
       WHERE c.city_name ILIKE $1 AND l.is_active GROUP BY l.locality_name ORDER BY length(l.locality_name) DESC LIMIT 2000`,
      [city]
    )
  ).rows;
  const hit = rows.find((r) => r.locality_name.length >= 4 && new RegExp(`\\b${escapeRe(r.locality_name.toLowerCase())}\\b`).test(lower));
  return hit ? hit.locality_name : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const amount = (n) => (n >= 1e7 ? `${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `${+(n / 1e5).toFixed(2)} Lakh` : `${Math.round(n).toLocaleString('en-IN')}`);
const TYPE_LABEL = { apartment: 'Apartment', villa: 'Villa', independent_house: 'Independent house', plot: 'Plot', commercial: 'Commercial space', farmhouse: 'Farmhouse' };

async function parseFields(text, intent) {
  const t = String(text || '');
  const out = {};
  const bhk = t.match(/\b(\d)\s*(bhk|bed\s?rooms?|bedroom|rk)\b/i);
  if (bhk) out.bedrooms = Number(bhk[1]);
  const area = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(sq\.?\s*ft|sqft|sft|square\s*f(?:ee|oo)t|sq\.?\s*yds?|sq\.?\s*yards?|gaj|yards?|acres?)\b/i);
  if (area) {
    const n = Number(area[1].replace(/,/g, ''));
    const unit = area[2].toLowerCase();
    out.areaSqft = Math.round(/acre/.test(unit) ? n * 43560 : /yd|yard|gaj/.test(unit) ? n * 9 : n);
  }
  // Rent per month ("25k/month", "rent 25,000"), else a price / budget ("1.2 Cr", "80 lakh").
  const monthly = t.match(/(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?\s*(?:k|thousand)?)\s*(?:\/|per|a)\s*(?:month|mon|mo|m)\b/i) || t.match(/\brent\s*(?:is|of|:|-)?\s*(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?\s*(?:k|thousand)?)\b/i);
  const priceMatch = t.match(/(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?\s*(?:cr|crore|crores|lakh|lakhs|lac|lacs|l)\b(?:\s*(?:-|to)\s*\d+(?:\.\d+)?\s*(?:cr|crore|crores|lakh|lakhs|lac|lacs|l)\b)?)/i);
  const budget = t.match(/\b(?:budget|upto|up to|under|below|max(?:imum)?)\s*(?:of|is|:|-)?\s*(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|cr|crore|crores|lakh|lakhs|lac|lacs|l)?)\b/i);
  const priceText = monthly && ['rent', 'rent_out'].includes(intent) ? monthly[1] : priceMatch ? priceMatch[1] : budget ? budget[1] : monthly ? monthly[1] : null;
  const priceValue = priceText ? N.parseBudget(priceText) : null;
  if (priceValue) {
    out.priceValue = priceValue;
    out.price = amount(priceValue);
  }
  const type = N.mapPropertyType(t);
  if (type && type !== 'other') out.propertyType = type;
  else if (bhk) out.propertyType = 'apartment';
  const furnish = t.match(/\b(fully|semi|un)[\s-]?furnished\b/i);
  if (furnish) out.furnishing = { fully: 'furnished', semi: 'semi-furnished', un: 'unfurnished' }[furnish[1].toLowerCase()];
  else if (/\bfurnished\b/i.test(t)) out.furnishing = 'furnished';

  const lower = t.toLowerCase();
  const list = await cities();
  for (const name of list) {
    if (new RegExp(`\\b${escapeRe(name.toLowerCase())}\\b`).test(lower)) {
      out.city = name;
      break;
    }
  }
  if (!out.city) {
    for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
      if (new RegExp(`\\b${alias}\\b`).test(lower)) {
        out.city = list.find((c) => c.toLowerCase() === canonical) || canonical.replace(/\b\w/g, (c) => c.toUpperCase());
        break;
      }
    }
  }
  const sector = t.match(/\b(?:sector|sec)[\s.-]*(\d{1,3}[a-z]?)\b/i);
  if (sector) out.locality = `Sector ${sector[1].toUpperCase()}`;
  else if (out.city && (out.locality = await knownLocality(out.city, lower))) {
    // matched a locality of that city
  } else {
    const near = t.match(/\b(?:in|at|near)\s+([A-Z][\w.]*(?:\s+[A-Z][\w.]*){0,2})/);
    if (near && near[1].toLowerCase() !== (out.city || '').toLowerCase()) {
      const loc = near[1].replace(new RegExp(`\\s+${escapeRe(out.city || '#none#')}$`, 'i'), '').trim();
      if (loc && !/^(the|a|my)$/i.test(loc)) out.locality = loc;
    }
  }
  const phone = t.match(PHONE_RE);
  if (phone) out.phone = N.cleanPhone(phone[1]);
  const name = t.match(/\b(?:my name is|i am|i'm|this is|name\s*[:-])\s*([a-z][a-z.]*(?:\s+[a-z][a-z.]*){0,3}?)(?=\s*(?:[,.\n]|$|\band\b|\bfrom\b|\bhere\b|\bowner\b))/i);
  if (name && !/\b(looking|selling|interested|owner|broker)\b/i.test(name[1])) out.name = name[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
  return out;
}

function confidenceOf(strength, f) {
  if (!strength) return 0;
  let c = strength;
  if (f.priceValue) c += 10;
  if (f.city || f.locality) c += 15;
  if (f.propertyType || f.bedrooms) c += 10;
  if (f.areaSqft) c += 5;
  return Math.min(100, c);
}

// Reads one message: intent + fields, by rules.
async function read(text) {
  const rule = detectIntent(text);
  if (rule.intent === 'greeting') return { intent: 'greeting', fields: {}, method: 'none', confidence: 0 };
  const fields = await parseFields(text, rule.intent);
  return { intent: rule.intent, fields, method: rule.intent === 'other' ? 'none' : 'rules', confidence: confidenceOf(rule.strength, fields) };
}

// Listing text with contact details taken out (they are never shown on listings).
function cleanDescription(text) {
  return String(text || '')
    .replace(/\b(?:call|contact|whatsapp|ph(?:one)?|mob(?:ile)?|mo)\b\.?\s*(?:(?:me|us|on|at|no\.?|number|:|-)\s*)*(?:\+?91[\s-]?|\b0)?[6-9]\d{4}[\s-]?\d{5}\b\.?/gi, '')
    .replace(/(?:\+?91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, '')
    .replace(/\b(?:e-?mail|mail)\b\s*(?:(?:me|us|at|on|:|-)\s*)*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/\b(call|whatsapp|contact|text)\s+(me|us|karo|on|at)\b[^.\n]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/([,.])(?:\s*[,.])+/g, '$1')
    .replace(/^[\s,.]+|[\s,]+$/g, '')
    .trim()
    .slice(0, 2000);
}

function titleFor(intent, f) {
  const type = TYPE_LABEL[f.propertyType] || 'Property';
  const what = f.bedrooms && ['apartment', 'villa', 'independent_house', undefined].includes(f.propertyType) ? `${f.bedrooms} BHK ${f.propertyType ? type.toLowerCase() : 'home'}` : type;
  const where = [f.locality, f.city].filter(Boolean).join(', ');
  return `${what} for ${intent === 'rent_out' ? 'rent' : 'sale'}${where ? ` in ${where}` : ''}`.replace(/^./, (c) => c.toUpperCase()).slice(0, 200);
}

// ------------------------------------------------------------- replies

async function send(contact, text) {
  try {
    if (contact.channel === 'telegram') {
      if (contact.chatId) await require('../telegram.service').send(contact.chatId, text);
      return;
    }
    const whatsapp = require('../whatsapp.service');
    const to = contact.phone ? whatsapp.toInternationalMobile(contact.phone) : null;
    if (!to && !contact.waUserId) return;
    await require('../metaWhatsapp.service').sendText({ ...(to ? { to } : { recipient: contact.waUserId }), body: text });
  } catch (err) {
    console.error(`[chat-intake] reply on ${contact.channel} failed:`, err.message);
  }
}

// ------------------------------------------------------------- listings

async function nextReference() {
  const n = (await pool.query(`SELECT nextval('chat_listing_seq') AS n`)).rows[0].n;
  return `CL-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;
}

// Possible duplicates of live / pending listings (Sec. 9 runs again in full on approval).
async function findDuplicates(f, text) {
  if (!f.city) return [];
  const rows = (
    await pool.query(
      `SELECT id, title, description, property_type, transaction_type, bedrooms, price_value, locality
       FROM properties WHERE status IN ('approved', 'pending_approval') AND city ILIKE $1
       ORDER BY created_at DESC LIMIT 500`,
      [f.city]
    )
  ).rows;
  const { textSimilarity } = require('../fraud.service');
  const out = [];
  for (const p of rows) {
    const reasons = [];
    let similarity = 0;
    const sameUnit =
      (!f.propertyType || p.property_type === f.propertyType) &&
      (!f.bedrooms || !p.bedrooms || Number(p.bedrooms) === f.bedrooms) &&
      p.transaction_type === f.transactionType;
    const sameArea = f.locality && p.locality && p.locality.toLowerCase() === f.locality.toLowerCase();
    const a = Number(f.priceValue);
    const b = Number(p.price_value);
    if (sameUnit && sameArea && a && b && Math.abs(a - b) / b <= 0.1) {
      reasons.push('Same type, locality and a price within 10%');
      similarity = Math.round((1 - Math.abs(a - b) / b) * 100);
    } else if (sameUnit && sameArea && (!a || !b) && (f.propertyType || f.bedrooms)) {
      reasons.push('Same type and locality (no price to compare yet)');
      similarity = 70;
    }
    const ts = textSimilarity(text, `${p.title} ${p.description || ''}`);
    if (ts >= 0.85) {
      reasons.push(`Text ${Math.round(ts * 100)}% similar`);
      similarity = Math.max(similarity, Math.round(ts * 100));
    }
    if (reasons.length) out.push({ propertyId: p.id, title: p.title, reason: reasons.join('; '), similarity });
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, 5);
}

// Stores photos, dropping any that show contact details (Sec. 11.2).
async function storePhotos(photos) {
  const kept = [];
  let rejected = 0;
  for (const p of photos || []) {
    if (!p?.buffer) continue;
    try {
      await require('../fraud.service').screenUpload(p.buffer);
    } catch (err) {
      if (err.statusCode === 422) {
        rejected += 1;
        continue;
      }
    }
    try {
      kept.push({ path: await uploadBuffer(p.buffer, 'chat-intake', p.filename || 'photo.jpg', p.mimetype || 'image/jpeg'), mimetype: p.mimetype || 'image/jpeg' });
    } catch (err) {
      // No storage bucket (local development): keep the count, not the file.
      if (process.env.NODE_ENV === 'production') throw err;
      kept.push({ path: null, mimetype: p.mimetype || 'image/jpeg' });
    }
  }
  return { kept, rejected };
}

async function notifyStaff(sub) {
  const users = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
  const title = sub.intent === 'institutional_sale' ? 'Institutional sale posted on chat' : `Listing posted on ${CHANNEL_NAME[sub.channel]}`;
  for (const u of users.rows) {
    await notificationService
      .createNotification({ userId: u.id, type: 'chat_listing', title, message: `${sub.reference}: ${sub.parsed.title || 'New listing'} - review it before it goes live.`, relatedEntityType: 'chat_listing', relatedEntityId: sub.id })
      .catch(() => {});
  }
}

const whereContact = (c) =>
  c.channel === 'telegram' ? ['telegram_chat_id = $1', c.chatId] : c.waUserId ? ['wa_user_id = $1', c.waUserId] : ['contact_phone = $1', c.phone];

async function latestOpenSubmission(contact) {
  const minutes = Number(await configService.getConfig('chat_intake.photo_window_minutes', 60)) || 60;
  const [cond, value] = whereContact(contact);
  if (value == null) return null;
  return (
    await pool.query(
      `SELECT * FROM chat_listing_submissions WHERE channel = $2 AND ${cond} AND status = 'pending_review'
         AND created_at > now() - make_interval(mins => $3) ORDER BY created_at DESC LIMIT 1`,
      [value, contact.channel, minutes]
    )
  ).rows[0] || null;
}

async function createSubmission(contact, { intent, fields, method, confidence }, text, photos) {
  const parsed = {
    ...fields,
    transactionType: intent === 'rent_out' ? 'rent' : 'sell',
    description: cleanDescription(text),
  };
  parsed.title = titleFor(intent, parsed);
  delete parsed.phone;
  const phone = contact.phone || fields.phone || null;
  const name = contact.name || fields.name || null;
  let customerId = null;
  if (phone || contact.waUserId) {
    const customer = await customerService
      .findOrCreateCustomerByContact({ fullName: name || `${CHANNEL_NAME[contact.channel]} ${phone || contact.waUserId}`, mobile: phone, waUserId: contact.waUserId || undefined })
      .catch(() => null);
    customerId = customer?.id || null;
  }
  const duplicates = intent === 'institutional_sale' ? [] : await findDuplicates(parsed, text);
  const { kept, rejected } = await storePhotos(photos);
  const tenantId = (contact.channel === 'telegram' ? process.env.TELEGRAM_DEFAULT_TENANT_ID : process.env.WHATSAPP_DEFAULT_TENANT_ID) || null;
  const sub = (
    await pool.query(
      `INSERT INTO chat_listing_submissions (reference, tenant_id, channel, contact_phone, wa_user_id, telegram_chat_id, contact_name, customer_id,
         intent, raw_text, parsed, parsed_by, confidence, photos, photos_rejected, duplicates)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        await nextReference(), tenantId, contact.channel, phone, contact.waUserId || null, contact.chatId || null, name, customerId,
        intent, String(text).slice(0, 5000), JSON.stringify(parsed), method === 'ai' ? 'ai' : 'rules', confidence,
        JSON.stringify(kept), rejected, JSON.stringify(duplicates),
      ]
    )
  ).rows[0];
  await notifyStaff(sub);
  return sub;
}

function listingReply(sub) {
  const p = sub.parsed;
  const read = [p.title, p.price && `Price: Rs ${p.price}${sub.intent === 'rent_out' ? ' a month' : ''}`, p.areaSqft && `Area: ${p.areaSqft} sq ft`].filter(Boolean).join('\n');
  const missing = [!p.priceValue && (sub.intent === 'rent_out' ? 'monthly rent' : 'price'), !p.city && 'city', !p.locality && 'locality / sector', !p.propertyType && !p.bedrooms && 'property type'].filter(Boolean);
  const photoLine = (sub.photos || []).length ? `${sub.photos.length} photo(s) received.` : 'Send photos of the property now (they are added to this listing).';
  const lead =
    sub.intent === 'institutional_sale'
      ? `Thank you. Your institutional sale enquiry (${sub.reference}) has gone to the A R Buildwel institutional desk. It is kept confidential and shared only with verified buyers under NDA.`
      : `Thank you. We have your property (${sub.reference}):\n${read}`;
  return [
    lead,
    missing.length && sub.intent !== 'institutional_sale' ? `Please also send: ${missing.join(', ')}.` : null,
    sub.intent === 'institutional_sale' ? null : photoLine,
    sub.intent === 'institutional_sale' ? null : 'Our team checks every listing before it goes live - we will message you once it is published.',
    sub.photos_rejected ? `${sub.photos_rejected} photo(s) were not added because they show contact details.` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function addPhotos(sub, photos) {
  const { kept, rejected } = await storePhotos(photos);
  return (
    await pool.query(
      `UPDATE chat_listing_submissions SET photos = photos || $2::jsonb, photos_rejected = photos_rejected + $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [sub.id, JSON.stringify(kept), rejected]
    )
  ).rows[0];
}

// Follow-up details for the latest open listing ("price 1.2 cr", "sector 57").
async function addDetails(sub, text) {
  const fields = await parseFields(text, sub.intent);
  const known = ['priceValue', 'price', 'city', 'locality', 'areaSqft', 'bedrooms', 'propertyType', 'furnishing'].filter((k) => fields[k] != null);
  if (!known.length) return null;
  const parsed = { ...sub.parsed };
  for (const k of known) parsed[k] = fields[k];
  parsed.title = titleFor(sub.intent, parsed);
  parsed.description = `${parsed.description || ''}\n${cleanDescription(text)}`.trim().slice(0, 2000);
  return (
    await pool.query(`UPDATE chat_listing_submissions SET parsed = $2, raw_text = raw_text || E'\\n' || $3, updated_at = now() WHERE id = $1 RETURNING *`, [
      sub.id, JSON.stringify(parsed), String(text).slice(0, 2000),
    ])
  ).rows[0];
}

// ------------------------------------------------------------- requirements

async function createRequirement(contact, { intent, fields }, text) {
  const phone = contact.phone || fields.phone || null;
  const label = CHANNEL_NAME[contact.channel];
  const message = `${label} requirement${intent === 'institutional_buy' ? ' (institutional buyer)' : ''}: ${String(text).slice(0, 1800)}`;
  if (!phone && contact.channel === 'whatsapp' && contact.waUserId) {
    // Number hidden behind a WhatsApp username: the BSUID-based capture path.
    const r = await require('../whatsapp.service').captureLead({
      waUserId: contact.waUserId, name: contact.name || fields.name, requirement: intent === 'rent' ? 'rent' : 'buy',
      location: [fields.locality, fields.city].filter(Boolean).join(', ') || null, budget: fields.price || null, propertyType: fields.propertyType || null, notes: String(text).slice(0, 1000),
    });
    return { leadId: r.leadId, status: r.isNewLead ? 'lead_created' : 'duplicate_detected' };
  }
  if (!phone) return { needsPhone: true };
  const source = await ingestion().getSource(`${contact.channel}_requirement`);
  const tenantId = (contact.channel === 'telegram' ? process.env.TELEGRAM_DEFAULT_TENANT_ID : process.env.WHATSAPP_DEFAULT_TENANT_ID) || null;
  return ingestion().ingest({
    source,
    tenantId,
    method: 'bot',
    mode: 'push',
    raw: { channel: contact.channel, text, contact: { phone, waUserId: contact.waUserId || null, chatId: contact.chatId || null } },
    parsed: {
      externalId: contact.messageId ? `${contact.channel}-${contact.messageId}` : null,
      name: contact.name || fields.name || null,
      phone,
      email: null,
      city: fields.city || null,
      locality: fields.locality || null,
      budget: fields.priceValue || null,
      propertyType: fields.propertyType || null,
      purpose: intent === 'rent' ? 'rent' : 'buy',
      message,
      propertyId: null,
    },
    parsedByAi: false,
  });
}

function requirementReply(result, fields) {
  const what = [fields.bedrooms && `${fields.bedrooms} BHK`, TYPE_LABEL[fields.propertyType], fields.locality, fields.city, fields.price && `budget Rs ${fields.price}`].filter(Boolean).join(', ');
  if (result.status === 'parse_failed') return 'Thank you. Our team will look at your message and get back to you shortly.';
  return `Thank you. We have noted your requirement${what ? ` (${what})` : ''}. Your A R Buildwel representative will contact you shortly with matching properties.`;
}

// ------------------------------------------------------------- entry point

async function log(contact, text, photoCount, r, routedTo, refs = {}) {
  await pool
    .query(
      `INSERT INTO chat_intake_log (channel, contact, text, photo_count, intent, method, confidence, routed_to, submission_id, inbox_id, lead_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        contact.channel, contact.phone ? `${String(contact.phone).slice(0, 2)}xxxxxx${String(contact.phone).slice(-2)}` : contact.waUserId || (contact.chatId ? `tg:${contact.chatId}` : null),
        text ? String(text).slice(0, 2000) : null, photoCount, r.intent, r.method, r.confidence || 0, routedTo,
        refs.submissionId || null, refs.inboxId || null, refs.leadId || null,
      ]
    )
    .catch((err) => console.error('[chat-intake] log failed:', err.message));
}

// One inbound message. `contact` = { channel: 'whatsapp' | 'telegram', phone?,
// waUserId?, chatId?, name?, messageId? }; `photos` = [{ buffer, mimetype }].
// `assume` = the intent the customer already picked in the bot ('sell' after
// "Sell / rent out my property"), used when the message itself does not say.
// Returns { handled: false } when the bots' question flow should answer instead.
async function handleMessage(contact, { text = '', photos = [], reply = true, assume = null } = {}) {
  if ((await configService.getConfig('chat_intake.enabled', true)) === false) return { handled: false };
  const body = String(text || '').trim();
  const say = (msg) => (reply ? send(contact, msg) : null);

  // Photos alone (or with a one-word caption) go to the poster's latest open listing.
  if (photos.length && body.length < 15) {
    const open = await latestOpenSubmission(contact);
    if (!open) {
      await say('Thanks for the photos. Please also send the property details in one message - type, BHK, area, price and location.');
      await log(contact, body, photos.length, { intent: 'other', method: 'none' }, 'ignored');
      return { handled: true, routedTo: 'photo_without_listing' };
    }
    const sub = await addPhotos(open, photos);
    await say(`${(sub.photos || []).length} photo(s) added to ${sub.reference}.${sub.photos_rejected > open.photos_rejected ? ' Photos showing contact details were not added.' : ''}`);
    await log(contact, body, photos.length, { intent: sub.intent, method: 'none' }, 'photo', { submissionId: sub.id });
    return { handled: true, routedTo: 'photo', submissionId: sub.id, photos: (sub.photos || []).length };
  }
  if (!body || body.length < 6) return { handled: false };

  const r = await read(body);
  if (r.intent === 'greeting') return { handled: false };
  if (assume && !LISTING_INTENTS.includes(r.intent) && !REQUIREMENT_INTENTS.includes(r.intent)) {
    r.intent = assume;
    r.fields = { ...r.fields, ...(await parseFields(body, assume)) };
    r.method = 'rules';
  }

  // Short follow-ups ("price 1.2 cr, sector 57") fill in the latest open listing.
  if (!LISTING_INTENTS.includes(r.intent) && !REQUIREMENT_INTENTS.includes(r.intent)) {
    const open = await latestOpenSubmission(contact);
    const updated = open ? await addDetails(open, body) : null;
    if (updated) {
      if (photos.length) await addPhotos(updated, photos);
      await say(`Updated ${updated.reference}: ${updated.parsed.title}${updated.parsed.price ? `, Rs ${updated.parsed.price}` : ''}.`);
      await log(contact, body, photos.length, r, 'listing', { submissionId: updated.id });
      return { handled: true, routedTo: 'listing_update', submissionId: updated.id };
    }
    await log(contact, body, photos.length, r, 'ignored');
    return { handled: false, intent: r.intent };
  }

  if (LISTING_INTENTS.includes(r.intent)) {
    const sub = await createSubmission(contact, r, body, photos);
    await say(listingReply(sub));
    if (!sub.contact_phone && contact.channel === 'telegram') {
      await log(contact, body, photos.length, r, 'needs_phone', { submissionId: sub.id });
      return { handled: true, routedTo: 'listing', intent: r.intent, submissionId: sub.id, reference: sub.reference, needsPhone: true };
    }
    await log(contact, body, photos.length, r, 'listing', { submissionId: sub.id });
    return { handled: true, routedTo: 'listing', intent: r.intent, submissionId: sub.id, reference: sub.reference, duplicates: sub.duplicates.length };
  }

  const res = await createRequirement(contact, r, body);
  if (res.needsPhone) {
    await log(contact, body, photos.length, r, 'needs_phone');
    return { handled: true, routedTo: 'requirement', intent: r.intent, needsPhone: true, text: body };
  }
  await say(requirementReply(res, r.fields));
  await log(contact, body, photos.length, r, 'requirement', { inboxId: res.inboxId, leadId: res.leadId });
  return { handled: true, routedTo: 'requirement', intent: r.intent, leadId: res.leadId || null, status: res.status };
}

// Telegram: the poster shared their number after posting.
async function attachPhone(contact, phone) {
  const clean = N.cleanPhone(phone);
  if (!clean) return null;
  const open = await latestOpenSubmission(contact);
  if (!open || open.contact_phone) return null;
  const customer = await customerService.findOrCreateCustomerByContact({ fullName: open.contact_name || contact.name || `${CHANNEL_NAME[contact.channel]} ${clean}`, mobile: clean }).catch(() => null);
  return (
    await pool.query(`UPDATE chat_listing_submissions SET contact_phone = $2, customer_id = COALESCE(customer_id, $3), updated_at = now() WHERE id = $1 RETURNING *`, [open.id, clean, customer?.id || null])
  ).rows[0];
}

// ------------------------------------------------------------- staff review

async function signPhotos(photos) {
  return Promise.all((photos || []).map(async (p) => ({ ...p, url: p.path ? await getReadUrl(p.path).catch(() => null) : null })));
}

function view(s) {
  return {
    id: s.id,
    reference: s.reference,
    channel: s.channel,
    intent: s.intent,
    status: s.status,
    contactName: s.contact_name,
    contactPhone: s.contact_phone,
    customerId: s.customer_id,
    rawText: s.raw_text,
    parsed: s.parsed,
    parsedBy: s.parsed_by,
    confidence: s.confidence,
    photoCount: (s.photos || []).length,
    photosRejected: s.photos_rejected,
    duplicates: s.duplicates,
    propertyId: s.property_id,
    reviewNote: s.review_note,
    reviewedAt: s.reviewed_at,
    createdAt: s.created_at,
  };
}

function assertStaff(user) {
  if (!isStaff(user)) throw forbidden('Only A R Buildwel staff review chat listings');
}

async function listSubmissions(user, { status = 'pending_review', intent, channel } = {}) {
  assertStaff(user);
  const where = [];
  const params = [];
  if (status && status !== 'all') where.push(`status = $${params.push(status)}`);
  if (intent) where.push(`intent = $${params.push(intent)}`);
  if (channel) where.push(`channel = $${params.push(channel)}`);
  const rows = (await pool.query(`SELECT * FROM chat_listing_submissions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`, params)).rows;
  const counts = (await pool.query(`SELECT status, COUNT(*)::int AS n FROM chat_listing_submissions GROUP BY status`)).rows;
  return { items: rows.map(view), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

async function load(id) {
  const s = (await pool.query('SELECT * FROM chat_listing_submissions WHERE id = $1', [id])).rows[0];
  if (!s) throw notFound('Chat listing not found');
  return s;
}

async function getSubmission(user, id) {
  assertStaff(user);
  const s = await load(id);
  return { ...view(s), photos: await signPhotos(s.photos) };
}

const EDITABLE = ['title', 'propertyType', 'transactionType', 'price', 'city', 'locality', 'areaSqft', 'bedrooms', 'bathrooms', 'furnishing', 'description', 'pincode',
  'institutionName', 'assetClass', 'dealType', 'askingPriceCr', 'latitude', 'longitude'];

async function updateSubmission(user, id, data, meta = {}) {
  assertStaff(user);
  const s = await load(id);
  if (s.status !== 'pending_review') throw badRequest('This listing has already been reviewed');
  const parsed = { ...s.parsed };
  for (const k of EDITABLE) if (data[k] !== undefined) parsed[k] = data[k] === '' ? null : data[k];
  if (data.price !== undefined) {
    const v = N.parseBudget(data.price);
    parsed.priceValue = v || null;
    parsed.price = v ? amount(v) : data.price || null;
  }
  if (data.intent && LISTING_INTENTS.includes(data.intent)) s.intent = data.intent;
  const row = (await pool.query(`UPDATE chat_listing_submissions SET parsed = $2, intent = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, JSON.stringify(parsed), s.intent])).rows[0];
  await auditService.log({ actor: user, action: 'chat_listing.edited', entityType: 'chat_listing', entityId: id, after: parsed, ...meta });
  return getSubmission(user, row.id);
}

async function siteUrl() {
  return String(await configService.getConfig('site.base_url', 'https://propertyserch.com')).replace(/\/$/, '');
}

async function approve(user, id, data = {}, meta = {}) {
  assertStaff(user);
  if (Object.keys(data).length) await updateSubmission(user, id, data, meta);
  const s = await load(id);
  if (s.status !== 'pending_review') throw badRequest('This listing has already been reviewed');
  const p = s.parsed;
  let propertyId;
  if (s.intent === 'institutional_sale') {
    // Engine 7: into the institutional desk (masked, NDA-gated listing).
    const listing = await require('../institutional.service').createListing(
      user,
      {
        institutionName: p.institutionName, assetClass: p.assetClass, dealType: p.dealType || 'full_sale', askingPriceCr: p.askingPriceCr ?? (p.priceValue ? Math.round((p.priceValue / 1e7) * 100) / 100 : null),
        city: p.city, locality: p.locality, latitude: p.latitude, longitude: p.longitude, campusAreaSqft: p.areaSqft || undefined,
      },
      meta
    );
    propertyId = listing.id;
  } else {
    if (!p.title || !p.city || !p.priceValue) throw badRequest('Add the title, city and price before approving');
    if (!p.propertyType) throw badRequest('Choose the property type before approving');
    const property = await require('../property.service').createProperty(
      {
        title: p.title, description: p.description || null, propertyType: p.propertyType, transactionType: p.transactionType || 'sell', price: p.price, priceValue: p.priceValue,
        city: p.city, locality: p.locality || null, areaSqft: p.areaSqft || null, bedrooms: p.bedrooms || null, bathrooms: p.bathrooms || null, furnishing: p.furnishing || null, pincode: p.pincode || null,
      },
      user,
      // Not auto-verified: the Sec. 9 duplicate / fraud check decides whether it goes live.
      { autoVerify: false }
    );
    propertyId = property.id;
    let order = 0;
    for (const photo of s.photos || []) {
      if (!photo.path) continue;
      await pool.query(`INSERT INTO property_media (property_id, media_type, url, display_order, is_primary) VALUES ($1, 'image', $2, $3, $4)`, [propertyId, photo.path, order, order === 0]);
      order += 1;
    }
    if (order) require('../fraud.service').safeAssess(propertyId, 'media');
  }
  await pool.query(`UPDATE chat_listing_submissions SET status = 'approved', property_id = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1`, [id, propertyId, user.id]);
  await auditService.log({ actor: user, action: 'chat_listing.approved', entityType: 'chat_listing', entityId: id, after: { propertyId }, ...meta });
  const status = (await pool.query('SELECT status FROM properties WHERE id = $1', [propertyId])).rows[0]?.status;
  const contact = { channel: s.channel, phone: s.contact_phone, waUserId: s.wa_user_id, chatId: s.telegram_chat_id };
  if (s.intent === 'institutional_sale') await send(contact, `Your institutional listing ${s.reference} is now with the A R Buildwel institutional desk. A representative will call you to complete the details.`);
  else if (status === 'approved') await send(contact, `Your property ${s.reference} is now live: ${await siteUrl()}/properties/${propertyId}\nShare this link with buyers.`);
  else await send(contact, `Your property ${s.reference} has been accepted and is in a final check. We will message you when it is live.`);
  return { ...(await getSubmission(user, id)), propertyStatus: status };
}

async function reject(user, id, { reason, notify = true } = {}, meta = {}) {
  assertStaff(user);
  const s = await load(id);
  if (s.status !== 'pending_review') throw badRequest('This listing has already been reviewed');
  if (!reason) throw badRequest('Give a reason');
  await pool.query(`UPDATE chat_listing_submissions SET status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1`, [id, String(reason).slice(0, 500), user.id]);
  await auditService.log({ actor: user, action: 'chat_listing.rejected', entityType: 'chat_listing', entityId: id, after: { reason }, ...meta });
  if (notify) await send({ channel: s.channel, phone: s.contact_phone, waUserId: s.wa_user_id, chatId: s.telegram_chat_id }, `Your property ${s.reference} could not be listed: ${reason}`);
  return getSubmission(user, id);
}

// Recent messages read, with intent and where each went (staff view).
async function intakeLog(user, { days = 7 } = {}) {
  assertStaff(user);
  const d = Math.min(90, Math.max(1, Number(days) || 7));
  const [rows, stats] = await Promise.all([
    pool.query(`SELECT * FROM chat_intake_log WHERE created_at > now() - make_interval(days => $1) ORDER BY created_at DESC LIMIT 200`, [d]),
    pool.query(
      `SELECT intent, method, routed_to, COUNT(*)::int AS n FROM chat_intake_log WHERE created_at > now() - make_interval(days => $1) GROUP BY 1, 2, 3 ORDER BY n DESC`,
      [d]
    ),
  ]);
  return {
    items: rows.rows.map((r) => ({ id: r.id, channel: r.channel, contact: r.contact, text: r.text, photoCount: r.photo_count, intent: r.intent, method: r.method, confidence: r.confidence, routedTo: r.routed_to, submissionId: r.submission_id, leadId: r.lead_id, createdAt: r.created_at })),
    stats: stats.rows,
  };
}

module.exports = {
  detectIntent,
  parseFields,
  read,
  handleMessage,
  attachPhone,
  listSubmissions,
  getSubmission,
  updateSubmission,
  approve,
  reject,
  intakeLog,
  LISTING_INTENTS,
  REQUIREMENT_INTENTS,
};
