const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const imageScan = require('./imageScan.service');
const msg91 = require('./msg91.service');
const { encrypt } = require('../utils/crypto');
const { uploadBuffer, getReadUrl } = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 47 - Work From Home (WFH) Citizen-Sourcing.
//
//   Join      any registered user accepts the Field Partner Agreement and
//             submits Aadhaar + bank details (stored encrypted). They can
//             browse tasks at once; accepting and submitting needs KYC.
//   Board     open tasks near the worker (default 5 km). Accepting reserves
//             a task for 48 hours; letting it lapse is a forfeit.
//   Evidence  per task type: GPS check-in, photos with EXIF location and
//             time, the buyer's / seller's phone, a structured report.
//   Checks    nothing is paid until every check for the task type passes:
//             distance, photo EXIF, phone not the worker's own and not
//             used in the last 90 days, OTP of the buyer / seller within
//             10 minutes, then the A R representative's confirmation
//             (buyer visit) or a staff quality review (photo / report
//             tasks).
//   Money     the amount is fixed on the task when it is created. Verified
//             earnings are paid monthly, less TDS once the yearly threshold
//             is crossed; each payout has a slip.
//   Phase 1   paid for the task, not for any deal that follows.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const isStaff = (u) => STAFF.includes(u.role);
const TYPES = {
  buyer_visit: { label: 'Buyer site visit', party: 'buyer', gps: true, otp: true, confirm: 'rep', sourceTag: 'WFH-BuyerVisit', needsProperty: true },
  seller_photo: { label: 'Seller photo permission', party: 'seller', photos: 'min', exif: true, otp: true, confirm: 'review', sourceTag: 'WFH-SellerPhoto' },
  requirement_collect: { label: 'Requirement collection', party: 'buyer', otp: true, confirm: 'auto', sourceTag: 'WFH-Requirement' },
  listing_assist: { label: 'Seller listing assist', party: 'seller', otp: true, confirm: 'listing', sourceTag: 'WFH-ListingAssist' },
  condition_report: { label: 'Property condition report', gps: true, photos: 3, exif: true, confirm: 'review', needsProperty: true },
  auction_check: { label: 'Auction property field check', gps: true, photos: 2, exif: true, confirm: 'review', needsProperty: true },
  area_survey: { label: 'Area demand mini-survey', party: 'buyer', otp: true, confirm: 'auto', sourceTag: 'WFH-AreaSurvey' },
};
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const sha = (s) => crypto.createHash('sha256').update(`${process.env.JWT_ACCESS_SECRET || 'wfh'}|${s}`).digest('hex');
const phoneOf = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const enabled = async () => (await configService.getConfig('wfh.enabled', true)) !== false;

// Metres between two points.
function distance(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || Number.isNaN(Number(v)))) return null;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ------------------------------------------------------------ configuration

let cache = { at: 0, value: null };
async function cfg() {
  if (cache.value && Date.now() - cache.at < 30000) return cache.value;
  const rows = (await pool.query('SELECT config_key, value FROM wfh_task_config')).rows;
  cache = { at: Date.now(), value: Object.fromEntries(rows.map((r) => [r.config_key, r.value])) };
  return cache.value;
}
const n = (c, key, fallback) => (Number.isFinite(Number(c[key])) ? Number(c[key]) : fallback);

// The amount for a task type, with the most specific override first (city + property type, then either).
async function amountFor(type, { city, propertyType } = {}) {
  const c = await cfg();
  const v = c[`${type}_payment_default`] || { amount: 0, overrides: [] };
  const same = (a, b) => !a || String(a).toLowerCase() === String(b || '').toLowerCase();
  const fit = (v.overrides || []).filter((o) => same(o.city, city) && same(o.propertyType, propertyType)).sort((a, b) => (b.city ? 1 : 0) + (b.propertyType ? 1 : 0) - ((a.city ? 1 : 0) + (a.propertyType ? 1 : 0)));
  return r2(fit[0]?.amount ?? v.amount ?? 0);
}

async function getConfig() {
  const rows = (await pool.query('SELECT config_key, value, description, effective_from, updated_at FROM wfh_task_config ORDER BY (config_key LIKE \'%payment_default\') DESC, config_key')).rows;
  const [rate, threshold, noPan] = await Promise.all([configService.getConfig('tax.payout_tds_percent', 5), configService.getConfig('tax.payout_tds_threshold', 15000), configService.getConfig('tax.payout_tds_no_pan_percent', 20)]);
  return { items: rows.map((r) => ({ key: r.config_key, value: r.value, description: r.description, isPayment: r.config_key.endsWith('_payment_default'), updatedAt: r.updated_at })), statutory: { tdsPercent: Number(rate), tdsThreshold: Number(threshold), tdsNoPanPercent: Number(noPan) }, taskTypes: Object.entries(TYPES).map(([key, t]) => ({ key, label: t.label })) };
}

async function updateConfig(admin, key, value, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  const cur = (await pool.query('SELECT value FROM wfh_task_config WHERE config_key = $1', [key])).rows[0];
  if (!cur) throw notFound('Setting not found');
  let next = value;
  if (key.endsWith('_payment_default')) {
    const amount = Number(value?.amount);
    if (!(amount >= 0) || amount > 100000) throw badRequest('Amount must be between 0 and 1,00,000');
    const overrides = (Array.isArray(value?.overrides) ? value.overrides : []).map((o) => ({ city: o.city ? String(o.city).trim() : undefined, propertyType: o.propertyType ? String(o.propertyType).trim() : undefined, amount: Number(o.amount) })).filter((o) => (o.city || o.propertyType) && o.amount >= 0);
    next = { amount: r2(amount), overrides };
  } else if (typeof cur.value === 'number') {
    next = Number(value);
    if (!Number.isFinite(next) || next < 0) throw badRequest('Give a number of zero or more');
  } else if (typeof cur.value === 'boolean') next = value === true || value === 'true';
  else next = String(value).slice(0, 120);
  await pool.query('UPDATE wfh_task_config SET value = $1, effective_from = CURRENT_DATE, updated_by = $2, updated_at = now() WHERE config_key = $3', [JSON.stringify(next), admin.id, key]);
  cache = { at: 0, value: null };
  await auditService.log({ actor: admin, action: 'wfh.config_updated', entityType: 'wfh_task_config', entityId: null, before: { [key]: cur.value }, after: { [key]: next }, ...meta });
  return { key, value: next };
}

// ------------------------------------------------------------ worker

const workerView = (w, staff = false) => ({
  userId: w.user_id, name: w.full_name, kycStatus: w.kyc_status, kycNote: w.kyc_note, status: w.status, statusNote: w.status_note, city: w.city, locality: w.locality,
  latitude: num(w.latitude), longitude: num(w.longitude), aadhaarLast4: w.aadhaar_last4, hasPan: !!w.pan_hash, bankAccountLast4: w.bank_account_last4, bankIfsc: w.bank_ifsc, bankAccountName: w.bank_account_name,
  agreementVersion: w.agreement_version, agreementAcceptedAt: w.agreement_accepted_at, totalEarned: num(w.total_earned), totalPaidOut: num(w.total_paid_out), rejectionRate: num(w.rejection_rate), forfeitRate: num(w.forfeit_rate),
  acceptBlockedUntil: w.accept_blocked_until, createdAt: w.created_at, mobile: staff ? w.mobile : undefined, email: staff ? w.email : undefined, sharedDevice: staff ? w.shared_device : undefined,
});

async function workerRow(userId) {
  return (await pool.query(`SELECT w.*, u.full_name, u.mobile, u.email FROM wfh_workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = $1`, [userId])).rows[0] || null;
}

const deviceHash = (meta) => (meta.userAgent || meta.ip ? sha(`${meta.userAgent || ''}|${meta.ip || ''}`) : null);

