const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const { uploadBuffer, deleteObject, signUrls, getReadUrl } = require('../utils/storage');
const customerService = require('./customer.service');

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

function forbidden(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

// Every human-readable field a property row needs for display - the
// properties table itself only stores FK ids. Shared by listProperties/
// getPropertyById so the shape returned to the frontend is identical
// everywhere.
const PROPERTY_SELECT = `
  SELECT p.*,
         creator.full_name AS created_by_name,
         broker.full_name AS broker_name,
         builder.full_name AS builder_name,
         builder.builder_rating AS builder_rating,
         builder.builder_experience_years AS builder_experience_years,
         builder.builder_projects_count AS builder_projects_count,
         (SELECT COALESCE(json_agg(json_build_object(
            'id', pm.id, 'mediaType', pm.media_type, 'url', pm.url,
            'displayOrder', pm.display_order, 'isPrimary', pm.is_primary
          ) ORDER BY pm.display_order ASC, pm.created_at ASC), '[]'::json)
          FROM property_media pm WHERE pm.property_id = p.id) AS media
  FROM properties p
  LEFT JOIN users creator ON creator.id = p.created_by
  LEFT JOIN users broker ON broker.id = p.broker_id
  LEFT JOIN users builder ON builder.id = p.builder_id
`;

// PROPERTY_SELECT's `media` column is a lightweight aggregate (no signed
// URLs yet) - used as-is by listProperties for list/grid views.
// getPropertyById below fetches the full property_media rows separately and
// overwrites this with that, so a single property page always gets every
// media column, not just the four aggregated here.
async function signPropertyMedia(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const signed = await Promise.all(
    list.map(async (row) => {
      if (!row) return row;
      const media = await Promise.all((row.media || []).map(async (m) => ({ ...m, url: await getReadUrl(m.url) })));
      return { ...row, media };
    })
  );
  return Array.isArray(rows) ? signed : signed[0];
}

// Restricts a listing query to the caller's own tenant/records unless
// they are admin/super_admin, per the module's tenant-isolation rule.
function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  where.push(`(p.tenant_id = $${params.length - 1} OR p.created_by = $${params.length})`);
}

