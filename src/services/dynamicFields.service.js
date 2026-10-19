const pool = require('../config/db');
const auditService = require('./audit.service');
const { encrypt, decrypt } = require('../utils/crypto');
const { uploadBuffer, getReadUrl } = require('../utils/storage');
const { badRequest, forbidden, notFound, unprocessable } = require('../utils/httpError');

// Section 5 - Dynamic Field Manager (no-code).
// A Super Admin adds fields to a form from the admin panel; they appear on the
// next page load, with no deployment.
//   metadata_fields      what the field is: type, label, section, validation,
//                        options, show / hide rule, and the states, cities and
//                        roles it applies to.
//   custom_field_values  what people entered, per record.
// Routes that save a record call capture(); routes that return one call
// expose(). Both do nothing at all until a field exists for that form.
//
// Field types (sec. 5.1.1): the 17 below. Type 18, "JSONB-extensible", is
// registerType(): a new type is a validator here and a renderer in the apps -
// no form and no table changes.

const ENTITIES = {
  property: { label: 'Property listing', table: 'properties', city: 'city', owner: 'created_by' },
  requirement: { label: 'Requirement', table: 'requirements', city: 'city', owner: 'created_by' },
  crm_lead: { label: 'CRM lead', table: 'leads' },
  institution: { label: 'Institutional listing', table: 'properties', city: 'city', owner: 'created_by' },
  user_profile: { label: 'User profile', table: 'users' },
  // Filled in on their own forms: the KYC submission, the due-diligence review
  // of a listing and the agreement generated for a deal.
  kyc: { label: 'KYC', form: 'The KYC submission (website profile and dashboard Trust page)' },
  due_diligence: { label: 'Due diligence', form: 'The due-diligence review on a listing', table: 'properties', city: 'city' },
  agreement: { label: 'Agreement', form: 'Generating an agreement document for a deal' },
  dashboard_widget: { label: 'Dashboard widget' },
};
const ROLES = ['customer', 'broker', 'agency_admin', 'builder', 'internal_sales', 'admin', 'super_admin', 'advertiser', 'franchisee_admin'];
const STAFF = ['internal_sales', 'admin', 'super_admin'];
// Never shown on a public page, whatever the field's own setting says.
const PRIVATE_TYPES = ['phone', 'email', 'address', 'file'];
const RULE_KEYS = ['min', 'max', 'step', 'precision', 'min_length', 'max_length', 'regex', 'required_if', 'allowed_values', 'max_file_size', 'accepted_file_types', 'multiple', 'max_files', 'min_items', 'max_items', 'rows'];
const OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'gt', 'lt', 'is_set', 'is_empty'];

const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const fail = (message) => { throw new Error(message); };
const numberIn = (n, rules, label = 'Value') => {
  if (rules.min !== undefined && n < Number(rules.min)) fail(`${label} must be at least ${rules.min}`);
  if (rules.max !== undefined && n > Number(rules.max)) fail(`${label} must be at most ${rules.max}`);
  return n;
};
const allowed = (v, rules) => {
  if (Array.isArray(rules.allowed_values) && rules.allowed_values.length && !rules.allowed_values.map(String).includes(String(v))) fail(`Must be one of: ${rules.allowed_values.join(', ')}`);
  return v;
};
const text = (max) => (raw, f, rules) => {
  if (typeof raw !== 'string' && typeof raw !== 'number') fail('Must be text');
  const v = String(raw).trim();
  const limit = Number(rules.max_length) || max;
  if (v.length > limit) fail(`At most ${limit} characters`);
  if (rules.min_length && v.length < Number(rules.min_length)) fail(`At least ${rules.min_length} characters`);
  if (rules.regex && !new RegExp(rules.regex).test(v)) fail('Not in the expected format');
  return allowed(v, rules);
};
const decimal = (defaults = {}) => (raw, f, rules) => {
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) fail('Must be a number');
  const p = Number.isInteger(Number(rules.precision)) ? Math.min(Math.max(Number(rules.precision), 0), 6) : 2;
  return numberIn(Math.round(n * 10 ** p) / 10 ** p, { ...defaults, ...rules });
};
const optionValues = (f) => (f.options_json || []).filter((o) => o.is_active !== false).map((o) => String(o.value));
const FILE_DEFAULTS = {
  file: { types: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], size: 10 * 1024 * 1024 },
  image: { types: ['image/jpeg', 'image/png', 'image/webp'], size: 8 * 1024 * 1024 },
};
// A stored upload: only something this field's own upload endpoint produced is accepted.
const upload = (raw, f, rules) => {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > 1 && !rules.multiple) fail('Only one file is allowed');
  if (list.length > (Number(rules.max_files) || 10)) fail(`At most ${Number(rules.max_files) || 10} files`);
  const out = list.map((x) => {
    if (!x || typeof x !== 'object' || typeof x.path !== 'string' || !x.path.includes(`custom-fields/${f.id}/`)) fail('Upload the file first');
    return { path: x.path, name: String(x.name || 'file').slice(0, 200), size: Number(x.size) || null, mime: String(x.mime || '').slice(0, 100) };
  });
  return rules.multiple ? out : out[0];
};

