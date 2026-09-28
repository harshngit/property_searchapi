const pool = require('../config/db');
const configService = require('./config.service');
const customerService = require('./customer.service');
const propertyService = require('./property.service');
const referralService = require('./referral.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { signUrls } = require('../utils/storage');
const { parsePriceToNumber } = require('../utils/price');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Customer portal - the website "Lite Dashboard" (Annexure A sec. 13.1 /
// 13.2A) for a `customer` login acting as buyer, tenant, seller and/or
// owner. Everything here is scoped to the caller's own customer record;
// mandatory intermediation still applies - a seller / owner never sees an
// enquirer's contact details, and a buyer / tenant sees only the assigned
// A R Buildwel representative, never the listing owner.

const PORTAL_ROLES = ['buyer', 'tenant', 'seller', 'owner'];
const PURPOSE_TRANSACTION_TYPES = { buy: ['sell', 'buy'], rent: ['rent'] };

const LEAD_STATUS_LABELS = {
  new: 'Received - a representative will contact you',
  contacted: 'Representative in touch',
  qualified: 'In progress',
  hot: 'In progress',
  warm: 'In progress',
  cold: 'In progress',
  won: 'Closed - deal done',
  lost: 'Closed',
};

const DEAL_STAGE_LABELS = {
  inquiry: 'Enquiry',
  site_visit: 'Site visit',
  negotiation: 'Negotiation',
  booking: 'Booking',
  documentation: 'Documentation',
  payment: 'Payment',
  closed_won: 'Closed - deal done',
  closed_lost: 'Closed',
  on_hold: 'On hold',
};

const DEFAULT_MATCH_WEIGHTS = { location: 40, budget: 35, type: 15, dealType: 10 };

// ------------------------------------------------------------------ helpers

// The caller's customer record - created on first use for a customer login
// that somehow has none (e.g. an account made before customers were linked).
async function resolveCustomer(user) {
  if (user.role !== 'customer') {
    throw forbidden('The customer dashboard is for buyer, tenant, seller and owner accounts - staff and brokers use the CRM');
  }
  const existing = await customerService.getCustomerByUserId(user.id);
  if (existing) return existing;
  const account = await pool.query('SELECT full_name, email, mobile FROM users WHERE id = $1', [user.id]);
  const { full_name: fullName, email, mobile } = account.rows[0] || {};
  return customerService.findOrCreateCustomerByContact({ fullName, email, mobile, userId: user.id });
}

async function listingValidityDays() {
  return Number(await configService.getConfig('listing_validity_days', 90)) || 90;
}

function expiryOf(listing, validityDays) {
  if (listing.status !== 'approved') return null;
  const base = listing.listing_renewed_at || listing.approved_at;
  if (!base) return null;
  return new Date(new Date(base).getTime() + validityDays * 24 * 60 * 60 * 1000);
}

const LISTING_CARD_COLUMNS = `p.id, p.title, p.property_type, p.transaction_type, p.listing_category, p.price, p.price_value,
  p.city, p.locality, p.area_sqft, p.bedrooms, p.bathrooms, p.furnishing, p.is_verified, p.badge, p.tags, p.created_at,
  (SELECT url FROM property_media pm WHERE pm.property_id = p.id
   ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS primary_image`;

// ------------------------------------------------------------------ profile

async function getProfile(user) {
  const customer = await resolveCustomer(user);
  const [account, preferences, closedDeals, referralCount] = await Promise.all([
    pool.query('SELECT id, full_name, email, mobile, referral_code, created_at FROM users WHERE id = $1', [user.id]),
    customerService.getPreferences(customer.id),
    pool.query(`SELECT COUNT(*)::int AS n FROM deals WHERE customer_id = $1 AND stage = 'closed_won'`, [customer.id]),
    referralService.countReferrals(user.id),
  ]);
  const code =
    account.rows[0].referral_code ||
    (await referralService.ensureReferralCode(user.id, user.role, customer.portal_roles || []));
  const [dealThreshold, referralThreshold] = await Promise.all([
    configService.getConfig('full_crm_deal_threshold', 5),
    configService.getConfig('full_crm_referral_threshold', 15),
  ]);

  return {
    user: { ...account.rows[0], referral_code: code },
    customerId: customer.id,
    portalRoles: customer.portal_roles || [],
    onboardedAt: customer.onboarded_at,
    preferences: preferences || null,
    referral: {
      code,
      shareMessage: code ? await referralService.getShareMessage(code) : null,
      referredUsers: referralCount,
    },
    // Lite Dashboard until the usage threshold (sec. 13.2A); shown as progress.
    tier: {
      current: closedDeals.rows[0].n >= Number(dealThreshold) || referralCount >= Number(referralThreshold) ? 'full' : 'lite',
      closedDeals: closedDeals.rows[0].n,
      dealThreshold: Number(dealThreshold),
      referredUsers: referralCount,
      referralThreshold: Number(referralThreshold),
    },
  };
}

// Onboarding (Screen 2) and later profile edits: which roles the person
// acts in, plus buyer / tenant preferences used for matching.
async function saveProfile(user, { portalRoles, preferences }, meta = {}) {
  const customer = await resolveCustomer(user);
  if (portalRoles !== undefined) {
    const roles = [...new Set(portalRoles)].filter((r) => PORTAL_ROLES.includes(r));
    if (!roles.length) throw badRequest('Pick at least one of buyer, tenant, seller or owner');
    await pool.query(
      'UPDATE customers SET portal_roles = $1, onboarded_at = COALESCE(onboarded_at, now()), updated_at = now() WHERE id = $2',
      [roles, customer.id]
    );
    await referralService.ensureReferralCode(user.id, user.role, roles);
  }
  if (preferences) {
    await customerService.upsertPreferences(customer.id, preferences);
    if (preferences.urgency !== undefined) {
      await pool.query('UPDATE customer_preferences SET urgency = $1 WHERE customer_id = $2', [
        preferences.urgency || null,
        customer.id,
      ]);
    }
  }
  await auditService.log({
    actor: user,
    action: 'portal.profile_updated',
    entityType: 'customer',
    entityId: customer.id,
    after: { portalRoles, preferences },
    ...meta,
  });
  return getProfile(user);
}

// ----------------------------------------------------------------- overview

async function getOverview(user) {
  const customer = await resolveCustomer(user);
  const validityDays = await listingValidityDays();
  const reminderDays = Number(await configService.getConfig('listing_renewal_reminder_days', 7)) || 7;

  const [counts, listings, visits, notifications, rentDue] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM requirements WHERE customer_id = $1 AND status = 'active')::int AS active_requirements,
         (SELECT COUNT(*) FROM property_favorites WHERE customer_id = $1)::int AS favourites,
         (SELECT COUNT(*) FROM saved_searches WHERE customer_id = $1)::int AS saved_searches,
         (SELECT COUNT(*) FROM leads WHERE customer_id = $1 AND status NOT IN ('won', 'lost'))::int AS open_enquiries,
         (SELECT COUNT(*) FROM leases WHERE (owner_customer_id = $1 OR tenant_customer_id = $1) AND status <> 'ended')::int AS active_leases,
         (SELECT COUNT(*) FROM maintenance_requests m JOIN leases l ON l.id = m.lease_id
           WHERE (l.owner_customer_id = $1 OR l.tenant_customer_id = $1) AND m.status IN ('open', 'in_progress'))::int AS open_maintenance`,
      [customer.id]
    ),
    pool.query(
      `SELECT id, title, status, approved_at, listing_renewed_at FROM properties WHERE created_by = $1`,
      [user.id]
    ),
    pool.query(
      `SELECT sv.id, sv.scheduled_at, sv.status, p.title AS property_title, p.locality, p.city
       FROM site_visits sv JOIN deals d ON d.id = sv.deal_id
       LEFT JOIN properties p ON p.id = d.property_id
       WHERE d.customer_id = $1 AND sv.status = 'scheduled' AND sv.scheduled_at >= now() - interval '1 day'
       ORDER BY sv.scheduled_at ASC LIMIT 5`,
      [customer.id]
    ),
    pool.query(
      `SELECT id, type, title, message, is_read, created_at FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [user.id]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM rent_payments rp JOIN leases l ON l.id = rp.lease_id
       WHERE l.tenant_customer_id = $1 AND l.status <> 'ended' AND rp.status IN ('due', 'disputed')`,
      [customer.id]
    ),
  ]);

  const now = Date.now();
  const listingRows = listings.rows.map((l) => ({ ...l, expires_at: expiryOf(l, validityDays) }));
  const listingSummary = {
    total: listingRows.length,
    live: listingRows.filter((l) => l.status === 'approved' && (!l.expires_at || l.expires_at.getTime() > now)).length,
    pending: listingRows.filter((l) => l.status === 'pending_approval').length,
    rejected: listingRows.filter((l) => l.status === 'rejected').length,
    renewalDue: listingRows
      .filter((l) => l.expires_at && l.expires_at.getTime() - now <= reminderDays * 24 * 60 * 60 * 1000)
      .map((l) => ({ id: l.id, title: l.title, expires_at: l.expires_at })),
  };

  return {
    portalRoles: customer.portal_roles || [],
    onboarded: !!customer.onboarded_at,
    counts: { ...counts.rows[0], rent_due: rentDue.rows[0].n },
    listings: listingSummary,
    upcomingVisits: visits.rows,
    notifications: notifications.rows,
  };
}

// ------------------------------------------------------------- requirements

async function temperatureFor(urgency) {
  const map = await configService.getConfig('requirement_temperature_by_urgency', {
    immediate: 'hot',
    '30_days': 'warm',
    flexible: 'cold',
  });
  return (map && map[urgency]) || 'cold';
}

function requirementSummary(r) {
  const fmt = (v) => (v == null ? null : Number(v) >= 1e7 ? `₹${Number(v) / 1e7} Cr` : `₹${Number(v) / 1e5} L`);
  const budget = r.budget_min || r.budget_max ? `${fmt(r.budget_min) || 'any'} - ${fmt(r.budget_max) || 'any'}` : 'any budget';
  const where = [...(r.localities || []), r.city].filter(Boolean).join(', ');
  return `Requirement (${r.purpose === 'rent' ? 'rent' : 'buy'}): ${r.property_type || 'any property'}${
    r.bedrooms ? `, ${r.bedrooms}+ BHK` : ''
  } in ${where}, ${budget}, urgency ${r.urgency.replace('_', ' ')}.${r.notes ? ` Notes: ${r.notes}` : ''}`;
}

async function listRequirements(user) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(
    `SELECT r.*, l.status AS lead_status, u.full_name AS representative_name
     FROM requirements r
     LEFT JOIN leads l ON l.id = r.lead_id
     LEFT JOIN users u ON u.id = l.assigned_to
     WHERE r.customer_id = $1
     ORDER BY (r.status = 'active') DESC, r.created_at DESC`,
    [customer.id]
  );
  return result.rows;
}

// Screen 5. The requirement is auto-tagged Hot/Warm/Cold from its urgency
// and enters the CRM as a website lead with the same tag, so a
// representative picks it up. Fee consent + mandate type are mandatory.
async function createRequirement(user, data, meta = {}) {
  const customer = await resolveCustomer(user);
  if (!data.feeConsent) throw badRequest('Please accept the professional fee terms to post a requirement');
  const temperature = await temperatureFor(data.urgency || 'flexible');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lead = await client.query(
      `INSERT INTO leads (source, customer_id, status) VALUES ('website', $1, $2) RETURNING id`,
      [customer.id, temperature]
    );
    const inserted = await client.query(
      `INSERT INTO requirements (customer_id, created_by, purpose, property_type, city, localities, budget_min, budget_max,
         area_min_sqft, area_max_sqft, bedrooms, urgency, temperature, notes, mandate_type, fee_consent_at, lead_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $16)
       RETURNING *`,
      [
        customer.id,
        user.id,
        data.purpose,
        data.propertyType || null,
        data.city,
        JSON.stringify((data.localities || []).map((l) => String(l).trim()).filter(Boolean)),
        data.budgetMin ?? null,
        data.budgetMax ?? null,
        data.areaMinSqft ?? null,
        data.areaMaxSqft ?? null,
        data.bedrooms ?? null,
        data.urgency || 'flexible',
        temperature,
        data.notes || null,
        data.mandateType || 'standard',
        lead.rows[0].id,
      ]
    );
    const requirement = inserted.rows[0];
    await client.query('INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, $2, $3)', [
      lead.rows[0].id,
      user.id,
      requirementSummary(requirement),
    ]);
    await auditService.log(
      { actor: user, action: 'requirement.created', entityType: 'requirement', entityId: requirement.id, after: requirement, ...meta },
      client
    );
    await client.query('COMMIT');
    if (!customer.portal_roles?.includes(data.purpose === 'rent' ? 'tenant' : 'buyer')) {
      await pool.query(
        'UPDATE customers SET portal_roles = array_append(portal_roles, $1::varchar), onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $2',
        [data.purpose === 'rent' ? 'tenant' : 'buyer', customer.id]
      );
    }
    return requirement;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const REQUIREMENT_FIELDS = {
  propertyType: 'property_type',
  city: 'city',
  budgetMin: 'budget_min',
  budgetMax: 'budget_max',
  areaMinSqft: 'area_min_sqft',
  areaMaxSqft: 'area_max_sqft',
  bedrooms: 'bedrooms',
  notes: 'notes',
  status: 'status',
};

async function updateRequirement(user, id, data, meta = {}) {
  const customer = await resolveCustomer(user);
  const existing = await pool.query('SELECT * FROM requirements WHERE id = $1 AND customer_id = $2', [id, customer.id]);
  if (!existing.rows[0]) throw notFound('Requirement not found');

  const set = [];
  const params = [];
  for (const [key, column] of Object.entries(REQUIREMENT_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key] === '' ? null : data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }
  if (data.localities !== undefined) {
    params.push(JSON.stringify(data.localities));
    set.push(`localities = $${params.length}`);
  }
  if (data.urgency !== undefined) {
    params.push(data.urgency);
    set.push(`urgency = $${params.length}::requirement_urgency`);
    params.push(await temperatureFor(data.urgency));
    set.push(`temperature = $${params.length}::requirement_temperature`);
  }
  if (!set.length) throw badRequest('Nothing to update');
  params.push(id);
  const updated = await pool.query(`UPDATE requirements SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  const requirement = updated.rows[0];

  // Keep the CRM lead in step: tag follows urgency; closing the requirement
  // is noted for the representative.
  if (requirement.lead_id) {
    if (data.urgency !== undefined) {
      await pool.query(
        `UPDATE leads SET status = $1::lead_status WHERE id = $2 AND status IN ('new', 'hot', 'warm', 'cold')`,
        [requirement.temperature, requirement.lead_id]
      );
    }
    await pool.query('INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, $2, $3)', [
      requirement.lead_id,
      user.id,
      data.status && data.status !== existing.rows[0].status
        ? `Customer marked the requirement as ${data.status}.`
        : `Customer updated the requirement. ${requirementSummary(requirement)}`,
    ]);
  }
  await auditService.log({
    actor: user,
    action: 'requirement.updated',
    entityType: 'requirement',
    entityId: id,
    before: existing.rows[0],
    after: requirement,
    ...meta,
  });
  return requirement;
}

// ------------------------------------------------------------------ matching

async function matchWeights() {
  const configured = await configService.getConfig('requirement_match_weights', DEFAULT_MATCH_WEIGHTS);
  return { ...DEFAULT_MATCH_WEIGHTS, ...(configured || {}) };
}

// 0-100 match of one listing against one requirement (Screen 6). Location
// and budget matter most; the deal type is already guaranteed by the query.
function scoreListing(listing, requirement, weights) {
  const reasons = {};
  let score = weights.dealType;

  const localities = (requirement.localities || []).map((l) => l.toLowerCase());
  const cityMatch = (listing.city || '').toLowerCase() === (requirement.city || '').toLowerCase();
  const localityMatch = localities.length > 0 && localities.includes((listing.locality || '').toLowerCase());
  if (cityMatch && (localities.length === 0 || localityMatch)) score += weights.location;
  else if (cityMatch) score += Math.round(weights.location * 0.6);
  reasons.location = localityMatch ? 'locality' : cityMatch ? 'city' : 'none';

  const price = listing.price_value != null ? Number(listing.price_value) : parsePriceToNumber(listing.price);
  const min = requirement.budget_min != null ? Number(requirement.budget_min) : null;
  const max = requirement.budget_max != null ? Number(requirement.budget_max) : null;
  if (min == null && max == null) {
    score += weights.budget;
    reasons.budget = 'any';
  } else if (Number.isFinite(price) && price > 0) {
    if ((min == null || price >= min) && (max == null || price <= max)) {
      score += weights.budget;
      reasons.budget = 'within';
    } else {
      const bound = max != null && price > max ? max : min;
      if (bound != null && Math.abs(price - bound) <= bound * 0.2) {
        score += Math.round(weights.budget * 0.45);
        reasons.budget = 'near';
      } else {
        reasons.budget = 'outside';
      }
    }
  } else {
    reasons.budget = 'unknown';
  }

  if (!requirement.property_type || requirement.property_type === listing.property_type) {
    score += weights.type;
    reasons.type = true;
  } else {
    reasons.type = false;
  }
  if (requirement.bedrooms && listing.bedrooms != null && listing.bedrooms < requirement.bedrooms) {
    score -= 10;
    reasons.bedrooms = 'fewer';
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

async function findMatches(requirements, { excludeCreatedBy = null, limitPerRequirement = 12 } = {}) {
  const weights = await matchWeights();
  const hotThreshold = Number(await configService.getConfig('hot_match_threshold', 80)) || 80;
  const out = [];
  for (const requirement of requirements) {
    const params = [PURPOSE_TRANSACTION_TYPES[requirement.purpose], requirement.city];
    let excludeClause = '';
    if (excludeCreatedBy) {
      params.push(excludeCreatedBy);
      excludeClause = `AND (p.created_by IS NULL OR p.created_by <> $${params.length})`;
    }
    const candidates = await pool.query(
      `SELECT ${LISTING_CARD_COLUMNS}
       FROM properties p
       WHERE p.status = 'approved' AND p.listing_category = 'residential'
         AND p.transaction_type::text = ANY($1) AND p.city ILIKE $2 ${excludeClause}
       ORDER BY p.created_at DESC LIMIT 300`,
      params
    );
    candidates.rows
      .map((listing) => ({ listing, ...scoreListing(listing, requirement, weights) }))
      .filter((m) => m.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, limitPerRequirement)
      .forEach((m) =>
        out.push({ requirementId: requirement.id, score: m.score, hotMatch: m.score >= hotThreshold, reasons: m.reasons, property: m.listing })
      );
  }
  return out;
}

async function getMatches(user, { requirementId } = {}) {
  const customer = await resolveCustomer(user);
  const params = [customer.id];
  let where = `customer_id = $1 AND status = 'active'`;
  if (requirementId) {
    params.push(requirementId);
    where += ` AND id = $2`;
  }
  const requirements = await pool.query(`SELECT * FROM requirements WHERE ${where}`, params);
  const matches = await findMatches(requirements.rows, { excludeCreatedBy: user.id });

  // One entry per property (its best requirement), best first.
  const best = new Map();
  for (const m of matches) {
    const current = best.get(m.property.id);
    if (!current || m.score > current.score) best.set(m.property.id, m);
  }
  const items = [...best.values()].sort((a, b) => b.score - a.score);
  const favourites = await pool.query('SELECT property_id FROM property_favorites WHERE customer_id = $1', [customer.id]);
  const favSet = new Set(favourites.rows.map((r) => r.property_id));
  const properties = await signUrls(items.map((m) => ({ ...m.property, is_favourite: favSet.has(m.property.id) })), 'primary_image');
  return {
    requirements: requirements.rows.length,
    items: items.map((m, i) => ({ ...m, property: properties[i] })),
  };
}

// Called when a listing goes live: in-app alerts to customers whose active
// requirement it matches (Hot Match or better) or whose saved search it
// fits. Best-effort - never blocks the approval.
async function notifyNewListing(propertyId) {
  try {
    const listingResult = await pool.query(`SELECT ${LISTING_CARD_COLUMNS}, p.created_by FROM properties p WHERE p.id = $1`, [propertyId]);
    const listing = listingResult.rows[0];
    if (!listing || listing.listing_category !== 'residential') return;
    const purpose = listing.transaction_type === 'rent' ? 'rent' : 'buy';
    const weights = await matchWeights();
    const hotThreshold = Number(await configService.getConfig('hot_match_threshold', 80)) || 80;
    const notified = new Set();

    const requirements = await pool.query(
      `SELECT r.*, c.user_id FROM requirements r JOIN customers c ON c.id = r.customer_id
       WHERE r.status = 'active' AND r.purpose = $1 AND r.city ILIKE $2 AND c.user_id IS NOT NULL`,
      [purpose, listing.city]
    );
    for (const requirement of requirements.rows) {
      if (requirement.user_id === listing.created_by || notified.has(requirement.user_id)) continue;
      const { score } = scoreListing(listing, requirement, weights);
      if (score < hotThreshold) continue;
      notified.add(requirement.user_id);
      await notificationService.createNotification({
        userId: requirement.user_id,
        type: 'match_alert',
        title: `Hot Match: ${listing.title}`,
        message: `A new listing in ${[listing.locality, listing.city].filter(Boolean).join(', ')} matches your requirement (${score}% match).`,
        relatedEntityType: 'property',
        relatedEntityId: listing.id,
      });
    }

    const searches = await pool.query(
      `SELECT s.*, c.user_id FROM saved_searches s JOIN customers c ON c.id = s.customer_id
       WHERE s.alerts_enabled = true AND c.user_id IS NOT NULL`
    );
    const price = listing.price_value != null ? Number(listing.price_value) : null;
    for (const search of searches.rows) {
      if (search.user_id === listing.created_by || notified.has(search.user_id)) continue;
      const f = search.filters || {};
      if (f.purpose && f.purpose !== 'all' && f.purpose !== purpose) continue;
      if (f.city && String(f.city).toLowerCase() !== String(listing.city || '').toLowerCase()) continue;
      if (f.propertyType && f.propertyType !== listing.property_type) continue;
      if (f.bedrooms && (listing.bedrooms == null || listing.bedrooms < Number(f.bedrooms))) continue;
      if (f.maxPrice && price != null && price > Number(f.maxPrice)) continue;
      if (f.minPrice && price != null && price < Number(f.minPrice)) continue;
      notified.add(search.user_id);
      await pool.query('UPDATE saved_searches SET last_alerted_at = now() WHERE id = $1', [search.id]);
      await notificationService.createNotification({
        userId: search.user_id,
        type: 'saved_search_alert',
        title: `New listing for "${search.name}"`,
        message: `${listing.title} in ${[listing.locality, listing.city].filter(Boolean).join(', ')} matches your saved search.`,
        relatedEntityType: 'property',
        relatedEntityId: listing.id,
      });
    }
  } catch (err) {
    console.error('Listing match alerts failed:', err.message);
  }
}

// --------------------------------------------------------------- favourites

// Saved properties as public cards (signed image, no owner / broker names).
// `ids` lets the site mark hearts on any listing page in one call.
async function listFavourites(user) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(
    `SELECT ${LISTING_CARD_COLUMNS}, p.status, f.created_at AS saved_at
     FROM property_favorites f JOIN properties p ON p.id = f.property_id
     WHERE f.customer_id = $1
     ORDER BY f.created_at DESC`,
    [customer.id]
  );
  const items = await signUrls(result.rows, 'primary_image');
  return { ids: items.map((row) => row.id), items };
}

// ------------------------------------------------------------ saved searches

async function listSavedSearches(user) {
  const customer = await resolveCustomer(user);
  const result = await pool.query('SELECT * FROM saved_searches WHERE customer_id = $1 ORDER BY created_at DESC', [customer.id]);
  return result.rows;
}

const SAVED_SEARCH_FILTER_KEYS = ['purpose', 'city', 'q', 'propertyType', 'minPrice', 'maxPrice', 'bedrooms'];

async function createSavedSearch(user, { name, filters, alertsEnabled = true }) {
  const customer = await resolveCustomer(user);
  const clean = Object.fromEntries(
    Object.entries(filters || {}).filter(([k, v]) => SAVED_SEARCH_FILTER_KEYS.includes(k) && v !== '' && v != null)
  );
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM saved_searches WHERE customer_id = $1', [customer.id]);
  if (count.rows[0].n >= 20) throw badRequest('You can keep up to 20 saved searches - delete one to add another');
  const result = await pool.query(
    `INSERT INTO saved_searches (customer_id, name, filters, alerts_enabled) VALUES ($1, $2, $3, $4) RETURNING *`,
    [customer.id, name, JSON.stringify(clean), alertsEnabled]
  );
  return result.rows[0];
}

async function updateSavedSearch(user, id, { name, alertsEnabled }) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(
    `UPDATE saved_searches SET name = COALESCE($1, name), alerts_enabled = COALESCE($2, alerts_enabled)
     WHERE id = $3 AND customer_id = $4 RETURNING *`,
    [name ?? null, alertsEnabled ?? null, id, customer.id]
  );
  if (!result.rows[0]) throw notFound('Saved search not found');
  return result.rows[0];
}

async function deleteSavedSearch(user, id) {
  const customer = await resolveCustomer(user);
  const result = await pool.query('DELETE FROM saved_searches WHERE id = $1 AND customer_id = $2 RETURNING id', [id, customer.id]);
  if (!result.rows[0]) throw notFound('Saved search not found');
}

// ------------------------------------------------------- enquiries & visits

async function listEnquiries(user) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(
    `SELECT l.id, l.status, l.source, l.created_at, l.updated_at, l.property_id,
            p.title AS property_title, p.city, p.locality, p.transaction_type, p.price, p.price_value,
            u.full_name AS representative_name,
            d.id AS deal_id, d.stage AS deal_stage,
            (SELECT MIN(sv.scheduled_at) FROM site_visits sv WHERE sv.deal_id = d.id AND sv.status = 'scheduled' AND sv.scheduled_at >= now()) AS next_visit_at,
            EXISTS (SELECT 1 FROM requirements r WHERE r.lead_id = l.id) AS is_requirement
     FROM leads l
     LEFT JOIN properties p ON p.id = l.property_id
     LEFT JOIN users u ON u.id = l.assigned_to
     LEFT JOIN LATERAL (SELECT id, stage FROM deals WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE l.customer_id = $1
     ORDER BY l.created_at DESC`,
    [customer.id]
  );
  return result.rows.map((row) => ({
    ...row,
    status_label: row.deal_stage ? DEAL_STAGE_LABELS[row.deal_stage] : LEAD_STATUS_LABELS[row.status] || row.status,
  }));
}

