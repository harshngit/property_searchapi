const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { assertCleanContent } = require('../utils/contentGuard');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 7 - Institutional (Modules 8, 22; valuation is Module 15 in
// institutionalValuation.service.js).
//
// Confidentiality (sec. 11.3): the institution's name and figures live in
// institutional_listings and are returned ONLY to A R staff, the lister /
// seller, or a buyer who has passed all three gates - qualified buyer +
// NDA signed on the platform + admin approval (the deal-room gates). The
// public properties row carries a generated title ("K-12 School in South
// Delhi"), never the name; the public card shows type, locality, an
// enrollment range and a price range.
//
// Pipeline (9 stages). A deal enters a stage when what that stage stands
// for has happened, and moves on by itself:
//   1 Intent Received        intake (platform / WhatsApp / guest / CRM)
//   2 Buyer Qualification    <- the representative has screened the intent
//   3 NDA Executed           <- buyer qualified + NDA signed on the platform
//   4 Data Room Access       <- admin approved the data-room access
//   5 Site Visit             <- campus visit scheduled
//   6 Valuation Discussion   <- visit completed
//   7 Legal Due Diligence    <- valuation shared with the buyer
//   8 Offer and Negotiation  <- legal due diligence cleared by the panel
//   9 Closure                <- an offer / term sheet accepted
//   closed (won)             <- agreement executed + payment confirmed
// Admins may move a deal by hand with a logged reason.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const isStaff = (u) => !!u && STAFF.includes(u.role);

const ASSET_CLASSES = {
  k12_school: 'K-12 School', college: 'Private College', university: 'University', international_school: 'International School',
  coaching_center: 'Coaching & Test-Prep Campus', vocational_institute: 'Vocational & Skill Institute', hospital: 'Hospital & Healthcare',
  hotel: 'Hotel & Hospitality', corporate_campus: 'Corporate Campus & Tech Park', senior_living: 'Senior Living', entertainment: 'Entertainment & Media',
};
const SECTOR = {
  k12_school: 'education', college: 'education', university: 'education', international_school: 'education', coaching_center: 'education', vocational_institute: 'education',
  hospital: 'healthcare', senior_living: 'healthcare', hotel: 'hospitality', corporate_campus: 'other', entertainment: 'other',
};
const CAPACITY_LABEL = { hospital: 'beds', hotel: 'rooms', senior_living: 'units', corporate_campus: 'seats', entertainment: 'seats' };
const DEAL_TYPES = { full_sale: 'Full sale', stake_sale: 'Stake sale', lease: 'Lease', jv: 'Joint venture', management_takeover: 'Management takeover' };
const STAGES = ['intent_received', 'buyer_qualification', 'nda_executed', 'data_room_access', 'site_visit', 'valuation_discussion', 'legal_due_diligence', 'offer_negotiation', 'closure'];
const STAGE_LABEL = {
  intent_received: 'Intent Received', buyer_qualification: 'Buyer Qualification', nda_executed: 'NDA Executed', data_room_access: 'Data Room Access',
  site_visit: 'Site Visit', valuation_discussion: 'Valuation Discussion', legal_due_diligence: 'Legal Due Diligence', offer_negotiation: 'Offer and Negotiation', closure: 'Closure',
};
const BUYER_TYPES = {
  pe_fund: 'PE fund', trust: 'Trust / foundation', education_group: 'Education group', healthcare_group: 'Healthcare group', hospitality_group: 'Hospitality group',
  corporate: 'Corporate', family_office: 'Family office', hni_individual: 'HNI individual', other: 'Other',
};
// Approvals a class of institution is expected to hold (missing-approval detection).
const EXPECTED_APPROVALS = {
  k12_school: ['Board affiliation (CBSE / ICSE / State)', 'State education department recognition'],
  international_school: ['Board affiliation (IB / Cambridge)', 'State education department NOC'],
  college: ['University affiliation', 'AICTE / relevant council approval'],
  university: ['UGC recognition'],
  vocational_institute: ['NSDC affiliation'],
  hospital: ['Clinical establishment registration', 'Pollution control / biomedical waste authorisation'],
  hotel: ['Trade licence', 'FSSAI licence'],
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const cr = (v) => (v === null || v === undefined ? null : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`);

// "500-1,000" style bands so the public card never gives the exact figure.
function band(value, steps, unit = '') {
  const v = num(value);
  if (v === null) return null;
  for (let i = 0; i < steps.length; i += 1) {
    if (v < steps[i]) return i === 0 ? `Under ${steps[0].toLocaleString('en-IN')}${unit}` : `${steps[i - 1].toLocaleString('en-IN')}-${steps[i].toLocaleString('en-IN')}${unit}`;
  }
  return `${steps[steps.length - 1].toLocaleString('en-IN')}+${unit}`;
}
const enrollmentBand = (n) => band(n, [250, 500, 1000, 2000, 5000, 10000]);
const priceBand = (c) => {
  const b = band(c, [5, 10, 25, 50, 100, 250, 500]);
  return b ? `₹${b} Cr` : null;
};
const acresBand = (a) => band(a, [1, 2, 5, 10, 25, 50], ' acres');

const SELECT = `
  SELECT il.*, p.id, p.title, p.city, p.locality, p.address, p.latitude, p.longitude, p.status, p.created_by, p.broker_id, p.created_at AS listed_at,
         p.verification_level, p.description
  FROM institutional_listings il JOIN properties p ON p.id = il.property_id`;

const maskedTitle = (assetClass, locality, city) => `${ASSET_CLASSES[assetClass] || 'Institutional asset'} in ${locality || city}`;

function publicView(r) {
  const cap = r.capacity_units ? `${band(r.capacity_units, [25, 50, 100, 250, 500])} ${r.capacity_label || CAPACITY_LABEL[r.asset_class] || 'units'}` : null;
  const students = enrollmentBand(r.student_enrollment);
  const price = priceBand(r.asking_price_cr);
  return {
    id: r.property_id,
    title: maskedTitle(r.asset_class, r.locality, r.city),
    // "K-12 School, 800 students, South Delhi, Asking INR XX Cr" - with ranges.
    summary: [ASSET_CLASSES[r.asset_class], students ? `${students} students` : cap, r.locality || r.city, price ? `Asking ${price}` : null].filter(Boolean).join(', '),
    assetClass: r.asset_class,
    assetClassLabel: ASSET_CLASSES[r.asset_class],
    sector: SECTOR[r.asset_class],
    boardAffiliation: r.board_affiliation || null,
    city: r.city,
    locality: r.locality,
    dealType: r.deal_type,
    dealTypeLabel: DEAL_TYPES[r.deal_type],
    enrollmentRange: students,
    capacityRange: cap,
    campusRange: acresBand(r.campus_area_acres),
    priceRange: price,
    landOwnership: r.land_ownership,
    establishedDecade: r.year_established ? `${Math.floor(r.year_established / 10) * 10}s` : null,
    verificationLevel: r.verification_level || 0,
    confidential: true,
    listedAt: r.listed_at,
  };
}

function fullView(r) {
  return {
    ...publicView(r),
    confidential: r.is_confidential,
    institutionName: r.institution_name,
    subType: r.sub_type,
    yearEstablished: r.year_established,
    address: r.address,
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
    campusAreaSqft: num(r.campus_area_sqft),
    campusAreaAcres: num(r.campus_area_acres),
    builtUpAreaSqft: num(r.built_up_area_sqft),
    buildingCount: r.building_count,
    infrastructure: r.infrastructure,
    studentEnrollment: r.student_enrollment,
    facultyCount: r.faculty_count,
    capacityUnits: r.capacity_units,
    capacityLabel: r.capacity_label || CAPACITY_LABEL[r.asset_class] || null,
    enrollmentHistory: r.enrollment_history || [],
    nocStatus: r.noc_status,
    approvals: r.approvals || [],
    askingPriceCr: num(r.asking_price_cr),
    annualRevenueCr: num(r.annual_revenue_cr),
    ebitdaCr: num(r.ebitda_cr),
    revenueMultiple: num(r.revenue_multiple),
    ebitdaMultiple: num(r.ebitda_multiple),
    status: r.status,
    sellerUserId: r.seller_user_id,
  };
}

async function disclaimer() {
  return configService.getConfig('institutional.disclaimer', 'A R Buildwel facilitates and coordinates; we do not act as legal counsel. All institutional transactions must involve qualified legal professionals and chartered accountants.');
}

async function meta() {
  return {
    assetClasses: Object.entries(ASSET_CLASSES).map(([value, label]) => ({ value, label, sector: SECTOR[value], capacityLabel: CAPACITY_LABEL[value] || null, expectedApprovals: EXPECTED_APPROVALS[value] || [] })),
    dealTypes: Object.entries(DEAL_TYPES).map(([value, label]) => ({ value, label })),
    buyerTypes: Object.entries(BUYER_TYPES).map(([value, label]) => ({ value, label })),
    stages: STAGES.map((value, i) => ({ value, label: STAGE_LABEL[value], number: i + 1 })),
    nocStatuses: ['valid', 'pending', 'expired', 'not_applicable'],
    landOwnership: ['owned', 'leased', 'trust_held', 'mixed'],
    disclaimer: await disclaimer(),
  };
}

// ------------------------------------------------------------ access

async function row(propertyId) {
  const r = (await pool.query(`${SELECT} WHERE il.property_id = $1`, [propertyId])).rows[0];
  if (!r) throw notFound('Institutional listing not found');
  return r;
}

const isLister = (user, r) => !!user && [r.created_by, r.broker_id, r.seller_user_id].includes(user.id);

async function isQualifiedBuyer(userId) {
  if (!userId) return false;
  return (await pool.query(`SELECT 1 FROM institutional_buyers WHERE user_id = $1 AND status = 'qualified'`, [userId])).rows.length > 0;
}

// The institutional layer check that runs before any confidential data is read.
async function accessFor(user, r) {
  if (isStaff(user)) return { full: true, reason: 'staff' };
  if (isLister(user, r)) return { full: true, reason: 'lister' };
  if (!user) return { full: false, gates: { signedIn: false, qualified: false, ndaSigned: false, approved: false } };
  const gates = await require('./dealRoom.service').evaluate(r.property_id, user);
  return { full: gates.open, reason: gates.open ? 'buyer' : null, gates: { signedIn: true, qualified: gates.verified, ndaSigned: gates.ndaSigned, approved: gates.approved, status: gates.status } };
}

// Certified institutional brokers, institutional sellers (their own asset) and staff may list.
async function assertCanList(user) {
  if (isStaff(user) || user.role === 'customer') return;
  if (['broker', 'agency_admin'].includes(user.role)) {
    const cert = await pool.query(`SELECT 1 FROM user_verifications WHERE user_id = $1 AND kind = 'institutional_cert' AND status = 'verified'`, [user.id]);
    if (cert.rows.length) return;
    throw forbidden('Only certified institutional brokers can list institutional assets - submit your institutional broker certification under Trust & Reviews');
  }
  throw forbidden('You cannot list institutional assets');
}

// ------------------------------------------------------------ listings

const FIELDS = {
  institutionName: 'institution_name', assetClass: 'asset_class', subType: 'sub_type', boardAffiliation: 'board_affiliation', yearEstablished: 'year_established',
  campusAreaSqft: 'campus_area_sqft', campusAreaAcres: 'campus_area_acres', builtUpAreaSqft: 'built_up_area_sqft', buildingCount: 'building_count',
  infrastructure: 'infrastructure', studentEnrollment: 'student_enrollment', facultyCount: 'faculty_count', capacityUnits: 'capacity_units', capacityLabel: 'capacity_label',
  enrollmentHistory: 'enrollment_history', nocStatus: 'noc_status', approvals: 'approvals', landOwnership: 'land_ownership', dealType: 'deal_type',
  askingPriceCr: 'asking_price_cr', annualRevenueCr: 'annual_revenue_cr', ebitdaCr: 'ebitda_cr', revenueMultiple: 'revenue_multiple', ebitdaMultiple: 'ebitda_multiple',
  isConfidential: 'is_confidential',
};
const JSON_FIELDS = new Set(['enrollmentHistory', 'approvals']);

function cleanInput(data) {
  const out = { ...data };
  if (out.approvals !== undefined) {
    out.approvals = (Array.isArray(out.approvals) ? out.approvals : []).slice(0, 20).map((a) => ({ name: String(a.name || '').slice(0, 120), status: ['valid', 'pending', 'expired', 'not_applicable'].includes(a.status) ? a.status : 'pending' })).filter((a) => a.name);
  }
  if (out.enrollmentHistory !== undefined) {
    out.enrollmentHistory = (Array.isArray(out.enrollmentHistory) ? out.enrollmentHistory : []).slice(0, 15).map((e) => ({ year: Number(e.year), count: Number(e.count) })).filter((e) => e.year > 1950 && e.year < 2100 && e.count >= 0).sort((a, b) => a.year - b.year);
  }
  // Acres <-> sq ft kept in step (1 acre = 43,560 sq ft).
  if (out.campusAreaAcres && !out.campusAreaSqft) out.campusAreaSqft = Math.round(Number(out.campusAreaAcres) * 43560);
  if (out.campusAreaSqft && !out.campusAreaAcres) out.campusAreaAcres = Math.round((Number(out.campusAreaSqft) / 43560) * 100) / 100;
  // Indicative multiples from the self-reported figures when not given.
  if (out.askingPriceCr && out.ebitdaCr && !out.ebitdaMultiple) out.ebitdaMultiple = Math.round((out.askingPriceCr / out.ebitdaCr) * 100) / 100;
  if (out.askingPriceCr && out.annualRevenueCr && !out.revenueMultiple) out.revenueMultiple = Math.round((out.askingPriceCr / out.annualRevenueCr) * 100) / 100;
  return out;
}

async function createListing(user, input, meta = {}) {
  await assertCanList(user);
  const data = cleanInput(input);
  if (!ASSET_CLASSES[data.assetClass]) throw badRequest('Choose the type of institution');
  if (!data.institutionName || !data.city) throw badRequest('Institution name and city are required');
  // Geolocation is mandatory on institutional listings (geo-validation, trust scoring).
  const lat = num(data.latitude);
  const lng = num(data.longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Pin the campus on the map - latitude and longitude are required');
  if (!(num(data.askingPriceCr) > 0)) throw badRequest('Asking price (in crores) is required');
  await assertCleanContent({ infrastructure: data.infrastructure, subType: data.subType }, { blockContact: true });

  const staff = isStaff(user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const price = Number(data.askingPriceCr);
    const p = (
      await client.query(
        `INSERT INTO properties (tenant_id, created_by, broker_id, title, description, property_type, transaction_type, price, price_value, city, locality, address,
           latitude, longitude, area_sqft, listing_category, is_institutional_asset, status, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, 'commercial', $6, $7, $8, $9, $10, $11, $12, $13, $14, 'institutional', true, $15, $16, $17)
         RETURNING id`,
        [
          user.tenant_id || null, user.id, ['broker', 'agency_admin'].includes(user.role) ? user.id : null,
          maskedTitle(data.assetClass, data.locality, data.city),
          `${ASSET_CLASSES[data.assetClass]} - ${DEAL_TYPES[data.dealType || 'full_sale']}. Details are confidential and shared with verified buyers under NDA.`,
          data.dealType === 'lease' ? 'rent' : 'sell', `${price} Cr`, Math.round(price * 1e7), data.city, data.locality || null, data.address || null,
          lat, lng, num(data.campusAreaSqft), staff ? 'approved' : 'pending_approval', staff ? user.id : null, staff ? new Date() : null,
        ]
      )
    ).rows[0];
    const cols = Object.entries(FIELDS).filter(([k]) => data[k] !== undefined && data[k] !== '');
    await client.query(
      `INSERT INTO institutional_listings (property_id, seller_user_id, ${cols.map(([, c]) => c).join(', ')})
       VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})`,
      [p.id, user.role === 'customer' ? user.id : data.sellerUserId || null, ...cols.map(([k]) => (JSON_FIELDS.has(k) ? JSON.stringify(data[k]) : data[k]))]
    );
    await client.query('COMMIT');
    await auditService.log({ actor: user, action: 'institutional.listing_created', entityType: 'property', entityId: p.id, after: { assetClass: data.assetClass, city: data.city, dealType: data.dealType }, ...meta });
    if (!staff) {
      const admins = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
      for (const a of admins.rows) {
        await notificationService.createNotification({ userId: a.id, type: 'institutional_listing', title: 'Institutional listing to review', message: `${maskedTitle(data.assetClass, data.locality, data.city)} was submitted for approval.`, relatedEntityType: 'property', relatedEntityId: p.id });
      }
    }
    await require('./institutionalValuation.service').refresh(p.id).catch(() => {});
    return fullView(await row(p.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function updateListing(user, propertyId, input, meta = {}) {
  const r = await row(propertyId);
  if (!isStaff(user) && !isLister(user, r)) throw forbidden('Not your listing');
  const data = cleanInput(input);
  if (data.assetClass && !ASSET_CLASSES[data.assetClass]) throw badRequest('Unknown type of institution');
  await assertCleanContent({ infrastructure: data.infrastructure, subType: data.subType }, { blockContact: true });
  const cols = Object.entries(FIELDS).filter(([k]) => data[k] !== undefined);
  if (cols.length) {
    await pool.query(
      `UPDATE institutional_listings SET ${cols.map(([, c], i) => `${c} = $${i + 1}`).join(', ')} WHERE property_id = $${cols.length + 1}`,
      [...cols.map(([k]) => (JSON_FIELDS.has(k) ? JSON.stringify(data[k]) : data[k] === '' ? null : data[k])), propertyId]
    );
  }
  // Keep the public row in step - it still never carries the name.
  const next = await row(propertyId);
  const sets = [];
  const params = [];
  const set = (col, v) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  for (const [key, col] of [['city', 'city'], ['locality', 'locality'], ['address', 'address']]) if (data[key] !== undefined) set(col, data[key] || null);
  if (data.latitude !== undefined && data.longitude !== undefined) {
    if (num(data.latitude) === null || num(data.longitude) === null) throw badRequest('Latitude and longitude are required');
    set('latitude', num(data.latitude));
    set('longitude', num(data.longitude));
  }
  set('title', maskedTitle(next.asset_class, data.locality !== undefined ? data.locality : next.locality, data.city || next.city));
  if (next.asking_price_cr !== null) {
    set('price', `${Number(next.asking_price_cr)} Cr`);
    set('price_value', Math.round(Number(next.asking_price_cr) * 1e7));
  }
  set('area_sqft', num(next.campus_area_sqft));
  set('transaction_type', next.deal_type === 'lease' ? 'rent' : 'sell');
  params.push(propertyId);
  await pool.query(`UPDATE properties SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  await auditService.log({ actor: user, action: 'institutional.listing_updated', entityType: 'property', entityId: propertyId, after: { fields: cols.map(([k]) => k) }, ...meta });
  await require('./institutionalValuation.service').refresh(propertyId).catch(() => {});
  return fullView(await row(propertyId));
}

