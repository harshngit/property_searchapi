const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('../services/config.service');
const apiKeys = require('../services/apiKey.service');

// Module 35 - the public API, mounted at /api/v1 (sec. 17).
//
//   Auth        X-API-Key: psk_live_...  (or Authorization: Bearer psk_live_...)
//   Scope       a key sees what its account sees in the CRM: an agency key its
//               organisation's records, a broker / builder key its own, an
//               admin key everything.
//   Pagination  cursor-based: ?limit= (max 100) & ?cursor=  ->
//               { items, next_cursor, has_more, total }
//   Errors      { error: { code, message, status, timestamp, trace_id, details } }
//   Limits      per key, per minute; X-RateLimit-* headers on every answer.
//   Retries     Idempotency-Key on POST replays the first answer for 24 hours.
//   Contact     phone and email are only ever returned masked.

const router = express.Router();
const ADMIN = ['admin', 'super_admin'];

const fail = (res, status, code, message, details) =>
  res.status(status).json({ error: { code, message, status, timestamp: new Date().toISOString(), trace_id: res.locals.traceId, details: details || undefined } });
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err.statusCode && err.statusCode < 500) return fail(res, err.statusCode, err.code || 'bad_request', err.message, err.errors);
  console.error('[api/v1]', err);
  return fail(res, 500, 'internal_error', 'Something went wrong on our side');
});

// Fixed one-minute windows per key, held in memory (one API instance).
const windows = new Map();
function rateLimit(req, res, next) {
  const { keyId, rateLimitPerMin } = req.api;
  const now = Date.now();
  const slot = Math.floor(now / 60000);
  let w = windows.get(keyId);
  if (!w || w.slot !== slot) windows.set(keyId, (w = { slot, n: 0 }));
  w.n += 1;
  const reset = (slot + 1) * 60;
  res.set({ 'X-RateLimit-Limit': String(rateLimitPerMin), 'X-RateLimit-Remaining': String(Math.max(rateLimitPerMin - w.n, 0)), 'X-RateLimit-Reset': String(reset) });
  if (w.n > rateLimitPerMin) {
    res.set('Retry-After', String(Math.max(reset - Math.floor(now / 1000), 1)));
    return fail(res, 429, 'rate_limited', `Rate limit of ${rateLimitPerMin} requests a minute exceeded`);
  }
  if (windows.size > 5000) for (const [k, v] of windows) if (v.slot !== slot) windows.delete(k);
  return next();
}

router.use(async (req, res, next) => {
  res.locals.traceId = crypto.randomUUID();
  res.set('X-Trace-Id', res.locals.traceId);
  if ((await configService.getConfig('api.enabled', true)) === false) return fail(res, 503, 'api_disabled', 'The API is switched off at the moment');
  const bearer = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const api = await apiKeys.authenticate(req.headers['x-api-key'] || bearer).catch(() => null);
  if (!api) return fail(res, 401, 'invalid_api_key', 'Send a valid API key in the X-API-Key header');
  req.api = api;
  return rateLimit(req, res, next);
});

const scope = (name) => (req, res, next) => (req.api.scopes.includes(name) ? next() : fail(res, 403, 'missing_scope', `This key does not have the "${name}" permission`));

// Rows this key's account may see, for a table alias and its owner columns.
function ownership(api, { users = [], tenant = null }) {
  const { user } = api;
  if (ADMIN.includes(user.role)) return { sql: 'TRUE', params: [] };
  if (user.role === 'agency_admin' && user.tenant_id && tenant) return { sql: `(${tenant} = $1 OR ${users.map((c) => `${c} = $2`).join(' OR ')})`, params: [user.tenant_id, user.id] };
  return { sql: `(${users.map((c) => `${c} = $1`).join(' OR ')})`, params: [user.id] };
}

// Cursor = base64 of "created_at|id" of the last row returned.
const encode = (row) => Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');
function decode(cursor) {
  if (!cursor) return null;
  const [ts, id] = Buffer.from(String(cursor), 'base64url').toString().split('|');
  if (!ts || !id || Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    const err = new Error('The cursor is not valid');
    err.statusCode = 400;
    err.code = 'invalid_cursor';
    throw err;
  }
  return { ts, id };
}

