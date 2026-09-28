const pool = require('../config/db');
const customerService = require('./customer.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { resolveCustomer } = require('./portal.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Rentals for the customer portal: an owner / landlord records a lease with
// their tenant; the tenant confirms it, reports each month's rent and
// raises maintenance requests; the owner confirms rent and works the
// requests (Annexure A sec. 2 Owner / Tenant roles, sec. 13.1).
// Rent is paid directly between the parties - the platform only keeps the
// record (sec. 5: buyer-to-seller payments flow off-platform).

const LEASE_SELECT = `
  SELECT l.*,
         oc.full_name AS owner_name, oc.user_id AS owner_user_id,
         tc.full_name AS tenant_name, tc.user_id AS tenant_user_id,
         p.title AS property_title, p.city AS property_city, p.locality AS property_locality
  FROM leases l
  JOIN customers oc ON oc.id = l.owner_customer_id
  JOIN customers tc ON tc.id = l.tenant_customer_id
  LEFT JOIN properties p ON p.id = l.property_id`;

function firstOfMonth(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// Loads a lease the caller is party to, with which side they are on.
async function loadLease(user, leaseId) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(`${LEASE_SELECT} WHERE l.id = $1`, [leaseId]);
  const lease = result.rows[0];
  if (!lease) throw notFound('Lease not found');
  const side = lease.owner_customer_id === customer.id ? 'owner' : lease.tenant_customer_id === customer.id ? 'tenant' : null;
  if (!side) throw notFound('Lease not found');
  return { lease, side, customer };
}

async function notify(userId, title, message, leaseId) {
  if (!userId) return;
  await notificationService.createNotification({
    userId,
    type: 'rental',
    title,
    message,
    relatedEntityType: 'lease',
    relatedEntityId: leaseId,
  });
}

// Creates one rent row per month from the lease start up to the current
// month (or the lease end), so the schedule is always complete.
async function ensureRentRows(lease) {
  if (lease.status === 'ended' && !lease.end_date) return;
  const start = new Date(lease.start_date);
  const today = new Date();
  const last = lease.end_date && new Date(lease.end_date) < today ? new Date(lease.end_date) : today;
  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= last && months.length < 240) {
    months.push(firstOfMonth(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  if (!months.length) return;
  await pool.query(
    `INSERT INTO rent_payments (lease_id, period_month, amount)
     SELECT $1, m::date, $2 FROM unnest($3::text[]) AS m
     ON CONFLICT (lease_id, period_month) DO NOTHING`,
    [lease.id, lease.monthly_rent, months]
  );
}

function shapeLease(lease, side) {
  // Each side sees the other party's name only; contact stays off-screen.
  return {
    id: lease.id,
    side,
    property_id: lease.property_id,
    property_label: lease.property_label,
    property_title: lease.property_title,
    owner_name: lease.owner_name,
    tenant_name: lease.tenant_name,
    monthly_rent: lease.monthly_rent,
    security_deposit: lease.security_deposit,
    rent_due_day: lease.rent_due_day,
    start_date: lease.start_date,
    end_date: lease.end_date,
    status: lease.status,
    tenant_confirmed_at: lease.tenant_confirmed_at,
    created_at: lease.created_at,
  };
}

async function listLeases(user) {
  const customer = await resolveCustomer(user);
  const result = await pool.query(
    `${LEASE_SELECT}
     WHERE l.owner_customer_id = $1 OR l.tenant_customer_id = $1
     ORDER BY (l.status = 'ended'), l.start_date DESC`,
    [customer.id]
  );
  const leases = [];
  for (const lease of result.rows) {
    await ensureRentRows(lease);
    const side = lease.owner_customer_id === customer.id ? 'owner' : 'tenant';
    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM rent_payments WHERE lease_id = $1 AND status IN ('due', 'disputed'))::int AS rent_due,
         (SELECT COUNT(*) FROM rent_payments WHERE lease_id = $1 AND status = 'reported')::int AS rent_to_confirm,
         (SELECT COUNT(*) FROM maintenance_requests WHERE lease_id = $1 AND status IN ('open', 'in_progress'))::int AS open_maintenance`,
      [lease.id]
    );
    leases.push({ ...shapeLease(lease, side), ...stats.rows[0] });
  }
  return leases;
}

async function getLease(user, leaseId) {
  const { lease, side } = await loadLease(user, leaseId);
  await ensureRentRows(lease);
  const [rent, maintenance] = await Promise.all([
    pool.query('SELECT * FROM rent_payments WHERE lease_id = $1 ORDER BY period_month DESC', [leaseId]),
    pool.query(
      `SELECT m.*, u.full_name AS raised_by_name FROM maintenance_requests m
       LEFT JOIN users u ON u.id = m.raised_by
       WHERE m.lease_id = $1 ORDER BY m.created_at DESC`,
      [leaseId]
    ),
  ]);
  return { ...shapeLease(lease, side), rent: rent.rows, maintenance: maintenance.rows };
}

// The owner records a lease. The tenant is matched to (or created as) a
// customer record by mobile / email, so the lease shows up in their
// dashboard as soon as they sign in with that number or email.
async function createLease(user, data, meta = {}) {
  const owner = await resolveCustomer(user);
  if (!data.tenantMobile && !data.tenantEmail) throw badRequest("Enter the tenant's mobile number or email");

  let propertyLabel = data.propertyLabel;
  if (data.propertyId) {
    const property = await pool.query('SELECT title, locality, city FROM properties WHERE id = $1 AND created_by = $2', [
      data.propertyId,
      user.id,
    ]);
    if (!property.rows[0]) throw badRequest('You can only link a lease to one of your own listings');
    propertyLabel = propertyLabel || [property.rows[0].title, property.rows[0].locality, property.rows[0].city].filter(Boolean).join(', ');
  }
  if (!propertyLabel) throw badRequest('Describe the property (e.g. flat number, society, city)');

  const tenant = await customerService.findOrCreateCustomerByContact({
    fullName: data.tenantName,
    email: data.tenantEmail || null,
    mobile: data.tenantMobile || null,
  });
  if (tenant.id === owner.id) throw badRequest('The tenant must be someone other than you');

  const result = await pool.query(
    `INSERT INTO leases (property_id, property_label, owner_customer_id, tenant_customer_id, monthly_rent, security_deposit,
       rent_due_day, start_date, end_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      data.propertyId || null,
      propertyLabel,
      owner.id,
      tenant.id,
      data.monthlyRent,
      data.securityDeposit ?? null,
      data.rentDueDay || 5,
      data.startDate,
      data.endDate || null,
      user.id,
    ]
  );
  const leaseId = result.rows[0].id;

  if (!owner.portal_roles?.includes('owner')) {
    await pool.query(
      `UPDATE customers SET portal_roles = array_append(portal_roles, 'owner'::varchar), onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $1`,
      [owner.id]
    );
  }
  if (!tenant.portal_roles?.includes('tenant')) {
    await pool.query(`UPDATE customers SET portal_roles = array_append(portal_roles, 'tenant'::varchar) WHERE id = $1`, [tenant.id]);
  }
  await auditService.log({ actor: user, action: 'lease.created', entityType: 'lease', entityId: leaseId, after: data, ...meta });
  await notify(
    tenant.user_id,
    'Please confirm your lease',
    `${owner.full_name} added your lease for ${propertyLabel}. Review and confirm the terms in your dashboard.`,
    leaseId
  );
  return getLease(user, leaseId);
}

// Owner: update status (notice / ended), end date or rent going forward.
async function updateLease(user, leaseId, data, meta = {}) {
  const { lease, side } = await loadLease(user, leaseId);
  if (side !== 'owner') throw forbidden('Only the owner can change the lease');
  const set = [];
  const params = [];
  if (data.status !== undefined) {
    params.push(data.status);
    set.push(`status = $${params.length}::lease_status`);
  }
  if (data.endDate !== undefined) {
    params.push(data.endDate || null);
    set.push(`end_date = $${params.length}`);
  }
  if (data.monthlyRent !== undefined) {
    params.push(data.monthlyRent);
    set.push(`monthly_rent = $${params.length}`);
  }
  if (data.rentDueDay !== undefined) {
    params.push(data.rentDueDay);
    set.push(`rent_due_day = $${params.length}`);
  }
  if (!set.length) throw badRequest('Nothing to update');
  params.push(leaseId);
  await pool.query(`UPDATE leases SET ${set.join(', ')} WHERE id = $${params.length}`, params);
  await auditService.log({ actor: user, action: 'lease.updated', entityType: 'lease', entityId: leaseId, before: lease, after: data, ...meta });
  await notify(lease.tenant_user_id, 'Lease updated', `${lease.owner_name} updated the lease for ${lease.property_label}.`, leaseId);
  return getLease(user, leaseId);
}

// Tenant: accept the lease terms as recorded by the owner.
async function confirmLease(user, leaseId, meta = {}) {
  const { lease, side } = await loadLease(user, leaseId);
  if (side !== 'tenant') throw forbidden('Only the tenant can confirm the lease');
  if (!lease.tenant_confirmed_at) {
    await pool.query('UPDATE leases SET tenant_confirmed_at = now() WHERE id = $1', [leaseId]);
    await auditService.log({ actor: user, action: 'lease.tenant_confirmed', entityType: 'lease', entityId: leaseId, ...meta });
    await notify(lease.owner_user_id, 'Lease confirmed', `${lease.tenant_name} confirmed the lease for ${lease.property_label}.`, leaseId);
  }
  return getLease(user, leaseId);
}

// Tenant reports a month's rent as paid (with UPI / bank reference).
async function reportRent(user, leaseId, paymentId, data, meta = {}) {
  const { lease, side } = await loadLease(user, leaseId);
  if (side !== 'tenant') throw forbidden('Only the tenant reports rent payments');
  const result = await pool.query(
    `UPDATE rent_payments
     SET status = 'reported', paid_on = $1, payment_mode = $2, reference = $3, note = $4, reported_by = $5, reported_at = now()
     WHERE id = $6 AND lease_id = $7 AND status IN ('due', 'disputed')
     RETURNING *`,
    [data.paidOn, data.paymentMode || null, data.reference || null, data.note || null, user.id, paymentId, leaseId]
  );
  if (!result.rows[0]) throw badRequest('This month is already reported or confirmed');
  const month = new Date(result.rows[0].period_month).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  await auditService.log({ actor: user, action: 'rent.reported', entityType: 'rent_payment', entityId: paymentId, after: data, ...meta });
  await notify(lease.owner_user_id, 'Rent payment reported', `${lease.tenant_name} reported rent for ${month} as paid. Please confirm.`, leaseId);
  return result.rows[0];
}

// Owner confirms (or disputes) a reported payment.
async function reviewRent(user, leaseId, paymentId, { action, note }, meta = {}) {
  const { lease, side } = await loadLease(user, leaseId);
  if (side !== 'owner') throw forbidden('Only the owner confirms rent payments');
  const confirming = action === 'confirm';
  const result = await pool.query(
    `UPDATE rent_payments
     SET status = $1::rent_payment_status,
         confirmed_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
         confirmed_at = CASE WHEN $2 THEN now() ELSE NULL END,
         note = COALESCE($4, note)
     WHERE id = $5 AND lease_id = $6 AND status = ANY($7::rent_payment_status[])
     RETURNING *`,
    [
      confirming ? 'confirmed' : 'disputed',
      confirming,
      user.id,
      note || null,
      paymentId,
      leaseId,
      confirming ? ['reported', 'due', 'disputed'] : ['reported'],
    ]
  );
  if (!result.rows[0]) throw badRequest(confirming ? 'This payment is already confirmed' : 'Only a reported payment can be disputed');
  const month = new Date(result.rows[0].period_month).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  await auditService.log({ actor: user, action: `rent.${confirming ? 'confirmed' : 'disputed'}`, entityType: 'rent_payment', entityId: paymentId, ...meta });
  await notify(
    lease.tenant_user_id,
    confirming ? 'Rent confirmed' : 'Rent payment queried',
    confirming
      ? `${lease.owner_name} confirmed your rent for ${month}.`
      : `${lease.owner_name} could not match your rent payment for ${month}${note ? `: ${note}` : ''}.`,
    leaseId
  );
  return result.rows[0];
}

async function createMaintenance(user, leaseId, data, meta = {}) {
  const { lease, side } = await loadLease(user, leaseId);
  if (lease.status === 'ended') throw badRequest('This lease has ended');
  const result = await pool.query(
    `INSERT INTO maintenance_requests (lease_id, raised_by, category, title, description, priority)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [leaseId, user.id, data.category || 'other', data.title, data.description || null, data.priority || 'medium']
  );
  await auditService.log({ actor: user, action: 'maintenance.raised', entityType: 'maintenance_request', entityId: result.rows[0].id, ...meta });
  const other = side === 'tenant' ? lease.owner_user_id : lease.tenant_user_id;
  await notify(other, 'New maintenance request', `${data.title} - ${lease.property_label}`, leaseId);
  return result.rows[0];
}

// Owner moves a request through open -> in progress -> resolved (with a
// note); either side can close it once it's resolved.
async function updateMaintenance(user, leaseId, requestId, { status, ownerNote }, meta = {}) {
  const { lease, side } = await loadLease(user, leaseId);
  const existing = await pool.query('SELECT * FROM maintenance_requests WHERE id = $1 AND lease_id = $2', [requestId, leaseId]);
  if (!existing.rows[0]) throw notFound('Maintenance request not found');
  if (side === 'tenant' && status && status !== 'closed') throw forbidden('The owner updates the progress of a request');
  if (side === 'tenant' && ownerNote) throw forbidden('Only the owner can add an update note');

  const result = await pool.query(
    `UPDATE maintenance_requests
     SET status = COALESCE($1::maintenance_status, status),
         owner_note = COALESCE($2, owner_note),
         resolved_at = CASE WHEN $1 IN ('resolved', 'closed') AND resolved_at IS NULL THEN now() ELSE resolved_at END
     WHERE id = $3 RETURNING *`,
    [status || null, ownerNote || null, requestId]
  );
  await auditService.log({
    actor: user,
    action: 'maintenance.updated',
    entityType: 'maintenance_request',
    entityId: requestId,
    before: existing.rows[0],
    after: result.rows[0],
    ...meta,
  });
  const other = side === 'owner' ? lease.tenant_user_id : lease.owner_user_id;
  await notify(
    other,
    'Maintenance request updated',
    `${existing.rows[0].title}: ${String(result.rows[0].status).replace('_', ' ')}${ownerNote ? ` - ${ownerNote}` : ''}`,
    leaseId
  );
  return result.rows[0];
}

module.exports = {
  listLeases,
  getLease,
  createLease,
  updateLease,
  confirmLease,
  reportRent,
  reviewRent,
  createMaintenance,
  updateMaintenance,
};