async function register(user, data, meta = {}) {
  if (!(await enabled())) throw badRequest('This programme is not open at the moment');
  if (isStaff(user)) throw badRequest('A R Buildwel staff cannot join the field network');
  const c = await cfg();
  if (!data.agreementAccepted) throw badRequest('Accept the Field Partner Agreement to join');
  const aadhaar = String(data.aadhaar || '').replace(/\D/g, '');
  if (!/^\d{12}$/.test(aadhaar)) throw badRequest('Enter the 12-digit Aadhaar number');
  const account = String(data.bankAccount || '').replace(/\s/g, '');
  if (!/^\d{9,18}$/.test(account)) throw badRequest('Enter a valid bank account number');
  const ifsc = String(data.bankIfsc || '').toUpperCase().trim();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw badRequest('Enter a valid IFSC code');
  const pan = data.pan ? String(data.pan).toUpperCase().trim() : null;
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw badRequest('Enter a valid PAN');
  const lat = data.latitude === undefined || data.latitude === '' ? null : Number(data.latitude);
  const lng = data.longitude === undefined || data.longitude === '' ? null : Number(data.longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Share your location so we can show tasks near you');
  const existing = await workerRow(user.id);
  if (existing && existing.kyc_status === 'verified') throw badRequest('Your KYC is already verified - ask A R Buildwel to change bank details');
  // One Aadhaar, one field partner.
  if ((await pool.query('SELECT 1 FROM wfh_workers WHERE aadhaar_hash = $1 AND user_id <> $2', [sha(aadhaar), user.id])).rows.length) throw badRequest('This Aadhaar is already registered with another account');
  const device = deviceHash(meta);
  await pool.query(
    `INSERT INTO wfh_workers (user_id, aadhaar_number_encrypted, aadhaar_hash, aadhaar_last4, pan_encrypted, pan_hash, bank_account_encrypted, bank_account_last4, bank_ifsc, bank_account_name,
       agreement_version, agreement_accepted_at, agreement_ip, city, locality, latitude, longitude, device_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12, $13, $14, $15, $16, $17)
     ON CONFLICT (user_id) DO UPDATE SET aadhaar_number_encrypted = EXCLUDED.aadhaar_number_encrypted, aadhaar_hash = EXCLUDED.aadhaar_hash, aadhaar_last4 = EXCLUDED.aadhaar_last4, pan_encrypted = EXCLUDED.pan_encrypted,
       pan_hash = EXCLUDED.pan_hash, bank_account_encrypted = EXCLUDED.bank_account_encrypted, bank_account_last4 = EXCLUDED.bank_account_last4, bank_ifsc = EXCLUDED.bank_ifsc, bank_account_name = EXCLUDED.bank_account_name,
       agreement_version = EXCLUDED.agreement_version, agreement_accepted_at = now(), agreement_ip = EXCLUDED.agreement_ip, city = EXCLUDED.city, locality = EXCLUDED.locality, latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude, device_hash = EXCLUDED.device_hash, kyc_status = 'pending', kyc_note = NULL, updated_at = now()`,
    [user.id, encrypt(aadhaar), sha(aadhaar), aadhaar.slice(-4), pan ? encrypt(pan) : null, pan ? sha(pan) : null, encrypt(account), account.slice(-4), ifsc, data.bankAccountName ? String(data.bankAccountName).slice(0, 120) : null,
      String(c.agreement_version || '1.0'), meta.ip || null, data.city ? String(data.city).slice(0, 120) : null, data.locality ? String(data.locality).slice(0, 160) : null, lat, lng, device]
  );
  // Several field accounts from one device is a fraud signal for staff.
  if (device && (await pool.query('SELECT COUNT(*)::int AS n FROM wfh_workers WHERE device_hash = $1', [device])).rows[0].n > 1) {
    await pool.query(`INSERT INTO user_flags (user_id, reason, detail) VALUES ($1, 'wfh_shared_device', $2)`, [user.id, JSON.stringify({ note: 'Another field partner registered from the same device' })]);
  }
  await auditService.log({ actor: user, action: 'wfh.registered', entityType: 'wfh_worker', entityId: user.id, after: { city: data.city, agreementVersion: c.agreement_version }, ...meta });
  return me(user);
}

async function updateLocation(user, { latitude, longitude, city, locality }) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Not a valid location');
  const r = await pool.query('UPDATE wfh_workers SET latitude = $1, longitude = $2, city = COALESCE($3, city), locality = COALESCE($4, locality), updated_at = now() WHERE user_id = $5', [lat, lng, city || null, locality || null, user.id]);
  if (!r.rowCount) throw badRequest('Join the programme first');
  return { latitude: lat, longitude: lng };
}

// What stops this worker from taking or submitting tasks right now (null = nothing).
function blocker(w, c) {
  if (!w) return 'Join the programme first';
  if (w.status !== 'active') return `Your field partner account is ${w.status}${w.status_note ? `: ${w.status_note}` : ''}`;
  if (w.kyc_status !== 'verified') return w.kyc_status === 'rejected' ? `KYC was not approved${w.kyc_note ? `: ${w.kyc_note}` : ''} - submit it again` : 'Your KYC is being verified - you can browse tasks meanwhile';
  if (w.agreement_version !== String(c.agreement_version || '1.0')) return 'Accept the updated Field Partner Agreement to continue';
  if (w.accept_blocked_until && new Date(w.accept_blocked_until) > new Date()) return `Task acceptance is paused until ${new Date(w.accept_blocked_until).toLocaleDateString('en-IN')} because too many accepted tasks were not completed`;
  return null;
}

// ------------------------------------------------------------ tasks

const taskView = (t, extra = {}) => ({
  id: t.id, taskType: t.task_type, taskTypeLabel: TYPES[t.task_type].label, title: t.title, instructions: t.instructions, city: t.city, locality: t.locality, paymentAmount: num(t.payment_amount),
  expiryAt: t.expiry_at, status: t.status, propertyId: t.property_id, origin: t.origin, createdAt: t.created_at, ...extra,
});

async function createTask(admin, data, meta = {}) {
  if (!isStaff(admin)) throw forbidden('A R Buildwel staff create tasks');
  const type = TYPES[data.taskType];
  if (!type) throw badRequest('Unknown task type');
  const c = await cfg();
  let p = null;
  if (data.propertyId) {
    p = (await pool.query('SELECT id, title, city, locality, latitude, longitude, property_type::text AS property_type, status::text AS status FROM properties WHERE id = $1', [data.propertyId])).rows[0];
    if (!p) throw badRequest('Listing not found');
  }
  if (type.needsProperty && !p) throw badRequest('Choose the listing for this task');
  const lat = data.latitude !== undefined && data.latitude !== '' && data.latitude !== null ? Number(data.latitude) : num(p?.latitude);
  const lng = data.longitude !== undefined && data.longitude !== '' && data.longitude !== null ? Number(data.longitude) : num(p?.longitude);
  if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) throw badRequest(p ? 'This listing has no map location - set it on the listing or give the coordinates' : 'Give the location (latitude and longitude) of the task');
  const city = data.city || p?.city || null;
  const locality = data.locality || p?.locality || null;
  const amount = await amountFor(data.taskType, { city, propertyType: p?.property_type });
  const days = Number(data.expiryDays) > 0 ? Math.min(Number(data.expiryDays), 90) : n(c, 'task_expiry_days', 14);
  const count = Math.min(Math.max(Number(data.count) || 1, 1), 50);
  const title = String(data.title || `${type.label}${locality ? ` - ${locality}` : city ? ` - ${city}` : ''}`).slice(0, 200);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push((await pool.query(
      `INSERT INTO wfh_tasks (task_type, property_id, requirement_id, title, instructions, city, locality, latitude, longitude, payment_amount, origin, expiry_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + ($12 || ' days')::interval, $13) RETURNING *`,
      [data.taskType, p?.id || null, data.requirementId || null, title, data.instructions ? String(data.instructions).slice(0, 2000) : null, city, locality, lat, lng, amount, data.origin || 'admin', String(days), admin.id || null]
    )).rows[0]);
  }
  if (admin.id) await auditService.log({ actor: admin, action: 'wfh.task_created', entityType: 'wfh_task', entityId: out[0].id, after: { type: data.taskType, count, amount }, ...meta });
  return out.map((t) => taskView(t));
}

async function cancelTask(admin, id, meta = {}) {
  if (!isStaff(admin)) throw forbidden('A R Buildwel staff only');
  const t = (await pool.query(`UPDATE wfh_tasks SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING *`, [id])).rows[0];
  if (!t) throw badRequest('Only an open task can be cancelled');
  await auditService.log({ actor: admin, action: 'wfh.task_cancelled', entityType: 'wfh_task', entityId: id, ...meta });
  return taskView(t);
}

async function listTasks({ status, taskType } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (taskType) { params.push(taskType); where.push(`t.task_type = $${params.length}`); }
  const r = await pool.query(
    `SELECT t.*, p.title AS property_title, u.full_name AS worker_name FROM wfh_tasks t LEFT JOIN properties p ON p.id = t.property_id
     LEFT JOIN wfh_task_assignments a ON a.task_id = t.id AND a.state IN ('accepted', 'submitted') LEFT JOIN users u ON u.id = a.worker_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC LIMIT 300`, params);
  return r.rows.map((t) => taskView(t, { propertyTitle: t.property_title, workerName: t.worker_name, latitude: num(t.latitude), longitude: num(t.longitude) }));
}

// Tasks near the worker. The exact property is not named until the task is accepted.
async function board(user, { latitude, longitude, taskType, minPayment } = {}) {
  if (!(await enabled())) return { enabled: false, items: [] };
  const c = await cfg();
  const w = await workerRow(user.id);
  const lat = latitude !== undefined && latitude !== '' ? Number(latitude) : num(w?.latitude);
  const lng = longitude !== undefined && longitude !== '' ? Number(longitude) : num(w?.longitude);
  const radius = n(c, 'board_radius_km', 5);
  if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) return { enabled: true, needsLocation: true, radiusKm: radius, items: [], canAccept: false, blocker: blocker(w, c) };
  const rows = (await pool.query(
    `SELECT t.* FROM wfh_tasks t WHERE t.status = 'open' AND t.expiry_at > now() AND ($1::varchar IS NULL OR t.task_type = $1) AND ($2::numeric IS NULL OR t.payment_amount >= $2)
       AND t.latitude BETWEEN $3::numeric - 0.5 AND $3::numeric + 0.5 AND t.longitude BETWEEN $4::numeric - 0.5 AND $4::numeric + 0.5 LIMIT 2000`,
    [taskType || null, minPayment ? Number(minPayment) : null, lat, lng]
  )).rows;
  const items = rows.map((t) => ({ t, d: distance(lat, lng, t.latitude, t.longitude) })).filter((x) => x.d !== null && x.d <= radius * 1000).sort((a, b) => a.d - b.d).slice(0, 100)
    .map(({ t, d }) => ({ id: t.id, taskType: t.task_type, taskTypeLabel: TYPES[t.task_type].label, locality: t.locality, city: t.city, paymentAmount: num(t.payment_amount), distanceKm: Math.round(d / 100) / 10, expiryAt: t.expiry_at, title: t.title }));
  const block = blocker(w, c);
  return { enabled: true, radiusKm: radius, items, canAccept: !block, blocker: block, programLabel: c.program_label || 'Work From Home' };
}

