const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 33 - Data Ownership & Export (DPDP Act 2023, sec. 19.1).
//
//   Consent    logged with version and category each time it is given or withdrawn.
//   My data    everything the platform holds about the signed-in person, as
//              JSON or CSV, on demand (the statutory limit is 30 days).
//   Deletion   a request starts a 30-day notice; the person can cancel in
//              that window. Then the account is ANONYMISED, never hard
//              deleted: identifiers are blanked, sign-in is closed, their
//              listings and requirements leave public view, and their events
//              keep only non-personal facts. Financial, fee-consent and
//              audit records are kept for 7 years as the law requires.
//   Legal hold an open deal, an unpaid invoice or an active mandate pauses
//              the deletion until it clears.
//   Inactivity no sign-in for 2 years -> the same 30-day notice (off until
//              switched on in app config).

const ADMIN = ['admin', 'super_admin'];
const STAFF = ['internal_sales', ...ADMIN];
const CATEGORIES = ['collection', 'usage', 'sharing', 'retention', 'rights', 'security'];
const OPTIONAL = ['marketing'];

const consentVersion = () => configService.getConfig('privacy.consent_version', '2026-10');
const noticeDays = async () => Number(await configService.getConfig('privacy.deletion_notice_days', 30)) || 30;

// ------------------------------------------------------------ consent

async function recordConsent(userId, { categories = CATEGORIES, granted = true, source = 'registration', ip = null, userAgent = null } = {}) {
  const version = await consentVersion();
  const list = [...new Set(categories)].filter((c) => [...CATEGORIES, ...OPTIONAL].includes(c));
  if (!list.length) throw badRequest('Unknown consent category');
  // The six statutory categories are needed to use the platform; only optional ones can be withdrawn here.
  if (!granted && list.some((c) => CATEGORIES.includes(c))) throw badRequest('To withdraw this consent, request deletion of your data');
  for (const c of list) {
    await pool.query('INSERT INTO consent_logs (user_id, category, consent_version, granted, source, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)', [userId, c, version, granted, source, ip, userAgent]);
  }
  return consents(userId);
}

async function consents(userId) {
  const version = await consentVersion();
  const r = await pool.query(
    `SELECT DISTINCT ON (category) category, consent_version, granted, source, created_at FROM consent_logs WHERE user_id = $1 ORDER BY category, created_at DESC, id DESC`,
    [userId]
  );
  const have = new Map(r.rows.map((x) => [x.category, x]));
  return {
    currentVersion: version,
    upToDate: CATEGORIES.every((c) => have.get(c)?.granted && have.get(c).consent_version === version),
    items: [...CATEGORIES, ...OPTIONAL].map((c) => ({ category: c, required: CATEGORIES.includes(c), granted: !!have.get(c)?.granted, version: have.get(c)?.consent_version || null, at: have.get(c)?.created_at || null })),
  };
}

// ------------------------------------------------------------ my data

const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

