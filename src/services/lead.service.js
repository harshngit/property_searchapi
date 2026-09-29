const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const customerService = require('./customer.service');
const whatsappService = require('./whatsapp.service');

function notFound(message = 'Lead not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Every human-readable field (names, titles) a lead row needs for display -
// the leads table itself only stores FK ids. Shared by listLeads/getLeadById
// so the shape returned to the frontend is identical everywhere.
const LEAD_SELECT = `
  SELECT l.*,
         c.full_name AS customer_name, c.email AS customer_email, c.mobile AS customer_mobile,
         cp.budget_min AS customer_budget_min, cp.budget_max AS customer_budget_max,
         p.title AS property_title, p.price AS property_price,
         assignee.full_name AS assigned_to_name,
         creator.full_name AS created_by_name
  FROM leads l
  JOIN customers c ON c.id = l.customer_id
  LEFT JOIN customer_preferences cp ON cp.customer_id = c.id
  LEFT JOIN properties p ON p.id = l.property_id
  LEFT JOIN users assignee ON assignee.id = l.assigned_to
  LEFT JOIN users creator ON creator.id = l.created_by
`;

function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id, user.id);
  where.push(
    `(l.tenant_id = $${params.length - 2} OR l.created_by = $${params.length - 1} OR l.assigned_to = $${params.length})`
  );
}

