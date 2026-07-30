const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');

function notFound(message = 'Property not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Restricts a listing query to the caller's own tenant/records unless
// they are admin/super_admin, per the module's tenant-isolation rule.
function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  where.push(`(tenant_id = $${params.length - 1} OR created_by = $${params.length})`);
}

async function listProperties(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.city) {
    params.push(filters.city);
    where.push(`city ILIKE $${params.length}`);
  }
  if (filters.propertyType) {
    params.push(filters.propertyType);
    where.push(`property_type = $${params.length}`);
  }
  if (filters.transactionType) {
    params.push(filters.transactionType);
    where.push(`transaction_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.minPrice) {
    params.push(filters.minPrice);
    where.push(`price >= $${params.length}`);
  }
  if (filters.maxPrice) {
    params.push(filters.maxPrice);
    where.push(`price <= $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM properties ${whereClause}`,
    params
  );

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM properties
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

async function getPropertyById(id) {
  const result = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
  const property = result.rows[0];
  if (!property) throw notFound();

  const media = await pool.query(
    'SELECT * FROM property_media WHERE property_id = $1 ORDER BY display_order ASC, created_at ASC',
    [id]
  );

  return { ...property, media: media.rows };
}

async function createProperty(data, user) {
  const {
    title,
    description,
    propertyType,
    transactionType,
    price,
    city,
    locality,
    address,
    latitude,
    longitude,
    areaSqft,
    bedrooms,
    bathrooms,
    amenities,
    brokerId,
    builderId,
  } = data;

  const result = await pool.query(
    `INSERT INTO properties (
       tenant_id, created_by, broker_id, builder_id, title, description,
       property_type, transaction_type, price, city, locality, address,
       latitude, longitude, area_sqft, bedrooms, bathrooms, amenities, status
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'pending_approval'
     ) RETURNING *`,
    [
      user.tenant_id || null,
      user.id,
      brokerId || (user.role === 'broker' ? user.id : null),
      builderId || (user.role === 'builder' ? user.id : null),
      title,
      description || null,
      propertyType,
      transactionType,
      price,
      city,
      locality || null,
      address || null,
      latitude || null,
      longitude || null,
      areaSqft || null,
      bedrooms || null,
      bathrooms || null,
      JSON.stringify(amenities || []),
    ]
  );

  return result.rows[0];
}

const UPDATABLE_FIELDS = {
  title: 'title',
  description: 'description',
  propertyType: 'property_type',
  transactionType: 'transaction_type',
  city: 'city',
  locality: 'locality',
  address: 'address',
  latitude: 'latitude',
  longitude: 'longitude',
  areaSqft: 'area_sqft',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
};

async function updateProperty(id, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }
  if (data.amenities !== undefined) {
    params.push(JSON.stringify(data.amenities));
    set.push(`amenities = $${params.length}`);
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE properties SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0];
}

async function deleteProperty(id) {
  await pool.query('DELETE FROM properties WHERE id = $1', [id]);
}

async function addMedia(propertyId, mediaItems) {
  const inserted = [];
  for (const item of mediaItems) {
    const result = await pool.query(
      `INSERT INTO property_media (property_id, media_type, url, display_order, is_primary)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        propertyId,
        item.mediaType || 'image',
        item.url,
        item.displayOrder || 0,
        item.isPrimary || false,
      ]
    );
    inserted.push(result.rows[0]);
  }
  return inserted;
}

async function deleteMedia(propertyId, mediaId) {
  const result = await pool.query(
    'DELETE FROM property_media WHERE id = $1 AND property_id = $2 RETURNING id',
    [mediaId, propertyId]
  );
  if (result.rows.length === 0) throw notFound('Media not found for this property');
}

async function updateAvailability(id, property, isAvailable) {
  if (!['approved', 'inactive'].includes(property.status)) {
    throw badRequest(
      'Availability can only be toggled for a property that has already been approved'
    );
  }

  const newStatus = isAvailable ? 'approved' : 'inactive';
  const result = await pool.query(
    'UPDATE properties SET status = $1 WHERE id = $2 RETURNING *',
    [newStatus, id]
  );
  return result.rows[0];
}

async function updatePricing(id, price) {
  const result = await pool.query(
    'UPDATE properties SET price = $1 WHERE id = $2 RETURNING *',
    [price, id]
  );
  return result.rows[0];
}

async function approveProperty(id, adminUser) {
  const result = await pool.query(
    `UPDATE properties
     SET status = 'approved', approved_by = $1, approved_at = now(), rejection_reason = NULL
     WHERE id = $2 RETURNING *`,
    [adminUser.id, id]
  );
  if (result.rows.length === 0) throw notFound();
  return result.rows[0];
}

async function rejectProperty(id, reason, adminUser) {
  const result = await pool.query(
    `UPDATE properties
     SET status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = now()
     WHERE id = $3 RETURNING *`,
    [reason, adminUser.id, id]
  );
  if (result.rows.length === 0) throw notFound();
  return result.rows[0];
}

module.exports = {
  listProperties,
  getPropertyById,
  createProperty,
  updateProperty,
  deleteProperty,
  addMedia,
  deleteMedia,
  updateAvailability,
  updatePricing,
  approveProperty,
  rejectProperty,
};
