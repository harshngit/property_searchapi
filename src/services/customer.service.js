const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const { signUrls } = require('../utils/storage');

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

const CUSTOMER_SELECT = `
  SELECT c.*, t.name AS tenant_name, creator.full_name AS created_by_name,
         account.signup_source AS account_signup_source, account.status AS account_status
  FROM customers c
  LEFT JOIN tenants t ON t.id = c.tenant_id
  LEFT JOIN users creator ON creator.id = c.created_by
  LEFT JOIN users account ON account.id = c.user_id
`;

function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  where.push(`(c.tenant_id = $${params.length - 1} OR c.created_by = $${params.length})`);
}

async function listCustomers(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);
  // Section 35: a suspended / removed customer is for the Super Admin only.
  if (user.role !== 'super_admin') where.push(`NOT EXISTS (SELECT 1 FROM users su WHERE su.id = c.user_id AND su.status IN ('suspended', 'removed'))`);

  if (filters.search) {
    params.push(`%${filters.search}%`);
    where.push(`(c.full_name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.mobile ILIKE $${params.length})`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM customers c ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `${CUSTOMER_SELECT}
     ${whereClause}
     ORDER BY c.created_at DESC
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
  const result = await pool.query(`${CUSTOMER_SELECT} WHERE c.id = $1`, [id]);
  const customer = result.rows[0];
  if (!customer) throw notFound();
  return customer;
}

// Looks up a customer record by the login account (users.id) it's linked
// to, rather than by customers.id - used to resolve "the customer record
// for the currently authenticated user" (e.g. for favorites). Returns
// null (not a 404) since a login account without a linked customer
// record is an expected, non-error case for staff roles.
async function getCustomerByUserId(userId) {
  const result = await pool.query('SELECT * FROM customers WHERE user_id = $1 LIMIT 1', [userId]);
  return result.rows[0] || null;
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

  return getCustomerById(result.rows[0].id);
}

// Used by the lead public-inquiry flow, the WhatsApp bot, and a new
// self-registered `customer` user account (registerUser/loginWithGoogle) -
// reuses an existing customer record matched by email/mobile/WhatsApp
// BSUID, or creates a new (tenant-less, staff-less) one. Any of
// {userId, mobile, waUserId} missing on an existing match is backfilled
// from this call - e.g. a WhatsApp user first captured via BSUID only
// (number hidden) later messages with their number visible, or a customer
// created from a public inquiry links to the account they sign up with.
async function findOrCreateCustomerByContact({ fullName, email, mobile, waUserId, userId } = {}) {
  let existing = null;
  if (email) {
    const result = await pool.query('SELECT * FROM customers WHERE email = $1 LIMIT 1', [email]);
    existing = result.rows[0];
  }
  if (!existing && mobile) {
    const result = await pool.query('SELECT * FROM customers WHERE mobile = $1 LIMIT 1', [mobile]);
    existing = result.rows[0];
  }
  if (!existing && waUserId) {
    const result = await pool.query('SELECT * FROM customers WHERE wa_user_id = $1 LIMIT 1', [waUserId]);
    existing = result.rows[0];
  }

  if (existing) {
    const set = [];
    const params = [];
    if (userId && !existing.user_id) { params.push(userId); set.push(`user_id = $${params.length}`); }
    if (mobile && !existing.mobile) { params.push(mobile); set.push(`mobile = $${params.length}`); }
    if (waUserId && !existing.wa_user_id) { params.push(waUserId); set.push(`wa_user_id = $${params.length}`); }

    if (set.length === 0) return existing;

    params.push(existing.id);
    const updated = await pool.query(
      `UPDATE customers SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return updated.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO customers (user_id, full_name, email, mobile, wa_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId || null, fullName, email || null, mobile || null, waUserId || null]
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
  await pool.query(
    `UPDATE customers SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return getCustomerById(id);
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
  return signUrls(result.rows, 'document_url');
}

// documentUrl is client-supplied (this endpoint takes a URL/path directly,
// there's no file upload step here) - it may be one of our GCS objects or a
// fully external URL. signUrls()/getReadUrl() only sign what's actually
// ours and pass anything else through untouched, so it's safe to run
// unconditionally.
async function addDocument(customerId, data, user) {
  const { documentUrl, documentType, dealId } = data;

  const result = await pool.query(
    `INSERT INTO customer_documents (customer_id, deal_id, document_url, document_type, uploaded_by, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [customerId, dealId || null, documentUrl, documentType || null, user.id]
  );

  return signUrls(result.rows[0], 'document_url');
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

async function deleteCustomer(id) {
  const result = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) throw notFound();
}

module.exports = {
  listCustomers,
  getCustomerById,
  getCustomerByUserId,
  createCustomer,
  findOrCreateCustomerByContact,
  updateCustomer,
  deleteCustomer,
  getPreferences,
  upsertPreferences,
  getDocuments,
  addDocument,
  getCustomerDeals,
};
