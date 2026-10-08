const zlib = require('zlib');
const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const geo = require('./geo.service');
const { findViolations } = require('../utils/contentGuard');
const { uploadBuffer } = require('../utils/storage');
const { badRequest, forbidden, notFound, unprocessable } = require('../utils/httpError');

// Module 50 - Document Template Engine (sec. 36).
//
//   Template   a blank master document with {{named_variables}}. Plain text
//              with light markup: "# " document title, "## " clause
//              heading, a blank line between paragraphs, and
//              {{state_clauses}} where the clauses for the property's state
//              go. No party, property or money detail is ever written into
//              a template.
//   Variables  each template lists its own (label, type, validation, help).
//              Some compute themselves: amount in words, stamp duty and
//              registration fee from the state's rules, today's date.
//   Generate   the user is shown only that template's variables, with what
//              the deal already knows filled in. The document comes out as
//              DOCX and PDF; a blank version has underlined blanks instead.
//   Rules      every document carries the working-draft disclaimer and a
//              DRAFT watermark until the assigned RM / DM marks advocate
//              review complete; an edit to a template makes a new version
//              and every generated document records the version it used;
//              every generation is audit-logged.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const PROFESSIONAL = ['broker', 'agency_admin', 'builder'];
const isStaff = (u) => STAFF.includes(u.role);
const FIELD_TYPES = ['text', 'longtext', 'number', 'currency', 'date', 'dropdown', 'party_picker', 'computed'];
const COMPUTED_KINDS = ['amount_in_words', 'stamp_duty', 'registration_fee', 'today', 'sum'];
const PREFILL = {
  'deal.buyer_name': 'Buyer / customer on the deal', 'deal.seller_name': 'Owner / lister of the property', 'deal.value': 'Agreed deal value', 'property.address': 'Property address',
  'property.description': 'Property title and locality', 'property.city': 'City', 'property.state': 'State', 'property.area_sqft': 'Area (sq ft)', 'property.rera_number': 'RERA number', 'deal.representative': 'A R Buildwel representative',
};
const BLANK = '________________';
const VAR = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const enabled = async () => (await configService.getConfig('templates.enabled', true)) !== false;

// ------------------------------------------------------------ formatting

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const below1000 = (n) => `${n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' and ' : ''}` : ''}${n % 100 ? below100(n % 100) : ''}`;

// 12500000 -> "Rupees One Crore Twenty Five Lakh Only" (Indian numbering).
function amountInWords(value) {
  const amount = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0) return '';
  let n = Math.floor(amount);
  const paise = Math.round((amount - n) * 100);
  if (n === 0 && !paise) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  // Crores above 99 are themselves read in the same system ("One Thousand Two Hundred Crore").
  if (crore) parts.push(`${crore >= 1000 ? `${below1000(Math.floor(crore / 1000))} Thousand ` : ''}${crore % 1000 ? below1000(crore % 1000) : ''}`.trim() + ' Crore');
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return `Rupees ${parts.join(' ') || 'Zero'}${paise ? ` and ${below100(paise)} Paise` : ''} Only`;
}

const rupees = (v) => `Rs. ${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}/-`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ordinal = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
// "2026-10-07" -> "7th day of October, 2026" (the convention in Indian deeds).
function deedDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${ordinal(Number(m[3]))} day of ${MONTHS[Number(m[2]) - 1]}, ${m[1]}` : '';
}
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// ------------------------------------------------------------ templates (admin)

function variablesIn(body, stateBlocks = []) {
  const names = new Set();
  for (const text of [body, ...stateBlocks.map((b) => b.body)]) for (const m of String(text || '').matchAll(VAR)) names.add(m[1]);
  names.delete('state_clauses');
  return [...names];
}

// Contact-blocking and forbidden-terms validators run on all template content (sec. 36.1).
async function assertCleanTemplate(body, stateBlocks) {
  const fields = { body, ...Object.fromEntries(stateBlocks.map((b, i) => [`state_block_${b.stateCode || i}`, b.body])) };
  const bad = await findViolations(fields, { blockContact: true });
  // "contact" as an ordinary word appears in legal text ("contact details of the parties"); numbers, emails, links and the other phrases stay blocked.
  const real = bad.filter((v) => !(v.rule === 'contact_phrase' && String(v.match).trim().toLowerCase() === 'contact'));
  if (real.length) throw unprocessable('The template text failed validation', real.map((v) => ({ field: v.field, rule: v.rule, msg: `${v.rule.replace(/_/g, ' ')}: "${v.match}"${v.suggestion ? ` - ${v.suggestion}` : ''}` })));
  if (/\b(legal advice|our advocate|as your (lawyer|advocate|counsel))\b/i.test(`${body} ${stateBlocks.map((b) => b.body).join(' ')}`)) throw badRequest('A template must not present A R Buildwel as legal counsel');
}