async function accept(user, taskId, meta = {}) {
  const c = await cfg();
  const w = await workerRow(user.id);
  const block = blocker(w, c);
  if (block) throw forbidden(block);
  const active = (await pool.query(`SELECT COUNT(*)::int AS n FROM wfh_task_assignments WHERE worker_id = $1 AND state = 'accepted'`, [user.id])).rows[0].n;
  if (active >= n(c, 'max_active_tasks', 5)) throw badRequest(`You can hold ${n(c, 'max_active_tasks', 5)} tasks at a time - finish one first`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query(`SELECT * FROM wfh_tasks WHERE id = $1 FOR UPDATE`, [taskId])).rows[0];
    if (!t) throw notFound('Task not found');
    if (t.status !== 'open' || new Date(t.expiry_at) <= new Date()) throw badRequest('This task has just been taken or has expired');
    if (t.property_id && (await client.query('SELECT 1 FROM properties WHERE id = $1 AND (created_by = $2 OR broker_id = $2)', [t.property_id, user.id])).rows.length) throw badRequest('You cannot take a task on your own listing');
    const a = (await client.query(
      `INSERT INTO wfh_task_assignments (task_id, worker_id, lock_expires_at, device_hash) VALUES ($1, $2, LEAST(now() + ($3 || ' hours')::interval, $4::timestamptz), $5) RETURNING id, lock_expires_at`,
      [taskId, user.id, String(n(c, 'lock_hours', 48)), t.expiry_at, deviceHash(meta)]
    )).rows[0];
    await client.query(`UPDATE wfh_tasks SET status = 'locked' WHERE id = $1`, [taskId]);
    await client.query('COMMIT');
    await notificationService.createNotification({ userId: user.id, type: 'wfh', title: `Task accepted: ${t.title}`, message: `Reserved for you until ${new Date(a.lock_expires_at).toLocaleString('en-IN')}. Open it for what to do and how it is verified.`, relatedEntityType: 'wfh_assignment', relatedEntityId: a.id }).catch(() => {});
    return assignmentView(user, a.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw badRequest('This task has just been taken');
    throw err;
  } finally {
    client.release();
  }
}

const ASSIGNMENT_SELECT = `
  SELECT a.*, t.task_type, t.title, t.instructions, t.city, t.locality, t.latitude AS task_lat, t.longitude AS task_lng, t.payment_amount, t.property_id, t.expiry_at, t.status AS task_status,
         p.title AS property_title, p.address AS property_address, p.latitude AS property_lat, p.longitude AS property_lng, p.status::text AS property_status, p.verification_level,
         u.full_name AS worker_name, rep.full_name AS rep_name
  FROM wfh_task_assignments a JOIN wfh_tasks t ON t.id = a.task_id LEFT JOIN properties p ON p.id = t.property_id JOIN users u ON u.id = a.worker_id LEFT JOIN users rep ON rep.id = a.rep_id`;

const HOW = {
  buyer_visit: 'Bring a genuine buyer to this property. Check in at the property (within 100 m), enter the buyer\'s mobile number, and have the buyer tell you the OTP they receive. The A R Buildwel representative then confirms the visit.',
  seller_photo: 'Get the owner\'s consent, take at least 5 photos at the property with location switched on in your camera, upload them within 24 hours, and enter the OTP the owner receives.',
  requirement_collect: 'Talk to someone looking for a property, fill in what they need, and enter the OTP they receive to confirm it is genuine.',
  listing_assist: 'Help the owner post their listing on the platform. Enter the listing and the owner\'s OTP. You are paid when the listing passes verification and goes live.',
  condition_report: 'Visit the property, check in there, fill in the condition report and add at least 3 photos taken on the spot. This is not a legal inspection.',
  auction_check: 'Visit the auction property, confirm it exists, photograph the exterior (at least 2 photos), and note whether it is occupied and how it is reached.',
  area_survey: 'Ask the survey questions in your locality. With the person\'s consent, enter their details and the OTP they receive.',
};

async function shapeAssignment(a, user) {
  const staff = isStaff(user);
  const photos = [];
  for (const ph of a.photo_urls || []) photos.push({ url: await getReadUrl(ph.path).catch(() => null), distanceM: ph.distanceM, takenAt: ph.takenAt, problems: ph.problems || [] });
  return {
    id: a.id, taskId: a.task_id, taskType: a.task_type, taskTypeLabel: TYPES[a.task_type].label, title: a.title, instructions: a.instructions, howItWorks: HOW[a.task_type], city: a.city, locality: a.locality,
    paymentAmount: num(a.payment_amount), state: a.state, verificationStatus: a.verification_status, rejectionReason: a.rejection_reason, payoutStatus: a.payout_status,
    acceptedAt: a.accepted_at, lockExpiresAt: a.lock_expires_at, submittedAt: a.submitted_at, verifiedAt: a.verified_at,
    // The worker gets the property and its location once the task is theirs.
    property: a.property_id ? { id: a.property_id, title: a.property_title, address: a.property_address } : null, location: { latitude: num(a.task_lat), longitude: num(a.task_lng) },
    gpsDistanceM: a.gps_distance_from_property_m, photos, evidence: a.evidence, partyName: a.party_name, partyPhoneLast4: a.party_phone_last4,
    otpRequired: !!TYPES[a.task_type].otp, otpConfirmed: a.buyer_otp_confirmed || a.seller_otp_confirmed, otpExpiresAt: a.otp_expires_at,
    confirmation: TYPES[a.task_type].confirm, repName: a.rep_name, repDueAt: a.rep_due_at, repConfirmed: a.rep_confirmed,
    workerName: staff ? a.worker_name : undefined, workerId: staff ? a.worker_id : undefined, fraudFlags: staff ? a.fraud_flags : undefined, leadId: staff ? a.lead_id : undefined,
    waitingFor: a.state !== 'submitted' || a.verification_status !== 'pending' ? null
      : TYPES[a.task_type].otp && !(a.buyer_otp_confirmed || a.seller_otp_confirmed) ? 'otp'
        : { rep: 'representative', review: 'review', listing: 'listing_live', auto: null }[TYPES[a.task_type].confirm],
  };
}

