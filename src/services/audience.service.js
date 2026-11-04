const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const { maskPhone, maskEmail } = require('../utils/masking');
const { badRequest, notFound } = require('../utils/httpError');

// Smart Audience Engine - Module 49.
//   Segments are rules over what the platform already records (events,
//   lead scores, requirements, investor profiles). Membership is recomputed
//   nightly and on demand; the rule is JSON an admin edits in the CRM:
//     { match: 'any' | 'all', conditions: [ condition, ... ] }
//   condition types:
//     event_count     { eventTypes: [..], minCount, days }
//     search_count    { propertyTypes: [..], minCount, days }   searches for those property types
//     budget_above    { minRupees }                              a search budget, requirement budget or viewed listing above it
//     distinct_views  { minProperties, minLocalities, days }
//     lead_score      { min }
//     nri             { homeCountry: 'IN' }                       NRI / OCI / PIO profile, or registered from another country
//     combo           { match, conditions }                       a nested rule
//   Sync: members with granted marketing consent (DPDP) go to Meta (Custom
//   Audience) and Google Ads (Customer Match) as SHA-256 hashes only; joiners
//   are added and leavers removed. Without the platform credentials a sync is
//   recorded as skipped - nothing else changes.

const TYPES = ['event_count', 'search_count', 'budget_above', 'distinct_views', 'lead_score', 'nri', 'combo'];
const MAX_DEPTH = 3;
const MAX_CONDITIONS = 10;
const PLATFORMS = ['meta', 'google'];

const settings = async () => ({ requireMarketingConsent: true, minSyncSize: 100, metaApiVersion: 'v21.0', googleAdsApiVersion: 'v18', ...((await configService.getConfig('audiences.settings', {})) || {}) });

// ------------------------------------------------------------------ rules

const int = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const words = (v, name) => {
  if (!Array.isArray(v) || !v.length || v.length > 20 || !v.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(x))) throw badRequest(`${name} must be a list of lowercase names`);
  return [...new Set(v)];
};

// Checks a rule and returns a clean copy (unknown keys dropped).
function normaliseRule(rule, depth = 1) {
  if (!rule || typeof rule !== 'object') throw badRequest('rule must be an object');
  const match = rule.match === 'all' ? 'all' : 'any';
  if (!Array.isArray(rule.conditions) || !rule.conditions.length) throw badRequest('rule needs at least one condition');
  if (rule.conditions.length > MAX_CONDITIONS) throw badRequest(`At most ${MAX_CONDITIONS} conditions in one group`);
  const conditions = rule.conditions.map((c) => {
    if (!c || !TYPES.includes(c.type)) throw badRequest(`condition type must be one of: ${TYPES.join(', ')}`);
    switch (c.type) {
      case 'event_count':
        return { type: c.type, eventTypes: words(c.eventTypes, 'eventTypes'), minCount: int(c.minCount ?? 1, 'minCount', 1, 1000), days: int(c.days ?? 30, 'days', 1, 730) };
      case 'search_count':
        return { type: c.type, propertyTypes: words(c.propertyTypes, 'propertyTypes'), minCount: int(c.minCount ?? 1, 'minCount', 1, 1000), days: int(c.days ?? 14, 'days', 1, 730) };
      case 'budget_above':
        return { type: c.type, minRupees: int(c.minRupees, 'minRupees', 1, 1e12) };
      case 'distinct_views':
        return { type: c.type, minProperties: int(c.minProperties ?? 10, 'minProperties', 1, 1000), minLocalities: int(c.minLocalities ?? 1, 'minLocalities', 1, 100), days: int(c.days ?? 30, 'days', 1, 730) };
      case 'lead_score':
        return { type: c.type, min: int(c.min, 'min', 0, 100) };
      case 'nri': {
        const home = String(c.homeCountry || 'IN').toUpperCase();
        if (!/^[A-Z]{2}$/.test(home)) throw badRequest('homeCountry is a 2-letter country code');
        return { type: c.type, homeCountry: home };
      }
      default:
        if (depth >= MAX_DEPTH) throw badRequest(`Groups can be nested ${MAX_DEPTH - 1} deep at most`);
        return { type: 'combo', ...normaliseRule(c, depth + 1) };
    }
  });
  return { match, conditions };
}

