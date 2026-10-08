const crypto = require('crypto');
const pool = require('../config/db');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 30 - Localization & Multi-Language.
//
// English is the source language. A translation is keyed by the English
// text itself, per app (website / crm): the apps swap any interface text
// they find in the bundle and leave everything else (listing titles, names,
// anything typed by a user) exactly as it is. A string with no translation
// shows in English, so a language can go live partly translated.
//
// Adding a language is self-serve: switch it on, download the template
// (every catalogued string), fill it in, upload it.

const ADMIN = ['admin', 'super_admin'];
const APPS = ['website', 'crm'];
const hash = (s) => crypto.createHash('md5').update(s).digest('hex');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const assertApp = (app) => {
  if (!APPS.includes(app)) throw badRequest('app must be website or crm');
};

const bundles = new Map(); // `${lang}|${app}` -> { etag, body }
const invalidate = () => bundles.clear();

async function activeLanguages() {
  const r = await pool.query('SELECT code, name, native_name FROM languages WHERE is_active ORDER BY sort_order');
  return r.rows.map((l) => ({ code: l.code, name: l.name, nativeName: l.native_name }));
}

async function language(code) {
  const l = (await pool.query('SELECT * FROM languages WHERE code = $1', [code])).rows[0];
  if (!l) throw notFound('Language not found');
  return l;
}

// What the apps load: { "English text": "translated text" } for one language.
async function bundle(code, app) {
  assertApp(app);
  const key = `${code}|${app}`;
  if (bundles.has(key)) return bundles.get(key);
  const l = (await pool.query('SELECT code, is_active, is_source FROM languages WHERE code = $1', [code])).rows[0];
  const strings = {};
  if (l && l.is_active && !l.is_source) {
    const r = await pool.query('SELECT source_text, value FROM translations WHERE language_code = $1 AND app = $2', [code, app]);
    for (const t of r.rows) strings[t.source_text] = t.value;
  }
  const body = { language: code, app, strings };
  const out = { etag: `"${hash(JSON.stringify(body))}"`, body };
  bundles.set(key, out);
  return out;
}

async function setPreference(user, code) {
  const l = (await pool.query('SELECT code FROM languages WHERE code = $1 AND is_active', [code])).rows[0];
  if (!l) throw badRequest('That language is not available');
  await pool.query('UPDATE users SET preferred_language = $1 WHERE id = $2', [code, user.id]);
  return { language: code };
}

async function preference(user) {
  const r = (await pool.query('SELECT u.preferred_language FROM users u JOIN languages l ON l.code = u.preferred_language AND l.is_active WHERE u.id = $1', [user.id])).rows[0];
  return { language: r?.preferred_language || null };
}

// ------------------------------------------------------------ admin

async function overview() {
  const langs = (await pool.query('SELECT * FROM languages ORDER BY sort_order')).rows;
  const totals = (await pool.query('SELECT app, COUNT(*)::int AS n FROM i18n_strings GROUP BY 1')).rows;
  const done = (
    await pool.query(
      `SELECT t.language_code, t.app, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE t.is_machine)::int AS machine
       FROM translations t JOIN i18n_strings s ON s.app = t.app AND s.source_hash = t.source_hash GROUP BY 1, 2`
    )
  ).rows;
  const total = (app) => totals.find((t) => t.app === app)?.n || 0;
  return {
    apps: APPS.map((app) => ({ app, strings: total(app) })),
    aiAvailable: !!process.env.ANTHROPIC_API_KEY,
    languages: langs.map((l) => ({
      code: l.code, name: l.name, nativeName: l.native_name, isActive: l.is_active, isSource: l.is_source,
      coverage: APPS.map((app) => {
        const d = done.find((x) => x.language_code === l.code && x.app === app);
        const n = l.is_source ? total(app) : d?.n || 0;
        return { app, translated: n, total: total(app), percent: total(app) ? Math.round((n / total(app)) * 100) : 0, machine: d?.machine || 0 };
      }),
    })),
  };
}