async function loadAssignment(id) {
  const a = (await pool.query(`${ASSIGNMENT_SELECT} WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw notFound('Task not found');
  return a;
}

async function assignmentView(user, id) {
  const a = await loadAssignment(id);
  if (!isStaff(user) && a.worker_id !== user.id) throw forbidden('Not your task');
  return shapeAssignment(a, user);
}

async function myTasks(user, { state } = {}) {
  const r = await pool.query(`${ASSIGNMENT_SELECT} WHERE a.worker_id = $1 ${state === 'active' ? `AND a.state = 'accepted'` : state === 'submitted' ? `AND a.state = 'submitted'` : ''} ORDER BY a.created_at DESC LIMIT 200`, [user.id]);
  const out = [];
  for (const a of r.rows) out.push(await shapeAssignment(a, user));
  return out;
}

// ------------------------------------------------------------ evidence

async function sendOtp(a, phone, c) {
  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(`UPDATE wfh_task_assignments SET otp_hash = $1, otp_expires_at = now() + ($2 || ' minutes')::interval, otp_attempts = 0 WHERE id = $3`, [sha(`${a.id}|${code}`), String(n(c, 'otp_minutes', 10)), a.id]);
  const template = msg91.getTemplateIdForPurpose('wfh_confirm');
  if (process.env.MSG91_AUTH_KEY && template) await msg91.sendOtpSms(phone, code, template, 'wfh_confirm');
  else if (process.env.NODE_ENV === 'production') throw badRequest('SMS is not set up for task confirmation yet - try again later');
  // Outside production the code is returned so the flow can be tested without an SMS account.
  return process.env.NODE_ENV !== 'production' ? code : undefined;
}

// Check and store photos: each must carry its own location and time.
async function processPhotos(a, files, c, radius) {
  const maxAge = n(c, 'photo_max_age_hours', 24) * 3600000;
  const out = [];
  for (const f of files) {
    const info = await imageScan.analyse(f.buffer).catch(() => ({ exif: { lat: null, lng: null, takenAt: null }, phash: null }));
    const d = distance(info.exif.lat, info.exif.lng, a.task_lat, a.task_lng);
    const problems = [];
    if (info.exif.lat === null) problems.push('no location in the photo');
    else if (d > radius) problems.push(`taken ${d} m from the property`);
    if (!info.exif.takenAt) problems.push('no time in the photo');
    else if (Date.now() - new Date(info.exif.takenAt).getTime() > maxAge || new Date(info.exif.takenAt).getTime() > Date.now() + 3600000) problems.push('not taken in the last 24 hours');
    // The same picture already on a listing means it was not taken for this task.
    if (info.phash !== null && info.phash !== undefined && (await pool.query('SELECT 1 FROM property_media WHERE phash = $1 LIMIT 1', [info.phash]).catch(() => ({ rows: [] }))).rows.length) problems.push('this photo is already on the platform');
    out.push({ file: f, path: null, lat: info.exif.lat, lng: info.exif.lng, takenAt: info.exif.takenAt, distanceM: d, phash: info.phash === null || info.phash === undefined ? null : String(info.phash), problems });
  }
  return out;
}

// Rules about the buyer's / seller's phone number. Throws when the task must be refused; returns flags otherwise.
async function checkPartyPhone(a, phone, worker, c) {
  const flags = [];
  if (phoneOf(worker.mobile) === phone) throw badRequest('You cannot submit your own mobile number');
  const hash = sha(phone);
  const dup = await pool.query(
    `SELECT 1 FROM wfh_task_assignments WHERE party_phone_hash = $1 AND id <> $2 AND state IN ('submitted', 'closed') AND verification_status <> 'failed' AND submitted_at > now() - ($3 || ' days')::interval LIMIT 1`,
    [hash, a.id, String(n(c, 'phone_dedupe_days', 90))]
  );
  if (dup.rows.length) throw badRequest(`This person has already been submitted for a task in the last ${n(c, 'phone_dedupe_days', 90)} days - the first submission counts`);
  const person = (await pool.query(`SELECT u.id, u.created_at, u.mobile_verified FROM users u WHERE right(regexp_replace(COALESCE(u.mobile, ''), '\\D', '', 'g'), 10) = $1 LIMIT 1`, [phone])).rows[0];
  if (person) {
    if (person.id === worker.user_id) throw badRequest('You cannot submit your own account');
    if (Date.now() - new Date(person.created_at).getTime() < n(c, 'new_account_hours', 24) * 3600000) throw badRequest('This person\'s account is too new - try again after 24 hours');
  }
  const month = (await pool.query(`SELECT COUNT(*)::int AS n FROM wfh_task_assignments WHERE party_phone_hash = $1 AND submitted_at > now() - interval '30 days'`, [hash])).rows[0].n;
  if (month + 1 >= n(c, 'phone_repeat_flag_count', 3)) flags.push({ rule: 'phone_repeat', detail: `Same mobile in ${month + 1} tasks this month` });
  return { hash, flags };
}

async function submit(user, id, body, files = [], meta = {}) {
  const c = await cfg();
  const a = await loadAssignment(id);
  if (a.worker_id !== user.id) throw forbidden('Not your task');
  const worker = await workerRow(user.id);
  const block = blocker(worker, c);
  if (block) throw forbidden(block);
  if (a.state !== 'accepted') throw badRequest('This task has already been submitted or is closed');
  if (new Date(a.lock_expires_at) < new Date()) throw badRequest('The time reserved for this task has run out');
  const today = (await pool.query(`SELECT COUNT(*)::int AS n FROM wfh_task_assignments WHERE worker_id = $1 AND submitted_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, [user.id])).rows[0].n;
  if (today >= n(c, 'max_submissions_per_day', 5)) throw badRequest(`You can submit ${n(c, 'max_submissions_per_day', 5)} tasks a day - try again tomorrow`);
  const type = TYPES[a.task_type];
  const flags = [];
  let gps = { lat: null, lng: null, d: null };

  if (type.gps) {
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || body.latitude === '' || body.latitude === undefined) throw badRequest('Check in at the property - location is required');
    gps = { lat, lng, d: distance(lat, lng, a.task_lat, a.task_lng) };
    const limit = n(c, 'gps_visit_radius_m', 100);
    if (gps.d === null || gps.d > limit) throw badRequest(`You are ${gps.d} m from the property - check in within ${limit} m`);
  }

  let photos = [];
  if (type.photos) {
    const min = type.photos === 'min' ? n(c, 'min_photos', 5) : type.photos;
    if (files.length < min) throw badRequest(`Upload at least ${min} photos`);
    photos = await processPhotos(a, files.slice(0, 12), c, n(c, 'photo_radius_m', 50));
    const good = photos.filter((p) => !p.problems.length).length;
    // No EXIF or mismatched EXIF = auto-reject (sec. F.1 anti-fraud).
    if (good < min) {
      const why = [...new Set(photos.flatMap((p) => p.problems))].join('; ');
      throw badRequest(`Only ${good} of ${photos.length} photos passed the location and time check (${why}). Retake them at the property with location switched on.`);
    }
  }

  // Only a set that passed is kept. (A development machine without a storage bucket keeps the checks and skips the upload.)
  for (const ph of photos) {
    const f = ph.file;
    delete ph.file;
    if (ph.problems.length) continue;
    if (!process.env.GCS_BUCKET_NAME && process.env.NODE_ENV !== 'production') ph.path = `not-stored/${f.originalname}`;
    else ph.path = await uploadBuffer(f.buffer, `wfh/${a.id}`, f.originalname, f.mimetype);
  }
  photos = photos.filter((ph) => ph.path);

  let phone = null;
  let party = { hash: null, flags: [] };
  if (type.party) {
    phone = phoneOf(body.partyPhone);
    if (!phone || !/^[6-9]\d{9}$/.test(phone)) throw badRequest(`Enter the ${type.party}'s 10-digit mobile number`);
    if (!body.partyName || String(body.partyName).trim().length < 2) throw badRequest(`Enter the ${type.party}'s name`);
    party = await checkPartyPhone(a, phone, worker, c);
    flags.push(...party.flags);
  }

  // What each task type has to say.
  const evidence = {};
  const text = (k, max = 500) => (body[k] ? String(body[k]).trim().slice(0, max) : undefined);
  if (a.task_type === 'requirement_collect' || a.task_type === 'area_survey') {
    Object.assign(evidence, { intent: ['buy', 'rent', 'sell'].includes(body.intent) ? body.intent : 'buy', propertyType: text('propertyType', 40), city: text('city', 120) || a.city, locality: text('wantedLocality', 160), budgetMax: body.budgetMax ? Number(body.budgetMax) : undefined, bedrooms: body.bedrooms ? Number(body.bedrooms) : undefined, notes: text('notes', 1000), consent: body.consent === true || body.consent === 'true' });
    if (!evidence.consent) throw badRequest('Confirm that the person agreed to share their details');
    if (a.task_type === 'requirement_collect' && !evidence.propertyType && !evidence.budgetMax) throw badRequest('Fill in what the person is looking for');
  }
  if (a.task_type === 'listing_assist') {
    const listing = (await pool.query(`SELECT id, created_by FROM properties WHERE id = $1`, [body.listingId || null]).catch(() => ({ rows: [] }))).rows[0];
    if (!listing) throw badRequest('Enter the listing you helped post');
    if (listing.created_by === user.id) throw badRequest('The listing must be posted by the owner, from the owner\'s account');
    if ((await pool.query(`SELECT 1 FROM wfh_task_assignments WHERE (evidence->>'listingId') = $1 AND id <> $2 AND verification_status <> 'failed'`, [listing.id, id])).rows.length) throw badRequest('This listing has already been claimed for a task');
    evidence.listingId = listing.id;
  }
  if (a.task_type === 'condition_report') {
    const fields = ['parking', 'amenities', 'buildingCondition', 'neighbourhood', 'accessRoad'];
    for (const k of fields) evidence[k] = text(k, 300);
    if (fields.some((k) => !evidence[k])) throw badRequest('Fill in every part of the condition report');
    evidence.overall = ['good', 'fair', 'poor'].includes(body.overall) ? body.overall : undefined;
    evidence.remarks = text('remarks', 1000);
  }
  if (a.task_type === 'auction_check') {
    if (!['occupied', 'vacant', 'unclear'].includes(body.possession)) throw badRequest('Say whether the property is occupied, vacant or unclear');
    Object.assign(evidence, { exists: body.exists === true || body.exists === 'true', possession: body.possession, access: text('access', 500), remarks: text('remarks', 1000) });
    if (!evidence.access) throw badRequest('Describe how the property is reached');
  }
  if (a.device_hash && deviceHash(meta) && a.device_hash !== deviceHash(meta)) flags.push({ rule: 'device_changed', detail: 'Submitted from a different device than the one that accepted' });

  await pool.query(
    `UPDATE wfh_task_assignments SET state = 'submitted', submitted_at = now(), gps_lat = $1, gps_lng = $2, gps_distance_from_property_m = $3, photo_urls = $4, evidence = $5,
       buyer_phone_submitted = $6, seller_phone_submitted = $7, party_phone_hash = $8, party_phone_last4 = $9, party_name = $10, fraud_flags = $11 WHERE id = $12`,
    [gps.lat, gps.lng, gps.d, JSON.stringify(photos), JSON.stringify(evidence), type.party === 'buyer' && phone ? encrypt(phone) : null, type.party === 'seller' && phone ? encrypt(phone) : null,
      party.hash, phone ? phone.slice(-4) : null, body.partyName ? String(body.partyName).trim().slice(0, 150) : null, JSON.stringify(flags), id]
  );
  await pool.query(`UPDATE wfh_tasks SET status = 'completed' WHERE id = $1`, [a.task_id]);
  await auditService.log({ actor: user, action: 'wfh.task_submitted', entityType: 'wfh_assignment', entityId: id, after: { type: a.task_type, gpsDistance: gps.d, photos: photos.length, flags: flags.length }, ...meta });
  let debugOtp;
  if (type.otp) debugOtp = await sendOtp(a, phone, c);
  else await advance(id);
  return { ...(await assignmentView(user, id)), ...(debugOtp ? { otp: debugOtp } : {}) };
}

async function resendOtp(user, id) {
  const c = await cfg();
  const a = await loadAssignment(id);
  if (a.worker_id !== user.id) throw forbidden('Not your task');
  if (a.state !== 'submitted' || a.buyer_otp_confirmed || a.seller_otp_confirmed || !TYPES[a.task_type].otp) throw badRequest('No OTP is pending for this task');
  const { decrypt } = require('../utils/crypto');
  const otp = await sendOtp(a, decrypt(a.buyer_phone_submitted || a.seller_phone_submitted), c);
  return { sent: true, ...(otp ? { otp } : {}) };
}

async function confirmOtp(user, id, code) {
  const a = await loadAssignment(id);
  if (a.worker_id !== user.id) throw forbidden('Not your task');
  if (a.state !== 'submitted' || !a.otp_hash) throw badRequest('No OTP is pending for this task');
  if (a.buyer_otp_confirmed || a.seller_otp_confirmed) return assignmentView(user, id);
  if (new Date(a.otp_expires_at) < new Date()) throw badRequest('The OTP has expired - send a new one');
  if (a.otp_attempts >= 5) throw badRequest('Too many wrong attempts - send a new OTP');
  if (sha(`${a.id}|${String(code || '').trim()}`) !== a.otp_hash) {
    await pool.query('UPDATE wfh_task_assignments SET otp_attempts = otp_attempts + 1 WHERE id = $1', [id]);
    throw badRequest('That OTP is not correct');
  }
  const buyer = TYPES[a.task_type].party === 'buyer';
  await pool.query(`UPDATE wfh_task_assignments SET buyer_otp_confirmed = $1, seller_otp_confirmed = $2, otp_confirmed_at = now(), otp_hash = NULL WHERE id = $3`, [buyer, !buyer, id]);
  await advance(id);
  return assignmentView(user, id);
}

