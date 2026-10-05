const { parsePriceToNumber } = require('../../utils/price');

// Source-specific, tenant-agnostic normalisers (Engine 2 "Lead
// normalisation is source-specific but tenant-agnostic"). Each turns one raw
// inbound payload into zero or more parsed leads:
//   { externalId, name, phone, email, city, locality, budget (INR),
//     propertyType, purpose, message, propertyId }
// plus a 0-100 confidence (see `confidence`). Field names that vary by
// portal come from lead_sources.field_mapping (admin-editable), falling back
// to the common names below - a new portal format needs a mapping row, not
// code.

const DEFAULT_MAPPING = {
  externalId: ['lead_id', 'leadid', 'id', 'enquiry_id', 'enquiryid', 'query_id', 'reference', 'ref_id'],
  name: ['name', 'full_name', 'fullname', 'customer_name', 'contact_name', 'buyer_name', 'first_name'],
  phone: ['phone', 'mobile', 'phone_number', 'mobile_number', 'contact_number', 'contact', 'customer_mobile', 'buyer_mobile'],
  email: ['email', 'email_address', 'customer_email', 'buyer_email'],
  city: ['city', 'city_name', 'location_city'],
  locality: ['locality', 'location', 'area', 'project_locality', 'sector', 'project_name', 'project'],
  budget: ['budget', 'price', 'max_budget', 'budget_max', 'expected_price'],
  propertyType: ['property_type', 'propertytype', 'type', 'category', 'unit_type'],
  purpose: ['purpose', 'transaction_type', 'intent', 'listing_type'],
  message: ['message', 'remarks', 'comments', 'query', 'requirement', 'notes', 'description'],
  propertyId: ['property_id', 'listing_id'],
};

const PHONE_RE = /(?:\+?91[\s-]?|\b0)?\b([6-9]\d{4}[\s-]?\d{5})\b/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanPhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

function cleanEmail(value) {
  const m = value ? String(value).match(EMAIL_RE) : null;
  return m ? m[0].toLowerCase() : null;
}

// "50 Lakh", "1.2 Cr", "50L - 1Cr" (takes the upper bound), "7500000".
function parseBudget(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const parts = String(value).toLowerCase().replace(/[₹,]|rs\.?|inr/g, '').split(/\s*(?:-|to)\s*/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts.reverse()) {
    const m = part.replace(/\s+/g, '').match(/^([0-9]+(?:\.[0-9]+)?)(cr|crore|crores|l|lac|lacs|lakh|lakhs|k|thousand)?/);
    if (!m) continue;
    const n = parsePriceToNumber(`${m[1]}${m[2] || ''}`);
    if (n) return Math.round(n);
  }
  return null;
}

function mapPropertyType(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/villa/.test(t)) return 'villa';
  if (/plot|land/.test(t)) return 'plot';
  if (/shop|office|commercial|retail|showroom|warehouse/.test(t)) return 'commercial';
  if (/farm/.test(t)) return 'farmhouse';
  if (/house|kothi|independent|builder floor|floor/.test(t)) return 'independent_house';
  if (/flat|apartment|bhk|studio|condo/.test(t)) return 'apartment';
  return 'other';
}

function mapPurpose(text) {
  const t = String(text || '').toLowerCase();
  if (/rent|lease|pg|tenant/.test(t)) return 'rent';
  if (/sell|sale|buy|purchase|invest/.test(t)) return 'buy';
  return null;
}