async function listProperties(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.city) {
    params.push(filters.city);
    where.push(`p.city ILIKE $${params.length}`);
  }
  if (filters.propertyType) {
    params.push(filters.propertyType);
    where.push(`p.property_type = $${params.length}`);
  }
  if (filters.transactionType) {
    params.push(filters.transactionType);
    where.push(`p.transaction_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`p.status = $${params.length}`);
  }
  if (filters.minRate) {
    params.push(filters.minRate);
    where.push(`p.rate >= $${params.length}`);
  }
  if (filters.maxRate) {
    params.push(filters.maxRate);
    where.push(`p.rate <= $${params.length}`);
  }
  // Used by the Broker CRM dashboard (GET /api/broker/inventory) to scope
  // to "properties created by or assigned (as broker) to this user" - kept
  // here rather than duplicated in broker.service.js since this service
  // owns all properties-table querying.
  if (filters.brokerId) {
    params.push(filters.brokerId);
    where.push(`(p.created_by = $${params.length} OR p.broker_id = $${params.length})`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM properties p ${whereClause}`,
    params
  );

  params.push(limit, offset);
  const result = await pool.query(
    `${PROPERTY_SELECT}
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: await signPropertyMedia(result.rows),
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

async function getPropertyById(id) {
  const result = await pool.query(`${PROPERTY_SELECT} WHERE p.id = $1`, [id]);
  const property = result.rows[0];
  if (!property) throw notFound();

  // Overwrites PROPERTY_SELECT's lightweight media aggregate with the full
  // property_media rows (every column, not just the four aggregated there).
  const media = await pool.query(
    'SELECT * FROM property_media WHERE property_id = $1 ORDER BY display_order ASC, created_at ASC',
    [id]
  );

  return { ...property, media: await signUrls(media.rows, 'url') };
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
    rate,
    listingCategory,
    annualAppreciationPercent,
    estimatedRentMonthly,
    localityRating,
    auctionDate,
    sourceBank,
    occupancyPercent,
    yieldPercent,
    yieldQualifier,
    aboutExtended,
    carpetAreaSqft,
    facing,
    tags,
    badge,
    verified,
    reraNumber,
    possessionStatus,
    floorNumber,
    totalFloors,
    furnishing,
    parkingSpots,
    parkingType,
    ageOfProperty,
    gatedCommunity,
    faqs,
  } = data;

  const result = await pool.query(
    `INSERT INTO properties (
       tenant_id, created_by, broker_id, builder_id, title, description,
       property_type, transaction_type, price, city, locality, address,
       latitude, longitude, area_sqft, bedrooms, bathrooms, amenities, status,
       rate, listing_category, annual_appreciation_percent, estimated_rent_monthly,
       locality_rating, auction_date, source_bank, occupancy_percent, yield_percent, yield_qualifier,
       about_extended, carpet_area_sqft, facing, tags, badge, is_verified, rera_number,
       possession_status, floor_number, total_floors, furnishing, parking_spots, parking_type,
       age_of_property, gated_community, faqs
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'pending_approval',
       $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
       $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44
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
      rate ?? null,
      listingCategory || 'residential',
      annualAppreciationPercent ?? null,
      estimatedRentMonthly ?? null,
      localityRating ?? null,
      auctionDate || null,
      sourceBank || null,
      occupancyPercent ?? null,
      yieldPercent ?? null,
      yieldQualifier || null,
      aboutExtended || null,
      carpetAreaSqft ?? null,
      facing || null,
      JSON.stringify(tags || []),
      badge || null,
      verified ?? false,
      reraNumber || null,
      possessionStatus || null,
      floorNumber ?? null,
      totalFloors ?? null,
      furnishing || null,
      parkingSpots ?? null,
      parkingType || null,
      ageOfProperty || null,
      gatedCommunity ?? false,
      JSON.stringify(faqs || []),
    ]
  );

  return getPropertyById(result.rows[0].id);
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
  rate: 'rate',
  listingCategory: 'listing_category',
  annualAppreciationPercent: 'annual_appreciation_percent',
  estimatedRentMonthly: 'estimated_rent_monthly',
  localityRating: 'locality_rating',
  auctionDate: 'auction_date',
  sourceBank: 'source_bank',
  occupancyPercent: 'occupancy_percent',
  yieldPercent: 'yield_percent',
  yieldQualifier: 'yield_qualifier',
  aboutExtended: 'about_extended',
  carpetAreaSqft: 'carpet_area_sqft',
  facing: 'facing',
  badge: 'badge',
  verified: 'is_verified',
  reraNumber: 'rera_number',
  possessionStatus: 'possession_status',
  floorNumber: 'floor_number',
  totalFloors: 'total_floors',
  furnishing: 'furnishing',
  parkingSpots: 'parking_spots',
  parkingType: 'parking_type',
  ageOfProperty: 'age_of_property',
  gatedCommunity: 'gated_community',
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
  if (data.tags !== undefined) {
    params.push(JSON.stringify(data.tags));
    set.push(`tags = $${params.length}`);
  }
  if (data.faqs !== undefined) {
    params.push(JSON.stringify(data.faqs));
    set.push(`faqs = $${params.length}`);
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  await pool.query(
    `UPDATE properties SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return getPropertyById(id);
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
  return signUrls(inserted, 'url');
}

// Uploads a single file straight to GCS (properties/<id>/images|videos/...)
// and records the resulting object path in property_media (the bucket is
// private, so what's stored is a path, never a browsable URL).
async function uploadMedia(propertyId, file, options = {}) {
  const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'image';
  const folder = `properties/${propertyId}/${mediaType === 'video' ? 'videos' : 'images'}`;
  const objectPath = await uploadBuffer(file.buffer, folder, file.originalname, file.mimetype);

  const result = await pool.query(
    `INSERT INTO property_media (property_id, media_type, url, display_order, is_primary)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [propertyId, mediaType, objectPath, options.displayOrder || 0, options.isPrimary || false]
  );
  return signUrls(result.rows[0], 'url');
}

async function deleteMedia(propertyId, mediaId) {
  const result = await pool.query(
    'DELETE FROM property_media WHERE id = $1 AND property_id = $2 RETURNING id, url',
    [mediaId, propertyId]
  );
  if (result.rows.length === 0) throw notFound('Media not found for this property');
  await deleteObject(result.rows[0].url);
}

// Cover photo is mutually exclusive - clearing every other flag and setting
// this one is done inside a transaction so a listing can never briefly end
// up with zero or multiple primaries.
async function setPrimaryMedia(propertyId, mediaId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query(
      'SELECT id FROM property_media WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [mediaId, propertyId]
    );
    if (target.rows.length === 0) throw notFound('Media not found for this property');

    await client.query('UPDATE property_media SET is_primary = false WHERE property_id = $1', [propertyId]);
    const result = await client.query(
      'UPDATE property_media SET is_primary = true WHERE id = $1 RETURNING *',
      [mediaId]
    );

    await client.query('COMMIT');
    return signUrls(result.rows[0], 'url');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateAvailability(id, property, isAvailable) {
  if (!['approved', 'inactive'].includes(property.status)) {
    throw badRequest(
      'Availability can only be toggled for a property that has already been approved'
    );
  }

  const newStatus = isAvailable ? 'approved' : 'inactive';
  await pool.query('UPDATE properties SET status = $1 WHERE id = $2 RETURNING *', [newStatus, id]);
  return getPropertyById(id);
}

async function updatePricing(id, price) {
  await pool.query('UPDATE properties SET price = $1 WHERE id = $2 RETURNING *', [price, id]);
  return getPropertyById(id);
}

async function approveProperty(id, adminUser) {
  const result = await pool.query(
    `UPDATE properties
     SET status = 'approved', approved_by = $1, approved_at = now(), rejection_reason = NULL
     WHERE id = $2 RETURNING id`,
    [adminUser.id, id]
  );
  if (result.rows.length === 0) throw notFound();
  return getPropertyById(id);
}

async function rejectProperty(id, reason, adminUser) {
  const result = await pool.query(
    `UPDATE properties
     SET status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = now()
     WHERE id = $3 RETURNING id`,
    [reason, adminUser.id, id]
  );
  if (result.rows.length === 0) throw notFound();
  return getPropertyById(id);
}

// Resolves req.user.id -> the linked customers.id. A `customer`-role
// account always has one (registerUser/findOrCreateCustomerByContact
// links it at signup); staff roles (broker/admin/etc.) generally don't,
// and get a 403 rather than a confusing empty favorites list.
async function resolveCustomerId(user) {
  const customer = await customerService.getCustomerByUserId(user.id);
  if (!customer) throw forbidden('Only customer accounts can save favorites');
  return customer.id;
}

async function addFavorite(propertyId, user) {
  const customerId = await resolveCustomerId(user);
  const property = await getPropertyById(propertyId);
  if (property.status !== 'approved') {
    throw badRequest('Only approved listings can be favorited');
  }
  await pool.query(
    `INSERT INTO property_favorites (customer_id, property_id)
     VALUES ($1, $2) ON CONFLICT (customer_id, property_id) DO NOTHING`,
    [customerId, propertyId]
  );
}

async function removeFavorite(propertyId, user) {
  const customerId = await resolveCustomerId(user);
  await pool.query(
    'DELETE FROM property_favorites WHERE customer_id = $1 AND property_id = $2',
    [customerId, propertyId]
  );
}

async function listFavorites(user, page, limit) {
  const customerId = await resolveCustomerId(user);
  const offset = (page - 1) * limit;

  const countResult = await pool.query(
    'SELECT COUNT(*) FROM property_favorites WHERE customer_id = $1',
    [customerId]
  );

  const result = await pool.query(
    `${PROPERTY_SELECT}
     JOIN property_favorites f ON f.property_id = p.id
     WHERE f.customer_id = $1
     ORDER BY f.created_at DESC
     LIMIT $2 OFFSET $3`,
    [customerId, limit, offset]
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

module.exports = {
  listProperties,
  getPropertyById,
  createProperty,
  updateProperty,
  deleteProperty,
  addMedia,
  uploadMedia,
  deleteMedia,
  setPrimaryMedia,
  updateAvailability,
  updatePricing,
  approveProperty,
  rejectProperty,
  addFavorite,
  removeFavorite,
  listFavorites,
};
