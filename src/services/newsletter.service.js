const pool = require('../config/db');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { notFound } = require('../utils/httpError');

// Website newsletter sign-ups. Subscribing an email that already exists
// just reactivates it, so the form never errors on a repeat.

async function subscribe({ email, sourcePage }, user = null) {
  const result = await pool.query(
    `INSERT INTO newsletter_subscriptions (email, source_page, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (LOWER(email)) DO UPDATE
       SET status = 'subscribed', unsubscribed_at = NULL,
           subscribed_at = CASE WHEN newsletter_subscriptions.status = 'unsubscribed' THEN now() ELSE newsletter_subscriptions.subscribed_at END,
           user_id = COALESCE(newsletter_subscriptions.user_id, EXCLUDED.user_id)
     RETURNING id, email, status, subscribed_at`,
    [email.trim().toLowerCase(), sourcePage || null, user?.id || null]
  );
  return result.rows[0];
}

async function listSubscribers(query = {}) {
  const { page, limit, offset } = parsePagination(query, 50);
  const where = [];
  const params = [];
  if (query.status) {
    params.push(query.status);
    where.push(`status = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    where.push(`email ILIKE $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [count, rows, stats] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM newsletter_subscriptions ${clause}`, params),
    pool.query(
      `SELECT * FROM newsletter_subscriptions ${clause} ORDER BY subscribed_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'subscribed')::int AS subscribed,
              COUNT(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed,
              COUNT(*) FILTER (WHERE status = 'subscribed' AND subscribed_at >= now() - interval '30 days')::int AS last_30_days
       FROM newsletter_subscriptions`
    ),
  ]);
  return { items: rows.rows, pagination: buildPagination(page, limit, count.rows[0].n), stats: stats.rows[0] };
}

async function setStatus(id, status) {
  const result = await pool.query(
    `UPDATE newsletter_subscriptions
     SET status = $1::varchar, unsubscribed_at = CASE WHEN $1::varchar = 'unsubscribed' THEN now() ELSE NULL END
     WHERE id = $2 RETURNING *`,
    [status, id]
  );
  if (!result.rows[0]) throw notFound('Subscriber not found');
  return result.rows[0];
}

module.exports = { subscribe, listSubscribers, setStatus };