// Case-insensitive key lookup across a flat object, using mapping keys first.
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(k).toLowerCase().replace(/[\s-]/g, '_'), v]));
  for (const k of keys) {
    const v = lower[String(k).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

function mappingFor(source) {
  const custom = source?.field_mapping || {};
  const out = {};
  for (const [field, defaults] of Object.entries(DEFAULT_MAPPING)) {
    out[field] = [...(Array.isArray(custom[field]) ? custom[field] : []), ...defaults];
  }
  return out;
}

function fromFlat(obj, source) {
  const m = mappingFor(source);
  const g = (f) => pick(obj, m[f]);
  const message = g('message');
  const propertyId = g('propertyId');
  return {
    externalId: g('externalId') != null ? String(g('externalId')) : null,
    name: g('name') ? String(g('name')).trim().slice(0, 150) : null,
    phone: cleanPhone(g('phone')) || cleanPhone(String(message || '').match(PHONE_RE)?.[1]),
    email: cleanEmail(g('email')),
    city: g('city') ? String(g('city')).trim().slice(0, 100) : null,
    locality: g('locality') ? String(g('locality')).trim().slice(0, 150) : null,
    budget: parseBudget(g('budget')),
    propertyType: mapPropertyType(g('propertyType') || message),
    purpose: mapPurpose(g('purpose') || g('propertyType') || message),
    message: message ? String(message).slice(0, 2000) : null,
    propertyId: propertyId && UUID_RE.test(String(propertyId)) ? String(propertyId) : null,
  };
}

// 0-100: a lead is only usable with a way to reach the person; the rest
// makes it actionable for the representative.
function confidence(p) {
  let c = 0;
  if (p.phone) c += 50;
  else if (p.email) c += 35;
  if (p.name) c += 15;
  if (p.city || p.locality) c += 15;
  if (p.budget) c += 10;
  if (p.propertyType || p.purpose) c += 5;
  if (p.message || p.propertyId) c += 5;
  return Math.min(100, c);
}

// ---------------------------------------------------------------- per source

// Meta Lead Ads (Facebook / Instagram): a lead object with field_data
// [{ name, values: [] }] - from the Graph API (push fetch or pull) or a test
// payload that already carries it.
function metaLead(lead, source) {
  const flat = {};
  for (const f of lead.field_data || []) flat[String(f.name).toLowerCase()] = Array.isArray(f.values) ? f.values[0] : f.values;
  const parsed = fromFlat(flat, source);
  parsed.externalId = String(lead.id || lead.leadgen_id || parsed.externalId || '') || null;
  if (!parsed.message && lead.ad_name) parsed.message = `Ad: ${lead.ad_name}`;
  return parsed;
}

// Google Ads lead form webhook / Google Ads API row.
function googleLead(body, source) {
  const flat = {};
  for (const c of body.user_column_data || body.lead_form_submission_fields || []) {
    const key = String(c.column_id || c.column_name || c.field_type || '').toLowerCase();
    const value = c.string_value ?? c.field_value ?? c.value;
    if (/full_name|^name$/.test(key)) flat.name = value;
    else if (/first_name/.test(key)) flat.name = flat.name ? `${value} ${flat.name}` : value;
    else if (/last_name/.test(key)) flat.name = flat.name ? `${flat.name} ${value}` : value;
    else if (/phone/.test(key)) flat.phone = value;
    else if (/email/.test(key)) flat.email = value;
    else if (/city/.test(key)) flat.city = value;
    else if (/budget|price/.test(key)) flat.budget = value;
    else if (/property|type/.test(key)) flat.property_type = value;
    else flat[key] = value;
  }
  const parsed = fromFlat(flat, source);
  parsed.externalId = String(body.lead_id || body.id || body.resource_name || '') || null;
  return parsed;
}

// Portal lead emails (99acres / MagicBricks / Housing ...). Rule-based
// regexes over "Label: value" lines and the free text.
function emailLead({ subject, text, from }) {
  const body = `${subject || ''}\n${String(text || '').replace(/\r/g, '')}`;
  const line = (labels) => {
    for (const l of labels) {
      const m = body.match(new RegExp(`(?:^|\\n)\\s*${l}\\s*[:\\-]\\s*(.+)`, 'i'));
      if (m) return m[1].trim();
    }
    return null;
  };
  const phoneLine = line(['mobile(?: no\\.?| number)?', 'phone(?: number)?', 'contact(?: no\\.?| number)?']);
  const parsed = {
    externalId: line(['lead id', 'enquiry id', 'query id', 'reference(?: no\\.?)?']),
    name: line(['name', 'buyer name', 'customer name', 'contact person'])?.slice(0, 150) || null,
    phone: cleanPhone(phoneLine) || cleanPhone(body.match(PHONE_RE)?.[1]),
    email: cleanEmail(line(['email(?: id)?', 'e-mail'])) || cleanEmail((body.match(EMAIL_RE) || []).find((e) => !String(from || '').includes(e)) || null),
    city: line(['city'])?.slice(0, 100) || null,
    locality: line(['locality', 'location', 'project', 'area', 'project name'])?.slice(0, 150) || null,
    budget: parseBudget(line(['budget', 'price', 'expected price'])),
    propertyType: mapPropertyType(line(['property type', 'type', 'category']) || subject),
    purpose: mapPurpose(line(['purpose', 'interested in', 'looking to']) || subject),
    message: line(['message', 'remarks', 'comments', 'requirement']) || null,
    propertyId: null,
  };
  return parsed;
}

module.exports = {
  DEFAULT_MAPPING,
  cleanPhone,
  cleanEmail,
  parseBudget,
  mapPropertyType,
  mapPurpose,
  fromFlat,
  confidence,
  metaLead,
  googleLead,
  emailLead,
};
