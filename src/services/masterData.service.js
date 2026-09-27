const pool = require('../config/db');
const auditService = require('./audit.service');
const { assertCleanContent } = require('../utils/contentGuard');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { badRequest, notFound, unprocessable } = require('../utils/httpError');

// Registry-driven CRUD + CSV import for every admin-managed master table
// (Annexure A sec. 22 - geography and compliance data are *data*, edited in
// the admin panel, never code). Each entity declares its columns once;
// create/update/list/import all run from that declaration, so adding a new
// master table is one registry entry, and every write is audit-logged the
// same way.
//
// Field types: string | text | uuid | boolean | int | numeric | date | json
// `ref` on a uuid field lets CSV rows (and API callers) reference a parent by
// a human key (state code, city slug/name) instead of a UUID.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE_REF = { table: 'states', by: ['state_code', 'state_name'], aliases: ['stateCode', 'state', 'stateName'] };
const CITY_REF = { table: 'cities', by: ['slug', 'city_name'], aliases: ['citySlug', 'city', 'cityName'] };
const LOCALITY_REF = {
  table: 'localities',
  by: ['locality_name'],
  aliases: ['locality', 'localityName'],
  scope: { column: 'city_id', field: 'cityId' },
};

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function deriveFromCity(data, client) {
  if (data.cityId && !data.stateId) {
    const r = await client.query('SELECT state_id FROM cities WHERE id = $1', [data.cityId]);
    if (r.rows[0]) data.stateId = r.rows[0].state_id;
  }
}