function cleanBlocks(list) {
  return (Array.isArray(list) ? list : []).map((b) => ({ stateCode: String(b.stateCode || '').toUpperCase().trim(), body: String(b.body || '').trim() })).filter((b) => /^[A-Z]{2,3}$/.test(b.stateCode) && b.body);
}

function cleanVariable(v, i) {
  const name = String(v.name || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,58}$/.test(name)) throw badRequest(`"${v.name}" is not a valid variable name - use lowercase letters, numbers and underscores`);
  if (name === 'state_clauses') throw badRequest('"state_clauses" is reserved for the state-specific block');
  const type = FIELD_TYPES.includes(v.fieldType) ? v.fieldType : 'text';
  let computed = null;
  if (type === 'computed') {
    if (!COMPUTED_KINDS.includes(v.computed?.kind)) throw badRequest(`Choose how "${name}" is computed`);
    computed = { kind: v.computed.kind, of: v.computed.of ? String(v.computed.of) : undefined, parts: Array.isArray(v.computed.parts) ? v.computed.parts.map(String) : undefined };
    if (['amount_in_words', 'stamp_duty', 'registration_fee'].includes(computed.kind) && !computed.of) throw badRequest(`"${name}" needs the amount variable it is worked out from`);
  }
  const options = type === 'dropdown' ? [...new Set((Array.isArray(v.options) ? v.options : String(v.options || '').split(',')).map((o) => String(o).trim()).filter(Boolean))] : [];
  if (type === 'dropdown' && options.length < 2) throw badRequest(`Give "${name}" at least two choices`);
  const val = v.validation && typeof v.validation === 'object' ? v.validation : {};
  const validation = {};
  for (const k of ['min', 'max', 'maxLength']) if (val[k] !== undefined && val[k] !== '' && val[k] !== null) validation[k] = Number(val[k]);
  if (val.pattern) {
    try { RegExp(String(val.pattern)); } catch { throw badRequest(`The pattern for "${name}" is not valid`); }
    validation.pattern = String(val.pattern).slice(0, 200);
    if (val.patternMessage) validation.patternMessage = String(val.patternMessage).slice(0, 160);
  }
  if (v.prefill && !PREFILL[v.prefill]) throw badRequest(`Unknown pre-fill source "${v.prefill}"`);
  return {
    name, label: String(v.label || name.replace(/_/g, ' ')).slice(0, 160), fieldType: type, options, validation, isRequired: type === 'computed' ? false : v.isRequired !== false,
    helpText: v.helpText ? String(v.helpText).slice(0, 300) : null, prefill: v.prefill || null, computed, stateCodes: (Array.isArray(v.stateCodes) ? v.stateCodes : []).map((s) => String(s).toUpperCase()).filter((s) => /^[A-Z]{2,3}$/.test(s)), sortOrder: Number(v.sortOrder) || i + 1,
  };
}