const TYPES = {
  text: { label: 'Text', clean: text(500) },
  textarea: { label: 'Long text', clean: text(5000) },
  number: {
    label: 'Whole number',
    clean: (raw, f, rules) => {
      const n = Number(raw);
      if (!Number.isInteger(n)) fail('Must be a whole number');
      if (rules.step && n % Number(rules.step) !== 0) fail(`Must be a multiple of ${rules.step}`);
      return allowed(numberIn(n, rules), rules);
    },
  },
  decimal: { label: 'Decimal number', clean: decimal() },
  currency: { label: 'Amount (currency)', clean: decimal({ min: 0 }) },
  dropdown: { label: 'Dropdown (choose one)', options: true, clean: (raw, f) => (optionValues(f).includes(String(raw)) ? String(raw) : fail('Choose one of the listed options')) },
  multiselect: {
    label: 'Multi-select (choose several)',
    options: true,
    clean: (raw, f, rules) => {
      const list = [...new Set((Array.isArray(raw) ? raw : [raw]).map(String))];
      const ok = optionValues(f);
      if (list.some((v) => !ok.includes(v))) fail('Choose from the listed options');
      if (rules.min_items && list.length < Number(rules.min_items)) fail(`Choose at least ${rules.min_items}`);
      if (rules.max_items && list.length > Number(rules.max_items)) fail(`Choose at most ${rules.max_items}`);
      return list;
    },
  },
  date: {
    label: 'Date',
    clean: (raw, f, rules) => {
      const v = String(raw).slice(0, 10);
      // Date.parse rolls 30 February over to March, so compare what comes back.
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) fail('Not a valid date');
      const bound = (b) => (b === 'today' ? new Date().toISOString().slice(0, 10) : String(b));
      if (rules.min !== undefined && v < bound(rules.min)) fail(`Must be on or after ${bound(rules.min)}`);
      if (rules.max !== undefined && v > bound(rules.max)) fail(`Must be on or before ${bound(rules.max)}`);
      return v;
    },
  },
  datetime: { label: 'Date and time', clean: (raw) => (Number.isNaN(Date.parse(raw)) ? fail('Not a valid date and time') : new Date(raw).toISOString()) },
  checkbox: { label: 'Yes / No', clean: (raw) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : fail('Must be yes or no')) },
  file: { label: 'File upload', upload: true, clean: upload },
  image: { label: 'Image upload', upload: true, clean: upload },
  email: { label: 'Email', clean: (raw) => (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(raw).trim()) ? String(raw).trim().toLowerCase() : fail('Not a valid email address')) },
  phone: {
    label: 'Phone number',
    // Stored encrypted; only the last four digits are kept readable.
    clean: (raw) => {
      const src = typeof raw === 'object' ? `${raw.countryCode || ''}${raw.number || ''}` : String(raw);
      const digits = src.replace(/\D/g, '');
      const intl = src.trim().startsWith('+') && digits.length > 10;
      const cc = intl ? `+${digits.slice(0, digits.length - 10)}` : '+91';
      const number = digits.slice(-10);
      if (digits.length < 10 || digits.length > 14 || (cc === '+91' && !/^[6-9]\d{9}$/.test(number))) fail('Not a valid phone number');
      return { cc, enc: encrypt(number), last4: number.slice(-4) };
    },
  },
  address: {
    label: 'Address',
    clean: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Enter the address');
      const s = (k, max) => (raw[k] ? String(raw[k]).trim().slice(0, max) : null);
      const out = { line1: s('line1', 200), line2: s('line2', 200), city: s('city', 120), state: s('state', 120), pincode: s('pincode', 10) };
      if (!out.line1) fail('Enter the first line of the address');
      if (out.pincode && !/^\d{6}$/.test(out.pincode)) fail('Pincode must be 6 digits');
      return out;
    },
  },
  geo_point: {
    label: 'Map location',
    clean: (raw) => {
      const lat = Number(raw?.lat ?? raw?.latitude);
      const lng = Number(raw?.lng ?? raw?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || raw?.lat === '' || raw?.lng === '') fail('Pick the location on the map');
      return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
    },
  },
  rating: {
    label: 'Star rating',
    clean: (raw, f, rules) => {
      const n = Number(raw);
      const max = Number(rules.max) || 5;
      return Number.isInteger(n) && n >= 1 && n <= max ? n : fail(`Choose 1 to ${max} stars`);
    },
  },
};

// Type 18: a developer adds a type here (and a renderer in the apps).
function registerType(name, def) {
  if (!/^[a-z][a-z0-9_]{1,19}$/.test(name) || typeof def?.clean !== 'function') throw new Error('A field type needs a name and a clean(value, field, rules) function');
  TYPES[name] = { label: def.label || name, ...def };
}

// ------------------------------------------------------------ field definitions

let cache = { at: 0, rows: null };
async function allFields() {
  if (cache.rows && Date.now() - cache.at < 15000) return cache.rows;
  cache = { at: Date.now(), rows: (await pool.query('SELECT * FROM metadata_fields ORDER BY entity_type, display_order, created_at')).rows };
  return cache.rows;
}
const invalidate = () => { cache = { at: 0, rows: null }; };
// Added fields only. Built-in fields (is_system) keep their place in the form's
// own code; their rows carry the label, help text, required and hidden settings.
const activeFields = async (entityType) => (await allFields()).filter((f) => f.entity_type === entityType && f.is_active && !f.is_system);
const systemFields = async (entityType) => (await allFields()).filter((f) => f.entity_type === entityType && f.is_system);

const view = (f) => ({
  id: f.id, entityType: f.entity_type, section: f.section, module: f.module, name: f.field_name, label: f.field_label, type: f.field_type, helpText: f.help_text, placeholder: f.placeholder,
  validation: f.validation_rules || {}, required: f.is_required, displayOrder: f.display_order, defaultValue: f.default_value, options: f.options_json || [], conditionalLogic: f.conditional_logic,
  applicableStates: f.applicable_states || [], applicableCities: f.applicable_cities || [], applicableRoles: f.applicable_roles || [], visiblePublicly: f.is_visible_publicly, searchable: f.is_searchable, active: f.is_active,
  system: f.is_system, locked: f.is_locked, coreKey: f.core_key, defaultLabel: f.default_label, optionsSource: f.options_source, defaultSection: f.default_section || null,
  moved: f.is_system && ((f.default_order !== null && f.display_order !== f.default_order) || (!!f.default_section && f.section !== f.default_section)),
  createdAt: f.created_at, updatedAt: f.updated_at,
});

// ------------------------------------------------------------ options from master data

