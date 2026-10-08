const pool = require('../config/db');
const { signUrls, getReadUrl } = require('../utils/storage');
const disclaimerService = require('./disclaimer.service');
const opportunityService = require('./opportunity.service');
const configService = require('./config.service');

// Module 28 ranking and matching settings (app_config, admin-editable).
async function searchSettings() {
  const [weights, boost, maxSponsored, recencyDays, typo, radius, maxRadius] = await Promise.all([
    configService.getConfig('search.ranking_weights', {}), configService.getConfig('search.sponsored_boost', 60), configService.getConfig('search.sponsored_max', 3),
    configService.getConfig('search.recency_days', 60), configService.getConfig('search.typo_similarity', 0.35), configService.getConfig('search.default_radius_km', 5), configService.getConfig('search.max_radius_km', 100),
  ]);
  const w = (k) => (Number.isFinite(Number(weights?.[k])) ? Number(weights[k]) : 1);
  return {
    weights: { trust: w('trust'), verification: w('verification'), recency: w('recency'), match: w('match'), sponsored: w('sponsored'), text: w('text') },
    sponsoredBoost: Number(boost) || 60, sponsoredMax: Math.max(Number(maxSponsored) || 0, 0), recencyDays: Number(recencyDays) || 60,
    typo: Math.min(Math.max(Number(typo) || 0.35, 0.1), 0.9), radiusKm: Number(radius) || 5, maxRadiusKm: Number(maxRadius) || 100,
  };
}

// Distance in km between a listing and a point ($lat / $lng are parameter numbers).
const distanceSql = (lat, lng) =>
  `(6371 * acos(LEAST(1, GREATEST(-1, cos(radians($${lat}::float8)) * cos(radians(properties.latitude::float8)) * cos(radians(properties.longitude::float8) - radians($${lng}::float8)) + sin(radians($${lat}::float8)) * sin(radians(properties.latitude::float8))))))`;

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
  // Sec. 8.3: listers with higher trust / badges rank higher (search
  // boost from trust_scores), then verified listings, then newest.
  // Sec. 9.1: plus the verification-level boost (System +5, Seller +15,
  // Legally +25, Site +35 - verification.search_boost).
  recommended: `(COALESCE((SELECT ts.search_boost FROM trust_scores ts
                  WHERE ts.user_id = COALESCE(properties.broker_id, properties.created_by)), 0)
                 + COALESCE((SELECT (ac.value->>(properties.verification_level::text))::numeric FROM app_config ac WHERE ac.config_key = 'verification.search_boost'), 0)) DESC,
                is_verified DESC, properties.created_at DESC`,
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