// Events with the person they belong to: the customer on the event, the
// customer of the signed-in user, or the customer linked to the browser id.
const PERSON_EVENTS = (since) => `
  SELECT COALESCE(e.customer_id, (SELECT cu.id FROM customers cu WHERE cu.user_id = e.user_id LIMIT 1), il.customer_id) AS customer_id,
         e.event_type, e.event_timestamp, e.properties_json AS p, e.device_json AS d
  FROM events e LEFT JOIN identity_links il ON il.anonymous_id = e.anonymous_id
  WHERE e.event_timestamp > now() - make_interval(days => ${since})`;

// One condition -> SQL that selects customer ids. Values go in `params`.
function conditionSql(c, params) {
  const $ = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (c.type) {
    case 'event_count':
      return `SELECT customer_id FROM (${PERSON_EVENTS($(c.days))}) pe
              WHERE customer_id IS NOT NULL AND event_type = ANY(${$(c.eventTypes)}::text[])
              GROUP BY customer_id HAVING COUNT(*) >= ${$(c.minCount)}`;
    case 'search_count':
      // The website sends { query, filters: { propertyType: 'a,b' } }; older clients put the filters at the top.
      return `SELECT customer_id FROM (${PERSON_EVENTS($(c.days))}) pe
              WHERE customer_id IS NOT NULL AND event_type = 'search_performed'
                AND EXISTS (SELECT 1 FROM unnest(string_to_array(lower(COALESCE(p->'filters'->>'propertyType', p->>'propertyType', '')), ',')) t
                            WHERE btrim(t) = ANY(${$(c.propertyTypes)}::text[]))
              GROUP BY customer_id HAVING COUNT(*) >= ${$(c.minCount)}`;
    case 'budget_above': {
      const min = $(c.minRupees);
      const num = (expr) => `CASE WHEN (${expr}) ~ '^[0-9]+(\\.[0-9]+)?$' THEN (${expr})::numeric END`;
      return `SELECT customer_id FROM (${PERSON_EVENTS(730)}) pe
              WHERE customer_id IS NOT NULL AND event_type = 'search_performed'
                AND GREATEST(${num(`COALESCE(p->'filters'->>'maxPrice', p->>'maxPrice')`)}, ${num(`COALESCE(p->'filters'->>'minPrice', p->>'minPrice')`)}) >= ${min}
              UNION
              SELECT customer_id FROM requirements WHERE customer_id IS NOT NULL AND budget_max >= ${min}
              UNION
              SELECT pe.customer_id FROM (${PERSON_EVENTS(730)}) pe JOIN properties pr ON pr.id::text = COALESCE(pe.p->>'property_id', pe.p->>'propertyId')
              WHERE pe.customer_id IS NOT NULL AND pe.event_type = 'property_view' AND pr.price_value >= ${min}`;
    }
    case 'distinct_views':
      return `SELECT pe.customer_id FROM (${PERSON_EVENTS($(c.days))}) pe
              LEFT JOIN properties pr ON pr.id::text = COALESCE(pe.p->>'property_id', pe.p->>'propertyId')
              WHERE pe.customer_id IS NOT NULL AND pe.event_type = 'property_view' AND COALESCE(pe.p->>'property_id', pe.p->>'propertyId') IS NOT NULL
              GROUP BY pe.customer_id
              HAVING COUNT(DISTINCT COALESCE(pe.p->>'property_id', pe.p->>'propertyId')) >= ${$(c.minProperties)}
                 AND COUNT(DISTINCT lower(COALESCE(pr.locality, pe.p->>'locality', pr.city, pe.p->>'city'))) >= ${$(c.minLocalities)}`;
    case 'lead_score':
      return `SELECT customer_id FROM lead_scores WHERE score >= ${$(c.min)}`;
    case 'nri': {
      const home = $(c.homeCountry);
      return `SELECT cu.id FROM customers cu JOIN investor_profiles ip ON ip.user_id = cu.user_id
              WHERE ip.is_nri OR ip.residency_status IN ('nri', 'oci', 'pio')
              UNION
              SELECT customer_id FROM (${PERSON_EVENTS(3650)}) pe
              WHERE customer_id IS NOT NULL AND event_type IN ('registration_completed', 'user_registered')
                AND d ? 'country' AND upper(d->>'country') <> ${home}`;
    }
    default:
      return ruleSql(c, params);
  }
}

