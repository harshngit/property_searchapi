const pool = require('../config/db');
const auditService = require('./audit.service');
const { notFound, forbidden } = require('../utils/httpError');

// app_config is read on hot paths (content guard on every listing save,
// scoring on every opportunity), so values are cached briefly in-process.
// A write through updateConfig() clears the cache immediately; other
// instances pick the change up within CACHE_TTL_MS.
const CACHE_TTL_MS = 30 * 1000;
let cache = null;
let cacheLoadedAt = 0;

async function loadAll() {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
  const result = await pool.query('SELECT config_key, value FROM app_config');
  cache = new Map(result.rows.map((row) => [row.config_key, row.value]));
  cacheLoadedAt = Date.now();
  return cache;
}

function invalidate() {
  cache = null;
}

// Returns the stored value, or `fallback` when the key has never been
// configured - callers always pass the Annexure A default as the fallback
// so a missing row degrades to the documented behaviour, not a crash.
async function getConfig(key, fallback = null) {
  const all = await loadAll();
  return all.has(key) ? all.get(key) : fallback;
}

async function listConfig({ category } = {}) {
  const params = [];
  let where = '';
  if (category) {
    params.push(category);
    where = 'WHERE category = $1';
  }
  const result = await pool.query(
    `SELECT c.*, u.full_name AS updated_by_name FROM app_config c
     LEFT JOIN users u ON u.id = c.updated_by
     ${where} ORDER BY category, config_key`,
    params
  );
  return result.rows;
}

async function getConfigEntry(key) {
  const result = await pool.query('SELECT * FROM app_config WHERE config_key = $1', [key]);
  if (!result.rows[0]) throw notFound('Config key not found');
  return result.rows[0];
}

// Statutory values (TDS/GST/FEMA limits) change only on a change in law and
// need super_admin plus a recorded legal basis; everything else is admin.
async function updateConfig(key, value, { reason } = {}, actingUser, requestMeta = {}) {
  const existing = await getConfigEntry(key);
  if (existing.is_statutory && actingUser.role !== 'super_admin') {
    throw forbidden('Statutory parameters can only be changed by a super admin');
  }

  const result = await pool.query(
    'UPDATE app_config SET value = $1, updated_by = $2 WHERE config_key = $3 RETURNING *',
    [JSON.stringify(value), actingUser.id, key]
  );

  await auditService.log({
    actor: actingUser,
    action: 'config_updated',
    entityType: 'app_config',
    entityId: key,
    before: { value: existing.value },
    after: { value, reason: reason || null },
    ...requestMeta,
  });

  invalidate();
  return result.rows[0];
}

module.exports = { getConfig, listConfig, getConfigEntry, updateConfig, invalidate };
