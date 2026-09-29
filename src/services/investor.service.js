const pool = require('../config/db');
const auditService = require('./audit.service');
const customerService = require('./customer.service');
const notificationService = require('./notification.service');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 3 investor profiles (NRI / OCI and HNI). NRI, HNI and
// institutional tracks are handled centrally by A R Buildwel's own
// relationship managers (sec. 14 - exempt from franchise territory), so
// staff here means internal_sales / admin / super_admin, not agencies.
const STAFF_ROLES = ['internal_sales', 'admin', 'super_admin'];

const PROFILE_FIELDS = {
  isNri: 'is_nri',
  isHni: 'is_hni',
  residencyStatus: 'residency_status',
  countryOfResidence: 'country_of_residence',
  cityOfResidence: 'city_of_residence',
  timeZone: 'time_zone',
  preferredContactWindow: 'preferred_contact_window',
  investorCategory: 'investor_category',
  ticketSizeMin: 'ticket_size_min',
  ticketSizeMax: 'ticket_size_max',
  riskAppetite: 'risk_appetite',
  investmentHorizonYears: 'investment_horizon_years',
  institutionalInterest: 'institutional_interest',
  alertsEnabled: 'alerts_enabled',
  alertMode: 'alert_mode',
  alertMaxPerDay: 'alert_max_per_day',
};
const PROFILE_JSON_FIELDS = {
  propertyInterestTypes: 'property_interest_types',
  alertChannels: 'alert_channels',
  assetClassPreferences: 'asset_class_preferences',
  preferredCities: 'preferred_cities',
  preferredPropertyTypes: 'preferred_property_types',
};

const PROFILE_SELECT = `
  SELECT ip.*, u.full_name, u.email, u.mobile,
         manager.full_name AS manager_name, manager.email AS manager_email, manager.mobile AS manager_mobile,
         verifier.full_name AS verified_by_name
  FROM investor_profiles ip
  JOIN users u ON u.id = ip.user_id
  LEFT JOIN users manager ON manager.id = ip.assigned_manager_id
  LEFT JOIN users verifier ON verifier.id = ip.verified_by
`;

function isStaff(user) {
  return STAFF_ROLES.includes(user.role);
}

async function getProfileByUserId(userId) {
  const result = await pool.query(`${PROFILE_SELECT} WHERE ip.user_id = $1`, [userId]);
  return result.rows[0] || null;
}

async function getProfileById(id) {
  const result = await pool.query(`${PROFILE_SELECT} WHERE ip.id = $1`, [id]);
  if (!result.rows[0]) throw notFound('Investor profile not found');
  return result.rows[0];
}

function assertProfileAccess(profile, user) {
  if (isStaff(user) || profile.user_id === user.id || profile.assigned_manager_id === user.id) return;
  throw notFound('Investor profile not found');
}

// Resolves which investor profile a request acts on: the caller's own, or -
// for staff / the assigned manager - the one named by `investorId`.
async function resolveProfile(user, investorId) {
  if (investorId) {
    const profile = await getProfileById(investorId);
    assertProfileAccess(profile, user);
    return profile;
  }
  const own = await getProfileByUserId(user.id);
  if (!own) {
    throw isStaff(user)
      ? badRequest('investorId is required when acting on behalf of an investor')
      : notFound('Create your investor profile first (PUT /investors/me)');
  }
  return own;
}

function assertNri(profile) {
  if (!profile.is_nri) throw forbidden('This is an NRI service - mark the investor profile as NRI first');
}

function assertHni(profile) {
  if (!profile.is_hni) throw forbidden('This is an HNI service - mark the investor profile as HNI first');
}

// PUT /investors/me - create or update the caller's own profile. Material
// changes (becoming NRI/HNI, ticket size) send a verified profile back to
// pending, since verification was granted against the old details.
// Screen 2 "assigned manager introduction": a new NRI / HNI investor gets a
// relationship manager straight away - the active internal sales user with
// the fewest investors - and both sides are introduced by notification.
// Admins can reassign any time (assignManager).
async function introduceManager(profileId, investorName) {
  const configService = require('./config.service');
  if (!(await configService.getConfig('investor.auto_assign_manager', true))) return null;
  const pick = await pool.query(
    `SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'internal_sales' AND u.status = 'active'
     ORDER BY (SELECT COUNT(*) FROM investor_profiles ip WHERE ip.assigned_manager_id = u.id) ASC, u.created_at ASC
     LIMIT 1`
  );
  const manager = pick.rows[0];
  if (!manager) return null;
  const updated = await pool.query(
    'UPDATE investor_profiles SET assigned_manager_id = $1 WHERE id = $2 AND assigned_manager_id IS NULL RETURNING user_id',
    [manager.id, profileId]
  );
  if (!updated.rows[0]) return null;
  await notificationService.createNotification({
    userId: updated.rows[0].user_id,
    type: 'investor_manager_assigned',
    title: 'Meet your relationship manager',
    message: `${manager.full_name} from A R Buildwel is your dedicated relationship manager and will be in touch shortly. You can reach them any time from your dashboard.`,
    relatedEntityType: 'investor_profile',
    relatedEntityId: profileId,
  });
  await notificationService.createNotification({
    userId: manager.id,
    type: 'investor_assigned',
    title: 'New investor assigned to you',
    message: `${investorName} has just created an investor profile - please introduce yourself.`,
    relatedEntityType: 'investor_profile',
    relatedEntityId: profileId,
  });
  return manager;
}