async function listVisits(user) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(
    `SELECT sv.id, sv.scheduled_at, sv.actual_visit_at, sv.status, sv.deal_id,
            p.id AS property_id, p.title AS property_title, p.city, p.locality,
            u.full_name AS representative_name
     FROM site_visits sv
     JOIN deals d ON d.id = sv.deal_id
     LEFT JOIN properties p ON p.id = d.property_id
     LEFT JOIN leads l ON l.id = d.lead_id
     LEFT JOIN users u ON u.id = COALESCE(l.assigned_to, d.broker_id)
     WHERE d.customer_id = $1
     ORDER BY sv.scheduled_at DESC`,
    [customer.id]
  );
  return result.rows;
}

// "Request a site visit" on one of the caller's enquiries - noted on the
// lead for the representative (who schedules it in the CRM) and notified.
async function requestVisit(user, leadId, { preferredAt, note }) {
  const customer = await resolveCustomer(user);
  const lead = await pool.query(
    `SELECT l.id, l.assigned_to, p.title FROM leads l LEFT JOIN properties p ON p.id = l.property_id
     WHERE l.id = $1 AND l.customer_id = $2`,
    [leadId, customer.id]
  );
  if (!lead.rows[0]) throw notFound('Enquiry not found');
  const when = new Date(preferredAt);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now()) throw badRequest('Pick a date and time in the future');
  const text = `Customer requested a site visit${lead.rows[0].title ? ` for ${lead.rows[0].title}` : ''} on ${when.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
  })}${note ? `. Note: ${note}` : ''}`;
  await pool.query('INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, $2, $3)', [leadId, user.id, text]);
  if (lead.rows[0].assigned_to) {
    await notificationService.createNotification({
      userId: lead.rows[0].assigned_to,
      type: 'visit_request',
      title: 'Site visit requested',
      message: text,
      relatedEntityType: 'lead',
      relatedEntityId: leadId,
    });
  }
  return { requested: true, preferredAt: when };
}

