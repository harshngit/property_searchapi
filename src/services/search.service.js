const pool = require('../config/db');
const { signUrls, getReadUrl } = require('../utils/storage');

function notFound(message = 'Property not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

const SORT_OPTIONS = {
  rate_asc: 'rate ASC NULLS LAST',
  rate_desc: 'rate DESC NULLS LAST',
  newest: 'properties.created_at DESC',
};

// `images` comes back as a plain array of stored object paths (one row's
// json_agg, not per-item objects like the dashboard's media aggregate) -
// signUrls only signs a single flat field per row, so each url in the array
// needs its own getReadUrl() call.
async function signImageArrays(rows, field) {
  return Promise.all(
    rows.map(async (row) => ({ ...row, [field]: await Promise.all((row[field] || []).map((url) => getReadUrl(url))) }))
  );
}

async function searchProperties(filters, page, limit, sort) {
  // Qualified with the table name (harmless when unjoined, e.g. in the
  // COUNT query below) since the results SELECT joins `users` for
  // builder_name, and `users` also has its own status/created_at columns -
  // an unqualified reference would be ambiguous once that join is present.
  const where = [`properties.status = 'approved'`];
  const params = [];

  if (filters.city) {
    params.push(filters.city);
    where.push(`city ILIKE $${params.length}`);
  }
  if (filters.locality) {
    params.push(filters.locality);
    where.push(`locality ILIKE $${params.length}`);
  }
  if (filters.propertyType) {
    params.push(filters.propertyType);
    where.push(`property_type = $${params.length}`);
  }
  if (filters.transactionType) {
    params.push(filters.transactionType);
    where.push(`transaction_type = $${params.length}`);
  }
  if (filters.minRate) {
    params.push(filters.minRate);
    where.push(`rate >= $${params.length}`);
  }
  if (filters.maxRate) {
    params.push(filters.maxRate);
    where.push(`rate <= $${params.length}`);
  }
  if (filters.amenities && filters.amenities.length > 0) {
    params.push(JSON.stringify(filters.amenities));
    where.push(`amenities @> $${params.length}::jsonb`);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const orderClause = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM properties ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT properties.id, title, description, property_type, transaction_type, price, rate,
            listing_category, city, locality, address, latitude, longitude, area_sqft,
            bedrooms, bathrooms, amenities, properties.created_at,
            builder.full_name AS builder_name,
            (SELECT url FROM property_media pm WHERE pm.property_id = properties.id
             ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS primary_image,
            (SELECT COALESCE(json_agg(pm.url ORDER BY pm.is_primary DESC, pm.display_order ASC), '[]'::json)
             FROM property_media pm WHERE pm.property_id = properties.id) AS images
     FROM properties
     LEFT JOIN users builder ON builder.id = properties.builder_id
     ${whereClause}
     ORDER BY ${orderClause}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const signed = await signImageArrays(await signUrls(result.rows, 'primary_image'), 'images');

  return {
    items: signed,
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

async function getFilterOptions() {
  const [cities, propertyTypes, transactionTypes, rateRange] = await Promise.all([
    pool.query(
      `SELECT DISTINCT city FROM properties WHERE status = 'approved' ORDER BY city ASC`
    ),
    pool.query(`SELECT unnest(enum_range(NULL::property_type)) AS value`),
    pool.query(`SELECT unnest(enum_range(NULL::transaction_type)) AS value`),
    pool.query(
      `SELECT MIN(rate) AS min_rate, MAX(rate) AS max_rate FROM properties WHERE status = 'approved'`
    ),
  ]);

  return {
    cities: cities.rows.map((r) => r.city),
    propertyTypes: propertyTypes.rows.map((r) => r.value),
    transactionTypes: transactionTypes.rows.map((r) => r.value),
    rateRange: {
      min: rateRange.rows[0].min_rate !== null ? Number(rateRange.rows[0].min_rate) : null,
      max: rateRange.rows[0].max_rate !== null ? Number(rateRange.rows[0].max_rate) : null,
    },
  };
}

// Public, unauthenticated single-property lookup for the customer-facing
// website's detail page. Only ever returns `approved` listings, and never
// exposes internal-only fields (tenant_id, created_by, approved_by,
// rejection_reason) that the staff-facing PROPERTY_SELECT in
// property.service.js includes.
async function getPublicPropertyById(id) {
  const result = await pool.query(
    `SELECT p.id, p.title, p.description, p.property_type, p.transaction_type, p.price, p.rate,
            p.listing_category, p.city, p.locality, p.address, p.latitude, p.longitude,
            p.area_sqft, p.bedrooms, p.bathrooms, p.amenities,
            p.annual_appreciation_percent, p.estimated_rent_monthly, p.locality_rating,
            p.auction_date, p.source_bank, p.occupancy_percent, p.yield_percent, p.yield_qualifier,
            p.created_at,
            builder.full_name AS builder_name
     FROM properties p
     LEFT JOIN users builder ON builder.id = p.builder_id
     WHERE p.id = $1 AND p.status = 'approved'`,
    [id]
  );
  const property = result.rows[0];
  if (!property) throw notFound();

  const media = await pool.query(
    'SELECT id, media_type, url, display_order, is_primary FROM property_media WHERE property_id = $1 ORDER BY display_order ASC, created_at ASC',
    [id]
  );

  return { ...property, media: await signUrls(media.rows, 'url') };
}

async function getSuggestions(term) {
  const likeTerm = `${term}%`;

  const [cities, localities] = await Promise.all([
    pool.query(
      `SELECT DISTINCT city AS value, 'city' AS type FROM properties
       WHERE status = 'approved' AND city ILIKE $1 LIMIT 10`,
      [likeTerm]
    ),
    pool.query(
      `SELECT DISTINCT locality AS value, 'locality' AS type FROM properties
       WHERE status = 'approved' AND locality ILIKE $1 LIMIT 10`,
      [likeTerm]
    ),
  ]);

  return [...cities.rows, ...localities.rows].slice(0, 10);
}

module.exports = { searchProperties, getFilterOptions, getSuggestions, getPublicPropertyById };