// Public, masked list with the institutional filters (sec. 21.1).
async function listPublic({ assetClass, sector, board, dealType, city, budgetMinCr, budgetMaxCr, campusMinAcres, campusMaxAcres, limit = 30, page = 1 } = {}) {
  const where = [`p.status = 'approved'`];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (assetClass) add('il.asset_class = ?', assetClass);
  if (sector) add('il.asset_class = ANY(?::text[])', Object.keys(SECTOR).filter((k) => SECTOR[k] === sector));
  if (board) add('il.board_affiliation ILIKE ?', `%${board}%`);
  if (dealType) add('il.deal_type = ?', dealType);
  if (city) add('p.city ILIKE ?', city);
  if (num(budgetMinCr) !== null) add('il.asking_price_cr >= ?', num(budgetMinCr));
  if (num(budgetMaxCr) !== null) add('il.asking_price_cr <= ?', num(budgetMaxCr));
  if (num(campusMinAcres) !== null) add('il.campus_area_acres >= ?', num(campusMinAcres));
  if (num(campusMaxAcres) !== null) add('il.campus_area_acres <= ?', num(campusMaxAcres));
  const lim = Math.min(60, Math.max(1, Number(limit) || 30));
  const pg = Math.max(1, Number(page) || 1);
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM institutional_listings il JOIN properties p ON p.id = il.property_id WHERE ${where.join(' AND ')}`, params)).rows[0].n;
  params.push(lim, (pg - 1) * lim);
  const rows = await pool.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows.rows.map(publicView), pagination: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) }, disclaimer: await disclaimer() };
}

// One listing: masked, or everything once the caller is entitled to it.
async function getListing(user, propertyId) {
  const r = await row(propertyId);
  const access = await accessFor(user, r);
  if (!access.full && r.status !== 'approved') throw notFound('Institutional listing not found');
  const base = { access: { full: access.full, as: access.reason, gates: access.gates || null }, disclaimer: await disclaimer() };
  const myDeal = user
    ? (await pool.query(`SELECT id, deal_number, stage, status FROM institutional_deals WHERE property_id = $1 AND buyer_user_id = $2 ORDER BY created_at DESC LIMIT 1`, [propertyId, user.id])).rows[0] || null
    : null;
  if (!access.full) return { ...base, listing: publicView(r), myDeal };
  const listing = fullView(r);
  // The representative is the buyer's only point of contact (controlled contact).
  let representative = null;
  if (myDeal) {
    const rep = (await pool.query('SELECT rep_id FROM institutional_deals WHERE id = $1', [myDeal.id])).rows[0];
    representative = await require('./assignment.service').repCard(rep?.rep_id).catch(() => null);
  }
  return { ...base, listing, valuation: r.valuation || null, dueDiligence: await dueDiligence(propertyId, { internal: isStaff(user) || isLister(user, r) }), representative, myDeal };
}

async function myListings(user) {
  const rows = await pool.query(`${SELECT} WHERE p.created_by = $1 OR p.broker_id = $1 OR il.seller_user_id = $1 ORDER BY p.created_at DESC`, [user.id]);
  const out = [];
  for (const r of rows.rows) {
    const deals = await pool.query(`SELECT stage, status, COUNT(*)::int AS n FROM institutional_deals WHERE property_id = $1 GROUP BY 1, 2`, [r.property_id]);
    out.push({ ...fullView(r), interest: { total: deals.rows.reduce((s, d) => s + d.n, 0), active: deals.rows.filter((d) => d.status === 'active').reduce((s, d) => s + d.n, 0) } });
  }
  return out;
}

async function listForStaff({ status, assetClass, search } = {}) {
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`p.status::text = $${params.length}`);
  }
  if (assetClass) {
    params.push(assetClass);
    where.push(`il.asset_class = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(il.institution_name ILIKE $${params.length} OR p.city ILIKE $${params.length} OR p.locality ILIKE $${params.length})`);
  }
  const rows = await pool.query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT 300`,
    params
  );
  const counts = await pool.query(`SELECT property_id, COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*)::int AS total FROM institutional_deals GROUP BY 1`);
  const byId = Object.fromEntries(counts.rows.map((c) => [c.property_id, c]));
  return rows.rows.map((r) => ({ ...fullView(r), deals: byId[r.property_id] || { active: 0, total: 0 }, valuationRange: r.valuation?.indicativeRange || null }));
}