async function upsertMyProfile(data, user) {
  const existing = await getProfileByUserId(user.id);

  if (!existing) {
    if (!data.isNri && !data.isHni) throw badRequest('Set isNri and/or isHni to create an investor profile');
    const me = await pool.query('SELECT full_name, email, mobile FROM users WHERE id = $1', [user.id]);
    const customer = await customerService.findOrCreateCustomerByContact({
      fullName: me.rows[0].full_name,
      email: me.rows[0].email,
      mobile: me.rows[0].mobile,
      userId: user.id,
    });

    const cols = ['user_id', 'customer_id', 'tenant_id'];
    const values = [user.id, customer.id, user.tenant_id || null];
    for (const [key, col] of Object.entries(PROFILE_FIELDS)) {
      if (data[key] !== undefined) {
        cols.push(col);
        values.push(data[key]);
      }
    }
    for (const [key, col] of Object.entries(PROFILE_JSON_FIELDS)) {
      if (data[key] !== undefined) {
        cols.push(col);
        values.push(JSON.stringify(data[key]));
      }
    }
    const result = await pool.query(
      `INSERT INTO investor_profiles (${cols.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      values
    );
    // Permanent referral code carries the investor category (NR- / HN-)
    // when this is the person's first category.
    await require('./referral.service')
      .ensureReferralCode(user.id, user.role, [data.isHni ? 'hni' : 'nri'])
      .catch((err) => console.error('[investor] referral code:', err.message));
    await introduceManager(result.rows[0].id, me.rows[0].full_name).catch((err) =>
      console.error('[investor] manager assignment failed:', err.message)
    );
    return getProfileById(result.rows[0].id);
  }

  const set = [];
  const params = [];
  for (const [key, col] of Object.entries(PROFILE_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${col} = $${params.length}`);
    }
  }
  for (const [key, col] of Object.entries(PROFILE_JSON_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(JSON.stringify(data[key]));
      set.push(`${col} = $${params.length}`);
    }
  }
  if (set.length === 0) throw badRequest('No updatable fields provided');

  const material =
    (data.isNri !== undefined && data.isNri !== existing.is_nri) ||
    (data.isHni !== undefined && data.isHni !== existing.is_hni) ||
    (data.ticketSizeMax !== undefined && Number(data.ticketSizeMax) !== Number(existing.ticket_size_max));
  if (material && existing.verification_status === 'verified') {
    set.push(`verification_status = 'pending'`, 'verified_by = NULL', 'verified_at = NULL');
  }

  params.push(existing.id);
  await pool.query(`UPDATE investor_profiles SET ${set.join(', ')} WHERE id = $${params.length}`, params);
  return getProfileById(existing.id);
}

