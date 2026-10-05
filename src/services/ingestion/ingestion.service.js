const crypto = require('crypto');
const pool = require('../../config/db');
const configService = require('../config.service');
const notificationService = require('../notification.service');
const auditService = require('../audit.service');
const customerService = require('../customer.service');
const { encrypt, decrypt } = require('../../utils/crypto');
const { maskPhone } = require('../../utils/masking');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');
const N = require('./normalisers');

// Engine 2 - External Lead Ingestion. Built once, shared by every tenant:
//   webhook / pull / email / bot payload
//     -> lead_ingestion_inbox (raw archived, idempotent on external id)
//     -> source normaliser (+ AI fallback for emails) -> confidence
//     -> below threshold: manual review queue (admins notified)
//     -> dedupe by phone within the org: existing open lead gets the new
//        source in lead_source_history, no second lead
//     -> new lead with an immutable source tag -> assignment cascade (sec. 34)
// Sources are rows in lead_sources; a tenant activates one by saving its
// credentials (lead_source_connections) - no developer, no deploy.

const ADMIN = ['admin', 'super_admin'];
const ORG_ADMIN = ['agency_admin', ...ADMIN];
const OPEN = "('won', 'lost')";
const NIL = '00000000-0000-0000-0000-000000000000';

const CREDENTIAL_FIELDS = {
  meta: ['page_id', 'page_access_token', 'app_secret', 'verify_token', 'form_ids'],
  google: ['google_key', 'customer_id', 'developer_token', 'client_id', 'client_secret', 'refresh_token', 'login_customer_id'],
  portal: ['api_key', 'pull_url', 'pull_since_param', 'pull_auth_header'],
  generic: ['api_key', 'pull_url', 'pull_since_param', 'pull_auth_header'],
};

// ---------------------------------------------------------------- sources

async function listSources() {
  return (await pool.query(`SELECT * FROM lead_sources ORDER BY built_in DESC, channel, source_name`)).rows;
}

async function getSource(key) {
  const s = (await pool.query('SELECT * FROM lead_sources WHERE source_key = $1', [key])).rows[0];
  if (!s) throw notFound('Unknown lead source');
  return s;
}

const NORMALISERS = ['meta', 'google', 'portal', 'generic', 'email', 'form', 'manual', 'whatsapp', 'telegram'];

// Super Admin adds a new source row - e.g. a new portal - no code deploy.
async function createSource(data, actor) {
  if (actor.role !== 'super_admin') throw forbidden('Only the Super Admin manages the lead source catalogue');
  const key = String(data.sourceKey || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!key || !data.sourceName || !data.sourceTag) throw badRequest('sourceKey, sourceName and sourceTag are required');
  const normaliser = data.normaliserModule || 'generic';
  if (!NORMALISERS.includes(normaliser)) throw badRequest(`normaliserModule must be one of ${NORMALISERS.join(', ')}`);
  const row = (
    await pool.query(
      `INSERT INTO lead_sources (source_key, source_name, source_tag, channel, webhook_path, auth_type, normaliser_module, lead_source_enum,
         sync_mode, supports_pull, poll_interval_minutes, field_mapping, tenant_config_required, tenant_config_label, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, COALESCE($14, true)) RETURNING *`,
      [
        key, data.sourceName, data.sourceTag, data.channel || 'portal', `/api/leads/ingest/${key}`, data.authType || 'API_KEY', normaliser,
        data.channel === 'social_ad' ? 'social_ad' : 'portal', data.syncMode || 'push+pull', ['portal', 'generic', 'meta', 'google'].includes(normaliser),
        Number(data.pollIntervalMinutes) || 30, JSON.stringify(data.fieldMapping || {}), data.tenantConfigLabel || null, data.isActive,
      ]
    )
  ).rows[0];
  await auditService.log({ actor, action: 'lead_source.created', entityType: 'lead_source', entityId: row.id, after: row });
  return row;
}

async function updateSource(key, data, actor) {
  if (actor.role !== 'super_admin') throw forbidden('Only the Super Admin manages the lead source catalogue');
  const before = await getSource(key);
  if (data.syncMode && !['push', 'pull', 'push+pull'].includes(data.syncMode)) throw badRequest('syncMode must be push, pull or push+pull');
  if (data.syncMode && data.syncMode !== 'push' && !before.supports_pull) throw badRequest('This source has no pull adapter - it can only be push');
  const row = (
    await pool.query(
      `UPDATE lead_sources SET
         source_name = COALESCE($2, source_name), is_active = COALESCE($3, is_active), sync_mode = COALESCE($4, sync_mode),
         poll_interval_minutes = COALESCE($5, poll_interval_minutes), field_mapping = COALESCE($6, field_mapping),
         tenant_config_label = COALESCE($7, tenant_config_label)
       WHERE source_key = $1 RETURNING *`,
      [key, data.sourceName || null, typeof data.isActive === 'boolean' ? data.isActive : null, data.syncMode || null,
        data.pollIntervalMinutes ? Number(data.pollIntervalMinutes) : null, data.fieldMapping ? JSON.stringify(data.fieldMapping) : null,
        data.tenantConfigLabel || null]
    )
  ).rows[0];
  await auditService.log({ actor, action: 'lead_source.updated', entityType: 'lead_source', entityId: row.id, before, after: row });
  return row;
}

// ---------------------------------------------------------------- connections

