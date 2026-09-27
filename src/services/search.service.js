const pool = require('../config/db');
const { signUrls, getReadUrl } = require('../utils/storage');
const disclaimerService = require('./disclaimer.service');
const opportunityService = require('./opportunity.service');

function notFound(message = 'Property not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

// Auction / special-situation deals are restricted (Engine 4 access
// control) and institutional names are confidential by default (sec.
// 11.3). They are left out of the default residential search, and when a
// caller asks for them explicitly they come back as masked teasers.
const RESTRICTED_CATEGORIES = ['auction', 'special_situation', 'institutional'];

// A listing someone is selling shows under the website's Buy menu; legacy
// rows saved as 'buy' are treated the same way.
const PURPOSE_TRANSACTION_TYPES = { buy: ['sell', 'buy'], rent: ['rent'] };

const SORT_OPTIONS = {
  rate_asc: 'rate ASC NULLS LAST',
  rate_desc: 'rate DESC NULLS LAST',
  price_asc: 'price_value ASC NULLS LAST',
  price_desc: 'price_value DESC NULLS LAST',
  newest: 'properties.created_at DESC',
  verified: 'is_verified DESC, properties.created_at DESC',
};

// Public coordinates are rounded to ~100 m: enough to place the listing in
// its locality on a map without revealing the exact address, which the
// Controlled Contact Architecture keeps private (sec. 11.2 "only Area and
// Locality shown publicly").
function approximateCoordinate(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 1000) / 1000;
}

function publicCoordinates(row) {
  return { ...row, latitude: approximateCoordinate(row.latitude), longitude: approximateCoordinate(row.longitude) };
}

// `images` comes back as a plain array of stored object paths (one row's
// json_agg, not per-item objects like the dashboard's media aggregate) -
// signUrls only signs a single flat field per row, so each url in the array
// needs its own getReadUrl() call.
async function signImageArrays(rows, field) {
  return Promise.all(
    rows.map(async (row) => ({ ...row, [field]: await Promise.all((row[field] || []).map((url) => getReadUrl(url))) }))
  );
}

function buildWhere(filters) {
  // Qualified with the table name (harmless when unjoined, e.g. in the
  // COUNT query below) since the results SELECT joins `users` for
  // builder_name, and `users` also has its own status/created_at columns -
  // an unqualified reference would be ambiguous once that join is present.
  const where = [`properties.status = 'approved'`];
  const params = [];

  if (filters.listingCategory) {
    params.push(filters.listingCategory);
    where.push(`listing_category = $${params.length}`);
  } else {
    params.push(RESTRICTED_CATEGORIES);
    where.push(`listing_category::text <> ALL($${params.length}::text[])`);
  }
  if (filters.city) {
    params.push(filters.city);
    where.push(`city ILIKE $${params.length}`);
  }
  if (filters.locality) {
    params.push(filters.locality);
    where.push(`locality ILIKE $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(title ILIKE $${params.length} OR locality ILIKE $${params.length} OR city ILIKE $${params.length})`);
  }
  if (filters.propertyType) {
    params.push(filters.propertyType);
    where.push(`property_type = $${params.length}`);
  }
  if (filters.transactionType) {
    params.push(filters.transactionType);
    where.push(`transaction_type = $${params.length}`);
  }
  // Website menu terms: "buy" = listings for sale, "rent" = listings to let.
  if (filters.purpose) {
    params.push(PURPOSE_TRANSACTION_TYPES[filters.purpose]);
    where.push(`transaction_type::text = ANY($${params.length}::text[])`);
  }
  if (filters.minRate) {
    params.push(filters.minRate);
    where.push(`rate >= $${params.length}`);
  }
  if (filters.maxRate) {
    params.push(filters.maxRate);
    where.push(`rate <= $${params.length}`);
  }
  if (filters.minPrice) {
    params.push(filters.minPrice);
    where.push(`price_value >= $${params.length}`);
  }
  if (filters.maxPrice) {
    params.push(filters.maxPrice);
    where.push(`price_value <= $${params.length}`);
  }
  if (filters.bedrooms) {
    params.push(filters.bedrooms);
    where.push(`bedrooms >= $${params.length}`);
  }
  if (filters.furnishing) {
    params.push(filters.furnishing);
    where.push(`furnishing ILIKE $${params.length}`);
  }
  if (filters.possessionStatus) {
    params.push(filters.possessionStatus);
    where.push(`possession_status ILIKE $${params.length}`);
  }
  if (filters.verified) where.push('is_verified = true');
  if (filters.amenities && filters.amenities.length > 0) {
    params.push(JSON.stringify(filters.amenities));
    where.push(`amenities @> $${params.length}::jsonb`);
  }

  return { where, params };
}

