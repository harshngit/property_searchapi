const pool = require('../config/db');
const auditService = require('./audit.service');
const storage = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Super Admin site configuration (migration 076): the dropdown lists and the
// editable text of the dashboard and the website.
//   Lists    A list whose values the backend validates (extensible = false)
//            keeps exactly its seeded values: the Super Admin renames, hides
//            and reorders them. Other lists also take new values or lose old
//            ones. At least one option stays visible.
//   Content  text, links, email, phone and images; an empty value falls back
//            to the default. Images live in the private bucket and are signed
//            when read.
// The public read is cached for a minute and dropped on every change.

const APPS = ['dashboard', 'website'];
const CACHE_MS = 60 * 1000;
const cache = new Map();
const invalidate = () => cache.clear();

const requireSuperAdmin = (admin) => {
  if (admin?.role !== 'super_admin') throw forbidden('Only the Super Admin changes the site configuration');
};

const listView = (r) => ({
  key: r.list_key,
  app: r.app,
  label: r.label,
  usedIn: r.used_in,
  extensible: r.extensible,
  options: r.options,
  customised: JSON.stringify(r.options) !== JSON.stringify(r.defaults),
  updatedAt: r.updated_at,
  updatedBy: r.updated_by_name || null,
});

const contentView = (r) => ({
  key: r.content_key,
  app: r.app,
  section: r.section,
  label: r.label,
  kind: r.kind,
  value: r.value,
  defaultValue: r.default_value,
  maxLength: r.max_length,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by_name || null,
});

// What an app reads on start: visible options in order, and each content value.
async function publicConfig(app) {
  if (!APPS.includes(app)) throw badRequest(`app must be one of: ${APPS.join(', ')}`);
  const hit = cache.get(app);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.data;
  const [lists, content] = await Promise.all([
    pool.query('SELECT list_key, options FROM site_option_lists WHERE app = $1', [app]),
    pool.query('SELECT content_key, kind, value, default_value FROM site_content WHERE app = $1', [app]),
  ]);
  const options = {};
  for (const r of lists.rows) {
    options[r.list_key.slice(app.length + 1)] = r.options
      .filter((o) => o.active !== false)
      .map(({ value, label, min, max }) => ({ value, label, ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) }));
  }
  const values = {};
  for (const r of content.rows) {
    const v = r.value != null && r.value !== '' ? r.value : r.default_value;
    values[r.content_key.slice(app.length + 1)] = r.kind === 'image' && v ? await storage.getReadUrl(v).catch(() => null) : v;
  }
  const data = { app, options, content: values };
  cache.set(app, { at: Date.now(), data });
  return data;
}

async function manage() {
  const [lists, content] = await Promise.all([
    pool.query(`SELECT l.*, u.full_name AS updated_by_name FROM site_option_lists l LEFT JOIN users u ON u.id = l.updated_by ORDER BY l.app, l.label`),
    pool.query(`SELECT c.*, u.full_name AS updated_by_name FROM site_content c LEFT JOIN users u ON u.id = c.updated_by ORDER BY c.app, c.section, c.content_key`),
  ]);
  const items = await Promise.all(content.rows.map(async (r) => {
    const view = contentView(r);
    if (r.kind === 'image' && r.value) view.previewUrl = await storage.getReadUrl(r.value).catch(() => null);
    return view;
  }));
  return { lists: lists.rows.map(listView), content: items };
}

function cleanOptions(input, row) {
  if (!Array.isArray(input) || !input.length) throw badRequest('Give the list of options');
  if (input.length > 200) throw badRequest('A list holds at most 200 options');
  const seen = new Set();
  const out = input.map((o, i) => {
    const value = String(o?.value ?? '').trim();
    const label = String(o?.label ?? '').trim();
    if (!value || value.length > 100) throw badRequest(`Option ${i + 1}: the value must be 1-100 characters`);
    if (!label || label.length > 120) throw badRequest(`Option ${i + 1}: the label must be 1-120 characters`);
    if (seen.has(value)) throw badRequest(`"${value}" appears twice`);
    seen.add(value);
    const opt = { value, label, active: o.active !== false };
    for (const k of ['min', 'max']) {
      if (o[k] === undefined || o[k] === null || o[k] === '') continue;
      const n = Number(o[k]);
      if (!Number.isFinite(n) || n < 0) throw badRequest(`Option ${i + 1}: ${k} must be a number`);
      opt[k] = n;
    }
    if (opt.min != null && opt.max != null && opt.min >= opt.max) throw badRequest(`Option ${i + 1}: min must be below max`);
    return opt;
  });
  if (!out.some((o) => o.active)) throw badRequest('Keep at least one option visible');
  if (!row.extensible) {
    const fixed = row.defaults.map((o) => o.value).sort();
    const given = out.map((o) => o.value).sort();
    if (JSON.stringify(fixed) !== JSON.stringify(given)) {
      throw badRequest('The system reads these values, so they can be renamed, hidden or reordered but not added or removed');
    }
  }
  return out;
}