function orgFor(user, tenantId) {
  if (ADMIN.includes(user.role)) return tenantId === undefined ? null : tenantId || null;
  if (user.role === 'agency_admin') {
    if (!user.tenant_id) throw forbidden('No organisation on your account');
    return user.tenant_id;
  }
  throw forbidden('Only organisation admins manage lead sources');
}

function readCredentials(conn) {
  if (!conn?.credentials_enc) return {};
  try {
    return JSON.parse(decrypt(conn.credentials_enc));
  } catch {
    return {};
  }
}

function maskCredentials(creds) {
  const out = {};
  for (const [k, v] of Object.entries(creds)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = /token|secret|key/.test(k) ? `••••${String(v).slice(-4)}` : v;
  }
  return out;
}

async function publicBase() {
  return String(await configService.getConfig('app.public_api_url', process.env.PUBLIC_API_URL || 'https://api.propertyserch.com')).replace(/\/$/, '');
}

async function mailbox(tenantId) {
  const domain = await configService.getConfig('ingestion.email_domain', 'leads.propertyserch.com');
  if (!tenantId) return `lead-arb@${domain}`;
  const t = (await pool.query('SELECT slug FROM tenants WHERE id = $1', [tenantId])).rows[0];
  return t ? `lead-${t.slug}@${domain}` : null;
}

async function connectionView(source, conn, base) {
  const month = conn
    ? (await pool.query(`SELECT COUNT(*)::int AS n FROM lead_ingestion_inbox WHERE connection_id = $1 AND created_at >= date_trunc('month', now())`, [conn.id])).rows[0].n
    : 0;
  const created = conn
    ? (await pool.query(`SELECT COUNT(*)::int AS n FROM lead_ingestion_inbox WHERE connection_id = $1 AND parse_status = 'lead_created' AND created_at >= date_trunc('month', now())`, [conn.id])).rows[0].n
    : 0;
  return {
    source: {
      key: source.source_key, name: source.source_name, tag: source.source_tag, channel: source.channel, authType: source.auth_type,
      normaliser: source.normaliser_module, syncMode: source.sync_mode, supportsPull: source.supports_pull, isActive: source.is_active,
      configRequired: source.tenant_config_required, configLabel: source.tenant_config_label, credentialFields: CREDENTIAL_FIELDS[source.normaliser_module] || [],
    },
    connection: conn
      ? {
          id: conn.id,
          status: conn.status,
          webhookUrl: source.normaliser_module === 'meta' ? `${base}/api/leads/ingest/meta` : `${base}/api/leads/ingest/${source.source_key}/${conn.webhook_key}`,
          credentials: maskCredentials(readCredentials(conn)),
          lastPushAt: conn.last_push_at, lastPullAt: conn.last_pull_at, pullCursor: conn.pull_cursor,
          lastError: conn.last_error, consecutiveFailures: conn.consecutive_failures,
          leadsThisMonth: created, payloadsThisMonth: month,
        }
      : null,
  };
}

// Settings > Lead Sources for one org (tenantId null = A R Buildwel).
async function listConnections(user, tenantId) {
  const org = orgFor(user, tenantId);
  const [sources, conns, base] = await Promise.all([
    listSources(),
    pool.query(`SELECT * FROM lead_source_connections WHERE COALESCE(tenant_id, $1::uuid) = COALESCE($2::uuid, $1::uuid)`, [NIL, org]),
    publicBase(),
  ]);
  const byId = new Map(conns.rows.map((c) => [c.source_id, c]));
  const items = [];
  for (const s of sources.filter((x) => x.channel !== 'manual')) items.push(await connectionView(s, byId.get(s.id), base));
  return { tenantId: org, mailbox: await mailbox(org), items };
}

async function saveConnection(user, sourceKey, { tenantId, credentials = {}, status } = {}, meta = {}) {
  const org = orgFor(user, tenantId);
  const source = await getSource(sourceKey);
  if (!source.is_active) throw badRequest('This source is not active on the platform');
  if (!source.tenant_config_required && !['email'].includes(source.normaliser_module)) throw badRequest('This source works without configuration');
  const existing = (
    await pool.query(`SELECT * FROM lead_source_connections WHERE source_id = $1 AND COALESCE(tenant_id, $2::uuid) = COALESCE($3::uuid, $2::uuid)`, [source.id, NIL, org])
  ).rows[0];
  const allowed = CREDENTIAL_FIELDS[source.normaliser_module] || [];
  const merged = { ...readCredentials(existing) };
  for (const [k, v] of Object.entries(credentials || {})) {
    if (!allowed.includes(k)) continue;
    if (v === null || v === '') delete merged[k];
    else if (!String(v).startsWith('••••')) merged[k] = k === 'form_ids' ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : String(v).trim();
  }
  const key = existing?.webhook_key || crypto.randomBytes(18).toString('hex');
  if (source.normaliser_module === 'meta' && !merged.verify_token) merged.verify_token = crypto.randomBytes(12).toString('hex');
  if (source.normaliser_module === 'google' && !merged.google_key) merged.google_key = key;
  const enc = encrypt(JSON.stringify(merged));
  const row = existing
    ? (await pool.query(
        `UPDATE lead_source_connections SET credentials_enc = $2, status = COALESCE($3, status), consecutive_failures = 0, last_error = NULL, failure_alerted_at = NULL WHERE id = $1 RETURNING *`,
        [existing.id, enc, status || null]
      )).rows[0]
    : (await pool.query(
        `INSERT INTO lead_source_connections (source_id, tenant_id, webhook_key, credentials_enc, status, created_by) VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), $6) RETURNING *`,
        [source.id, org, key, enc, status || null, user.id]
      )).rows[0];
  await auditService.log({ actor: user, action: existing ? 'lead_source_connection.updated' : 'lead_source_connection.created', entityType: 'lead_source_connection', entityId: row.id, after: { source: sourceKey, tenant_id: org, status: row.status, fields: Object.keys(merged) }, ...meta });
  return connectionView(source, row, await publicBase());
}

