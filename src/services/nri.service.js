const pool = require('../config/db');
const configService = require('./config.service');
const disclaimerService = require('./disclaimer.service');
const notificationService = require('./notification.service');
const investorService = require('./investor.service');
const { encrypt, decrypt } = require('../utils/crypto');
const { maskPhone } = require('../utils/masking');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 3 - NRI Management Module: owned-property monitoring, rent
// collection, tenant management, service requests with timeline tracking,
// repatriation tracking, and indicative (non-advisory, disclaimered)
// FEMA / TDS guidance. Every rate comes from app_config.

// Indian financial year label for a date: 2026-09-27 -> "2026-27".
function financialYear(date = new Date()) {
  const d = new Date(date);
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function fyBounds(fy) {
  const startYear = Number(String(fy).slice(0, 4));
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}

// ---------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------
const PROPERTY_FIELDS = {
  propertyId: 'property_id',
  title: 'title',
  propertyType: 'property_type',
  city: 'city',
  locality: 'locality',
  address: 'address',
  areaSqft: 'area_sqft',
  ownershipType: 'ownership_type',
  purchasePrice: 'purchase_price',
  purchaseDate: 'purchase_date',
  currentEstimatedValue: 'current_estimated_value',
  valuationDate: 'valuation_date',
  managementStatus: 'management_status',
  occupancyStatus: 'occupancy_status',
  monthlyRentExpected: 'monthly_rent_expected',
  tenantName: 'tenant_name',
  leaseStartDate: 'lease_start_date',
  leaseEndDate: 'lease_end_date',
  notes: 'notes',
};

// Tenant phone is stored encrypted and only ever returned masked
// ("98XXXXXX67") - the NRI and their manager never need the raw number in
// an API response; calls go through the platform.
function presentProperty(row) {
  if (!row) return row;
  const { tenant_phone_encrypted: encrypted, ...rest } = row;
  let tenantPhoneMasked = null;
  if (encrypted) {
    try {
      tenantPhoneMasked = maskPhone(decrypt(encrypted));
    } catch {
      tenantPhoneMasked = 'XXXX';
    }
  }
  return { ...rest, tenant_phone_masked: tenantPhoneMasked };
}

async function getPropertyRow(id) {
  const result = await pool.query('SELECT * FROM nri_properties WHERE id = $1', [id]);
  if (!result.rows[0]) throw notFound('NRI property not found');
  return result.rows[0];
}

async function getAccessibleProperty(id, user) {
  const row = await getPropertyRow(id);
  const profile = await investorService.getProfileById(row.investor_profile_id);
  investorService.assertProfileAccess(profile, user);
  return { row, profile };
}

async function listProperties(user, investorId) {
  const profile = await investorService.resolveProfile(user, investorId);
  investorService.assertNri(profile);
  const result = await pool.query(
    `SELECT np.*,
            (SELECT COUNT(*) FROM nri_service_requests r WHERE r.nri_property_id = np.id
             AND r.status NOT IN ('completed', 'cancelled'))::int AS open_requests,
            (SELECT COALESCE(SUM(rent_due - rent_received), 0) FROM nri_rent_records rr
             WHERE rr.nri_property_id = np.id AND rr.status IN ('due', 'partial', 'overdue')) AS rent_outstanding
     FROM nri_properties np WHERE np.investor_profile_id = $1 ORDER BY np.created_at DESC`,
    [profile.id]
  );
  return result.rows.map(presentProperty);
}

async function createProperty(data, user) {
  const profile = await investorService.resolveProfile(user, data.investorId);
  investorService.assertNri(profile);
  const cols = ['investor_profile_id'];
  const values = [profile.id];
  for (const [key, col] of Object.entries(PROPERTY_FIELDS)) {
    if (data[key] !== undefined) {
      cols.push(col);
      values.push(data[key]);
    }
  }
  if (data.tenantPhone) {
    cols.push('tenant_phone_encrypted');
    values.push(encrypt(data.tenantPhone));
  }
  const result = await pool.query(
    `INSERT INTO nri_properties (${cols.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values
  );
  return presentProperty(result.rows[0]);
}

async function getProperty(id, user) {
  const { row } = await getAccessibleProperty(id, user);
  const [rent, requests] = await Promise.all([
    pool.query('SELECT * FROM nri_rent_records WHERE nri_property_id = $1 ORDER BY period_month DESC LIMIT 12', [id]),
    pool.query(
      `SELECT id, request_type, title, status, priority, sla_due_at, created_at FROM nri_service_requests
       WHERE nri_property_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [id]
    ),
  ]);
  return { ...presentProperty(row), rentRecords: rent.rows, serviceRequests: requests.rows };
}

