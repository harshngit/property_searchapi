const pool = require('../config/db');

const SORT_OPTIONS = {
  price_asc: 'price ASC',
  price_desc: 'price DESC',
  newest: 'created_at DESC',
};

async function searchProperties(filters, page, limit, sort) {
  const where = [`status = 'approved'`];
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
  if (filters.minPrice) {
    params.push(filters.minPrice);
    where.push(`price >= $${params.length}`);
  }
  if (filters.maxPrice) {
    params.push(filters.maxPrice);
    where.push(`price <= $${params.length}`);
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
    `SELECT id, title, description, property_type, transaction_type, price,
            city, locality, address, latitude, longitude, area_sqft,
            bedrooms, bathrooms, amenities, created_at
     FROM properties
     ${whereClause}
     ORDER BY ${orderClause}
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

async function getFilterOptions() {
  const [cities, propertyTypes, transactionTypes, priceRange] = await Promise.all([
    pool.query(
      `SELECT DISTINCT city FROM properties WHERE status = 'approved' ORDER BY city ASC`
    ),
    pool.query(`SELECT unnest(enum_range(NULL::property_type)) AS value`),
    pool.query(`SELECT unnest(enum_range(NULL::transaction_type)) AS value`),
    pool.query(
      `SELECT MIN(price) AS min_price, MAX(price) AS max_price FROM properties WHERE status = 'approved'`
    ),
  ]);

  return {
    cities: cities.rows.map((r) => r.city),
    propertyTypes: propertyTypes.rows.map((r) => r.value),
    transactionTypes: transactionTypes.rows.map((r) => r.value),
    priceRange: {
      min: priceRange.rows[0].min_price !== null ? Number(priceRange.rows[0].min_price) : null,
      max: priceRange.rows[0].max_price !== null ? Number(priceRange.rows[0].max_price) : null,
    },
  };
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

module.exports = { searchProperties, getFilterOptions, getSuggestions };