// A dropdown can list master data for the record's city instead of typed options.
const SOURCES = {
  localities: { label: 'Localities of the city', sql: `SELECT DISTINCT l.locality_name AS v FROM localities l JOIN cities c ON c.id = l.city_id WHERE lower(c.city_name) = lower($1) AND l.is_active ORDER BY 1 LIMIT 500` },
  circle_rate_zones: {
    label: 'Circle rate zones of the city',
    sql: `SELECT DISTINCT l.locality_name || ' - Rs ' || cr.rate_per_sqft::int || ' per sq ft' || COALESCE(' (' || cr.property_type || ')', '') AS v
          FROM circle_rates cr JOIN cities c ON c.id = cr.city_id JOIN localities l ON l.id = cr.locality_id
          WHERE lower(c.city_name) = lower($1) AND (cr.effective_until IS NULL OR cr.effective_until >= CURRENT_DATE) ORDER BY 1 LIMIT 500`,
  },
  sub_registrar_offices: { label: 'Sub-Registrar Offices of the city', sql: `SELECT DISTINCT o.sro_name AS v FROM sub_registrar_offices o JOIN cities c ON c.id = o.city_id WHERE lower(c.city_name) = lower($1) ORDER BY 1 LIMIT 300` },
  cities: { label: 'All cities', sql: `SELECT city_name AS v FROM cities WHERE $1::text IS NOT NULL OR true ORDER BY 1 LIMIT 2000` },
  states: { label: 'All states', sql: `SELECT state_name AS v FROM states WHERE $1::text IS NOT NULL OR true ORDER BY 1` },
};
let sourceCache = new Map();
async function sourceOptions(source, city) {
  if (!SOURCES[source]) return [];
  const key = `${source}|${String(city || '').toLowerCase()}`;
  const hit = sourceCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.rows;
  const rows = (await pool.query(SOURCES[source].sql, [city || '']).catch(() => ({ rows: [] }))).rows.map((r) => ({ value: r.v, label: r.v, is_active: true }));
  if (sourceCache.size > 500) sourceCache = new Map();
  sourceCache.set(key, { at: Date.now(), rows });
  return rows;
}
// The field with its options filled in for this city.
const withOptions = async (f, city) => (f.options_source ? { ...f, options_json: await sourceOptions(f.options_source, city) } : f);

function checkCondition(c, where) {
  if (!c || typeof c !== 'object') throw badRequest(`${where} must be { field, operator, value }`);
  if (Array.isArray(c.all) || Array.isArray(c.any)) return (c.all || c.any).forEach((x) => checkCondition(x, where));
  if (!c.field || !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(String(c.field))) throw badRequest(`${where}: name the field the rule looks at`);
  if (!OPERATORS.includes(c.operator)) throw badRequest(`${where}: operator must be one of ${OPERATORS.join(', ')}`);
  return undefined;
}

// Turn what the admin typed into a row, refusing anything that could not work.
async function fieldInput(data, current) {
  const type = String(data.type ?? current?.field_type ?? '').replace('-', '_');
  if (!TYPES[type]) throw badRequest(`Field type must be one of: ${Object.keys(TYPES).join(', ')}`);
  const label = String(data.label ?? current?.field_label ?? '').trim();
  if (label.length < 2 || label.length > 150) throw badRequest('Give the field a label (2 to 150 characters)');
  const rules = data.validation === undefined ? current?.validation_rules || {} : data.validation || {};
  if (typeof rules !== 'object' || Array.isArray(rules)) throw badRequest('Validation rules must be an object');
  const unknown = Object.keys(rules).filter((k) => !RULE_KEYS.includes(k));
  if (unknown.length) throw badRequest(`Unknown validation rule: ${unknown.join(', ')}`);
  if (rules.regex !== undefined) {
    try {
      new RegExp(rules.regex);
    } catch {
      throw badRequest('The pattern (regex) is not valid');
    }
  }
  if (rules.required_if) checkCondition(rules.required_if, 'required_if');
  if (rules.min !== undefined && rules.max !== undefined && type !== 'date' && Number(rules.min) > Number(rules.max)) throw badRequest('Minimum cannot be more than maximum');
  let options = data.options === undefined ? current?.options_json || [] : data.options;
  const source = data.optionsSource === undefined ? current?.options_source || null : data.optionsSource || null;
  if (source && !SOURCES[source]) throw badRequest(`Options can come from: ${Object.keys(SOURCES).join(', ')}`);
  if (source && !TYPES[type].options) throw badRequest('Only a dropdown or multi-select can take its options from master data');
  if (source) options = [];
  else if (TYPES[type].options) {
    if (!Array.isArray(options)) throw badRequest('Options must be a list');
    options = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)).map((o) => ({ value: String(o?.value ?? '').trim().slice(0, 100), label: String(o?.label ?? o?.value ?? '').trim().slice(0, 150), is_active: o?.is_active !== false }));
    if (options.some((o) => !o.value || !o.label)) throw badRequest('Every option needs a value and a label');
    if (new Set(options.map((o) => o.value)).size !== options.length) throw badRequest('Option values must be different from each other');
    if (!options.some((o) => o.is_active)) throw badRequest('Add at least one option');
  } else options = [];
  const logic = data.conditionalLogic === undefined ? current?.conditional_logic || null : data.conditionalLogic || null;
  if (logic) {
    if (!logic.show_if && !logic.hide_if) throw badRequest('A show / hide rule needs show_if or hide_if');
    if (logic.show_if) checkCondition(logic.show_if, 'show_if');
    if (logic.hide_if) checkCondition(logic.hide_if, 'hide_if');
  }
  const list = (v, cur) => (v === undefined ? cur || [] : [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean))]);
  const states = list(data.applicableStates, current?.applicable_states).map((s) => s.toUpperCase());
  if (states.length) {
    const known = (await pool.query('SELECT state_code FROM states WHERE state_code = ANY($1::text[])', [states])).rows.map((r) => r.state_code);
    const bad = states.filter((s) => !known.includes(s));
    if (bad.length) throw badRequest(`Unknown state code: ${bad.join(', ')}`);
  }
  const roles = list(data.applicableRoles, current?.applicable_roles);
  if (roles.some((r) => !ROLES.includes(r))) throw badRequest(`Roles must be from: ${ROLES.join(', ')}`);
  const row = {
    field_type: type, field_label: label,
    section: String(data.section ?? current?.section ?? 'Additional details').trim().slice(0, 80) || 'Additional details',
    module: data.module === undefined ? current?.module || null : data.module ? String(data.module).trim().slice(0, 40) : null,
    help_text: data.helpText === undefined ? current?.help_text || null : data.helpText ? String(data.helpText).slice(0, 300) : null,
    placeholder: data.placeholder === undefined ? current?.placeholder || null : data.placeholder ? String(data.placeholder).slice(0, 150) : null,
    validation_rules: rules, is_required: data.required === undefined ? !!current?.is_required : !!data.required,
    display_order: data.displayOrder === undefined ? current?.display_order ?? 0 : Number(data.displayOrder) || 0,
    options_json: options, conditional_logic: logic,
    applicable_states: states, applicable_cities: list(data.applicableCities, current?.applicable_cities), applicable_roles: roles,
    is_visible_publicly: data.visiblePublicly === undefined ? !!current?.is_visible_publicly : !!data.visiblePublicly && !PRIVATE_TYPES.includes(type),
    is_searchable: data.searchable === undefined ? !!current?.is_searchable : !!data.searchable,
    is_active: data.active === undefined ? current?.is_active ?? true : !!data.active,
    options_source: source,
    default_value: null,
  };
  // The default has to be a value the field itself would accept.
  const def = data.defaultValue === undefined ? current?.default_value : data.defaultValue;
  if (!empty(def) && !TYPES[type].upload && type !== 'phone' && !source) {
    try {
      row.default_value = TYPES[type].clean(def, { ...row, id: current?.id }, rules);
    } catch (err) {
      throw badRequest(`Default value: ${err.message}`);
    }
  }
  return row;
}