// ------------------------------------------------------------ buyers (Stage 2)

function buyerView(b) {
  if (!b) return null;
  return {
    userId: b.user_id, buyerType: b.buyer_type, buyerTypeLabel: BUYER_TYPES[b.buyer_type], organisationName: b.organisation_name, budgetMinCr: num(b.budget_min_cr), budgetMaxCr: num(b.budget_max_cr),
    geographies: b.geographies || [], assetClasses: b.asset_classes || [], intent: b.intent, capacityNote: b.capacity_note, hasCapacityDocument: !!b.capacity_document,
    status: b.status, decisionNote: b.decision_note, decidedAt: b.decided_at, updatedAt: b.updated_at,
  };
}

async function getBuyerProfile(userId) {
  return buyerView((await pool.query('SELECT * FROM institutional_buyers WHERE user_id = $1', [userId])).rows[0]);
}

async function saveBuyerProfile(user, data, file, meta = {}) {
  if (isStaff(user)) throw badRequest('Staff do not need a buyer profile');
  if (!BUYER_TYPES[data.buyerType]) throw badRequest('Choose the type of buyer');
  await assertCleanContent({ intent: data.intent, capacityNote: data.capacityNote }, { blockContact: true });
  let path = null;
  if (file) {
    const { uploadBuffer } = require('../utils/storage');
    path = await uploadBuffer(file.buffer, `institutional/buyers/${user.id}`, file.originalname, file.mimetype);
  }
  const list = (v) => JSON.stringify((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 20));
  const r = await pool.query(
    `INSERT INTO institutional_buyers (user_id, buyer_type, organisation_name, budget_min_cr, budget_max_cr, geographies, asset_classes, intent, capacity_note, capacity_document, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     ON CONFLICT (user_id) DO UPDATE SET buyer_type = EXCLUDED.buyer_type, organisation_name = EXCLUDED.organisation_name, budget_min_cr = EXCLUDED.budget_min_cr,
       budget_max_cr = EXCLUDED.budget_max_cr, geographies = EXCLUDED.geographies, asset_classes = EXCLUDED.asset_classes, intent = EXCLUDED.intent,
       capacity_note = EXCLUDED.capacity_note, capacity_document = COALESCE(EXCLUDED.capacity_document, institutional_buyers.capacity_document),
       -- A qualified buyer stays qualified unless the facts that were checked change.
       status = CASE WHEN institutional_buyers.status = 'qualified' AND institutional_buyers.buyer_type = EXCLUDED.buyer_type
                      AND institutional_buyers.budget_max_cr IS NOT DISTINCT FROM EXCLUDED.budget_max_cr AND EXCLUDED.capacity_document IS NULL
                     THEN 'qualified' ELSE 'pending' END
     RETURNING *`,
    [user.id, data.buyerType, data.organisationName || null, num(data.budgetMinCr), num(data.budgetMaxCr), list(data.geographies), list(data.assetClasses), data.intent || null, data.capacityNote || null, path]
  );
  await auditService.log({ actor: user, action: 'institutional.buyer_profile_saved', entityType: 'user', entityId: user.id, after: { buyerType: data.buyerType, status: r.rows[0].status }, ...meta });
  if (r.rows[0].status === 'pending') {
    const staff = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin', 'internal_sales') AND u.status = 'active'`);
    for (const s of staff.rows) await notificationService.createNotification({ userId: s.id, type: 'institutional_buyer', title: 'Institutional buyer to qualify', message: `${BUYER_TYPES[data.buyerType]}${data.organisationName ? ` (${data.organisationName})` : ''} submitted a buyer profile.`, relatedEntityType: 'user', relatedEntityId: user.id });
  }
  return buyerView(r.rows[0]);
}