async function saveLanguage(admin, data, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  const code = String(data.code || '').trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(code)) throw badRequest('Use a language code such as hi, mr or ta');
  const existing = (await pool.query('SELECT * FROM languages WHERE code = $1', [code])).rows[0];
  if (existing?.is_source && data.isActive === false) throw badRequest('English is the source language and stays on');
  if (!existing && (!data.name || !data.nativeName)) throw badRequest('Give the language name in English and in its own script');
  const args = [code, data.name ? clean(data.name).slice(0, 60) : null, data.nativeName ? clean(data.nativeName).slice(0, 60) : null, data.isActive === undefined ? null : !!data.isActive, admin.id];
  const r = existing
    ? await pool.query('UPDATE languages SET name = COALESCE($2, name), native_name = COALESCE($3, native_name), is_active = COALESCE($4, is_active), updated_by = $5, updated_at = now() WHERE code = $1 RETURNING *', args)
    : await pool.query('INSERT INTO languages (code, name, native_name, is_active, sort_order, updated_by) VALUES ($1, $2, $3, COALESCE($4, false), (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM languages), $5) RETURNING *', args);
  invalidate();
  await auditService.log({ actor: admin, action: existing ? 'i18n.language_updated' : 'i18n.language_added', entityType: 'language', entityId: null, after: { code, isActive: r.rows[0].is_active }, ...meta });
  return r.rows[0];
}

// The catalogue with this language's translation beside each string.
async function strings({ language: code, app, filter = 'all', search, page = 1, limit = 50 }) {
  assertApp(app);
  await language(code);
  const where = ['s.app = $2'];
  const params = [code, app];
  if (filter === 'missing') where.push('t.value IS NULL');
  if (filter === 'translated') where.push('t.value IS NOT NULL');
  if (filter === 'machine') where.push('t.is_machine');
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where.push(`(lower(s.source_text) LIKE $${params.length} OR lower(t.value) LIKE $${params.length})`);
  }
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const from = `FROM i18n_strings s LEFT JOIN translations t ON t.app = s.app AND t.source_hash = s.source_hash AND t.language_code = $1 WHERE ${where.join(' AND ')}`;
  const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from}`, params)).rows[0].n;
  const rows = (await pool.query(`SELECT s.source_hash, s.source_text, t.value, COALESCE(t.is_machine, false) AS is_machine ${from} ORDER BY (t.value IS NULL) DESC, length(s.source_text), s.source_text LIMIT ${size} OFFSET ${(Math.max(Number(page) || 1, 1) - 1) * size}`, params)).rows;
  return { total, page: Math.max(Number(page) || 1, 1), limit: size, items: rows.map((r) => ({ hash: r.source_hash, source: r.source_text, value: r.value, isMachine: r.is_machine })) };
}

// Save translations given as { "English text": "translation" }. An empty
// value removes the translation. Unknown source strings join the catalogue,
// so text added by a later release can be translated before it is extracted.
async function upsert(admin, { language: code, app, entries, machine = false }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  assertApp(app);
  const l = await language(code);
  if (l.is_source) throw badRequest('English is the source language - translate into another language');
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw badRequest('Send translations as { "English text": "translation" }');
  const pairs = Object.entries(entries).map(([k, v]) => [clean(k), v === null || v === undefined ? '' : String(v).trim()]).filter(([k]) => k && k.length <= 2000);
  if (!pairs.length) throw badRequest('Nothing to save');
  if (pairs.length > 20000) throw badRequest('Too many strings in one upload');
  let saved = 0;
  let removed = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [source, value] of pairs) {
      const h = hash(source);
      if (!value) {
        removed += (await client.query('DELETE FROM translations WHERE language_code = $1 AND app = $2 AND source_hash = $3', [code, app, h])).rowCount;
        continue;
      }
      await client.query('INSERT INTO i18n_strings (app, source_hash, source_text) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [app, h, source]);
      await client.query(
        `INSERT INTO translations (language_code, app, source_hash, source_text, value, is_machine, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (language_code, app, source_hash) DO UPDATE SET value = EXCLUDED.value, is_machine = EXCLUDED.is_machine, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [code, app, h, source, value.slice(0, 4000), !!machine, admin.id]
      );
      saved += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  invalidate();
  await auditService.log({ actor: admin, action: 'i18n.translations_saved', entityType: 'language', entityId: null, after: { language: code, app, saved, removed, machine: !!machine }, ...meta });
  return { saved, removed };
}

// The translation file: every catalogued string with its translation ("" when missing).
async function exportFile({ language: code, app, onlyMissing = false }) {
  assertApp(app);
  await language(code);
  const r = await pool.query(
    `SELECT s.source_text, t.value FROM i18n_strings s LEFT JOIN translations t ON t.app = s.app AND t.source_hash = s.source_hash AND t.language_code = $1
     WHERE s.app = $2 ${onlyMissing ? 'AND t.value IS NULL' : ''} ORDER BY s.source_text`,
    [code, app]
  );
  return Object.fromEntries(r.rows.map((x) => [x.source_text, x.value || '']));
}

