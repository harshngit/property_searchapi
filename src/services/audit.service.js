const pool = require('../config/db');
const { parsePagination, buildPagination } = require('../utils/pagination');

// Pulls the caller's IP / user agent off an Express request for log().
function requestMeta(req) {
  return {
    ip: req.ip || null,
    userAgent: (req.headers['user-agent'] || '').slice(0, 500) || null,
  };
}

// Writes one immutable audit_logs row. `client` lets a caller include the
// audit write in its own transaction so the change and its log commit (or
// roll back) together.
async function log({ actor, action, entityType, entityId, before, after, ip, userAgent }, client = pool) {
  await client.query(
    `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      actor?.id || null,
      actor?.role || null,
      action,
      entityType,
      entityId != null ? String(entityId) : null,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      ip || null,
      userAgent || null,
    ]
  );
}

async function listLogs(query) {
  const { page, limit, offset } = parsePagination(query, 50);
  const where = [];
  const params = [];

  if (query.entityType) {
    params.push(query.entityType);
    where.push(`a.entity_type = $${params.length}`);
  }
  if (query.entityId) {
    params.push(query.entityId);
    where.push(`a.entity_id = $${params.length}`);
  }
  if (query.actorId) {
    params.push(query.actorId);
    where.push(`a.actor_id = $${params.length}`);
  }
  if (query.action) {
    params.push(query.action);
    where.push(`a.action = $${params.length}`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    where.push(`a.created_at >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    where.push(`a.created_at <= $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM audit_logs a ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT a.*, u.full_name AS actor_name FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { items: result.rows, pagination: buildPagination(page, limit, count.rows[0].count) };
}

module.exports = { log, listLogs, requestMeta };