// Everything held about one person. Internal staff notes, fraud scoring and
// other people's contact details are not the person's own data and stay out.
async function collect(userId) {
  const user = (await q(
    `SELECT u.id, u.full_name, u.email, u.mobile, r.name AS role, u.status::text AS status, u.email_verified, u.mobile_verified, u.referral_code, u.preferred_language, u.signup_source::text AS signup_source,
            u.last_login_at, u.created_at FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId]))[0];
  if (!user) throw notFound('User not found');
  const customer = (await q('SELECT id, full_name, email, mobile, portal_roles, onboarded_at, created_at FROM customers WHERE user_id = $1', [userId]))[0] || null;
  const cid = customer?.id || null;
  const sections = {
    profile: [user],
    customer_profile: customer ? [customer] : [],
    consents: await q('SELECT category, consent_version, granted, source, created_at FROM consent_logs WHERE user_id = $1 ORDER BY created_at', [userId]),
    investor_profile: await q(`SELECT is_nri, is_hni, residency_status, country_of_residence, city_of_residence, time_zone, investor_category, preferred_cities, preferred_property_types, ticket_size_min, ticket_size_max, verification_status, created_at FROM investor_profiles WHERE user_id = $1`, [userId]),
    verifications: await q('SELECT kind, reference, status, decided_at, created_at FROM user_verifications WHERE user_id = $1', [userId]),
    listings: await q(`SELECT id, title, property_type::text AS property_type, transaction_type::text AS transaction_type, price, city, locality, address, status::text AS status, rera_number, created_at FROM properties WHERE created_by = $1 OR broker_id = $1 OR builder_id = $1 ORDER BY created_at`, [userId]),
    requirements: cid ? await q(`SELECT id, purpose, property_type::text AS property_type, city, localities, budget_min, budget_max, bedrooms, status::text AS status, notes, created_at FROM requirements WHERE customer_id = $1 ORDER BY created_at`, [cid]) : [],
    enquiries: cid ? await q(`SELECT l.id, l.source::text AS source, l.status::text AS status, l.enquiry_type, l.enquiry_topic, l.enquiry_details, p.title AS property, l.created_at FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE l.customer_id = $1 ORDER BY l.created_at`, [cid]) : [],
    site_visit_requests: cid ? await q('SELECT id, property_id, preferred_at, note, status, created_at FROM site_visit_requests WHERE customer_id = $1 OR requested_by = $2 ORDER BY created_at', [cid, userId]) : [],
    deals: await q(`SELECT d.id, d.stage::text AS stage, d.deal_value, p.title AS property, d.created_at, d.closed_at FROM deals d LEFT JOIN properties p ON p.id = d.property_id WHERE d.broker_id = $1 OR d.customer_id = $2 ORDER BY d.created_at`, [userId, cid]),
    invoices: await q('SELECT invoice_number, kind, total_amount, gst_type, status, issue_date, due_date, paid_at FROM invoices WHERE liable_user_id = $1 OR liable_customer_id = $2 ORDER BY created_at', [userId, cid]),
    // The price range a person gave under a mandate is stored encrypted and is theirs: say it exists, not the cipher text.
    mandates: await q(`SELECT mandate_number, mandate_type, status, mandate_start_date, mandate_end_date, professional_fee_rate_percent, (seller_min_price_enc IS NOT NULL OR buyer_min_budget_enc IS NOT NULL) AS price_range_recorded, created_at FROM mandates WHERE user_id = $1 ORDER BY created_at`, [userId]),
    fee_consents: await q('SELECT kind, consent_version, fee_rate_percent, otp_verified_at, created_at FROM fee_consents WHERE user_id = $1 ORDER BY created_at', [userId]),
    leases: cid ? await q('SELECT id, property_label, monthly_rent, security_deposit, start_date, end_date, status, (owner_customer_id = $1) AS as_owner FROM leases WHERE owner_customer_id = $1 OR tenant_customer_id = $1', [cid]) : [],
    documents: await q(`SELECT id, document_type::text AS document_type, file_name, status::text AS status, created_at FROM documents WHERE uploaded_by = $1 OR customer_id = $2 ORDER BY created_at`, [userId, cid]),
    reviews_written: await q('SELECT id, rating, title, body, status, created_at FROM reviews WHERE reviewer_id = $1 ORDER BY created_at', [userId]),
    reviews_about_me: await q(`SELECT id, rating, title, body, reply, created_at FROM reviews WHERE subject_user_id = $1 AND status = 'published' ORDER BY created_at`, [userId]),
    saved_searches: cid ? await q('SELECT name, filters, alerts_enabled, created_at FROM saved_searches WHERE customer_id = $1', [cid]) : [],
    saved_properties: cid ? await q('SELECT f.property_id, p.title, f.created_at FROM property_favorites f LEFT JOIN properties p ON p.id = f.property_id WHERE f.customer_id = $1', [cid]) : [],
    referrals: await q('SELECT referral_code, created_at, (referrer_id = $1) AS i_referred FROM referral_tree WHERE referrer_id = $1 OR referred_id = $1', [userId]),
    trust: await q('SELECT score, components, computed_at FROM trust_scores WHERE user_id = $1', [userId]),
    badges: await q('SELECT badge_key, status, awarded_at FROM user_badges WHERE user_id = $1', [userId]),
    points: await q('SELECT action_key, points, city, note, earned_at FROM gamification_points WHERE user_id = $1 ORDER BY earned_at', [userId]),
    disputes: await q('SELECT case_number, type, title, description, status, resolution, created_at FROM disputes WHERE raised_by = $1 ORDER BY created_at', [userId]),
    notifications: await q('SELECT type, title, message, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500', [userId]),
    notification_preferences: await q('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]).catch(() => []),
    devices_for_push: await q('SELECT created_at FROM push_subscriptions WHERE user_id = $1', [userId]).catch(() => []),
    activity: await q(`SELECT event_timestamp, event_type, properties_json, device_json FROM events WHERE user_id = $1 ORDER BY event_timestamp DESC LIMIT 2000`, [userId]),
    data_requests: await q('SELECT request_number, kind, status, requested_at, due_at, processed_at FROM data_requests WHERE user_id = $1 ORDER BY requested_at', [userId]),
    // Module 47: field partner profile (identifiers masked), tasks and earnings.
    field_partner: await q(`SELECT kyc_status, status, city, locality, aadhaar_last4, bank_account_last4, bank_ifsc, agreement_version, agreement_accepted_at, total_earned, total_paid_out, created_at FROM wfh_workers WHERE user_id = $1`, [userId]),
    field_tasks: await q(`SELECT t.task_type, t.locality, t.city, a.accepted_at, a.submitted_at, a.state, a.verification_status, a.rejection_reason FROM wfh_task_assignments a JOIN wfh_tasks t ON t.id = a.task_id WHERE a.worker_id = $1 ORDER BY a.accepted_at`, [userId]),
    field_earnings: await q('SELECT gross_amount, tds_amount, net_amount, status, paid_at, utr_reference, created_at FROM wfh_earnings WHERE worker_id = $1 ORDER BY created_at', [userId]),
  };
  return {
    generatedAt: new Date().toISOString(),
    dataController: 'A R Buildwel (PropertySerch.com)',
    notes: [
      'This is the personal data PropertySerch holds about you.',
      'Activity is limited to your latest 2,000 events and notifications to your latest 500.',
      'Internal staff notes and automated risk scoring are not included.',
    ],
    ...sections,
  };
}

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One CSV with a block per section (section name, header row, rows, blank line).
function toCsv(data) {
  const lines = [`PropertySerch personal data export,${data.generatedAt}`, ''];
  for (const [name, rows] of Object.entries(data)) {
    if (!Array.isArray(rows) || name === 'notes') continue;
    lines.push(`# ${name}`);
    if (!rows.length) lines.push('(none)');
    else {
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      lines.push(cols.join(','));
      for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
    }
    lines.push('');
  }
  return `﻿${lines.join('\n')}`;
}

async function nextNumber(client = pool) {
  const n = (await client.query(`SELECT nextval('data_request_seq') AS n`)).rows[0].n;
  return `DR-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
}

// GET /user/my-data - served at once, and logged as a completed request.
async function myData(user, { format = 'json' } = {}, meta = {}) {
  if (!['json', 'csv'].includes(format)) throw badRequest('format must be json or csv');
  const data = await collect(user.id);
  await pool.query(
    `INSERT INTO data_requests (request_number, user_id, kind, status, due_at, processed_at, summary, ip_address) VALUES ($1, $2, 'export', 'completed', now() + interval '30 days', now(), $3, $4)`,
    [await nextNumber(), user.id, JSON.stringify({ format, sections: Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])) }), meta.ip || null]
  );
  await auditService.log({ actor: user, action: 'privacy.data_exported', entityType: 'user', entityId: user.id, after: { format }, ...meta });
  return format === 'csv' ? { csv: toCsv(data) } : { data };
}

// ------------------------------------------------------------ deletion

const view = (r) => ({
  id: r.id, requestNumber: r.request_number, userId: r.user_id, kind: r.kind, status: r.status, reason: r.reason, holdReasons: r.hold_reasons, decisionNote: r.decision_note,
  requestedAt: r.requested_at, dueAt: r.due_at, processedAt: r.processed_at, summary: r.summary,
});

async function openDeletion(userId) {
  return (await pool.query(`SELECT * FROM data_requests WHERE user_id = $1 AND kind IN ('deletion', 'inactivity') AND status IN ('pending', 'on_hold')`, [userId])).rows[0] || null;
}

async function requestDeletion(user, { reason } = {}, meta = {}) {
  if (STAFF.includes(user.role)) throw forbidden('Staff accounts are closed by a Super Admin, not by a deletion request');
  const existing = await openDeletion(user.id);
  if (existing) {
    if (existing.kind === 'deletion') return view(existing);
    // An inactivity notice the person now confirms as a deletion.
    await pool.query(`UPDATE data_requests SET status = 'cancelled', decision_note = 'Replaced by the person''s own deletion request', processed_at = now() WHERE id = $1`, [existing.id]);
  }
  const days = await noticeDays();
  const r = (await pool.query(
    `INSERT INTO data_requests (request_number, user_id, kind, reason, due_at, ip_address) VALUES ($1, $2, 'deletion', $3, now() + ($4 || ' days')::interval, $5) RETURNING *`,
    [await nextNumber(), user.id, reason ? String(reason).slice(0, 1000) : null, String(days), meta.ip || null]
  )).rows[0];
  await auditService.log({ actor: user, action: 'privacy.deletion_requested', entityType: 'data_request', entityId: r.id, after: { requestNumber: r.request_number, dueAt: r.due_at }, ...meta });
  await notificationService.createNotification({
    userId: user.id, type: 'privacy', title: `Deletion request ${r.request_number} received`,
    message: `Your personal data will be anonymised on ${new Date(r.due_at).toLocaleDateString('en-IN')}. You can cancel before then from Profile > Privacy. Invoices and other records the law requires us to keep are retained.`,
    relatedEntityType: 'data_request', relatedEntityId: r.id,
  }).catch(() => {});
  return view(r);
}

async function cancelDeletion(user, meta = {}) {
  const r = await openDeletion(user.id);
  if (!r) throw badRequest('There is no deletion request to cancel');
  await pool.query(`UPDATE data_requests SET status = 'cancelled', processed_at = now(), decision_note = 'Cancelled by the person' WHERE id = $1`, [r.id]);
  await auditService.log({ actor: user, action: 'privacy.deletion_cancelled', entityType: 'data_request', entityId: r.id, ...meta });
  return view({ ...r, status: 'cancelled' });
}

// Signing in shows the account is in use: an inactivity notice lapses.
async function touch(userId) {
  await pool.query(`UPDATE data_requests SET status = 'cancelled', processed_at = now(), decision_note = 'Signed in during the notice period' WHERE user_id = $1 AND kind = 'inactivity' AND status IN ('pending', 'on_hold')`, [userId]);
}

async function myRequests(user) {
  const r = await pool.query('SELECT * FROM data_requests WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 50', [user.id]);
  return { items: r.rows.map(view), openDeletion: r.rows.filter((x) => ['deletion', 'inactivity'].includes(x.kind) && ['pending', 'on_hold'].includes(x.status)).map(view)[0] || null, consents: await consents(user.id) };
}

// What stops an anonymisation right now.
async function legalHolds(userId) {
  const cid = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [userId])).rows[0]?.id || null;
  const [deals, invoices, mandates, inst, disputes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM deals WHERE (broker_id = $1 OR customer_id = $2) AND stage NOT IN ('closed_won', 'closed_lost')`, [userId, cid]),
    pool.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE (liable_user_id = $1 OR liable_customer_id = $2) AND status IN ('invoiced', 'overdue')`, [userId, cid]),
    pool.query(`SELECT COUNT(*)::int AS n FROM mandates WHERE user_id = $1 AND status IN ('active', 'pending_rep_ack')`, [userId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM institutional_deals WHERE buyer_user_id = $1 AND status = 'active'`, [userId]).catch(() => ({ rows: [{ n: 0 }] })),
    pool.query(`SELECT COUNT(*)::int AS n FROM disputes WHERE (raised_by = $1 OR against_user_id = $1) AND status NOT IN ('resolved', 'closed', 'rejected')`, [userId]),
  ]);
  const out = [];
  if (deals.rows[0].n) out.push({ code: 'open_deal', detail: `${deals.rows[0].n} deal(s) still in progress` });
  if (invoices.rows[0].n) out.push({ code: 'unpaid_invoice', detail: `${invoices.rows[0].n} unpaid invoice(s)` });
  if (mandates.rows[0].n) out.push({ code: 'active_mandate', detail: `${mandates.rows[0].n} active mandate(s)` });
  if (inst.rows[0].n) out.push({ code: 'open_institutional_deal', detail: `${inst.rows[0].n} institutional deal(s) in progress` });
  if (disputes.rows[0].n) out.push({ code: 'open_dispute', detail: `${disputes.rows[0].n} open dispute(s)` });
  return out;
}

