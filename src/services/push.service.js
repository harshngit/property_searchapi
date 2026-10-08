const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const { badRequest } = require('../utils/httpError');

// Web Push for the PWA (Module 18). Implemented on Node's crypto - VAPID
// (RFC 8292) + aes128gcm message encryption (RFC 8291) - so no third-party
// push library is needed.
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  base64url P-256 key pair
//                                         (npm run vapid:generate)
//   VAPID_SUBJECT                         mailto: / https: contact
// Every in-app notification is also pushed to the user's subscribed
// browsers (notification.service -> notifyUser). Dead subscriptions (404 /
// 410 from the push service) are removed.

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

function keys() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || 'mailto:support@propertyserch.com' };
}

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidAuthorization(endpoint, k) {
  const pub = fromB64u(k.publicKey);
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: k.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: k.subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.publicKey}`;
}

// RFC 8291 aes128gcm body for one record.
function encrypt(payload, p256dh, auth) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function assertEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    throw badRequest('Invalid push endpoint');
  }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  // Only real browser push services (the server posts to this URL).
  if (process.env.NODE_ENV === 'production' || !local) {
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname))) throw badRequest('Unsupported push service');
  }
  return u.toString();
}

async function subscribe(user, { endpoint, keys: k, app }, userAgent) {
  const url = assertEndpoint(endpoint);
  if (!k?.p256dh || !k?.auth || fromB64u(k.p256dh).length !== 65 || fromB64u(k.auth).length < 16) throw badRequest('Invalid push subscription keys');
  const r = await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, app) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent,
       app = EXCLUDED.app, failure_count = 0
     RETURNING id`,
    [user.id, url, k.p256dh, k.auth, String(userAgent || '').slice(0, 300), app === 'crm' ? 'crm' : 'website']
  );
  return { id: r.rows[0].id, subscribed: true };
}

async function unsubscribe(user, { endpoint }) {
  const r = await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2 RETURNING id', [user.id, String(endpoint || '')]);
  return { removed: r.rows.length };
}

async function status(user) {
  const n = (await pool.query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [user.id])).rows[0].n;
  return { configured: !!keys(), publicKey: keys()?.publicKey || null, subscriptions: n };
}

async function sendOne(sub, payload, k) {
  const body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: vapidAuthorization(sub.endpoint, k), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: payload.urgent ? 'high' : 'normal' },
      body,
      signal: controller.signal,
    });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// Push to every browser a user subscribed. Returns { sent, removed }.
async function sendToUser(userId, { title, body, url, tag, urgent = false }) {
  const k = keys();
  if (!k || !(await configService.getConfig('push.enabled', true))) return { sent: 0, removed: 0, skipped: true };
  const subs = (await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId])).rows;
  let sent = 0;
  let removed = 0;
  for (const sub of subs) {
    const target = url || (sub.app === 'crm' ? '/app/dashboard' : '/dashboard/notifications');
    const code = await sendOne(sub, { title: String(title || 'PropertySerch').slice(0, 120), body: String(body || '').slice(0, 300), url: target, tag: tag || undefined, urgent }, k);
    if (code >= 200 && code < 300) {
      sent += 1;
      await pool.query('UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1', [sub.id]);
    } else if (code === 404 || code === 410) {
      removed += 1;
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
    } else {
      // Give up on a subscription that keeps failing.
      const r = await pool.query('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1 RETURNING failure_count', [sub.id]);
      if (r.rows[0]?.failure_count >= 10) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
    }
  }
  return { sent, removed };
}

// ------------------------------------------------------------ preferences
// Notification preferences (Module 45): the in-app inbox always receives
// everything; push can be switched off, muted per topic, and held back
// during the person's quiet hours (in their own time zone).

const TOPICS = {
  matches: 'Matched properties, requirements and investment alerts',
  enquiries: 'Enquiries, site visits and assignments',
  deals: 'Deals, mandates, documents and invoices',
  rentals: 'Leases, rent and maintenance',
  account: 'Verification, reviews, trust and disputes',
  updates: 'Other updates',
};
function topicOf(type) {
  const t = String(type || '').toLowerCase();
  if (/match|requirement|saved_search|investor_alert|opportunit|deal_alert|hot_/.test(t)) return 'matches';
  if (/lead|visit|enquir|assign|guest|inquiry|sla_response/.test(t)) return 'enquiries';
  if (/deal|invoice|mandate|payment|document|milestone|orchestration/.test(t)) return 'deals';
  if (/lease|rent|maintenance|tenant/.test(t)) return 'rentals';
  if (/trust|review|verif|dispute|fraud|reputation|kyc|badge|duplicate/.test(t)) return 'account';
  return 'updates';
}