// ---------------------------------------------------------------- listings

async function listListings(user) {
  await resolveCustomer(user);
  const validityDays = await listingValidityDays();
  const result = await pool.query(
    `SELECT ${LISTING_CARD_COLUMNS}, p.status, p.rejection_reason, p.approved_at, p.listing_renewed_at, p.mandate_type,
            (SELECT COUNT(*) FROM leads l WHERE l.property_id = p.id)::int AS enquiry_count,
            (SELECT COUNT(DISTINCT l.customer_id) FROM leads l WHERE l.property_id = p.id)::int AS interested_count,
            (SELECT COUNT(*) FROM property_favorites f WHERE f.property_id = p.id)::int AS favourite_count,
            (SELECT COUNT(*) FROM site_visits sv JOIN deals d ON d.id = sv.deal_id WHERE d.property_id = p.id)::int AS visit_count,
            (SELECT COUNT(*) FROM site_visits sv JOIN deals d ON d.id = sv.deal_id
              WHERE d.property_id = p.id AND sv.status = 'completed')::int AS completed_visit_count
     FROM properties p
     WHERE p.created_by = $1
     ORDER BY p.created_at DESC`,
    [user.id]
  );
  const rows = await signUrls(result.rows, 'primary_image');
  return rows.map((row) => ({ ...row, expires_at: expiryOf(row, validityDays) }));
}