// After the evidence (and OTP) is in: who has to confirm next.
async function advance(id) {
  const c = await cfg();
  const a = await loadAssignment(id);
  const how = TYPES[a.task_type].confirm;
  if (how === 'auto') return pass(id, null);
  if (how === 'rep') {
    // The representative on the property's enquiries, else the least busy one.
    const rep = (await pool.query(
      `SELECT x.user_id FROM (
         SELECT l.arb_rep_id AS user_id, 0 AS pri, 0 AS load FROM leads l WHERE l.property_id = $1 AND l.arb_rep_id IS NOT NULL
         UNION ALL
         SELECT ar.user_id, 1, (SELECT COUNT(*) FROM wfh_task_assignments w WHERE w.rep_id = ar.user_id AND w.state = 'submitted' AND w.rep_confirmed IS NULL) FROM arb_representatives ar JOIN users u ON u.id = ar.user_id AND u.status = 'active' WHERE ar.accepts_assignments
       ) x ORDER BY x.pri, x.load LIMIT 1`,
      [a.property_id]
    )).rows[0]?.user_id || null;
    await pool.query(`UPDATE wfh_task_assignments SET rep_id = $1, rep_due_at = now() + ($2 || ' hours')::interval WHERE id = $3`, [rep, String(n(c, 'rep_confirm_hours', 24)), id]);
    const tell = rep ? [rep] : (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`)).rows.map((r) => r.id);
    for (const u of tell) await notificationService.createNotification({ userId: u, type: 'wfh', title: 'Field partner submitted a buyer visit', message: `${a.worker_name} reports a buyer visit at ${a.locality || a.city || 'the property'}. Please confirm.`, relatedEntityType: 'wfh_assignment', relatedEntityId: id }).catch(() => {});
  }
  // 'review' waits in the staff queue; 'listing' waits for the listing to go live (see sweep).
  return null;
}

// ------------------------------------------------------------ verification outcome

async function recomputeRates(workerId) {
  const c = await cfg();
  const s = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE state IN ('submitted', 'closed') AND verification_status <> 'pending')::int AS decided, COUNT(*) FILTER (WHERE verification_status = 'failed')::int AS failed,
            COUNT(*)::int AS accepted, COUNT(*) FILTER (WHERE state = 'forfeited')::int AS forfeited FROM wfh_task_assignments WHERE worker_id = $1`,
    [workerId]
  )).rows[0];
  const rejection = s.decided ? r2((s.failed / s.decided) * 100) : 0;
  const forfeit = s.accepted ? r2((s.forfeited / s.accepted) * 100) : 0;
  // Too many abandoned tasks pauses acceptance for a while (needs a few tasks before it bites).
  const pause = s.accepted >= 4 && forfeit > n(c, 'forfeit_rate_suspend_percent', 30);
  await pool.query(
    `UPDATE wfh_workers SET rejection_rate = $1, forfeit_rate = $2, accept_blocked_until = CASE WHEN $3 AND (accept_blocked_until IS NULL OR accept_blocked_until < now()) THEN now() + ($4 || ' days')::interval ELSE accept_blocked_until END, updated_at = now() WHERE user_id = $5`,
    [rejection, forfeit, pause, String(n(c, 'forfeit_block_days', 7)), workerId]
  );
  if (s.decided >= 4 && rejection > n(c, 'rejection_rate_review_percent', 30) && !(await pool.query(`SELECT 1 FROM user_flags WHERE user_id = $1 AND reason = 'wfh_high_rejection' AND resolved_at IS NULL`, [workerId])).rows.length) {
    await pool.query(`INSERT INTO user_flags (user_id, reason, detail) VALUES ($1, 'wfh_high_rejection', $2)`, [workerId, JSON.stringify({ rejectionRate: rejection })]);
  }
  return { rejection, forfeit };
}

// A lead in the CRM for the person the worker brought, tagged with where it came from.
async function createLead(a, phone, tag) {
  const customer = (await pool.query(`SELECT id FROM customers WHERE right(regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g'), 10) = $1 ORDER BY created_at LIMIT 1`, [phone])).rows[0]
    || (await pool.query('INSERT INTO customers (full_name, mobile, created_by) VALUES ($1, $2, $3) RETURNING id', [a.party_name || 'Field lead', phone, a.worker_id])).rows[0];
  const ev = a.evidence || {};
  const lead = (await pool.query(
    `INSERT INTO leads (created_by, source, source_tag, property_id, customer_id, status, enquiry_type, enquiry_details)
     VALUES ($1, 'manual', $2, $3, $4, 'new', $5, $6) RETURNING id`,
    [a.worker_id, tag, a.task_type === 'buyer_visit' ? a.property_id : null, customer.id, a.task_type === 'buyer_visit' ? 'property' : ev.intent === 'sell' || a.task_type === 'seller_photo' || a.task_type === 'listing_assist' ? 'seller' : 'requirement',
      JSON.stringify({ via: 'wfh', taskType: a.task_type, city: ev.city || a.city, locality: ev.locality || a.locality, propertyType: ev.propertyType, budgetMax: ev.budgetMax, bedrooms: ev.bedrooms, notes: ev.notes, siteVisitDone: a.task_type === 'buyer_visit' || undefined })]
  )).rows[0];
  await require('./assignment.service').safeAssign(lead.id);
  return lead.id;
}

async function pass(id, staff) {
  const a = await loadAssignment(id);
  if (a.verification_status !== 'pending') return null;
  const type = TYPES[a.task_type];
  const { decrypt } = require('../utils/crypto');
  const phone = a.buyer_phone_submitted || a.seller_phone_submitted ? decrypt(a.buyer_phone_submitted || a.seller_phone_submitted) : null;
  let leadId = null;
  if (type.sourceTag && phone) leadId = await createLead(a, phone, type.sourceTag).catch((err) => { console.error('[wfh] lead creation failed:', err.message); return null; });
  // Field photos join the listing's gallery, marked as field-sourced.
  if (a.property_id && ['seller_photo', 'condition_report', 'auction_check'].includes(a.task_type)) {
    const order = (await pool.query('SELECT COALESCE(MAX(display_order), 0)::int AS n FROM property_media WHERE property_id = $1', [a.property_id])).rows[0].n;
    let i = 0;
    for (const ph of (a.photo_urls || []).filter((p) => !p.problems?.length)) {
      i += 1;
      await pool.query(`INSERT INTO property_media (property_id, media_type, url, display_order, is_primary, exif_lat, exif_lng, exif_taken_at, source_tag) VALUES ($1, 'image', $2, $3, false, $4, $5, $6, 'Field-Sourced')`, [a.property_id, ph.path, order + i, ph.lat, ph.lng, ph.takenAt]).catch((err) => console.error('[wfh] photo attach failed:', err.message));
    }
  }
  if (a.task_type === 'auction_check' && a.property_id && a.evidence?.possession && a.evidence.possession !== 'unclear') {
    await pool.query('UPDATE properties SET possession_type = COALESCE(possession_type, $1) WHERE id = $2', [a.evidence.possession, a.property_id]).catch(() => {});
  }
  const amount = num(a.payment_amount);
  await pool.query(`UPDATE wfh_task_assignments SET verification_status = 'passed', state = 'closed', verified_by = $1, verified_at = now(), lead_id = $2, payout_status = 'credited' WHERE id = $3`, [staff?.id || null, leadId, id]);
  await pool.query(`UPDATE wfh_tasks SET status = 'verified' WHERE id = $1`, [a.task_id]);
  await pool.query(`INSERT INTO wfh_earnings (worker_id, assignment_id, gross_amount, net_amount) VALUES ($1, $2, $3, $3) ON CONFLICT (assignment_id) DO NOTHING`, [a.worker_id, id, amount]);
  await pool.query('UPDATE wfh_workers SET total_earned = total_earned + $1, updated_at = now() WHERE user_id = $2', [amount, a.worker_id]);
  await recomputeRates(a.worker_id);
  await require('./gamification.service').award(a.worker_id, 'wfh_task_verified', { entityId: id, city: a.city }).then((ok) => ok && require('./gamification.service').refreshProfile(a.worker_id)).catch(() => {});
  await notificationService.createNotification({ userId: a.worker_id, type: 'wfh', title: `Task verified: Rs ${amount.toLocaleString('en-IN')} earned`, message: `${a.title} passed verification. It will be in your next monthly payout.`, relatedEntityType: 'wfh_assignment', relatedEntityId: id }).catch(() => {});
  if (staff) await auditService.log({ actor: staff, action: 'wfh.task_verified', entityType: 'wfh_assignment', entityId: id, after: { amount, leadId } });
  return { passed: true, amount, leadId };
}