const DEFAULT_PREFS = { pushEnabled: true, pushMuted: [], quietStart: null, quietEnd: null, timezone: 'Asia/Kolkata' };

async function getPreferences(userId) {
  const r = (await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId])).rows[0];
  const prefs = r
    ? { pushEnabled: r.push_enabled, pushMuted: r.push_muted || [], quietStart: r.quiet_start ? String(r.quiet_start).slice(0, 5) : null, quietEnd: r.quiet_end ? String(r.quiet_end).slice(0, 5) : null, timezone: r.timezone }
    : { ...DEFAULT_PREFS };
  return { ...prefs, topics: Object.entries(TOPICS).map(([key, label]) => ({ key, label, push: !prefs.pushMuted.includes(key) })) };
}

async function updatePreferences(userId, data) {
  const cur = await getPreferences(userId);
  const hhmm = (v) => (v === null || v === '' ? null : /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : undefined);
  const next = {
    pushEnabled: data.pushEnabled === undefined ? cur.pushEnabled : !!data.pushEnabled,
    pushMuted: Array.isArray(data.pushMuted) ? [...new Set(data.pushMuted.filter((k) => TOPICS[k]))] : cur.pushMuted,
    quietStart: data.quietStart === undefined ? cur.quietStart : hhmm(data.quietStart),
    quietEnd: data.quietEnd === undefined ? cur.quietEnd : hhmm(data.quietEnd),
    timezone: data.timezone === undefined ? cur.timezone : String(data.timezone).slice(0, 60),
  };
  if (next.quietStart === undefined || next.quietEnd === undefined) throw badRequest('Quiet hours must be HH:MM (24-hour)');
  if (!!next.quietStart !== !!next.quietEnd) throw badRequest('Set both a start and an end for quiet hours, or neither');
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: next.timezone });
  } catch {
    throw badRequest('Unknown time zone');
  }
  await pool.query(
    `INSERT INTO notification_preferences (user_id, push_enabled, push_muted, quiet_start, quiet_end, timezone, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET push_enabled = EXCLUDED.push_enabled, push_muted = EXCLUDED.push_muted, quiet_start = EXCLUDED.quiet_start,
       quiet_end = EXCLUDED.quiet_end, timezone = EXCLUDED.timezone, updated_at = now()`,
    [userId, next.pushEnabled, JSON.stringify(next.pushMuted), next.quietStart, next.quietEnd, next.timezone]
  );
  return getPreferences(userId);
}

function inQuietHours(prefs, now = new Date()) {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: prefs.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(/^24/, '00');
  // A window that crosses midnight (22:00 - 07:00) wraps.
  return prefs.quietStart <= prefs.quietEnd ? local >= prefs.quietStart && local < prefs.quietEnd : local >= prefs.quietStart || local < prefs.quietEnd;
}

// Would a push of this type reach this person right now?
async function pushAllowed(userId, type, now = new Date()) {
  const prefs = await getPreferences(userId);
  if (!prefs.pushEnabled) return { allowed: false, reason: 'push_off' };
  if (prefs.pushMuted.includes(topicOf(type))) return { allowed: false, reason: 'topic_muted' };
  if (inQuietHours(prefs, now)) return { allowed: false, reason: 'quiet_hours' };
  return { allowed: true };
}

// Fire-and-forget from notification.service - never throws.
function notifyUser(userId, notification) {
  if (!userId || !keys()) return;
  pushAllowed(userId, notification.type)
    .then((p) => (p.allowed ? sendToUser(userId, { title: notification.title, body: notification.message, tag: notification.type }) : null))
    .catch((err) => console.error('[push] send failed:', err.message));
}

module.exports = { subscribe, unsubscribe, status, sendToUser, notifyUser, generateVapidKeys, encrypt, vapidAuthorization, getPreferences, updatePreferences, pushAllowed, topicOf, inQuietHours };
