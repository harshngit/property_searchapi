const pool = require('../config/db');

function notFound(message = 'Notification not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

async function listNotifications(userId, filters, page, limit) {
  const where = ['user_id = $1'];
  const params = [userId];

  if (filters.isRead !== undefined) {
    params.push(filters.isRead);
    where.push(`is_read = $${params.length}`);
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
    items: result.rows,
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
async function createNotification({ userId, tenantId, type, title, message, relatedEntityType, relatedEntityId }, client = pool) {
  const result = await client.query(
    `INSERT INTO notifications (user_id, tenant_id, type, title, message, related_entity_type, related_entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, tenantId || null, type, title, message || null, relatedEntityType || null, relatedEntityId || null]
  );
  return result.rows[0];
}

async function markRead(id, userId) {
  const result = await pool.query(
    `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId]
  );
  if (result.rows.length === 0) throw notFound();
  return result.rows[0];
}

async function markAllRead(userId) {
  const result = await pool.query(
    `UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false RETURNING id`,
    [userId]
  );
  return { updated: result.rows.length };
}

module.exports = {
  listNotifications,
  createNotification,
  markRead,
  markAllRead,
};