async function listFields({ entityType, includeHidden = true } = {}) {
  const rows = (await allFields()).filter((f) => (!entityType || f.entity_type === entityType) && (includeHidden === true || includeHidden === 'true' || f.is_active));
  const counts = Object.fromEntries((await pool.query(
    `SELECT f.id, (SELECT COUNT(*)::int FROM custom_field_values v WHERE v.entity_type = f.entity_type AND v.field_values ? f.field_name) AS n FROM metadata_fields f ${entityType ? 'WHERE f.entity_type = $1' : ''}`,
    entityType ? [entityType] : []
  )).rows.map((r) => [r.id, r.n]));
  return rows.map((f) => ({ ...view(f), recordsWithValue: counts[f.id] || 0 }));
}

function meta() {
  return {
    entities: Object.entries(ENTITIES).map(([key, e]) => ({ key, label: e.label, inForms: !!e.table || !!e.form, form: e.form || null })),
    types: Object.entries(TYPES).map(([key, t]) => ({ key, label: t.label, hasOptions: !!t.options, isUpload: !!t.upload, neverPublic: PRIVATE_TYPES.includes(key) })),
    roles: ROLES, operators: OPERATORS, validationRules: RULE_KEYS,
    optionSources: Object.entries(SOURCES).map(([key, v]) => ({ key, label: v.label })),
  };
}

// What the Super Admin typed (label, section, help text, option labels) joins
// the translation catalogue of both apps, so it can be translated in Languages.
async function catalogue(row) {
  const strings = [row.field_label, row.section, row.help_text, row.placeholder, ...(row.options_json || []).map((o) => o.label)].filter((x) => typeof x === 'string' && x.trim().length > 1);
  if (!strings.length) return;
  await pool.query(`INSERT INTO i18n_strings (app, source_hash, source_text) SELECT a, md5(x), x FROM unnest($1::text[]) AS x, unnest(ARRAY['website', 'crm']) AS a ON CONFLICT DO NOTHING`, [[...new Set(strings.map((x) => x.trim()))]]).catch((err) => console.error('[fields] catalogue not updated:', err.message));
}

const COLUMNS = ['field_type', 'field_label', 'section', 'module', 'help_text', 'placeholder', 'validation_rules', 'is_required', 'display_order', 'default_value', 'options_json', 'conditional_logic', 'applicable_states', 'applicable_cities', 'applicable_roles', 'is_visible_publicly', 'is_searchable', 'is_active', 'options_source'];
const JSON_COLUMNS = ['validation_rules', 'default_value', 'options_json', 'conditional_logic'];
const dbValue = (col, v) => (JSON_COLUMNS.includes(col) ? (v === null || v === undefined ? null : JSON.stringify(v)) : v);

async function createField(admin, data, meta_ = {}) {
  if (!ENTITIES[data.entityType]) throw badRequest(`Form must be one of: ${Object.keys(ENTITIES).join(', ')}`);
  const row = await fieldInput(data, null);
  const name = String(data.name || row.field_label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!/^[a-z][a-z0-9_]{1,59}$/.test(name)) throw badRequest('The internal name must start with a letter and use only letters, numbers and underscores');
  if (data.displayOrder === undefined) row.display_order = (await pool.query('SELECT COALESCE(MAX(display_order), 0)::int + 10 AS n FROM metadata_fields WHERE entity_type = $1', [data.entityType])).rows[0].n;
  let created;
  try {
    created = (await pool.query(
      `INSERT INTO metadata_fields (entity_type, field_name, ${COLUMNS.join(', ')}, created_by, updated_by) VALUES ($1, $2, ${COLUMNS.map((_, i) => `$${i + 3}`).join(', ')}, $${COLUMNS.length + 3}, $${COLUMNS.length + 3}) RETURNING *`,
      [data.entityType, name, ...COLUMNS.map((c) => dbValue(c, row[c])), admin.id]
    )).rows[0];
  } catch (err) {
    if (err.code === '23505') throw badRequest(`This form already has a field called "${name}"`);
    throw err;
  }
  invalidate();
  await catalogue(created);
  await auditService.log({ actor: admin, action: 'field.created', entityType: 'metadata_field', entityId: created.id, after: view(created), ...meta_ });
  return view(created);
}

