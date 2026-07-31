const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const leadService = require('./lead.service');

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

function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  where.push(`(tenant_id = $${params.length - 1} OR broker_id = $${params.length})`);
}

async function listDeals(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.stage) {
    params.push(filters.stage);
    where.push(`stage = $${params.length}`);
  }
  if (filters.brokerId) {
    params.push(filters.brokerId);
    where.push(`broker_id = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    where.push(`created_at >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    where.push(`created_at <= $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM deals ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM deals
     ${whereClause}
     ORDER BY created_at DESC
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
  const result = await pool.query('SELECT * FROM deals WHERE id = $1', [id]);
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

async function scheduleSiteVisit(dealId, data, user) {
  const result = await pool.query(
    `INSERT INTO site_visits (deal_id, scheduled_at, notes, created_by, status)
     VALUES ($1, $2, $3, $4, 'scheduled')
     RETURNING *`,
    [dealId, data.scheduledAt, data.notes || null, user.id]
  );
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

module.exports = {
  listDeals,
  getDealById,
  createDeal,
  updateDeal,
  changeStage,
  scheduleSiteVisit,
  updateSiteVisit,
  logNegotiation,
  recordBooking,
  closeDeal,
  STAGE_TRANSITIONS,
};
