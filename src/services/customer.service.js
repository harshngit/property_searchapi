const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');

function notFound(message = 'Customer not found') {
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
  where.push(`(tenant_id = $${params.length - 1} OR created_by = $${params.length})`);
}

async function listCustomers(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.search) {
    params.push(`%${filters.search}%`);
    where.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR mobile ILIKE $${params.length})`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM customers ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM customers
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

async function getCustomerById(id) {
  const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  const customer = result.rows[0];
  if (!customer) throw notFound();
  return customer;
}

async function createCustomer(data, user) {
  const { fullName, email, mobile, userId } = data;

  if (!email && !mobile) {
    throw badRequest('Either email or mobile is required');
  }

  const result = await pool.query(
    `INSERT INTO customers (tenant_id, created_by, user_id, full_name, email, mobile)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [user.tenant_id || null, user.id, userId || null, fullName, email || null, mobile || null]
  );

  return result.rows[0];
}

// Used by the lead public-inquiry flow: reuses an existing customer record
// matched by email/mobile, or creates a new (tenant-less, staff-less) one.
async function findOrCreateCustomerByContact({ fullName, email, mobile }) {
  if (email) {
    const existing = await pool.query('SELECT * FROM customers WHERE email = $1 LIMIT 1', [email]);
    if (existing.rows.length > 0) return existing.rows[0];
  }
  if (mobile) {
    const existing = await pool.query('SELECT * FROM customers WHERE mobile = $1 LIMIT 1', [mobile]);
    if (existing.rows.length > 0) return existing.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO customers (full_name, email, mobile)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [fullName, email || null, mobile || null]
  );
  return result.rows[0];
}

const UPDATABLE_CUSTOMER_FIELDS = {
  fullName: 'full_name',
  email: 'email',
  mobile: 'mobile',
  userId: 'user_id',
};

async function updateCustomer(id, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_CUSTOMER_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE customers SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0];
}

async function getPreferences(customerId) {
  const result = await pool.query('SELECT * FROM customer_preferences WHERE customer_id = $1', [customerId]);
  return result.rows[0] || null;
}

async function upsertPreferences(customerId, data) {
  const {
    budgetMin,
    budgetMax,
    preferredLocations,
    propertyType,
    transactionType,
    bedrooms,
    notes,
  } = data;

  const result = await pool.query(
    `INSERT INTO customer_preferences (
       customer_id, budget_min, budget_max, preferred_locations,
       property_type, transaction_type, bedrooms, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (customer_id) DO UPDATE SET
       budget_min = EXCLUDED.budget_min,
       budget_max = EXCLUDED.budget_max,
       preferred_locations = EXCLUDED.preferred_locations,
       property_type = EXCLUDED.property_type,
       transaction_type = EXCLUDED.transaction_type,
       bedrooms = EXCLUDED.bedrooms,
       notes = EXCLUDED.notes
     RETURNING *`,
    [
      customerId,
      budgetMin ?? null,
      budgetMax ?? null,
      JSON.stringify(preferredLocations || []),
      propertyType || null,
      transactionType || null,
      bedrooms ?? null,
      notes || null,
    ]
  );

  return result.rows[0];
}

async function getDocuments(customerId) {
  const result = await pool.query(
    'SELECT * FROM customer_documents WHERE customer_id = $1 ORDER BY created_at DESC',
    [customerId]
  );
  return result.rows;
}

async function addDocument(customerId, data, user) {
  const { documentUrl, documentType, dealId } = data;

  const result = await pool.query(
    `INSERT INTO customer_documents (customer_id, deal_id, document_url, document_type, uploaded_by, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [customerId, dealId || null, documentUrl, documentType || null, user.id]
  );

  return result.rows[0];
}

// Used by GET /api/customers/:id/deals, now that the Deal Pipeline module's
// `deals` table exists (replaces the earlier empty-array placeholder). Not
// implemented via deal.service.js to avoid a circular require
// (deal.service -> lead.service -> customer.service), so the tenant-scope
// clause is duplicated inline here rather than shared.
async function getCustomerDeals(user, customerId) {
  const where = ['customer_id = $1'];
  const params = [customerId];

  if (!isAdmin(user.role)) {
    params.push(user.tenant_id || null, user.id);
    where.push(`(tenant_id = $${params.length - 1} OR broker_id = $${params.length})`);
  }

  const result = await pool.query(
    `SELECT * FROM deals WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

module.exports = {
  listCustomers,
  getCustomerById,
  createCustomer,
  findOrCreateCustomerByContact,
  updateCustomer,
  getPreferences,
  upsertPreferences,
  getDocuments,
  addDocument,
  getCustomerDeals,
};
