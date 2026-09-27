const pool = require('../config/db');
const { notFound } = require('../utils/httpError');

// Public, read-only views over the geographic master tables. Only active
// geography is exposed publicly - a city an admin hasn't switched on yet
// (status inactive) is invisible here, which is what makes the "mark the
// city active" step of the City Addition Test meaningful.

async function listStates({ includeInactive = false } = {}) {
  const result = await pool.query(
    `SELECT s.id, s.state_code, s.state_name, s.is_union_territory, s.is_active,
            s.default_language, s.time_zone,
            (SELECT COUNT(*) FROM cities c WHERE c.state_id = s.id AND c.status IN ('active', 'coming_soon'))::int AS city_count
     FROM states s
     ${includeInactive ? '' : 'WHERE s.is_active = true'}
     ORDER BY s.state_name ASC`
  );
  return result.rows;
}

async function listCities({ stateCode, status, search } = {}) {
  const where = [];
  const params = [];

  if (status) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  } else {
    where.push(`c.status IN ('active', 'coming_soon')`);
  }
  if (stateCode) {
    params.push(String(stateCode).toUpperCase());
    where.push(`s.state_code = $${params.length}`);
  }
  if (search) {
    params.push(`${search}%`);
    where.push(`c.city_name ILIKE $${params.length}`);
  }

  const result = await pool.query(
    `SELECT c.id, c.city_name, c.slug, c.status, c.city_tier, c.match_radius_km,
            c.lat_centroid, c.lng_centroid, s.state_code, s.state_name,
            (SELECT COUNT(*) FROM localities l WHERE l.city_id = c.id AND l.is_active = true)::int AS locality_count
     FROM cities c
     JOIN states s ON s.id = c.state_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.city_tier ASC NULLS LAST, c.city_name ASC`,
    params
  );
  return result.rows;
}

async function getCityBySlug(slug) {
  const result = await pool.query(
    `SELECT c.*, s.state_code, s.state_name
     FROM cities c JOIN states s ON s.id = c.state_id
     WHERE c.slug = $1 AND c.status IN ('active', 'coming_soon')`,
    [slug]
  );
  if (!result.rows[0]) throw notFound('City not found');
  return result.rows[0];
}

async function listLocalities({ cityId, citySlug, search, limit = 200 } = {}) {
  const where = ['l.is_active = true', `c.status IN ('active', 'coming_soon')`];
  const params = [];

  if (cityId) {
    params.push(cityId);
    where.push(`l.city_id = $${params.length}`);
  }
  if (citySlug) {
    params.push(citySlug);
    where.push(`c.slug = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(l.locality_name ILIKE $${params.length} OR l.sub_locality ILIKE $${params.length} OR l.pincode ILIKE $${params.length})`);
  }

  params.push(Math.min(Number(limit) || 200, 1000));
  const result = await pool.query(
    `SELECT l.id, l.locality_name, l.sub_locality, l.pincode, l.lat_centroid, l.lng_centroid,
            l.is_premium_area, c.id AS city_id, c.city_name, c.slug AS city_slug
     FROM localities l JOIN cities c ON c.id = l.city_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.locality_name ASC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function lookupPincode(pincode) {
  const result = await pool.query(
    `SELECT p.pincode, l.id AS locality_id, l.locality_name, c.id AS city_id, c.city_name,
            c.slug AS city_slug, c.status AS city_status, s.state_code, s.state_name
     FROM pincodes p
     JOIN cities c ON c.id = p.city_id
     JOIN states s ON s.id = p.state_id
     LEFT JOIN localities l ON l.id = p.locality_id
     WHERE p.pincode = $1 AND p.is_active = true
     ORDER BY l.locality_name ASC NULLS LAST`,
    [pincode]
  );
  if (result.rows.length === 0) throw notFound('Pincode not found');
  return result.rows;
}

// Current (effective today) stamp duty rules for a state, most specific
// first: a city-level rule overrides the state-wide one.
async function getStampDutyRules({ stateCode, cityId, transactionType } = {}) {
  const params = [String(stateCode || '').toUpperCase()];
  const where = [
    's.state_code = $1',
    'r.effective_from <= CURRENT_DATE',
    '(r.effective_until IS NULL OR r.effective_until >= CURRENT_DATE)',
  ];
  if (cityId) {
    params.push(cityId);
    where.push(`(r.city_id IS NULL OR r.city_id = $${params.length})`);
  } else {
    where.push('r.city_id IS NULL');
  }
  if (transactionType) {
    params.push(transactionType);
    where.push(`r.transaction_type = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT r.id, r.transaction_type, r.buyer_gender, r.rate_percent, r.registration_fee_percent,
            r.registration_fee_cap, r.effective_from, r.effective_until, r.notes, r.city_id,
            s.state_code, s.state_name
     FROM stamp_duty_rules r JOIN states s ON s.id = r.state_id
     WHERE ${where.join(' AND ')}
     ORDER BY (r.city_id IS NULL) ASC, r.effective_from DESC`,
    params
  );
  return result.rows;
}

// Current circle rate for a locality (falls back to the city-wide rate)
// and property type (falls back to 'any'). Used by fraud scoring and the
// document template engine as well as this public endpoint.
async function getCircleRate({ cityId, localityId, propertyType }) {
  const result = await pool.query(
    `SELECT cr.*, l.locality_name, c.city_name
     FROM circle_rates cr
     JOIN cities c ON c.id = cr.city_id
     LEFT JOIN localities l ON l.id = cr.locality_id
     WHERE cr.city_id = $1
       AND (cr.locality_id = $2 OR cr.locality_id IS NULL)
       AND (cr.property_type = $3 OR cr.property_type = 'any')
       AND cr.effective_from <= CURRENT_DATE
       AND (cr.effective_until IS NULL OR cr.effective_until >= CURRENT_DATE)
     ORDER BY (cr.locality_id IS NULL) ASC, (cr.property_type = 'any') ASC, cr.effective_from DESC
     LIMIT 1`,
    [cityId, localityId || null, propertyType || 'any']
  );
  return result.rows[0] || null;
}

module.exports = {
  listStates,
  listCities,
  getCityBySlug,
  listLocalities,
  lookupPincode,
  getStampDutyRules,
  getCircleRate,
};