async function updateField(admin, id, data, meta_ = {}) {
  const current = (await pool.query('SELECT * FROM metadata_fields WHERE id = $1', [id])).rows[0];
  if (!current) throw notFound('Field not found');
  // A built-in field: how it is presented, and which section of its own form it sits in.
  if (current.is_system) {
    if (data.active === false && current.is_locked) throw badRequest('This field is needed on every record and cannot be hidden');
    const place_ = await systemPlace(current, data);
    const label = data.label === undefined ? current.field_label : String(data.label).trim();
    if (label.length < 2 || label.length > 150) throw badRequest('Give the field a label (2 to 150 characters)');
    const sys = (await pool.query(
      `UPDATE metadata_fields SET field_label = $1, help_text = $2, placeholder = $3, is_required = $4, is_active = $5, updated_by = $6, updated_at = now(), section = $8, display_order = $9 WHERE id = $7 RETURNING *`,
      [label, data.helpText === undefined ? current.help_text : data.helpText ? String(data.helpText).slice(0, 300) : null, data.placeholder === undefined ? current.placeholder : data.placeholder ? String(data.placeholder).slice(0, 150) : null,
        current.is_locked ? true : data.required === undefined ? current.is_required : !!data.required, data.active === undefined ? current.is_active : !!data.active, admin.id, id, place_.section, place_.displayOrder]
    )).rows[0];
    invalidate();
    await catalogue(sys);
    await auditService.log({ actor: admin, action: 'field.updated', entityType: 'metadata_field', entityId: id, before: view(current), after: view(sys), ...meta_ });
    return view(sys);
  }
  // Changing the type would leave stored values that the new type cannot read.
  if (data.type !== undefined && String(data.type).replace('-', '_') !== current.field_type) {
    const used = (await pool.query('SELECT 1 FROM custom_field_values WHERE entity_type = $1 AND field_values ? $2 LIMIT 1', [current.entity_type, current.field_name])).rows.length;
    if (used) throw badRequest('This field already holds values, so its type cannot change. Hide it and add a new field instead.');
  }
  const row = await fieldInput(data, current);
  const updated = (await pool.query(
    `UPDATE metadata_fields SET ${COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_by = $${COLUMNS.length + 1}, updated_at = now() WHERE id = $${COLUMNS.length + 2} RETURNING *`,
    [...COLUMNS.map((c) => dbValue(c, row[c])), admin.id, id]
  )).rows[0];
  invalidate();
  await catalogue(updated);
  await auditService.log({ actor: admin, action: 'field.updated', entityType: 'metadata_field', entityId: id, before: view(current), after: view(updated), ...meta_ });
  return view(updated);
}

// The sections a built-in field can move to: those its form draws.
async function homeSections(entityType) {
  return [...new Set((await systemFields(entityType)).map((f) => f.default_section || f.section))];
}

// Where a built-in field goes: `putBack` returns it to the form's own place;
// a new `section` must be one of its form's sections, and the field goes last there.
async function systemPlace(current, data) {
  if (data.putBack) return { section: current.default_section || current.section, displayOrder: current.default_order ?? current.display_order };
  const section = data.section === undefined ? current.section : String(data.section).trim();
  if (section === current.section) return { section, displayOrder: current.display_order };
  const homes = await homeSections(current.entity_type);
  if (!homes.includes(section)) throw badRequest(`A built-in field can move only to a section of its form: ${homes.join(', ')}`);
  const last = (await pool.query('SELECT MAX(display_order) AS m FROM metadata_fields WHERE entity_type = $1 AND is_system AND section = $2', [current.entity_type, section])).rows[0].m;
  return { section, displayOrder: last === null ? current.display_order : Number(last) + 1 };
}

// Drag-and-drop order: [{ id, displayOrder, section? }].
async function reorder(admin, items, meta_ = {}) {
  if (!Array.isArray(items) || !items.length || items.length > 500) throw badRequest('Send the fields in their new order');
  for (const it of items) {
    // A built-in field can move only among the sections its form draws.
    await pool.query(
      `UPDATE metadata_fields f SET display_order = $1, updated_by = $3, updated_at = now(),
         section = CASE WHEN NOT f.is_system THEN COALESCE($2, f.section)
                        WHEN $2 IN (SELECT COALESCE(h.default_section, h.section) FROM metadata_fields h WHERE h.entity_type = f.entity_type AND h.is_system) THEN $2
                        ELSE f.section END
       WHERE f.id = $4`,
      [Number(it.displayOrder) || 0, it.section ? String(it.section).trim().slice(0, 80) : null, admin.id, it.id]
    );
  }
  invalidate();
  await auditService.log({ actor: admin, action: 'field.reordered', entityType: 'metadata_field', entityId: null, after: { fields: items.length }, ...meta_ });
  return { reordered: items.length };
}

// A field that already holds values is hidden, never deleted.
async function deleteField(admin, id, meta_ = {}) {
  const f = (await pool.query('SELECT * FROM metadata_fields WHERE id = $1', [id])).rows[0];
  if (!f) throw notFound('Field not found');
  if (f.is_system) throw badRequest('A built-in field cannot be deleted. Hide it instead.');
  if ((await pool.query('SELECT 1 FROM custom_field_values WHERE entity_type = $1 AND field_values ? $2 LIMIT 1', [f.entity_type, f.field_name])).rows.length) {
    throw badRequest('Records already hold a value for this field. Hide it instead - the values are kept.');
  }
  await pool.query('DELETE FROM metadata_fields WHERE id = $1', [id]);
  invalidate();
  await auditService.log({ actor: admin, action: 'field.deleted', entityType: 'metadata_field', entityId: id, before: view(f), ...meta_ });
  return { deleted: true };
}

// ------------------------------------------------------------ where a field applies

let geoCache = new Map();
// The state a city belongs to, from the geographic master data.
async function locate(city) {
  const key = String(city || '').trim().toLowerCase();
  if (!key) return { stateCode: null, cityKeys: [] };
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 300000) return hit.value;
  const r = (await pool.query(`SELECT c.id::text AS id, c.city_name, c.slug, s.state_code FROM cities c JOIN states s ON s.id = c.state_id WHERE lower(c.city_name) = $1 OR lower(c.slug) = $1 LIMIT 1`, [key])).rows[0];
  const value = { stateCode: r?.state_code || null, cityKeys: [key, r?.slug, r?.city_name, r?.id].filter(Boolean).map((x) => String(x).toLowerCase()) };
  geoCache.set(key, { at: Date.now(), value });
  if (geoCache.size > 2000) geoCache = new Map();
  return value;
}

async function place({ city, state }) {
  const p = await locate(city);
  return { stateCode: state ? String(state).toUpperCase() : p.stateCode, cityKeys: p.cityKeys };
}

function applies(f, ctx) {
  if (ctx.module && f.module && f.module !== ctx.module) return false;
  if ((f.applicable_states || []).length && !f.applicable_states.includes(ctx.stateCode)) return false;
  if ((f.applicable_cities || []).length && !f.applicable_cities.some((c) => (ctx.cityKeys || []).includes(String(c).toLowerCase()))) return false;
  if ((f.applicable_roles || []).length && !f.applicable_roles.includes(ctx.role)) return false;
  return true;
}

