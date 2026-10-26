const pool = require('../config/db');

function notFound(message = 'Notification not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

async function listNotifications(userId, filters, page, limit) {
  const intel = require('./notificationIntel.service');
  const where = ['user_id = $1'];
  const params = [userId];

  if (filters.isRead !== undefined) {
    params.push(filters.isRead);
    where.push(`is_read = $${params.length}`);
  }
  // Notification Centre filters (Module 43): type group, priority and date range.
  if (filters.category && intel.CATEGORIES[filters.category]) where.push(intel.categorySql(filters.category, params));
  if (filters.priority && intel.PRIORITIES.includes(filters.priority)) {
    params.push(filters.priority);
    where.push(`priority = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`created_at >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`created_at < $${params.length}::date + 1`);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM notifications ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM notifications
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows.map((n) => ({ ...n, category: n.category || intel.categoryOf(n.type) })),
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

// Used internally by task.service.js (and available to any future module)
// to raise a notification - kept centralized here since notification.service.js
// owns the notifications table.
// `priority` overrides the priority worked out from the type; `alreadySent`
// names channels the caller has delivered on itself (so they are not repeated).
async function createNotification({ userId, tenantId, type, title, message, relatedEntityType, relatedEntityId, priority, alreadySent, scheduled, whatsappContent }, client = pool) {
  const intel = require('./notificationIntel.service');
  const kind = intel.classify({ type, title, priority });
  const result = await client.query(
    `INSERT INTO notifications (user_id, tenant_id, type, title, message, related_entity_type, related_entity_id, category, priority, persistent, whatsapp_content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [userId, tenantId || null, type, String(title || '').slice(0, 200), message || null, relatedEntityType || null, relatedEntityId || null, kind.category, kind.priority, kind.persistent && !!relatedEntityId, whatsappContent ? JSON.stringify(whatsappContent) : null]
  );
  // Module 43: decide what also leaves the app (push, WhatsApp, SMS, email), now or in a digest.
  intel.onCreated(result.rows[0], { alreadySent: alreadySent || [], scheduled: scheduled === true });
  return result.rows[0];
}

async function markRead(id, userId) {
  const result = await pool.query(
    `UPDATE notifications SET is_read = true, read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId]
  );
  if (result.rows.length === 0) throw notFound();
  return result.rows[0];
}

async function markAllRead(userId) {
  const result = await pool.query(
    `UPDATE notifications SET is_read = true, read_at = now() WHERE user_id = $1 AND is_read = false RETURNING id`,
    [userId]
  );
  return { updated: result.rows.length };
}

// Header bell badge - cheap single count, polled by both frontends.
async function getUnreadCount(userId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = false',
    [userId]
  );
  return result.rows[0].count;
}

module.exports = {
  getUnreadCount,
  listNotifications,
  createNotification,
  markRead,
  markAllRead,
};