// Create a template, or save an edit (which makes a new version). Variables are replaced as a set.
async function saveTemplate(admin, data, meta = {}) {
  if (admin.role !== 'super_admin' && !ADMIN.includes(admin.role)) throw forbidden('Only an admin manages templates');
  const body = String(data.body || '').replace(/\r\n/g, '\n').trim();
  if (body.length < 40) throw badRequest('Write the template text');
  const blocks = cleanBlocks(data.stateBlocks);
  await assertCleanTemplate(body, blocks);
  const vars = (Array.isArray(data.variables) ? data.variables : []).map(cleanVariable);
  if (new Set(vars.map((v) => v.name)).size !== vars.length) throw badRequest('Two variables have the same name');
  const used = variablesIn(body, blocks);
  const missing = used.filter((u) => !vars.some((v) => v.name === u));
  if (missing.length) throw badRequest(`Define these variables used in the text: ${missing.map((m) => `{{${m}}}`).join(', ')}`);
  for (const v of vars.filter((x) => x.computed?.of)) if (!vars.some((x) => x.name === v.computed.of)) throw badRequest(`"${v.name}" is worked out from "${v.computed.of}", which is not a variable of this template`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let t;
    if (data.id) {
      t = (await client.query('SELECT * FROM document_templates WHERE id = $1 FOR UPDATE', [data.id])).rows[0];
      if (!t) throw notFound('Template not found');
      await client.query(
        `UPDATE document_templates SET name = COALESCE($1, name), category = COALESCE($2, category), description = COALESCE($3, description), audience = COALESCE($4, audience), duty_transaction = COALESCE($5, duty_transaction), updated_at = now() WHERE id = $6`,
        [data.name ? String(data.name).slice(0, 160) : null, data.category || null, data.description ? String(data.description).slice(0, 400) : null, ['staff', 'professional', 'all'].includes(data.audience) ? data.audience : null, data.dutyTransaction || null, t.id]
      );
    } else {
      const key = String(data.templateKey || data.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
      if (!key || !data.name) throw badRequest('Give the template a name');
      if ((await client.query('SELECT 1 FROM document_templates WHERE template_key = $1', [key])).rows.length) throw badRequest('A template with this name already exists');
      t = (await client.query(
        `INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM document_templates), $7) RETURNING *`,
        [key, String(data.name).slice(0, 160), data.category || 'other', data.description ? String(data.description).slice(0, 400) : null, ['staff', 'professional', 'all'].includes(data.audience) ? data.audience : 'professional', data.dutyTransaction || 'sale', admin.id]
      )).rows[0];
    }
    const version = t.current_version + 1;
    await client.query('INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [t.id, version, body, JSON.stringify(blocks), data.changeNote ? String(data.changeNote).slice(0, 300) : null, admin.id]);
    await client.query('UPDATE document_templates SET current_version = $1 WHERE id = $2', [version, t.id]);
    await client.query('DELETE FROM template_variables WHERE template_id = $1', [t.id]);
    for (const v of vars) {
      await client.query(
        `INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [t.id, v.name, v.label, v.fieldType, JSON.stringify(v.options), JSON.stringify(v.validation), v.isRequired, v.helpText, v.prefill, v.computed ? JSON.stringify(v.computed) : null, JSON.stringify(v.stateCodes), v.sortOrder]
      );
    }
    await client.query('COMMIT');
    await auditService.log({ actor: admin, action: data.id ? 'template.new_version' : 'template.created', entityType: 'document_template', entityId: t.id, after: { version, variables: vars.length, note: data.changeNote }, ...meta });
    return templateDetail(admin, t.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setStatus(admin, id, status, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Only an admin manages templates');
  if (!['draft', 'active', 'retired'].includes(status)) throw badRequest('Unknown status');
  const t = (await pool.query('UPDATE document_templates SET status = $1, updated_at = now() WHERE id = $2 AND current_version > 0 RETURNING id', [status, id])).rows[0];
  if (!t) throw notFound('Template not found');
  await auditService.log({ actor: admin, action: `template.${status}`, entityType: 'document_template', entityId: id, ...meta });
  return templateDetail(admin, id);
}

const variableView = (v) => ({ name: v.name, label: v.label, fieldType: v.field_type, options: v.options, validation: v.validation, isRequired: v.is_required, helpText: v.help_text, prefill: v.prefill, computed: v.computed, stateCodes: v.state_codes, sortOrder: v.sort_order });

function canUse(user, t) {
  if (isStaff(user)) return true;
  if (t.status !== 'active') return false;
  if (t.audience === 'all') return true;
  return t.audience === 'professional' && PROFESSIONAL.includes(user.role);
}

async function listTemplates(user) {
  const r = await pool.query(`SELECT t.*, (SELECT COUNT(*)::int FROM template_variables v WHERE v.template_id = t.id) AS variables, (SELECT COUNT(*)::int FROM generated_documents g WHERE g.template_id = t.id) AS generated FROM document_templates t ORDER BY t.sort_order, t.name`);
  return r.rows.filter((t) => canUse(user, t)).map((t) => ({ id: t.id, templateKey: t.template_key, name: t.name, category: t.category, description: t.description, audience: t.audience, status: t.status, currentVersion: t.current_version, variables: t.variables, generated: isStaff(user) ? t.generated : undefined, updatedAt: t.updated_at }));
}

async function loadTemplate(user, id, version = null) {
  const t = (await pool.query('SELECT * FROM document_templates WHERE id = $1', [id])).rows[0];
  if (!t || !canUse(user, t)) throw notFound('Template not found');
  const v = (await pool.query('SELECT * FROM document_template_versions WHERE template_id = $1 AND version = $2', [id, version || t.current_version])).rows[0];
  if (!v) throw notFound('Template version not found');
  const vars = (await pool.query('SELECT * FROM template_variables WHERE template_id = $1 ORDER BY sort_order, name', [id])).rows;
  return { t, v, vars };
}

// Admin view: the text, the variables, the version history.
async function templateDetail(user, id) {
  const { t, v, vars } = await loadTemplate(user, id);
  const history = isStaff(user) ? (await pool.query('SELECT x.version, x.change_note, x.created_at, u.full_name FROM document_template_versions x LEFT JOIN users u ON u.id = x.created_by WHERE x.template_id = $1 ORDER BY x.version DESC', [id])).rows : [];
  return {
    id: t.id, templateKey: t.template_key, name: t.name, category: t.category, description: t.description, audience: t.audience, dutyTransaction: t.duty_transaction, status: t.status, currentVersion: t.current_version,
    body: isStaff(user) ? v.body : undefined, stateBlocks: isStaff(user) ? v.state_blocks : undefined, variables: vars.map(variableView),
    history: history.map((h) => ({ version: h.version, note: h.change_note, at: h.created_at, by: h.full_name })), prefillSources: isStaff(user) ? PREFILL : undefined,
  };
}

// ------------------------------------------------------------ context & pre-fill

// What the platform already knows for this deal / property. Names and
// property facts only - never anyone's phone or email (controlled contact).
async function contextFor(user, { dealId, propertyId }) {
  const ctx = { known: {}, parties: [], stateCode: null, cityId: null, dealId: null, propertyId: null };
  let deal = null;
  if (dealId) {
    deal = (await pool.query(
      `SELECT d.id, d.deal_value, d.property_id, d.broker_id, d.assigned_rep_id, d.tenant_id, c.full_name AS customer_name, c.user_id AS customer_user_id, rep.full_name AS rep_name
       FROM deals d LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN users rep ON rep.id = COALESCE(d.assigned_rep_id, d.broker_id) WHERE d.id = $1`, [dealId])).rows[0];
    if (!deal) throw notFound('Deal not found');
    const mine = isStaff(user) || deal.broker_id === user.id || deal.customer_user_id === user.id || (user.role === 'agency_admin' && user.tenant_id && deal.tenant_id === user.tenant_id);
    if (!mine) throw forbidden('This deal is not yours');
    ctx.dealId = deal.id;
    ctx.known['deal.buyer_name'] = deal.customer_name || null;
    ctx.known['deal.value'] = deal.deal_value === null ? null : Number(deal.deal_value);
    ctx.known['deal.representative'] = deal.rep_name || null;
    if (deal.customer_name) ctx.parties.push({ role: 'Buyer / customer', name: deal.customer_name });
  }
  const pid = propertyId || deal?.property_id;
  if (pid) {
    const p = (await pool.query(
      `SELECT p.id, p.title, p.address, p.locality, p.city, p.area_sqft, p.rera_number, p.created_by, p.broker_id, p.builder_id, owner.full_name AS owner_name, ci.id AS city_id, s.state_code, s.state_name
       FROM properties p LEFT JOIN users owner ON owner.id = p.created_by LEFT JOIN cities ci ON lower(ci.city_name) = lower(p.city) LEFT JOIN states s ON s.id = ci.state_id WHERE p.id = $1`, [pid])).rows[0];
    if (!p) throw notFound('Listing not found');
    if (!deal && !isStaff(user) && ![p.created_by, p.broker_id, p.builder_id].includes(user.id)) throw forbidden('This listing is not yours');
    ctx.propertyId = p.id;
    ctx.stateCode = p.state_code || null;
    ctx.cityId = p.city_id || null;
    Object.assign(ctx.known, {
      'deal.seller_name': p.owner_name || null, 'property.address': [p.address, p.locality, p.city, p.state_name].filter(Boolean).join(', ') || null, 'property.description': [p.title, p.locality].filter(Boolean).join(', ') || null,
      'property.city': p.city || null, 'property.state': p.state_name || null, 'property.area_sqft': p.area_sqft === null ? null : Number(p.area_sqft), 'property.rera_number': p.rera_number || null,
    });
    if (p.owner_name) ctx.parties.push({ role: 'Seller / owner', name: p.owner_name });
  }
  if (ctx.known['deal.representative']) ctx.parties.push({ role: 'A R Buildwel representative', name: ctx.known['deal.representative'] });
  return ctx;
}

// Step 2 of the download flow: only this template's variables, with what is known already filled in.
async function form(user, id, { dealId, propertyId, stateCode } = {}) {
  if (!(await enabled())) throw badRequest('Document templates are switched off at the moment');
  const { t, v, vars } = await loadTemplate(user, id);
  if (!isStaff(user) && t.status !== 'active') throw notFound('Template not found');
  const ctx = await contextFor(user, { dealId, propertyId });
  const state = String(ctx.stateCode || stateCode || '').toUpperCase() || null;
  const usesState = v.state_blocks.length > 0 || vars.some((x) => ['stamp_duty', 'registration_fee'].includes(x.computed?.kind) || x.state_codes.length);
  const states = usesState && !ctx.stateCode ? (await pool.query('SELECT state_code, state_name FROM states WHERE is_active ORDER BY state_name')).rows.map((s) => ({ code: s.state_code, name: s.state_name })) : [];
  const fields = vars
    .filter((x) => x.field_type !== 'computed' && (!x.state_codes.length || (state && x.state_codes.includes(state))))
    .map((x) => {
      const known = x.prefill ? ctx.known[x.prefill] : undefined;
      return { ...variableView(x), value: known ?? null, prefilled: known !== undefined && known !== null, options: x.field_type === 'party_picker' ? ctx.parties.map((p) => p.name) : x.options, parties: x.field_type === 'party_picker' ? ctx.parties : undefined };
    });
  return {
    template: { id: t.id, name: t.name, description: t.description, version: t.current_version, category: t.category },
    dealId: ctx.dealId, propertyId: ctx.propertyId, stateCode: state, needsState: usesState && !state, states,
    fields, computed: vars.filter((x) => x.field_type === 'computed').map((x) => ({ name: x.name, label: x.label, kind: x.computed.kind, of: x.computed.of })),
    // Genuinely missing = required and not already known.
    missing: fields.filter((f) => f.isRequired && !f.prefilled).length,
    disclaimer: await configService.getConfig('templates.draft_disclaimer', "Working draft for the client's chosen advocate to review, stamp, and register before execution."),
  };
}

// ------------------------------------------------------------ values

function validate(vars, input, state) {
  const errors = [];
  const out = {};
  for (const x of vars) {
    if (x.field_type === 'computed') continue;
    if (x.state_codes.length && !(state && x.state_codes.includes(state))) continue;
    const raw = input[x.name];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) {
      if (x.is_required) errors.push({ field: x.name, msg: `${x.label} is required` });
      continue;
    }
    const val = x.validation || {};
    if (['number', 'currency'].includes(x.field_type)) {
      const num = Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(num)) { errors.push({ field: x.name, msg: `${x.label} must be a number` }); continue; }
      if (x.field_type === 'currency' && num < 0) errors.push({ field: x.name, msg: `${x.label} cannot be negative` });
      if (val.min !== undefined && num < val.min) errors.push({ field: x.name, msg: `${x.label} must be at least ${val.min}` });
      if (val.max !== undefined && num > val.max) errors.push({ field: x.name, msg: `${x.label} must be at most ${val.max}` });
      out[x.name] = num;
    } else if (x.field_type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(String(raw)))) errors.push({ field: x.name, msg: `${x.label} must be a date` });
      else out[x.name] = String(raw);
    } else {
      const text = String(raw).trim();
      if (x.field_type === 'dropdown' && !x.options.includes(text)) errors.push({ field: x.name, msg: `Choose one of the options for ${x.label}` });
      if (text.length > (val.maxLength || (x.field_type === 'longtext' ? 4000 : 400))) errors.push({ field: x.name, msg: `${x.label} is too long` });
      if (val.pattern && !new RegExp(val.pattern).test(text)) errors.push({ field: x.name, msg: val.patternMessage || `${x.label} is not in the expected format` });
      out[x.name] = text;
    }
  }
  if (errors.length) throw unprocessable('Some fields need attention', errors);
  return out;
}

// Figures that fill themselves from the values and the state's rules.
async function compute(t, vars, values, { stateCode, cityId }) {
  const out = {};
  let duty = null;
  const rule = async () => {
    if (duty !== null) return duty;
    const rows = stateCode ? await geo.getStampDutyRules({ stateCode, cityId, transactionType: t.duty_transaction }).catch(() => []) : [];
    duty = rows.find((r) => r.buyer_gender === 'any') || rows[0] || false;
    return duty;
  };
  for (const x of vars.filter((v) => v.field_type === 'computed')) {
    const c = x.computed;
    const base = c.of ? values[c.of] ?? out[c.of] : null;
    if (c.kind === 'today') out[x.name] = todayIso();
    else if (c.kind === 'amount_in_words') out[x.name] = base === null || base === undefined ? null : amountInWords(base);
    else if (c.kind === 'sum') out[x.name] = (c.parts || []).reduce((s, p) => s + (Number(values[p] ?? out[p]) || 0), 0);
    else {
      const r = await rule();
      if (!r || base === null || base === undefined) out[x.name] = null;
      else if (c.kind === 'stamp_duty') out[x.name] = Math.round((Number(base) * Number(r.rate_percent)) / 100);
      else {
        const fee = (Number(base) * Number(r.registration_fee_percent)) / 100;
        out[x.name] = Math.round(r.registration_fee_cap !== null && r.registration_fee_cap !== undefined ? Math.min(fee, Number(r.registration_fee_cap)) : fee);
      }
    }
  }
  return { values: out, dutyRule: duty ? { state: duty.state_name, ratePercent: Number(duty.rate_percent), registrationFeePercent: Number(duty.registration_fee_percent) } : null };
}

// How a value is written in the document.
function display(x, value, blank) {
  if (blank || value === null || value === undefined || value === '') return BLANK;
  const kind = x.field_type === 'computed' ? { amount_in_words: 'text', today: 'date', stamp_duty: 'currency', registration_fee: 'currency', sum: 'currency' }[x.computed.kind] : x.field_type;
  if (kind === 'currency') return rupees(value);
  if (kind === 'date') return deedDate(value);
  if (kind === 'number') return Number(value).toLocaleString('en-IN');
  return String(value);
}

// The template text with every variable merged, as a list of blocks.
function merge(v, vars, values, state, blank) {
  const byName = new Map(vars.map((x) => [x.name, x]));
  const block = v.state_blocks.find((b) => b.stateCode === state);
  const fill = (text) => text.replace(VAR, (_, name) => (byName.has(name) ? display(byName.get(name), values[name], blank) : BLANK));
  const text = fill(v.body.replace(/\{\{\s*state_clauses\s*\}\}/g, block ? block.body : ''));
  const blocks = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.startsWith('# ')) blocks.push({ kind: 'title', text: p.slice(2).trim() });
    else if (p.startsWith('## ')) blocks.push({ kind: 'heading', text: p.slice(3).trim() });
    else blocks.push({ kind: 'para', text: p.replace(/\n/g, ' ') });
  }
  return blocks;
}

// ------------------------------------------------------------ PDF & DOCX

const latin = (s) => String(s).replace(/₹/g, 'Rs. ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, ' ');

async function toPdf(blocks, { title, footer, watermark }) {
  const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin(title));
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const [W, H, M] = [595, 842, 64];
  let page;
  let y;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
    if (watermark) page.drawText('DRAFT', { x: 120, y: 260, size: 130, font: bold, color: rgb(0.85, 0.85, 0.85), rotate: degrees(45), opacity: 0.5 });
  };
  const wrap = (text, f, size, width) => {
    const lines = [];
    let line = '';
    for (const word of latin(text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const write = (text, { f = font, size = 11.5, gap = 9, center = false } = {}) => {
    for (const line of wrap(text, f, size, W - 2 * M)) {
      if (y < M + 44) newPage();
      page.drawText(line, { x: center ? (W - f.widthOfTextAtSize(line, size)) / 2 : M, y, size, font: f });
      y -= size + 4.5;
    }
    y -= gap;
  };
  newPage();
  for (const b of blocks) {
    if (b.kind === 'title') write(b.text.toUpperCase(), { f: bold, size: 15, gap: 14, center: true });
    else if (b.kind === 'heading') write(b.text, { f: bold, size: 12, gap: 5 });
    else write(b.text);
  }
  // The disclaimer on every page.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    wrap(footer, font, 8, W - 2 * M).forEach((line, j) => p.drawText(line, { x: M, y: 40 - j * 10, size: 8, font, color: rgb(0.35, 0.35, 0.35) }));
    p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 60, y: 18, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
  });
  return Buffer.from(await pdf.save());
}

// A .docx is a zip of XML parts; this writes the few parts a plain document needs.
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const fname = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8); head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(fname.length, 26); head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(fname.length, 28); dir.writeUInt32LE(offset, 42);
    local.push(head, fname, packed);
    central.push(dir, fname);
    offset += 30 + fname.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBuf, end]);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function toDocx(blocks, { title, footer, watermark }) {
  const run = (text, { bold = false, size = 23, color } = {}) => `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  const para = (inner, { center = false, after = 180 } = {}) => `<w:p><w:pPr>${center ? '<w:jc w:val="center"/>' : '<w:jc w:val="both"/>'}<w:spacing w:after="${after}"/></w:pPr>${inner}</w:p>`;
  const body = [
    watermark ? para(run('DRAFT - NOT FOR EXECUTION', { bold: true, size: 20, color: '9CA3AF' }), { center: true }) : '',
    ...blocks.map((b) => (b.kind === 'title' ? para(run(b.text.toUpperCase(), { bold: true, size: 30 }), { center: true, after: 280 }) : b.kind === 'heading' ? para(run(b.text, { bold: true, size: 24 }), { after: 100 }) : para(run(b.text)))),
  ].join('');
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>PropertySerch.com</dc:creator></cp:coreProperties>`],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'],
    ['word/footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${ns}>${para(run(footer, { size: 15, color: '6B7280' }), { after: 0 })}</w:ftr>`],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`],
  ]);
}

// ------------------------------------------------------------ generate

async function render(g, t, v, vars, format) {
  const [disclaimer, note] = await Promise.all([
    configService.getConfig('templates.draft_disclaimer', "Working draft for the client's chosen advocate to review, stamp, and register before execution."),
    configService.getConfig('templates.facilitation_note', 'A R Buildwel facilitates the transaction and does not act as legal counsel to any party.'),
  ]);
  const blocks = merge(v, vars, g.values, g.state_code, g.is_blank);
  // The mandatory disclaimer is also the closing paragraph of the document itself.
  blocks.push({ kind: 'para', text: `${disclaimer} ${note}` });
  const opts = { title: `${t.name} ${g.document_number}`, footer: `${disclaimer} ${note} ${g.document_number} - ${t.name} v${g.template_version}.`, watermark: !g.advocate_reviewed_at };
  const safe = `${t.template_key}-${g.document_number.replace(/[^A-Za-z0-9]+/g, '-')}${g.is_blank ? '-blank' : ''}`;
  return format === 'docx'
    ? { buffer: toDocx(blocks, opts), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${safe}.docx` }
    : { buffer: await toPdf(blocks, opts), contentType: 'application/pdf', filename: `${safe}.pdf` };
}

// Step 4: record the generation and hand back the document (format: pdf | docx). Both formats can be fetched again later.
async function generate(user, id, { dealId, propertyId, stateCode, values = {}, blank = false } = {}, meta = {}) {
  if (!(await enabled())) throw badRequest('Document templates are switched off at the moment');
  const { t, v, vars } = await loadTemplate(user, id);
  if (t.status !== 'active' && !isStaff(user)) throw notFound('Template not found');
  if (t.status === 'retired') throw badRequest('This template has been retired');
  const ctx = await contextFor(user, { dealId, propertyId });
  const state = String(ctx.stateCode || stateCode || '').toUpperCase() || null;
  let merged = {};
  if (!blank) {
    // Known values stand in for anything the user did not retype.
    const input = { ...Object.fromEntries(vars.filter((x) => x.prefill && ctx.known[x.prefill] !== null && ctx.known[x.prefill] !== undefined).map((x) => [x.name, ctx.known[x.prefill]])), ...Object.fromEntries(Object.entries(values || {}).filter(([, val]) => val !== '' && val !== null && val !== undefined)) };
    const needsState = v.state_blocks.length > 0 || vars.some((x) => ['stamp_duty', 'registration_fee'].includes(x.computed?.kind));
    if (needsState && !state) throw unprocessable('Some fields need attention', [{ field: 'stateCode', msg: 'Choose the state the property is in' }]);
    const clean = validate(vars, input, state);
    const computed = await compute(t, vars, clean, { stateCode: state, cityId: ctx.cityId });
    merged = { ...clean, ...computed.values };
  }
  const seq = (await pool.query(`SELECT nextval('generated_document_seq') AS n`)).rows[0].n;
  const g = (await pool.query(
    `INSERT INTO generated_documents (document_number, template_id, template_version, deal_id, property_id, state_code, "values", is_blank, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [`DOC-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`, t.id, v.version, ctx.dealId, ctx.propertyId, state, JSON.stringify(merged), !!blank, user.id]
  )).rows[0];
  // Who, when, which deal, which template version - immutable.
  await auditService.log({ actor: user, action: 'template.document_generated', entityType: 'generated_document', entityId: g.id, after: { documentNumber: g.document_number, template: t.template_key, templateVersion: v.version, dealId: ctx.dealId, blank: !!blank }, ...meta });
  // A deal's document also goes into the Document Repository (Module 20), visible to staff and the deal's broker only.
  if (ctx.dealId && !blank && process.env.GCS_BUCKET_NAME) {
    try {
      const file = await render(g, t, v, vars, 'pdf');
      const path = await uploadBuffer(file.buffer, `generated/${ctx.dealId}`, file.filename, file.contentType);
      const doc = (await pool.query(
        `INSERT INTO documents (deal_id, property_id, document_type, document_url, file_name, uploaded_by, status, visible_to) VALUES ($1, $2, $3::document_category, $4, $5, $6, 'pending', $7) RETURNING id`,
        [ctx.dealId, ctx.propertyId, { agreement_to_sell: 'agreement_to_sell', sale_deed: 'sale_deed', rent_agreement: 'rent_agreement', leave_and_licence: 'rent_agreement', general_power_of_attorney: 'power_of_attorney', specific_power_of_attorney: 'power_of_attorney' }[t.template_key] || 'agreement', path, file.filename, user.id, JSON.stringify(['staff', 'broker'])]
      )).rows[0];
      await pool.query('UPDATE generated_documents SET repository_document_id = $1 WHERE id = $2', [doc.id, g.id]);
    } catch (err) {
      console.error('[templates] repository copy failed:', err.message);
    }
  }
  return generatedView(g, t);
}

const generatedView = (g, t) => ({
  id: g.id, documentNumber: g.document_number, templateId: g.template_id, templateName: t?.name || g.template_name, templateVersion: g.template_version, dealId: g.deal_id, propertyId: g.property_id, stateCode: g.state_code,
  isBlank: g.is_blank, draft: !g.advocate_reviewed_at, advocateReviewedAt: g.advocate_reviewed_at, createdAt: g.created_at, createdByName: g.created_by_name, inRepository: !!g.repository_document_id,
});

async function loadGenerated(user, id) {
  const g = (await pool.query(`SELECT g.*, d.broker_id, d.tenant_id, d.assigned_rep_id FROM generated_documents g LEFT JOIN deals d ON d.id = g.deal_id WHERE g.id = $1`, [id])).rows[0];
  if (!g) throw notFound('Document not found');
  // Staff, whoever generated it, and the broker on its deal. Not the counterparty.
  const ok = isStaff(user) || g.created_by === user.id || (g.broker_id && g.broker_id === user.id) || (user.role === 'agency_admin' && user.tenant_id && g.tenant_id === user.tenant_id);
  if (!ok) throw forbidden('This document is not yours');
  return g;
}

async function download(user, id, format = 'pdf') {
  if (!['pdf', 'docx'].includes(format)) throw badRequest('format must be pdf or docx');
  const g = await loadGenerated(user, id);
  const t = (await pool.query('SELECT * FROM document_templates WHERE id = $1', [g.template_id])).rows[0];
  // Always the version it was generated from, even if the template has changed since.
  const v = (await pool.query('SELECT * FROM document_template_versions WHERE template_id = $1 AND version = $2', [g.template_id, g.template_version])).rows[0];
  const vars = (await pool.query('SELECT * FROM template_variables WHERE template_id = $1', [g.template_id])).rows;
  return render(g, t, v, vars, format);
}

async function listGenerated(user, { dealId, templateId } = {}) {
  const where = [];
  const params = [];
  if (dealId) { params.push(dealId); where.push(`g.deal_id = $${params.length}`); }
  if (templateId) { params.push(templateId); where.push(`g.template_id = $${params.length}`); }
  if (!isStaff(user)) { params.push(user.id); where.push(`(g.created_by = $${params.length} OR d.broker_id = $${params.length})`); }
  const r = await pool.query(
    `SELECT g.*, t.name AS template_name, u.full_name AS created_by_name FROM generated_documents g JOIN document_templates t ON t.id = g.template_id LEFT JOIN deals d ON d.id = g.deal_id LEFT JOIN users u ON u.id = g.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.created_at DESC LIMIT 200`, params);
  return r.rows.map((g) => generatedView(g));
}

// The assigned RM / DM marks the advocate's review complete: the DRAFT watermark comes off.
async function markReviewed(user, id, meta = {}) {
  if (!isStaff(user)) throw forbidden('Only the assigned A R Buildwel representative can do this');
  const g = await loadGenerated(user, id);
  if (g.is_blank) throw badRequest('A blank form has nothing to review');
  if (g.advocate_reviewed_at) return generatedView(g);
  if (g.assigned_rep_id && g.assigned_rep_id !== user.id && !ADMIN.includes(user.role)) throw forbidden('Only the representative assigned to this deal can mark the review complete');
  const r = (await pool.query('UPDATE generated_documents SET advocate_reviewed_at = now(), advocate_reviewed_by = $1 WHERE id = $2 RETURNING *', [user.id, id])).rows[0];
  await auditService.log({ actor: user, action: 'template.advocate_review_complete', entityType: 'generated_document', entityId: id, after: { documentNumber: g.document_number }, ...meta });
  return generatedView(r);
}

module.exports = { FIELD_TYPES, COMPUTED_KINDS, PREFILL, amountInWords, deedDate, variablesIn, saveTemplate, setStatus, listTemplates, templateDetail, form, generate, download, listGenerated, markReviewed };