function test(c, values) {
  if (!c) return true;
  if (Array.isArray(c.all)) return c.all.every((x) => test(x, values));
  if (Array.isArray(c.any)) return c.any.some((x) => test(x, values));
  const v = values[c.field];
  const same = (a, b) => String(a) === String(b);
  switch (c.operator) {
    case 'equals': return Array.isArray(v) ? v.some((x) => same(x, c.value)) : same(v ?? '', c.value ?? '');
    case 'not_equals': return Array.isArray(v) ? !v.some((x) => same(x, c.value)) : !same(v ?? '', c.value ?? '');
    case 'in': return (Array.isArray(c.value) ? c.value : [c.value]).some((x) => (Array.isArray(v) ? v.some((y) => same(y, x)) : same(v, x)));
    case 'not_in': return !(Array.isArray(c.value) ? c.value : [c.value]).some((x) => (Array.isArray(v) ? v.some((y) => same(y, x)) : same(v, x)));
    case 'gt': return Number(v) > Number(c.value);
    case 'lt': return Number(v) < Number(c.value);
    case 'is_set': return !empty(v) && v !== false;
    case 'is_empty': return empty(v) || v === false;
    default: return true;
  }
}
// Shown, given what else is on the form?
const shown = (f, values) => {
  const l = f.conditional_logic;
  if (!l) return true;
  if (l.show_if && !test(l.show_if, values)) return false;
  if (l.hide_if && test(l.hide_if, values)) return false;
  return true;
};

// ------------------------------------------------------------ the form

// The fields to draw for one form, for this place and this person.
async function form({ entityType, module, city, state, role } = {}) {
  if (!ENTITIES[entityType]) throw badRequest(`entityType must be one of: ${Object.keys(ENTITIES).join(', ')}`);
  const ctx = { ...(await place({ city, state })), role: role || null, module: module || null };
  const fields = (await activeFields(entityType)).filter((f) => applies(f, ctx));
  const sections = [];
  for (const raw of fields) {
    const f = await withOptions(raw, city);
    let s = sections.find((x) => x.name === f.section);
    if (!s) sections.push((s = { name: f.section, fields: [] }));
    const v = view(f);
    s.fields.push({ id: v.id, name: v.name, label: v.label, type: v.type, helpText: v.helpText, placeholder: v.placeholder, required: v.required, validation: v.validation, defaultValue: v.defaultValue, options: v.options.filter((o) => o.is_active !== false).map((o) => ({ value: o.value, label: o.label })), conditionalLogic: v.conditionalLogic, searchable: v.searchable });
  }
  // How the built-in fields are presented: { <key>: { label, helpText, required, hidden } }.
  // `order` is set only once the Super Admin has moved a built-in field: the
  // forms then lay their built-in fields out in that order.
  const core = {};
  const system = await systemFields(entityType);
  // `section` is set only for a field moved out of the section its form draws it in.
  const moved = system.some((f) => (f.default_order !== null && f.display_order !== f.default_order) || (f.default_section && f.section !== f.default_section));
  for (const f of system) {
    core[f.core_key] = {
      label: f.field_label, relabelled: f.field_label !== f.default_label, helpText: f.help_text, placeholder: f.placeholder, required: f.is_required, hidden: !f.is_active, locked: f.is_locked,
      order: moved ? f.display_order : null, section: f.default_section && f.section !== f.default_section ? f.section : null,
    };
  }
  return { entityType, stateCode: ctx.stateCode, sections, count: fields.length, core };
}

// Check what was entered. `partial` (an edit) only looks at the fields sent.
// `core` is the rest of the form, so a rule can look at a built-in field.
async function validate(entityType, input, { city, state, role, core = {}, partial = false, existing = {} } = {}) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) throw unprocessable('Validation failed', [{ field: 'customFields', message: 'customFields must be an object of field name to value' }]);
  const values = input || {};
  const ctx = { ...(await place({ city, state })), role: role || null };
  const fields = (await activeFields(entityType)).filter((f) => applies(f, ctx));
  const known = new Set(fields.map((f) => f.field_name));
  const errors = Object.keys(values).filter((k) => !known.has(k)).map((k) => ({ field: k, message: 'This field is not part of this form here' }));
  const out = {};
  const all = { ...core, ...existing, ...values };
  for (const f of fields) {
    const sent = Object.prototype.hasOwnProperty.call(values, f.field_name);
    if (partial && !sent) continue;
    const raw = values[f.field_name];
    const rules = f.validation_rules || {};
    if (!shown(f, all)) continue;
    // A phone the screen only ever saw masked comes back untouched.
    if (f.field_type === 'phone' && raw && typeof raw === 'object' && raw.unchanged) continue;
    if (empty(raw)) {
      const required = f.is_required || (rules.required_if && test(rules.required_if, all));
      if (required && (f.field_type !== 'phone' || !existing[f.field_name])) errors.push({ field: f.field_name, message: `${f.field_label} is required` });
      else if (sent) out[f.field_name] = null;
      else if (!partial && !empty(f.default_value)) out[f.field_name] = f.default_value;
      continue;
    }
    try {
      out[f.field_name] = TYPES[f.field_type].clean(raw, await withOptions(f, city), rules);
    } catch (err) {
      errors.push({ field: f.field_name, message: `${f.field_label}: ${err.message}` });
    }
  }
  // Built-in fields the Super Admin made required (the ones every record needs are checked by the form's own rules).
  if (!partial) {
    for (const f of await systemFields(entityType)) {
      if (f.is_active && f.is_required && !f.is_locked && empty(core[f.core_key])) errors.push({ field: f.core_key, message: `${f.field_label} is required` });
    }
  }
  if (errors.length) throw unprocessable('Validation failed', errors);
  return out;
}

// Required added fields a record has no value for - records that did not come
// through a form (WhatsApp, lead ingestion, bulk import) can be created without them.
async function missing(entityType, entityId, { city, state, role, core = {} } = {}) {
  const fields = await activeFields(entityType);
  if (!fields.some((f) => f.is_required || f.validation_rules?.required_if)) return [];
  const where = city ? { city } : await recordPlace(entityType, entityId);
  const ctx = { ...(await place({ city: where.city, state })), role: role || null };
  const values = await stored(entityType, entityId);
  const all = { ...core, ...values };
  return fields
    .filter((f) => !(f.applicable_roles || []).length && applies(f, ctx) && shown(f, all) && (f.is_required || (f.validation_rules?.required_if && test(f.validation_rules.required_if, all))) && empty(values[f.field_name]))
    .map((f) => ({ name: f.field_name, label: f.field_label }));
}

