const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const { signUrls, uploadBuffer } = require('../utils/storage');

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
  where.push(`(d.tenant_id = $${params.length - 1} OR d.uploaded_by = $${params.length})`);
}

// Human-readable context for list views: who the document belongs to and
// who uploaded / reviewed it.
const DOCUMENT_LIST_SELECT = `
  SELECT d.*, c.full_name AS customer_name, p.title AS property_title,
         uploader.full_name AS uploaded_by_name, reviewer.full_name AS reviewed_by_name
  FROM documents d
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN deals dl ON dl.id = d.deal_id
  LEFT JOIN properties p ON p.id = dl.property_id
  LEFT JOIN users uploader ON uploader.id = d.uploaded_by
  LEFT JOIN users reviewer ON reviewer.id = d.reviewed_by
`;

async function listDocuments(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.documentType) {
    params.push(filters.documentType);
    where.push(`d.document_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`d.status = $${params.length}`);
  }
  if (filters.customerId) {
    params.push(filters.customerId);
    where.push(`d.customer_id = $${params.length}`);
  }
  if (filters.dealId) {
    params.push(filters.dealId);
    where.push(`d.deal_id = $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM documents d ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `${DOCUMENT_LIST_SELECT}
     ${whereClause}
     ORDER BY d.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: await signUrls(result.rows, 'document_url'),
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
  return signUrls(document, 'document_url');
}

// documentUrl is client-supplied, same as customer.service.js's addDocument -
// signUrls() only touches values that resolve to one of our GCS objects.
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

  return signUrls(result.rows[0], 'document_url');
}

// Stores an uploaded file privately in GCS (documents/<id-prefix>/...) and
// records it like any other document - the stored value is the object path,
// signed per request on read.
async function uploadDocument(file, data, user) {
  const folder = `documents/${data.dealId || data.customerId || 'general'}`;
  const objectPath = await uploadBuffer(file.buffer, folder, file.originalname, file.mimetype);
  return createDocument({ ...data, documentUrl: objectPath, fileName: data.fileName || file.originalname }, user);
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

  return signUrls(result.rows[0], 'document_url');
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
  return signUrls(result.rows, 'document_url');
}

async function getByDeal(user, dealId) {
  const where = ['deal_id = $1'];
  const params = [dealId];
  applyTenantScope(user, where, params);

  const result = await pool.query(
    `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return signUrls(result.rows, 'document_url');
}

async function reviewDocument(id, { status, reviewNotes }, reviewer) {
  const result = await pool.query(
    `UPDATE documents SET status = $1, reviewed_by = $2, review_notes = $3 WHERE id = $4 RETURNING *`,
    [status, reviewer.id, reviewNotes || null, id]
  );
  if (result.rows.length === 0) throw notFound();
  return signUrls(result.rows[0], 'document_url');
}

module.exports = {
  uploadDocument,
  listDocuments,
  getDocumentById,
  createDocument,
  updateDocument,
  deleteDocument,
  getByCustomer,
  getByDeal,
  reviewDocument,
};
