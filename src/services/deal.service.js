const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const leadService = require('./lead.service');
const notificationService = require('./notification.service');

function notFound(message = 'Deal not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Which stages a deal may move to from its current stage. A self-transition
// (toStage === fromStage) is always allowed regardless of this map - it's
// used to log an activity (e.g. a negotiation round) without changing stage.
const STAGE_TRANSITIONS = {
  inquiry: ['site_visit', 'on_hold', 'closed_lost'],
  site_visit: ['negotiation', 'on_hold', 'closed_lost'],
  negotiation: ['booking', 'on_hold', 'closed_lost'],
  booking: ['documentation', 'on_hold', 'closed_lost'],
  documentation: ['payment', 'on_hold', 'closed_lost'],
  payment: ['closed_won', 'on_hold', 'closed_lost'],
  on_hold: ['inquiry', 'site_visit', 'negotiation', 'booking', 'documentation', 'payment', 'closed_lost'],
  closed_won: [],
  closed_lost: [],
};

const TERMINAL_STAGES = ['closed_won', 'closed_lost'];

// Every human-readable field a deal row needs for display - the deals table
// itself only stores FK ids. Shared by listDeals/getDealById so the shape
// returned to the frontend pipeline board is identical everywhere.
const DEAL_SELECT = `
  SELECT d.*,
         c.full_name AS customer_name, c.email AS customer_email, c.mobile AS customer_mobile,
         p.title AS property_title, p.city AS property_city,
         un.unit_number AS unit_number,
         broker.full_name AS broker_name
  FROM deals d
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN properties p ON p.id = d.property_id
  LEFT JOIN units un ON un.id = d.unit_id
  LEFT JOIN users broker ON broker.id = d.broker_id
`;

function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  where.push(`(d.tenant_id = $${params.length - 1} OR d.broker_id = $${params.length})`);
}

