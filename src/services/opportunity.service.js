const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const disclaimerService = require('./disclaimer.service');
const notificationService = require('./notification.service');
const customerService = require('./customer.service');
const opportunityScoring = require('./opportunityScoring.service');
const { signUrls } = require('../utils/storage');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { parsePriceToNumber, formatInr } = require('../utils/price');
const { isAdmin } = require('../utils/ownership');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 4 - Bank Auction & Special Situation deals.
//   - Access control: full details only for staff/broker roles
//     (opportunity.full_access_roles) and verified NRI/HNI investors; casual
//     visitors get a masked teaser (no source bank, reference, portal link,
//     address, legal notes, documents).
//   - CRM pipeline: Lead -> Deal Interest -> Due Diligence -> Negotiation
//     -> Closure (+ Dropped), one stage at a time.
//   - Alerts: matched, verified investors are notified when a deal goes
//     live; high-score deals are flagged priority.
//   - Ingestion (pipeline layers 2-5): raw records from crawlers / CSV /
//     API are normalised, confidence-scored, de-duplicated and either
//     queued for review or published.
// Every deal carries its mandatory disclaimers in the API response.

const CATEGORIES = opportunityScoring.OPPORTUNITY_CATEGORIES;
const DEFAULT_FULL_ACCESS_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];
const STAFF_ROLES = ['internal_sales', 'admin', 'super_admin'];
const STAGES = ['lead', 'deal_interest', 'due_diligence', 'negotiation', 'closure'];

const SOURCE_LABELS = {
  sarfaesi_bank_auction: 'Bank auction (SARFAESI)',
  nbfc_repossession: 'NBFC asset sale',
  arc_asset: 'ARC asset sale',
  drt_auction: 'Tribunal auction (DRT)',
  nclt_liquidation: 'Tribunal sale (NCLT)',
  housing_board: 'Housing board allotment',
  legal_notice: 'Public notice sale',
  broker_sourced: 'Special situation',
  direct_seller: 'Special situation',
  internal_crm: 'Special situation',
  other: 'Special situation',
};

function disclaimerTypes(category) {
  return ['all_listings', category, 'investment_guidance'];
}

function maskedInstitutionalTitle(row) {
  return `${String(row.property_type || 'Institutional asset').replace(/_/g, ' ')} in ${row.locality || row.city}`;
}