const PII_KEYS = ['name', 'full_name', 'fullName', 'mobile', 'phone', 'email', 'address', 'message', 'query', 'ip'];

// Blank a person's identifiers everywhere. One transaction: all or nothing.
async function anonymise(userId, actor = null) {
  const user = (await pool.query(`SELECT u.id, u.anonymised_at, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0];
  if (!user) throw notFound('User not found');
  if (user.anonymised_at) return { already: true };
  if (STAFF.includes(user.role)) throw badRequest('Staff accounts cannot be anonymised here');
  const client = await pool.connect();
  const done = {};
  const run = async (key, sql, params) => { done[key] = (await client.query(sql, params)).rowCount; };
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.dpdp_anonymise = 'on'`);
    const c = (await client.query('SELECT id, mobile, email FROM customers WHERE user_id = $1', [userId])).rows[0];
    const old = (await client.query('SELECT mobile, email FROM users WHERE id = $1', [userId])).rows[0];
    const marker = `deleted-${userId}@anonymised.invalid`;

    // Out of public view first: listings delisted, requirements closed, reviews about them unpublished.
    await run('listings_delisted', `UPDATE properties SET status = 'inactive' WHERE created_by = $1 AND status IN ('approved', 'pending_approval', 'draft')`, [userId]);
    if (c) await run('requirements_closed', `UPDATE requirements SET status = 'closed', notes = NULL WHERE customer_id = $1 AND status <> 'closed'`, [c.id]);
    await run('badges_revoked', `UPDATE user_badges SET status = 'revoked', revoked_at = now() WHERE user_id = $1 AND status <> 'revoked'`, [userId]);

    // Sign-in and devices.
    for (const [key, table] of [['sessions', 'refresh_tokens'], ['push_devices', 'push_subscriptions'], ['reset_tokens', 'password_reset_tokens'], ['notifications', 'notifications'], ['known_ips', 'user_ips']]) {
      await run(key, `DELETE FROM ${table} WHERE user_id = $1`, [userId]).catch(() => { throw new Error(`Could not clear ${table}`); });
    }
    await run('otps', 'DELETE FROM otp_verifications WHERE user_id = $1 OR identifier = ANY($2::text[])', [userId, [old.mobile, old.email].filter(Boolean)]);
    await client.query('DELETE FROM notification_preferences WHERE user_id = $1', [userId]);
    await run('newsletter', `DELETE FROM newsletter_subscriptions WHERE user_id = $1 OR lower(email) = lower($2)`, [userId, old.email || '']);

    if (c) {
      await run('saved_searches', 'DELETE FROM saved_searches WHERE customer_id = $1', [c.id]);
      await run('saved_properties', 'DELETE FROM property_favorites WHERE customer_id = $1', [c.id]);
      await client.query('DELETE FROM customer_360_profiles WHERE customer_id = $1', [c.id]);
      await client.query('UPDATE customer_preferences SET notes = NULL WHERE customer_id = $1', [c.id]);
      await run('guest_interests', `UPDATE guest_interests SET mobile = 'deleted', full_name = NULL, message = NULL WHERE customer_id = $1 OR mobile = $2`, [c.id, c.mobile || old.mobile || '']);
      await run('whatsapp_messages', `UPDATE whatsapp_conversations SET phone_number = 'deleted', message_body = NULL WHERE customer_id = $1`, [c.id]);
      await client.query(`UPDATE leads SET enquiry_details = '{}'::jsonb WHERE customer_id = $1`, [c.id]);
      await client.query(`UPDATE customers SET full_name = 'Deleted user', email = $2, mobile = NULL WHERE id = $1`, [c.id, marker]);
    }
    // Module 47: field partner KYC is removed (earnings and payouts are financial records and stay);
    // and where this person was the buyer / seller on someone's field task, their number goes.
    await run('field_partner_kyc', `UPDATE wfh_workers SET aadhaar_number_encrypted = NULL, aadhaar_hash = NULL, aadhaar_last4 = NULL, pan_encrypted = NULL, bank_account_encrypted = NULL, bank_account_name = NULL, latitude = NULL, longitude = NULL, device_hash = NULL, status = 'banned', status_note = 'Account anonymised' WHERE user_id = $1`, [userId]);
    const fieldHashes = [old.mobile, c?.mobile].map((m) => require('./wfh.service').phoneHash(m)).filter(Boolean);
    if (fieldHashes.length) await run('field_task_phone', `UPDATE wfh_task_assignments SET buyer_phone_submitted = NULL, seller_phone_submitted = NULL, party_name = NULL, party_phone_last4 = NULL WHERE party_phone_hash = ANY($1::text[])`, [fieldHashes]);
    await client.query(`UPDATE investor_profiles SET country_of_residence = NULL, city_of_residence = NULL, preferred_contact_window = NULL, verification_notes = NULL, alerts_enabled = false WHERE user_id = $1`, [userId]);
    await client.query(`UPDATE user_verifications SET reference = NULL, document_path = NULL, notes = NULL WHERE user_id = $1`, [userId]);
    await client.query(`UPDATE reviews SET title = NULL, body = '[removed at the author''s request]' WHERE reviewer_id = $1`, [userId]);

    // Events are kept; the person is taken out of them.
    await run('events_anonymised', `UPDATE events SET user_id = NULL, customer_id = NULL, anonymous_id = NULL, session_id = NULL, device_json = '{"anonymised": true}'::jsonb,
        properties_json = COALESCE(properties_json, '{}'::jsonb) - $2::text[] || '{"pii": "deleted"}'::jsonb
      WHERE user_id = $1 OR ($3::uuid IS NOT NULL AND customer_id = $3)`, [userId, PII_KEYS, c?.id || null]);
    await client.query('DELETE FROM identity_links WHERE user_id = $1', [userId]).catch(() => {});

    await client.query(
      `UPDATE users SET full_name = 'Deleted user', email = $2, mobile = NULL, password_hash = NULL, profile_picture_url = NULL, status = 'inactive', email_verified = false, mobile_verified = false, preferred_language = NULL, anonymised_at = now() WHERE id = $1`,
      [userId, marker]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await auditService.log({ actor: actor || { id: null, role: 'system' }, action: 'privacy.user_anonymised', entityType: 'user', entityId: userId, after: done });
  return { ...done, kept: ['invoices', 'fee consents', 'mandate records', 'deal records', 'audit log', 'consent log'] };
}

// Carry out one deletion request: anonymise, or park it on legal hold.
async function process(requestId, actor = null, { force = false } = {}) {
  const r = (await pool.query('SELECT * FROM data_requests WHERE id = $1', [requestId])).rows[0];
  if (!r) throw notFound('Request not found');
  if (!['deletion', 'inactivity'].includes(r.kind) || !['pending', 'on_hold'].includes(r.status)) throw badRequest('This request is not waiting to be processed');
  if (!r.user_id) throw badRequest('The account no longer exists');
  if (!force && new Date(r.due_at) > new Date()) throw badRequest('The 30-day notice period has not ended');
  const holds = await legalHolds(r.user_id);
  if (holds.length) {
    await pool.query(`UPDATE data_requests SET status = 'on_hold', hold_reasons = $1 WHERE id = $2`, [JSON.stringify(holds), r.id]);
    if (r.status !== 'on_hold') {
      await notificationService.createNotification({ userId: r.user_id, type: 'privacy', title: `Deletion request ${r.request_number} is on hold`, message: `We cannot remove your data yet: ${holds.map((h) => h.detail).join('; ')}. It will go ahead once this is settled.`, relatedEntityType: 'data_request', relatedEntityId: r.id }).catch(() => {});
    }
    return view({ ...r, status: 'on_hold', hold_reasons: holds });
  }
  const summary = await anonymise(r.user_id, actor);
  const out = (await pool.query(`UPDATE data_requests SET status = 'completed', processed_at = now(), processed_by = $1, hold_reasons = '[]', summary = $2 WHERE id = $3 RETURNING *`, [actor?.id || null, JSON.stringify(summary), r.id])).rows[0];
  return view(out);
}

// ------------------------------------------------------------ admin & jobs

async function listRequests({ status, kind } = {}) {
  const where = [];
  const params = [];
  if (status === 'open') where.push(`d.status IN ('pending', 'on_hold')`);
  else if (status) { params.push(status); where.push(`d.status = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`d.kind = $${params.length}`); }
  const r = await pool.query(
    `SELECT d.*, u.full_name, u.email, u.mobile, ro.name AS role FROM data_requests d LEFT JOIN users u ON u.id = d.user_id LEFT JOIN roles ro ON ro.id = u.role_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (d.status IN ('pending', 'on_hold')) DESC, d.due_at ASC LIMIT 300`, params);
  const totals = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'pending' AND kind <> 'export')::int AS pending, COUNT(*) FILTER (WHERE status = 'on_hold')::int AS on_hold,
      COUNT(*) FILTER (WHERE status IN ('pending', 'on_hold') AND due_at < now())::int AS overdue, COUNT(*) FILTER (WHERE kind = 'export' AND requested_at > now() - interval '30 days')::int AS exports_30d,
      COUNT(*) FILTER (WHERE status = 'completed' AND kind <> 'export')::int AS anonymised FROM data_requests`)).rows[0];
  return { totals, items: r.rows.map((x) => ({ ...view(x), userName: x.full_name, userEmail: x.email, userMobile: x.mobile, role: x.role, daysLeft: Math.ceil((new Date(x.due_at) - Date.now()) / 86400000) })) };
}

async function decide(admin, requestId, { action, note }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  if (action === 'process') {
    const out = await process(requestId, admin, { force: admin.role === 'super_admin' });
    await auditService.log({ actor: admin, action: 'privacy.request_processed', entityType: 'data_request', entityId: requestId, after: { status: out.status }, ...meta });
    return out;
  }
  if (action !== 'reject') throw badRequest('action must be process or reject');
  if (!note || String(note).trim().length < 5) throw badRequest('Give the reason - it is shown to the person');
  const r = (await pool.query(`UPDATE data_requests SET status = 'rejected', decision_note = $1, processed_at = now(), processed_by = $2 WHERE id = $3 AND status IN ('pending', 'on_hold') RETURNING *`, [String(note).trim(), admin.id, requestId])).rows[0];
  if (!r) throw badRequest('This request is not open');
  if (r.user_id) await notificationService.createNotification({ userId: r.user_id, type: 'privacy', title: `Deletion request ${r.request_number} was not carried out`, message: String(note).trim(), relatedEntityType: 'data_request', relatedEntityId: r.id }).catch(() => {});
  await auditService.log({ actor: admin, action: 'privacy.request_rejected', entityType: 'data_request', entityId: requestId, after: { note }, ...meta });
  return view(r);
}

// A person's data for a regulator / legal request, taken by a Super Admin.
async function exportFor(admin, userId, format = 'json', meta = {}) {
  if (admin.role !== 'super_admin') throw forbidden('Only a Super Admin can export another person\'s data');
  const data = await collect(userId);
  await auditService.log({ actor: admin, action: 'privacy.data_exported_by_admin', entityType: 'user', entityId: userId, after: { format }, ...meta });
  return format === 'csv' ? { csv: toCsv(data) } : { data };
}

// Daily: carry out requests whose notice has ended; send inactivity notices when switched on.
async function sweep() {
  const due = await pool.query(`SELECT id FROM data_requests WHERE kind IN ('deletion', 'inactivity') AND status IN ('pending', 'on_hold') AND due_at <= now()`);
  let completed = 0;
  let held = 0;
  for (const d of due.rows) {
    const out = await process(d.id).catch((err) => { console.error('[privacy] request failed:', err.message); return null; });
    if (out?.status === 'completed') completed += 1;
    else if (out?.status === 'on_hold') held += 1;
  }
  let notices = 0;
  if ((await configService.getConfig('privacy.inactivity_sweep_enabled', false)) === true) {
    const years = Number(await configService.getConfig('privacy.inactive_years', 2)) || 2;
    const days = await noticeDays();
    const idle = await pool.query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name NOT IN ('internal_sales', 'admin', 'super_admin') AND u.anonymised_at IS NULL AND COALESCE(u.last_login_at, u.created_at) < now() - ($1 || ' years')::interval
         AND NOT EXISTS (SELECT 1 FROM data_requests d WHERE d.user_id = u.id AND d.kind IN ('deletion', 'inactivity') AND d.status IN ('pending', 'on_hold')) LIMIT 200`,
      [String(years)]
    );
    for (const u of idle.rows) {
      const r = (await pool.query(`INSERT INTO data_requests (request_number, user_id, kind, reason, due_at) VALUES ($1, $2, 'inactivity', $3, now() + ($4 || ' days')::interval) RETURNING id, request_number, due_at`, [await nextNumber(), u.id, `No sign-in for ${years} years`, String(days)])).rows[0];
      await notificationService.createNotification({ userId: u.id, type: 'privacy', title: 'Your account has been inactive', message: `You have not signed in for ${years} years. Your personal data will be anonymised on ${new Date(r.due_at).toLocaleDateString('en-IN')} unless you sign in before then.`, relatedEntityType: 'data_request', relatedEntityId: r.id }).catch(() => {});
      notices += 1;
    }
  }
  return { completed, held, inactivityNotices: notices };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((err) => console.error('[privacy] sweep failed:', err.message)), 6 * 60 * 60 * 1000);
}

module.exports = { CATEGORIES, recordConsent, consents, myData, collect, toCsv, requestDeletion, cancelDeletion, myRequests, touch, legalHolds, anonymise, process, listRequests, decide, exportFor, sweep, startScheduler };