async function listBuyers({ status } = {}) {
  const r = await pool.query(
    `SELECT b.*, u.full_name, u.email, u.mobile,
            (SELECT COUNT(*)::int FROM institutional_deals d WHERE d.buyer_user_id = b.user_id AND d.status = 'active') AS active_deals
     FROM institutional_buyers b JOIN users u ON u.id = b.user_id
     ${status ? 'WHERE b.status = $1' : ''} ORDER BY (b.status = 'pending') DESC, b.updated_at DESC LIMIT 300`,
    status ? [status] : []
  );
  return r.rows.map((b) => ({ ...buyerView(b), fullName: b.full_name, email: b.email, mobile: b.mobile, activeDeals: b.active_deals }));
}

async function buyerCapacityDocumentUrl(userId) {
  const b = (await pool.query('SELECT capacity_document FROM institutional_buyers WHERE user_id = $1', [userId])).rows[0];
  if (!b?.capacity_document) throw notFound('No document on file');
  return { url: await require('../utils/storage').generateSignedReadUrl(b.capacity_document) };
}

async function decideBuyer(user, buyerUserId, { decision, note }, meta = {}) {
  if (!['qualified', 'rejected'].includes(decision)) throw badRequest('decision must be qualified or rejected');
  if (decision === 'rejected' && !note) throw badRequest('Give the reason');
  const r = await pool.query(
    `UPDATE institutional_buyers SET status = $1, decision_note = $2, decided_by = $3, decided_at = now() WHERE user_id = $4 RETURNING *`,
    [decision, note || null, user.id, buyerUserId]
  );
  if (!r.rows[0]) throw notFound('Buyer profile not found');
  await auditService.log({ actor: user, action: `institutional.buyer_${decision}`, entityType: 'user', entityId: buyerUserId, after: { note }, ...meta });
  await notificationService.createNotification({
    userId: buyerUserId, type: 'institutional_buyer',
    title: decision === 'qualified' ? 'You are a verified institutional buyer' : 'Institutional buyer profile needs changes',
    message: decision === 'qualified' ? 'You can now sign the NDA on an institutional listing to request its data room.' : `Your buyer profile was not approved: ${note}`,
    relatedEntityType: 'user', relatedEntityId: buyerUserId,
  });
  await evaluateBuyerDeals(buyerUserId);
  return buyerView(r.rows[0]);
}

// ------------------------------------------------------------ pipeline

async function logEvent(dealId, kind, { from = null, to = null, detail = {}, actorId = null } = {}) {
  await pool.query(`INSERT INTO institutional_deal_events (deal_id, kind, from_stage, to_stage, detail, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`, [dealId, kind, from, to, JSON.stringify(detail), actorId]);
}

async function loadDeal(dealId) {
  const d = (await pool.query('SELECT * FROM institutional_deals WHERE id = $1', [dealId])).rows[0];
  if (!d) throw notFound('Institutional deal not found');
  return d;
}

// What each stage needs before a deal can enter it: [{ key, label, met }].
async function requirementsFor(deal, stage) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows[0]);
  const access = deal.buyer_user_id ? await q('SELECT status, nda_signed_at, access_expires_at FROM deal_room_access WHERE property_id = $1 AND user_id = $2', [deal.property_id, deal.buyer_user_id]) : null;
  switch (stage) {
    case 'buyer_qualification':
      return [{ key: 'screened', label: 'Intent screened by the representative', met: !!deal.screened_at }];
    case 'nda_executed':
      return [
        { key: 'registered', label: 'Buyer has a platform account', met: !!deal.buyer_user_id },
        { key: 'qualified', label: 'Buyer qualified (verified buyer, financial capacity checked)', met: await isQualifiedBuyer(deal.buyer_user_id) },
        { key: 'nda', label: 'NDA signed on the platform', met: !!access?.nda_signed_at },
      ];
    case 'data_room_access':
      return [{ key: 'approved', label: 'Data-room access approved by an admin', met: access?.status === 'approved' && !(access.access_expires_at && new Date(access.access_expires_at) < new Date()) }];
    case 'site_visit':
      return [{ key: 'visit_scheduled', label: 'Campus visit scheduled', met: !!deal.site_visit_at }];
    case 'valuation_discussion':
      return [{ key: 'visit_done', label: 'Campus visit completed', met: !!deal.site_visit_done_at }];
    case 'legal_due_diligence':
      return [{ key: 'valuation_shared', label: 'Valuation shared with the buyer', met: !!deal.valuation_shared_at }];
    case 'offer_negotiation':
      return [{ key: 'legal_cleared', label: 'Legal due diligence cleared by the legal panel', met: !!deal.legal_cleared_at }];
    case 'closure': {
      const accepted = await q(`SELECT 1 AS ok FROM institutional_offers WHERE deal_id = $1 AND status = 'accepted' LIMIT 1`, [deal.id]);
      return [{ key: 'offer_accepted', label: 'Offer / term sheet accepted', met: !!accepted }];
    }
    default:
      return [];
  }
}

const nextStage = (stage) => STAGES[STAGES.indexOf(stage) + 1] || null;

async function setStage(deal, to, actorId, kind = 'stage', detail = {}) {
  await pool.query(`UPDATE institutional_deals SET stage = $1, stage_entered_at = now() WHERE id = $2`, [to, deal.id]);
  await logEvent(deal.id, kind, { from: deal.stage, to, detail, actorId });
  if (deal.buyer_user_id) {
    await notificationService.createNotification({
      userId: deal.buyer_user_id, type: 'institutional_deal', title: `Your institutional deal moved to ${STAGE_LABEL[to]}`,
      message: `Deal ${deal.deal_number} is now at stage ${STAGES.indexOf(to) + 1} of 9: ${STAGE_LABEL[to]}.`, relatedEntityType: 'institutional_deal', relatedEntityId: deal.id,
    });
  }
  if (deal.rep_id && deal.rep_id !== actorId) {
    await notificationService.createNotification({ userId: deal.rep_id, type: 'institutional_deal', title: `${deal.deal_number} → ${STAGE_LABEL[to]}`, message: 'Institutional deal moved stage.', relatedEntityType: 'institutional_deal', relatedEntityId: deal.id });
  }
}

// Move the deal forward while the next stage's requirements are met.
async function evaluate(dealId, actorId = null) {
  let deal = await loadDeal(dealId);
  const moved = [];
  for (let i = 0; i < STAGES.length && deal.status === 'active'; i += 1) {
    const next = nextStage(deal.stage);
    if (!next) break;
    const reqs = await requirementsFor(deal, next);
    if (reqs.some((r) => !r.met)) break;
    await setStage(deal, next, actorId, 'stage', { auto: true, met: reqs.map((r) => r.key) });
    moved.push(next);
    deal = await loadDeal(dealId);
  }
  return { stage: deal.stage, moved };
}

async function evaluateBuyerDeals(buyerUserId, propertyId = null) {
  const r = await pool.query(
    `SELECT id FROM institutional_deals WHERE buyer_user_id = $1 AND status = 'active' ${propertyId ? 'AND property_id = $2' : ''}`,
    propertyId ? [buyerUserId, propertyId] : [buyerUserId]
  );
  for (const d of r.rows) await evaluate(d.id).catch((err) => console.error('[institutional] evaluate failed:', err.message));
}