async function saveList(admin, key, options, meta = {}) {
  requireSuperAdmin(admin);
  const row = (await pool.query('SELECT * FROM site_option_lists WHERE list_key = $1', [key])).rows[0];
  if (!row) throw notFound('No such list');
  const next = cleanOptions(options, row);
  const r = (await pool.query(
    'UPDATE site_option_lists SET options = $2::jsonb, updated_by = $3, updated_at = now() WHERE list_key = $1 RETURNING *',
    [key, JSON.stringify(next), admin.id]
  )).rows[0];
  await auditService.log({ actor: admin, action: 'site_config.list_updated', entityType: 'site_option_list', entityId: null, before: { key, options: row.options }, after: { key, options: next }, ...meta });
  invalidate();
  return listView(r);
}

async function resetList(admin, key, meta = {}) {
  requireSuperAdmin(admin);
  const row = (await pool.query('SELECT * FROM site_option_lists WHERE list_key = $1', [key])).rows[0];
  if (!row) throw notFound('No such list');
  const r = (await pool.query('UPDATE site_option_lists SET options = defaults, updated_by = $2, updated_at = now() WHERE list_key = $1 RETURNING *', [key, admin.id])).rows[0];
  await auditService.log({ actor: admin, action: 'site_config.list_reset', entityType: 'site_option_list', entityId: null, before: { key, options: row.options }, after: { key, options: r.options }, ...meta });
  invalidate();
  return listView(r);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{6,20}$/;
const URL_RE = /^(https?:\/\/[^\s]+|\/[^\s]*)$/i;

function checkValue(row, value) {
  if (value === null || value === undefined || String(value).trim() === '') return null; // back to the default
  const v = String(value).trim();
  if (v.length > row.max_length) throw badRequest(`Keep it within ${row.max_length} characters`);
  if (row.kind === 'email' && !EMAIL_RE.test(v)) throw badRequest('Give a valid email address');
  if (row.kind === 'phone' && !PHONE_RE.test(v)) throw badRequest('Give a valid phone number');
  if (row.kind === 'url' && !URL_RE.test(v)) throw badRequest('Give a link starting with https:// or a site path starting with /');
  if (row.kind === 'image') throw badRequest('Upload the image file instead');
  return v;
}

async function writeContent(admin, row, value, meta) {
  const r = (await pool.query(
    'UPDATE site_content SET value = $2, updated_by = $3, updated_at = now() WHERE content_key = $1 RETURNING *',
    [row.content_key, value, admin.id]
  )).rows[0];
  await auditService.log({ actor: admin, action: 'site_config.content_updated', entityType: 'site_content', entityId: null, before: { key: row.content_key, value: row.value }, after: { key: row.content_key, value }, ...meta });
  invalidate();
  const view = contentView(r);
  if (r.kind === 'image' && r.value) view.previewUrl = await storage.getReadUrl(r.value).catch(() => null);
  return view;
}

async function contentRow(key) {
  const row = (await pool.query('SELECT * FROM site_content WHERE content_key = $1', [key])).rows[0];
  if (!row) throw notFound('No such content item');
  return row;
}

async function saveContent(admin, key, value, meta = {}) {
  requireSuperAdmin(admin);
  const row = await contentRow(key);
  // An image is cleared through here (value empty) and set through the upload.
  const v = row.kind === 'image' && (value === null || value === '' || value === undefined) ? null : checkValue(row, value);
  return writeContent(admin, row, v, meta);
}

async function uploadContentImage(admin, key, file, meta = {}) {
  requireSuperAdmin(admin);
  const row = await contentRow(key);
  if (row.kind !== 'image') throw badRequest('This item is not an image');
  if (!file) throw badRequest('Attach the image file');
  if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.mimetype)) throw badRequest('Upload a PNG, JPG, WebP, GIF or SVG image');
  const objectPath = await storage.uploadBuffer(file.buffer, 'site-content', file.originalname, file.mimetype);
  return writeContent(admin, row, objectPath, meta);
}

module.exports = { APPS, publicConfig, manage, saveList, resetList, saveContent, uploadContentImage, invalidate };
