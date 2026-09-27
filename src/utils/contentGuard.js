const configService = require('../services/config.service');
const { unprocessable } = require('./httpError');

// Server-side content validation required by Annexure A:
//   - sec. 0.3  brand spellings (Buildwel / Propertyserch) - no role bypass
//   - sec. 0.4  forbidden terms ("distressed", "guaranteed returns", ...)
//   - sec. 11.2 contact blocking in listing text (phones, emails, URLs,
//               contact phrases) - rejected before any database write
// Every word list is read from app_config so it stays admin-editable.

const DEFAULT_FORBIDDEN = [
  { term: 'distressed', use: 'Special Situation Properties or High-Opportunity Investment Deals' },
  { term: 'disputed', use: 'Special Situation Properties' },
  { term: 'cheap', use: null },
  { term: 'guaranteed returns', use: 'indicative projections, not guaranteed' },
  { term: 'risk-free investment', use: null },
  { term: 'first in india', use: null },
  { term: "india's only", use: null },
  { term: 'law firm', use: null },
];
const DEFAULT_MISSPELLINGS = ['buildwell', 'propertysearch'];
const DEFAULT_CONTACT_PHRASES = ['call me', 'reach at', 'contact', 'whatsapp', 'telegram', 'text me', 'call karo', 'contact karo'];

const CONTACT_PATTERNS = [
  // Indian mobiles in any common format: +91 98765 43210, 098765-43210, 9876543210
  { rule: 'phone_number', regex: /(?:\+?91[\s.-]?|\b0)?\b[6-9](?:[\s.-]?\d){9}\b/ },
  // International numbers written with a leading +
  { rule: 'phone_number', regex: /\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){6,12}\b/ },
  { rule: 'email', regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { rule: 'url', regex: /\b(?:https?:\/\/|www\.)\S+/i },
  { rule: 'url', regex: /\b[a-z0-9-]+\.(?:com|in|net|org|co|io|info|biz|me|link)\b/i },
];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word, case-insensitive; straight and curly apostrophes match alike.
function phraseRegex(phrase) {
  const pattern = escapeRegex(phrase.toLowerCase()).replace(/'/g, "['’]").replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])(${pattern})(?=$|[^a-z0-9])`, 'i');
}

// Collects every string inside a value (arrays of tags, FAQ objects...).
function collectStrings(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

async function loadRules() {
  const [forbidden, misspellings, contactPhrases, contactBlockEnabled] = await Promise.all([
    configService.getConfig('content_guard.forbidden_terms', DEFAULT_FORBIDDEN),
    configService.getConfig('content_guard.brand_misspellings', DEFAULT_MISSPELLINGS),
    configService.getConfig('content_guard.contact_phrases', DEFAULT_CONTACT_PHRASES),
    configService.getConfig('content_guard.contact_block_enabled', true),
  ]);
  return { forbidden, misspellings, contactPhrases, contactBlockEnabled };
}

/**
 * Returns a list of violations ({ field, rule, match, suggestion }) for the
 * given fields. `blockContact` turns on the sec. 11.2 contact rules - used
 * for listing text; CMS/admin copy only gets the brand/forbidden checks.
 */
async function findViolations(fields, { blockContact = false } = {}) {
  const rules = await loadRules();
  const violations = [];

  for (const [field, value] of Object.entries(fields)) {
    for (const text of collectStrings(value)) {
      for (const misspelling of rules.misspellings) {
        const m = text.match(new RegExp(`\\b${escapeRegex(misspelling)}\\b`, 'i'));
        if (m) {
          violations.push({ field, rule: 'brand_spelling', match: m[0], suggestion: 'Use "Buildwel" (single L) and "Propertyserch" (no A)' });
        }
      }

      for (const entry of rules.forbidden) {
        const m = text.match(phraseRegex(entry.term));
        if (m) {
          violations.push({ field, rule: 'forbidden_term', match: m[2], suggestion: entry.use ? `Use: ${entry.use}` : 'Remove this term' });
        }
      }

      if (blockContact && rules.contactBlockEnabled) {
        for (const { rule, regex } of CONTACT_PATTERNS) {
          const m = text.match(regex);
          if (m) violations.push({ field, rule, match: m[0], suggestion: 'Contact details are never shown publicly - buyers reach the assigned A R Buildwel representative' });
        }
        for (const phrase of rules.contactPhrases) {
          const m = text.match(phraseRegex(phrase));
          if (m) violations.push({ field, rule: 'contact_phrase', match: m[2], suggestion: 'Remove contact phrases from listing text' });
        }
      }
    }
  }

  return violations;
}

async function assertCleanContent(fields, options = {}) {
  const violations = await findViolations(fields, options);
  if (violations.length > 0) {
    throw unprocessable('Content failed validation', violations);
  }
}

module.exports = { findViolations, assertCleanContent };