async function nextNumber() {
  const n = (await pool.query(`SELECT nextval('institutional_deal_seq') AS n`)).rows[0].n;
  return `INST-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// Stage 1 - intake. Creates the CRM lead through the assignment cascade
// (the representative is the buyer's only contact) and the pipeline record.
async function expressInterest(user, propertyId, { message } = {}, meta = {}) {
  const r = await row(propertyId);
  if (r.status !== 'approved') throw notFound('This listing is not available');
  if (isStaff(user)) throw badRequest('Staff open deals from the CRM');
  if (isLister(user, r)) throw badRequest('This is your own listing');
  const live = (await pool.query(`SELECT id FROM institutional_deals WHERE property_id = $1 AND buyer_user_id = $2 AND status IN ('active', 'on_hold')`, [propertyId, user.id])).rows[0];
  if (live) return dealView(user, live.id);
  await assertCleanContent({ message }, { blockContact: true });
  const u = (await pool.query('SELECT full_name, email, mobile FROM users WHERE id = $1', [user.id])).rows[0];
  const lead = await require('./lead.service').createPublicInquiry({
    fullName: u.full_name, email: u.email || undefined, mobile: u.mobile || undefined, propertyId, source: 'website',
    topic: 'Institutional interest', enquiryType: 'institutional', message: `[Institutional interest] ${maskedTitle(r.asset_class, r.locality, r.city)}${message ? ` - ${message}` : ''}`,
    details: { institutionType: ASSET_CLASSES[r.asset_class] }, skipInstitutionalHook: true,
  });
  const deal = await createDealRecord({ propertyId, buyerUserId: user.id, customerId: lead.customer_id, leadId: lead.id, repId: lead.arb_rep_id || lead.assigned_to || null, source: 'platform', actorId: user.id });
  await auditService.log({ actor: user, action: 'institutional.interest', entityType: 'institutional_deal', entityId: deal.id, after: { propertyId }, ...meta });
  return dealView(user, deal.id);
}

async function createDealRecord({ propertyId, buyerUserId = null, customerId = null, leadId = null, repId = null, source = 'platform', actorId = null }) {
  const number = await nextNumber();
  const d = (
    await pool.query(
      `INSERT INTO institutional_deals (deal_number, property_id, buyer_user_id, customer_id, lead_id, rep_id, source) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [number, propertyId, buyerUserId, customerId, leadId, repId, source]
    )
  ).rows[0];
  await logEvent(d.id, 'created', { to: 'intent_received', detail: { source }, actorId });
  if (repId) await notificationService.createNotification({ userId: repId, type: 'institutional_deal', title: 'New institutional intent', message: `${number} - screen the buyer's intent.`, relatedEntityType: 'institutional_deal', relatedEntityId: d.id });
  return d;
}

// Enquiries on an institutional listing that arrive by other routes (guest
// interest, call-back form, WhatsApp) also open a pipeline record.
async function onLeadCreated(lead, source = 'guest') {
  if (!lead?.property_id) return;
  const inst = (await pool.query('SELECT 1 FROM institutional_listings WHERE property_id = $1', [lead.property_id])).rows[0];
  if (!inst) return;
  const exists = (await pool.query('SELECT 1 FROM institutional_deals WHERE lead_id = $1', [lead.id])).rows[0];
  if (exists) return;
  const buyer = lead.customer_id ? (await pool.query('SELECT user_id FROM customers WHERE id = $1', [lead.customer_id])).rows[0]?.user_id || null : null;
  if (buyer) {
    const live = (await pool.query(`SELECT 1 FROM institutional_deals WHERE property_id = $1 AND buyer_user_id = $2 AND status IN ('active', 'on_hold')`, [lead.property_id, buyer])).rows[0];
    if (live) return;
  }
  await createDealRecord({ propertyId: lead.property_id, buyerUserId: buyer, customerId: lead.customer_id, leadId: lead.id, repId: lead.arb_rep_id || lead.assigned_to || null, source });
}

async function staffCreateDeal(user, { propertyId, buyerUserId, customerId }, meta = {}) {
  await row(propertyId);
  if (!buyerUserId && !customerId) throw badRequest('Choose the buyer');
  let cust = customerId || null;
  if (buyerUserId && !cust) cust = (await pool.query('SELECT id FROM customers WHERE user_id = $1', [buyerUserId])).rows[0]?.id || null;
  if (buyerUserId) {
    const live = (await pool.query(`SELECT id FROM institutional_deals WHERE property_id = $1 AND buyer_user_id = $2 AND status IN ('active', 'on_hold')`, [propertyId, buyerUserId])).rows[0];
    if (live) throw badRequest('This buyer already has a live deal on this asset');
  }
  const d = await createDealRecord({ propertyId, buyerUserId: buyerUserId || null, customerId: cust, repId: user.id, source: 'crm', actorId: user.id });
  await auditService.log({ actor: user, action: 'institutional.deal_created', entityType: 'institutional_deal', entityId: d.id, after: { propertyId, buyerUserId }, ...meta });
  return dealView(user, d.id);
}

async function assertStaffDeal(user, dealId) {
  if (!isStaff(user)) throw forbidden('A R staff only');
  const d = await loadDeal(dealId);
  if (d.status === 'closed_won' || d.status === 'dropped') throw badRequest('This deal is closed');
  return d;
}

// Staff actions. Each records what happened; evaluate() then moves the stage.
async function act(user, dealId, action, body = {}, meta = {}) {
  const d = await assertStaffDeal(user, dealId);
  const upd = (sql, params) => pool.query(`UPDATE institutional_deals SET ${sql} WHERE id = $${params.length + 1}`, [...params, dealId]);
  const future = (v) => {
    const t = new Date(v);
    if (Number.isNaN(t.getTime())) throw badRequest('Give a valid date and time');
    return t;
  };
  switch (action) {
    case 'screen':
      await upd('screened_at = now(), rep_id = COALESCE(rep_id, $1)', [user.id]);
      await logEvent(dealId, 'note', { detail: { text: `Intent screened${body.note ? `: ${body.note}` : ''}` }, actorId: user.id });
      break;
    case 'schedule_visit': {
      const when = future(body.at);
      await upd('site_visit_at = $1, site_visit_done_at = NULL', [when]);
      await logEvent(dealId, 'site_visit', { detail: { scheduledAt: when, note: body.note || null }, actorId: user.id });
      if (d.buyer_user_id) await notificationService.createNotification({ userId: d.buyer_user_id, type: 'institutional_deal', title: 'Campus visit scheduled', message: `Your campus visit for ${d.deal_number} is on ${when.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`, relatedEntityType: 'institutional_deal', relatedEntityId: dealId });
      break;
    }
    case 'complete_visit':
      if (!d.site_visit_at) throw badRequest('Schedule the campus visit first');
      await upd('site_visit_done_at = now()', []);
      await logEvent(dealId, 'site_visit', { detail: { completed: true, note: body.note || null }, actorId: user.id });
      break;
    case 'share_valuation': {
      const v = await require('./institutionalValuation.service').refresh(d.property_id);
      await upd('valuation_shared_at = now()', []);
      await logEvent(dealId, 'valuation', { detail: { range: v.indicativeRange, note: body.note || null }, actorId: user.id });
      break;
    }
    case 'clear_legal':
      if (!body.note) throw badRequest("Record the legal panel's finding");
      await upd('legal_cleared_at = now(), legal_notes = $1', [String(body.note).slice(0, 4000)]);
      await logEvent(dealId, 'legal', { detail: { cleared: true, note: body.note }, actorId: user.id });
      break;
    case 'note':
      if (!body.note) throw badRequest('Write the note');
      await logEvent(dealId, 'note', { detail: { text: String(body.note).slice(0, 4000) }, actorId: user.id });
      break;
    case 'hold':
      await upd(`status = 'on_hold'`, []);
      await logEvent(dealId, 'hold', { detail: { on: true, reason: body.note || null }, actorId: user.id });
      break;
    case 'resume':
      await upd(`status = 'active'`, []);
      await logEvent(dealId, 'hold', { detail: { on: false }, actorId: user.id });
      break;
    case 'drop':
      if (!body.note) throw badRequest('Give the reason');
      await upd(`status = 'dropped', drop_reason = $1, closed_at = now()`, [String(body.note).slice(0, 1000)]);
      await logEvent(dealId, 'dropped', { detail: { reason: body.note }, actorId: user.id });
      break;
    case 'assign':
      await upd('rep_id = $1', [body.repId]);
      await logEvent(dealId, 'note', { detail: { text: 'Representative assigned' }, actorId: user.id });
      break;
    case 'move': {
      // Admin override, with a logged reason.
      if (!ADMIN.includes(user.role)) throw forbidden('Only admins can move a stage by hand');
      if (!STAGES.includes(body.stage)) throw badRequest('Unknown stage');
      if (!body.note) throw badRequest('Give the reason for the override');
      await setStage(d, body.stage, user.id, 'override', { reason: body.note });
      await auditService.log({ actor: user, action: 'institutional.stage_override', entityType: 'institutional_deal', entityId: dealId, after: { from: d.stage, to: body.stage, reason: body.note }, ...meta });
      return dealView(user, dealId);
    }
    default:
      throw badRequest('Unknown action');
  }
  await auditService.log({ actor: user, action: `institutional.${action}`, entityType: 'institutional_deal', entityId: dealId, after: body, ...meta });
  if (!['hold', 'drop', 'note', 'assign'].includes(action)) await evaluate(dealId, user.id);
  return dealView(user, dealId);
}