function ruleSql(rule, params) {
  const parts = rule.conditions.map((c) => `(${conditionSql(c, params)})`);
  return parts.join(rule.match === 'all' ? ' INTERSECT ' : ' UNION ');
}

// ------------------------------------------------------------------ membership

async function preview(rule) {
  const clean = normaliseRule(rule);
  const params = [];
  const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM (${ruleSql(clean, params)}) m`, params)).rows[0].n;
  return { rule: clean, members: n };
}

// Recompute one segment: add joiners, keep joined_at for those still in, remove leavers.
async function refresh(segmentId) {
  const seg = (await pool.query('SELECT * FROM audience_segments WHERE id = $1', [segmentId])).rows[0];
  if (!seg) throw notFound('Audience not found');
  const params = [];
  const sql = ruleSql(normaliseRule(seg.rule), params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE _aud_now ON COMMIT DROP AS SELECT DISTINCT m.customer_id FROM (${sql}) m(customer_id) JOIN customers c ON c.id = m.customer_id`, params);
    const joined = (await client.query(
      `INSERT INTO audience_members (segment_id, customer_id) SELECT $1, customer_id FROM _aud_now
       ON CONFLICT (segment_id, customer_id) DO UPDATE SET last_seen_at = now() RETURNING (xmax = 0) AS inserted`,
      [seg.id]
    )).rows.filter((r) => r.inserted).length;
    const left = (await client.query(`DELETE FROM audience_members am WHERE am.segment_id = $1 AND NOT EXISTS (SELECT 1 FROM _aud_now n WHERE n.customer_id = am.customer_id)`, [seg.id])).rowCount;
    const total = (await client.query('SELECT COUNT(*)::int AS n FROM audience_members WHERE segment_id = $1', [seg.id])).rows[0].n;
    await client.query('UPDATE audience_segments SET member_count = $2, last_computed_at = now() WHERE id = $1', [seg.id, total]);
    await client.query('COMMIT');
    return { id: seg.id, key: seg.segment_key, members: total, joined, left };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function refreshAll() {
  const segs = (await pool.query('SELECT id FROM audience_segments WHERE active ORDER BY segment_key')).rows;
  const out = [];
  for (const s of segs) {
    try {
      out.push(await refresh(s.id));
    } catch (err) {
      console.error('[audiences] refresh failed:', s.id, err.message);
      out.push({ id: s.id, error: err.message });
    }
  }
  return out;
}

// ------------------------------------------------------------------ sync

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const normEmail = (e) => (e && /@/.test(e) ? String(e).trim().toLowerCase() : null);
// India-first numbers: a bare 10-digit mobile gets the 91 country code.
function normPhone(m) {
  if (!m) return null;
  let d = String(m).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
// Meta wants digits with the country code; Google wants E.164 (+ in front). Both hashed.
const hashesFor = (platform, row) => {
  const e = normEmail(row.email);
  const p = normPhone(row.mobile);
  return { email: e ? sha(e) : null, phone: p ? sha(platform === 'google' ? `+${p}` : p) : null };
};

function platformConfig(platform, seg) {
  if (platform === 'meta') {
    if (!process.env.META_ADS_ACCESS_TOKEN) return { missing: 'Meta is not connected - set META_ADS_ACCESS_TOKEN on the API server' };
    if (!seg.meta_audience_id) return { missing: 'Add the Meta custom audience id to this segment' };
    return { ok: true };
  }
  const need = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'].filter((k) => !process.env[k]);
  if (need.length) return { missing: `Google Ads is not connected - set ${need.join(', ')}` };
  if (!seg.google_user_list) return { missing: 'Add the Google Ads user list (customers/.../userLists/...) to this segment' };
  return { ok: true };
}

async function metaPush(seg, s, rows, method) {
  for (let i = 0; i < rows.length; i += 10000) {
    const chunk = rows.slice(i, i + 10000);
    const res = await fetch(`https://graph.facebook.com/${s.metaApiVersion}/${encodeURIComponent(seg.meta_audience_id)}/users`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: process.env.META_ADS_ACCESS_TOKEN, payload: { schema: ['EMAIL_SHA256', 'PHONE_SHA256'], data: chunk.map((r) => [r.email || '', r.phone || '']) } }),
    });
    if (!res.ok) throw new Error(`Meta ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function googleToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_ADS_CLIENT_ID, client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Google OAuth ${res.status}`);
  return (await res.json()).access_token;
}