const ENTITIES = {
  countries: {
    table: 'countries',
    fields: {
      countryCode: { col: 'country_code', type: 'string', upper: true },
      countryName: { col: 'country_name', type: 'string' },
      currencyCode: { col: 'currency_code', type: 'string', upper: true },
      isActive: { col: 'is_active', type: 'boolean' },
    },
    required: ['countryCode', 'countryName'],
    conflict: ['country_code'],
    search: ['country_name', 'country_code'],
    filters: { isActive: 'is_active' },
    orderBy: 'country_name ASC',
  },
  states: {
    table: 'states',
    fields: {
      countryId: { col: 'country_id', type: 'uuid', ref: { table: 'countries', by: ['country_code'], aliases: ['countryCode', 'country'] } },
      stateCode: { col: 'state_code', type: 'string', upper: true },
      stateName: { col: 'state_name', type: 'string' },
      isUnionTerritory: { col: 'is_union_territory', type: 'boolean' },
      isActive: { col: 'is_active', type: 'boolean' },
      reraPortalUrl: { col: 'rera_portal_url', type: 'string' },
      defaultLanguage: { col: 'default_language', type: 'string' },
      timeZone: { col: 'time_zone', type: 'string' },
      capitalCity: { col: 'capital_city', type: 'string' },
    },
    required: ['stateCode', 'stateName'],
    conflict: ['state_code'],
    search: ['state_name', 'state_code'],
    filters: { isActive: 'is_active', countryId: 'country_id' },
    orderBy: 'state_name ASC',
    async derive(data, client) {
      if (!data.countryId) {
        const r = await client.query(`SELECT id FROM countries WHERE country_code = 'IN'`);
        data.countryId = r.rows[0]?.id;
      }
    },
  },
  cities: {
    table: 'cities',
    fields: {
      stateId: { col: 'state_id', type: 'uuid', ref: STATE_REF },
      cityName: { col: 'city_name', type: 'string' },
      slug: { col: 'slug', type: 'string' },
      status: { col: 'status', type: 'string', enum: ['active', 'coming_soon', 'inactive'] },
      cityTier: { col: 'city_tier', type: 'int' },
      matchRadiusKm: { col: 'match_radius_km', type: 'numeric' },
      launchDate: { col: 'launch_date', type: 'date' },
      latCentroid: { col: 'lat_centroid', type: 'numeric' },
      lngCentroid: { col: 'lng_centroid', type: 'numeric' },
    },
    required: ['stateId', 'cityName'],
    conflict: ['slug'],
    search: ['city_name', 'slug'],
    filters: { status: 'status', stateId: 'state_id' },
    orderBy: 'city_name ASC',
    // Slug is only derived on create - renaming a city must never silently
    // change its public URL.
    async derive(data, client, { partial }) {
      if (!partial && data.cityName && !data.slug) data.slug = slugify(data.cityName);
    },
  },
  localities: {
    table: 'localities',
    fields: {
      cityId: { col: 'city_id', type: 'uuid', ref: CITY_REF },
      localityName: { col: 'locality_name', type: 'string' },
      subLocality: { col: 'sub_locality', type: 'string' },
      pincode: { col: 'pincode', type: 'string' },
      latCentroid: { col: 'lat_centroid', type: 'numeric' },
      lngCentroid: { col: 'lng_centroid', type: 'numeric' },
      isPremiumArea: { col: 'is_premium_area', type: 'boolean' },
      isActive: { col: 'is_active', type: 'boolean' },
    },
    required: ['cityId', 'localityName'],
    conflict: ['city_id', 'locality_name'],
    search: ['locality_name', 'sub_locality', 'pincode'],
    filters: { cityId: 'city_id', isActive: 'is_active', pincode: 'pincode' },
    orderBy: 'locality_name ASC',
    // Every locality with a pincode also gets a pincodes row (sec. 22:
    // "pincodes - auto-populated from locality entries or CSV import").
    async afterWrite(row, client) {
      if (!row.pincode) return;
      await client.query(
        `INSERT INTO pincodes (pincode, locality_id, city_id, state_id)
         SELECT $1, $2, c.id, c.state_id FROM cities c WHERE c.id = $3
         ON CONFLICT (pincode, locality_id) DO NOTHING`,
        [row.pincode, row.id, row.city_id]
      );
    },
  },
  pincodes: {
    table: 'pincodes',
    fields: {
      pincode: { col: 'pincode', type: 'string' },
      cityId: { col: 'city_id', type: 'uuid', ref: CITY_REF },
      stateId: { col: 'state_id', type: 'uuid', ref: STATE_REF },
      localityId: { col: 'locality_id', type: 'uuid', ref: LOCALITY_REF },
      isActive: { col: 'is_active', type: 'boolean' },
    },
    required: ['pincode', 'cityId', 'stateId'],
    conflict: ['pincode', 'locality_id'],
    search: ['pincode'],
    filters: { cityId: 'city_id', stateId: 'state_id', localityId: 'locality_id' },
    orderBy: 'pincode ASC',
    derive: deriveFromCity,
  },
  stamp_duty_rules: {
    table: 'stamp_duty_rules',
    fields: {
      stateId: { col: 'state_id', type: 'uuid', ref: STATE_REF },
      cityId: { col: 'city_id', type: 'uuid', ref: CITY_REF },
      transactionType: { col: 'transaction_type', type: 'string' },
      buyerGender: { col: 'buyer_gender', type: 'string', enum: ['any', 'male', 'female', 'joint'] },
      ratePercent: { col: 'rate_percent', type: 'numeric' },
      registrationFeePercent: { col: 'registration_fee_percent', type: 'numeric' },
      registrationFeeCap: { col: 'registration_fee_cap', type: 'numeric' },
      effectiveFrom: { col: 'effective_from', type: 'date' },
      effectiveUntil: { col: 'effective_until', type: 'date' },
      notes: { col: 'notes', type: 'text' },
    },
    required: ['stateId', 'ratePercent'],
    search: ['transaction_type', 'notes'],
    filters: { stateId: 'state_id', cityId: 'city_id', transactionType: 'transaction_type' },
    orderBy: 'effective_from DESC',
    derive: deriveFromCity,
  },
  circle_rates: {
    table: 'circle_rates',
    fields: {
      stateId: { col: 'state_id', type: 'uuid', ref: STATE_REF },
      cityId: { col: 'city_id', type: 'uuid', ref: CITY_REF },
      localityId: { col: 'locality_id', type: 'uuid', ref: LOCALITY_REF },
      propertyType: { col: 'property_type', type: 'string' },
      ratePerSqft: { col: 'rate_per_sqft', type: 'numeric' },
      effectiveFrom: { col: 'effective_from', type: 'date' },
      effectiveUntil: { col: 'effective_until', type: 'date' },
      sourceDocUrl: { col: 'source_doc_url', type: 'string' },
    },
    required: ['cityId', 'stateId', 'ratePerSqft'],
    search: ['property_type'],
    filters: { cityId: 'city_id', localityId: 'locality_id', propertyType: 'property_type' },
    orderBy: 'effective_from DESC',
    derive: deriveFromCity,
  },
  sub_registrar_offices: {
    table: 'sub_registrar_offices',
    fields: {
      stateId: { col: 'state_id', type: 'uuid', ref: STATE_REF },
      cityId: { col: 'city_id', type: 'uuid', ref: CITY_REF },
      sroName: { col: 'sro_name', type: 'string' },
      address: { col: 'address', type: 'string' },
      jurisdictionLocalities: { col: 'jurisdiction_localities', type: 'json' },
      officeHours: { col: 'office_hours', type: 'string' },
    },
    required: ['cityId', 'stateId', 'sroName'],
    search: ['sro_name', 'address'],
    filters: { cityId: 'city_id', stateId: 'state_id' },
    orderBy: 'sro_name ASC',
    derive: deriveFromCity,
  },
  feature_flags: {
    table: 'feature_flags',
    fields: {
      flagKey: { col: 'flag_key', type: 'string' },
      scope: { col: 'scope', type: 'string', enum: ['global', 'state', 'city'] },
      scopeId: { col: 'scope_id', type: 'uuid' },
      isEnabled: { col: 'is_enabled', type: 'boolean' },
      rolloutPercentage: { col: 'rollout_percentage', type: 'int' },
      description: { col: 'description', type: 'text' },
    },
    required: ['flagKey'],
    search: ['flag_key', 'description'],
    filters: { scope: 'scope', isEnabled: 'is_enabled' },
    orderBy: 'flag_key ASC',
  },
  disclaimers: {
    table: 'disclaimers',
    fields: {
      disclaimerKey: { col: 'disclaimer_key', type: 'string' },
      title: { col: 'title', type: 'string', guard: true },
      contentHtml: { col: 'content_html', type: 'text', guard: true },
      applicableContentTypes: { col: 'applicable_content_types', type: 'json' },
      applicableStates: { col: 'applicable_states', type: 'json' },
      isMandatory: { col: 'is_mandatory', type: 'boolean' },
      isActive: { col: 'is_active', type: 'boolean' },
      sortOrder: { col: 'sort_order', type: 'int' },
    },
    required: ['disclaimerKey', 'title', 'contentHtml'],
    conflict: ['disclaimer_key'],
    search: ['disclaimer_key', 'title', 'content_html'],
    filters: { isActive: 'is_active' },
    orderBy: 'sort_order ASC, disclaimer_key ASC',
  },
};

