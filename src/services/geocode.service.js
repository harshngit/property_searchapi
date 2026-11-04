const pool = require('../config/db');
const configService = require('./config.service');

// Contract sec. 25.5.2 - Google Maps / geo-services failover. A listing is
// never blocked because the map or the geocoder is down: it is saved with a
// 6-digit pincode and this job places it later (delayed geocoding).
//
// Providers, in the order set by geo.geocoder_order:
//   google       Geocoding API (GOOGLE_GEOCODING_API_KEY, server key)
//   nominatim    OpenStreetMap Nominatim - at most one request a second, as
//                its usage policy requires; fine for a delayed, low-volume job
//   master_data  the centre of the listing's locality or city from our own
//                master tables (needs no network at all)
// A pincode found once is cached in pincode_geocodes. Every result is
// 'approximate' (a pincode centre, not the building): the owner or staff can
// still drop the exact pin later, which makes it 'pinned'.

const NOMINATIM_GAP_MS = 1100;
let lastNominatim = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fromGoogle(pincode) {
  const key = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?components=postal_code:${pincode}|country:IN&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Google geocoding HTTP ${res.status}`);
  const body = await res.json();
  if (body.status === 'ZERO_RESULTS') return { found: false };
  if (body.status !== 'OK') throw new Error(`Google geocoding ${body.status}`);
  const loc = body.results?.[0]?.geometry?.location;
  return loc ? { found: true, lat: loc.lat, lng: loc.lng } : { found: false };
}

async function fromNominatim(pincode) {
  const gap = lastNominatim + NOMINATIM_GAP_MS - Date.now();
  if (gap > 0) await wait(gap);
  lastNominatim = Date.now();
  const res = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${pincode}&countrycodes=in&format=json&limit=1`, {
    headers: { 'User-Agent': 'PropertySerch-geocoder/1.0 (delayed pincode geocoding)', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] ? { found: true, lat: Number(rows[0].lat), lng: Number(rows[0].lon) } : { found: false };
}

// Locality centre for the pincode (or the listing's locality), else the city centre.
async function fromMasterData(pincode, { city, locality } = {}) {
  const r = (await pool.query(
    `SELECT l.lat_centroid AS lat, l.lng_centroid AS lng FROM localities l
     WHERE l.lat_centroid IS NOT NULL AND (l.pincode = $1 OR ($2::text IS NOT NULL AND lower(l.locality_name) = lower($2)))
     ORDER BY (l.pincode = $1) DESC LIMIT 1`,
    [pincode, locality || null]
  )).rows[0];
  if (r) return { found: true, lat: Number(r.lat), lng: Number(r.lng), local: true };
  const c = city
    ? (await pool.query(`SELECT lat_centroid AS lat, lng_centroid AS lng FROM cities WHERE lower(city_name) = lower($1) AND lat_centroid IS NOT NULL LIMIT 1`, [city])).rows[0]
    : null;
  return c ? { found: true, lat: Number(c.lat), lng: Number(c.lng), local: true } : { found: false, local: true };
}

const PROVIDERS = { google: fromGoogle, nominatim: fromNominatim, master_data: fromMasterData };

// Returns { lat, lng, source } or null. Network providers' answers are cached
// per pincode; the master-data fallback is not (it depends on the listing).
async function locate(pincode, hint = {}) {
  if (!/^\d{6}$/.test(String(pincode || ''))) return null;
  const cached = (await pool.query('SELECT * FROM pincode_geocodes WHERE pincode = $1', [pincode])).rows[0];
  if (cached?.found) return { lat: Number(cached.latitude), lng: Number(cached.longitude), source: cached.source };
  const order = (await configService.getConfig('geo.geocoder_order', ['google', 'nominatim', 'master_data'])) || [];
  let lastError = null;
  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider) continue;
    if (cached && !cached.found && name === cached.source) continue; // already known to have no answer
    try {
      const out = await provider(pincode, hint);
      if (!out) continue; // not configured
      if (!out.local) {
        await pool.query(
          `INSERT INTO pincode_geocodes (pincode, latitude, longitude, source, found) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (pincode) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, source = EXCLUDED.source, found = EXCLUDED.found, looked_up_at = now()`,
          [pincode, out.found ? out.lat : null, out.found ? out.lng : null, name, out.found]
        );
      }
      if (out.found) return { lat: Number(out.lat.toFixed(7)), lng: Number(out.lng.toFixed(7)), source: name };
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return null;
}

// Places pincode-only listings and map fields filled with a pincode.
async function run({ limit = 50 } = {}) {
  const maxAttempts = Number(await configService.getConfig('geo.max_geocode_attempts', 5)) || 5;
  const out = { placed: 0, failed: 0, retry: 0, fields: 0 };
  const due = (await pool.query(
    `SELECT id, pincode, city, locality, geocode_attempts FROM properties WHERE geo_status = 'pending' ORDER BY geocode_attempts, created_at DESC LIMIT $1`,
    [limit]
  )).rows;
  for (const p of due) {
    let hit = null;
    let error = null;
    try {
      hit = await locate(p.pincode, p);
    } catch (err) {
      error = err;
    }
    if (hit) {
      await pool.query(
        `UPDATE properties SET latitude = $2, longitude = $3, geo_status = 'approximate', geo_source = $4, geocoded_at = now(), geocode_attempts = geocode_attempts + 1
         WHERE id = $1 AND geo_status = 'pending'`,
        [p.id, hit.lat, hit.lng, hit.source]
      );
      out.placed += 1;
    } else {
      // A provider outage is retried; "no such pincode anywhere" counts towards giving up as well.
      const gaveUp = p.geocode_attempts + 1 >= maxAttempts;
      await pool.query(
        `UPDATE properties SET geocode_attempts = geocode_attempts + 1, geo_status = CASE WHEN $2 THEN 'failed' ELSE geo_status END WHERE id = $1 AND geo_status = 'pending'`,
        [p.id, gaveUp]
      );
      if (gaveUp) out.failed += 1;
      else out.retry += 1;
      if (error) console.error(`[geocode] ${p.pincode}:`, error.message);
    }
  }
  out.fields = await placeMapFields(limit);
  return out;
}

// Dynamic "map location" fields saved as { pincode, pending: true }.
async function placeMapFields(limit) {
  const fields = (await pool.query(`SELECT entity_type, field_name FROM metadata_fields WHERE field_type = 'geo_point'`)).rows;
  let placed = 0;
  for (const f of fields) {
    const rows = (await pool.query(
      `SELECT entity_id, field_values -> $2 AS v FROM custom_field_values
       WHERE entity_type = $1 AND (field_values -> $2 ->> 'pending') = 'true' LIMIT $3`,
      [f.entity_type, f.field_name, limit]
    )).rows;
    for (const r of rows) {
      const hit = await locate(r.v.pincode).catch(() => null);
      if (!hit) continue;
      await pool.query(
        `UPDATE custom_field_values SET field_values = jsonb_set(field_values, ARRAY[$3::text], $4::jsonb), updated_at = now() WHERE entity_type = $1 AND entity_id = $2`,
        [f.entity_type, r.entity_id, f.field_name, JSON.stringify({ lat: hit.lat, lng: hit.lng, pincode: r.v.pincode, approximate: true })]
      );
      placed += 1;
    }
  }
  return placed;
}

async function summary() {
  const r = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE geo_status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE geo_status = 'approximate')::int AS approximate,
            COUNT(*) FILTER (WHERE geo_status = 'failed')::int AS failed
     FROM properties`
  )).rows[0];
  return { ...r, providers: { google: !!process.env.GOOGLE_GEOCODING_API_KEY, nominatim: true, masterData: true } };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => run().catch((err) => console.error('[geocode] run failed:', err.message)), 15 * 60 * 1000);
  timer.unref?.();
}

module.exports = { locate, run, summary, startScheduler };