async function googlePush(seg, s, adds, removes) {
  const token = await googleToken();
  const cid = String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, '');
  const base = `https://googleads.googleapis.com/${s.googleAdsApiVersion}`;
  const headers = { Authorization: `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN, 'Content-Type': 'application/json' };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers['login-customer-id'] = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '');
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Google Ads ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  const job = await post(`${base}/customers/${cid}/offlineUserDataJobs:create`, {
    job: { type: 'CUSTOMER_MATCH_USER_LIST', customerMatchUserListMetadata: { userList: seg.google_user_list, consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' } } },
  });
  const ids = (r) => [r.email && { hashedEmail: r.email }, r.phone && { hashedPhoneNumber: r.phone }].filter(Boolean);
  const ops = [...adds.map((r) => ({ create: { userIdentifiers: ids(r) } })), ...removes.map((r) => ({ remove: { userIdentifiers: ids(r) } }))];
  for (let i = 0; i < ops.length; i += 10000) await post(`${base}/${job.resourceName}:addOperations`, { operations: ops.slice(i, i + 10000), enablePartialFailure: true });
  await post(`${base}/${job.resourceName}:run`, {});
}

async function syncOne(seg, platform, s) {
  const run = (await pool.query(`INSERT INTO audience_sync_runs (segment_id, platform, status) VALUES ($1, $2, 'skipped') RETURNING id`, [seg.id, platform])).rows[0];
  const finish = (status, f = {}) =>
    pool.query(`UPDATE audience_sync_runs SET status = $2, sent = $3, removed = $4, held_back = $5, detail = $6, finished_at = now() WHERE id = $1`, [run.id, status, f.sent || 0, f.removed || 0, f.heldBack || 0, f.detail ? String(f.detail).slice(0, 500) : null]).then(() => ({ platform, status, ...f }));
  const mock = process.env.AUDIENCE_SYNC_MOCK === 'true';
  const cfg = mock ? { ok: true } : platformConfig(platform, seg);
  if (!cfg.ok) return finish('skipped', { detail: cfg.missing });

  // Members we may send: marketing consent granted (latest record), with an email or a mobile.
  const members = (await pool.query(
    `SELECT c.id AS customer_id, c.email, c.mobile,
            (SELECT cl.granted FROM consent_logs cl WHERE cl.user_id = c.user_id AND cl.category = 'marketing' ORDER BY cl.created_at DESC, cl.id DESC LIMIT 1) AS marketing
     FROM audience_members am JOIN customers c ON c.id = am.customer_id WHERE am.segment_id = $1`,
    [seg.id]
  )).rows;
  const allowed = members.filter((m) => !s.requireMarketingConsent || m.marketing === true).map((m) => ({ customer_id: m.customer_id, ...hashesFor(platform, m) })).filter((m) => m.email || m.phone);
  const heldBack = members.length - allowed.length;
  const prev = (await pool.query('SELECT customer_id, email_sha256 AS email, phone_sha256 AS phone FROM audience_synced_members WHERE segment_id = $1 AND platform = $2', [seg.id, platform])).rows;
  const now = new Set(allowed.map((m) => m.customer_id));
  const before = new Set(prev.map((m) => m.customer_id));
  // Too small a list: hold the joiners back, but leavers (and withdrawn consent) are always removed.
  const tooSmall = allowed.length < Number(s.minSyncSize || 0);
  const adds = tooSmall ? [] : allowed.filter((m) => !before.has(m.customer_id));
  const removes = prev.filter((m) => !now.has(m.customer_id));
  if (tooSmall && !removes.length) return finish('skipped', { heldBack, detail: `${allowed.length} members can be sent; the ad platforms need at least ${s.minSyncSize}` });
  try {
    if (!mock) {
      if (platform === 'meta') {
        if (adds.length) await metaPush(seg, s, adds, 'POST');
        if (removes.length) await metaPush(seg, s, removes, 'DELETE');
      } else if (adds.length || removes.length) await googlePush(seg, s, adds, removes);
    }
  } catch (err) {
    return finish('failed', { heldBack, detail: err.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (removes.length) await client.query('DELETE FROM audience_synced_members WHERE segment_id = $1 AND platform = $2 AND customer_id = ANY($3::uuid[])', [seg.id, platform, removes.map((r) => r.customer_id)]);
    for (const a of adds) {
      await client.query(`INSERT INTO audience_synced_members (segment_id, platform, customer_id, email_sha256, phone_sha256) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [seg.id, platform, a.customer_id, a.email, a.phone]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return finish('success', { sent: adds.length, removed: removes.length, heldBack, detail: mock ? 'mock mode - nothing sent' : null });
}