async function searchProperties(filters, page, limit, sort) {
  const { where, params } = buildWhere(filters);
  const whereClause = `WHERE ${where.join(' AND ')}`;
  const orderClause = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM properties ${whereClause}`, params);
  const pagination = {
    page,
    limit,
    total: Number(countResult.rows[0].count),
    totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
  };

  params.push(limit, offset);

  if (RESTRICTED_CATEGORIES.includes(filters.listingCategory)) {
    const result = await pool.query(
      // TEASER_COLUMNS is written against alias `p`; this query uses the
      // unaliased table name because buildWhere's clauses do.
      `SELECT ${opportunityService.TEASER_COLUMNS.replace(/\bp\./g, 'properties.')}
       FROM properties ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const items = await signUrls(result.rows.map(opportunityService.toTeaser), 'primary_image');
    const disclaimers = await disclaimerService.getDisclaimers(['all_listings', filters.listingCategory]);
    return { items, pagination, disclaimers };
  }

  const result = await pool.query(
    `SELECT properties.id, title, description, property_type, transaction_type, price, price_value, rate,
            listing_category, city, locality, latitude, longitude, area_sqft, carpet_area_sqft,
            bedrooms, bathrooms, amenities, furnishing, possession_status, facing, floor_number, total_floors,
            is_verified, badge, tags, rera_number, liquidity_band, properties.created_at,
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

  const signed = await signImageArrays(await signUrls(result.rows.map(publicCoordinates), 'primary_image'), 'images');
  const disclaimers = await disclaimerService.getDisclaimers(['all_listings']);

  return { items: signed, pagination, disclaimers };
}

async function getFilterOptions() {
  const [cities, propertyTypes, transactionTypes, rateRange, priceRange, categories] = await Promise.all([
    pool.query(
      `SELECT DISTINCT city FROM properties WHERE status = 'approved' ORDER BY city ASC`
    ),
    pool.query(`SELECT unnest(enum_range(NULL::property_type)) AS value`),
    pool.query(`SELECT unnest(enum_range(NULL::transaction_type)) AS value`),
    pool.query(
      `SELECT MIN(rate) AS min_rate, MAX(rate) AS max_rate FROM properties WHERE status = 'approved'`
    ),
    pool.query(
      `SELECT MIN(price_value) AS min_price, MAX(price_value) AS max_price FROM properties
       WHERE status = 'approved' AND listing_category = 'residential'`
    ),
    pool.query(
      `SELECT listing_category AS value, COUNT(*)::int AS count FROM properties
       WHERE status = 'approved' GROUP BY listing_category ORDER BY listing_category`
    ),
  ]);

  return {
    cities: cities.rows.map((r) => r.city),
    propertyTypes: propertyTypes.rows.map((r) => r.value),
    transactionTypes: transactionTypes.rows.map((r) => r.value),
    listingCategories: categories.rows,
    rateRange: {
      min: rateRange.rows[0].min_rate !== null ? Number(rateRange.rows[0].min_rate) : null,
      max: rateRange.rows[0].max_rate !== null ? Number(rateRange.rows[0].max_rate) : null,
    },
    priceRange: {
      min: priceRange.rows[0].min_price !== null ? Number(priceRange.rows[0].min_price) : null,
      max: priceRange.rows[0].max_price !== null ? Number(priceRange.rows[0].max_price) : null,
    },
  };
}

// Public, unauthenticated single-property lookup for the customer-facing
// website's detail page. Only ever returns `approved` listings, and never
// exposes internal-only fields (tenant_id, created_by, approved_by,
// rejection_reason) or the private full address that the staff-facing
// PROPERTY_SELECT in property.service.js includes. Restricted categories
// (auction / special situation / institutional) come back as a teaser -
// their full detail lives behind GET /opportunities/:id.
async function getPublicPropertyById(id) {
  const result = await pool.query(
    `SELECT p.id, p.title, p.description, p.property_type, p.transaction_type, p.price, p.price_value, p.rate,
            p.listing_category, p.city, p.locality, p.latitude, p.longitude,
            p.area_sqft, p.carpet_area_sqft, p.bedrooms, p.bathrooms, p.amenities,
            p.annual_appreciation_percent, p.estimated_rent_monthly, p.locality_rating,
            p.about_extended, p.facing, p.tags, p.badge, p.is_verified, p.rera_number,
            p.possession_status, p.floor_number, p.total_floors, p.furnishing, p.parking_spots,
            p.parking_type, p.age_of_property, p.gated_community, p.faqs,
            p.liquidity_score, p.liquidity_band, p.created_at,
            builder.full_name AS builder_name,
            builder.builder_rating AS builder_rating,
            builder.builder_experience_years AS builder_experience_years,
            builder.builder_projects_count AS builder_projects_count
     FROM properties p
     LEFT JOIN users builder ON builder.id = p.builder_id
     WHERE p.id = $1 AND p.status = 'approved'`,
    [id]
  );
  const property = result.rows[0];
  if (!property) throw notFound();

  if (RESTRICTED_CATEGORIES.includes(property.listing_category)) {
    const teaser = await pool.query(`SELECT ${opportunityService.TEASER_COLUMNS} FROM properties p WHERE p.id = $1`, [id]);
    const disclaimers = await disclaimerService.getDisclaimers(['all_listings', property.listing_category]);
    return { ...(await signUrls(opportunityService.toTeaser(teaser.rows[0]), 'primary_image')), disclaimers };
  }

  const [media, disclaimers] = await Promise.all([
    pool.query(
      'SELECT id, media_type, url, display_order, is_primary FROM property_media WHERE property_id = $1 ORDER BY display_order ASC, created_at ASC',
      [id]
    ),
    disclaimerService.getDisclaimers(['all_listings']),
  ]);

  return { ...publicCoordinates(property), media: await signUrls(media.rows, 'url'), disclaimers };
}

async function getSuggestions(term) {
  const likeTerm = `${term}%`;

  // Live geography first (admin-managed master data), then anything that
  // only exists on listings so far.
  const [masterCities, masterLocalities, cities, localities] = await Promise.all([
    pool.query(
      `SELECT city_name AS value, 'city' AS type, slug FROM cities
       WHERE status IN ('active', 'coming_soon') AND city_name ILIKE $1 LIMIT 10`,
      [likeTerm]
    ),
    pool.query(
      `SELECT l.locality_name AS value, 'locality' AS type, c.city_name AS city FROM localities l
       JOIN cities c ON c.id = l.city_id
       WHERE l.is_active = true AND c.status IN ('active', 'coming_soon') AND l.locality_name ILIKE $1 LIMIT 10`,
      [likeTerm]
    ),
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

  const seen = new Set();
  const merged = [];
  for (const row of [...masterCities.rows, ...masterLocalities.rows, ...cities.rows, ...localities.rows]) {
    const key = `${row.type}:${String(row.value).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged.slice(0, 10);
}

// Website home page feed: headline counts, verified + latest residential
// listings, opportunity teasers, top cities, featured articles - one call.
async function getHomeData() {
  const residential = `properties.status = 'approved' AND listing_category = 'residential'`;
  const listingColumns = `properties.id, title, property_type, transaction_type, price, price_value, rate, city, locality,
    area_sqft, bedrooms, bathrooms, is_verified, badge, tags, properties.created_at,
    (SELECT url FROM property_media pm WHERE pm.property_id = properties.id
     ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS primary_image`;

  const [stats, verified, latest, topCities, opportunities, articles] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE listing_category = 'residential')::int AS residential_listings,
              COUNT(*) FILTER (WHERE is_verified)::int AS verified_listings,
              COUNT(*) FILTER (WHERE listing_category = 'auction')::int AS auction_deals,
              COUNT(*) FILTER (WHERE listing_category = 'special_situation')::int AS special_situation_deals,
              COUNT(*) FILTER (WHERE listing_category = 'institutional')::int AS institutional_deals,
              COUNT(DISTINCT LOWER(city))::int AS cities
       FROM properties WHERE status = 'approved'`
    ),
    pool.query(`SELECT ${listingColumns} FROM properties WHERE ${residential} AND is_verified = true ORDER BY properties.created_at DESC LIMIT 8`),
    pool.query(`SELECT ${listingColumns} FROM properties WHERE ${residential} ORDER BY properties.created_at DESC LIMIT 8`),
    pool.query(
      `SELECT city, COUNT(*)::int AS listings, ROUND(AVG(rate))::int AS avg_rate_per_sqft
       FROM properties WHERE ${residential} GROUP BY city ORDER BY listings DESC LIMIT 8`
    ),
    opportunityService.listPublicTeasers({ limit: 4, sort: 'score', listingCategory: 'auction' }, null),
    pool.query(
      `SELECT slug, title, excerpt, cover_image_url, category, reading_minutes, published_at
       FROM cms_articles WHERE status = 'published' AND published_at <= now()
       ORDER BY is_featured DESC, published_at DESC LIMIT 3`
    ),
  ]);

  return {
    stats: stats.rows[0],
    verifiedListings: await signUrls(verified.rows, 'primary_image'),
    latestListings: await signUrls(latest.rows, 'primary_image'),
    topCities: topCities.rows,
    auctionHighlights: opportunities.items,
    articles: articles.rows,
    disclaimers: await disclaimerService.getDisclaimers(['all_listings']),
  };
}

module.exports = { searchProperties, getFilterOptions, getSuggestions, getPublicPropertyById, getHomeData };