async function listDeals(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.stage) {
    params.push(filters.stage);
    where.push(`d.stage = $${params.length}`);
  }
  if (filters.brokerId) {
    params.push(filters.brokerId);
    where.push(`d.broker_id = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`d.created_at >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`d.created_at <= $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM deals d ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `${DEAL_SELECT}
     ${whereClause}
     ORDER BY d.created_at DESC
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

async function getDealById(id) {
  const result = await pool.query(`${DEAL_SELECT} WHERE d.id = $1`, [id]);
  const deal = result.rows[0];
  if (!deal) throw notFound();

  const [siteVisits, stageHistory] = await Promise.all([
    pool.query('SELECT * FROM site_visits WHERE deal_id = $1 ORDER BY scheduled_at ASC', [id]),
    pool.query('SELECT * FROM deal_stage_history WHERE deal_id = $1 ORDER BY created_at ASC', [id]),
  ]);

  return { ...deal, siteVisits: siteVisits.rows, stageHistory: stageHistory.rows };
}

async function logStageChange(client, dealId, fromStage, toStage, userId, notes) {
  await client.query(
    `INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [dealId, fromStage || null, toStage, userId || null, notes || null]
  );
}

async function createDeal(data, user) {
  let lead = null;
  if (data.leadId) {
    lead = await leadService.getLeadById(data.leadId);
  }

  const customerId = data.customerId || (lead && lead.customer_id);
  if (!customerId) throw badRequest('customerId is required (directly, or via a leadId that has a linked customer)');

  const propertyId = data.propertyId || (lead && lead.property_id) || null;
  const brokerId = data.brokerId || (lead && lead.assigned_to) || (user.role === 'broker' ? user.id : null);
  if (!brokerId) throw badRequest('brokerId is required (directly, via a leadId with an assignee, or by creating as a broker)');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO deals (
         tenant_id, lead_id, customer_id, property_id, unit_id, broker_id,
         stage, deal_value, commission_amount, commission_percent
       ) VALUES ($1, $2, $3, $4, $5, $6, 'inquiry', $7, $8, $9)
       RETURNING *`,
      [
        user.tenant_id || null,
        data.leadId || null,
        customerId,
        propertyId,
        data.unitId || null,
        brokerId,
        data.dealValue ?? null,
        data.commissionAmount ?? null,
        data.commissionPercent ?? null,
      ]
    );
    const deal = result.rows[0];

    await logStageChange(client, deal.id, null, deal.stage, user.id, 'Deal created');

    await client.query('COMMIT');
    return deal;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const UPDATABLE_DEAL_FIELDS = {
  propertyId: 'property_id',
  unitId: 'unit_id',
  brokerId: 'broker_id',
  dealValue: 'deal_value',
  commissionAmount: 'commission_amount',
  commissionPercent: 'commission_percent',
};

async function updateDeal(id, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_DEAL_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE deals SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0];
}

// The single function that ever changes deals.stage - always logs to
// deal_stage_history in the same transaction. Used directly by
// PUT /:id/stage, and reused (via a fixed toStage) by /booking and /close
// so every stage-affecting endpoint shares one guarded code path.
async function changeStage(id, toStage, user, notes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [id]);
    if (current.rows.length === 0) throw notFound();
    const fromStage = current.rows[0].stage;

    if (toStage !== fromStage) {
      const allowed = STAGE_TRANSITIONS[fromStage] || [];
      if (!allowed.includes(toStage)) {
        throw badRequest(
          `Cannot move a deal from '${fromStage}' to '${toStage}'. Allowed next stages: ${allowed.join(', ') || 'none (terminal stage)'}`
        );
      }
    }

    const closesDeal = TERMINAL_STAGES.includes(toStage);
    const result = await client.query(
      `UPDATE deals SET stage = $1, closed_at = ${closesDeal ? 'now()' : 'closed_at'} WHERE id = $2 RETURNING *`,
      [toStage, id]
    );
    const deal = result.rows[0];

    await logStageChange(client, id, fromStage, toStage, user.id, notes);

    await client.query('COMMIT');
    return deal;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Tells the customer (if they have a website account) about a visit booked
// or changed by their representative - it shows in their dashboard too.
// Best-effort: never fails the CRM action.
async function notifyCustomerOfVisit(dealId, visit, kind) {
  try {
    const info = await pool.query(
      `SELECT c.user_id, p.title FROM deals d
       JOIN customers c ON c.id = d.customer_id
       LEFT JOIN properties p ON p.id = d.property_id
       WHERE d.id = $1`,
      [dealId]
    );
    const row = info.rows[0];
    if (!row?.user_id) return;
    const when = new Date(visit.scheduled_at).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
    const place = row.title ? ` for ${row.title}` : '';
    const text = {
      scheduled: ['Site visit scheduled', `Your site visit${place} is booked for ${when}.`],
      rescheduled: ['Site visit rescheduled', `Your site visit${place} has moved to ${when}.`],
      cancelled: ['Site visit cancelled', `Your site visit${place} on ${when} was cancelled. Your representative will be in touch.`],
      completed: ['Thanks for visiting', `Hope the visit${place} went well - your representative will follow up.`],
    }[kind];
    if (!text) return;
    await notificationService.createNotification({
      userId: row.user_id,
      type: 'site_visit',
      title: text[0],
      message: text[1],
      relatedEntityType: 'deal',
      relatedEntityId: dealId,
    });
  } catch (err) {
    console.error(`Visit notification failed for deal ${dealId}:`, err.message);
  }
}

async function scheduleSiteVisit(dealId, data, user) {
  const result = await pool.query(
    `INSERT INTO site_visits (deal_id, scheduled_at, notes, created_by, status)
     VALUES ($1, $2, $3, $4, 'scheduled')
     RETURNING *`,
    [dealId, data.scheduledAt, data.notes || null, user.id]
  );
  await notifyCustomerOfVisit(dealId, result.rows[0], 'scheduled');
  return result.rows[0];
}

const UPDATABLE_VISIT_FIELDS = {
  scheduledAt: 'scheduled_at',
  actualVisitAt: 'actual_visit_at',
  status: 'status',
  notes: 'notes',
};

async function updateSiteVisit(dealId, visitId, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_VISIT_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(visitId, dealId);
  const result = await pool.query(
    `UPDATE site_visits SET ${set.join(', ')}
     WHERE id = $${params.length - 1} AND deal_id = $${params.length}
     RETURNING *`,
    params
  );
  if (result.rows.length === 0) throw notFound('Site visit not found for this deal');
  const kind = data.status && data.status !== 'scheduled' ? data.status : data.scheduledAt ? 'rescheduled' : null;
  if (kind) await notifyCustomerOfVisit(dealId, result.rows[0], kind);
  return result.rows[0];
}

// Logs an offer/negotiation round as a same-stage deal_stage_history entry
// (does not change the deal's stage - use PUT /:id/stage for that).
async function logNegotiation(dealId, { offerAmount, notes }, user) {
  const deal = await getDealById(dealId);
  const combinedNotes = offerAmount ? `Offer amount: ${offerAmount}. ${notes || ''}`.trim() : notes;
  return changeStage(dealId, deal.stage, user, combinedNotes);
}

async function recordBooking(dealId, { bookingAmount, notes }, user) {
  const combinedNotes = bookingAmount ? `Booking amount: ${bookingAmount}. ${notes || ''}`.trim() : notes;
  return changeStage(dealId, 'booking', user, combinedNotes);
}

async function closeDeal(dealId, { outcome, reason }, user) {
  const toStage = outcome === 'won' ? 'closed_won' : 'closed_lost';
  return changeStage(dealId, toStage, user, reason);
}

async function deleteDeal(id) {
  const result = await pool.query('DELETE FROM deals WHERE id = $1 RETURNING id', [id]);
  if (result.rows.length === 0) throw notFound();
}

module.exports = {
  listDeals,
  getDealById,
  createDeal,
  updateDeal,
  deleteDeal,
  changeStage,
  scheduleSiteVisit,
  updateSiteVisit,
  logNegotiation,
  recordBooking,
  closeDeal,
  STAGE_TRANSITIONS,
};