async function updateProperty(id, data, user) {
  await getAccessibleProperty(id, user);
  const set = [];
  const params = [];
  for (const [key, col] of Object.entries(PROPERTY_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${col} = $${params.length}`);
    }
  }
  if (data.tenantPhone !== undefined) {
    params.push(data.tenantPhone ? encrypt(data.tenantPhone) : null);
    set.push(`tenant_phone_encrypted = $${params.length}`);
  }
  if (set.length === 0) throw badRequest('No updatable fields provided');
  params.push(id);
  const result = await pool.query(`UPDATE nri_properties SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  return presentProperty(result.rows[0]);
}

async function deleteProperty(id, user) {
  await getAccessibleProperty(id, user);
  await pool.query('DELETE FROM nri_properties WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------
// Rent collection
// ---------------------------------------------------------------------
function deriveRentStatus(periodMonth, due, received, explicit) {
  if (explicit === 'waived') return 'waived';
  if (Number(received) >= Number(due)) return 'received';
  if (Number(received) > 0) return 'partial';
  const monthEnd = new Date(periodMonth);
  monthEnd.setMonth(monthEnd.getMonth() + 1, 0);
  return monthEnd < new Date() ? 'overdue' : 'due';
}

function firstOfMonth(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest('periodMonth must be a valid date');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function listRent(propertyId, user) {
  await getAccessibleProperty(propertyId, user);
  const result = await pool.query('SELECT * FROM nri_rent_records WHERE nri_property_id = $1 ORDER BY period_month DESC', [propertyId]);
  return result.rows;
}

// Upserts the rent record for one month (one row per property per month).
async function recordRent(propertyId, data, user) {
  const { row } = await getAccessibleProperty(propertyId, user);
  const period = firstOfMonth(data.periodMonth);
  const due = data.rentDue ?? row.monthly_rent_expected;
  if (due === null || due === undefined) throw badRequest('rentDue is required (no expected monthly rent on the property)');
  const received = data.rentReceived ?? 0;
  const status = deriveRentStatus(period, due, received, data.status);

  const result = await pool.query(
    `INSERT INTO nri_rent_records (nri_property_id, period_month, rent_due, rent_received, tds_deducted, received_on, status, notes, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (nri_property_id, period_month) DO UPDATE SET
       rent_due = EXCLUDED.rent_due, rent_received = EXCLUDED.rent_received, tds_deducted = EXCLUDED.tds_deducted,
       received_on = EXCLUDED.received_on, status = EXCLUDED.status, notes = EXCLUDED.notes, recorded_by = EXCLUDED.recorded_by
     RETURNING *`,
    [propertyId, period, due, received, data.tdsDeducted ?? 0, data.receivedOn || null, status, data.notes || null, user.id]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------
// Service requests
// ---------------------------------------------------------------------
const REQUEST_SELECT = `
  SELECT r.*, np.title AS property_title, u.full_name AS investor_name,
         manager.full_name AS assigned_manager_name,
         (r.sla_due_at < now() AND r.first_response_at IS NULL AND r.status = 'submitted') AS sla_breached
  FROM nri_service_requests r
  JOIN investor_profiles ip ON ip.id = r.investor_profile_id
  JOIN users u ON u.id = ip.user_id
  LEFT JOIN nri_properties np ON np.id = r.nri_property_id
  LEFT JOIN users manager ON manager.id = r.assigned_manager_id
`;

async function getRequestRow(id) {
  const result = await pool.query(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  if (!result.rows[0]) throw notFound('Service request not found');
  return result.rows[0];
}

async function getAccessibleRequest(id, user) {
  const request = await getRequestRow(id);
  const profile = await investorService.getProfileById(request.investor_profile_id);
  if (request.assigned_manager_id !== user.id) investorService.assertProfileAccess(profile, user);
  return { request, profile };
}

async function createRequest(data, user) {
  const profile = await investorService.resolveProfile(user, data.investorId);
  investorService.assertNri(profile);
  if (data.nriPropertyId) {
    const property = await getPropertyRow(data.nriPropertyId);
    if (property.investor_profile_id !== profile.id) throw badRequest('nriPropertyId belongs to a different investor');
  }

  const slaHours = await configService.getConfig('nri.service_request_sla_hours', { low: 72, medium: 48, high: 24, urgent: 4 });
  const priority = data.priority || 'medium';

  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO nri_service_requests (investor_profile_id, nri_property_id, request_type, title, description,
         priority, assigned_manager_id, created_by, sla_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval) RETURNING id`,
      [
        profile.id,
        data.nriPropertyId || null,
        data.requestType,
        data.title,
        data.description || null,
        priority,
        profile.assigned_manager_id,
        user.id,
        Number(slaHours[priority] ?? 48),
      ]
    );
    id = result.rows[0].id;
    await client.query(
      `INSERT INTO nri_service_request_updates (request_id, author_id, update_type, to_status, message)
       VALUES ($1, $2, 'created', 'submitted', $3)`,
      [id, user.id, data.description || null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (profile.assigned_manager_id) {
    await notificationService
      .createNotification({
        userId: profile.assigned_manager_id,
        type: 'nri_service_request',
        title: `New NRI request: ${data.requestType.replace(/_/g, ' ')}`,
        message: `${profile.full_name} - ${data.title}`,
        relatedEntityType: 'nri_service_request',
        relatedEntityId: id,
      })
      .catch(() => {});
  }
  return getRequest(id, user);
}

async function listRequests(user, query) {
  const { page, limit, offset } = parsePagination(query);
  const where = [];
  const params = [];

  if (query.investorId || !investorService.isStaff(user)) {
    const profile = await investorService.resolveProfile(user, query.investorId);
    params.push(profile.id);
    where.push(`r.investor_profile_id = $${params.length}`);
  }
  for (const [key, col] of [['status', 'r.status'], ['requestType', 'r.request_type'], ['priority', 'r.priority'], ['managerId', 'r.assigned_manager_id'], ['nriPropertyId', 'r.nri_property_id']]) {
    if (query[key]) {
      params.push(query[key]);
      where.push(`${col} = $${params.length}`);
    }
  }
  if (query.open === 'true') where.push(`r.status NOT IN ('completed', 'cancelled')`);
  if (query.slaBreached === 'true') where.push(`r.sla_due_at < now() AND r.first_response_at IS NULL AND r.status = 'submitted'`);

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM nri_service_requests r ${whereClause}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `${REQUEST_SELECT} ${whereClause} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: result.rows, pagination: buildPagination(page, limit, count.rows[0].count) };
}

async function getRequest(id, user) {
  const { request, profile } = await getAccessibleRequest(id, user);
  // The investor never sees staff-internal notes on their own timeline.
  const showInternal = investorService.isStaff(user) || request.assigned_manager_id === user.id;
  const updates = await pool.query(
    `SELECT upd.*, u.full_name AS author_name FROM nri_service_request_updates upd
     LEFT JOIN users u ON u.id = upd.author_id
     WHERE upd.request_id = $1 ${showInternal ? '' : 'AND upd.is_internal = false'}
     ORDER BY upd.created_at ASC`,
    [id]
  );
  return { ...request, investor_user_id: profile.user_id, timeline: updates.rows };
}

async function markFirstResponse(client, id, user, request) {
  if (!request.first_response_at && user.id !== request.created_by && investorService.isStaff(user)) {
    await client.query('UPDATE nri_service_requests SET first_response_at = now() WHERE id = $1 AND first_response_at IS NULL', [id]);
  }
}

async function addUpdate(id, { message, isInternal }, user) {
  const { request, profile } = await getAccessibleRequest(id, user);
  const staffSide = investorService.isStaff(user) || request.assigned_manager_id === user.id;
  if (isInternal && !staffSide) throw forbidden('Only staff can add internal notes');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO nri_service_request_updates (request_id, author_id, update_type, message, is_internal)
       VALUES ($1, $2, 'comment', $3, $4)`,
      [id, user.id, message, !!isInternal]
    );
    if (!isInternal) await markFirstResponse(client, id, user, request);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Tell the other side of the conversation.
  if (!isInternal) {
    const recipient = staffSide ? profile.user_id : request.assigned_manager_id;
    if (recipient) {
      await notificationService
        .createNotification({
          userId: recipient,
          type: 'nri_service_request_update',
          title: `Update on: ${request.title}`,
          message: String(message).slice(0, 200),
          relatedEntityType: 'nri_service_request',
          relatedEntityId: id,
        })
        .catch(() => {});
    }
  }
  return getRequest(id, user);
}

const TERMINAL = ['completed', 'cancelled'];

async function updateRequestStatus(id, { status, message }, user) {
  const { request, profile } = await getAccessibleRequest(id, user);
  const staffSide = investorService.isStaff(user) || request.assigned_manager_id === user.id;
  // The investor may only cancel their own request; everything else is staff.
  if (!staffSide && status !== 'cancelled') throw forbidden('Only your representative can change this status');
  if (TERMINAL.includes(request.status)) throw badRequest(`Request is already ${request.status}`);
  if (request.status === status) throw badRequest(`Request is already ${status}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE nri_service_requests
       SET status = $1::nri_request_status,
           completed_at = CASE WHEN $1::nri_request_status IN ('completed', 'cancelled') THEN now() ELSE completed_at END
       WHERE id = $2`,
      [status, id]
    );
    await client.query(
      `INSERT INTO nri_service_request_updates (request_id, author_id, update_type, from_status, to_status, message)
       VALUES ($1, $2, 'status_change', $3, $4, $5)`,
      [id, user.id, request.status, status, message || null]
    );
    await markFirstResponse(client, id, user, request);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (staffSide) {
    await notificationService
      .createNotification({
        userId: profile.user_id,
        type: 'nri_service_request_status',
        title: `Request ${status.replace(/_/g, ' ')}: ${request.title}`,
        message: message || null,
        relatedEntityType: 'nri_service_request',
        relatedEntityId: id,
      })
      .catch(() => {});
  }
  return getRequest(id, user);
}

async function assignRequest(id, managerId, user) {
  const { request } = await getAccessibleRequest(id, user);
  const manager = await pool.query(
    `SELECT u.id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.status = 'active'`,
    [managerId]
  );
  if (!manager.rows[0] || !investorService.STAFF_ROLES.includes(manager.rows[0].role_name)) {
    throw badRequest('Assignee must be an active internal_sales / admin / super_admin user');
  }
  await pool.query('UPDATE nri_service_requests SET assigned_manager_id = $1 WHERE id = $2', [managerId, id]);
  await pool.query(
    `INSERT INTO nri_service_request_updates (request_id, author_id, update_type, message, is_internal)
     VALUES ($1, $2, 'assignment', $3, true)`,
    [id, user.id, `Reassigned from ${request.assigned_manager_name || 'unassigned'}`]
  );
  return getRequest(id, user);
}

// ---------------------------------------------------------------------
// Repatriation
// ---------------------------------------------------------------------
const REPATRIATION_FIELDS = {
  nriPropertyId: 'nri_property_id',
  source: 'source',
  amountInr: 'amount_inr',
  fxCurrency: 'fx_currency',
  amountFx: 'amount_fx',
  amountUsdEquivalent: 'amount_usd_equivalent',
  financialYear: 'financial_year',
  form15caCbStatus: 'form_15ca_cb_status',
  bankName: 'bank_name',
  status: 'status',
  completedOn: 'completed_on',
  notes: 'notes',
};

async function repatriationSummary(profileId, fy) {
  const limitUsd = await configService.getConfig('fema.repatriation_annual_limit_usd', 1000000);
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount_usd_equivalent) FILTER (WHERE status = 'completed'), 0) AS completed_usd,
            COALESCE(SUM(amount_usd_equivalent) FILTER (WHERE status IN ('planned', 'in_process')), 0) AS pipeline_usd,
            COALESCE(SUM(amount_inr) FILTER (WHERE status = 'completed'), 0) AS completed_inr
     FROM nri_repatriation_records WHERE investor_profile_id = $1 AND financial_year = $2`,
    [profileId, fy]
  );
  const row = result.rows[0];
  const used = Number(row.completed_usd);
  return {
    financialYear: fy,
    annualLimitUsd: Number(limitUsd),
    completedUsd: used,
    pipelineUsd: Number(row.pipeline_usd),
    completedInr: Number(row.completed_inr),
    remainingUsd: Math.max(Number(limitUsd) - used, 0),
    utilisationPercent: Math.round((used / Number(limitUsd)) * 1000) / 10,
  };
}

async function listRepatriation(user, investorId, fy) {
  const profile = await investorService.resolveProfile(user, investorId);
  investorService.assertNri(profile);
  const year = fy || financialYear();
  const result = await pool.query(
    `SELECT r.*, np.title AS property_title FROM nri_repatriation_records r
     LEFT JOIN nri_properties np ON np.id = r.nri_property_id
     WHERE r.investor_profile_id = $1 ORDER BY r.created_at DESC`,
    [profile.id]
  );
  return {
    items: result.rows,
    summary: await repatriationSummary(profile.id, year),
    disclaimers: await disclaimerService.getDisclaimers(['tax_legal']),
  };
}

async function createRepatriation(data, user) {
  const profile = await investorService.resolveProfile(user, data.investorId);
  investorService.assertNri(profile);
  const payload = { ...data, financialYear: data.financialYear || financialYear() };
  const cols = ['investor_profile_id', 'created_by'];
  const values = [profile.id, user.id];
  for (const [key, col] of Object.entries(REPATRIATION_FIELDS)) {
    if (payload[key] !== undefined) {
      cols.push(col);
      values.push(payload[key]);
    }
  }
  const result = await pool.query(
    `INSERT INTO nri_repatriation_records (${cols.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values
  );
  const summary = await repatriationSummary(profile.id, payload.financialYear);
  return { record: result.rows[0], summary, withinLimit: summary.completedUsd + summary.pipelineUsd <= summary.annualLimitUsd };
}

async function updateRepatriation(id, data, user) {
  const existing = await pool.query('SELECT * FROM nri_repatriation_records WHERE id = $1', [id]);
  if (!existing.rows[0]) throw notFound('Repatriation record not found');
  const profile = await investorService.getProfileById(existing.rows[0].investor_profile_id);
  investorService.assertProfileAccess(profile, user);

  const set = [];
  const params = [];
  for (const [key, col] of Object.entries(REPATRIATION_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${col} = $${params.length}`);
    }
  }
  if (set.length === 0) throw badRequest('No updatable fields provided');
  params.push(id);
  const result = await pool.query(`UPDATE nri_repatriation_records SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  return { record: result.rows[0], summary: await repatriationSummary(profile.id, result.rows[0].financial_year) };
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
async function getDashboard(user, investorId) {
  const profile = await investorService.resolveProfile(user, investorId);
  investorService.assertNri(profile);
  const fy = financialYear();
  const { start, end } = fyBounds(fy);

  const [portfolio, rent, requests, recentUpdates] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS properties,
              COALESCE(SUM(purchase_price), 0) AS total_purchase_value,
              COALESCE(SUM(COALESCE(current_estimated_value, purchase_price)), 0) AS total_current_value,
              COALESCE(SUM(monthly_rent_expected) FILTER (WHERE occupancy_status = 'tenant_occupied'), 0) AS expected_monthly_rent,
              COUNT(*) FILTER (WHERE occupancy_status = 'tenant_occupied')::int AS tenant_occupied,
              COUNT(*) FILTER (WHERE occupancy_status = 'vacant')::int AS vacant,
              COUNT(*) FILTER (WHERE management_status = 'platform_managed')::int AS platform_managed,
              COUNT(*) FILTER (WHERE lease_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60)::int AS leases_ending_60d
       FROM nri_properties WHERE investor_profile_id = $1`,
      [profile.id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(rr.rent_received), 0) AS collected_this_fy,
              COALESCE(SUM(rr.tds_deducted), 0) AS tds_deducted_this_fy,
              COALESCE(SUM(rr.rent_due - rr.rent_received) FILTER (WHERE rr.status IN ('due', 'partial', 'overdue')), 0) AS outstanding,
              COUNT(*) FILTER (WHERE rr.status = 'overdue')::int AS overdue_months
       FROM nri_rent_records rr JOIN nri_properties np ON np.id = rr.nri_property_id
       WHERE np.investor_profile_id = $1 AND rr.period_month BETWEEN $2 AND $3`,
      [profile.id, start, end]
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE sla_due_at < now() AND first_response_at IS NULL AND status = 'submitted')::int AS breached
       FROM nri_service_requests WHERE investor_profile_id = $1 GROUP BY status`,
      [profile.id]
    ),
    pool.query(
      `SELECT upd.message, upd.update_type, upd.to_status, upd.created_at, r.id AS request_id, r.title
       FROM nri_service_request_updates upd JOIN nri_service_requests r ON r.id = upd.request_id
       WHERE r.investor_profile_id = $1 AND upd.is_internal = false
       ORDER BY upd.created_at DESC LIMIT 5`,
      [profile.id]
    ),
  ]);

  const byStatus = Object.fromEntries(requests.rows.map((r) => [r.status, r.count]));
  const open = requests.rows.filter((r) => !TERMINAL.includes(r.status)).reduce((a, r) => a + r.count, 0);

  return {
    profile: {
      id: profile.id,
      fullName: profile.full_name,
      residencyStatus: profile.residency_status,
      countryOfResidence: profile.country_of_residence,
      verificationStatus: profile.verification_status,
    },
    // Mandatory intermediation: the NRI's single point of contact is their
    // A R Buildwel representative.
    assignedManager: profile.assigned_manager_id
      ? { id: profile.assigned_manager_id, name: profile.manager_name, email: profile.manager_email, mobile: profile.manager_mobile }
      : null,
    portfolio: portfolio.rows[0],
    rent: { financialYear: fy, ...rent.rows[0] },
    serviceRequests: {
      open,
      byStatus,
      slaBreached: requests.rows.reduce((a, r) => a + r.breached, 0),
    },
    repatriation: await repatriationSummary(profile.id, fy),
    recentUpdates: recentUpdates.rows,
    disclaimers: await disclaimerService.getDisclaimers(['tax_legal']),
  };
}

// ---------------------------------------------------------------------
// Guidance (non-advisory)
// ---------------------------------------------------------------------
function round2(n) {
  return Math.round(n * 100) / 100;
}

// Indicative TDS a buyer deducts when purchasing from an NRI (sec. 195):
// on the capital gain when the NRI holds a lower-deduction certificate
// (Form 13), otherwise buyers commonly deduct on the full consideration -
// both figures are shown. Rates, surcharge bands, cess and the long-term
// holding period all come from app_config (statutory, super_admin-only).
async function estimateTdsOnSale({ salePrice, purchasePrice, purchaseDate, saleDate, holdingMonths, improvementCost = 0, transferExpenses = 0 }) {
  const [ltcgRate, stcgRate, ltcgMonths, cessPercent, surchargeBands] = await Promise.all([
    configService.getConfig('tax.nri_ltcg_rate_percent', 12.5),
    configService.getConfig('tax.nri_stcg_rate_percent', 30),
    configService.getConfig('tax.ltcg_holding_months', 24),
    configService.getConfig('tax.cess_percent', 4),
    configService.getConfig('tax.nri_surcharge_bands', []),
  ]);

  let months = holdingMonths !== undefined ? Number(holdingMonths) : null;
  if (months === null && purchaseDate) {
    const from = new Date(purchaseDate);
    const to = saleDate ? new Date(saleDate) : new Date();
    months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  }
  if (months === null) throw badRequest('Provide holdingMonths or purchaseDate');

  const isLongTerm = months >= Number(ltcgMonths);
  const rate = Number(isLongTerm ? ltcgRate : stcgRate);
  const gain = Math.max(Number(salePrice) - Number(purchasePrice) - Number(improvementCost) - Number(transferExpenses), 0);

  const taxOn = (base) => {
    const tax = base * (rate / 100);
    const band = [...surchargeBands].sort((a, b) => b.above - a.above).find((b) => base > Number(b.above));
    const surchargePercent = band ? Number(band.rate_percent) : 0;
    const surcharge = tax * (surchargePercent / 100);
    const cess = (tax + surcharge) * (Number(cessPercent) / 100);
    return { base: round2(base), tax: round2(tax), surchargePercent, surcharge: round2(surcharge), cess: round2(cess), total: round2(tax + surcharge + cess) };
  };

  return {
    holdingMonths: months,
    gainType: isLongTerm ? 'long_term' : 'short_term',
    ratePercent: rate,
    cessPercent: Number(cessPercent),
    capitalGain: round2(gain),
    tdsOnCapitalGain: taxOn(gain),
    tdsOnFullConsideration: taxOn(Number(salePrice)),
    notes: [
      'TDS on a sale by an NRI is deducted by the buyer under Section 195.',
      'Without a lower/nil deduction certificate (Form 13), buyers commonly deduct TDS on the full sale consideration; with one, deduction can be limited to the capital gain.',
      'Figures are indicative and ignore exemptions (e.g. Sections 54 / 54EC), indexation and your total income.',
    ],
    disclaimers: await disclaimerService.getDisclaimers(['tax_legal', 'nri_guidance']),
  };
}

async function estimateRentTds({ monthlyRent }) {
  const [ratePercent, cessPercent] = await Promise.all([
    configService.getConfig('tax.nri_rent_tds_percent', 30),
    configService.getConfig('tax.cess_percent', 4),
  ]);
  const effective = Number(ratePercent) * (1 + Number(cessPercent) / 100);
  const monthlyTds = Number(monthlyRent) * (effective / 100);
  return {
    ratePercent: Number(ratePercent),
    cessPercent: Number(cessPercent),
    effectiveRatePercent: round2(effective),
    monthlyRent: Number(monthlyRent),
    monthlyTds: round2(monthlyTds),
    annualTds: round2(monthlyTds * 12),
    netMonthlyRent: round2(Number(monthlyRent) - monthlyTds),
    notes: ['Tenants paying rent to an NRI landlord deduct TDS under Section 195; rent is credited to the NRO account.'],
    disclaimers: await disclaimerService.getDisclaimers(['tax_legal', 'nri_guidance']),
  };
}

async function getFemaGuidance() {
  const [points, limitUsd] = await Promise.all([
    configService.getConfig('nri.fema_guidance_points', []),
    configService.getConfig('fema.repatriation_annual_limit_usd', 1000000),
  ]);
  return {
    points,
    repatriationAnnualLimitUsd: Number(limitUsd),
    currentFinancialYear: financialYear(),
    disclaimers: await disclaimerService.getDisclaimers(['tax_legal', 'nri_guidance']),
  };
}

module.exports = {
  financialYear,
  listProperties,
  createProperty,
  getProperty,
  updateProperty,
  deleteProperty,
  listRent,
  recordRent,
  createRequest,
  listRequests,
  getRequest,
  addUpdate,
  updateRequestStatus,
  assignRequest,
  listRepatriation,
  createRepatriation,
  updateRepatriation,
  getDashboard,
  estimateTdsOnSale,
  estimateRentTds,
  getFemaGuidance,
};