// Every status/assignment change (and creation) writes an activity_log row
// here in the service layer, so it can never be skipped by a controller.
async function logActivity(client, leadId, userId, action, details = {}) {
  await client.query(
    `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [leadId, userId || null, action, JSON.stringify(details)]
  );
}

async function listLeads(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.status) {
    params.push(filters.status);
    where.push(`l.status = $${params.length}`);
  }
  if (filters.assignedTo) {
    params.push(filters.assignedTo);
    where.push(`l.assigned_to = $${params.length}`);
  }
  if (filters.source) {
    params.push(filters.source);
    where.push(`l.source = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`l.created_at >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`l.created_at <= $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM leads l ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `${LEAD_SELECT}
     ${whereClause}
     ORDER BY l.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows,
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

async function getLeadById(id) {
  const result = await pool.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
  const lead = result.rows[0];
  if (!lead) throw notFound();
  return lead;
}

async function createLead(data, user) {
  const { source, propertyId, customerId, assignedTo } = data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO leads (tenant_id, created_by, source, property_id, customer_id, assigned_to, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'new')
       RETURNING *`,
      [user.tenant_id || null, user.id, source || 'manual', propertyId || null, customerId, assignedTo || null]
    );
    const lead = result.rows[0];

    await logActivity(client, lead.id, user.id, 'lead_created', {
      source: lead.source,
      assignedTo: lead.assigned_to,
    });

    await client.query('COMMIT');
    await sendAcknowledgement(lead.id, user);
    // Sec. 9.6: same buyer already in another broker's CRM?
    await require('./dispute.service').detectLeadConflict(lead.id);
    return getLeadById(lead.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Fires the WhatsApp lead-acknowledgement template right after a lead is
// committed. Runs outside the lead's own transaction (an external API call
// has no place inside a DB transaction) and never throws - a WhatsApp
// failure (missing config, no phone on file, provider error) must not
// break lead creation.
async function sendAcknowledgement(leadId, user) {
  try {
    await whatsappService.acknowledgeLead(leadId, { actingUser: user || null });
  } catch (err) {
    console.error(`WhatsApp acknowledge-lead failed for lead ${leadId}:`, err.message);
  }
}

// Public, unauthenticated lead capture. Finds-or-creates a bare customer
// record by contact details (no tenant/staff context available yet) and
// opens a 'website' lead against it.
async function createPublicInquiry(data) {
  const { fullName, email, mobile, propertyId, message, source } = data;

  const customer = await customerService.findOrCreateCustomerByContact({ fullName, email, mobile });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO leads (source, property_id, customer_id, status)
       VALUES ($1, $2, $3, 'new')
       RETURNING *`,
      [source || 'website', propertyId || null, customer.id]
    );
    const lead = result.rows[0];

    await logActivity(client, lead.id, null, 'lead_created', {
      source: lead.source,
      channel: 'public_inquiry',
      message: message || null,
    });

    // The visitor's message (form topic, details, note) becomes the first
    // note on the lead, so the CRM timeline shows what they asked for.
    if (message && message.trim()) {
      await client.query('INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, NULL, $2)', [
        lead.id,
        `Website enquiry: ${message.trim()}`,
      ]);
    }

    await client.query('COMMIT');
    await sendAcknowledgement(lead.id, null);
    if (propertyId) require('./matchEngine.service').recordEvent({ customerId: customer.id, propertyId, event: 'enquired' });
    return getLeadById(lead.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const UPDATABLE_LEAD_FIELDS = {
  source: 'source',
  propertyId: 'property_id',
};

async function updateLead(id, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_LEAD_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  await pool.query(
    `UPDATE leads SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return getLeadById(id);
}

async function assignLead(id, assigneeId, user) {
  const assignee = await pool.query(
    `SELECT u.id, u.tenant_id, r.name AS role_name FROM users u
     JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [assigneeId]
  );
  if (assignee.rows.length === 0) {
    throw badRequest('Assignee not found');
  }
  if (!isAdmin(user.role) && assignee.rows[0].tenant_id !== user.tenant_id) {
    throw badRequest('Cannot assign a lead to a user outside your tenant');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT assigned_to FROM leads WHERE id = $1 FOR UPDATE', [id]);
    if (current.rows.length === 0) throw notFound();
    const previousAssignee = current.rows[0].assigned_to;

    await client.query(
      'UPDATE leads SET assigned_to = $1 WHERE id = $2 RETURNING *',
      [assigneeId, id]
    );

    await logActivity(client, id, user.id, 'assigned', {
      from: previousAssignee,
      to: assigneeId,
    });

    await client.query('COMMIT');
    await require('./dispute.service').detectLeadConflict(id);
    return getLeadById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateStatus(id, status, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT status FROM leads WHERE id = $1 FOR UPDATE', [id]);
    if (current.rows.length === 0) throw notFound();
    const previousStatus = current.rows[0].status;

    await client.query(
      'UPDATE leads SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    await logActivity(client, id, user.id, 'status_changed', {
      from: previousStatus,
      to: status,
    });

    await client.query('COMMIT');
    return getLeadById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function addNote(leadId, note, user) {
  const result = await pool.query(
    `INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, $2, $3) RETURNING *`,
    [leadId, user.id, note]
  );
  return result.rows[0];
}

async function getTimeline(leadId) {
  const [notes, activity] = await Promise.all([
    pool.query(
      `SELECT n.*, u.full_name AS author_name FROM lead_notes n
       LEFT JOIN users u ON u.id = n.user_id WHERE n.lead_id = $1`,
      [leadId]
    ),
    pool.query(
      `SELECT a.*, u.full_name AS author_name FROM lead_activity_log a
       LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = $1`,
      [leadId]
    ),
  ]);

  const combined = [
    ...notes.rows.map((n) => ({ type: 'note', ...n })),
    ...activity.rows.map((a) => ({ type: 'activity', ...a })),
  ];

  combined.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return combined;
}

async function getActivity(leadId) {
  const result = await pool.query(
    `SELECT a.*, u.full_name AS author_name FROM lead_activity_log a
     LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = $1 ORDER BY a.created_at ASC`,
    [leadId]
  );
  return result.rows;
}

// Used by the Broker CRM dashboard (GET /api/broker/dashboard) - counts of
// this user's assigned leads grouped by status. Lives here rather than in
// broker.service.js since this service owns all leads-table querying.
async function getStatusCounts(userId) {
  const result = await pool.query(
    `SELECT status, COUNT(*) AS count FROM leads WHERE assigned_to = $1 GROUP BY status`,
    [userId]
  );
  const counts = {};
  for (const row of result.rows) {
    counts[row.status] = Number(row.count);
  }
  return counts;
}

// Used by the Broker CRM dashboard's performance report - a cohort
// conversion rate: of the leads assigned to this user that were created in
// the given date range, how many have since become 'won'. from/to filter
// on created_at (when the lead entered the pipeline), not on when it
// converted - see getWonCount() below for a "won during this window" metric.
async function getConversionStats(userId, { from, to } = {}) {
  const where = ['assigned_to = $1'];
  const params = [userId];

  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at <= $${params.length}`);
  }

  const assignedResult = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE ${where.join(' AND ')}`,
    params
  );

  const convertedWhere = [...where, `status = 'won'`];
  const convertedResult = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE ${convertedWhere.join(' AND ')}`,
    params
  );

  const assigned = Number(assignedResult.rows[0].count);
  const converted = Number(convertedResult.rows[0].count);

  return {
    assigned,
    converted,
    conversionRate: assigned > 0 ? Number(((converted / assigned) * 100).toFixed(2)) : 0,
  };
}

// Used by the Broker CRM dashboard summary ("leads won this month") - counts
// leads that *became* 'won' within the given window, using updated_at as a
// proxy for the won transition (the leads table has no dedicated won_at
// column, and a status change is the only thing that touches updated_at
// after creation). This is distinct from getConversionStats() above, which
// filters on when the lead was created, not when it converted.
async function getWonCount(userId, { from, to } = {}) {
  const where = ['assigned_to = $1', `status = 'won'`];
  const params = [userId];

  if (from) {
    params.push(from);
    where.push(`updated_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`updated_at <= $${params.length}`);
  }

  const result = await pool.query(`SELECT COUNT(*) FROM leads WHERE ${where.join(' AND ')}`, params);
  return Number(result.rows[0].count);
}

async function deleteLead(id) {
  const result = await pool.query('DELETE FROM leads WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) throw notFound();
}

module.exports = {
  listLeads,
  getLeadById,
  createLead,
  createPublicInquiry,
  updateLead,
  deleteLead,
  assignLead,
  updateStatus,
  addNote,
  getTimeline,
  getActivity,
  getStatusCounts,
  getConversionStats,
  getWonCount,
};