async function deleteConnection(user, sourceKey, tenantId) {
  const org = orgFor(user, tenantId);
  const source = await getSource(sourceKey);
  await pool.query(`UPDATE lead_source_connections SET status = 'inactive' WHERE source_id = $1 AND COALESCE(tenant_id, $2::uuid) = COALESCE($3::uuid, $2::uuid)`, [source.id, NIL, org]);
  return { deactivated: true };
}

// Super Admin master view: every activation across every org.
async function masterView() {
  return (
    await pool.query(
      `SELECT s.source_key, s.source_name, s.source_tag, s.is_active, s.sync_mode,
              c.id AS connection_id, c.tenant_id, COALESCE(t.name, 'A R Buildwel') AS org_name, c.status, c.last_push_at, c.last_pull_at,
              c.consecutive_failures, c.last_error,
              (SELECT COUNT(*) FROM lead_ingestion_inbox i WHERE i.connection_id = c.id AND i.parse_status = 'lead_created'
                 AND i.created_at >= date_trunc('month', now()))::int AS leads_this_month
       FROM lead_sources s
       LEFT JOIN lead_source_connections c ON c.source_id = s.id
       LEFT JOIN tenants t ON t.id = c.tenant_id
       ORDER BY s.source_name, org_name`
    )
  ).rows;
}

// ---------------------------------------------------------------- pipeline

async function archive(raw, sourceKey, tenantId) {
  try {
    const { uploadBuffer } = require('../../utils/storage');
    const d = new Date();
    return await uploadBuffer(Buffer.from(String(raw)), `leads-archive/${tenantId || 'arb'}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${sourceKey}`, 'payload.txt', 'text/plain');
  } catch {
    return null; // storage not configured (local / test) - raw kept in the row
  }
}