function buildWhere(filters, settings = { typo: 0.35, radiusKm: 5, maxRadiusKm: 100 }) {
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
  // Free text: full-text match, a plain "contains", or - for a typing mistake -
  // a word close enough to one in the title, locality or city.
  const extra = { q: null, lat: null, lng: null };
  if (filters.q) {
    const q = String(filters.q).trim().slice(0, 120);
    params.push(q);
    extra.q = params.length;
    params.push(`%${q}%`);
    const like = params.length;
    params.push(settings.typo);
    const typo = params.length;
    where.push(`(properties.search_vector @@ websearch_to_tsquery('simple', $${extra.q})
      OR title ILIKE $${like} OR locality ILIKE $${like} OR city ILIKE $${like}
      OR word_similarity(lower($${extra.q}), lower(title)) >= $${typo}::real
      OR word_similarity(lower($${extra.q}), lower(coalesce(locality, '') || ' ' || coalesce(city, ''))) >= $${typo}::real)`);
  }
  // Geo-search: listings within a radius of a point (bounding box first so the index is used).
  if (filters.lat !== undefined && filters.lng !== undefined && filters.lat !== null && filters.lng !== null) {
    const radius = Math.min(Math.max(Number(filters.radiusKm) || settings.radiusKm, 0.1), settings.maxRadiusKm);
    params.push(Number(filters.lat));
    extra.lat = params.length;
    params.push(Number(filters.lng));
    extra.lng = params.length;
    params.push(radius);
    const r = params.length;
    where.push(`properties.latitude IS NOT NULL AND properties.longitude IS NOT NULL
      AND properties.latitude BETWEEN $${extra.lat}::numeric - ($${r}::numeric / 111.0) AND $${extra.lat}::numeric + ($${r}::numeric / 111.0)
      AND properties.longitude BETWEEN $${extra.lng}::numeric - ($${r}::numeric / (111.0 * GREATEST(cos(radians($${extra.lat}::float8)), 0.01))::numeric) AND $${extra.lng}::numeric + ($${r}::numeric / (111.0 * GREATEST(cos(radians($${extra.lat}::float8)), 0.01))::numeric)
      AND ${distanceSql(extra.lat, extra.lng)} <= $${r}::float8`);
    extra.radiusKm = radius;
  }
  if (filters.minArea) {
    params.push(filters.minArea);
    where.push(`COALESCE(area_sqft, carpet_area_sqft) >= $${params.length}`);
  }
  if (filters.maxArea) {
    params.push(filters.maxArea);
    where.push(`COALESCE(area_sqft, carpet_area_sqft) <= $${params.length}`);
  }
  // Trust score of whoever listed it (sec. 8).
  if (filters.minTrust) {
    params.push(filters.minTrust);
    where.push(`EXISTS (SELECT 1 FROM trust_scores ts WHERE ts.user_id = COALESCE(properties.broker_id, properties.created_by) AND ts.score >= $${params.length})`);
  }
  // Urgency: listings marked for a quick or time-bound sale.
  if (filters.urgency === 'urgent') {
    where.push(`(EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(properties.situation_tags, '[]'::jsonb) || COALESCE(properties.tags, '[]'::jsonb)) t WHERE t ILIKE '%urgent%' OR t ILIKE '%time-bound%' OR t ILIKE '%time bound%' OR t ILIKE '%quick sale%') OR properties.badge ILIKE '%urgent%')`);
  }
  // Deal type in the words the site uses.
  if (filters.dealType) {
    const deal = { sale: `transaction_type::text IN ('sell', 'buy')`, rent: `transaction_type::text = 'rent'`, lease: `transaction_type::text IN ('rent', 'lease')`, new_launch: `properties.badge ILIKE '%new launch%'`,
      resale: `transaction_type::text IN ('sell', 'buy') AND properties.builder_id IS NULL` }[filters.dealType];
    if (deal) where.push(`(${deal})`);
  }
  // propertyType / furnishing / possessionStatus accept one value or a
  // comma-separated list (the website's multi-select filters).
  const list = (value) =>
    String(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  if (filters.propertyType) {
    params.push(list(filters.propertyType));
    where.push(`property_type::text = ANY($${params.length}::text[])`);
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
  if (filters.maxBedrooms) {
    params.push(filters.maxBedrooms);
    where.push(`(bedrooms IS NULL OR bedrooms <= $${params.length})`);
  }
  // Listing tags set in the CRM (e.g. "PG", "Co-living") - case-insensitive.
  if (filters.tag) {
    params.push(filters.tag);
    where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t ILIKE $${params.length})`);
  }
  if (filters.furnishing) {
    params.push(list(filters.furnishing));
    where.push(`furnishing ILIKE ANY($${params.length}::text[])`);
  }
  if (filters.possessionStatus) {
    params.push(list(filters.possessionStatus));
    where.push(`possession_status ILIKE ANY($${params.length}::text[])`);
  }
  // bhk=1,2,5 -> exactly 1 or 2 bedrooms, or 5 and above (the "5+" pill).
  if (filters.bhk) {
    const counts = list(filters.bhk).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
    if (counts.length) {
      const exact = counts.filter((n) => n < 5);
      const clauses = [];
      if (exact.length) {
        params.push(exact);
        clauses.push(`bedrooms = ANY($${params.length}::int[])`);
      }
      if (counts.some((n) => n >= 5)) clauses.push('bedrooms >= 5');
      where.push(`(${clauses.join(' OR ')})`);
    }
  }
  // parking=covered,open,none - matches the CRM's parking type; "none"
  // means no parking type and no spots recorded.
  if (filters.parking) {
    const kinds = list(filters.parking).map((k) => k.toLowerCase());
    const clauses = [];
    const typed = kinds.filter((k) => k !== 'none');
    if (typed.length) {
      params.push(typed);
      clauses.push(`LOWER(parking_type) = ANY($${params.length}::text[])`);
    }
    if (kinds.includes('none')) clauses.push(`(COALESCE(parking_type, '') = '' AND COALESCE(parking_spots, 0) = 0)`);
    if (clauses.length) where.push(`(${clauses.join(' OR ')})`);
  }
  if (filters.rera) where.push(`COALESCE(rera_number, '') <> ''`);
  if (filters.verified) where.push('is_verified = true');
  // Every requested amenity must appear (case-insensitive, partial match -
  // "pool" matches "Swimming pool") since amenities are typed in the CRM.
  if (filters.amenities && filters.amenities.length > 0) {
    for (const amenity of filters.amenities) {
      params.push(`%${amenity}%`);
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(amenities) a WHERE a ILIKE $${params.length})`);
    }
  }

  return { where, params, extra };
}

