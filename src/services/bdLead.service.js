const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const notificationService = require('./notification.service');
const { uploadBuffer, signUrls } = require('../utils/storage');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { isAdmin } = require('../utils/ownership');
const { badRequest, forbidden, notFound, unprocessable } = require('../utils/httpError');

// "Get Involved" business-development leads + "Advertise With Us" (Annexure
// A sec. 24). These are never property inquiries: they skip the Assignment
// Cascade entirely and always land with Super Admin first, who may then
// assign them onward. City Addition requests are aggregated into a demand
// signal rather than individually actioned.

const CATEGORY_LABELS = {
  city_addition: 'City addition request',
  careers: 'Careers application',
  broker: 'Broker partner enquiry',
  builder: 'Builder partner enquiry',
  franchisee: 'Franchisee enquiry',
  advertiser: 'Advertiser enquiry',
};

// Minimum fields per category, beyond name + (mobile or email).
const CATEGORY_REQUIRED = {
  city_addition: ['cityName'],
  careers: ['positionOfInterest'],
  broker: ['cityName'],
  builder: ['businessName'],
  franchisee: ['territoryOfInterest'],
  advertiser: ['businessName', 'businessCategory'],
};

const ASSIGNABLE_ROLES = ['admin', 'super_admin', 'internal_sales', 'agency_admin'];

const BD_SELECT = `
  SELECT b.*, assignee.full_name AS assigned_to_name, assigner.full_name AS assigned_by_name
  FROM bd_leads b
  LEFT JOIN users assignee ON assignee.id = b.assigned_to
  LEFT JOIN users assigner ON assigner.id = b.assigned_by
`;

async function notifyAdmins(lead) {
  const admins = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('super_admin', 'admin') AND u.status = 'active'`
  );
  await Promise.all(
    admins.rows.map((a) =>
      notificationService
        .createNotification({
          userId: a.id,
          type: 'bd_lead_received',
          title: `New ${CATEGORY_LABELS[lead.category].toLowerCase()}`,
          message: `${lead.full_name}${lead.city_name ? ` - ${lead.city_name}` : ''}`,
          relatedEntityType: 'bd_lead',
          relatedEntityId: lead.id,
        })
        .catch((err) => console.error(`bd-lead notification failed for ${a.id}:`, err.message))
    )
  );
}

// Stores a careers resume privately and links it to the enquiry. Returns
// true / false instead of throwing, so a storage problem never loses the
// application itself.
async function attachResume(leadId, file, { onlyIfMissing = false } = {}) {
  if (onlyIfMissing) {
    const current = await pool.query('SELECT resume_url FROM bd_leads WHERE id = $1', [leadId]);
    if (current.rows[0]?.resume_url) return true;
  }
  try {
    const objectPath = await uploadBuffer(file.buffer, `bd-leads/${leadId}/resume`, file.originalname, file.mimetype);
    await pool.query('UPDATE bd_leads SET resume_url = $1 WHERE id = $2', [objectPath, leadId]);
    return true;
  } catch (err) {
    console.error(`Resume upload failed for bd lead ${leadId}:`, err.message);
    return false;
  }
}

async function createBdLead(data, file) {
  const missing = (CATEGORY_REQUIRED[data.category] || []).filter((k) => !data[k]);
  if (missing.length) throw badRequest(`Missing required field(s) for ${data.category}: ${missing.join(', ')}`);

  // Module 17: advertising is sold only to real-estate-ecosystem businesses,
  // enforced here at intake rather than left to self-certification.
  if (data.category === 'advertiser') {
    const eligible = await configService.getConfig('bd_leads.advertiser_eligible_categories', []);
    if (!eligible.includes(data.businessCategory)) {
      throw unprocessable('Advertising on the platform is limited to businesses in the real-estate ecosystem', [
        { field: 'businessCategory', allowed: eligible },
      ]);
    }
  }

  // Idempotent re-submits: the same person sending the same form twice in a
  // day gets their existing enquiry back rather than a duplicate row.
  const existing = await pool.query(
    `SELECT id FROM bd_leads
     WHERE category = $1 AND created_at > now() - interval '24 hours'
       AND ((mobile IS NOT NULL AND mobile = $2) OR (email IS NOT NULL AND LOWER(email) = LOWER($3)))
     LIMIT 1`,
    [data.category, data.mobile || null, data.email || null]
  );
  if (existing.rows[0]) {
    // A repeat submission that carries a resume the first one lacked (e.g.
    // the upload failed earlier) attaches it rather than dropping it.
    const resumeAttached = file ? await attachResume(existing.rows[0].id, file, { onlyIfMissing: true }) : null;
    return { lead: await getBdLeadById(existing.rows[0].id), duplicate: true, resumeAttached };
  }

  const result = await pool.query(
    `INSERT INTO bd_leads (category, full_name, mobile, email, city_name, area_name, territory_of_interest,
       position_of_interest, business_background, business_name, business_category, desired_placement,
       budget_range, message, source_page)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      data.category,
      data.fullName,
      data.mobile || null,
      data.email || null,
      data.cityName || null,
      data.areaName || null,
      data.territoryOfInterest || null,
      data.positionOfInterest || null,
      data.businessBackground || null,
      data.businessName || null,
      data.businessCategory || null,
      data.desiredPlacement || null,
      data.budgetRange || null,
      data.message || null,
      data.sourcePage || null,
    ]
  );
  let lead = result.rows[0];

  // The application is kept even if the resume can't be stored - the
  // caller is told so the person can re-send it.
  const resumeAttached = file ? await attachResume(lead.id, file) : null;

  if (lead.category !== 'city_addition') await notifyAdmins(lead);
  return {
    lead: { id: lead.id, category: lead.category, status: lead.status, created_at: lead.created_at },
    duplicate: false,
    resumeAttached,
  };
}

