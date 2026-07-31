const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');

function notFound(message = 'Document not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  where.push(`(tenant_id = $${params.length - 1} OR uploaded_by = $${params.length})`);
}

async function listDocuments(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.documentType) {
    params.push(filters.documentType);
    where.push(`document_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.customerId) {
    params.push(filters.customerId);
    where.push(`customer_id = $${params.length}`);
  }
  if (filters.dealId) {
    params.push(filters.dealId);
    where.push(`deal_id = $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM documents ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM documents
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

async function getDocumentById(id) {
  const result = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
  const document = result.rows[0];
  if (!document) throw notFound();
  return document;
}

async function createDocument(data, user) {
  const { customerId, dealId, documentType, documentUrl, fileName } = data;

  const result = await pool.query(
    `INSERT INTO documents (tenant_id, customer_id, deal_id, document_type, document_url, file_name, uploaded_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING *`,
    [
      user.tenant_id || null,
      customerId || null,
      dealId || null,
      documentType || 'other',
      documentUrl,
      fileName || null,
      user.id,
    ]
  );

  return result.rows[0];
}

const UPDATABLE_DOCUMENT_FIELDS = {
  customerId: 'customer_id',
  dealId: 'deal_id',
  documentType: 'document_type',
  documentUrl: 'document_url',
  fileName: 'file_name',
};

async function updateDocument(id, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_DOCUMENT_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE documents SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0];
}

async function deleteDocument(id) {
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
}

async function getByCustomer(user, customerId) {
  const where = ['customer_id = $1'];
  const params = [customerId];
  applyTenantScope(user, where, params);

  const result = await pool.query(
    `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

async function getByDeal(user, dealId) {
  const where = ['deal_id = $1'];
  const params = [dealId];
  applyTenantScope(user, where, params);

  const result = await pool.query(
    `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

async function reviewDocument(id, { status, reviewNotes }, reviewer) {
  const result = await pool.query(
    `UPDATE documents SET status = $1, reviewed_by = $2, review_notes = $3 WHERE id = $4 RETURNING *`,
    [status, reviewer.id, reviewNotes || null, id]
  );
  if (result.rows.length === 0) throw notFound();
  return result.rows[0];
}

module.exports = {
  listDocuments,
  getDocumentById,
  createDocument,
  updateDocument,
  deleteDocument,
  getByCustomer,
  getByDeal,
  reviewDocument,
};