async function stored(entityType, entityId) {
  return (await pool.query('SELECT field_values FROM custom_field_values WHERE entity_type = $1 AND entity_id = $2', [entityType, entityId])).rows[0]?.field_values || {};
}

async function save(entityType, entityId, cleaned, userId) {
  if (!cleaned || !Object.keys(cleaned).length) return;
  await pool.query(
    `INSERT INTO custom_field_values (entity_type, entity_id, field_values, updated_by) VALUES ($1, $2, jsonb_strip_nulls($3::jsonb), $4)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET field_values = jsonb_strip_nulls(custom_field_values.field_values || $3::jsonb), updated_by = $4, updated_at = now()`,
    [entityType, entityId, JSON.stringify(cleaned), userId || null]
  );
}

// How a stored value is shown to this person.
async function present(f, value, { full, staff }) {
  if (f.field_type === 'phone') return full && staff ? { countryCode: value.cc, number: decrypt(value.enc), masked: false } : { countryCode: value.cc, number: `••••••${value.last4}`, masked: true };
  if (TYPES[f.field_type]?.upload) {
    const one = async (x) => ({ ...x, url: await getReadUrl(x.path).catch(() => null) });
    return Array.isArray(value) ? Promise.all(value.map(one)) : one(value);
  }
  return value;
}
function displayText(f, value) {
  const label = (v) => (f.options_json || []).find((o) => String(o.value) === String(v))?.label || String(v);
  switch (f.field_type) {
    case 'checkbox': return value ? 'Yes' : 'No';
    case 'dropdown': return label(value);
    case 'multiselect': return (value || []).map(label).join(', ');
    case 'address': return [value.line1, value.line2, value.city, value.state, value.pincode].filter(Boolean).join(', ');
    case 'geo_point': return `${value.lat}, ${value.lng}`;
    case 'phone': return `${value.countryCode} ${value.number}`;
    case 'rating': return `${value} / ${Number(f.validation_rules?.max) || 5}`;
    case 'file': case 'image': return (Array.isArray(value) ? value : [value]).map((x) => x.name).join(', ');
    default: return String(value);
  }
}

// A record's values. mode 'public' keeps only what may appear on a public page.
async function read(entityType, entityId, { mode = 'full', role = null, city, state } = {}) {
  const values = await stored(entityType, entityId);
  if (!Object.keys(values).length) return { values: {}, list: [] };
  const ctx = { ...(await place({ city, state })), role };
  const staff = STAFF.includes(role);
  const full = mode === 'full';
  const list = [];
  const out = {};
  for (const f of await activeFields(entityType)) {
    const v = values[f.field_name];
    if (empty(v) && v !== false) continue;
    if (!full && (!f.is_visible_publicly || PRIVATE_TYPES.includes(f.field_type))) continue;
    if ((f.applicable_roles || []).length && !staff && !f.applicable_roles.includes(ctx.role)) continue;
    const shownValue = await present(f, v, { full, staff });
    out[f.field_name] = shownValue;
    list.push({ name: f.field_name, label: f.field_label, type: f.field_type, section: f.section, value: shownValue, display: displayText(f, shownValue) });
  }
  return { values: out, list };
}

// Search filters: ?cf_<field name>=value, for fields marked searchable. Returns
// one JSON probe per filter; searchSql() turns a probe into a WHERE clause.
async function searchProbes(entityType, query) {
  if (!query || typeof query !== 'object') return [];
  const keys = Object.keys(query).filter((k) => k.startsWith('cf_'));
  if (!keys.length) return [];
  const fields = (await activeFields(entityType)).filter((f) => f.is_searchable);
  const out = [];
  for (const key of keys) {
    const name = key.slice(3);
    const raw = query[key];
    const f = fields.find((x) => x.field_name === name);
    if (!f || empty(raw)) continue;
    let probe;
    if (f.field_type === 'multiselect') probe = { [name]: String(raw).split(',').map((x) => x.trim()).filter(Boolean) };
    else if (f.field_type === 'checkbox') probe = { [name]: raw === true || raw === 'true' };
    else if (['number', 'decimal', 'currency', 'rating'].includes(f.field_type)) probe = { [name]: Number(raw) };
    else probe = { [name]: String(raw) };
    out.push(JSON.stringify(probe));
  }
  return out;
}
// `alias` is the record's table name or alias in the query; the probe goes in as a parameter.
const searchSql = (entityType, alias, paramIndex) =>
  `EXISTS (SELECT 1 FROM custom_field_values cfv WHERE cfv.entity_type = '${ENTITIES[entityType] ? entityType : 'property'}' AND cfv.entity_id = ${alias}.id AND cfv.field_values @> $${paramIndex}::jsonb)`;

// ------------------------------------------------------------ uploads

async function uploadFile(user, fieldId, file) {
  const f = (await allFields()).find((x) => x.id === fieldId && x.is_active);
  if (!f || !TYPES[f.field_type]?.upload) throw notFound('Upload field not found');
  if (!file) throw badRequest('Choose a file');
  const rules = f.validation_rules || {};
  const d = FILE_DEFAULTS[f.field_type];
  const types = Array.isArray(rules.accepted_file_types) && rules.accepted_file_types.length ? rules.accepted_file_types : d.types;
  const ext = String(file.originalname || '').split('.').pop().toLowerCase();
  if (!types.some((t) => t === file.mimetype || String(t).replace(/^\./, '').toLowerCase() === ext)) throw badRequest(`This file type is not accepted for ${f.field_label}`);
  const max = Number(rules.max_file_size) || d.size;
  if (file.size > max) throw badRequest(`The file is larger than ${Math.round(max / 1048576)} MB`);
  let buffer = file.buffer;
  let mime = file.mimetype;
  let name = file.originalname;
  if (f.field_type === 'image') {
    // Auto-compression: long edge 1920 px, JPEG quality 80 (WEBP is kept as it is).
    try {
      if (mime !== 'image/webp') {
        const { Jimp } = require('jimp');
        const img = await Jimp.read(buffer);
        if (Math.max(img.bitmap.width, img.bitmap.height) > 1920) img.scaleToFit({ w: 1920, h: 1920 });
        buffer = await img.getBuffer('image/jpeg', { quality: 80 });
        mime = 'image/jpeg';
        name = name.replace(/\.[a-z0-9]+$/i, '.jpg');
      }
    } catch {
      throw badRequest('This image could not be read');
    }
  }
  const folder = `custom-fields/${f.id}/${user.id}`;
  const path = !process.env.GCS_BUCKET_NAME && process.env.NODE_ENV !== 'production' ? `not-stored/${folder}/${name}` : await uploadBuffer(buffer, folder, name, mime);
  return { path, name: String(name).slice(0, 200), size: buffer.length, mime, url: await getReadUrl(path).catch(() => null) };
}