async function listBdLeads(user, query) {
  const { page, limit, offset } = parsePagination(query);
  const where = [];
  const params = [];

  // Non-admin staff only see the enquiries Super Admin assigned to them.
  if (!isAdmin(user.role)) {
    params.push(user.id);
    where.push(`b.assigned_to = $${params.length}`);
  }
  for (const [key, col] of [['category', 'b.category'], ['status', 'b.status'], ['assignedTo', 'b.assigned_to']]) {
    if (query[key]) {
      params.push(query[key]);
      where.push(`${col} = $${params.length}`);
    }
  }
  if (query.city) {
    params.push(query.city);
    where.push(`LOWER(b.city_name) = LOWER($${params.length})`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    where.push(`(b.full_name ILIKE $${params.length} OR b.mobile ILIKE $${params.length} OR b.email ILIKE $${params.length} OR b.business_name ILIKE $${params.length})`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    where.push(`b.created_at >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    where.push(`b.created_at <= $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM bd_leads b ${whereClause}`, params);
  const byCategory = await pool.query(
    `SELECT b.category, COUNT(*)::int AS count FROM bd_leads b ${whereClause} GROUP BY b.category`,
    params
  );
  params.push(limit, offset);
  const result = await pool.query(
    `${BD_SELECT} ${whereClause} ORDER BY b.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: await signUrls(result.rows, 'resume_url'),
    countsByCategory: Object.fromEntries(byCategory.rows.map((r) => [r.category, r.count])),
    pagination: buildPagination(page, limit, count.rows[0].count),
  };
}

async function getBdLeadById(id) {
  const result = await pool.query(`${BD_SELECT} WHERE b.id = $1`, [id]);
  if (!result.rows[0]) throw notFound('Enquiry not found');
  return signUrls(result.rows[0], 'resume_url');
}

async function getBdLeadForUser(id, user) {
  const lead = await getBdLeadById(id);
  if (!isAdmin(user.role) && lead.assigned_to !== user.id) throw notFound('Enquiry not found');
  return lead;
}

// Every Super Admin hand-off is logged immutably - who assigned, to whom,
// when (sec. 24 "Get Involved").
async function assignBdLead(id, assigneeId, notes, user, meta = {}) {
  const lead = await getBdLeadById(id);
  const assignee = await pool.query(
    `SELECT u.id, u.full_name, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1 AND u.status = 'active'`,
    [assigneeId]
  );
  if (!assignee.rows[0]) throw badRequest('Assignee not found or inactive');
  if (!ASSIGNABLE_ROLES.includes(assignee.rows[0].role_name)) {
    throw badRequest(`Enquiries can only be assigned to: ${ASSIGNABLE_ROLES.join(', ')}`);
  }

  const result = await pool.query(
    `UPDATE bd_leads
     SET assigned_to = $1, assigned_by = $2, assigned_at = now(),
         status = CASE WHEN status IN ('new', 'under_review') THEN 'assigned'::bd_lead_status ELSE status END,
         internal_notes = COALESCE($3, internal_notes)
     WHERE id = $4 RETURNING id`,
    [assigneeId, user.id, notes || null, id]
  );

  await auditService.log({
    actor: user,
    action: 'bd_lead_assigned',
    entityType: 'bd_lead',
    entityId: id,
    before: { assignedTo: lead.assigned_to, status: lead.status },
    after: { assignedTo: assigneeId },
    ...meta,
  });
  await notificationService
    .createNotification({
      userId: assigneeId,
      type: 'bd_lead_assigned',
      title: `${CATEGORY_LABELS[lead.category]} assigned to you`,
      message: lead.full_name,
      relatedEntityType: 'bd_lead',
      relatedEntityId: id,
    })
    .catch((err) => console.error('bd-lead assign notification failed:', err.message));

  return getBdLeadById(result.rows[0].id);
}

async function updateBdLeadStatus(id, status, notes, user, meta = {}) {
  const lead = await getBdLeadForUser(id, user);
  if (!isAdmin(user.role) && lead.assigned_to !== user.id) throw forbidden();

  await pool.query(
    `UPDATE bd_leads SET status = $1, internal_notes = COALESCE($2, internal_notes) WHERE id = $3`,
    [status, notes || null, id]
  );
  await auditService.log({
    actor: user,
    action: 'bd_lead_status_changed',
    entityType: 'bd_lead',
    entityId: id,
    before: { status: lead.status },
    after: { status, notes: notes || null },
    ...meta,
  });
  return getBdLeadById(id);
}

// Ranked "most requested cities" for the Multi-Geography dashboard - tells
// Super Admin which city to activate next via the City Addition Test.
async function getCityDemand({ days } = {}) {
  const params = [];
  let windowClause = '';
  if (days) {
    params.push(Number(days));
    windowClause = `AND b.created_at > now() - ($1 || ' days')::interval`;
  }
  const result = await pool.query(
    `WITH demand AS (
       SELECT LOWER(TRIM(b.city_name)) AS city_key, INITCAP(MIN(TRIM(b.city_name))) AS city_name,
              COUNT(*)::int AS requests, MAX(b.created_at) AS last_requested_at
       FROM bd_leads b
       WHERE b.category = 'city_addition' AND b.city_name IS NOT NULL ${windowClause}
       GROUP BY LOWER(TRIM(b.city_name))
     )
     SELECT d.city_name, d.requests, d.last_requested_at,
            (SELECT c.status FROM cities c WHERE LOWER(c.city_name) = d.city_key LIMIT 1) AS platform_status
     FROM demand d
     ORDER BY d.requests DESC, d.last_requested_at DESC
     LIMIT 100`,
    params
  );
  return result.rows;
}

module.exports = {
  createBdLead,
  listBdLeads,
  getBdLeadForUser,
  assignBdLead,
  updateBdLeadStatus,
  getCityDemand,
};