// ---------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------
async function getInvestorProfile(userId) {
  const result = await pool.query('SELECT * FROM investor_profiles WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}

async function getAccess(user) {
  if (!user) return { full: false, profile: null, reason: 'Sign in with a verified investor profile to unlock full deal details' };
  const roles = await configService.getConfig('opportunity.full_access_roles', DEFAULT_FULL_ACCESS_ROLES);
  const profile = await getInvestorProfile(user.id);
  if (roles.includes(user.role)) return { full: true, profile };
  if (profile && profile.verification_status === 'verified') return { full: true, profile };
  return {
    full: false,
    profile,
    reason: profile
      ? 'Your investor profile is pending verification - full deal details unlock once it is verified'
      : 'Complete your NRI / HNI investor profile to unlock full deal details',
  };
}

async function assertFullAccess(user) {
  const access = await getAccess(user);
  if (!access.full) throw forbidden(access.reason);
  return access;
}

// ---------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------
const TEASER_COLUMNS = `
  p.id, p.listing_category, p.title, p.property_type, p.transaction_type, p.city, p.locality,
  p.area_sqft, p.price, p.price_value, p.reserve_price, p.discount_percent, p.investment_score,
  p.liquidity_band, p.auction_date, p.possession_type, p.situation_tags, p.risk_indicators,
  p.opportunity_source_type, p.is_institutional_asset, p.yield_percent, p.yield_qualifier,
  p.estimated_rent_monthly, p.is_verified, p.created_at,
  (SELECT url FROM property_media pm WHERE pm.property_id = p.id
   ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS primary_image
`;

function toTeaser(row) {
  const risks = Array.isArray(row.risk_indicators) ? row.risk_indicators : [];
  return {
    id: row.id,
    listing_category: row.listing_category,
    title: row.listing_category === 'institutional' || row.is_institutional_asset ? maskedInstitutionalTitle(row) : row.title,
    property_type: row.property_type,
    transaction_type: row.transaction_type,
    city: row.city,
    locality: row.locality,
    area_sqft: row.area_sqft,
    price: row.price,
    price_value: row.price_value,
    reserve_price: row.reserve_price,
    reserve_price_display: formatInr(row.reserve_price ?? row.price_value),
    discount_percent: row.discount_percent,
    investment_score: row.investment_score,
    liquidity_band: row.liquidity_band,
    auction_date: row.auction_date,
    possession_type: row.possession_type,
    yield_percent: row.yield_percent,
    yield_qualifier: row.yield_qualifier,
    situation_tags: row.situation_tags,
    risk_indicator_count: risks.length,
    source_label: SOURCE_LABELS[row.opportunity_source_type] || (row.listing_category === 'auction' ? 'Bank auction' : 'Special situation'),
    is_institutional_asset: row.is_institutional_asset,
    is_verified: row.is_verified,
    primary_image: row.primary_image,
    created_at: row.created_at,
    locked: true,
  };
}

function applyOpportunityFilters(query, where, params) {
  const categories = query.listingCategory ? [query.listingCategory] : CATEGORIES;
  params.push(categories);
  where.push(`p.listing_category::text = ANY($${params.length}::text[])`);
  where.push(`p.status = 'approved'`);

  if (query.city) {
    params.push(query.city);
    where.push(`p.city ILIKE $${params.length}`);
  }
  if (query.locality) {
    params.push(query.locality);
    where.push(`p.locality ILIKE $${params.length}`);
  }
  if (query.propertyType) {
    params.push(query.propertyType);
    where.push(`p.property_type = $${params.length}`);
  }
  if (query.transactionType) {
    params.push(query.transactionType);
    where.push(`p.transaction_type = $${params.length}`);
  }
  if (query.purpose) {
    params.push(query.purpose === 'rent' ? ['rent'] : ['sell', 'buy']);
    where.push(`p.transaction_type::text = ANY($${params.length}::text[])`);
  }
  if (query.sourceType) {
    params.push(query.sourceType);
    where.push(`p.opportunity_source_type = $${params.length}`);
  }
  if (query.minPrice) {
    params.push(Number(query.minPrice));
    where.push(`COALESCE(p.reserve_price, p.price_value) >= $${params.length}`);
  }
  if (query.maxPrice) {
    params.push(Number(query.maxPrice));
    where.push(`COALESCE(p.reserve_price, p.price_value) <= $${params.length}`);
  }
  if (query.minScore) {
    params.push(Number(query.minScore));
    where.push(`p.investment_score >= $${params.length}`);
  }
  if (query.minDiscount) {
    params.push(Number(query.minDiscount));
    where.push(`p.discount_percent >= $${params.length}`);
  }
  if (query.liquidityBand) {
    params.push(query.liquidityBand);
    where.push(`p.liquidity_band = $${params.length}`);
  }
  if (query.possessionType) {
    params.push(query.possessionType);
    where.push(`p.possession_type = $${params.length}`);
  }
  if (query.situationTag) {
    params.push(JSON.stringify([query.situationTag]));
    where.push(`p.situation_tags @> $${params.length}::jsonb`);
  }
  // Past auctions drop off by default - an auction that has happened is no
  // longer an opportunity.
  if (query.includePast !== 'true') {
    where.push(`(p.listing_category <> 'auction' OR p.auction_date IS NULL OR p.auction_date >= now() - interval '1 day')`);
  }
}

const SORTS = {
  score: 'p.investment_score DESC NULLS LAST, p.created_at DESC',
  discount: 'p.discount_percent DESC NULLS LAST, p.investment_score DESC NULLS LAST',
  auction_date: 'p.auction_date ASC NULLS LAST',
  price_asc: 'COALESCE(p.reserve_price, p.price_value) ASC NULLS LAST',
  price_desc: 'COALESCE(p.reserve_price, p.price_value) DESC NULLS LAST',
  newest: 'p.created_at DESC',
};

async function queryOpportunities(query, columns) {
  const { page, limit, offset } = parsePagination(query, 12);
  const where = [];
  const params = [];
  applyOpportunityFilters(query, where, params);
  const whereClause = `WHERE ${where.join(' AND ')}`;
  const count = await pool.query(`SELECT COUNT(*) FROM properties p ${whereClause}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT ${columns} FROM properties p ${whereClause}
     ORDER BY ${SORTS[query.sort] || SORTS.score}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: result.rows, pagination: buildPagination(page, limit, count.rows[0].count) };
}

// Public (website) - masked teasers for everyone, no login needed.
async function listPublicTeasers(query, user) {
  const teaserEnabled = await configService.getConfig('opportunity.public_teaser_enabled', true);
  const access = await getAccess(user);
  const category = query.listingCategory || 'auction';
  const disclaimers = await disclaimerService.getDisclaimers(disclaimerTypes(category));

  if (!teaserEnabled && !access.full) {
    return { items: [], pagination: buildPagination(1, 12, 0), access: { full: false, reason: access.reason }, disclaimers };
  }

  const { rows, pagination } = await queryOpportunities(query, TEASER_COLUMNS);
  const items = await signUrls(rows.map(toTeaser), 'primary_image');
  return { items, pagination, access: { full: access.full, reason: access.full ? null : access.reason }, disclaimers };
}

// Eligible investors / staff - full list with scores and source details.
async function listForInvestor(query, user) {
  await assertFullAccess(user);
  const columns = `${TEASER_COLUMNS}, p.source_bank, p.auction_reference_id, p.auction_portal_url, p.emd_amount,
    p.emd_deadline, p.inspection_date, p.estimated_market_value, p.liquidity_score, p.legal_status_note`;
  const { rows, pagination } = await queryOpportunities(query, columns);
  const items = await signUrls(
    rows.map((r) => ({ ...r, risk_indicator_count: (r.risk_indicators || []).length, source_label: SOURCE_LABELS[r.opportunity_source_type] || null, locked: false })),
    'primary_image'
  );
  const disclaimers = await disclaimerService.getDisclaimers(disclaimerTypes(query.listingCategory || 'auction'));
  return { items, pagination, disclaimers };
}

async function logInteraction(user, profile, property, action) {
  await pool.query(
    `INSERT INTO investor_deal_interactions (investor_profile_id, user_id, property_id, action, listing_category, city, ticket_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [profile?.id || null, user.id, property.id, action, property.listing_category, property.city, property.reserve_price ?? property.price_value ?? null]
  );
}

async function getOpportunity(id, user) {
  const result = await pool.query(
    `SELECT p.*, builder.full_name AS builder_name
     FROM properties p LEFT JOIN users builder ON builder.id = p.builder_id
     WHERE p.id = $1 AND p.status = 'approved' AND p.listing_category::text = ANY($2::text[])`,
    [id, CATEGORIES]
  );
  const property = result.rows[0];
  if (!property) throw notFound('Opportunity not found');

  const access = await getAccess(user);
  const disclaimers = await disclaimerService.getDisclaimers(disclaimerTypes(property.listing_category));

  if (!access.full) {
    const teaserRow = await pool.query(`SELECT ${TEASER_COLUMNS} FROM properties p WHERE p.id = $1`, [id]);
    const teaser = await signUrls(toTeaser(teaserRow.rows[0]), 'primary_image');
    return { ...teaser, access: { full: false, reason: access.reason }, disclaimers };
  }

  const media = await pool.query(
    'SELECT id, media_type, url, display_order, is_primary FROM property_media WHERE property_id = $1 ORDER BY display_order ASC, created_at ASC',
    [id]
  );
  const myInterest = await pool.query(
    'SELECT id, stage, created_at, updated_at FROM opportunity_interests WHERE property_id = $1 AND user_id = $2',
    [id, user.id]
  );
  await logInteraction(user, access.profile, property, 'viewed');

  // Internal-only fields never leave the API even for eligible investors.
  const { tenant_id, created_by, approved_by, rejection_reason, address, ...publicFields } = property;
  const isStaff = STAFF_ROLES.includes(user.role);
  // Deal advisory (non-legal risk-return / structure brief) and, for an
  // investor, how well the deal fits them (AI investor-deal matching).
  const { buildAdvisory } = require('./dealAdvisory.service');
  let myMatch = null;
  if (access.profile) {
    const irm = require('./irm.service');
    const behaviour = await irm.behaviourSummary(user.id);
    myMatch = irm.scoreMatch(access.profile, behaviour, property, await irm.weights());
  }
  return {
    ...publicFields,
    ...(isStaff ? { address, tenant_id, created_by } : {}),
    source_label: SOURCE_LABELS[property.opportunity_source_type] || null,
    media: await signUrls(media.rows, 'url'),
    my_interest: myInterest.rows[0] || null,
    advisory: buildAdvisory(property),
    my_match: myMatch,
    access: { full: true },
    disclaimers,
  };
}

// ---------------------------------------------------------------------
// Interest pipeline
// ---------------------------------------------------------------------
async function logStage(client, interestId, fromStage, toStage, userId, notes) {
  await client.query(
    `INSERT INTO opportunity_interest_history (interest_id, from_stage, to_stage, changed_by, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [interestId, fromStage, toStage, userId, notes || null]
  );
}

async function expressInterest(propertyId, data, user) {
  const access = await assertFullAccess(user);
  const propertyResult = await pool.query(
    `SELECT * FROM properties WHERE id = $1 AND status = 'approved' AND listing_category::text = ANY($2::text[])`,
    [propertyId, CATEGORIES]
  );
  const property = propertyResult.rows[0];
  if (!property) throw notFound('Opportunity not found');

  const existing = await pool.query('SELECT id FROM opportunity_interests WHERE property_id = $1 AND user_id = $2', [propertyId, user.id]);
  if (existing.rows[0]) return { interest: await getInterestById(existing.rows[0].id), created: false };

  const me = await pool.query('SELECT full_name, email, mobile FROM users WHERE id = $1', [user.id]);
  const customer = await customerService.findOrCreateCustomerByContact({
    fullName: me.rows[0].full_name,
    email: me.rows[0].email,
    mobile: me.rows[0].mobile,
    userId: user.id,
  });
  // NRI / HNI / special-situation deals are handled centrally by A R
  // Buildwel's own RM network (sec. 14 - exempt from franchise territory),
  // so the lead goes to the investor's assigned manager, not a tenant.
  const assignee = access.profile?.assigned_manager_id || null;

  const client = await pool.connect();
  let interestId;
  try {
    await client.query('BEGIN');
    const lead = await client.query(
      `INSERT INTO leads (source, property_id, customer_id, assigned_to, status)
       VALUES ('opportunity', $1, $2, $3, 'new') RETURNING id`,
      [propertyId, customer.id, assignee]
    );
    await client.query(
      `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'lead_created', $3)`,
      [lead.rows[0].id, user.id, JSON.stringify({ source: 'opportunity', channel: 'opportunity_interest', message: data.message || null })]
    );
    const interest = await client.query(
      `INSERT INTO opportunity_interests (property_id, user_id, investor_profile_id, customer_id, lead_id,
         intended_bid_amount, financing_needed, message, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        propertyId,
        user.id,
        access.profile?.id || null,
        customer.id,
        lead.rows[0].id,
        data.intendedBidAmount ?? null,
        data.financingNeeded ?? false,
        data.message || null,
        assignee,
      ]
    );
    interestId = interest.rows[0].id;
    await logStage(client, interestId, null, 'lead', user.id, 'Interest expressed');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logInteraction(user, access.profile, property, 'interest_expressed');
  await notifyStaffOfInterest(interestId, property, assignee);
  return { interest: await getInterestById(interestId), created: true };
}

async function notifyStaffOfInterest(interestId, property, assignee) {
  const recipients = assignee
    ? [assignee]
    : (
        await pool.query(
          `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
           WHERE r.name IN ('super_admin', 'admin') AND u.status = 'active'`
        )
      ).rows.map((r) => r.id);
  await Promise.all(
    recipients.map((userId) =>
      notificationService
        .createNotification({
          userId,
          type: 'opportunity_interest',
          title: 'New interest in an opportunity deal',
          message: property.title,
          relatedEntityType: 'opportunity_interest',
          relatedEntityId: interestId,
        })
        .catch((err) => console.error('opportunity interest notification failed:', err.message))
    )
  );
}

const INTEREST_SELECT = `
  SELECT oi.*, p.title AS property_title, p.listing_category, p.city, p.locality,
         p.reserve_price, p.price, p.auction_date, p.investment_score,
         u.full_name AS investor_name, assignee.full_name AS assigned_to_name
  FROM opportunity_interests oi
  JOIN properties p ON p.id = oi.property_id
  JOIN users u ON u.id = oi.user_id
  LEFT JOIN users assignee ON assignee.id = oi.assigned_to
`;

async function getInterestById(id) {
  const result = await pool.query(`${INTEREST_SELECT} WHERE oi.id = $1`, [id]);
  if (!result.rows[0]) throw notFound('Interest not found');
  const history = await pool.query(
    `SELECT h.*, u.full_name AS changed_by_name FROM opportunity_interest_history h
     LEFT JOIN users u ON u.id = h.changed_by WHERE h.interest_id = $1 ORDER BY h.created_at ASC`,
    [id]
  );
  return { ...result.rows[0], history: history.rows };
}

function assertInterestVisible(interest, user) {
  if (isAdmin(user.role) || STAFF_ROLES.includes(user.role)) return;
  if (interest.user_id === user.id || interest.assigned_to === user.id) return;
  throw notFound('Interest not found');
}

async function getInterestForUser(id, user) {
  const interest = await getInterestById(id);
  assertInterestVisible(interest, user);
  return interest;
}

async function listInterests(query, user) {
  const { page, limit, offset } = parsePagination(query);
  const where = [];
  const params = [];
  if (!STAFF_ROLES.includes(user.role)) {
    params.push(user.id);
    where.push(`(oi.user_id = $${params.length} OR oi.assigned_to = $${params.length})`);
  }
  for (const [key, col] of [['stage', 'oi.stage'], ['propertyId', 'oi.property_id'], ['assignedTo', 'oi.assigned_to']]) {
    if (query[key]) {
      params.push(query[key]);
      where.push(`${col} = $${params.length}`);
    }
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM opportunity_interests oi ${whereClause}`, params);
  const byStage = await pool.query(
    `SELECT oi.stage, COUNT(*)::int AS count FROM opportunity_interests oi ${whereClause} GROUP BY oi.stage`,
    params
  );
  params.push(limit, offset);
  const result = await pool.query(
    `${INTEREST_SELECT} ${whereClause} ORDER BY oi.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    items: result.rows,
    countsByStage: Object.fromEntries(byStage.rows.map((r) => [r.stage, r.count])),
    pagination: buildPagination(page, limit, count.rows[0].count),
  };
}

// One stage at a time (Module 40: "Stage N cannot start until Stage N-1 is
// marked complete"). Dropping is allowed from any open stage; admins may
// step back one stage to correct a mistake. Every move is logged.
async function updateInterestStage(id, toStage, notes, user) {
  const interest = await getInterestById(id);
  const fromStage = interest.stage;
  if (fromStage === toStage) throw badRequest(`Interest is already at ${toStage}`);
  if (['closure', 'dropped'].includes(fromStage)) throw badRequest(`Interest is ${fromStage} and can no longer move`);

  const fromIndex = STAGES.indexOf(fromStage);
  const toIndex = STAGES.indexOf(toStage);
  const allowed =
    toStage === 'dropped' ||
    toIndex === fromIndex + 1 ||
    (isAdmin(user.role) && toIndex === fromIndex - 1);
  if (!allowed) {
    throw badRequest(`Cannot move from ${fromStage} to ${toStage} - next stage is ${STAGES[fromIndex + 1]}`);
  }
  if (toStage === 'dropped' && !notes) throw badRequest('A reason is required to drop an interest');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE opportunity_interests
       SET stage = $1::opportunity_stage,
           dropped_reason = CASE WHEN $1::opportunity_stage = 'dropped' THEN $2 ELSE dropped_reason END
       WHERE id = $3`,
      [toStage, notes || null, id]
    );
    await logStage(client, id, fromStage, toStage, user.id, notes);
    if (interest.lead_id && ['closure', 'dropped'].includes(toStage)) {
      const leadStatus = toStage === 'closure' ? 'won' : 'lost';
      const previous = await client.query('SELECT status FROM leads WHERE id = $1', [interest.lead_id]);
      await client.query('UPDATE leads SET status = $1 WHERE id = $2', [leadStatus, interest.lead_id]);
      await client.query(
        `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'status_changed', $3)`,
        [interest.lead_id, user.id, JSON.stringify({ from: previous.rows[0]?.status, to: leadStatus, via: 'opportunity_pipeline' })]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await notificationService
    .createNotification({
      userId: interest.user_id,
      type: 'opportunity_stage_changed',
      title: 'Your opportunity deal moved forward',
      message: `${interest.property_title}: ${toStage.replace(/_/g, ' ')}`,
      relatedEntityType: 'opportunity_interest',
      relatedEntityId: id,
    })
    .catch(() => {});
  return getInterestById(id);
}

async function assignInterest(id, assigneeId, user, meta = {}) {
  const interest = await getInterestById(id);
  const assignee = await pool.query(
    `SELECT u.id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.status = 'active'`,
    [assigneeId]
  );
  if (!assignee.rows[0] || !STAFF_ROLES.includes(assignee.rows[0].role_name)) {
    throw badRequest(`Assignee must be an active ${STAFF_ROLES.join(' / ')} user`);
  }
  await pool.query('UPDATE opportunity_interests SET assigned_to = $1 WHERE id = $2', [assigneeId, id]);
  if (interest.lead_id) await pool.query('UPDATE leads SET assigned_to = $1 WHERE id = $2', [assigneeId, interest.lead_id]);
  await auditService.log({
    actor: user,
    action: 'opportunity_interest_assigned',
    entityType: 'opportunity_interest',
    entityId: id,
    before: { assignedTo: interest.assigned_to },
    after: { assignedTo: assigneeId },
    ...meta,
  });
  return getInterestById(id);
}

// ---------------------------------------------------------------------
// Alerts (Engine 4 "auction alerts" + "notification priority integration")
// ---------------------------------------------------------------------
// Matching investors are alerted through the notification-intelligence
// queue (investorAlert.service): priority deals now, the rest in each
// investor's daily window, with fatigue control and channel choice.
async function sendAlerts(propertyId) {
  const r = await require('./investorAlert.service').queueAlertsForDeal(propertyId);
  return { sent: r.sentNow || 0, matched: r.matched || 0, queued: r.queued || 0, suppressed: r.suppressed || 0, priority: !!r.priority };
}

function safeSendAlerts(propertyId) {
  sendAlerts(propertyId).catch((err) => console.error(`Opportunity alerts failed for ${propertyId}:`, err.message));
}

async function rescore(propertyId) {
  const exists = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
  if (!exists.rows[0]) throw notFound('Property not found');
  await opportunityScoring.refreshScores(propertyId);
  const result = await pool.query(
    `SELECT id, listing_category, discount_percent, investment_score, liquidity_score, liquidity_band, score_breakdown, scored_at
     FROM properties WHERE id = $1`,
    [propertyId]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------
// Ingestion - layers 2 (parse) to 5 (publish)
// ---------------------------------------------------------------------
const CONTACT_TOKEN = /(?:\+?91[\s.-]?)?\b[6-9](?:[\s.-]?\d){9}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:https?:\/\/|www\.)\S+/gi;
const CONTACT_SENTENCE = /[^.\n]*\b(contact|call|phone|mobile|e-?mail|whatsapp|telegram)\b[^.\n]*[.\n]?/gi;

const CONTACT_CLAUSE = /\s*[-–|,;:(]?\s*\b(contact|call|phone|mobile|e-?mail|whatsapp|telegram)\b.*$/i;

// Sec. 23 / portal scraping rules: contact data is never captured. In
// descriptions, sentences mentioning contact channels are dropped; any
// stray phone/email/URL tokens are removed.
function stripContactDetails(text) {
  if (!text) return text;
  return String(text).replace(CONTACT_SENTENCE, ' ').replace(CONTACT_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim() || null;
}

// Titles are one line, so only the trailing "- contact ... " clause goes.
function stripContactFromTitle(text) {
  if (!text) return null;
  return String(text).replace(CONTACT_TOKEN, ' ').replace(CONTACT_CLAUSE, '').replace(/\s{2,}/g, ' ').trim() || null;
}

function pick(raw, keys) {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function parseArea(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const text = String(value).toLowerCase().replace(/,/g, '');
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  if (/acre/.test(text)) return Math.round(n * 43560);
  if (/hectare/.test(text)) return Math.round(n * 107639);
  if (/sq\.?\s*(m|mt|mtr|meter|metre)|sqm|square\s*met/.test(text)) return Math.round(n * 10.7639);
  if (/sq\.?\s*y|yard|gaj/.test(text)) return Math.round(n * 9);
  return n;
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  // DD/MM/YYYY or DD-MM-YYYY, optional "HH:MM" and AM/PM (Indian notices)
  const m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})\s*(am|pm)?)?/i);
  if (m) {
    let hour = Number(m[4] || 0);
    if (m[6]) hour = (hour % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${m[5] || '00'}:00+05:30`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const INSTITUTIONAL_RE = /\b(school|college|university|hospital|nursing home|hotel|resort|campus|institute)\b/i;

function mapPropertyType(text) {
  const t = String(text || '').toLowerCase();
  if (/flat|apartment|residential unit|dwelling unit/.test(t)) return 'apartment';
  if (/villa|bungalow/.test(t)) return 'villa';
  if (/house|kothi|builder floor|floor/.test(t)) return 'independent_house';
  if (/plot|land|site/.test(t)) return 'plot';
  if (/farm/.test(t)) return 'farmhouse';
  if (/shop|office|commercial|industrial|factory|warehouse|godown|showroom|hotel|hospital|school|college/.test(t)) return 'commercial';
  return t ? 'other' : null;
}

function mapSourceType(text, fallbackCategory) {
  const t = String(text || '').toLowerCase();
  if (/sarfaesi|bank/.test(t)) return 'sarfaesi_bank_auction';
  if (/drt/.test(t)) return 'drt_auction';
  if (/nclt|ibc|liquidat|insolven/.test(t)) return 'nclt_liquidation';
  if (/\barc\b|asset reconstruction/.test(t)) return 'arc_asset';
  if (/nbfc|finance|housing finance/.test(t)) return 'nbfc_repossession';
  if (/housing board|dda|mhada|dusib|huda|bda/.test(t)) return 'housing_board';
  if (/notice|newspaper|gazette/.test(t)) return 'legal_notice';
  return fallbackCategory === 'special_situation' ? 'other' : 'sarfaesi_bank_auction';
}

// Field -> weight toward the 0-100 parse confidence. The first group is what
// a deal needs before it can be published at all.
const CONFIDENCE_WEIGHTS = {
  title: 15,
  city: 15,
  property_type: 10,
  reserve_price: 20,
  auction_date: 15,
  source_bank: 10,
  locality: 5,
  area_sqft: 5,
  emd_amount: 5,
};
const PUBLISH_REQUIRED = ['title', 'city', 'property_type', 'reserve_price'];

async function resolvePincode(pincode) {
  if (!pincode) return null;
  const r = await pool.query(
    `SELECT c.city_name, l.locality_name FROM pincodes p JOIN cities c ON c.id = p.city_id
     LEFT JOIN localities l ON l.id = p.locality_id WHERE p.pincode = $1 LIMIT 1`,
    [String(pincode).trim()]
  );
  return r.rows[0] || null;
}

async function normalise(raw, { defaultCategory = 'auction' } = {}) {
  const issues = [];
  const listingCategory = ['auction', 'special_situation'].includes(pick(raw, ['listing_category', 'listingCategory']))
    ? pick(raw, ['listing_category', 'listingCategory'])
    : defaultCategory;

  const rawTitle = pick(raw, ['title', 'property_title', 'name', 'description_short']);
  const rawType = pick(raw, ['property_type', 'propertyType', 'type', 'asset_type', 'category']);
  const description = stripContactDetails(pick(raw, ['description', 'details', 'property_description']));
  const combinedText = `${rawTitle || ''} ${rawType || ''} ${description || ''}`;

  const n = {
    listing_category: listingCategory,
    title: stripContactFromTitle(rawTitle)?.slice(0, 200) || null,
    description,
    property_type: mapPropertyType(rawType || rawTitle),
    city: pick(raw, ['city', 'district', 'town']),
    locality: pick(raw, ['locality', 'area', 'location', 'sub_locality']),
    pincode: pick(raw, ['pincode', 'pin', 'pin_code']),
    latitude: pick(raw, ['latitude', 'lat']) != null ? Number(pick(raw, ['latitude', 'lat'])) : null,
    longitude: pick(raw, ['longitude', 'lng', 'lon']) != null ? Number(pick(raw, ['longitude', 'lng', 'lon'])) : null,
    area_sqft: parseArea(pick(raw, ['area_sqft', 'area', 'size', 'built_up_area', 'plot_area'])),
    reserve_price: parsePriceToNumber(pick(raw, ['reserve_price', 'reservePrice', 'price', 'reserve'])),
    emd_amount: parsePriceToNumber(pick(raw, ['emd_amount', 'emdAmount', 'emd'])),
    estimated_market_value: parsePriceToNumber(pick(raw, ['estimated_market_value', 'market_value', 'estimatedMarketValue'])),
    auction_date: parseDate(pick(raw, ['auction_date', 'auctionDate', 'date_of_auction', 'e_auction_date'])),
    emd_deadline: parseDate(pick(raw, ['emd_deadline', 'emd_last_date', 'last_date_of_emd'])),
    inspection_date: parseDate(pick(raw, ['inspection_date', 'date_of_inspection'])),
    source_bank: pick(raw, ['source_bank', 'bank', 'bank_name', 'institution', 'lender']),
    auction_reference_id: pick(raw, ['auction_reference_id', 'auction_id', 'reference_id', 'property_id', 'ref_no']),
    auction_portal_url: pick(raw, ['auction_portal_url', 'portal_url', 'url', 'link']),
    possession_type: (() => {
      const p = String(pick(raw, ['possession_type', 'possession']) || '').toLowerCase();
      if (p.includes('physical')) return 'physical';
      if (p.includes('symbolic')) return 'symbolic';
      return p ? 'unknown' : null;
    })(),
    opportunity_source_type: pick(raw, ['opportunity_source_type'])
      || mapSourceType(pick(raw, ['source_type', 'source', 'act', 'auction_type']) || pick(raw, ['bank', 'bank_name', 'institution']), listingCategory),
    is_institutional_asset: INSTITUTIONAL_RE.test(combinedText),
  };

  if (!n.city && n.pincode) {
    const resolved = await resolvePincode(n.pincode);
    if (resolved) {
      n.city = resolved.city_name;
      n.locality = n.locality || resolved.locality_name;
    } else {
      issues.push({ field: 'pincode', issue: 'Pincode not found in geography master - city not resolved' });
    }
  }
  if (n.auction_portal_url && !/^https?:\/\//i.test(n.auction_portal_url)) n.auction_portal_url = null;

  let confidence = 0;
  for (const [field, weight] of Object.entries(CONFIDENCE_WEIGHTS)) {
    const notApplicable = listingCategory !== 'auction' && ['auction_date', 'source_bank', 'emd_amount'].includes(field);
    if (notApplicable || (n[field] !== null && n[field] !== undefined && n[field] !== '')) confidence += weight;
    else issues.push({ field, issue: 'missing or unparseable' });
  }
  if (n.auction_date && new Date(n.auction_date) < new Date()) issues.push({ field: 'auction_date', issue: 'auction date is in the past' });

  return { normalised: n, confidence: Math.min(confidence, 100), issues };
}

async function findDuplicate(n) {
  if (n.source_bank && n.auction_reference_id) {
    const r = await pool.query(
      `SELECT id FROM properties WHERE LOWER(source_bank) = LOWER($1) AND auction_reference_id = $2 LIMIT 1`,
      [n.source_bank, String(n.auction_reference_id)]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  if (n.city && n.reserve_price) {
    const r = await pool.query(
      `SELECT id FROM properties
       WHERE listing_category::text = ANY($1::text[]) AND LOWER(city) = LOWER($2)
         AND COALESCE(LOWER(locality), '') = COALESCE(LOWER($3), '')
         AND reserve_price BETWEEN $4 * 0.99 AND $4 * 1.01
         AND ($5::timestamptz IS NULL OR auction_date::date = $5::timestamptz::date)
       LIMIT 1`,
      [CATEGORIES, n.city, n.locality, n.reserve_price, n.auction_date]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

async function getSystemUser() {
  const configured = await configService.getConfig('opportunity.system_user_id', null);
  const result = await pool.query(
    `SELECT u.id, u.tenant_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
     WHERE ${configured ? 'u.id = $1' : `r.name = 'super_admin' AND $1::uuid IS NULL`} AND u.status = 'active'
     ORDER BY u.created_at ASC LIMIT 1`,
    [configured]
  );
  if (!result.rows[0]) throw badRequest('No active system user available to publish opportunities');
  return result.rows[0];
}

// `crawlerSourceId` links items to the crawler that produced them;
// `requiresLegalReview` (legal / newspaper notice sources) holds every item
// for the lawyer-panel review gate - never auto-published.
async function ingestItems(items, { sourceName, dataSource = 'api', defaultCategory = 'auction', crawlerSourceId = null, requiresLegalReview = false }, user) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('items must be a non-empty array');
  if (items.length > 1000) throw badRequest('A single ingest call is limited to 1000 items');

  const [autoPublish, minConfidence] = await Promise.all([
    configService.getConfig('opportunity.auto_publish_enabled', false),
    configService.getConfig('opportunity.auto_publish_min_confidence', 95),
  ]);

  const summary = { received: items.length, needs_review: 0, duplicate: 0, published: 0, failed: 0, skipped_existing: 0, items: [] };

  for (const raw of items) {
    const externalRef = pick(raw, ['auction_reference_id', 'auction_id', 'reference_id', 'external_ref', 'ref_no']);
    if (externalRef) {
      const seen = await pool.query(
        'SELECT id, status FROM opportunity_ingestion_items WHERE source_name = $1 AND external_ref = $2',
        [sourceName, String(externalRef)]
      );
      if (seen.rows[0]) {
        summary.skipped_existing++;
        summary.items.push({ id: seen.rows[0].id, status: seen.rows[0].status, externalRef, skipped: true });
        continue;
      }
    }

    const { normalised, confidence, issues } = await normalise(raw, { defaultCategory });
    const duplicateOf = await findDuplicate(normalised);
    let status = duplicateOf ? 'duplicate' : 'needs_review';

    const inserted = await pool.query(
      `INSERT INTO opportunity_ingestion_items (source_name, source_url, external_ref, raw_payload, normalised,
         confidence, issues, status, duplicate_of_property_id, ingested_by, crawler_source_id, requires_legal_review)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        sourceName,
        normalised.auction_portal_url,
        externalRef ? String(externalRef) : null,
        JSON.stringify(raw),
        JSON.stringify({ ...normalised, data_source: dataSource }),
        confidence,
        JSON.stringify(issues),
        status,
        duplicateOf,
        user?.id || null,
        crawlerSourceId,
        requiresLegalReview || normalised.opportunity_source_type === 'legal_notice',
      ]
    );
    const itemId = inserted.rows[0].id;

    // Layer 5: auto-publish only when enabled, confident, complete, and not
    // from a legal/newspaper notice (those always need the lawyer-panel
    // review gate before going live).
    const complete = PUBLISH_REQUIRED.every((f) => normalised[f] != null);
    if (!duplicateOf && autoPublish && !requiresLegalReview && confidence >= Number(minConfidence) && complete && normalised.opportunity_source_type !== 'legal_notice') {
      try {
        await publishItem(itemId, {}, user || (await getSystemUser()), { auto: true });
        status = 'published';
      } catch (err) {
        await pool.query(
          `UPDATE opportunity_ingestion_items SET status = 'needs_review', review_notes = $1 WHERE id = $2`,
          [`Auto-publish failed: ${err.message}`, itemId]
        );
      }
    }

    summary[status]++;
    summary.items.push({ id: itemId, status, confidence, duplicateOf, externalRef: externalRef || null });
  }
  return summary;
}

async function listQueue(query) {
  const { page, limit, offset } = parsePagination(query);
  const where = [];
  const params = [];
  if (query.status) {
    params.push(query.status);
    where.push(`status = $${params.length}`);
  }
  if (query.sourceName) {
    params.push(query.sourceName);
    where.push(`source_name = $${params.length}`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM opportunity_ingestion_items ${whereClause}`, params);
  const byStatus = await pool.query(`SELECT status, COUNT(*)::int AS count FROM opportunity_ingestion_items GROUP BY status`);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT id, source_name, external_ref, normalised, confidence, issues, status, duplicate_of_property_id,
            property_id, review_notes, created_at, reviewed_at, crawler_source_id,
            requires_legal_review, legal_reviewed_at, legal_review_notes
     FROM opportunity_ingestion_items ${whereClause}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    items: result.rows,
    countsByStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
    pagination: buildPagination(page, limit, count.rows[0].count),
  };
}

async function getQueueItem(id) {
  const result = await pool.query('SELECT * FROM opportunity_ingestion_items WHERE id = $1', [id]);
  if (!result.rows[0]) throw notFound('Ingestion item not found');
  return result.rows[0];
}

// Turns a reviewed ingestion item into a live, approved listing. Goes
// through property.service.createProperty so the content guard, price
// parsing and scoring apply exactly as for a hand-entered listing, then
// approveProperty, which is what fires investor alerts.
async function publishItem(id, overrides, user, { auto = false } = {}) {
  const item = await getQueueItem(id);
  if (!['needs_review', 'pending', 'duplicate'].includes(item.status)) {
    throw badRequest(`Item is ${item.status} and cannot be published`);
  }
  if (item.status === 'duplicate' && !overrides.forceDespiteDuplicate) {
    throw badRequest('Item looks like a duplicate of an existing listing - pass forceDespiteDuplicate to publish anyway');
  }

  // Legal / newspaper notices go live only after the lawyer-panel review.
  if (item.requires_legal_review && !item.legal_reviewed_at) {
    throw badRequest('This item came from a legal / newspaper notice - it needs legal review before publishing');
  }

  const n = { ...item.normalised, ...(overrides.normalised || {}) };
  const missing = PUBLISH_REQUIRED.filter((f) => n[f] === null || n[f] === undefined || n[f] === '');
  if (missing.length) throw badRequest(`Cannot publish - missing: ${missing.join(', ')}`);

  const propertyService = require('./property.service');
  const property = await propertyService.createProperty(
    {
      title: n.title,
      description: n.description || null,
      propertyType: n.property_type,
      transactionType: 'sell',
      price: formatInr(n.reserve_price),
      priceValue: n.reserve_price,
      city: n.city,
      locality: n.locality || null,
      latitude: Number.isFinite(n.latitude) ? n.latitude : null,
      longitude: Number.isFinite(n.longitude) ? n.longitude : null,
      areaSqft: n.area_sqft || null,
      // Institutional assets found by the pipeline (school, college, hospital
      // campuses...) are routed to the Institutional engine (Engine 7).
      listingCategory: n.is_institutional_asset && !overrides.keepCategory ? 'institutional' : n.listing_category || 'auction',
      auctionDate: n.auction_date || null,
      sourceBank: n.source_bank || null,
      opportunitySourceType: n.opportunity_source_type || null,
      reservePrice: n.reserve_price,
      emdAmount: n.emd_amount ?? null,
      emdDeadline: n.emd_deadline || null,
      inspectionDate: n.inspection_date || null,
      auctionReferenceId: n.auction_reference_id ? String(n.auction_reference_id) : null,
      auctionPortalUrl: n.auction_portal_url || null,
      possessionType: n.possession_type || null,
      estimatedMarketValue: n.estimated_market_value ?? null,
      isInstitutionalAsset: !!n.is_institutional_asset,
      situationTags: n.situation_tags || [],
      riskIndicators: n.risk_indicators || [],
    },
    { id: user.id, role: user.role, tenant_id: null },
    // Imported deals are published below after review, but never get the
    // Verified badge automatically - that is for team-vetted listings.
    { autoVerify: false }
  );

  await pool.query(
    `UPDATE properties SET data_source = $1, source_confidence = $2 WHERE id = $3`,
    [n.data_source || 'api', item.confidence, property.id]
  );
  await pool.query(
    `UPDATE opportunity_ingestion_items SET status = 'published', property_id = $1, reviewed_by = $2,
            reviewed_at = now(), review_notes = COALESCE($3, review_notes), normalised = $4
     WHERE id = $5`,
    [property.id, user.id, auto ? 'Auto-published' : overrides.notes || null, JSON.stringify(n), id]
  );
  await propertyService.approveProperty(property.id, user);
  await auditService.log({
    actor: user,
    action: auto ? 'opportunity_auto_published' : 'opportunity_published',
    entityType: 'opportunity_ingestion_item',
    entityId: id,
    after: { propertyId: property.id, confidence: item.confidence },
  });
  return propertyService.getPropertyById(property.id);
}

// Lawyer-panel sign-off for a legal / newspaper notice item.
async function markLegalReviewed(id, notes, user) {
  const item = await getQueueItem(id);
  if (!item.requires_legal_review) throw badRequest('This item does not need legal review');
  await pool.query(
    `UPDATE opportunity_ingestion_items SET legal_reviewed_by = $1, legal_reviewed_at = now(), legal_review_notes = $2 WHERE id = $3`,
    [user.id, notes || null, id]
  );
  await auditService.log({ actor: user, action: 'opportunity_legal_reviewed', entityType: 'opportunity_ingestion_item', entityId: id, after: { notes } });
  return getQueueItem(id);
}

async function rejectItem(id, notes, user) {
  const item = await getQueueItem(id);
  if (item.status === 'published') throw badRequest('Item is already published');
  await pool.query(
    `UPDATE opportunity_ingestion_items SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_notes = $2 WHERE id = $3`,
    [user.id, notes || null, id]
  );
  await auditService.log({ actor: user, action: 'opportunity_ingestion_rejected', entityType: 'opportunity_ingestion_item', entityId: id, after: { notes } });
  return getQueueItem(id);
}

// Dashboard summary for the staff "Opportunity Deals" screen.
async function getSummary() {
  const [live, pipeline, queue, upcoming] = await Promise.all([
    pool.query(
      `SELECT listing_category, COUNT(*)::int AS count, ROUND(AVG(investment_score))::int AS avg_score,
              ROUND(AVG(discount_percent), 1) AS avg_discount
       FROM properties WHERE status = 'approved' AND listing_category::text = ANY($1::text[])
       GROUP BY listing_category`,
      [CATEGORIES]
    ),
    pool.query(`SELECT stage, COUNT(*)::int AS count FROM opportunity_interests GROUP BY stage`),
    pool.query(`SELECT status, COUNT(*)::int AS count FROM opportunity_ingestion_items GROUP BY status`),
    pool.query(
      `SELECT id, title, city, auction_date, reserve_price, investment_score FROM properties
       WHERE status = 'approved' AND listing_category = 'auction' AND auction_date BETWEEN now() AND now() + interval '14 days'
       ORDER BY auction_date ASC LIMIT 10`
    ),
  ]);
  return {
    liveByCategory: live.rows,
    pipelineByStage: Object.fromEntries(pipeline.rows.map((r) => [r.stage, r.count])),
    ingestionQueue: Object.fromEntries(queue.rows.map((r) => [r.status, r.count])),
    upcomingAuctions: upcoming.rows,
  };
}

module.exports = {
  getAccess,
  toTeaser,
  TEASER_COLUMNS,
  listPublicTeasers,
  listForInvestor,
  getOpportunity,
  expressInterest,
  listInterests,
  getInterestForUser,
  updateInterestStage,
  assignInterest,
  sendAlerts,
  safeSendAlerts,
  rescore,
  normalise,
  ingestItems,
  listQueue,
  getQueueItem,
  publishItem,
  markLegalReviewed,
  rejectItem,
  getSummary,
  getSystemUser,
};