// New interface text from a release: { app, strings: [...] } from the extract script.
async function importCatalogue(admin, { app, strings: list, replace = false }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  assertApp(app);
  if (!Array.isArray(list) || !list.length) throw badRequest('Send the list of strings');
  const items = [...new Set(list.map(clean).filter((s) => s && s.length <= 2000))];
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM i18n_strings WHERE app = $1', [app])).rows[0].n;
  await pool.query(
    `INSERT INTO i18n_strings (app, source_hash, source_text) SELECT $1, md5(x), x FROM unnest($2::text[]) AS x ON CONFLICT DO NOTHING`,
    [app, items]
  );
  let retired = 0;
  // Text that no longer exists in the app leaves the catalogue; its translations are kept.
  if (replace) retired = (await pool.query('DELETE FROM i18n_strings WHERE app = $1 AND source_hash <> ALL($2::text[])', [app, items.map(hash)])).rowCount;
  const after = (await pool.query('SELECT COUNT(*)::int AS n FROM i18n_strings WHERE app = $1', [app])).rows[0].n;
  await auditService.log({ actor: admin, action: 'i18n.catalogue_imported', entityType: 'language', entityId: null, after: { app, added: after - before + retired, retired }, ...meta });
  return { total: after, added: after - before + retired, retired };
}

// Draft the missing strings with the AI helper. Drafts are flagged so a
// person can review them; they are live straight away.
async function aiDraft(admin, { language: code, app, limit = 80 }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  assertApp(app);
  const l = await language(code);
  if (l.is_source) throw badRequest('Choose a language other than English');
  if (!process.env.ANTHROPIC_API_KEY) throw badRequest('The AI helper is not configured (ANTHROPIC_API_KEY) - download the file and translate it instead');
  const n = Math.min(Math.max(Number(limit) || 80, 1), 150);
  const missing = (
    await pool.query(
      `SELECT s.source_text FROM i18n_strings s LEFT JOIN translations t ON t.app = s.app AND t.source_hash = s.source_hash AND t.language_code = $1
       WHERE s.app = $2 AND t.value IS NULL ORDER BY length(s.source_text), s.source_text LIMIT ${n}`,
      [code, app]
    )
  ).rows.map((r) => r.source_text);
  if (!missing.length) return { drafted: 0, remaining: 0 };
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.I18N_AI_MODEL || 'claude-sonnet-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content:
        `Translate these interface strings of an Indian real-estate platform from English into ${l.name} (${l.native_name}). ` +
        'Use the natural, everyday wording an Indian property buyer or broker would expect; keep common English terms people actually use (BHK, RERA, GST, OTP, EMI, CRM, NRI, KYC, PDF). ' +
        'Never translate the brand names "PropertySerch" and "A R Buildwel". Keep numbers, symbols, punctuation and any leading or trailing words such as "in" that join onto a value exactly in position. ' +
        'Reply with only a JSON array of the translated strings, in the same order and of the same length as the input array.\n\n' +
        JSON.stringify(missing),
    }],
  });
  const text = response.content.find((b) => b.type === 'text')?.text || '';
  let out;
  try {
    out = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  } catch {
    throw badRequest('The AI helper returned something unreadable - try again');
  }
  if (!Array.isArray(out) || out.length !== missing.length) throw badRequest('The AI helper returned an incomplete answer - try again with fewer strings');
  const entries = Object.fromEntries(missing.map((m, i) => [m, typeof out[i] === 'string' ? out[i] : '']).filter(([, v]) => v));
  const r = await upsert(admin, { language: code, app, entries, machine: true }, meta);
  const remaining = (await pool.query(`SELECT COUNT(*)::int AS n FROM i18n_strings s LEFT JOIN translations t ON t.app = s.app AND t.source_hash = s.source_hash AND t.language_code = $1 WHERE s.app = $2 AND t.value IS NULL`, [code, app])).rows[0].n;
  return { drafted: r.saved, remaining };
}

module.exports = { APPS, activeLanguages, bundle, setPreference, preference, overview, saveLanguage, strings, upsert, exportFile, importCatalogue, aiDraft, invalidate };