async function sync(segmentId) {
  const seg = (await pool.query('SELECT * FROM audience_segments WHERE id = $1', [segmentId])).rows[0];
  if (!seg) throw notFound('Audience not found');
  const s = await settings();
  const out = [];
  for (const p of PLATFORMS) if (seg[`sync_${p}`]) out.push(await syncOne(seg, p, s));
  if (!out.length) throw badRequest('Switch on Meta or Google Ads sync for this audience first');
  return out;
}

// ------------------------------------------------------------------ read / edit

const view = (r) => ({
  id: r.id, key: r.segment_key, name: r.name, description: r.description, rule: r.rule, active: r.active,
  sync: { meta: r.sync_meta, google: r.sync_google, metaAudienceId: r.meta_audience_id, googleUserList: r.google_user_list },
  members: r.member_count, lastComputedAt: r.last_computed_at, builtIn: r.built_in, updatedAt: r.updated_at,
  lastSyncs: r.last_syncs || [],
});

async function list() {
  const rows = (await pool.query(
    `SELECT s.*, (SELECT COALESCE(json_agg(x ORDER BY x.platform), '[]') FROM (
        SELECT DISTINCT ON (platform) platform, status, sent, removed, held_back AS "heldBack", detail, started_at AS at
        FROM audience_sync_runs WHERE segment_id = s.id ORDER BY platform, started_at DESC) x) AS last_syncs
     FROM audience_segments s ORDER BY s.built_in DESC, s.name`
  )).rows;
  return {
    items: rows.map(view),
    connected: { meta: !!process.env.META_ADS_ACCESS_TOKEN, google: !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_REFRESH_TOKEN) },
    settings: await settings(),
    conditionTypes: TYPES,
  };
}

async function get(id) {
  const r = (await pool.query('SELECT * FROM audience_segments WHERE id = $1', [id])).rows[0];
  if (!r) throw notFound('Audience not found');
  const syncs = (await pool.query(`SELECT platform, status, sent, removed, held_back AS "heldBack", detail, started_at AS at FROM audience_sync_runs WHERE segment_id = $1 ORDER BY started_at DESC LIMIT 20`, [id])).rows;
  return { ...view(r), syncHistory: syncs };
}

// Members, masked - ad audiences never need the full contact on screen.
async function members(id, { page = 1, limit = 50 } = {}) {
  await get(id);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const rows = (await pool.query(
    `SELECT c.id, c.full_name, c.mobile, c.email, am.joined_at, ls.score, ls.category,
            (SELECT cl.granted FROM consent_logs cl WHERE cl.user_id = c.user_id AND cl.category = 'marketing' ORDER BY cl.created_at DESC, cl.id DESC LIMIT 1) AS marketing,
            COUNT(*) OVER()::int AS total
     FROM audience_members am JOIN customers c ON c.id = am.customer_id LEFT JOIN lead_scores ls ON ls.customer_id = c.id
     WHERE am.segment_id = $1 ORDER BY am.joined_at DESC LIMIT $2 OFFSET $3`,
    [id, lim, off]
  )).rows;
  return {
    items: rows.map((r) => ({ customerId: r.id, name: r.full_name, mobile: maskPhone(r.mobile), email: maskEmail(r.email), joinedAt: r.joined_at, leadScore: r.score, category: r.category, marketingConsent: r.marketing === true })),
    total: rows[0]?.total || 0, page: Math.max(Number(page) || 1, 1), limit: lim,
  };
}