async function listProfiles(query) {
  const { page, limit, offset } = parsePagination(query);
  const where = [];
  const params = [];
  if (query.type === 'nri') where.push('ip.is_nri = true');
  if (query.type === 'hni') where.push('ip.is_hni = true');
  for (const [key, col] of [['verificationStatus', 'ip.verification_status'], ['managerId', 'ip.assigned_manager_id'], ['investorCategory', 'ip.investor_category']]) {
    if (query[key]) {
      params.push(query[key]);
      where.push(`${col} = $${params.length}`);
    }
  }
  if (query.unassigned === 'true') where.push('ip.assigned_manager_id IS NULL');
  if (query.search) {
    params.push(`%${query.search}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.mobile ILIKE $${params.length} OR ip.country_of_residence ILIKE $${params.length})`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM investor_profiles ip JOIN users u ON u.id = ip.user_id ${whereClause}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `${PROFILE_SELECT} ${whereClause} ORDER BY ip.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: result.rows, pagination: buildPagination(page, limit, count.rows[0].count) };
}

async function verifyProfile(id, { status, notes }, user, meta = {}) {
  const profile = await getProfileById(id);
  await pool.query(
    `UPDATE investor_profiles SET verification_status = $1::varchar, verification_notes = $2,
            verified_by = $3, verified_at = CASE WHEN $1::varchar = 'verified' THEN now() ELSE NULL END
     WHERE id = $4`,
    [status, notes || null, user.id, id]
  );
  await auditService.log({
    actor: user,
    action: 'investor_profile_verification',
    entityType: 'investor_profile',
    entityId: id,
    before: { status: profile.verification_status },
    after: { status, notes: notes || null },
    ...meta,
  });
  await notificationService
    .createNotification({
      userId: profile.user_id,
      type: 'investor_profile_verification',
      title: status === 'verified' ? 'Your investor profile is verified' : 'Investor profile update',
      message:
        status === 'verified'
          ? 'You now have full access to curated deals, auctions and special situation opportunities.'
          : notes || `Verification status: ${status}`,
      relatedEntityType: 'investor_profile',
      relatedEntityId: id,
    })
    .catch(() => {});
  return getProfileById(id);
}

async function assignManager(id, managerId, user, meta = {}) {
  const profile = await getProfileById(id);
  const manager = await pool.query(
    `SELECT u.id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.status = 'active'`,
    [managerId]
  );
  if (!manager.rows[0] || !STAFF_ROLES.includes(manager.rows[0].role_name)) {
    throw badRequest(`Manager must be an active ${STAFF_ROLES.join(' / ')} user`);
  }
  await pool.query('UPDATE investor_profiles SET assigned_manager_id = $1 WHERE id = $2', [managerId, id]);
  // Open NRI requests follow the relationship to the new manager.
  await pool.query(
    `UPDATE nri_service_requests SET assigned_manager_id = $1
     WHERE investor_profile_id = $2 AND status NOT IN ('completed', 'cancelled')
       AND (assigned_manager_id IS NULL OR assigned_manager_id = $3)`,
    [managerId, id, profile.assigned_manager_id]
  );
  await auditService.log({
    actor: user,
    action: 'investor_manager_assigned',
    entityType: 'investor_profile',
    entityId: id,
    before: { managerId: profile.assigned_manager_id },
    after: { managerId },
    ...meta,
  });
  await notificationService
    .createNotification({
      userId: managerId,
      type: 'investor_assigned',
      title: `${profile.is_nri ? 'NRI' : 'HNI'} investor assigned to you`,
      message: profile.full_name,
      relatedEntityType: 'investor_profile',
      relatedEntityId: id,
    })
    .catch(() => {});
  return getProfileById(id);
}

// Investor behaviour tracking (Engine 3 / Module 38): which deal types,
// areas and ticket sizes the investor engages with.
async function getBehaviour(id, { days = 90 } = {}) {
  await getProfileById(id);
  const span = Math.min(Math.max(Number(days) || 90, 1), 730);
  const params = [id, span];
  const window = `investor_profile_id = $1 AND created_at > now() - ($2 || ' days')::interval`;
  const [byAction, byCategory, byCity, tickets, recent] = await Promise.all([
    pool.query(`SELECT action, COUNT(*)::int AS count FROM investor_deal_interactions WHERE ${window} GROUP BY action`, params),
    pool.query(
      `SELECT listing_category, COUNT(*)::int AS count FROM investor_deal_interactions WHERE ${window}
       GROUP BY listing_category ORDER BY count DESC`,
      params
    ),
    pool.query(
      `SELECT city, COUNT(*)::int AS count FROM investor_deal_interactions WHERE ${window} AND city IS NOT NULL
       GROUP BY city ORDER BY count DESC LIMIT 10`,
      params
    ),
    pool.query(
      `SELECT MIN(ticket_size) AS min, MAX(ticket_size) AS max,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ticket_size) AS median
       FROM investor_deal_interactions WHERE ${window} AND ticket_size IS NOT NULL`,
      params
    ),
    pool.query(
      `SELECT i.action, i.created_at, p.id AS property_id, p.title, p.listing_category, p.city
       FROM investor_deal_interactions i JOIN properties p ON p.id = i.property_id
       WHERE i.investor_profile_id = $1 AND i.created_at > now() - ($2 || ' days')::interval
       ORDER BY i.created_at DESC LIMIT 20`,
      params
    ),
  ]);
  return {
    days: span,
    byAction: Object.fromEntries(byAction.rows.map((r) => [r.action, r.count])),
    byCategory: byCategory.rows,
    topCities: byCity.rows,
    ticketSize: {
      min: tickets.rows[0].min != null ? Number(tickets.rows[0].min) : null,
      median: tickets.rows[0].median != null ? Number(tickets.rows[0].median) : null,
      max: tickets.rows[0].max != null ? Number(tickets.rows[0].max) : null,
    },
    recent: recent.rows,
  };
}

module.exports = {
  STAFF_ROLES,
  isStaff,
  getProfileByUserId,
  getProfileById,
  assertProfileAccess,
  resolveProfile,
  assertNri,
  assertHni,
  upsertMyProfile,
  listProfiles,
  verifyProfile,
  assignManager,
  getBehaviour,
};
