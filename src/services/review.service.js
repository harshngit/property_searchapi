const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const trustService = require('./trust.service');
const { assertCleanContent } = require('../utils/contentGuard');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 5 Trust & Reputation - reviews.
//   - Allowed only after a verified interaction: a closed deal, a completed
//     site visit, or a confirmed lease between the two parties.
//   - Buyers never learn the broker's / owner's identity (controlled contact
//     architecture): the reviewer picks the interaction and the role
//     ("the listing broker", "the property owner"); the server resolves who.
//   - Every review runs through the fake-review filter (rule-based signals
//     + an AI classifier). Clean reviews publish at once; suspicious ones go
//     to admin moderation. Published ratings feed the trust score (25%).
//   - The reviewed person can reply once and can report a review for
//     moderation; contact details are blocked in all review text.

const AI_MODEL = 'claude-sonnet-5';
const aiClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const STAFF = ['internal_sales', 'admin', 'super_admin'];

async function roleOf(userId) {
  const r = await pool.query('SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [userId]);
  return r.rows[0]?.name || null;
}

// Every interaction the user can review, with the reviewable parties
// described by role only.
async function eligibleInteractions(user) {
  const out = [];
  const deals = await pool.query(
    `SELECT d.id AS deal_id, d.stage, d.broker_id, d.property_id, p.title, p.created_by, p.builder_id,
            EXISTS (SELECT 1 FROM site_visits sv WHERE sv.deal_id = d.id AND sv.status = 'completed') AS visited
     FROM deals d JOIN customers c ON c.id = d.customer_id LEFT JOIN properties p ON p.id = d.property_id
     WHERE c.user_id = $1 AND (d.stage = 'closed_won' OR EXISTS (SELECT 1 FROM site_visits sv WHERE sv.deal_id = d.id AND sv.status = 'completed'))`,
    [user.id]
  );
  for (const d of deals.rows) {
    const interaction = d.stage === 'closed_won' ? 'deal_closed' : 'site_visit';
    const parties = [];
    const brokerRole = d.broker_id ? await roleOf(d.broker_id) : null;
    if (d.broker_id && d.broker_id !== user.id && ['broker', 'agency_admin'].includes(brokerRole)) parties.push({ subject: 'broker', label: 'The listing broker', userId: d.broker_id });
    if (d.builder_id && d.builder_id !== user.id) parties.push({ subject: 'builder', label: 'The builder / developer', userId: d.builder_id });
    const creatorRole = d.created_by ? await roleOf(d.created_by) : null;
    if (d.created_by && d.created_by !== user.id && creatorRole === 'customer') parties.push({ subject: 'owner', label: 'The property owner / seller', userId: d.created_by });
    for (const p of parties) out.push({ interaction, dealId: d.deal_id, leaseId: null, propertyId: d.property_id, propertyTitle: d.title, ...p });
  }
  const leases = await pool.query(
    `SELECT l.id, l.property_id, l.property_label, co.user_id AS owner_user, ct.user_id AS tenant_user
     FROM leases l JOIN customers co ON co.id = l.owner_customer_id JOIN customers ct ON ct.id = l.tenant_customer_id
     WHERE l.tenant_confirmed_at IS NOT NULL AND (co.user_id = $1 OR ct.user_id = $1)`,
    [user.id]
  );
  for (const l of leases.rows) {
    if (l.tenant_user === user.id && l.owner_user) out.push({ interaction: 'lease', dealId: null, leaseId: l.id, propertyId: l.property_id, propertyTitle: l.property_label, subject: 'owner', label: 'Your landlord', userId: l.owner_user });
    if (l.owner_user === user.id && l.tenant_user) out.push({ interaction: 'lease', dealId: null, leaseId: l.id, propertyId: l.property_id, propertyTitle: l.property_label, subject: 'tenant', label: 'Your tenant', userId: l.tenant_user });
  }
  // Mark already-reviewed; never expose the subject's user id.
  const done = await pool.query('SELECT subject_user_id, deal_id, lease_id FROM reviews WHERE reviewer_id = $1', [user.id]);
  return out.map(({ userId, ...rest }) => ({
    ...rest,
    alreadyReviewed: done.rows.some((r) => r.subject_user_id === userId && (r.deal_id === rest.dealId || (rest.leaseId && r.lease_id === rest.leaseId))),
  }));
}

async function resolveSubject(user, { dealId, leaseId, subject }) {
  const full = [];
  const deals = dealId
    ? await pool.query(
        `SELECT d.id, d.stage, d.broker_id, d.property_id, p.created_by, p.builder_id,
                EXISTS (SELECT 1 FROM site_visits sv WHERE sv.deal_id = d.id AND sv.status = 'completed') AS visited
         FROM deals d JOIN customers c ON c.id = d.customer_id LEFT JOIN properties p ON p.id = d.property_id
         WHERE d.id = $1 AND c.user_id = $2`,
        [dealId, user.id]
      )
    : { rows: [] };
  const d = deals.rows[0];
  if (d && (d.stage === 'closed_won' || d.visited)) {
    const interaction = d.stage === 'closed_won' ? 'deal_closed' : 'site_visit';
    if (subject === 'broker' && d.broker_id && ['broker', 'agency_admin'].includes(await roleOf(d.broker_id))) full.push({ userId: d.broker_id, interaction, propertyId: d.property_id });
    if (subject === 'builder' && d.builder_id) full.push({ userId: d.builder_id, interaction, propertyId: d.property_id });
    if (subject === 'owner' && d.created_by && (await roleOf(d.created_by)) === 'customer') full.push({ userId: d.created_by, interaction, propertyId: d.property_id });
  }
  if (leaseId) {
    const l = (
      await pool.query(
        `SELECT l.id, l.property_id, co.user_id AS owner_user, ct.user_id AS tenant_user
         FROM leases l JOIN customers co ON co.id = l.owner_customer_id JOIN customers ct ON ct.id = l.tenant_customer_id
         WHERE l.id = $1 AND l.tenant_confirmed_at IS NOT NULL`,
        [leaseId]
      )
    ).rows[0];
    if (l && subject === 'owner' && l.tenant_user === user.id) full.push({ userId: l.owner_user, interaction: 'lease', propertyId: l.property_id });
    if (l && subject === 'tenant' && l.owner_user === user.id) full.push({ userId: l.tenant_user, interaction: 'lease', propertyId: l.property_id });
  }
  const hit = full.find((f) => f.userId && f.userId !== user.id);
  if (!hit) throw forbidden('Reviews are allowed only after a verified interaction - a closed deal, a completed site visit or a confirmed lease');
  return hit;
}

// ------------------------------------------------------------ fraud filter

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function aiAssess(review) {
  if (!aiClient || !(await configService.getConfig('reviews.ai_filter_enabled', true))) return null;
  try {
    const response = await aiClient.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { fake_likelihood: { type: 'integer' }, reasons: { type: 'array', items: { type: 'string' } } },
            required: ['fake_likelihood', 'reasons'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: 'user',
          content:
            'You screen reviews on an Indian real-estate platform for fake, incentivised, spam, abusive or off-topic content. ' +
            'Return fake_likelihood 0-100 and short reasons. Genuine short or negative reviews are fine.\n\n' +
            `Rating: ${review.rating}/5\nTitle: ${review.title || ''}\nReview: ${review.body || ''}`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === 'text');
    return block ? JSON.parse(block.text) : null;
  } catch (err) {
    console.error('[reviews] AI filter failed:', err.message);
    return null;
  }
}

async function fraudCheck(reviewerId, subjectId, { rating, title, body }) {
  const reasons = [];
  let score = 0;
  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };
  const [reviewer, recentByReviewer, recentForSubject, duplicate, related] = await Promise.all([
    pool.query('SELECT created_at, tenant_id, created_by FROM users WHERE id = $1', [reviewerId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM reviews WHERE reviewer_id = $1 AND created_at > now() - interval '24 hours'`, [reviewerId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM reviews WHERE subject_user_id = $1 AND created_at > now() - interval '24 hours'`, [subjectId]),
    norm(body).length >= 20
      ? pool.query(`SELECT 1 FROM reviews WHERE lower(regexp_replace(COALESCE(body, ''), '[^a-zA-Z0-9]+', ' ', 'g')) = $1 LIMIT 1`, [norm(body)])
      : { rows: [] },
    pool.query('SELECT tenant_id FROM users WHERE id = $1', [subjectId]),
  ]);
  const r = reviewer.rows[0];
  if (Date.now() - new Date(r.created_at).getTime() < 3 * 86400000) add(20, 'Reviewer account is less than 3 days old');
  if (recentByReviewer.rows[0].n >= 3) add(25, 'Reviewer posted several reviews in 24 hours');
  if (recentForSubject.rows[0].n >= 5) add(20, 'Burst of reviews for the same person in 24 hours');
  if ((rating === 1 || rating === 5) && norm(body).length < 20) add(10, 'Extreme rating with little or no text');
  if (duplicate.rows.length) add(40, 'Same text as another review');
  if (r.created_by === subjectId || (r.tenant_id && r.tenant_id === related.rows[0]?.tenant_id)) add(40, 'Reviewer is linked to the reviewed person');
  const ai = await aiAssess({ rating, title, body });
  if (ai && ai.fake_likelihood >= 30) {
    score += Math.round(ai.fake_likelihood / 2);
    reasons.push(...(ai.reasons || []).slice(0, 3).map((x) => `AI: ${x}`));
  }
  return { score: Math.min(100, score), reasons, ai: !!ai };
}

// ----------------------------------------------------------------- writes

async function createReview(user, { dealId, leaseId, subject, rating, title, body }, meta = {}) {
  if (!dealId && !leaseId) throw badRequest('Choose the deal or lease you are reviewing');
  await assertCleanContent({ title, body }, { blockContact: true });
  const target = await resolveSubject(user, { dealId, leaseId, subject });
  const fraud = await fraudCheck(user.id, target.userId, { rating, title, body });
  const threshold = Number(await configService.getConfig('reviews.moderation_threshold', 40)) || 40;
  const status = fraud.score >= threshold ? 'pending_moderation' : 'published';
  let row;
  try {
    row = (
      await pool.query(
        `INSERT INTO reviews (reviewer_id, subject_user_id, property_id, deal_id, lease_id, interaction, rating, title, body, status, fraud_score, fraud_reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [user.id, target.userId, target.propertyId || null, dealId || null, leaseId || null, target.interaction, rating, title || null, body || null, status, fraud.score, JSON.stringify(fraud.reasons)]
      )
    ).rows[0];
  } catch (err) {
    if (err.code === '23505') throw badRequest('You have already reviewed this interaction');
    throw err;
  }
  await auditService.log({ actor: user, action: 'review.created', entityType: 'review', entityId: row.id, after: { status, rating, fraudScore: fraud.score }, ...meta });
  if (status === 'published') {
    await notificationService.createNotification({
      userId: target.userId,
      type: 'review_received',
      title: `New ${rating}-star review`,
      message: title || (body ? body.slice(0, 120) : 'A customer reviewed your service.'),
      relatedEntityType: 'review',
      relatedEntityId: row.id,
    });
    trustService.safeRecompute(target.userId, 'review');
  }
  return publicReview(row);
}

function publicReview(r, { staff = false } = {}) {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    interaction: r.interaction,
    status: r.status,
    reply: r.reply,
    repliedAt: r.replied_at,
    createdAt: r.created_at,
    reviewerFirstName: r.reviewer_first_name,
    propertyTitle: r.property_title,
    ...(staff
      ? {
          reviewerId: r.reviewer_id,
          reviewerName: r.reviewer_name,
          subjectUserId: r.subject_user_id,
          subjectName: r.subject_name,
          fraudScore: r.fraud_score,
          fraudReasons: r.fraud_reasons,
          reportedAt: r.reported_at,
          reportReason: r.report_reason,
          moderationNote: r.moderation_note,
          moderatedAt: r.moderated_at,
        }
      : {}),
  };
}

const LIST_SELECT = `SELECT rv.*, split_part(ur.full_name, ' ', 1) AS reviewer_first_name, ur.full_name AS reviewer_name,
    us.full_name AS subject_name, p.title AS property_title
  FROM reviews rv JOIN users ur ON ur.id = rv.reviewer_id JOIN users us ON us.id = rv.subject_user_id
  LEFT JOIN properties p ON p.id = rv.property_id`;

async function mine(user) {
  const r = await pool.query(`${LIST_SELECT} WHERE rv.reviewer_id = $1 ORDER BY rv.created_at DESC`, [user.id]);
  return r.rows.map((x) => publicReview(x));
}

async function aboutMe(user) {
  const r = await pool.query(`${LIST_SELECT} WHERE rv.subject_user_id = $1 AND rv.status = 'published' ORDER BY rv.created_at DESC`, [user.id]);
  return r.rows.map((x) => publicReview(x));
}

async function forUser(userId) {
  const r = await pool.query(`${LIST_SELECT} WHERE rv.subject_user_id = $1 ORDER BY rv.created_at DESC`, [userId]);
  return r.rows.map((x) => publicReview(x, { staff: true }));
}

// Admin "Reviews" desk: every review in any status, with the totals the
// page shows on top. Filters narrow the list only - the totals stay whole.
async function adminList({ status, rating, q, propertyId, subjectId, reported, page = 1, limit = 25 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (status) add('rv.status = ?::varchar', status);
  if (rating) add('rv.rating = ?::int', Number(rating));
  if (propertyId) add('rv.property_id = ?::uuid', propertyId);
  if (subjectId) add('rv.subject_user_id = ?::uuid', subjectId);
  if (reported) where.push('rv.reported_at IS NOT NULL AND (rv.moderated_at IS NULL OR rv.moderated_at < rv.reported_at)');
  if (q) add(`(rv.title ILIKE ? OR rv.body ILIKE $${params.length + 1} OR ur.full_name ILIKE $${params.length + 1} OR us.full_name ILIKE $${params.length + 1} OR p.title ILIKE $${params.length + 1})`, `%${q}%`);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const [rows, total, stats] = await Promise.all([
    pool.query(
      `${LIST_SELECT} ${filter} ORDER BY rv.created_at DESC LIMIT ${size} OFFSET ${offset}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM reviews rv JOIN users ur ON ur.id = rv.reviewer_id JOIN users us ON us.id = rv.subject_user_id LEFT JOIN properties p ON p.id = rv.property_id ${filter}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'published')::int AS published,
              COUNT(*) FILTER (WHERE status = 'pending_moderation')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'hidden')::int AS hidden,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE reported_at IS NOT NULL AND (moderated_at IS NULL OR moderated_at < reported_at))::int AS reported,
              ROUND(AVG(rating) FILTER (WHERE status = 'published'), 1)::float AS average
       FROM reviews`
    ),
  ]);
  return {
    items: rows.rows.map((x) => ({ ...publicReview(x, { staff: true }), propertyId: x.property_id, dealId: x.deal_id, leaseId: x.lease_id })),
    pagination: { page: Math.max(Number(page) || 1, 1), limit: size, total: total.rows[0].n },
    stats: stats.rows[0],
  };
}

// Public: the published reviews written about one listing (the property the
// deal, visit or lease was for), with their average. No identities.
async function forProperty(propertyId) {
  const r = await pool.query(
    `SELECT rv.id, rv.rating, rv.title, rv.body, rv.interaction, rv.reply, rv.replied_at, rv.created_at,
            split_part(u.full_name, ' ', 1) AS reviewer_first_name
     FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
     WHERE rv.property_id = $1 AND rv.status = 'published' ORDER BY rv.created_at DESC LIMIT 50`,
    [propertyId]
  );
  const count = r.rows.length;
  return {
    rating: { average: count ? Math.round((r.rows.reduce((s, x) => s + x.rating, 0) / count) * 10) / 10 : null, count },
    reviews: r.rows,
  };
}

async function reply(user, id, text, meta = {}) {
  await assertCleanContent({ reply: text }, { blockContact: true });
  const r = await pool.query(
    `UPDATE reviews SET reply = $1, replied_at = now() WHERE id = $2 AND subject_user_id = $3 AND reply IS NULL AND status = 'published' RETURNING *`,
    [text, id, user.id]
  );
  if (!r.rows[0]) throw notFound('Review not found, not yours, or already replied to');
  await auditService.log({ actor: user, action: 'review.replied', entityType: 'review', entityId: id, ...meta });
  return publicReview(r.rows[0]);
}

async function report(user, id, reason, meta = {}) {
  const r = await pool.query(
    `UPDATE reviews SET reported_at = now(), report_reason = $1 WHERE id = $2 AND subject_user_id = $3 RETURNING *`,
    [reason, id, user.id]
  );
  if (!r.rows[0]) throw notFound('Review not found');
  await auditService.log({ actor: user, action: 'review.reported', entityType: 'review', entityId: id, after: { reason }, ...meta });
  return publicReview(r.rows[0]);
}

async function moderationQueue() {
  const r = await pool.query(
    `${LIST_SELECT} WHERE rv.status = 'pending_moderation'
        OR (rv.reported_at IS NOT NULL AND (rv.moderated_at IS NULL OR rv.moderated_at < rv.reported_at))
     ORDER BY rv.created_at ASC`
  );
  return r.rows.map((x) => publicReview(x, { staff: true }));
}

async function moderate(user, id, action, note, meta = {}) {
  const status = { approve: 'published', reject: 'rejected', hide: 'hidden' }[action];
  if (!status) throw badRequest('action must be approve, reject or hide');
  const before = (await pool.query('SELECT * FROM reviews WHERE id = $1', [id])).rows[0];
  if (!before) throw notFound('Review not found');
  const r = await pool.query(
    `UPDATE reviews SET status = $1, moderated_by = $2, moderated_at = now(), moderation_note = $3 WHERE id = $4 RETURNING *`,
    [status, user.id, note || null, id]
  );
  await auditService.log({ actor: user, action: `review.${action}`, entityType: 'review', entityId: id, before: { status: before.status }, after: { status, note }, ...meta });
  if (status === 'published' && before.status !== 'published') {
    await notificationService.createNotification({
      userId: before.subject_user_id,
      type: 'review_received',
      title: `New ${before.rating}-star review`,
      message: before.title || 'A customer reviewed your service.',
      relatedEntityType: 'review',
      relatedEntityId: id,
    });
  }
  if (status !== before.status) {
    await notificationService.createNotification({
      userId: before.reviewer_id,
      type: 'review_moderated',
      title: status === 'published' ? 'Your review is live' : 'Your review is not shown',
      message: status === 'published' ? 'It now shows on the property page.' : 'Our team reviewed it and it is not shown on the website.',
      relatedEntityType: 'review',
      relatedEntityId: id,
    });
  }
  trustService.safeRecompute(before.subject_user_id, `review_${action}`);
  return publicReview(r.rows[0], { staff: true });
}

// ------------------------------------------------------------ verifications

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

async function submitVerification(user, { kind, reference, documentPath }, meta = {}) {
  if (kind === 'gst' && !GSTIN.test(String(reference || '').toUpperCase())) throw badRequest('Enter a valid 15-character GSTIN');
  if (['rera', 'company'].includes(kind) && !reference) throw badRequest('Registration number is required');
  if (kind === 'kyc' && !documentPath && !reference) throw badRequest('Upload an ID document or enter its reference');
  // Never store full ID numbers for KYC - keep only the last 4 characters.
  const ref = kind === 'kyc' && reference ? `••••${String(reference).replace(/\s+/g, '').slice(-4)}` : kind === 'gst' ? String(reference).toUpperCase() : reference || null;
  const r = await pool.query(
    `INSERT INTO user_verifications (user_id, kind, reference, document_path, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (user_id, kind) DO UPDATE SET reference = EXCLUDED.reference,
       document_path = COALESCE(EXCLUDED.document_path, user_verifications.document_path),
       status = 'pending', notes = NULL, decided_by = NULL, decided_at = NULL
     RETURNING id, kind, reference, status, created_at`,
    [user.id, kind, ref, documentPath || null]
  );
  await auditService.log({ actor: user, action: 'verification.submitted', entityType: 'user_verification', entityId: r.rows[0].id, after: { kind }, ...meta });
  return r.rows[0];
}

async function listVerifications({ status = 'pending' } = {}) {
  const r = await pool.query(
    `SELECT v.id, v.user_id, v.kind, v.reference, v.status, v.notes, v.created_at, v.decided_at, (v.document_path IS NOT NULL) AS has_document,
            u.full_name, u.email, r.name AS role
     FROM user_verifications v JOIN users u ON u.id = v.user_id JOIN roles r ON r.id = u.role_id
     WHERE ($1 = 'all' OR v.status = $1) ORDER BY v.created_at ASC LIMIT 300`,
    [status]
  );
  return r.rows;
}

async function verificationDocumentUrl(id) {
  const v = (await pool.query('SELECT document_path FROM user_verifications WHERE id = $1', [id])).rows[0];
  if (!v?.document_path) throw notFound('No document');
  const { generateSignedReadUrl } = require('../utils/storage');
  return { url: await generateSignedReadUrl(v.document_path, 15 * 60 * 1000) };
}

async function decideVerification(user, id, action, notes, meta = {}) {
  if (action === 'reject' && !notes) throw badRequest('A reason is required to reject');
  const r = await pool.query(
    `UPDATE user_verifications SET status = $1, notes = $2, decided_by = $3, decided_at = now() WHERE id = $4 RETURNING *`,
    [action === 'verify' ? 'verified' : 'rejected', notes || null, user.id, id]
  );
  const v = r.rows[0];
  if (!v) throw notFound('Verification not found');
  await auditService.log({ actor: user, action: `verification.${action}`, entityType: 'user_verification', entityId: id, after: { kind: v.kind, notes }, ...meta });
  const label = { kyc: 'KYC', rera: 'RERA registration', gst: 'GSTIN', company: 'Company registration', institutional_cert: 'Institutional broker certification' }[v.kind];
  await notificationService.createNotification({
    userId: v.user_id,
    type: 'verification_decided',
    title: `${label} ${action === 'verify' ? 'verified' : 'not verified'}`,
    message: action === 'verify' ? `Your ${label} is verified - your trust score has been updated.` : `Your ${label} could not be verified: ${notes}`,
    relatedEntityType: 'user_verification',
    relatedEntityId: id,
  });
  await trustService.recompute(v.user_id, `verification_${action}`);
  return v;
}

module.exports = {
  STAFF,
  eligibleInteractions,
  createReview,
  mine,
  aboutMe,
  forUser,
  adminList,
  forProperty,
  reply,
  report,
  moderationQueue,
  moderate,
  submitVerification,
  listVerifications,
  verificationDocumentUrl,
  decideVerification,
};