async function page(req, { select, from, where, params, shape }) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const cur = decode(req.query.cursor);
  const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} WHERE ${where}`, params)).rows[0].n;
  const p = [...params];
  let after = '';
  if (cur) {
    p.push(cur.ts, cur.id);
    after = ` AND (t.created_at, t.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`;
  }
  const rows = (await pool.query(`${select} ${from} WHERE ${where}${after} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit + 1}`, p)).rows;
  const items = rows.slice(0, limit);
  return { items: items.map(shape), next_cursor: rows.length > limit ? encode(items[items.length - 1]) : null, has_more: rows.length > limit, total };
}

const maskPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 6 ? `${d.slice(-10, -8)}XXXXXX${d.slice(-2)}` : null; };
const maskEmail = (v) => (v && String(v).includes('@') ? `${v[0]}*@${String(v).split('@')[1]}` : null);
const filters = (req, map, start) => {
  const sql = [];
  const params = [];
  for (const [q, col] of Object.entries(map)) if (req.query[q]) { params.push(String(req.query[q])); sql.push(`${col} = $${start + params.length}`); }
  return { sql: sql.length ? ` AND ${sql.join(' AND ')}` : '', params };
};

/**
 * @swagger
 * tags:
 *   name: Public API v1
 *   description: >
 *     Module 35 - the API for an organisation's own systems. Authenticate with an API key (CRM > API & Webhooks) in the
 *     X-API-Key header. A key sees what its account sees in the CRM, limited to its permissions. Lists are
 *     cursor-paginated ({ items, next_cursor, has_more, total }); errors come as { error: { code, message, status,
 *     timestamp, trace_id } }; every answer carries X-RateLimit-* headers. Phone numbers and emails are returned
 *     masked only.
 * components:
 *   securitySchemes:
 *     apiKey: { type: apiKey, in: header, name: X-API-Key }
 */

/**
 * @swagger
 * /v1/me:
 *   get:
 *     summary: The account and permissions behind this key
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     responses: { 200: { description: Account, scopes and rate limit } }
 * /v1/properties:
 *   get:
 *     summary: Your listings (scope properties:read) - filter by status, city
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, maximum: 100 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: city, schema: { type: string } }
 *     responses: { 200: { description: Cursor page of listings } }
 * /v1/properties/{id}:
 *   get:
 *     summary: One of your listings
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     responses: { 200: { description: Listing }, 404: { description: Not found or not yours } }
 * /v1/leads:
 *   get:
 *     summary: Your leads, contact masked (scope leads:read) - filter by status, source
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     responses: { 200: { description: Cursor page of leads } }
 *   post:
 *     summary: Create a lead in your CRM (scope leads:write). Send Idempotency-Key to make retries safe.
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [full_name]
 *             properties:
 *               full_name: { type: string }
 *               mobile: { type: string }
 *               email: { type: string }
 *               property_id: { type: string, format: uuid }
 *               message: { type: string }
 *               external_id: { type: string, description: Your own reference; a repeat with the same value returns the first lead }
 *     responses: { 201: { description: Lead created }, 200: { description: Existing lead returned (same external_id or Idempotency-Key) } }
 * /v1/leads/{id}:
 *   get:
 *     summary: One lead, contact masked
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     responses: { 200: { description: Lead } }
 * /v1/requirements:
 *   get:
 *     summary: Open buyer requirements in the marketplace, without the buyer's identity (scope requirements:read)
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     responses: { 200: { description: Cursor page of requirements } }
 * /v1/deals:
 *   get:
 *     summary: Your deals (scope deals:read) - filter by stage
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     responses: { 200: { description: Cursor page of deals } }
 * /v1/matches:
 *   get:
 *     summary: Requirement matches for your listings (scope matches:read) - filter by property_id, tier
 *     tags: [Public API v1]
 *     security: [{ apiKey: [] }]
 *     responses: { 200: { description: Cursor page of matches } }
 */
router.get('/me', h(async (req, res) => res.json({ account: { id: req.api.user.id, role: req.api.user.role, organisation_id: req.api.user.tenant_id || null }, scopes: req.api.scopes, rate_limit_per_min: req.api.rateLimitPerMin })));

const PROPERTY_SELECT = `SELECT t.id, t.created_at, t.title, t.property_type::text AS property_type, t.transaction_type::text AS transaction_type, t.listing_category::text AS listing_category, t.price, t.price_value, t.city, t.locality,
  t.area_sqft, t.bedrooms, t.bathrooms, t.status::text AS status, t.is_verified, t.verification_level, t.rera_number, t.updated_at`;
const propertyShape = (p) => ({ ...p, price_value: p.price_value === null ? null : Number(p.price_value), area_sqft: p.area_sqft === null ? null : Number(p.area_sqft) });
const propertyOwner = (api) => ownership(api, { users: ['t.created_by', 't.broker_id', 't.builder_id'], tenant: 't.tenant_id' });

router.get('/properties', scope('properties:read'), h(async (req, res) => {
  const own = propertyOwner(req.api);
  const f = filters(req, { status: 't.status::text', city: 't.city' }, own.params.length);
  res.json(await page(req, { select: PROPERTY_SELECT, from: 'FROM properties t', where: own.sql + f.sql, params: [...own.params, ...f.params], shape: propertyShape }));
}));
router.get('/properties/:id', scope('properties:read'), h(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, 'not_found', 'Listing not found');
  const own = propertyOwner(req.api);
  const p = (await pool.query(`${PROPERTY_SELECT}, t.description, t.amenities FROM properties t WHERE ${own.sql} AND t.id = $${own.params.length + 1}`, [...own.params, req.params.id])).rows[0];
  return p ? res.json(propertyShape(p)) : fail(res, 404, 'not_found', 'Listing not found');
}));

const LEAD_SELECT = `SELECT t.id, t.created_at, t.source::text AS source, t.status::text AS status, t.property_id, p.title AS property_title, t.enquiry_type, t.lead_score, t.lead_score_category, t.external_lead_id,
  t.first_contacted_at, t.updated_at, c.full_name, c.mobile, c.email`;
const LEAD_FROM = 'FROM leads t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN properties p ON p.id = t.property_id';
const leadOwner = (api) => ownership(api, { users: ['t.assigned_to', 't.created_by'], tenant: 't.tenant_id' });
const leadShape = (l) => ({
  id: l.id, created_at: l.created_at, updated_at: l.updated_at, source: l.source, status: l.status, property_id: l.property_id, property_title: l.property_title, enquiry_type: l.enquiry_type,
  lead_score: l.lead_score, lead_score_category: l.lead_score_category, external_id: l.external_lead_id, first_contacted_at: l.first_contacted_at,
  // Controlled contact: first name and masked contact only.
  contact: { name: String(l.full_name || '').trim().split(/\s+/)[0] || null, phone_masked: maskPhone(l.mobile), email_masked: maskEmail(l.email) },
});

router.get('/leads', scope('leads:read'), h(async (req, res) => {
  const own = leadOwner(req.api);
  const f = filters(req, { status: 't.status::text', source: 't.source::text', property_id: 't.property_id::text' }, own.params.length);
  res.json(await page(req, { select: LEAD_SELECT, from: LEAD_FROM, where: own.sql + f.sql, params: [...own.params, ...f.params], shape: leadShape }));
}));
router.get('/leads/:id', scope('leads:read'), h(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return fail(res, 404, 'not_found', 'Lead not found');
  const own = leadOwner(req.api);
  const l = (await pool.query(`${LEAD_SELECT} ${LEAD_FROM} WHERE ${own.sql} AND t.id = $${own.params.length + 1}`, [...own.params, req.params.id])).rows[0];
  return l ? res.json(leadShape(l)) : fail(res, 404, 'not_found', 'Lead not found');
}));

router.post('/leads', scope('leads:write'), h(async (req, res) => {
  const b = req.body || {};
  const idem = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']).slice(0, 120) : null;
  if (idem) {
    const hit = (await pool.query('SELECT status_code, response FROM api_idempotency WHERE api_key_id = $1 AND idem_key = $2 AND created_at > now() - interval \'24 hours\'', [req.api.keyId, idem])).rows[0];
    if (hit) return res.set('Idempotent-Replayed', 'true').status(hit.status_code).json(hit.response);
  }
  const name = String(b.full_name || '').trim();
  const mobile = b.mobile ? String(b.mobile).replace(/[^\d+]/g, '') : null;
  const email = b.email ? String(b.email).trim().toLowerCase() : null;
  const details = [];
  if (name.length < 2) details.push({ field: 'full_name', message: 'Required' });
  if (!mobile && !email) details.push({ field: 'mobile', message: 'Give a mobile number or an email' });
  if (mobile && !/^\+?\d{10,14}$/.test(mobile)) details.push({ field: 'mobile', message: 'Not a valid mobile number' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) details.push({ field: 'email', message: 'Not a valid email' });
  if (b.property_id && !/^[0-9a-f-]{36}$/i.test(String(b.property_id))) details.push({ field: 'property_id', message: 'Not a valid id' });
  if (details.length) return fail(res, 422, 'validation_failed', 'Some fields are not valid', details);
  const user = req.api.user;
  const reply = async (status, body) => {
    if (idem) await pool.query('INSERT INTO api_idempotency (api_key_id, idem_key, method, path, status_code, response) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', [req.api.keyId, idem, 'POST', '/v1/leads', status, JSON.stringify(body)]);
    return res.status(status).json(body);
  };
  const external = b.external_id ? String(b.external_id).slice(0, 120) : null;
  if (external) {
    const own = leadOwner(req.api);
    const dup = (await pool.query(`${LEAD_SELECT} ${LEAD_FROM} WHERE ${own.sql} AND t.external_lead_id = $${own.params.length + 1} LIMIT 1`, [...own.params, external])).rows[0];
    if (dup) return reply(200, leadShape(dup));
  }
  if (b.property_id) {
    const own = propertyOwner(req.api);
    if (!(await pool.query(`SELECT 1 FROM properties t WHERE ${own.sql} AND t.id = $${own.params.length + 1}`, [...own.params, b.property_id])).rows.length) return fail(res, 422, 'validation_failed', 'Some fields are not valid', [{ field: 'property_id', message: 'Not one of your listings' }]);
  }
  // The person: reuse the same customer inside this organisation when the mobile or email is already known.
  const existing = (await pool.query(
    `SELECT id FROM customers WHERE (($1::varchar IS NOT NULL AND mobile = $1) OR ($2::varchar IS NOT NULL AND lower(email) = $2)) AND (tenant_id IS NOT DISTINCT FROM $3 OR created_by = $4) ORDER BY created_at LIMIT 1`,
    [mobile, email, user.tenant_id || null, user.id]
  )).rows[0];
  const customerId = existing?.id || (await pool.query('INSERT INTO customers (tenant_id, created_by, full_name, email, mobile) VALUES ($1, $2, $3, $4, $5) RETURNING id', [user.tenant_id || null, user.id, name.slice(0, 150), email, mobile])).rows[0].id;
  const lead = await require('../services/lead.service').createLead({ source: 'manual', propertyId: b.property_id || null, customerId, assignedTo: user.id }, user);
  const extra = { via: 'api', message: b.message ? String(b.message).slice(0, 1000) : undefined };
  await pool.query(`UPDATE leads SET external_lead_id = $1, ingestion_mode = 'api', enquiry_details = COALESCE(enquiry_details, '{}'::jsonb) || $2::jsonb WHERE id = $3`, [external, JSON.stringify(extra), lead.id]);
  const out = (await pool.query(`${LEAD_SELECT} ${LEAD_FROM} WHERE t.id = $1`, [lead.id])).rows[0];
  return reply(201, leadShape(out));
}));

router.get('/requirements', scope('requirements:read'), h(async (req, res) => {
  const f = filters(req, { city: 't.city', purpose: 't.purpose', property_type: 't.property_type::text' }, 0);
  res.json(await page(req, {
    select: `SELECT t.id, t.created_at, t.purpose, t.property_type::text AS property_type, t.city, t.localities, t.bedrooms, t.area_min_sqft, t.area_max_sqft, t.urgency::text AS urgency`,
    from: 'FROM requirements t', where: `t.status = 'active'${f.sql}`, params: f.params,
    // Budget and the buyer's identity stay with the representative.
    shape: (r) => ({ ...r, area_min_sqft: r.area_min_sqft === null ? null : Number(r.area_min_sqft), area_max_sqft: r.area_max_sqft === null ? null : Number(r.area_max_sqft) }),
  }));
}));

router.get('/deals', scope('deals:read'), h(async (req, res) => {
  const own = ownership(req.api, { users: ['t.broker_id'], tenant: 't.tenant_id' });
  const f = filters(req, { stage: 't.stage::text' }, own.params.length);
  res.json(await page(req, {
    select: `SELECT t.id, t.created_at, t.lead_id, t.property_id, p.title AS property_title, t.stage::text AS stage, t.deal_value, t.stage_entered_at, t.closed_at, t.health_band, t.updated_at`,
    from: 'FROM deals t LEFT JOIN properties p ON p.id = t.property_id', where: own.sql + f.sql, params: [...own.params, ...f.params],
    shape: (d) => ({ ...d, deal_value: d.deal_value === null ? null : Number(d.deal_value) }),
  }));
}));

router.get('/matches', scope('matches:read'), h(async (req, res) => {
  const own = ownership(req.api, { users: ['p.created_by', 'p.broker_id', 'p.builder_id'], tenant: 'p.tenant_id' });
  const f = filters(req, { property_id: 't.property_id::text', tier: 't.tier' }, own.params.length);
  res.json(await page(req, {
    select: `SELECT t.id, t.first_matched_at AS created_at, t.property_id, p.title AS property_title, t.requirement_id, t.score, t.tier, t.price_compatible`,
    from: 'FROM (SELECT m.*, m.first_matched_at AS created_at FROM requirement_matches m) t JOIN properties p ON p.id = t.property_id', where: own.sql + f.sql, params: [...own.params, ...f.params], shape: (m) => m,
  }));
}));

router.use((req, res) => fail(res, 404, 'not_found', 'No such endpoint in API v1'));

module.exports = router;