const LISTING_INPUT_FIELDS = [
  'title', 'description', 'propertyType', 'transactionType', 'price', 'city', 'locality', 'address',
  'latitude', 'longitude', 'areaSqft', 'carpetAreaSqft', 'bedrooms', 'bathrooms', 'amenities', 'furnishing',
  'floorNumber', 'totalFloors', 'facing', 'parkingSpots', 'possessionStatus', 'ageOfProperty', 'gatedCommunity',
  'reraNumber', 'estimatedRentMonthly',
];

// Screen 4 - Post Property. Goes to the admin approval queue like any
// broker listing (content guard rejects contact details in the text).
// Professional fee consent + mandate type are mandatory.
async function createListing(user, data, meta = {}) {
  const customer = await resolveCustomer(user);
  if (!data.feeConsent) throw badRequest('Please accept the professional fee terms to post a property');
  const input = Object.fromEntries(LISTING_INPUT_FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
  if (data.pg) input.tags = ['PG'];
  const property = await propertyService.createProperty(
    { ...input, listingCategory: 'residential', verified: false },
    { id: user.id, role: user.role, tenant_id: null },
    { autoVerify: false }
  );
  await pool.query('UPDATE properties SET fee_consent_at = now(), mandate_type = $1 WHERE id = $2', [
    data.mandateType || 'standard',
    property.id,
  ]);
  const role = data.transactionType === 'rent' ? 'owner' : 'seller';
  if (!customer.portal_roles?.includes(role)) {
    await pool.query(
      'UPDATE customers SET portal_roles = array_append(portal_roles, $1::varchar), onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $2',
      [role, customer.id]
    );
  }
  await auditService.log({ actor: user, action: 'listing.posted', entityType: 'property', entityId: property.id, ...meta });
  return { ...property, mandate_type: data.mandateType || 'standard' };
}

async function getOwnListing(user, id) {
  const result = await pool.query('SELECT * FROM properties WHERE id = $1 AND created_by = $2', [id, user.id]);
  if (!result.rows[0]) throw notFound('Listing not found');
  return result.rows[0];
}

// Edits go back through approval (the admin re-checks what goes live). A
// live listing can instead just change price, be marked sold / rented
// (inactive) or be renewed.
async function updateListing(user, id, data, meta = {}) {
  await resolveCustomer(user);
  const listing = await getOwnListing(user, id);
  const input = Object.fromEntries(LISTING_INPUT_FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
  if (!Object.keys(input).length) throw badRequest('Nothing to update');
  const { price, ...rest } = input;
  if (Object.keys(rest).length) await propertyService.updateProperty(id, rest);
  if (price !== undefined) {
    await pool.query('UPDATE properties SET price = $1, price_value = $2 WHERE id = $3', [price, parsePriceToNumber(price), id]);
  }
  if (listing.status === 'approved' || listing.status === 'rejected') {
    await pool.query(`UPDATE properties SET status = 'pending_approval', rejection_reason = NULL WHERE id = $1`, [id]);
  }
  await auditService.log({ actor: user, action: 'listing.edited', entityType: 'property', entityId: id, before: listing, after: input, ...meta });
  return (await listListings(user)).find((l) => l.id === id);
}

async function setListingState(user, id, action, meta = {}) {
  await resolveCustomer(user);
  const listing = await getOwnListing(user, id);
  if (action === 'renew') {
    if (listing.status !== 'approved') throw badRequest('Only a live listing can be renewed');
    await pool.query('UPDATE properties SET listing_renewed_at = now() WHERE id = $1', [id]);
  } else if (action === 'close') {
    await pool.query(`UPDATE properties SET status = 'inactive' WHERE id = $1`, [id]);
  } else if (action === 'reopen') {
    if (listing.status !== 'inactive') throw badRequest('Only a closed listing can be reopened');
    await pool.query(`UPDATE properties SET status = 'pending_approval' WHERE id = $1`, [id]);
  } else {
    throw badRequest('Unknown action');
  }
  await auditService.log({ actor: user, action: `listing.${action}`, entityType: 'property', entityId: id, ...meta });
  return (await listListings(user)).find((l) => l.id === id);
}

// Who has enquired on the caller's listing - first name and status only.
// Contact details stay with the A R Buildwel representative (mandatory
// intermediation); the owner's "tenant screening" happens through them.
async function listListingEnquiries(user, id) {
  await resolveCustomer(user);
  await getOwnListing(user, id);
  const result = await pool.query(
    `SELECT l.id, l.status, l.created_at, split_part(c.full_name, ' ', 1) AS first_name,
            d.stage AS deal_stage,
            (SELECT COUNT(*) FROM site_visits sv WHERE sv.deal_id = d.id)::int AS visits
     FROM leads l
     JOIN customers c ON c.id = l.customer_id
     LEFT JOIN LATERAL (SELECT id, stage FROM deals WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE l.property_id = $1
     ORDER BY l.created_at DESC`,
    [id]
  );
  return result.rows.map((row) => ({
    ...row,
    status_label: row.deal_stage ? DEAL_STAGE_LABELS[row.deal_stage] : LEAD_STATUS_LABELS[row.status] || row.status,
  }));
}

// --------------------------------------------------------------- documents

async function listDocuments(user) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(
    `SELECT id, document_type, file_name, document_url, status, review_notes, created_at
     FROM documents WHERE customer_id = $1 ORDER BY created_at DESC`,
    [customer.id]
  );
  return signUrls(result.rows, 'document_url');
}

async function uploadDocument(user, file, { documentType }) {
  const customer = await resolveCustomer(user);
  if (!file) throw badRequest('Choose a file to upload');
  const documentService = require('./document.service');
  return documentService.uploadDocument(
    file,
    { customerId: customer.id, documentType: documentType || 'other', fileName: file.originalname },
    { id: user.id, role: user.role, tenant_id: customer.tenant_id || null }
  );
}

// ------------------------------------------------------- staff (Customer 360)

// What a customer does on the website dashboard, for the CRM customer page:
// roles, referral code, requirements, self-posted listings, rentals and
// saved items. Staff only (route-level role check).
async function getCustomerPortalSummary(customerId) {
  const customerResult = await pool.query(
    `SELECT c.id, c.user_id, c.portal_roles, c.onboarded_at, u.referral_code, u.last_login_at
     FROM customers c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
    [customerId]
  );
  const customer = customerResult.rows[0];
  if (!customer) throw notFound('Customer not found');

  const [requirements, listings, leases, counts, referred] = await Promise.all([
    pool.query(`SELECT * FROM requirements WHERE customer_id = $1 ORDER BY created_at DESC`, [customerId]),
    customer.user_id
      ? pool.query(
          `SELECT p.id, p.title, p.status, p.transaction_type, p.price, p.price_value, p.city, p.locality, p.mandate_type, p.created_at,
                  (SELECT COUNT(*) FROM leads l WHERE l.property_id = p.id)::int AS enquiry_count
           FROM properties p WHERE p.created_by = $1 ORDER BY p.created_at DESC`,
          [customer.user_id]
        )
      : { rows: [] },
    pool.query(
      `SELECT l.id, l.property_label, l.monthly_rent, l.start_date, l.end_date, l.status, l.tenant_confirmed_at,
              CASE WHEN l.owner_customer_id = $1 THEN 'owner' ELSE 'tenant' END AS side,
              oc.full_name AS owner_name, tc.full_name AS tenant_name,
              (SELECT COUNT(*) FROM rent_payments rp WHERE rp.lease_id = l.id AND rp.status IN ('due', 'disputed'))::int AS rent_due,
              (SELECT COUNT(*) FROM maintenance_requests m WHERE m.lease_id = l.id AND m.status IN ('open', 'in_progress'))::int AS open_maintenance
       FROM leases l
       JOIN customers oc ON oc.id = l.owner_customer_id
       JOIN customers tc ON tc.id = l.tenant_customer_id
       WHERE l.owner_customer_id = $1 OR l.tenant_customer_id = $1
       ORDER BY l.start_date DESC`,
      [customerId]
    ),
    pool.query(
      `SELECT (SELECT COUNT(*) FROM property_favorites WHERE customer_id = $1)::int AS favourites,
              (SELECT COUNT(*) FROM saved_searches WHERE customer_id = $1)::int AS saved_searches`,
      [customerId]
    ),
    customer.user_id ? referralService.countReferrals(customer.user_id) : 0,
  ]);

  return {
    hasAccount: !!customer.user_id,
    portalRoles: customer.portal_roles || [],
    onboardedAt: customer.onboarded_at,
    lastLoginAt: customer.last_login_at || null,
    referralCode: customer.referral_code || null,
    referredUsers: referred,
    ...counts.rows[0],
    requirements: requirements.rows,
    listings: listings.rows,
    leases: leases.rows,
  };
}

module.exports = {
  getCustomerPortalSummary,
  PORTAL_ROLES,
  resolveCustomer,
  getProfile,
  saveProfile,
  getOverview,
  listRequirements,
  createRequirement,
  updateRequirement,
  getMatches,
  notifyNewListing,
  listFavourites,
  listSavedSearches,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
  listEnquiries,
  listVisits,
  requestVisit,
  listListings,
  createListing,
  updateListing,
  setListingState,
  listListingEnquiries,
  listDocuments,
  uploadDocument,
};