function getEntity(name) {
  const entity = ENTITIES[name];
  if (!entity) throw notFound(`Unknown master data entity: ${name}`);
  return entity;
}

function listEntities() {
  return Object.entries(ENTITIES).map(([name, e]) => ({
    name,
    fields: Object.entries(e.fields).map(([key, f]) => ({
      key,
      type: f.type,
      enum: f.enum || undefined,
      required: e.required.includes(key),
      acceptsReference: f.ref ? f.ref.aliases : undefined,
    })),
  }));
}

// snake_case CSV headers ("locality_name") -> camelCase keys ("localityName")
function camelKey(key) {
  return String(key).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function coerce(key, field, raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;

  switch (field.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const v = String(raw).toLowerCase();
      if (['true', 'yes', '1', 'y'].includes(v)) return true;
      if (['false', 'no', '0', 'n'].includes(v)) return false;
      throw badRequest(`${key} must be a boolean`);
    }
    case 'int':
    case 'numeric': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw badRequest(`${key} must be a number`);
      if (field.type === 'int' && !Number.isInteger(n)) throw badRequest(`${key} must be an integer`);
      return n;
    }
    case 'date': {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw badRequest(`${key} must be a valid date`);
      return String(raw).slice(0, 10);
    }
    case 'json': {
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            return JSON.parse(trimmed);
          } catch {
            throw badRequest(`${key} must be valid JSON`);
          }
        }
        // CSV-friendly: "Karol Bagh|Rajouri Garden" -> ["Karol Bagh", "Rajouri Garden"]
        return trimmed.split('|').map((s) => s.trim()).filter(Boolean);
      }
      return raw;
    }
    default: {
      let v = String(raw).trim();
      if (field.upper) v = v.toUpperCase();
      if (field.enum && !field.enum.includes(v)) {
        throw badRequest(`${key} must be one of: ${field.enum.join(', ')}`);
      }
      return v;
    }
  }
}