async function fail(id, staff, reason, { didNotHappen = false } = {}) {
  const c = await cfg();
  const a = await loadAssignment(id);
  if (a.verification_status !== 'pending') return null;
  await pool.query(`UPDATE wfh_task_assignments SET verification_status = 'failed', state = 'closed', rejection_reason = $1, verified_by = $2, verified_at = now() WHERE id = $3`, [String(reason).slice(0, 500), staff?.id || null, id]);
  // The task goes back on the board for someone else while it is still current.
  await pool.query(`UPDATE wfh_tasks SET status = CASE WHEN expiry_at > now() THEN 'open' ELSE 'expired' END WHERE id = $1`, [a.task_id]);
  await recomputeRates(a.worker_id);
  if (didNotHappen) {
    const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM wfh_task_assignments WHERE worker_id = $1 AND rep_confirmed = false`, [a.worker_id])).rows[0].n;
    if (count >= n(c, 'rejections_to_flag', 3) && !(await pool.query(`SELECT 1 FROM user_flags WHERE user_id = $1 AND reason = 'wfh_visits_did_not_happen' AND resolved_at IS NULL`, [a.worker_id])).rows.length) {
      await pool.query(`INSERT INTO user_flags (user_id, reason, detail) VALUES ($1, 'wfh_visits_did_not_happen', $2)`, [a.worker_id, JSON.stringify({ rejections: count })]);
    }
  }
  await notificationService.createNotification({ userId: a.worker_id, type: 'wfh', title: `Task not approved: ${a.title}`, message: String(reason).slice(0, 200), relatedEntityType: 'wfh_assignment', relatedEntityId: id }).catch(() => {});
  if (staff) await auditService.log({ actor: staff, action: 'wfh.task_rejected', entityType: 'wfh_assignment', entityId: id, after: { reason, didNotHappen } });
  return { passed: false };
}

// The representative's one-click answer on a buyer visit.
async function repDecide(staff, id, { happened, reason }) {
  if (!isStaff(staff)) throw forbidden('A R Buildwel staff only');
  const a = await loadAssignment(id);
  if (a.task_type !== 'buyer_visit') throw badRequest('Only buyer visits are confirmed by the representative');
  if (a.state !== 'submitted' || a.verification_status !== 'pending') throw badRequest('This visit has already been decided');
  if (!a.buyer_otp_confirmed) throw badRequest('The buyer has not confirmed the visit by OTP yet');
  if (a.rep_id && a.rep_id !== staff.id && !ADMIN.includes(staff.role)) throw forbidden('This visit is with another representative');
  if (happened !== true && happened !== false) throw badRequest('Say whether the visit happened');
  if (!happened && (!reason || String(reason).trim().length < 5)) throw badRequest('Say why - the field partner is told');
  await pool.query('UPDATE wfh_task_assignments SET rep_confirmed = $1, rep_decided_at = now(), rep_id = COALESCE(rep_id, $2) WHERE id = $3', [happened, staff.id, id]);
  if (happened) await pass(id, staff);
  else await fail(id, staff, `Visit did not happen: ${String(reason).trim()}`, { didNotHappen: true });
  return assignmentView(staff, id);
}

// Staff quality review of photo / report tasks.
async function review(staff, id, { decision, reason }) {
  if (!isStaff(staff)) throw forbidden('A R Buildwel staff only');
  const a = await loadAssignment(id);
  if (TYPES[a.task_type].confirm === 'rep') throw badRequest('A buyer visit is confirmed by its representative');
  if (a.state !== 'submitted' || a.verification_status !== 'pending') throw badRequest('This task has already been decided');
  if (TYPES[a.task_type].otp && !(a.buyer_otp_confirmed || a.seller_otp_confirmed)) throw badRequest('The OTP confirmation is still pending');
  if (!['approve', 'reject'].includes(decision)) throw badRequest('decision must be approve or reject');
  if (decision === 'reject' && (!reason || String(reason).trim().length < 5)) throw badRequest('Give the reason - the field partner is told');
  if (decision === 'approve') await pass(id, staff);
  else await fail(id, staff, String(reason).trim());
  return assignmentView(staff, id);
}

async function listSubmissions(staff, { queue = 'pending' } = {}) {
  const where = {
    pending: `a.state = 'submitted' AND a.verification_status = 'pending'`,
    mine: `a.state = 'submitted' AND a.verification_status = 'pending' AND a.rep_id = $1`,
    passed: `a.verification_status = 'passed'`, failed: `a.verification_status = 'failed'`, flagged: `jsonb_array_length(a.fraud_flags) > 0`,
  }[queue] || `a.state = 'submitted' AND a.verification_status = 'pending'`;
  const r = await pool.query(`${ASSIGNMENT_SELECT} WHERE ${where} ORDER BY a.submitted_at DESC NULLS LAST LIMIT 200`, queue === 'mine' ? [staff.id] : []);
  const out = [];
  for (const a of r.rows) out.push(await shapeAssignment(a, staff));
  return out;
}

// ------------------------------------------------------------ workers (staff)

async function listWorkers({ kyc, status } = {}) {
  const where = [];
  const params = [];
  if (kyc) { params.push(kyc); where.push(`w.kyc_status = $${params.length}`); }
  if (status) { params.push(status); where.push(`w.status = $${params.length}`); }
  const r = await pool.query(
    `SELECT w.*, u.full_name, u.mobile, u.email, (SELECT COUNT(*) > 1 FROM wfh_workers x WHERE x.device_hash = w.device_hash AND w.device_hash IS NOT NULL) AS shared_device,
            (SELECT COUNT(*)::int FROM wfh_task_assignments a WHERE a.worker_id = w.user_id AND a.verification_status = 'passed') AS verified_tasks
     FROM wfh_workers w JOIN users u ON u.id = w.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (w.kyc_status = 'pending') DESC, w.created_at DESC LIMIT 300`, params);
  return r.rows.map((w) => ({ ...workerView(w, true), verifiedTasks: w.verified_tasks }));
}

async function decideKyc(admin, userId, { decision, note }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Only an admin verifies KYC');
  if (!['verify', 'reject'].includes(decision)) throw badRequest('decision must be verify or reject');
  if (decision === 'reject' && (!note || String(note).trim().length < 5)) throw badRequest('Give the reason');
  const w = (await pool.query(`UPDATE wfh_workers SET kyc_status = $1, kyc_note = $2, kyc_decided_by = $3, kyc_decided_at = now(), updated_at = now() WHERE user_id = $4 RETURNING user_id`, [decision === 'verify' ? 'verified' : 'rejected', note ? String(note).slice(0, 500) : null, admin.id, userId])).rows[0];
  if (!w) throw notFound('Field partner not found');
  await auditService.log({ actor: admin, action: `wfh.kyc_${decision}`, entityType: 'wfh_worker', entityId: userId, after: { note }, ...meta });
  await notificationService.createNotification({ userId, type: 'wfh', title: decision === 'verify' ? 'KYC verified - you can take tasks now' : 'KYC not approved', message: decision === 'verify' ? 'Open the task board to see tasks near you.' : String(note).slice(0, 200), relatedEntityType: 'wfh_worker', relatedEntityId: userId }).catch(() => {});
  return workerView(await workerRow(userId), true);
}

async function setWorkerStatus(admin, userId, { status, note }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  if (!['active', 'suspended', 'banned'].includes(status)) throw badRequest('Unknown status');
  if (status !== 'active' && (!note || String(note).trim().length < 5)) throw badRequest('Give the reason');
  const w = (await pool.query(`UPDATE wfh_workers SET status = $1::varchar, status_note = $2, accept_blocked_until = CASE WHEN $1::varchar = 'active' THEN NULL ELSE accept_blocked_until END, updated_at = now() WHERE user_id = $3 RETURNING user_id`, [status, note ? String(note).slice(0, 500) : null, userId])).rows[0];
  if (!w) throw notFound('Field partner not found');
  await auditService.log({ actor: admin, action: 'wfh.worker_status', entityType: 'wfh_worker', entityId: userId, after: { status, note }, ...meta });
  return workerView(await workerRow(userId), true);
}

// ------------------------------------------------------------ earnings & payouts

const fyStart = (d = new Date()) => new Date(Date.UTC(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1)).toISOString().slice(0, 10);

async function earnings(user) {
  const s = (await pool.query(
    `SELECT COALESCE(SUM(gross_amount), 0)::float AS lifetime, COALESCE(SUM(gross_amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::float AS this_month,
            COALESCE(SUM(gross_amount) FILTER (WHERE status = 'credited'), 0)::float AS awaiting_payout, COALESCE(SUM(net_amount) FILTER (WHERE status = 'paid'), 0)::float AS paid_out,
            COALESCE(SUM(tds_amount) FILTER (WHERE status = 'paid'), 0)::float AS tds FROM wfh_earnings WHERE worker_id = $1`,
    [user.id]
  )).rows[0];
  const pending = (await pool.query(`SELECT COALESCE(SUM(t.payment_amount), 0)::float AS n FROM wfh_task_assignments a JOIN wfh_tasks t ON t.id = a.task_id WHERE a.worker_id = $1 AND a.state = 'submitted' AND a.verification_status = 'pending'`, [user.id])).rows[0].n;
  const ledger = (await pool.query(
    `SELECT e.id, e.created_at, t.task_type, t.locality, t.city, e.gross_amount, e.tds_amount, e.net_amount, e.status, e.paid_at, e.utr_reference
     FROM wfh_earnings e JOIN wfh_task_assignments a ON a.id = e.assignment_id JOIN wfh_tasks t ON t.id = a.task_id WHERE e.worker_id = $1 ORDER BY e.created_at DESC LIMIT 200`,
    [user.id]
  )).rows;
  const payouts = (await pool.query('SELECT id, payout_number, period, gross_amount, tds_amount, net_amount, bank_account_last4, status, utr_reference, paid_at, created_at FROM wfh_payouts WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 60', [user.id])).rows;
  const c = await cfg();
  return {
    totals: { lifetime: s.lifetime, thisMonth: s.this_month, pendingVerification: pending, awaitingPayout: s.awaiting_payout, paidOut: s.paid_out, tdsDeducted: s.tds }, minPayout: n(c, 'min_payout', 500),
    ledger: ledger.map((e) => ({ id: e.id, date: e.created_at, taskType: e.task_type, taskTypeLabel: TYPES[e.task_type].label, locality: e.locality || e.city, amount: num(e.gross_amount), tds: num(e.tds_amount), net: num(e.net_amount), status: e.status, paidAt: e.paid_at, utr: e.utr_reference })),
    payouts: payouts.map((p) => ({ id: p.id, payoutNumber: p.payout_number, period: p.period, gross: num(p.gross_amount), tds: num(p.tds_amount), net: num(p.net_amount), bankAccountLast4: p.bank_account_last4, status: p.status, utr: p.utr_reference, paidAt: p.paid_at })),
  };
}

async function performance(userId) {
  const s = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE verification_status = 'passed' AND verified_at >= date_trunc('month', now()))::int AS completed_month, COUNT(*) FILTER (WHERE verification_status = 'passed')::int AS completed,
            COUNT(*)::int AS accepted, COUNT(*) FILTER (WHERE state IN ('submitted', 'closed'))::int AS submitted, COUNT(*) FILTER (WHERE verification_status = 'failed')::int AS rejected,
            COUNT(*) FILTER (WHERE state = 'forfeited')::int AS forfeited FROM wfh_task_assignments WHERE worker_id = $1`,
    [userId]
  )).rows[0];
  const weeks = (await pool.query(`SELECT DISTINCT date_trunc('week', verified_at)::date::text AS w FROM wfh_task_assignments WHERE worker_id = $1 AND verification_status = 'passed' ORDER BY 1 DESC LIMIT 104`, [userId])).rows.map((r) => r.w);
  const week = (d) => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 604800000);
  const now = week((await pool.query(`SELECT date_trunc('week', now())::date::text AS w`)).rows[0].w);
  let streak = 0;
  for (let i = 0; i < weeks.length; i += 1) {
    if (i === 0 ? now - week(weeks[0]) > 1 : week(weeks[i - 1]) - week(weeks[i]) !== 1) break;
    streak += 1;
  }
  const areas = (await pool.query(`SELECT COALESCE(t.locality, t.city, 'Unknown') AS area, COUNT(*)::int AS tasks FROM wfh_task_assignments a JOIN wfh_tasks t ON t.id = a.task_id WHERE a.worker_id = $1 AND a.verification_status = 'passed' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [userId])).rows;
  const w = await workerRow(userId);
  return {
    completedThisMonth: s.completed_month, completed: s.completed, accepted: s.accepted, completionRate: s.accepted ? r2((s.submitted / s.accepted) * 100) : null,
    rejectionRate: num(w?.rejection_rate) || 0, rejectionWarning: (num(w?.rejection_rate) || 0) > 30, forfeitRate: num(w?.forfeit_rate) || 0, streakWeeks: streak, areas,
  };
}

// The worker's own home screen.
async function me(user) {
  const c = await cfg();
  const w = await workerRow(user.id);
  const amounts = {};
  for (const k of Object.keys(TYPES)) amounts[k] = await amountFor(k, { city: w?.city });
  const base = {
    enabled: await enabled(), programLabel: c.program_label || 'Work From Home', agreementVersion: String(c.agreement_version || '1.0'), radiusKm: n(c, 'board_radius_km', 5),
    taskTypes: Object.entries(TYPES).map(([key, t]) => ({ key, label: t.label, howItWorks: HOW[key], amount: amounts[key] })),
    agreement: ['You are paid a fixed amount for each task that passes verification - not for any deal that follows.', 'Every task is checked: location, photos, the OTP of the buyer or owner, and confirmation by A R Buildwel. False submissions lead to rejection and removal.',
      'You are an independent field partner, not an employee of A R Buildwel, and are responsible for your own income tax. TDS is deducted where the law requires.', 'Never submit your own number or a family member\'s, and never share a buyer\'s or owner\'s details with anyone else.'],
  };
  if (!w) return { ...base, joined: false };
  return { ...base, joined: true, worker: workerView(w), blocker: blocker(w, c), performance: await performance(user.id) };
}

// Monthly payout run: one payout per worker whose verified, unpaid earnings reach the minimum.
async function runPayouts(admin, { period } = {}, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Only an admin runs payouts');
  const c = await cfg();
  const label = /^\d{4}-\d{2}$/.test(String(period || '')) ? period : new Date().toISOString().slice(0, 7);
  const [rate, threshold, noPan] = (await Promise.all([configService.getConfig('tax.payout_tds_percent', 5), configService.getConfig('tax.payout_tds_threshold', 15000), configService.getConfig('tax.payout_tds_no_pan_percent', 20)])).map(Number);
  const due = (await pool.query(
    `SELECT e.worker_id, SUM(e.gross_amount)::float AS gross, w.bank_account_last4, w.pan_hash,
            (SELECT COALESCE(SUM(p.gross_amount), 0)::float FROM wfh_payouts p WHERE p.worker_id = e.worker_id AND p.created_at >= $1::date) AS fy_paid
     FROM wfh_earnings e JOIN wfh_workers w ON w.user_id = e.worker_id
     WHERE e.status = 'credited' AND e.payout_id IS NULL AND w.kyc_status = 'verified' AND w.status <> 'banned' GROUP BY e.worker_id, w.bank_account_last4, w.pan_hash HAVING SUM(e.gross_amount) >= $2`,
    [fyStart(), n(c, 'min_payout', 500)]
  )).rows;
  const created = [];
  for (const d of due) {
    // TDS applies once the year's total crosses the threshold - on this payout in full from then on.
    const crosses = d.fy_paid + d.gross > threshold;
    const pct = crosses ? (d.pan_hash ? rate : noPan) : 0;
    const tds = r2((d.gross * pct) / 100);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seq = (await client.query(`SELECT nextval('wfh_payout_seq') AS n`)).rows[0].n;
      const p = (await client.query(
        `INSERT INTO wfh_payouts (payout_number, worker_id, period, gross_amount, tds_amount, net_amount, tds_rate_percent, bank_account_last4) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, payout_number`,
        [`WFH/${label}/${String(seq).padStart(5, '0')}`, d.worker_id, label, d.gross, tds, r2(d.gross - tds), pct, d.bank_account_last4]
      )).rows[0];
      await client.query(`UPDATE wfh_earnings SET payout_id = $1, tds_amount = round(gross_amount * $2 / 100.0, 2), net_amount = gross_amount - round(gross_amount * $2 / 100.0, 2) WHERE worker_id = $3 AND status = 'credited' AND payout_id IS NULL`, [p.id, pct, d.worker_id]);
      await client.query('COMMIT');
      created.push({ id: p.id, payoutNumber: p.payout_number, workerId: d.worker_id, gross: d.gross, tds, net: r2(d.gross - tds) });
      const gstFlag = n(c, 'gst_flag_amount', 2000000);
      if (d.fy_paid + d.gross >= gstFlag && !(await pool.query(`SELECT 1 FROM user_flags WHERE user_id = $1 AND reason = 'wfh_gst_registration_due' AND resolved_at IS NULL`, [d.worker_id])).rows.length) {
        await pool.query(`INSERT INTO user_flags (user_id, reason, detail) VALUES ($1, 'wfh_gst_registration_due', $2)`, [d.worker_id, JSON.stringify({ yearTotal: d.fy_paid + d.gross })]);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  await auditService.log({ actor: admin, action: 'wfh.payout_run', entityType: 'wfh_payout', entityId: null, after: { period: label, payouts: created.length, total: r2(created.reduce((s, x) => s + x.net, 0)) }, ...meta });
  return { period: label, created };
}

async function listPayouts({ status } = {}) {
  const r = await pool.query(
    `SELECT p.*, u.full_name, w.bank_ifsc, w.bank_account_name FROM wfh_payouts p JOIN users u ON u.id = p.worker_id JOIN wfh_workers w ON w.user_id = p.worker_id ${status ? 'WHERE p.status = $1' : ''} ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT 300`,
    status ? [status] : []
  );
  return r.rows.map((p) => ({ id: p.id, payoutNumber: p.payout_number, workerId: p.worker_id, workerName: p.full_name, period: p.period, gross: num(p.gross_amount), tds: num(p.tds_amount), net: num(p.net_amount), tdsRatePercent: num(p.tds_rate_percent), bankAccountLast4: p.bank_account_last4, bankIfsc: p.bank_ifsc, bankAccountName: p.bank_account_name, status: p.status, utr: p.utr_reference, paidAt: p.paid_at, createdAt: p.created_at }));
}

// The full account number, for the person making the bank transfer. Every look is logged.
async function payoutBankDetails(admin, payoutId, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  const p = (await pool.query('SELECT p.id, p.payout_number, p.net_amount, w.bank_account_encrypted, w.bank_ifsc, w.bank_account_name FROM wfh_payouts p JOIN wfh_workers w ON w.user_id = p.worker_id WHERE p.id = $1', [payoutId])).rows[0];
  if (!p) throw notFound('Payout not found');
  const { decrypt } = require('../utils/crypto');
  await auditService.log({ actor: admin, action: 'wfh.bank_details_viewed', entityType: 'wfh_payout', entityId: payoutId, ...meta });
  return { payoutNumber: p.payout_number, net: num(p.net_amount), accountNumber: decrypt(p.bank_account_encrypted), ifsc: p.bank_ifsc, accountName: p.bank_account_name };
}

async function markPaid(admin, payoutId, { utr }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Only an admin records a payout');
  if (!utr || String(utr).trim().length < 6) throw badRequest('Enter the bank UTR reference');
  const p = (await pool.query(`UPDATE wfh_payouts SET status = 'paid', utr_reference = $1, paid_at = now(), paid_by = $2 WHERE id = $3 AND status = 'pending' RETURNING *`, [String(utr).trim().slice(0, 60), admin.id, payoutId])).rows[0];
  if (!p) throw badRequest('This payout is not pending');
  await pool.query(`UPDATE wfh_earnings SET status = 'paid', paid_at = now(), utr_reference = $1 WHERE payout_id = $2`, [p.utr_reference, payoutId]);
  await pool.query(`UPDATE wfh_task_assignments SET payout_status = 'paid' WHERE id IN (SELECT assignment_id FROM wfh_earnings WHERE payout_id = $1)`, [payoutId]);
  await pool.query('UPDATE wfh_workers SET total_paid_out = total_paid_out + $1, updated_at = now() WHERE user_id = $2', [p.net_amount, p.worker_id]);
  await auditService.log({ actor: admin, action: 'wfh.payout_paid', entityType: 'wfh_payout', entityId: payoutId, after: { utr: p.utr_reference, net: num(p.net_amount) }, ...meta });
  await notificationService.createNotification({ userId: p.worker_id, type: 'wfh', title: `Payout sent: Rs ${Number(p.net_amount).toLocaleString('en-IN')}`, message: `${p.payout_number}, UTR ${p.utr_reference}, to the account ending ${p.bank_account_last4 || '----'}.`, relatedEntityType: 'wfh_payout', relatedEntityId: payoutId }).catch(() => {});
  return (await listPayouts({})).find((x) => x.id === payoutId);
}

async function payoutSlip(user, payoutId) {
  const p = (await pool.query('SELECT p.*, u.full_name FROM wfh_payouts p JOIN users u ON u.id = p.worker_id WHERE p.id = $1', [payoutId])).rows[0];
  if (!p) throw notFound('Payout not found');
  if (!isStaff(user) && p.worker_id !== user.id) throw forbidden('Not your payout');
  const items = (await pool.query(`SELECT t.task_type, t.locality, t.city, e.gross_amount, e.created_at FROM wfh_earnings e JOIN wfh_task_assignments a ON a.id = e.assignment_id JOIN wfh_tasks t ON t.id = a.task_id WHERE e.payout_id = $1 ORDER BY e.created_at`, [payoutId])).rows;
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (text, { size = 11, f = font, gap = 7 } = {}) => {
    if (y < 60) { page = pdf.addPage([595, 842]); y = 790; }
    page.drawText(String(text).replace(/[^\x20-\x7E]/g, ' '), { x: 50, y, size, font: f });
    y -= size + gap;
  };
  const money = (v) => `INR ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  line('A R Buildwel - PropertySerch.com', { size: 16, f: bold });
  line(`Field partner payout slip ${p.payout_number}`, { size: 13, f: bold });
  line(`Field partner: ${p.full_name}`);
  line(`Period: ${p.period}    Status: ${p.status}${p.paid_at ? `    Paid on: ${new Date(p.paid_at).toLocaleDateString('en-IN')}` : ''}`);
  line(`Bank account ending: ${p.bank_account_last4 || '----'}${p.utr_reference ? `    UTR: ${p.utr_reference}` : ''}`);
  y -= 6;
  line('Verified tasks', { f: bold });
  for (const i of items) line(`${new Date(i.created_at).toLocaleDateString('en-IN')}  ${TYPES[i.task_type].label}  ${i.locality || i.city || ''}  ${money(i.gross_amount)}`, { size: 10, gap: 5 });
  y -= 6;
  line(`Gross: ${money(p.gross_amount)}`);
  line(`TDS @ ${Number(p.tds_rate_percent)}%: ${money(p.tds_amount)}`);
  line(`Net paid: ${money(p.net_amount)}`, { size: 13, f: bold });
  line('Task payments are for completed and verified tasks only. You are responsible for your own income tax.', { size: 9 });
  return Buffer.from(await pdf.save());
}

// ------------------------------------------------------------ jobs

async function sweep() {
  if (!(await enabled())) return { enabled: false };
  const c = await cfg();
  // Reserved tasks that ran out of time: a forfeit, and the task goes back on the board.
  const lapsed = (await pool.query(`UPDATE wfh_task_assignments SET state = 'forfeited' WHERE state = 'accepted' AND lock_expires_at < now() RETURNING id, task_id, worker_id`)).rows;
  for (const l of lapsed) {
    await pool.query(`UPDATE wfh_tasks SET status = CASE WHEN expiry_at > now() THEN 'open' ELSE 'expired' END WHERE id = $1`, [l.task_id]);
    await recomputeRates(l.worker_id);
    await notificationService.createNotification({ userId: l.worker_id, type: 'wfh', title: 'A reserved task ran out of time', message: 'It has gone back on the board. Tasks you accept and do not complete count against you.', relatedEntityType: 'wfh_assignment', relatedEntityId: l.id }).catch(() => {});
  }
  const expired = (await pool.query(`UPDATE wfh_tasks SET status = 'expired' WHERE status = 'open' AND expiry_at < now()`)).rowCount;
  // A buyer visit the representative has not answered in time goes to the admins.
  const late = (await pool.query(`UPDATE wfh_task_assignments SET rep_escalated_at = now() WHERE state = 'submitted' AND verification_status = 'pending' AND rep_confirmed IS NULL AND rep_due_at < now() AND rep_escalated_at IS NULL RETURNING id, rep_id`)).rows;
  if (late.length) {
    const admins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`)).rows;
    for (const a of admins) await notificationService.createNotification({ userId: a.id, type: 'wfh', title: `${late.length} buyer visit${late.length === 1 ? '' : 's'} not confirmed in time`, message: 'The representative did not respond within the window. Please decide.', relatedEntityType: 'wfh', relatedEntityId: null }).catch(() => {});
  }
  // Listing assist: paid when the listing is live and has passed L1 verification.
  const assists = (await pool.query(
    `SELECT a.id, p.status::text AS status, p.verification_level FROM wfh_task_assignments a JOIN wfh_tasks t ON t.id = a.task_id JOIN properties p ON p.id = (a.evidence->>'listingId')::uuid
     WHERE t.task_type = 'listing_assist' AND a.state = 'submitted' AND a.verification_status = 'pending' AND a.seller_otp_confirmed`
  )).rows;
  let assistsPaid = 0;
  for (const a of assists) {
    if (a.status === 'approved' && Number(a.verification_level) >= 1) { await pass(a.id, null); assistsPaid += 1; }
    else if (a.status === 'rejected') await fail(a.id, null, 'The listing did not pass review');
  }
  // Tasks the platform creates by itself.
  let auto = 0;
  if (c.auto_tasks_enabled === true) {
    const cap = n(c, 'auto_tasks_per_run', 20);
    const bare = (await pool.query(
      `SELECT p.id FROM properties p WHERE p.status = 'approved' AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM property_media m WHERE m.property_id = p.id) AND NOT EXISTS (SELECT 1 FROM wfh_tasks t WHERE t.property_id = p.id AND t.task_type = 'seller_photo' AND t.status IN ('open', 'locked', 'completed'))
         AND EXISTS (SELECT 1 FROM wfh_workers w WHERE w.status = 'active' AND w.kyc_status = 'verified' AND lower(w.city) = lower(p.city)) LIMIT $1`,
      [cap]
    )).rows;
    for (const p of bare) { await createTask({ id: null, role: 'admin' }, { taskType: 'seller_photo', propertyId: p.id, origin: 'no_photos', title: undefined, instructions: 'This listing has no photos. With the owner\'s consent, take photos at the property.' }); auto += 1; }
    const unmet = (await pool.query(
      `SELECT r.id, r.city, r.latitude, r.longitude, (r.localities->>0) AS locality FROM requirements r WHERE r.status = 'active' AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM requirement_matches m WHERE m.requirement_id = r.id) AND NOT EXISTS (SELECT 1 FROM wfh_tasks t WHERE t.requirement_id = r.id AND t.status IN ('open', 'locked', 'completed'))
         AND EXISTS (SELECT 1 FROM wfh_workers w WHERE w.status = 'active' AND w.kyc_status = 'verified' AND lower(w.city) = lower(r.city)) LIMIT $1`,
      [Math.max(cap - auto, 0)]
    )).rows;
    for (const r of unmet) { await createTask({ id: null, role: 'admin' }, { taskType: 'seller_photo', requirementId: r.id, origin: 'unmet_requirement', latitude: r.latitude, longitude: r.longitude, city: r.city, locality: r.locality, instructions: 'A buyer is looking in this area and nothing on the platform fits. Find an owner with a suitable unlisted property and, with their consent, take photos.' }); auto += 1; }
  }
  return { enabled: true, forfeited: lapsed.length, expired, escalated: late.length, assistsPaid, autoTasks: auto };
}

async function summary() {
  const [w, t, a, e] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS workers, COUNT(*) FILTER (WHERE kyc_status = 'pending')::int AS kyc_pending, COUNT(*) FILTER (WHERE kyc_status = 'verified' AND status = 'active')::int AS active FROM wfh_workers`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'open' AND expiry_at > now())::int AS open, COUNT(*) FILTER (WHERE status = 'locked')::int AS locked, COUNT(*) FILTER (WHERE status = 'verified')::int AS verified FROM wfh_tasks`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE state = 'submitted' AND verification_status = 'pending')::int AS to_review, COUNT(*) FILTER (WHERE state = 'submitted' AND verification_status = 'pending' AND rep_due_at < now() AND rep_confirmed IS NULL)::int AS overdue FROM wfh_task_assignments`),
    pool.query(`SELECT COALESCE(SUM(gross_amount) FILTER (WHERE status = 'credited' AND payout_id IS NULL), 0)::float AS unpaid, COALESCE(SUM(gross_amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::float AS month FROM wfh_earnings`),
  ]);
  const pend = (await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(net_amount), 0)::float AS amount FROM wfh_payouts WHERE status = 'pending'`)).rows[0];
  return { ...w.rows[0], tasks: t.rows[0], ...a.rows[0], earnedThisMonth: e.rows[0].month, awaitingPayoutRun: e.rows[0].unpaid, payoutsPending: pend.n, payoutsPendingAmount: pend.amount };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((err) => console.error('[wfh] sweep failed:', err.message)), 15 * 60 * 1000);
}

// For the DPDP anonymiser: the hash a phone number is stored under.
const phoneHash = (phone) => (phoneOf(phone) ? sha(phoneOf(phone)) : null);

module.exports = {
  TYPES, phoneHash, distance, amountFor, getConfig, updateConfig, register, updateLocation, me, board, accept, myTasks, assignmentView, submit, resendOtp, confirmOtp,
  createTask, cancelTask, listTasks, repDecide, review, listSubmissions, listWorkers, decideKyc, setWorkerStatus, earnings, performance,
  runPayouts, listPayouts, payoutBankDetails, markPaid, payoutSlip, sweep, summary, startScheduler,
};