async function adminIds(tenantId) {
  const rows = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.status = 'active' AND (r.name IN ('super_admin', 'admin') OR (r.name = 'agency_admin' AND $1::uuid IS NOT NULL AND u.tenant_id = $1::uuid))`,
    [tenantId || null]
  );
  return rows.rows.map((r) => r.id);
}

async function notifyAdmins(tenantId, { type, title, message }) {
  for (const userId of await adminIds(tenantId)) {
    await notificationService.createNotification({ userId, type, title, message }).catch(() => {});
  }
}

// Creates (or merges into) the CRM lead for one parsed inbound lead.
async function createLead(parsed, { source, tenantId, mode, inboxId, actor = null }) {
  const customer = await customerService.findOrCreateCustomerByContact({
    fullName: parsed.name || `${source.source_name} lead ${parsed.phone ? maskPhone(parsed.phone) : ''}`.trim(),
    email: parsed.email || null,
    mobile: parsed.phone || null,
  });
  const client = await pool.connect();
  let leadId;
  let dedup = 'unique';
  let created = false;
  try {
    await client.query('BEGIN');
    // Dedupe within the same org only (multi-tenant isolation).
    const same = (
      await client.query(
        `SELECT id FROM leads WHERE customer_id = $1 AND status NOT IN ${OPEN} AND COALESCE(tenant_id, $2::uuid) = COALESCE($3::uuid, $2::uuid)
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [customer.id, NIL, tenantId || null]
      )
    ).rows[0];
    if (same) {
      leadId = same.id;
      dedup = 'duplicate_same_org';
      await client.query(
        `INSERT INTO lead_source_history (lead_id, source_tag, ingestion_mode, external_lead_id, inbox_id) VALUES ($1, $2, $3, $4, $5)`,
        [leadId, source.source_tag, mode, parsed.externalId || null, inboxId || null]
      );
      await client.query(`INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, NULL, $2)`, [
        leadId, `Same person came in again via ${source.source_name}${parsed.message ? `: ${parsed.message}` : ''}`,
      ]);
    } else {
      const cross = (
        await client.query(
          `SELECT 1 FROM leads WHERE customer_id = $1 AND status NOT IN ${OPEN} AND COALESCE(tenant_id, $2::uuid) <> COALESCE($3::uuid, $2::uuid) LIMIT 1`,
          [customer.id, NIL, tenantId || null]
        )
      ).rows.length > 0;
      if (cross) dedup = 'duplicate_cross_org';
      let propertyId = null;
      if (parsed.propertyId) propertyId = (await client.query('SELECT id FROM properties WHERE id = $1', [parsed.propertyId])).rows[0]?.id || null;
      const ins = (
        await client.query(
          `INSERT INTO leads (tenant_id, created_by, source, source_tag, ingestion_mode, external_lead_id, property_id, customer_id, status)
           VALUES ($1, $2, $3::lead_source, $4, $5, $6, $7, $8, 'new') RETURNING id`,
          [tenantId || null, actor?.id || null, source.lead_source_enum, source.source_tag, mode, parsed.externalId || null, propertyId, customer.id]
        )
      ).rows[0];
      leadId = ins.id;
      created = true;
      await client.query(`INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'lead_created', $3)`, [
        leadId, actor?.id || null, JSON.stringify({ source: source.source_key, source_tag: source.source_tag, ingestion_mode: mode, external_lead_id: parsed.externalId || null }),
      ]);
      const summary = [
        parsed.purpose && `Looking to ${parsed.purpose}`,
        parsed.propertyType && `Type: ${parsed.propertyType.replace('_', ' ')}`,
        (parsed.locality || parsed.city) && `Location: ${[parsed.locality, parsed.city].filter(Boolean).join(', ')}`,
        parsed.budget && `Budget: ₹${Number(parsed.budget).toLocaleString('en-IN')}`,
        parsed.message && `Message: ${parsed.message}`,
      ].filter(Boolean).join('\n');
      await client.query(`INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, NULL, $2)`, [leadId, `${source.source_name} lead${summary ? `\n${summary}` : ''}`]);
      await client.query(
        `INSERT INTO customer_preferences (customer_id, budget_max, preferred_locations, property_type, transaction_type)
         VALUES ($1, $2, $3::jsonb, $4::property_type, $5::transaction_type)
         ON CONFLICT (customer_id) DO NOTHING`,
        [customer.id, parsed.budget || null, JSON.stringify([parsed.locality, parsed.city].filter(Boolean)),
          ['apartment', 'villa', 'independent_house', 'plot', 'commercial', 'farmhouse', 'other'].includes(parsed.propertyType) ? parsed.propertyType : null,
          parsed.purpose === 'rent' ? 'rent' : parsed.purpose === 'buy' ? 'buy' : null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  let repId = null;
  if (created) {
    const placed = await require('../assignment.service').safeAssign(leadId);
    repId = placed?.userId || null;
  } else {
    repId = (await pool.query('SELECT arb_rep_id FROM leads WHERE id = $1', [leadId])).rows[0]?.arb_rep_id || null;
  }
  return { leadId, created, dedup, repId };
}

// One inbound item through the whole pipeline. `parsed` may be given
// (normaliser already run) or produced here from `raw` + `parse`.
async function ingest({ source, connection = null, tenantId = null, method, mode, raw, parsed, parsedByAi = false }) {
  const threshold = Number(await configService.getConfig('ingestion.confidence_threshold', 70)) || 70;
  const externalId = parsed?.externalId ? String(parsed.externalId).slice(0, 120) : null;
  const tenant = connection ? connection.tenant_id : tenantId;
  // Idempotency: the same external lead (push + pull, retries) once only.
  if (externalId) {
    const seen = (
      await pool.query(
        `SELECT id, created_lead_id FROM lead_ingestion_inbox WHERE source_key = $1 AND COALESCE(tenant_id, $2::uuid) = COALESCE($3::uuid, $2::uuid)
           AND external_lead_id = $4 AND parse_status <> 'duplicate_detected' LIMIT 1`,
        [source.source_key, NIL, tenant || null, externalId]
      )
    ).rows[0];
    if (seen) return { inboxId: seen.id, status: 'duplicate_detected', dedup: 'duplicate_external_id', leadId: seen.created_lead_id };
  }
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const ref = await archive(rawText, source.source_key, tenant);
  const conf = parsed ? N.confidence(parsed) : 0;
  const inbox = (
    await pool.query(
      `INSERT INTO lead_ingestion_inbox (tenant_id, source_key, connection_id, external_lead_id, ingestion_method, raw_payload_ref, raw_payload,
         parse_status, parse_confidence, parsed_name, parsed_phone_enc, parsed_phone_masked, parsed_email, parsed_city, parsed_locality,
         parsed_budget, parsed_property_type, parsed_purpose, parsed_message, parsed_property_id, parsed_by_ai)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'parsed', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
      [
        tenant || null, source.source_key, connection?.id || null, externalId, method, ref, ref ? null : rawText.slice(0, 200000), conf,
        parsed?.name || null, parsed?.phone ? encrypt(parsed.phone) : null, parsed?.phone ? maskPhone(parsed.phone) : null, parsed?.email || null,
        parsed?.city || null, parsed?.locality || null, parsed?.budget ? Math.round(parsed.budget * 100) : null, parsed?.propertyType || null,
        parsed?.purpose || null, parsed?.message || null, parsed?.propertyId || null, parsedByAi,
      ]
    )
  ).rows[0];
  if (!parsed || (!parsed.phone && !parsed.email) || conf < threshold) {
    await pool.query(`UPDATE lead_ingestion_inbox SET parse_status = 'parse_failed', parse_error = $2, processed_at = now() WHERE id = $1`, [
      inbox.id, !parsed ? 'Could not read the payload' : !parsed.phone && !parsed.email ? 'No phone or email found' : `Confidence ${conf} below ${threshold}`,
    ]);
    await notifyAdmins(tenant, { type: 'lead_ingestion_review', title: `${source.source_name} lead needs review`, message: 'An inbound lead could not be parsed confidently - open the ingestion review queue.' });
    return { inboxId: inbox.id, status: 'parse_failed', confidence: conf };
  }
  const res = await createLead(parsed, { source, tenantId: tenant, mode, inboxId: inbox.id });
  await pool.query(
    `UPDATE lead_ingestion_inbox SET parse_status = $2, dedup_result = $3, created_lead_id = $4, assigned_rep_id = $5, processed_at = now() WHERE id = $1`,
    [inbox.id, res.created ? 'lead_created' : 'duplicate_detected', res.dedup, res.leadId, res.repId]
  );
  return { inboxId: inbox.id, status: res.created ? 'lead_created' : 'duplicate_detected', dedup: res.dedup, leadId: res.leadId, confidence: conf };
}

// ---------------------------------------------------------------- push

function timingSafeEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function connectionByKey(sourceKey, key) {
  const source = await getSource(sourceKey);
  const conn = (await pool.query(`SELECT * FROM lead_source_connections WHERE source_id = $1 AND webhook_key = $2`, [source.id, key])).rows[0];
  if (!conn || conn.status === 'inactive') throw notFound('Unknown or inactive lead source connection');
  if (!source.is_active) throw forbidden('This lead source is switched off');
  if (source.sync_mode === 'pull') throw badRequest('This source is configured as pull-only');
  return { source, conn };
}

async function markPush(conn) {
  await pool.query('UPDATE lead_source_connections SET last_push_at = now() WHERE id = $1', [conn.id]);
}

// Generic webhook: POST /api/leads/ingest/:source/:key (portals, JustDial,
// Sulekha, LinkedIn, Google). The key in the URL identifies the org; an
// optional shared secret (credentials.api_key) must match when set.
async function handleWebhook(sourceKey, key, { body, headers }) {
  const { source, conn } = await connectionByKey(sourceKey, key);
  const creds = readCredentials(conn);
  if (source.normaliser_module === 'google') {
    if (!timingSafeEq(body?.google_key, creds.google_key)) throw forbidden('Invalid google_key');
  } else if (creds.api_key) {
    const supplied = headers['x-api-key'] || headers['x-webhook-secret'] || body?.api_key || body?.key;
    if (!timingSafeEq(supplied, creds.api_key)) throw forbidden('Invalid API key');
  }
  const items = Array.isArray(body?.leads) ? body.leads : Array.isArray(body) ? body : [body];
  const results = [];
  for (const item of items) {
    const parsed = source.normaliser_module === 'google' ? N.googleLead(item, source) : N.fromFlat(item, source);
    if (source.normaliser_module === 'google' && item.is_test) parsed.message = `[Google test lead] ${parsed.message || ''}`.trim();
    results.push(await ingest({ source, connection: conn, method: 'webhook', mode: 'push', raw: item, parsed }));
  }
  await markPush(conn);
  return { received: items.length, results };
}

// Meta: one app-level webhook for every connected page.
async function metaVerify(query) {
  const conns = (
    await pool.query(`SELECT c.* FROM lead_source_connections c JOIN lead_sources s ON s.id = c.source_id WHERE s.normaliser_module = 'meta' AND c.status <> 'inactive'`)
  ).rows;
  const ok = query['hub.mode'] === 'subscribe' && conns.some((c) => readCredentials(c).verify_token && timingSafeEq(readCredentials(c).verify_token, query['hub.verify_token']));
  if (!ok) throw forbidden('Verify token mismatch');
  return query['hub.challenge'];
}

async function graphGet(path, token) {
  const version = await configService.getConfig('ingestion.meta_graph_version', 'v21.0');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://graph.facebook.com/${version}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Graph API ${res.status}`);
  return json;
}

async function metaConnections() {
  return (
    await pool.query(
      `SELECT c.*, s.source_key FROM lead_source_connections c JOIN lead_sources s ON s.id = c.source_id
       WHERE s.normaliser_module = 'meta' AND c.status <> 'inactive' AND s.is_active`
    )
  ).rows;
}

async function handleMetaWebhook({ body, rawBody, headers }) {
  const conns = await metaConnections();
  const results = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const v = change.value || {};
      const pageId = String(v.page_id || entry.id || '');
      const candidates = conns.filter((c) => String(readCredentials(c).page_id || '') === pageId);
      if (!candidates.length) continue;
      // Signature check against the page's app secret, when configured.
      const sig = headers['x-hub-signature-256'];
      const secretOk = candidates.some((c) => {
        const secret = readCredentials(c).app_secret;
        if (!secret) return true;
        const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex')}`;
        return timingSafeEq(sig, expected);
      });
      if (!secretOk) throw forbidden('Invalid Meta signature');
      // Fetch the lead from the Graph API (or use field_data if already present - test events).
      let lead = v.field_data ? { id: v.leadgen_id, field_data: v.field_data, platform: v.platform } : null;
      const conn = candidates[0];
      if (!lead) lead = await graphGet(`${v.leadgen_id}?fields=id,created_time,field_data,ad_name,form_id,platform`, readCredentials(conn).page_access_token);
      const platform = String(lead.platform || v.platform || '').toLowerCase();
      const chosen = candidates.find((c) => c.source_key === (platform === 'ig' || platform === 'instagram' ? 'instagram' : 'facebook')) || conn;
      const source = await getSource(chosen.source_key);
      results.push(await ingest({ source, connection: chosen, method: 'webhook', mode: 'push', raw: lead, parsed: N.metaLead(lead, source) }));
      await markPush(chosen);
    }
  }
  return { results };
}

// Portal emails: POST /api/leads/ingest/email from the inbound-mail provider.
async function handleEmail({ to, from, subject, text }) {
  const domain = await configService.getConfig('ingestion.email_domain', 'leads.propertyserch.com');
  const local = String(to || '').toLowerCase().match(new RegExp(`lead-([a-z0-9-]+)@${String(domain).replace(/\./g, '\\.')}`))?.[1];
  if (!local) throw badRequest('Unknown lead mailbox');
  let tenantId = null;
  if (local !== 'arb') {
    const t = (await pool.query('SELECT id FROM tenants WHERE slug = $1', [local])).rows[0];
    if (!t) throw notFound('Unknown lead mailbox');
    tenantId = t.id;
  }
  const senders = await configService.getConfig('ingestion.email_sender_sources', {});
  const fromDomain = String(from || '').toLowerCase().split('@')[1]?.replace(/>.*/, '') || '';
  const match = Object.entries(senders || {}).find(([d]) => fromDomain === d || fromDomain.endsWith(`.${d}`));
  const source = await getSource(match ? match[1] : 'portal_email');
  const conn = (await pool.query(`SELECT * FROM lead_source_connections WHERE source_id = $1 AND COALESCE(tenant_id, $2::uuid) = COALESCE($3::uuid, $2::uuid)`, [source.id, NIL, tenantId])).rows[0] || null;
  let parsed = N.emailLead({ subject, text, from });
  let byAi = false;
  if (N.confidence(parsed) < 70) {
    const ai = await aiParseEmail(`${subject || ''}\n${text || ''}`).catch(() => null);
    if (ai) {
      for (const [k, v] of Object.entries(ai)) if (parsed[k] == null && v != null) parsed[k] = k === 'phone' ? N.cleanPhone(v) : k === 'budget' ? N.parseBudget(v) : v;
      byAi = true;
    }
  }
  const raw = `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${text}`;
  return ingest({ source, connection: conn, tenantId, method: 'email_parser', mode: 'push', raw, parsed, parsedByAi: byAi });
}

// AI fallback for portal email formats the regexes don't know (no code
// change per new template). Off unless ANTHROPIC_API_KEY is set.
async function aiParseEmail(text) {
  if (!process.env.ANTHROPIC_API_KEY || !text) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 600,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { name: nullable, phone: nullable, email: nullable, city: nullable, locality: nullable, budget: nullable, propertyType: nullable, purpose: nullable, message: nullable },
          required: ['name', 'phone', 'email', 'city', 'locality', 'budget', 'propertyType', 'purpose', 'message'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: `Extract the enquirer's details from this Indian property portal lead email. Use null when absent.\n\n${text.slice(0, 8000)}` }],
  });
  const block = response.content.find((b) => b.type === 'text');
  return block ? JSON.parse(block.text) : null;
}