// Stage 8 - term sheets, offers and counter-offers.
async function addOffer(user, dealId, { kind, byParty, amountCr, terms }, meta = {}) {
  const d = await loadDeal(dealId);
  const staff = isStaff(user);
  if (!staff && d.buyer_user_id !== user.id) throw forbidden('Not your deal');
  if (d.status !== 'active') throw badRequest('This deal is not active');
  if (STAGES.indexOf(d.stage) < STAGES.indexOf('offer_negotiation')) throw badRequest('Offers open once legal due diligence is cleared (stage 8)');
  if (!(Number(amountCr) > 0)) throw badRequest('Give the amount in crores');
  await assertCleanContent({ terms }, { blockContact: true });
  const k = staff ? (['term_sheet', 'offer', 'counter_offer'].includes(kind) ? kind : 'term_sheet') : 'offer';
  const party = staff ? (['buyer', 'seller', 'platform'].includes(byParty) ? byParty : 'platform') : 'buyer';
  await pool.query(`UPDATE institutional_offers SET status = 'superseded' WHERE deal_id = $1 AND status = 'open'`, [dealId]);
  const o = (await pool.query(`INSERT INTO institutional_offers (deal_id, kind, by_party, amount_cr, terms, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [dealId, k, party, Number(amountCr), terms || null, user.id])).rows[0];
  await logEvent(dealId, 'offer', { detail: { offerId: o.id, kind: k, byParty: party, amountCr: Number(amountCr) }, actorId: user.id });
  const notify = staff ? d.buyer_user_id : d.rep_id;
  if (notify) await notificationService.createNotification({ userId: notify, type: 'institutional_deal', title: `${k === 'term_sheet' ? 'Term sheet' : k === 'offer' ? 'Offer' : 'Counter-offer'} on ${d.deal_number}`, message: `${cr(amountCr)} from the ${party}.`, relatedEntityType: 'institutional_deal', relatedEntityId: dealId });
  await auditService.log({ actor: user, action: 'institutional.offer', entityType: 'institutional_deal', entityId: dealId, after: { kind: k, amountCr }, ...meta });
  return dealView(user, dealId);
}

async function decideOffer(user, offerId, { decision }, meta = {}) {
  if (!isStaff(user)) throw forbidden('A R staff record the decision on an offer');
  if (!['accepted', 'rejected', 'withdrawn'].includes(decision)) throw badRequest('decision must be accepted, rejected or withdrawn');
  const o = (await pool.query(`UPDATE institutional_offers SET status = $1, decided_at = now() WHERE id = $2 AND status = 'open' RETURNING *`, [decision, offerId])).rows[0];
  if (!o) throw notFound('Open offer not found');
  if (decision === 'accepted') await pool.query('UPDATE institutional_deals SET agreed_value_cr = $1 WHERE id = $2', [o.amount_cr, o.deal_id]);
  await logEvent(o.deal_id, 'offer', { detail: { offerId, decision, amountCr: Number(o.amount_cr) }, actorId: user.id });
  await auditService.log({ actor: user, action: `institutional.offer_${decision}`, entityType: 'institutional_deal', entityId: o.deal_id, after: { offerId }, ...meta });
  await evaluate(o.deal_id, user.id);
  return dealView(user, o.deal_id);
}

// Stage 9 - agreement executed + payment confirmed -> deal record created.
async function closeDeal(user, dealId, { agreementDate, paymentConfirmed, agreedValueCr }, meta = {}) {
  const d = await assertStaffDeal(user, dealId);
  if (d.stage !== 'closure') throw badRequest('The deal reaches Closure once an offer is accepted');
  const value = Number(agreedValueCr || d.agreed_value_cr);
  if (!(value > 0)) throw badRequest('Agreed value is missing');
  if (!agreementDate || new Date(agreementDate) > new Date()) throw badRequest('Give the agreement execution date (not in the future)');
  if (!paymentConfirmed) throw badRequest('Confirm that payment has been received by the seller');
  const feePct = Number(await configService.getConfig('institutional.advisory_fee_percent', 1)) || 0;
  const fee = Math.round(value * feePct * 100) / 10000;
  await pool.query(
    `UPDATE institutional_deals SET status = 'closed_won', agreement_date = $1, payment_confirmed_at = now(), agreed_value_cr = $2, advisory_fee_cr = $3, closed_at = now() WHERE id = $4`,
    [agreementDate, value, fee, dealId]
  );
  await logEvent(dealId, 'closed', { detail: { agreementDate, agreedValueCr: value, advisoryFeeCr: fee }, actorId: user.id });
  // Other buyers' deals on this asset end; the listing leaves the market.
  const others = await pool.query(`UPDATE institutional_deals SET status = 'dropped', drop_reason = 'Asset closed with another buyer', closed_at = now() WHERE property_id = $1 AND id <> $2 AND status IN ('active', 'on_hold') RETURNING id`, [d.property_id, dealId]);
  for (const o of others.rows) await logEvent(o.id, 'dropped', { detail: { reason: 'Asset closed with another buyer' }, actorId: user.id });
  await pool.query(`UPDATE properties SET status = 'inactive' WHERE id = $1`, [d.property_id]);
  // A closed platform deal becomes a comparable for future benchmarking.
  const l = await row(d.property_id);
  await pool.query(
    `INSERT INTO institutional_comparables (asset_class, city, deal_type, deal_year, deal_value_cr, revenue_cr, ebitda_cr, enrollment, capacity_units, area_acres, source, deal_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PropertySerch closed deal', $11, $12)`,
    [l.asset_class, l.city, l.deal_type, new Date(agreementDate).getFullYear(), value, l.annual_revenue_cr, l.ebitda_cr, l.student_enrollment, l.capacity_units, l.campus_area_acres, dealId, user.id]
  );
  if (d.lead_id) await pool.query(`UPDATE leads SET status = 'won' WHERE id = $1 AND status NOT IN ('won', 'lost')`, [d.lead_id]).catch(() => {});
  const trust = require('./trust.service');
  for (const id of new Set([l.broker_id, l.created_by].filter(Boolean))) trust.safeRecompute(id, 'institutional_deal_closed');
  for (const id of new Set([d.buyer_user_id, l.seller_user_id, l.created_by].filter(Boolean))) {
    await notificationService.createNotification({ userId: id, type: 'institutional_deal', title: `Institutional deal ${d.deal_number} closed`, message: `Agreement executed on ${new Date(agreementDate).toLocaleDateString('en-IN')}.`, relatedEntityType: 'institutional_deal', relatedEntityId: dealId });
  }
  await auditService.log({ actor: user, action: 'institutional.deal_closed', entityType: 'institutional_deal', entityId: dealId, after: { agreementDate, agreedValueCr: value, advisoryFeeCr: fee }, ...meta });
  return dealView(user, dealId);
}

async function slaDays() {
  return configService.getConfig('institutional.stage_sla_days', {});
}

// The pipeline tracker: stages, what the next one needs, NDA status, log.
async function dealView(user, dealId) {
  const d = await loadDeal(dealId);
  const staff = isStaff(user);
  const l = await row(d.property_id);
  const lister = isLister(user, l);
  if (!staff && d.buyer_user_id !== user.id && !lister) throw forbidden('Not your deal');
  const idx = STAGES.indexOf(d.stage);
  const next = d.status === 'active' ? nextStage(d.stage) : null;
  const access = d.buyer_user_id ? (await pool.query('SELECT status, nda_signed_at, access_expires_at FROM deal_room_access WHERE property_id = $1 AND user_id = $2', [d.property_id, d.buyer_user_id])).rows[0] : null;
  const sla = await slaDays();
  const days = Math.floor((Date.now() - new Date(d.stage_entered_at).getTime()) / 86400000);
  const [events, offers, buyer] = await Promise.all([
    pool.query(`SELECT e.*, u.full_name AS actor_name FROM institutional_deal_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.deal_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [dealId]),
    pool.query(`SELECT o.*, u.full_name AS created_by_name FROM institutional_offers o LEFT JOIN users u ON u.id = o.created_by WHERE o.deal_id = $1 ORDER BY o.created_at DESC`, [dealId]),
    d.buyer_user_id ? pool.query(`SELECT u.full_name, u.email, u.mobile FROM users u WHERE u.id = $1`, [d.buyer_user_id]).then((r) => r.rows[0]) : d.customer_id ? pool.query('SELECT full_name, email, mobile FROM customers WHERE id = $1', [d.customer_id]).then((r) => r.rows[0]) : null,
  ]);
  const closing = d.stage === 'closure' && d.status === 'active';
  const view = {
    id: d.id, dealNumber: d.deal_number, propertyId: d.property_id, status: d.status, stage: d.stage, stageLabel: STAGE_LABEL[d.stage], stageNumber: idx + 1,
    stages: STAGES.map((s, i) => ({ value: s, label: STAGE_LABEL[s], number: i + 1, done: i < idx || d.status === 'closed_won', current: i === idx && d.status !== 'closed_won' })),
    next, nextLabel: next ? STAGE_LABEL[next] : null,
    nextRequirements: next ? await requirementsFor(d, next) : closing ? [{ key: 'agreement', label: 'Agreement executed', met: !!d.agreement_date }, { key: 'payment', label: 'Payment confirmed', met: !!d.payment_confirmed_at }] : [],
    nda: { signed: !!access?.nda_signed_at, signedAt: access?.nda_signed_at || null, access: access ? (access.access_expires_at && new Date(access.access_expires_at) < new Date() ? 'expired' : access.status) : 'not_requested' },
    daysInStage: days, slaDays: sla[d.stage] || null, slaOverdue: d.status === 'active' && !!sla[d.stage] && days > sla[d.stage],
    siteVisitAt: d.site_visit_at, siteVisitDoneAt: d.site_visit_done_at, valuationSharedAt: d.valuation_shared_at, legalClearedAt: d.legal_cleared_at,
    agreedValueCr: num(d.agreed_value_cr), agreementDate: d.agreement_date, closedAt: d.closed_at, dropReason: d.drop_reason, createdAt: d.created_at,
    listing: staff || lister ? { id: l.property_id, institutionName: l.institution_name, title: maskedTitle(l.asset_class, l.locality, l.city), askingPriceCr: num(l.asking_price_cr), assetClassLabel: ASSET_CLASSES[l.asset_class] } : { id: l.property_id, title: maskedTitle(l.asset_class, l.locality, l.city), assetClassLabel: ASSET_CLASSES[l.asset_class] },
    offers: offers.rows.map((o) => ({ id: o.id, kind: o.kind, byParty: o.by_party, amountCr: Number(o.amount_cr), terms: o.terms, status: o.status, createdAt: o.created_at, createdBy: staff ? o.created_by_name : undefined })),
    representative: await require('./assignment.service').repCard(d.rep_id).catch(() => null),
    disclaimer: await disclaimer(),
  };
  if (staff) {
    view.buyer = buyer ? { userId: d.buyer_user_id, fullName: buyer.full_name, email: buyer.email, mobile: buyer.mobile, profile: d.buyer_user_id ? await getBuyerProfile(d.buyer_user_id) : null } : null;
    view.repId = d.rep_id;
    view.leadId = d.lead_id;
    view.source = d.source;
    view.legalNotes = d.legal_notes;
    view.advisoryFeeCr = num(d.advisory_fee_cr);
    view.events = events.rows.map((e) => ({ id: e.id, kind: e.kind, fromStage: e.from_stage, toStage: e.to_stage, detail: e.detail, actorName: e.actor_name, createdAt: e.created_at }));
  } else if (d.buyer_user_id === user.id) {
    // The buyer's timeline: stage moves and offers only - no internal notes.
    view.events = events.rows.filter((e) => ['created', 'stage', 'override', 'site_visit', 'offer', 'closed', 'dropped'].includes(e.kind)).map((e) => ({ id: e.id, kind: e.kind, toStage: e.to_stage, createdAt: e.created_at }));
    // What the buyer has to do next, if anything.
    const todo = (view.nextRequirements || []).filter((r) => !r.met).map((r) => r.key);
    view.yourAction = todo.includes('qualified') ? 'complete_buyer_profile' : todo.includes('nda') ? 'sign_nda' : null;
  }
  return view;
}

async function listDeals(user, { stage, status = 'active', propertyId, search } = {}) {
  if (!isStaff(user)) throw forbidden('A R staff only');
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace(/\?/g, `$${params.length}`));
  };
  if (status && status !== 'all') add('d.status = ?', status);
  if (stage) add('d.stage = ?', stage);
  if (propertyId) add('d.property_id = ?', propertyId);
  if (search) add('(d.deal_number ILIKE ? OR il.institution_name ILIKE ? OR bu.full_name ILIKE ? OR c.full_name ILIKE ?)', `%${search}%`);
  const sla = await slaDays();
  const rows = await pool.query(
    `SELECT d.*, il.institution_name, il.asset_class, il.asking_price_cr, p.city, p.locality, COALESCE(bu.full_name, c.full_name) AS buyer_name, rep.full_name AS rep_name,
            b.status AS buyer_status, a.nda_signed_at, a.status AS access_status
     FROM institutional_deals d JOIN institutional_listings il ON il.property_id = d.property_id JOIN properties p ON p.id = d.property_id
     LEFT JOIN users bu ON bu.id = d.buyer_user_id LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN users rep ON rep.id = d.rep_id
     LEFT JOIN institutional_buyers b ON b.user_id = d.buyer_user_id LEFT JOIN deal_room_access a ON a.property_id = d.property_id AND a.user_id = d.buyer_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC LIMIT 500`,
    params
  );
  const items = rows.rows.map((d) => {
    const days = Math.floor((Date.now() - new Date(d.stage_entered_at).getTime()) / 86400000);
    return {
      id: d.id, dealNumber: d.deal_number, propertyId: d.property_id, institutionName: d.institution_name, assetClassLabel: ASSET_CLASSES[d.asset_class], city: d.city, locality: d.locality,
      askingPriceCr: num(d.asking_price_cr), agreedValueCr: num(d.agreed_value_cr), buyerName: d.buyer_name, buyerStatus: d.buyer_status || (d.buyer_user_id ? 'no_profile' : 'not_registered'),
      ndaSigned: !!d.nda_signed_at, accessStatus: d.access_status || 'not_requested', repName: d.rep_name, stage: d.stage, stageLabel: STAGE_LABEL[d.stage], stageNumber: STAGES.indexOf(d.stage) + 1,
      status: d.status, daysInStage: days, slaOverdue: d.status === 'active' && !!sla[d.stage] && days > sla[d.stage], source: d.source, updatedAt: d.updated_at,
    };
  });
  const counts = await pool.query(`SELECT stage, COUNT(*)::int AS n FROM institutional_deals WHERE status = 'active' GROUP BY 1`);
  const by = Object.fromEntries(counts.rows.map((c) => [c.stage, c.n]));
  return { items, stages: STAGES.map((s, i) => ({ value: s, label: STAGE_LABEL[s], number: i + 1, count: by[s] || 0 })) };
}

async function myDeals(user) {
  const r = await pool.query(`SELECT id FROM institutional_deals WHERE buyer_user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.id]);
  const out = [];
  for (const d of r.rows) out.push(await dealView(user, d.id));
  return out;
}

async function summary() {
  const r = (
    await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM institutional_listings il JOIN properties p ON p.id = il.property_id WHERE p.status = 'approved') AS live_listings,
              (SELECT COUNT(*)::int FROM institutional_listings il JOIN properties p ON p.id = il.property_id WHERE p.status = 'pending_approval') AS listings_pending,
              (SELECT COUNT(*)::int FROM institutional_deals WHERE status = 'active') AS active_deals,
              (SELECT COUNT(*)::int FROM institutional_deals WHERE status = 'closed_won') AS closed_deals,
              (SELECT COALESCE(SUM(agreed_value_cr), 0)::float FROM institutional_deals WHERE status = 'closed_won') AS closed_value_cr,
              (SELECT COALESCE(SUM(il.asking_price_cr), 0)::float FROM institutional_deals d JOIN institutional_listings il ON il.property_id = d.property_id WHERE d.status = 'active') AS pipeline_value_cr,
              (SELECT COUNT(*)::int FROM institutional_buyers WHERE status = 'pending') AS buyers_pending,
              (SELECT COUNT(*)::int FROM institutional_buyers WHERE status = 'qualified') AS buyers_qualified,
              (SELECT COUNT(*)::int FROM institutional_deals WHERE status = 'active' AND stage = 'intent_received' AND screened_at IS NULL) AS intents_to_screen`
    )
  ).rows[0];
  return r;
}

// ------------------------------------------------------------ due diligence (Module 22)

const DOC_LABEL = {
  land_records: 'Land records / title documents', noc: 'NOC from the competent authority', fire_noc: 'Fire NOC', municipal_approval: 'Municipal / building plan approval',
  encumbrance_certificate: 'Encumbrance certificate', audited_financials: 'Audited financial statements', affiliation_certificate: 'Affiliation certificate',
  trust_deed: 'Trust deed / society registration', enrollment_records: 'Enrollment records', regulatory_approval: 'Regulatory licences and approvals',
};

// Checklist against the data-room documents (approved versions), ownership /
// encumbrance / enrollment review by staff, and automated flags for missing
// or lapsed approvals. `internal` adds staff notes.
async function dueDiligence(propertyId, { internal = false } = {}) {
  const l = await row(propertyId);
  const cfg = await configService.getConfig('institutional.dd_checklist', {});
  const sector = SECTOR[l.asset_class] || 'other';
  const required = [...new Set([...(cfg.common || []), ...(cfg[sector] || [])])];
  const docs = await pool.query(
    `SELECT DISTINCT d.document_type FROM deal_room_documents d
     WHERE d.property_id = $1 AND d.is_active AND EXISTS (SELECT 1 FROM deal_room_document_versions v WHERE v.document_id = d.id AND v.status = 'approved')`,
    [propertyId]
  );
  const have = new Set(docs.rows.map((d) => d.document_type));
  // "title_documents" in the room also satisfies land records.
  if (have.has('title_documents')) have.add('land_records');
  if (have.has('financials')) have.add('audited_financials');
  const checklist = required.map((type) => ({ type, label: DOC_LABEL[type] || type.replace(/_/g, ' '), present: have.has(type) }));
  const missing = checklist.filter((c) => !c.present);

  const flags = [];
  const flag = (severity, category, detail) => flags.push({ severity, category, detail, source: 'rules' });
  const approvals = l.approvals || [];
  for (const a of approvals) {
    if (a.status === 'expired') flag('high', 'regulatory', `${a.name}: approval expired`);
    else if (a.status === 'pending') flag('medium', 'regulatory', `${a.name}: approval pending`);
  }
  // Approvals this kind of institution is expected to hold but has not declared.
  for (const expected of EXPECTED_APPROVALS[l.asset_class] || []) {
    const key = expected.split(/[ (/]/)[0].toLowerCase();
    if (!approvals.some((a) => a.name.toLowerCase().includes(key) || expected.toLowerCase().includes(a.name.toLowerCase()))) flag('medium', 'regulatory', `No "${expected}" declared for a ${ASSET_CLASSES[l.asset_class]}`);
  }
  if (l.noc_status === 'expired') flag('high', 'regulatory', 'NOC has expired');
  if (l.noc_status === 'pending') flag('medium', 'regulatory', 'NOC is pending');
  if (l.land_ownership === 'leased') flag('medium', 'ownership', 'Campus land is leased - check the remaining term and assignment rights');
  if (l.land_ownership === 'trust_held') flag('medium', 'ownership', 'Land is held by a trust - transfer needs trust deed review and charity commissioner / registrar consent where applicable');
  if (l.land_ownership === 'mixed') flag('medium', 'ownership', 'Mixed land ownership - validate each parcel');
  if (l.deal_type === 'management_takeover' && sector === 'education') flag('medium', 'structure', 'Management takeover of an educational trust / society - a change of trustees, not a sale of the institution');
  const hist = l.enrollment_history || [];
  if (sector === 'education' && l.student_enrollment && hist.length < 2) flag('low', 'enrollment', 'Enrollment history not provided - current count cannot be cross-checked');
  if (hist.length >= 2) {
    const last = hist[hist.length - 1].count;
    const prev = hist[hist.length - 2].count;
    if (prev > 0 && last < prev * 0.85) flag('medium', 'enrollment', `Enrollment fell ${Math.round((1 - last / prev) * 100)}% in the latest year`);
    if (l.student_enrollment && last > 0 && Math.abs(l.student_enrollment - last) / last > 0.15) flag('medium', 'enrollment', 'Stated enrollment differs from the latest year in the history by more than 15%');
  }
  for (const m of missing) if (['land_records', 'encumbrance_certificate', 'noc', 'trust_deed'].includes(m.type)) flag('medium', 'documents', `${m.label} not in the data room`);

  const review = l.dd_review || {};
  const reviewItems = [
    ['ownershipChain', 'Ownership chain validated (land + building + trust / promoter structure)'],
    ['encumbrance', 'Encumbrance checked (bank loans, charges, litigation)'],
    ['enrollmentAudit', 'Enrollment audit trail verified'],
    ['municipalCompliance', 'RERA / municipal compliance for campus land checked'],
  ].filter(([k]) => sector === 'education' || k !== 'enrollmentAudit');
  const high = flags.some((f) => f.severity === 'high');
  const status = high ? 'issues' : missing.length === 0 && reviewItems.every(([k]) => review[k]?.status === 'ok') ? 'complete' : checklist.some((c) => c.present) || Object.keys(review).length ? 'in_progress' : 'not_started';
  return {
    status, sector, checklist, missingCount: missing.length,
    review: reviewItems.map(([key, label]) => ({ key, label, status: review[key]?.status || 'pending', note: internal ? review[key]?.note || null : undefined, at: review[key]?.at || null })),
    riskFlags: flags, disclaimer: await disclaimer(),
  };
}

async function reviewDueDiligence(user, propertyId, { key, status, note }, meta = {}) {
  if (!isStaff(user)) throw forbidden('A R staff only');
  if (!['ownershipChain', 'encumbrance', 'enrollmentAudit', 'municipalCompliance'].includes(key)) throw badRequest('Unknown review item');
  if (!['ok', 'issue', 'pending'].includes(status)) throw badRequest('status must be ok, issue or pending');
  if (status === 'issue' && !note) throw badRequest('Describe the issue');
  await row(propertyId);
  await pool.query(
    `UPDATE institutional_listings SET dd_review = dd_review || jsonb_build_object($1::text, jsonb_build_object('status', $2::text, 'note', $3::text, 'by', $4::text, 'at', now())) WHERE property_id = $5`,
    [key, status, note || null, user.id, propertyId]
  );
  await auditService.log({ actor: user, action: 'institutional.dd_review', entityType: 'property', entityId: propertyId, after: { key, status, note }, ...meta });
  return dueDiligence(propertyId, { internal: true });
}

// ------------------------------------------------------------ comparables

async function listComparables({ assetClass } = {}) {
  return (await pool.query(`SELECT * FROM institutional_comparables ${assetClass ? 'WHERE asset_class = $1' : ''} ORDER BY deal_year DESC NULLS LAST, created_at DESC LIMIT 500`, assetClass ? [assetClass] : [])).rows;
}

async function addComparable(user, c, meta = {}) {
  if (!ASSET_CLASSES[c.assetClass]) throw badRequest('Choose the asset class');
  if (!(Number(c.dealValueCr) > 0)) throw badRequest('Deal value (in crores) is required');
  const r = await pool.query(
    `INSERT INTO institutional_comparables (asset_class, city, state, deal_type, deal_year, deal_value_cr, revenue_cr, ebitda_cr, enrollment, capacity_units, area_acres, source, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [c.assetClass, c.city || null, c.state || null, c.dealType || null, num(c.dealYear), Number(c.dealValueCr), num(c.revenueCr), num(c.ebitdaCr), num(c.enrollment), num(c.capacityUnits), num(c.areaAcres), c.source || null, c.notes || null, user.id]
  );
  await auditService.log({ actor: user, action: 'institutional.comparable_added', entityType: 'institutional_comparable', entityId: r.rows[0].id, after: c, ...meta });
  await require('./institutionalValuation.service').refreshClass(c.assetClass);
  return r.rows[0];
}

async function removeComparable(user, id, meta = {}) {
  const r = await pool.query('DELETE FROM institutional_comparables WHERE id = $1 AND deal_id IS NULL RETURNING id, asset_class', [id]);
  if (!r.rows[0]) throw notFound('Comparable not found (closed platform deals cannot be removed)');
  await require('./institutionalValuation.service').refreshClass(r.rows[0].asset_class);
  await auditService.log({ actor: user, action: 'institutional.comparable_removed', entityType: 'institutional_comparable', entityId: id, ...meta });
  return { id };
}

module.exports = {
  ASSET_CLASSES, SECTOR, STAGES, STAGE_LABEL, DEAL_TYPES,
  meta, row, isQualifiedBuyer, accessFor,
  createListing, updateListing, listPublic, getListing, myListings, listForStaff,
  getBuyerProfile, saveBuyerProfile, listBuyers, decideBuyer, buyerCapacityDocumentUrl,
  expressInterest, staffCreateDeal, onLeadCreated, act, addOffer, decideOffer, closeDeal, dealView, listDeals, myDeals, evaluate, evaluateBuyerDeals, summary,
  dueDiligence, reviewDueDiligence, listComparables, addComparable, removeComparable,
};
