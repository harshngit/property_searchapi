const pool = require('../../config/db');

// Crawler modules whose output is reference data, not listings (contract
// sec. 23 expanded list):
//   crawler_rera.js          -> rera_projects   (weekly)
//   crawler_nhb_rbi.js       -> price_indices   (monthly)
//   crawler_portal_market.js -> market_stats    (weekly)
// The adapters (html_list / json_api / pdf_links) and their admin-editable
// field mappings are the same as for auction sources; the mapping's field
// names are this module's column names. Rows from PDFs are read from the
// text (or OCR) with a row pattern - config.rowPattern (a regular
// expression with named groups) or the built-in default per output.
//
// Binding rules for portal data: aggregated market statistics only. No
// listing, person or contact detail is ever stored - rows are built from a
// whitelist of aggregate fields, and a row whose area text looks like a
// listing or carries contact details is rejected.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = Number(m[0]);
  const unit = String(v).toLowerCase();
  if (/\bcr(ore)?s?\b/.test(unit)) n *= 1e7;
  else if (/\b(lakh|lac)s?\b/.test(unit)) n *= 1e5;
  else if (/\bk\b/.test(unit)) n *= 1e3;
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const text = (v, max = 300) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function date(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{4})/i);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()] + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// "Q1 2025-26", "2025-26:Q3", "Q4 FY26", "Jan-Mar 2026", "March 2026", "2026-Q1".
function period(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{4})\s*-\s*Q([1-4])/i);
  if (m) return { period: `${m[1]}-Q${m[2]}`, start: `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, '0')}-01` };
  const q = s.match(/Q\s*([1-4])/i);
  const fy = s.match(/(\d{4})\s*[-/]\s*(\d{2,4})/) || s.match(/FY\s*'?(\d{2,4})/i);
  if (q && fy) {
    // Indian financial year: "2025-26" / "FY26" starts April 2025; Q4 is Jan-Mar of the next year.
    const startYear = fy[2] !== undefined ? Number(fy[1]) : Number(fy[1].length === 2 ? `20${fy[1]}` : fy[1]) - 1;
    const quarter = Number(q[1]);
    const month = [4, 7, 10, 1][quarter - 1];
    return { period: `FY${String(startYear + 1).slice(-2)}-Q${quarter}`, start: `${quarter === 4 ? startYear + 1 : startYear}-${String(month).padStart(2, '0')}-01` };
  }
  m = s.match(/([a-z]{3})[a-z]*\s*(?:-|to)?\s*(?:[a-z]{3}[a-z]*)?[\s,'-]+(\d{4})/i);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const mo = MONTHS[m[1].toLowerCase()];
    return { period: `${m[2]}-${String(mo + 1).padStart(2, '0')}`, start: `${m[2]}-${String(mo + 1).padStart(2, '0')}-01` };
  }
  m = s.match(/(\d{4})-(\d{2})/);
  if (m) return { period: `${m[1]}-${m[2]}`, start: `${m[1]}-${m[2]}-01` };
  return { period: s.slice(0, 12), start: null };
}

// Area names only: anything that reads like a listing or a contact is refused.
function cleanArea(v) {
  const s = text(v, 160);
  if (!s) return null;
  if (/\d{6,}|@|https?:|www\.|\bbhk\b|\bfor (sale|rent)\b|\bcall\b|\bcontact\b|\bowner\b|\bbroker\b/i.test(s)) return null;
  return s;
}

const DEFAULT_ROW_PATTERNS = {
  // "Mumbai 312.4 4.2 1.1"  (city, index, YoY %, QoQ %). OCR often closes the
  // gap between narrow columns ("4.21.1"), so the two changes may be joined.
  price_indices: '^(?<city>[A-Za-z][A-Za-z .&()-]{2,40}?)\\s+(?<index_value>\\d{2,4}(?:\\.\\d+)?)(?:\\s+(?<yoy_change_percent>-?\\d{1,3}(?:\\.\\d{1,2}?)?))?(?:\\s*(?<qoq_change_percent>-?\\d{1,3}(?:\\.\\d{1,2}?)?))?\\s*$',
  // "Gurugram Sector 56 12,450 6.5"  (area, average Rs / sq ft, change %)
  market_stats: '^(?<locality>[A-Za-z][A-Za-z0-9 .&()/-]{2,60}?)\\s+(?:Rs\\.?\\s*|₹\\s*)?(?<avg_price_per_sqft>\\d{1,3}(?:,\\d{2,3})+|\\d{4,6})(?:\\s+(?<price_change_percent>-?\\d{1,3}(?:\\.\\d+)?)\\s*%?)?\\s*$',
  // "P52100012345 Sunrise Heights ABC Developers Pune Ongoing"
  rera_projects: null,
};

const KEY_FIELDS = {
  rera_projects: ['rera_number'],
  price_indices: ['index_value'],
  market_stats: ['avg_price_per_sqft', 'price_change_percent', 'demand_index', 'supply_count', 'rental_yield_percent'],
};

// Turn adapter items into plain mapped rows. PDF items carry their text in
// _text and are expanded line by line with the row pattern.
function expand(source, items) {
  const cfg = source.config || {};
  const pattern = cfg.rowPattern || DEFAULT_ROW_PATTERNS[source.output];
  const rows = [];
  for (const item of items) {
    const { _text, _method, ...mapped } = item;
    // Rows mapped by the adapter already carry this output's own fields; PDF
    // items only carry text and are expanded line by line.
    const mappedRow = KEY_FIELDS[source.output].some((k) => mapped[k] != null && mapped[k] !== '');
    if (mappedRow || !_text || !pattern) {
      rows.push({ ...mapped, source_url: mapped.source_url || mapped.auction_portal_url || source.list_url });
      continue;
    }
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue;
    }
    // A period stated once in the document applies to every row.
    const docPeriod = (String(_text).match(/Q\s*[1-4][\s:,-]*(?:FY\s*'?\d{2,4}|\d{4}\s*[-/]\s*\d{2,4})|(?:\d{4}\s*[-/]\s*\d{2,4})[\s:,-]*Q\s*[1-4]|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(?:-|to)\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,]+\d{4}/i) || [])[0];
    for (const line of String(_text).split(/\r?\n/)) {
      const m = line.trim().match(re);
      if (m?.groups) rows.push({ ...(cfg.constants || {}), period: docPeriod, ...Object.fromEntries(Object.entries(m.groups).filter(([, v]) => v != null)), source_url: mapped.auction_portal_url || source.list_url });
    }
  }
  return rows;
}

// ------------------------------------------------------------ sinks

function reraStatus(raw, completion) {
  const s = String(raw || '').toLowerCase();
  if (/revok|cancel/.test(s)) return 'revoked';
  if (/laps|expir/.test(s)) return 'lapsed';
  if (/complet|occupancy|oc received/.test(s)) return 'completed';
  if (/delay|extend|overdue/.test(s)) return 'delayed';
  const known = /ongoing|progress|under construction|new|registered|active/.test(s);
  if (completion && new Date(completion) < new Date()) return 'delayed';
  return known ? 'ongoing' : 'unknown';
}

async function storeRera(source, rows) {
  const out = { stored: 0, updated: 0, rejected: 0, sample: [] };
  for (const r of rows) {
    const number = text(r.rera_number, 80);
    const state = text(r.state, 60);
    if (!number || !state || number.length < 4) {
      out.rejected += 1;
      continue;
    }
    const completion = date(r.proposed_completion_date);
    const row = {
      state, rera_number: number, rera_number_key: number.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      project_name: text(r.project_name), promoter_name: text(r.promoter_name), district: text(r.district, 120), city: text(r.city || r.district, 120),
      project_status: reraStatus(r.project_status || r.status, completion), approved_units: int(r.approved_units), complaints_count: int(r.complaints_count),
      registration_date: date(r.registration_date), proposed_completion_date: completion, source_url: text(r.source_url, 1000),
    };
    const res = await pool.query(
      `INSERT INTO rera_projects (state, rera_number, rera_number_key, project_name, promoter_name, district, city, project_status, approved_units,
         complaints_count, registration_date, proposed_completion_date, source_url, crawler_source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (rera_number_key) DO UPDATE SET
         project_name = COALESCE(EXCLUDED.project_name, rera_projects.project_name), promoter_name = COALESCE(EXCLUDED.promoter_name, rera_projects.promoter_name),
         district = COALESCE(EXCLUDED.district, rera_projects.district), city = COALESCE(EXCLUDED.city, rera_projects.city),
         project_status = CASE WHEN EXCLUDED.project_status = 'unknown' THEN rera_projects.project_status ELSE EXCLUDED.project_status END,
         approved_units = COALESCE(EXCLUDED.approved_units, rera_projects.approved_units), complaints_count = COALESCE(EXCLUDED.complaints_count, rera_projects.complaints_count),
         registration_date = COALESCE(EXCLUDED.registration_date, rera_projects.registration_date),
         proposed_completion_date = COALESCE(EXCLUDED.proposed_completion_date, rera_projects.proposed_completion_date),
         source_url = COALESCE(EXCLUDED.source_url, rera_projects.source_url), last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [row.state, row.rera_number, row.rera_number_key, row.project_name, row.promoter_name, row.district, row.city, row.project_status, row.approved_units,
        row.complaints_count, row.registration_date, row.proposed_completion_date, row.source_url, source.id]
    );
    out[res.rows[0].inserted ? 'stored' : 'updated'] += 1;
    if (out.sample.length < 5) out.sample.push(row);
  }
  return out;
}

async function storeIndices(source, rows) {
  const out = { stored: 0, updated: 0, rejected: 0, sample: [] };
  for (const r of rows) {
    const city = cleanArea(r.city);
    const value = num(r.index_value);
    const p = period(r.period);
    const indexSource = text(r.index_source, 30) || source.source_key;
    if (!city || value === null || value <= 0 || value > 5000 || !p || /^(city|cities|total|index|quarter|period|source)$/i.test(city)) {
      out.rejected += 1;
      continue;
    }
    const row = { index_source: indexSource, index_kind: text(r.index_kind, 40) || 'composite', city, period: p.period, period_start: p.start, index_value: value, yoy_change_percent: num(r.yoy_change_percent), qoq_change_percent: num(r.qoq_change_percent) };
    const res = await pool.query(
      `INSERT INTO price_indices (index_source, index_kind, city, period, period_start, index_value, yoy_change_percent, qoq_change_percent, source_url, crawler_source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (index_source, index_kind, city, period) DO UPDATE SET index_value = EXCLUDED.index_value,
         yoy_change_percent = COALESCE(EXCLUDED.yoy_change_percent, price_indices.yoy_change_percent),
         qoq_change_percent = COALESCE(EXCLUDED.qoq_change_percent, price_indices.qoq_change_percent), captured_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [row.index_source, row.index_kind, row.city, row.period, row.period_start, row.index_value, row.yoy_change_percent, row.qoq_change_percent, text(r.source_url, 1000), source.id]
    );
    out[res.rows[0].inserted ? 'stored' : 'updated'] += 1;
    if (out.sample.length < 5) out.sample.push(row);
  }
  return out;
}

async function storeMarketStats(source, rows) {
  const out = { stored: 0, updated: 0, rejected: 0, sample: [] };
  for (const r of rows) {
    const city = cleanArea(r.city);
    const locality = r.locality ? cleanArea(r.locality) : '';
    const avg = num(r.avg_price_per_sqft);
    const change = num(r.price_change_percent);
    const demand = num(r.demand_index);
    const supply = int(r.supply_count);
    const yieldPct = num(r.rental_yield_percent);
    // Need an area and at least one aggregate figure; a locality that failed the area check rejects the row.
    if (!city || (r.locality && !locality) || (avg === null && change === null && demand === null && supply === null && yieldPct === null) || (avg !== null && (avg < 200 || avg > 500000))) {
      out.rejected += 1;
      continue;
    }
    const tx = /rent/i.test(String(r.transaction_type || '')) ? 'rent' : 'sell';
    const row = {
      portal_key: source.source_key, city, locality: locality || '', property_type: (text(r.property_type, 40) || 'all').toLowerCase(), transaction_type: tx,
      avg_price_per_sqft: avg, min_price_per_sqft: num(r.min_price_per_sqft), max_price_per_sqft: num(r.max_price_per_sqft), price_change_percent: change,
      demand_index: demand, supply_count: supply, rental_yield_percent: yieldPct,
    };
    const res = await pool.query(
      `INSERT INTO market_stats (portal_key, city, locality, property_type, transaction_type, avg_price_per_sqft, min_price_per_sqft, max_price_per_sqft,
         price_change_percent, demand_index, supply_count, rental_yield_percent, source_url, crawler_source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (portal_key, city, locality, property_type, transaction_type, captured_on) DO UPDATE SET
         avg_price_per_sqft = EXCLUDED.avg_price_per_sqft, min_price_per_sqft = EXCLUDED.min_price_per_sqft, max_price_per_sqft = EXCLUDED.max_price_per_sqft,
         price_change_percent = EXCLUDED.price_change_percent, demand_index = EXCLUDED.demand_index, supply_count = EXCLUDED.supply_count,
         rental_yield_percent = EXCLUDED.rental_yield_percent
       RETURNING (xmax = 0) AS inserted`,
      [row.portal_key, row.city, row.locality, row.property_type, row.transaction_type, row.avg_price_per_sqft, row.min_price_per_sqft, row.max_price_per_sqft,
        row.price_change_percent, row.demand_index, row.supply_count, row.rental_yield_percent, text(r.source_url, 1000), source.id]
    );
    out[res.rows[0].inserted ? 'stored' : 'updated'] += 1;
    if (out.sample.length < 5) out.sample.push(row);
  }
  return out;
}

const SINKS = { rera_projects: storeRera, price_indices: storeIndices, market_stats: storeMarketStats };

// dryRun (a "test" run) only shows what would be stored.
async function store(source, items, { dryRun = false } = {}) {
  const rows = expand(source, items).slice(0, 5000);
  if (dryRun) return { received: rows.length, stored: 0, updated: 0, rejected: 0, sample: rows.slice(0, 5) };
  const result = await SINKS[source.output](source, rows);
  return { received: rows.length, ...result };
}

module.exports = { store, expand, period, date, cleanArea };