// ---------------------------------------------------------------- pull

async function pullMeta(conn, since) {
  const creds = readCredentials(conn);
  if (!creds.page_access_token || !(creds.form_ids || []).length) throw new Error('Add the page access token and lead form ids to pull');
  const out = [];
  const ts = Math.floor(new Date(since).getTime() / 1000);
  for (const formId of creds.form_ids) {
    let next = `${formId}/leads?fields=id,created_time,field_data,ad_name,platform&limit=100&filtering=${encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: ts }]))}`;
    for (let page = 0; next && page < 20; page += 1) {
      const json = await graphGet(next, creds.page_access_token);
      out.push(...(json.data || []));
      next = json.paging?.next ? json.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '').replace(/[?&]access_token=[^&]+/, '') : null;
    }
  }
  return out.map((lead) => ({ raw: lead, parse: (source) => N.metaLead(lead, source) }));
}

async function pullGoogle(conn, since) {
  const c = readCredentials(conn);
  if (!c.customer_id || !c.developer_token || !c.client_id || !c.client_secret || !c.refresh_token) throw new Error('Add Google Ads API credentials (customer id, developer token, OAuth client + refresh token) to pull');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!token.access_token) throw new Error(`Google OAuth failed: ${token.error_description || token.error || tokenRes.status}`);
  const version = await configService.getConfig('ingestion.google_ads_api_version', 'v18');
  const cid = String(c.customer_id).replace(/-/g, '');
  const stamp = new Date(since).toISOString().replace('T', ' ').slice(0, 19);
  const res = await fetch(`https://googleads.googleapis.com/${version}/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.access_token}`, 'developer-token': c.developer_token, 'content-type': 'application/json',
      ...(c.login_customer_id ? { 'login-customer-id': String(c.login_customer_id).replace(/-/g, '') } : {}),
    },
    body: JSON.stringify({
      query: `SELECT lead_form_submission_data.id, lead_form_submission_data.submission_date_time, lead_form_submission_data.lead_form_submission_fields FROM lead_form_submission_data WHERE lead_form_submission_data.submission_date_time > '${stamp}'`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Google Ads API ${res.status}`);
  return (json.results || []).map((r) => {
    const d = r.leadFormSubmissionData || {};
    const row = { id: d.id, lead_form_submission_fields: (d.leadFormSubmissionFields || []).map((f) => ({ field_type: f.fieldType, field_value: f.fieldValue })) };
    return { raw: row, parse: (source) => N.googleLead(row, source) };
  });
}

// Portals / generic: the org's lead-pull URL returning JSON (array, or
// { leads | data | results: [] }), `since` passed as a query parameter.
async function pullGeneric(conn, since) {
  const c = readCredentials(conn);
  if (!c.pull_url) throw new Error('Add the portal lead pull URL to pull');
  const url = new URL(c.pull_url);
  url.searchParams.set(c.pull_since_param || 'since', new Date(since).toISOString());
  const headers = {};
  if (c.api_key) headers[c.pull_auth_header || 'x-api-key'] = c.api_key;
  const res = await fetch(url, { headers });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`Pull failed: HTTP ${res.status}`);
  const rows = Array.isArray(json) ? json : json.leads || json.data || json.results || [];
  return rows.map((row) => ({ raw: row, parse: (source) => N.fromFlat(row, source) }));
}

const PULLERS = { meta: pullMeta, google: pullGoogle, portal: pullGeneric, generic: pullGeneric };

// Reconciliation for one connection: anything a missed webhook dropped.
async function pullConnection(connId, { manual = false } = {}) {
  const conn = (await pool.query('SELECT * FROM lead_source_connections WHERE id = $1', [connId])).rows[0];
  if (!conn) throw notFound('Connection not found');
  const source = (await pool.query('SELECT * FROM lead_sources WHERE id = $1', [conn.source_id])).rows[0];
  const puller = PULLERS[source.normaliser_module];
  if (!source.supports_pull || !puller) throw badRequest('This source has no pull adapter');
  const started = new Date();
  const since = conn.pull_cursor || new Date(Date.now() - 24 * 3600000);
  try {
    const items = await puller(conn, since);
    let created = 0;
    let duplicates = 0;
    for (const item of items) {
      const r = await ingest({ source, connection: conn, method: 'pull', mode: 'pull', raw: item.raw, parsed: item.parse(source) });
      if (r.status === 'lead_created') created += 1;
      else duplicates += 1;
    }
    await pool.query(
      `UPDATE lead_source_connections SET pull_cursor = $2, last_pull_at = now(), consecutive_failures = 0, last_error = NULL, failure_alerted_at = NULL,
         status = CASE WHEN status = 'error' THEN 'active' ELSE status END WHERE id = $1`,
      [conn.id, started]
    );
    return { fetched: items.length, created, duplicates };
  } catch (err) {
    const after = Number(await configService.getConfig('ingestion.pull_failure_alert_after', 3)) || 3;
    const row = (
      await pool.query(
        `UPDATE lead_source_connections SET last_pull_at = now(), consecutive_failures = consecutive_failures + 1, last_error = $2,
           status = CASE WHEN consecutive_failures + 1 >= $3 THEN 'error' ELSE status END WHERE id = $1 RETURNING *`,
        [conn.id, String(err.message).slice(0, 500), after]
      )
    ).rows[0];
    if (row.consecutive_failures >= after && !row.failure_alerted_at) {
      await pool.query('UPDATE lead_source_connections SET failure_alerted_at = now() WHERE id = $1', [conn.id]);
      await notifyAdmins(conn.tenant_id, {
        type: 'lead_source_failing', title: `${source.source_name} lead pull is failing`,
        message: `${row.consecutive_failures} failed pulls in a row: ${row.last_error}. Leads may be missing - check the connection in Settings > Lead Sources.`,
      });
    }
    if (manual) throw badRequest(`Pull failed: ${err.message}`);
    return { error: err.message };
  }
}

async function sweepPulls() {
  const due = (
    await pool.query(
      `SELECT c.id FROM lead_source_connections c JOIN lead_sources s ON s.id = c.source_id
       WHERE s.is_active AND s.supports_pull AND s.sync_mode IN ('pull', 'push+pull') AND c.status <> 'inactive'
         AND (c.last_pull_at IS NULL OR c.last_pull_at <= now() - make_interval(mins => s.poll_interval_minutes))`
    )
  ).rows;
  const out = [];
  for (const c of due) out.push({ id: c.id, ...(await pullConnection(c.id)) });
  return out;
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweepPulls().catch((err) => console.error('[ingestion] pull sweep failed:', err.message)), 60 * 1000);
}

// ---------------------------------------------------------------- review queue

async function listInbox(user, { status, source, tenantId, limit = 100 } = {}) {
  const where = ['1=1'];
  const params = [];
  if (!ADMIN.includes(user.role)) {
    if (user.role !== 'agency_admin' || !user.tenant_id) throw forbidden();
    params.push(user.tenant_id);
    where.push(`i.tenant_id = $${params.length}`);
  } else if (tenantId !== undefined && tenantId !== '') {
    params.push(tenantId === 'arb' ? NIL : tenantId);
    where.push(`COALESCE(i.tenant_id, '${NIL}'::uuid) = $${params.length}::uuid`);
  }
  if (status) {
    params.push(status);
    where.push(`i.parse_status = $${params.length}`);
  }
  if (source) {
    params.push(source);
    where.push(`i.source_key = $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 100, 300));
  const rows = (
    await pool.query(
      `SELECT i.id, i.tenant_id, COALESCE(t.name, 'A R Buildwel') AS org_name, i.source_key, s.source_name, i.external_lead_id, i.ingestion_method,
              i.parse_status, i.parse_confidence, i.parse_error, i.parsed_name, i.parsed_phone_masked, i.parsed_email, i.parsed_city, i.parsed_locality,
              i.parsed_budget, i.parsed_property_type, i.parsed_purpose, i.parsed_message, i.parsed_by_ai, i.dedup_result, i.created_lead_id,
              rep.full_name AS assigned_rep_name, i.created_at, i.processed_at
       FROM lead_ingestion_inbox i
       LEFT JOIN lead_sources s ON s.source_key = i.source_key
       LEFT JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN users rep ON rep.id = i.assigned_rep_id
       WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT $${params.length}`,
      params
    )
  ).rows;
  const counts = (
    await pool.query(
      `SELECT parse_status, COUNT(*)::int AS n FROM lead_ingestion_inbox WHERE created_at >= now() - interval '30 days'
       ${ADMIN.includes(user.role) ? '' : 'AND tenant_id = $1'} GROUP BY parse_status`,
      ADMIN.includes(user.role) ? [] : [user.tenant_id]
    )
  ).rows;
  return { counts: Object.fromEntries(counts.map((c) => [c.parse_status, c.n])), items: rows.map((r) => ({ ...r, parsed_budget: r.parsed_budget ? Number(r.parsed_budget) / 100 : null })) };
}