// Faceted search: how many results each choice would give, for the filters in force.
async function facetsFor(whereClause, params) {
  const run = (sql) => pool.query(`${sql}`, params).then((r) => r.rows).catch(() => []);
  const [types, beds, furnishing, localities, bands, flags] = await Promise.all([
    run(`SELECT property_type::text AS value, COUNT(*)::int AS count FROM properties ${whereClause} GROUP BY 1 ORDER BY 2 DESC`),
    run(`SELECT LEAST(bedrooms, 5) AS value, COUNT(*)::int AS count FROM properties ${whereClause} AND bedrooms IS NOT NULL GROUP BY 1 ORDER BY 1`),
    run(`SELECT lower(furnishing) AS value, COUNT(*)::int AS count FROM properties ${whereClause} AND COALESCE(furnishing, '') <> '' GROUP BY 1 ORDER BY 2 DESC`),
    run(`SELECT locality AS value, COUNT(*)::int AS count FROM properties ${whereClause} AND COALESCE(locality, '') <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
    run(`SELECT CASE WHEN price_value < 2500000 THEN 'under_25l' WHEN price_value < 5000000 THEN '25l_50l' WHEN price_value < 10000000 THEN '50l_1cr' WHEN price_value < 20000000 THEN '1cr_2cr' WHEN price_value < 50000000 THEN '2cr_5cr' ELSE 'above_5cr' END AS value,
                MIN(price_value) AS lo, COUNT(*)::int AS count FROM properties ${whereClause} AND price_value IS NOT NULL GROUP BY 1 ORDER BY 2`),
    run(`SELECT COUNT(*) FILTER (WHERE is_verified)::int AS verified, COUNT(*) FILTER (WHERE COALESCE(rera_number, '') <> '')::int AS rera FROM properties ${whereClause}`),
  ]);
  return {
    propertyType: types, bedrooms: beds.map((b) => ({ value: Number(b.value), label: Number(b.value) >= 5 ? '5+' : String(b.value), count: b.count })), furnishing, locality: localities,
    priceBand: bands.map((b) => ({ value: b.value, count: b.count })), verified: flags[0]?.verified || 0, rera: flags[0]?.rera || 0,
  };
}

// "Did you mean": the nearest known city / locality / project to what was typed.
async function didYouMean(q, typo) {
  const r = await pool.query(
    `SELECT term, kind, city, similarity(lower(term), lower($1)) AS sim FROM search_terms WHERE lower(term) % lower($1) OR word_similarity(lower($1), lower(term)) >= $2::real
     ORDER BY GREATEST(similarity(lower(term), lower($1)), word_similarity(lower($1), lower(term))) DESC, listings DESC LIMIT 1`,
    [q, Math.max(typo - 0.1, 0.2)]
  ).catch(() => ({ rows: [] }));
  const hit = r.rows[0];
  return hit && hit.term.toLowerCase() !== String(q).toLowerCase() ? { term: hit.term, kind: hit.kind, city: hit.city || null } : null;
}

async function searchProperties(filters, page, limit, sort, { userId = null, viewerKey = null, facets = false } = {}) {
  const settings = await searchSettings();
  const { where, params, extra } = buildWhere(filters, settings);
  const whereClause = `WHERE ${where.join(' AND ')}`;
  const offset = (page - 1) * limit;
  const W = settings.weights;
  const geo = extra.lat !== null;
  // Sponsored boost: a live, approved Sponsored / Featured campaign on this listing (for the city searched, if it targets cities).
  params.push(filters.city || null);
  const cityParam = params.length;
  const sponsoredSql = `(SELECT c.id FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id
      WHERE c.property_id = properties.id AND c.status = 'approved' AND a.status = 'active' AND CURRENT_DATE BETWEEN c.start_date AND c.end_date AND c.placements ?| ARRAY['search_sponsored', 'featured_listing']
        AND (jsonb_array_length(COALESCE(c.targeting->'cities', '[]'::jsonb)) = 0 OR ($${cityParam}::varchar IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.targeting->'cities') tc WHERE lower(tc) = lower($${cityParam}))))
      ORDER BY (c.placements ? 'featured_listing') DESC LIMIT 1)`;
  // Match score: how well it fits the signed-in buyer's own active requirements (sec. 7).
  params.push(userId);
  const userParam = params.length;
  const matchSql = `(SELECT MAX(m.score) FROM requirement_matches m JOIN requirements r ON r.id = m.requirement_id JOIN customers cu ON cu.id = r.customer_id
      WHERE m.property_id = properties.id AND r.status = 'active' AND cu.user_id = $${userParam}::uuid)`;
  const textSql = extra.q ? `(ts_rank(properties.search_vector, websearch_to_tsquery('simple', $${extra.q})) * 40 + GREATEST(word_similarity(lower($${extra.q}), lower(title)), word_similarity(lower($${extra.q}), lower(coalesce(locality, '') || ' ' || coalesce(city, '')))) * 20)` : '0';
  // Sec. 21.1 ranking: trust score + verification level + recency + match score + sponsored boost (+ text relevance when searching by words).
  const scoreSql = `(
      ${W.trust} * COALESCE((SELECT ts.search_boost FROM trust_scores ts WHERE ts.user_id = COALESCE(properties.broker_id, properties.created_by)), 0)
    + ${W.verification} * (COALESCE((SELECT (ac.value->>(properties.verification_level::text))::numeric FROM app_config ac WHERE ac.config_key = 'verification.search_boost'), 0) + CASE WHEN is_verified THEN 5 ELSE 0 END)
    + ${W.recency} * GREATEST(0, 20 * (1 - EXTRACT(EPOCH FROM (now() - properties.created_at)) / (86400.0 * ${settings.recencyDays})))
    + ${W.match} * COALESCE(${matchSql}, 0) / 4.0
    + ${W.text} * ${textSql})`;
  const sorts = {
    ...SORT_OPTIONS,
    recommended: `(sponsored_campaign IS NOT NULL) DESC, rank_score DESC, properties.created_at DESC`,
    relevance: `(sponsored_campaign IS NOT NULL) DESC, rank_score DESC, properties.created_at DESC`,
    distance: geo ? 'distance_km ASC NULLS LAST' : 'properties.created_at DESC',
  };
  const orderClause = sorts[sort] || (geo && !sort ? sorts.distance : sorts.recommended);

  // (The WHERE clause uses only the filter parameters, which come first.)
  const countResult = await pool.query(`SELECT COUNT(*) FROM properties ${whereClause}`, params.slice(0, cityParam - 1));
  const pagination = {
    page,
    limit,
    total: Number(countResult.rows[0].count),
    totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
  };

  if (RESTRICTED_CATEGORIES.includes(filters.listingCategory)) {
    // Masked teasers: the plain filters and sort only (no sponsored or match ranking on confidential stock).
    const teaserParams = [...params.slice(0, cityParam - 1), limit, offset];
    const teaserOrder = geo && (!sort || sort === 'distance') ? `${distanceSql(extra.lat, extra.lng)} ASC` : SORT_OPTIONS[sort] || SORT_OPTIONS.recommended;
    const result = await pool.query(
      // TEASER_COLUMNS is written against alias `p`; this query uses the
      // unaliased table name because buildWhere's clauses do.
      `SELECT ${opportunityService.TEASER_COLUMNS.replace(/\bp\./g, 'properties.')}
       FROM properties ${whereClause}
       ORDER BY ${teaserOrder}
       LIMIT $${teaserParams.length - 1} OFFSET $${teaserParams.length}`,
      teaserParams
    );
    const items = await signUrls(result.rows.map(opportunityService.toTeaser), 'primary_image');
    const disclaimers = await disclaimerService.getDisclaimers(['all_listings', filters.listingCategory]);
    return { items, pagination, disclaimers };
  }

  params.push(limit, offset);

  const result = await pool.query(
    `SELECT * FROM (
     SELECT properties.id, title, description, property_type, transaction_type, price, price_value, rate,
            listing_category, city, locality, latitude, longitude, area_sqft, carpet_area_sqft,
            bedrooms, bathrooms, amenities, furnishing, possession_status, facing, floor_number, total_floors,
            is_verified, badge, tags, rera_number, liquidity_band, properties.created_at,
            verification_level, under_review,
            builder.full_name AS builder_name,
            (SELECT url FROM property_media pm WHERE pm.property_id = properties.id
             ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS primary_image,
            (SELECT COALESCE(json_agg(pm.url ORDER BY pm.is_primary DESC, pm.display_order ASC), '[]'::json)
             FROM property_media pm WHERE pm.property_id = properties.id) AS images,
            -- Lister trust (no identity): score + live badge keys for the card.
            (SELECT json_build_object('score', ts.score,
                    'badges', (SELECT COALESCE(json_agg(ub.badge_key), '[]'::json) FROM user_badges ub
                               WHERE ub.user_id = ts.user_id AND ub.status <> 'revoked'))
             FROM trust_scores ts WHERE ts.user_id = COALESCE(properties.broker_id, properties.created_by)) AS lister_trust,
            ${scoreSql} AS rank_score,
            ${matchSql} AS match_score,
            ${geo ? `round((${distanceSql(extra.lat, extra.lng)})::numeric, 2)` : 'NULL::numeric'} AS distance_km,
            ${sponsoredSql} AS sponsored_campaign
     FROM properties
     LEFT JOIN users builder ON builder.id = properties.builder_id
     ${whereClause}
     ) ranked
     ORDER BY ${orderClause.replace(/properties\./g, '')}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // Only the first few sponsored listings are shown as such on a page; the label is always shown (sec. F.3).
  let shown = 0;
  const ads = require('./advertising.service');
  const rows = [];
  for (const row of result.rows) {
    const { sponsored_campaign: campaign, rank_score: rank, match_score: match, distance_km: distance, ...rest } = row;
    const item = { ...rest, rank_score: Math.round(Number(rank) * 10) / 10, match_score: match === null ? null : Number(match), distance_km: distance === null ? null : Number(distance), sponsored: null };
    if (campaign && shown < settings.sponsoredMax) {
      shown += 1;
      const label = await ads.sponsoredLabel(campaign, { viewerKey, userId, city: filters.city || null }).catch(() => null);
      if (label) item.sponsored = label;
    }
    rows.push(item);
  }

  const signed = await signImageArrays(await signUrls(rows.map(publicCoordinates), 'primary_image'), 'images');
  const disclaimers = await disclaimerService.getDisclaimers(['all_listings']);
  const facetParams = params.slice(0, cityParam - 1);
  const out = { items: signed, pagination, disclaimers, search: { sort: sort || (geo ? 'distance' : 'recommended'), radiusKm: extra.radiusKm || null } };
  if (facets) out.facets = await facetsFor(whereClause, facetParams);
  if (extra.q && pagination.total === 0) out.didYouMean = await didYouMean(filters.q, settings.typo);
  return out;
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
            p.about_extended, p.facing, p.tags, p.badge, p.is_verified, p.rera_number, p.verification_level, p.under_review,
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

  // Typo-tolerant matches from the search dictionary ("gurgoan" -> Gurgaon, "dwraka" -> Dwarka), and project names.
  const fuzzy = await pool
    .query(
      `SELECT term AS value, kind AS type, NULLIF(city, '') AS city FROM search_terms
       WHERE lower(term) LIKE lower($1) || '%' OR lower(term) % lower($1) OR word_similarity(lower($1), lower(term)) >= $2::real
       ORDER BY (lower(term) LIKE lower($1) || '%') DESC, GREATEST(similarity(lower(term), lower($1)), word_similarity(lower($1), lower(term))) DESC, listings DESC LIMIT 10`,
      [term, (await searchSettings()).typo]
    )
    .catch(() => ({ rows: [] }));

  const seen = new Set();
  const merged = [];
  for (const row of [...masterCities.rows, ...masterLocalities.rows, ...cities.rows, ...localities.rows, ...fuzzy.rows]) {
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

// Rebuild the search dictionary from the geography master and live listings.
async function refreshSearchTerms() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM search_terms');
    await client.query(
      `INSERT INTO search_terms (term, kind, city, listings)
       SELECT term, kind, city, SUM(n)::int FROM (
         SELECT c.city_name AS term, 'city' AS kind, '' AS city, 0 AS n FROM cities c WHERE c.status IN ('active', 'coming_soon')
         UNION ALL SELECT l.locality_name, 'locality', c.city_name, 0 FROM localities l JOIN cities c ON c.id = l.city_id WHERE l.is_active AND c.status IN ('active', 'coming_soon')
         UNION ALL SELECT p.city, 'city', '', COUNT(*) FROM properties p WHERE p.status = 'approved' AND COALESCE(p.city, '') <> '' GROUP BY 1
         UNION ALL SELECT p.locality, 'locality', COALESCE(p.city, ''), COUNT(*) FROM properties p WHERE p.status = 'approved' AND COALESCE(p.locality, '') <> '' GROUP BY 1, 3
         UNION ALL SELECT left(p.title, 200), 'project', COALESCE(p.city, ''), 1 FROM properties p WHERE p.status = 'approved' AND p.listing_category::text = 'residential' AND length(p.title) BETWEEN 4 AND 200
       ) t WHERE btrim(term) <> '' GROUP BY term, kind, city
       ON CONFLICT DO NOTHING`
    );
    await client.query('COMMIT');
    return (await pool.query('SELECT COUNT(*)::int AS n FROM search_terms')).rows[0].n;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let termsTimer = null;
function startScheduler() {
  if (termsTimer) return;
  refreshSearchTerms().catch((err) => console.error('[search] dictionary refresh failed:', err.message));
  termsTimer = setInterval(() => refreshSearchTerms().catch((err) => console.error('[search] dictionary refresh failed:', err.message)), 30 * 60 * 1000);
}

module.exports = { searchProperties, getFilterOptions, getSuggestions, getPublicPropertyById, getHomeData, refreshSearchTerms, startScheduler, buildWhere, searchSettings };