// ------------------------------------------------------------ route helpers

// Where the record is, for fields that only apply in some states or cities.
async function recordPlace(entityType, id, body) {
  const e = ENTITIES[entityType];
  if (body?.city) return { city: body.city };
  if (!id || !e?.table || !e.city) return {};
  const r = (await pool.query(`SELECT ${e.city} AS city FROM ${e.table} WHERE id = $1`, [id]).catch(() => ({ rows: [] }))).rows[0];
  return { city: r?.city };
}

// On a route that creates or edits a record: validates body.customFields before
// the handler runs, stores them once it has succeeded, and adds them to the reply.
//   recordId(req)  the record a form fills in, when it is not req.params.id
//                  (e.g. the user for KYC, the deal for an agreement)
//   complete       every required field must be filled in, as on a new record
// A multipart form sends customFields as a JSON string.
const capture = (entityType, { create = false, idFrom = (data) => data?.id, recordId, complete = false } = {}) => async (req, res, next) => {
  try {
    if (typeof req.body?.customFields === 'string') {
      try {
        req.body.customFields = JSON.parse(req.body.customFields || '{}');
      } catch {
        throw badRequest('customFields must be JSON');
      }
    }
    const whole = create || complete;
    const builtInRules = create && (await systemFields(entityType)).some((f) => f.is_active && f.is_required && !f.is_locked);
    if (!(await activeFields(entityType)).length && !builtInRules) return next();
    if (req.body?.customFields === undefined && !whole) return next();
    const id = create ? null : recordId ? recordId(req) : req.params.id;
    if (!create && !id) return next();
    const where = await recordPlace(entityType, id, req.body);
    const role = req.user?.role || null;
    const cleaned = await validate(entityType, req.body?.customFields, { ...where, role, core: req.body || {}, partial: !whole, existing: id ? await stored(entityType, id) : {} });
    const json = res.json.bind(res);
    res.json = (payload) => {
      const targetId = id || idFrom(payload?.data);
      if (res.statusCode >= 400 || !targetId || !payload?.data) return json(payload);
      save(entityType, targetId, cleaned, req.user?.id)
        .then(() => read(entityType, targetId, { mode: 'full', role, ...where }))
        .then((cf) => json({ ...payload, data: { ...payload.data, customFields: cf.values, customFieldList: cf.list } }))
        .catch((err) => {
          console.error('[fields] values not saved:', err.message);
          json(payload);
        });
      return res;
    };
    return next();
  } catch (err) {
    return next(err);
  }
};

// On a route that returns one record: adds its custom fields. Staff, partners
// and the record's own creator get everything; anyone else only the public ones.
const expose = (entityType, { mode = 'auto', idFrom = (data) => data?.id, fullWhen } = {}) => async (req, res, next) => {
  try {
    if (!(await activeFields(entityType)).length) return next();
    const json = res.json.bind(res);
    res.json = (payload) => {
      const data = payload?.data;
      const recordId = data ? idFrom(data, req) : null;
      if (res.statusCode >= 400 || !recordId) return json(payload);
      const role = req.user?.role || null;
      const mine = req.user && [data.created_by, data.createdBy, data.user_id, data.seller_user_id].includes(req.user.id);
      const full = mode === 'full' || (fullWhen ? !!fullWhen(data, req) : mode === 'auto' && req.user && (role !== 'customer' || mine));
      Promise.all([read(entityType, recordId, { mode: full ? 'full' : 'public', role, city: data.city }), full ? missing(entityType, recordId, { city: data.city, core: data }) : []])
        .then(([cf, gaps]) => json({ ...payload, data: { ...data, customFields: cf.values, customFieldList: cf.list, customFieldsMissing: gaps } }))
        .catch((err) => {
          console.error('[fields] values not read:', err.message);
          json(payload);
        });
      return res;
    };
    return next();
  } catch (err) {
    return next(err);
  }
};

// Staff: read or set the values of any record (KYC, due diligence, agreements, profiles).
// Anyone may see and fill in the added fields of their own profile.
const mayUseValues = (user, entityType, entityId) => STAFF.includes(user.role) || (entityType === 'user_profile' && entityId === user.id);
async function getValues(user, entityType, entityId) {
  if (!ENTITIES[entityType]) throw badRequest('Unknown form');
  if (!mayUseValues(user, entityType, entityId)) throw forbidden();
  return read(entityType, entityId, { mode: 'full', role: user.role, ...(await recordPlace(entityType, entityId)) });
}
async function setValues(user, entityType, entityId, body = {}, meta_ = {}) {
  if (!ENTITIES[entityType]) throw badRequest('Unknown form');
  if (!mayUseValues(user, entityType, entityId)) throw forbidden();
  const where = body.city ? { city: body.city } : await recordPlace(entityType, entityId);
  const cleaned = await validate(entityType, body.customFields || {}, { ...where, state: body.state, role: user.role, partial: true, existing: await stored(entityType, entityId) });
  await save(entityType, entityId, cleaned, user.id);
  await auditService.log({ actor: user, action: 'field.values_saved', entityType, entityId, after: { fields: Object.keys(cleaned) }, ...meta_ });
  return read(entityType, entityId, { mode: 'full', role: user.role, ...where });
}

module.exports = {
  ENTITIES, TYPES, ROLES, registerType, meta, homeSections, listFields, createField, updateField, reorder, deleteField,
  form, validate, missing, save, read, stored, searchProbes, searchSql, uploadFile, capture, expose, getValues, setValues, invalidate,
};