async function getInboxItem(user, id) {
  const row = (await pool.query('SELECT * FROM lead_ingestion_inbox WHERE id = $1', [id])).rows[0];
  if (!row) throw notFound('Inbox item not found');
  if (!ADMIN.includes(user.role) && !(user.role === 'agency_admin' && row.tenant_id === user.tenant_id)) throw notFound('Inbox item not found');
  let raw = row.raw_payload;
  if (!raw && row.raw_payload_ref) raw = `(archived at ${row.raw_payload_ref})`;
  const { parsed_phone_enc: enc, ...rest } = row;
  return { ...rest, parsed_budget: row.parsed_budget ? Number(row.parsed_budget) / 100 : null, raw_payload: raw };
}

// Admin completes a failed parse by hand and creates the lead.
async function resolveInbox(user, id, data) {
  const item = await getInboxItem(user, id);
  if (!['parse_failed', 'parsed'].includes(item.parse_status)) throw badRequest(`Item is ${item.parse_status}`);
  const stored = (await pool.query('SELECT parsed_phone_enc FROM lead_ingestion_inbox WHERE id = $1', [id])).rows[0];
  const parsed = {
    externalId: item.external_lead_id,
    name: data.name ?? item.parsed_name,
    phone: N.cleanPhone(data.phone) || (stored.parsed_phone_enc ? decrypt(stored.parsed_phone_enc) : null),
    email: N.cleanEmail(data.email) || item.parsed_email,
    city: data.city ?? item.parsed_city,
    locality: data.locality ?? item.parsed_locality,
    budget: data.budget != null ? N.parseBudget(data.budget) : item.parsed_budget,
    propertyType: data.propertyType ? N.mapPropertyType(data.propertyType) : item.parsed_property_type,
    purpose: data.purpose ?? item.parsed_purpose,
    message: data.message ?? item.parsed_message,
    propertyId: item.parsed_property_id,
  };
  if (!parsed.phone && !parsed.email) throw badRequest('A phone number or email is needed to create the lead');
  const source = await getSource(item.source_key);
  const res = await createLead(parsed, { source, tenantId: item.tenant_id, mode: item.ingestion_method === 'pull' ? 'pull' : 'push', inboxId: id, actor: user });
  await pool.query(
    `UPDATE lead_ingestion_inbox SET parse_status = $2, dedup_result = $3, created_lead_id = $4, assigned_rep_id = $5, reviewed_by = $6, processed_at = now(),
       parsed_name = $7, parsed_email = $8, parsed_city = $9, parsed_locality = $10, parsed_phone_enc = COALESCE($11, parsed_phone_enc),
       parsed_phone_masked = COALESCE($12, parsed_phone_masked)
     WHERE id = $1`,
    [id, res.created ? 'lead_created' : 'duplicate_detected', res.dedup, res.leadId, res.repId, user.id, parsed.name, parsed.email, parsed.city, parsed.locality,
      parsed.phone ? encrypt(parsed.phone) : null, parsed.phone ? maskPhone(parsed.phone) : null]
  );
  await auditService.log({ actor: user, action: 'lead_ingestion.resolved', entityType: 'lead_ingestion_inbox', entityId: id, after: { lead_id: res.leadId, dedup: res.dedup } });
  return { ...res, inboxId: id };
}