function cleanSync(d, before = {}) {
  const out = {};
  if (d.syncMeta !== undefined) out.sync_meta = !!d.syncMeta;
  if (d.syncGoogle !== undefined) out.sync_google = !!d.syncGoogle;
  if (d.metaAudienceId !== undefined) {
    const v = d.metaAudienceId ? String(d.metaAudienceId).trim() : null;
    if (v && !/^\d{6,30}$/.test(v)) throw badRequest('The Meta custom audience id is a number');
    out.meta_audience_id = v;
  }
  if (d.googleUserList !== undefined) {
    const v = d.googleUserList ? String(d.googleUserList).trim() : null;
    if (v && !/^customers\/\d+\/userLists\/\d+$/.test(v)) throw badRequest('The Google Ads user list looks like customers/1234567890/userLists/987654321');
    out.google_user_list = v;
  }
  void before;
  return out;
}

async function create(user, d, meta = {}) {
  const key = String(d.key || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,39}$/.test(key)) throw badRequest('key: 3-40 lowercase letters, digits or _');
  const name = String(d.name || '').trim();
  if (name.length < 3 || name.length > 100) throw badRequest('name: 3-100 characters');
  const rule = normaliseRule(d.rule);
  const sync = cleanSync(d);
  const r = (await pool.query(
    `INSERT INTO audience_segments (segment_key, name, description, rule, active, sync_meta, sync_google, meta_audience_id, google_user_list, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) ON CONFLICT (segment_key) DO NOTHING RETURNING *`,
    [key, name, d.description ? String(d.description).slice(0, 500) : null, JSON.stringify(rule), d.active !== false, !!sync.sync_meta, !!sync.sync_google, sync.meta_audience_id || null, sync.google_user_list || null, user.id]
  )).rows[0];
  if (!r) throw badRequest('An audience with this key already exists');
  await auditService.log({ actor: user, action: 'audience.created', entityType: 'audience_segment', entityId: r.id, after: { key, name, rule }, ...meta });
  await refresh(r.id);
  return get(r.id);
}

async function update(user, id, d, meta = {}) {
  const before = (await pool.query('SELECT * FROM audience_segments WHERE id = $1', [id])).rows[0];
  if (!before) throw notFound('Audience not found');
  const set = { ...cleanSync(d, before) };
  if (d.name !== undefined) {
    const name = String(d.name).trim();
    if (name.length < 3 || name.length > 100) throw badRequest('name: 3-100 characters');
    set.name = name;
  }
  if (d.description !== undefined) set.description = d.description ? String(d.description).slice(0, 500) : null;
  if (d.active !== undefined) set.active = !!d.active;
  if (d.rule !== undefined) set.rule = JSON.stringify(normaliseRule(d.rule));
  const keys = Object.keys(set);
  if (!keys.length) throw badRequest('Nothing to change');
  await pool.query(
    `UPDATE audience_segments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => set[k]), user.id]
  );
  await auditService.log({ actor: user, action: 'audience.updated', entityType: 'audience_segment', entityId: id, before: { name: before.name, rule: before.rule, active: before.active, sync_meta: before.sync_meta, sync_google: before.sync_google }, after: set, ...meta });
  if (set.rule || set.active === true) await refresh(id);
  return get(id);
}

// ------------------------------------------------------------------ jobs

let timer = null;
async function nightly() {
  await refreshAll();
  const segs = (await pool.query('SELECT id FROM audience_segments WHERE active AND (sync_meta OR sync_google)')).rows;
  for (const s of segs) await sync(s.id).catch((err) => console.error('[audiences] sync failed:', s.id, err.message));
}
function startScheduler() {
  if (timer) return;
  // Every 6 hours: segments stay fresh through the day; ad platforms refresh lists about daily anyway.
  timer = setInterval(() => nightly().catch((err) => console.error('[audiences] run failed:', err.message)), 6 * 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = { normaliseRule, preview, refresh, refreshAll, sync, list, get, members, create, update, startScheduler, nightly, _test: { normPhone, hashesFor } };