async function resolveRef(key, field, input, data, client) {
  const direct = input[key];
  if (direct && UUID_RE.test(String(direct))) return direct;

  const ref = field.ref;
  const humanValue = direct || ref.aliases.map((a) => input[a]).find((v) => v !== undefined && v !== null && v !== '');
  if (!humanValue) return direct === null ? null : undefined;

  const params = [String(humanValue).trim()];
  const matchers = ref.by.map((col) => `LOWER(${col}) = LOWER($1)`);
  let scopeClause = '';
  if (ref.scope) {
    const scopeValue = data[ref.scope.field];
    if (!scopeValue) throw badRequest(`${key}: "${humanValue}" needs ${ref.scope.field} to be resolved first`);
    params.push(scopeValue);
    scopeClause = ` AND ${ref.scope.column} = $2`;
  }

  const result = await client.query(
    `SELECT id FROM ${ref.table} WHERE (${matchers.join(' OR ')})${scopeClause} LIMIT 2`,
    params
  );
  if (result.rows.length === 0) throw badRequest(`${key}: no ${ref.table} record matches "${humanValue}"`);
  if (result.rows.length > 1) throw badRequest(`${key}: "${humanValue}" matches more than one ${ref.table} record - use its id`);
  return result.rows[0].id;
}

// Normalises input keys, resolves references, coerces types. Refs are
// resolved in declaration order so scoped refs (locality within city) can
// see the parent resolved just before them.
async function buildRecord(entity, rawInput, client, { partial = false } = {}) {
  const input = {};
  for (const [k, v] of Object.entries(rawInput || {})) input[camelKey(k)] = v;

  const data = {};
  for (const [key, field] of Object.entries(entity.fields)) {
    const value = field.ref ? await resolveRef(key, field, input, data, client) : input[key];
    const coerced = coerce(key, field, value);
    if (coerced !== undefined) data[key] = coerced;
  }

  if (entity.derive) await entity.derive(data, client, { partial });

  if (!partial) {
    const missing = entity.required.filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
    if (missing.length) throw badRequest(`Missing required field(s): ${missing.join(', ')}`);
  }

  const guarded = Object.fromEntries(
    Object.entries(entity.fields).filter(([k, f]) => f.guard && data[k] != null).map(([k]) => [k, data[k]])
  );
  if (Object.keys(guarded).length) await assertCleanContent(guarded);

  return data;
}

function toColumns(entity, data) {
  const cols = [];
  const values = [];
  for (const [key, value] of Object.entries(data)) {
    const field = entity.fields[key];
    if (!field) continue;
    cols.push(field.col);
    values.push(field.type === 'json' ? JSON.stringify(value) : value);
  }
  return { cols, values };
}