async function rejectInbox(user, id, reason) {
  const item = await getInboxItem(user, id);
  if (!['parse_failed', 'parsed'].includes(item.parse_status)) throw badRequest(`Item is ${item.parse_status}`);
  await pool.query(`UPDATE lead_ingestion_inbox SET parse_status = 'rejected', parse_error = $2, reviewed_by = $3, processed_at = now() WHERE id = $1`, [id, reason || 'Rejected by reviewer', user.id]);
  return { rejected: true };
}

// Dry run: normalise a sample payload with a source's normaliser + mapping.
async function testParse(sourceKey, payload) {
  const source = await getSource(sourceKey);
  let parsed;
  if (source.normaliser_module === 'meta') parsed = N.metaLead(payload || {}, source);
  else if (source.normaliser_module === 'google') parsed = N.googleLead(payload || {}, source);
  else if (source.normaliser_module === 'email') parsed = N.emailLead(payload || {});
  else parsed = N.fromFlat(payload || {}, source);
  return { parsed: { ...parsed, phone: parsed.phone ? maskPhone(parsed.phone) : null }, confidence: N.confidence(parsed) };
}

async function leadSources(leadId) {
  return (
    await pool.query(
      `SELECT h.source_tag, h.ingestion_mode, h.external_lead_id, h.received_at FROM lead_source_history h WHERE h.lead_id = $1 ORDER BY h.received_at`,
      [leadId]
    )
  ).rows;
}

module.exports = {
  ORG_ADMIN,
  listSources,
  getSource,
  createSource,
  updateSource,
  listConnections,
  saveConnection,
  deleteConnection,
  masterView,
  ingest,
  createLead,
  handleWebhook,
  metaVerify,
  handleMetaWebhook,
  handleEmail,
  pullConnection,
  sweepPulls,
  startScheduler,
  listInbox,
  getInboxItem,
  resolveInbox,
  rejectInbox,
  testParse,
  leadSources,
};
