const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 35 - organisation-level API keys.
// A key acts as the account that created it: it can reach exactly the data
// that account can reach in the CRM, narrowed further by the scopes chosen
// when the key was made. Only a SHA-256 hash is stored; the key itself is
// shown once, at creation.

const ADMIN = ['admin', 'super_admin'];
const OWNERS = ['agency_admin', 'builder', 'broker', ...ADMIN];
const SCOPES = {
  'properties:read': 'Read your listings',
  'leads:read': 'Read your leads (contact details masked)',
  'leads:write': 'Create leads in your CRM',
  'requirements:read': 'Read open buyer requirements',
  'deals:read': 'Read your deals',
  'matches:read': 'Read matches for your listings',
};
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

const view = (k) => ({
  id: k.id, name: k.name, prefix: `${k.key_prefix}…`, scopes: k.scopes, rateLimitPerMin: k.rate_limit_per_min, status: k.status, expiresAt: k.expires_at, lastUsedAt: k.last_used_at,
  requestCount: Number(k.request_count), createdAt: k.created_at, revokedAt: k.revoked_at, ownerName: k.owner_name,
});

async function create(user, { name, scopes, expiresInDays }, meta = {}) {
  if (!OWNERS.includes(user.role)) throw forbidden('API keys are for agencies, builders and brokers');
  if (!name || String(name).trim().length < 3) throw badRequest('Give the key a name, for example "Website sync"');
  const list = [...new Set((Array.isArray(scopes) ? scopes : []).filter((s) => SCOPES[s]))];
  if (!list.length) throw badRequest('Choose at least one permission');
  const max = Number(await configService.getConfig('api.max_keys_per_account', 5)) || 5;
  const active = (await pool.query(`SELECT COUNT(*)::int AS n FROM api_keys WHERE owner_user_id = $1 AND status = 'active'`, [user.id])).rows[0].n;
  if (active >= max) throw badRequest(`You can have up to ${max} active keys - revoke one first`);
  const days = expiresInDays ? Number(expiresInDays) : null;
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 730)) throw badRequest('Expiry must be between 1 and 730 days');
  const key = `psk_live_${crypto.randomBytes(24).toString('hex')}`;
  const limit = Number(await configService.getConfig('api.default_rate_limit_per_min', 120)) || 120;
  const k = (await pool.query(
    `INSERT INTO api_keys (owner_user_id, tenant_id, name, key_prefix, key_hash, scopes, rate_limit_per_min, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + ($8::int || ' days')::interval END) RETURNING *`,
    [user.id, user.tenant_id || null, String(name).trim().slice(0, 80), key.slice(0, 14), hashKey(key), JSON.stringify(list), limit, days]
  )).rows[0];
  await auditService.log({ actor: user, action: 'api.key_created', entityType: 'api_key', entityId: k.id, after: { name: k.name, scopes: list }, ...meta });
  return { ...view(k), key }; // the only time the key is returned
}

async function list(user) {
  const all = ADMIN.includes(user.role);
  const r = await pool.query(
    `SELECT k.*, u.full_name AS owner_name FROM api_keys k JOIN users u ON u.id = k.owner_user_id ${all ? '' : 'WHERE k.owner_user_id = $1'} ORDER BY (k.status = 'active') DESC, k.created_at DESC LIMIT 300`,
    all ? [] : [user.id]
  );
  return { scopes: Object.entries(SCOPES).map(([key, label]) => ({ key, label })), items: r.rows.map((k) => ({ ...view(k), ownerName: all ? k.owner_name : undefined, mine: k.owner_user_id === user.id })) };
}

async function revoke(user, id, meta = {}) {
  const k = (await pool.query('SELECT * FROM api_keys WHERE id = $1', [id])).rows[0];
  if (!k) throw notFound('Key not found');
  if (k.owner_user_id !== user.id && !ADMIN.includes(user.role)) throw forbidden('Not your key');
  if (k.status === 'revoked') return view(k);
  const r = (await pool.query(`UPDATE api_keys SET status = 'revoked', revoked_at = now(), revoked_by = $1 WHERE id = $2 RETURNING *`, [user.id, id])).rows[0];
  await auditService.log({ actor: user, action: 'api.key_revoked', entityType: 'api_key', entityId: id, ...meta });
  return view(r);
}

async function setRateLimit(admin, id, perMin, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  const n = Number(perMin);
  if (!Number.isInteger(n) || n < 1 || n > 6000) throw badRequest('Rate limit must be between 1 and 6,000 requests a minute');
  const r = (await pool.query('UPDATE api_keys SET rate_limit_per_min = $1 WHERE id = $2 RETURNING *', [n, id])).rows[0];
  if (!r) throw notFound('Key not found');
  await auditService.log({ actor: admin, action: 'api.key_rate_limit', entityType: 'api_key', entityId: id, after: { perMin: n }, ...meta });
  return view(r);
}

// Resolve a presented key to the account it acts as. null = not valid.
async function authenticate(presented) {
  if (!presented || !/^psk_live_[0-9a-f]{48}$/.test(presented)) return null;
  const k = (await pool.query(
    `SELECT k.id, k.scopes, k.rate_limit_per_min, k.owner_user_id, u.tenant_id, r.name AS role
     FROM api_keys k JOIN users u ON u.id = k.owner_user_id JOIN roles r ON r.id = u.role_id
     WHERE k.key_hash = $1 AND k.status = 'active' AND (k.expires_at IS NULL OR k.expires_at > now()) AND u.status = 'active'`,
    [hashKey(presented)]
  )).rows[0];
  if (!k) return null;
  pool.query('UPDATE api_keys SET last_used_at = now(), request_count = request_count + 1 WHERE id = $1', [k.id]).catch(() => {});
  return { keyId: k.id, scopes: k.scopes, rateLimitPerMin: k.rate_limit_per_min, user: { id: k.owner_user_id, role: k.role, tenant_id: k.tenant_id } };
}

module.exports = { SCOPES, create, list, revoke, setRateLimit, authenticate };