async function insertRow(entity, data, client, { upsert = false } = {}) {
  const { cols, values } = toColumns(entity, data);
  const placeholders = values.map((_, i) => `$${i + 1}`);
  let conflictClause = '';
  if (upsert && entity.conflict) {
    const updates = cols.filter((c) => !entity.conflict.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
    conflictClause = updates.length
      ? ` ON CONFLICT (${entity.conflict.join(', ')}) DO UPDATE SET ${updates.join(', ')}`
      : ` ON CONFLICT (${entity.conflict.join(', ')}) DO NOTHING`;
  }
  const result = await client.query(
    `INSERT INTO ${entity.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})${conflictClause} RETURNING *`,
    values
  );
  const row = result.rows[0];
  if (row && entity.afterWrite) await entity.afterWrite(row, client);
  return row;
}

function translatePgError(err) {
  if (err.code === '23505') return unprocessable('A record with the same unique key already exists', [{ detail: err.detail }]);
  if (err.code === '23503') return unprocessable('Referenced record does not exist or is still in use', [{ detail: err.detail }]);
  return err;
}

async function list(name, query) {
  const entity = getEntity(name);
  const { page, limit, offset } = parsePagination(query, 50);
  const where = [];
  const params = [];

  for (const [key, col] of Object.entries(entity.filters || {})) {
    if (query[key] === undefined || query[key] === '') continue;
    const field = entity.fields[key];
    params.push(field ? coerce(key, field, query[key]) : query[key]);
    where.push(`${col} = $${params.length}`);
  }
  if (query.search && entity.search) {
    params.push(`%${query.search}%`);
    where.push(`(${entity.search.map((c) => `${c}::text ILIKE $${params.length}`).join(' OR ')})`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM ${entity.table} ${whereClause}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM ${entity.table} ${whereClause} ORDER BY ${entity.orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: result.rows, pagination: buildPagination(page, limit, count.rows[0].count) };
}

async function getById(name, id) {
  const entity = getEntity(name);
  const result = await pool.query(`SELECT * FROM ${entity.table} WHERE id = $1`, [id]);
  if (!result.rows[0]) throw notFound(`${name} record not found`);
  return result.rows[0];
}

async function create(name, input, actingUser, meta = {}) {
  const entity = getEntity(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data = await buildRecord(entity, input, client);
    const row = await insertRow(entity, data, client);
    await auditService.log({ actor: actingUser, action: `${name}_created`, entityType: name, entityId: row.id, after: row, ...meta }, client);
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK');
    throw translatePgError(err);
  } finally {
    client.release();
  }
}

async function update(name, id, input, actingUser, meta = {}) {
  const entity = getEntity(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT * FROM ${entity.table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing.rows[0]) throw notFound(`${name} record not found`);

    // Scoped refs (e.g. a locality name within a city) need the parent id
    // even when the caller is only changing the child - seed it from the row.
    const seeded = { ...input };
    for (const [key, field] of Object.entries(entity.fields)) {
      if (field.ref?.scope && seeded[field.ref.scope.field] === undefined) {
        const parentCol = entity.fields[field.ref.scope.field]?.col;
        if (parentCol) seeded[field.ref.scope.field] = existing.rows[0][parentCol];
      }
      if (field.ref && seeded[key] === undefined && !field.ref.aliases.some((a) => seeded[a] !== undefined)) {
        delete seeded[key];
      }
    }

    const data = await buildRecord(entity, seeded, client, { partial: true });
    const { cols, values } = toColumns(entity, data);
    if (cols.length === 0) throw badRequest('No updatable fields provided');

    values.push(id);
    const result = await client.query(
      `UPDATE ${entity.table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    const row = result.rows[0];
    if (entity.afterWrite) await entity.afterWrite(row, client);

    await auditService.log(
      { actor: actingUser, action: `${name}_updated`, entityType: name, entityId: id, before: existing.rows[0], after: row, ...meta },
      client
    );
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK');
    throw translatePgError(err);
  } finally {
    client.release();
  }
}

async function remove(name, id, actingUser, meta = {}) {
  const entity = getEntity(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`DELETE FROM ${entity.table} WHERE id = $1 RETURNING *`, [id]);
    if (!result.rows[0]) throw notFound(`${name} record not found`);
    await auditService.log(
      { actor: actingUser, action: `${name}_deleted`, entityType: name, entityId: id, before: result.rows[0], ...meta },
      client
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw translatePgError(err);
  } finally {
    client.release();
  }
}

// All-or-nothing bulk import: every row is validated and written inside one
// transaction; any failing row rolls the whole file back and the response
// lists every failing row (1-based, counting the header as row 1) so the
// admin can fix the sheet and re-upload. `dryRun` validates without saving.
async function importRows(name, rows, actingUser, { dryRun = false } = {}, meta = {}) {
  const entity = getEntity(name);
  if (!Array.isArray(rows) || rows.length === 0) throw badRequest('The file contains no data rows');
  if (rows.length > 5000) throw badRequest('A single import is limited to 5000 rows');

  const client = await pool.connect();
  const errors = [];
  const written = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i++) {
      await client.query('SAVEPOINT import_row');
      try {
        const data = await buildRecord(entity, rows[i], client);
        written.push(await insertRow(entity, data, client, { upsert: true }));
        await client.query('RELEASE SAVEPOINT import_row');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT import_row');
        const translated = translatePgError(err);
        errors.push({ row: i + 2, message: translated.message, details: translated.errors || undefined });
      }
    }

    if (errors.length > 0 || dryRun) {
      await client.query('ROLLBACK');
      if (errors.length > 0) throw unprocessable(`Import failed - ${errors.length} row(s) invalid, nothing was saved`, errors);
      return { dryRun: true, validRows: rows.length, imported: 0 };
    }

    await auditService.log(
      { actor: actingUser, action: `${name}_imported`, entityType: name, after: { rows: written.length }, ...meta },
      client
    );
    await client.query('COMMIT');
    return { dryRun: false, validRows: rows.length, imported: written.length };
  } catch (err) {
    if (!err.statusCode) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ENTITIES, listEntities, list, getById, create, update, remove, importRows, slugify };
