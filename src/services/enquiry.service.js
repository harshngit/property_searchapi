const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { badRequest, notFound } = require('../utils/httpError');

// Enquiry desk (CRM "Enquiries"): every website enquiry is a lead with an
// enquiry_type, so home-loan, insurance, legal, valuation, NRI, investment,
// institutional and general requests each get their own tab and columns
// instead of being mixed with property enquiries. Admins see everything;
// a manager / representative sees the enquiries assigned to them (same
// scope as Leads).
// Site-visit requests from the website are separate records here too, with
// a schedule / decline flow (scheduling opens the deal if there is none).
// attention(): the "needs your attention" counts on the CRM dashboard.

const TYPES = ['property', 'home_loan', 'insurance', 'legal', 'valuation', 'seller', 'nri', 'investment', 'institutional', 'requirement', 'general'];
const LABELS = {
  property: 'Property', home_loan: 'Home loan & financing', insurance: 'Insurance', legal: 'Legal & due diligence', valuation: 'Valuation',
  seller: 'Sellers & owners', nri: 'NRI services', investment: 'Investment', institutional: 'Institutional', requirement: 'Requirement responses', general: 'General',
};
const STAFF = ['internal_sales', 'admin', 'super_admin'];

// Type from the form's topic (and whether a listing is attached).
function classify({ enquiryType, topic, propertyId, requirementId } = {}) {
  if (enquiryType && TYPES.includes(enquiryType)) return enquiryType;
  const t = String(topic || '').toLowerCase();
  if (requirementId || /^requirement\b/.test(t)) return 'requirement';
  if (/loan|financ|mortgage/.test(t)) return 'home_loan';
  if (/insurance/.test(t)) return 'insurance';
  if (/legal|due diligence|document/.test(t)) return 'legal';
  if (/valuation/.test(t)) return 'valuation';
  if (/institutional/.test(t)) return 'institutional';
  if (/nri/.test(t) && !/spv/.test(t)) return 'nri';
  if (/hni|fractional|spv|special situation|invest|auction/.test(t)) return 'investment';
  if (/seller|list property|owner services|sell my/.test(t)) return 'seller';
  if (propertyId) return 'property';
  return t ? 'general' : 'property';
}

// Only plain, short values are kept from the form's extra fields.
function cleanDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const out = {};
  for (const [k, v] of Object.entries(details).slice(0, 12)) {
    if (v === null || v === undefined || v === '') continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) continue;
    out[k] = typeof v === 'number' ? v : String(v).slice(0, 300);
  }
  return out;
}

function scope(user, where, params, alias = 'l') {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  const t = params.length - 1;
  const u = params.length;
  where.push(`(${alias}.tenant_id = $${t} OR ${alias}.created_by = $${u} OR ${alias}.assigned_to = $${u} OR ${alias}.arb_rep_id = $${u})`);
}

async function summary(user) {
  const where = [];
  const params = [];
  scope(user, where, params);
  const r = await pool.query(
    `SELECT l.enquiry_type AS type, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE l.status = 'new')::int AS new,
            COUNT(*) FILTER (WHERE l.status NOT IN ('won', 'lost'))::int AS open
     FROM leads l ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY 1`,
    params
  );
  const by = Object.fromEntries(r.rows.map((x) => [x.type, x]));
  const visits = await visitRequestCounts(user);
  return {
    types: TYPES.map((type) => ({ type, label: LABELS[type], total: by[type]?.total || 0, new: by[type]?.new || 0, open: by[type]?.open || 0 })),
    visitRequests: visits,
  };
}

async function list(user, { type, status, search, page = 1, limit = 25 } = {}) {
  if (type && !TYPES.includes(type)) throw badRequest('Unknown enquiry type');
  const where = [];
  const params = [];
  scope(user, where, params);
  if (type) {
    params.push(type);
    where.push(`l.enquiry_type = $${params.length}`);
  }
  if (status === 'open') where.push(`l.status NOT IN ('won', 'lost')`);
  else if (status) {
    params.push(status);
    where.push(`l.status::text = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    where.push(`(c.full_name ILIKE $${params.length} OR c.mobile ILIKE $${params.length} OR c.email ILIKE $${params.length} OR p.title ILIKE $${params.length} OR l.enquiry_topic ILIKE $${params.length})`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM leads l JOIN customers c ON c.id = l.customer_id LEFT JOIN properties p ON p.id = l.property_id
                LEFT JOIN users rep ON rep.id = COALESCE(l.arb_rep_id, l.assigned_to)`;
  const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} ${w}`, params)).rows[0].n;
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));
  const pg = Math.max(1, Number(page) || 1);
  params.push(lim, (pg - 1) * lim);
  const rows = await pool.query(
    `SELECT l.id, l.enquiry_type, l.enquiry_topic, l.enquiry_details, l.status, l.source, l.created_at, l.first_contacted_at,
            l.lead_score, l.lead_score_category, l.property_id,
            c.id AS customer_id, c.full_name AS customer_name, c.mobile AS customer_mobile, c.email AS customer_email,
            p.title AS property_title, p.city AS property_city, p.locality AS property_locality, p.price AS property_price,
            rep.full_name AS representative_name,
            (SELECT n.note FROM lead_notes n WHERE n.lead_id = l.id ORDER BY n.created_at ASC LIMIT 1) AS first_note,
            (SELECT d.id FROM deals d WHERE d.lead_id = l.id ORDER BY d.created_at DESC LIMIT 1) AS deal_id
     ${from} ${w} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    items: rows.rows.map((r) => ({ ...r, message: String(r.first_note || '').replace(/^Website enquiry:\s*(\[[^\]]*\]\s*)?/, '').replace(/^Guest interest \(mobile verified by OTP\)[^.]*\.\s*(Message:\s*)?/, '') || null })),
    pagination: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
}

// ------------------------------------------------------------ site-visit requests

async function visitRequestCounts(user) {
  const where = [`r.status = 'pending'`];
  const params = [];
  scope(user, where, params);
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM site_visit_requests r JOIN leads l ON l.id = r.lead_id WHERE ${where.join(' AND ')}`, params);
  return { pending: r.rows[0].n };
}

// Website: a customer asks for a visit on one of their enquiries.
async function createVisitRequest({ leadId, customerId, userId, preferredAt, note }) {
  const lead = (
    await pool.query(`SELECT l.id, l.property_id, l.assigned_to, l.arb_rep_id, p.title FROM leads l LEFT JOIN properties p ON p.id = l.property_id WHERE l.id = $1`, [leadId])
  ).rows[0];
  if (!lead) throw notFound('Enquiry not found');
  const when = new Date(preferredAt);
  const row = (
    await pool.query(
      `INSERT INTO site_visit_requests (lead_id, customer_id, property_id, requested_by, preferred_at, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [leadId, customerId || null, lead.property_id, userId || null, when, note ? String(note).slice(0, 1000) : null]
    )
  ).rows[0];
  const text = `Customer requested a site visit${lead.title ? ` for ${lead.title}` : ''} on ${when.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}${note ? `. Note: ${note}` : ''}`;
  await pool.query('INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, $2, $3)', [leadId, userId || null, text]);
  // The representative holding the enquiry; if nobody holds it yet, the admins.
  let targets = [...new Set([lead.arb_rep_id, lead.assigned_to].filter(Boolean))];
  if (!targets.length) {
    targets = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`)).rows.map((x) => x.id);
  }
  for (const id of targets) {
    await notificationService.createNotification({ userId: id, type: 'visit_request', title: 'Site visit requested', message: text, relatedEntityType: 'lead', relatedEntityId: leadId });
  }
  require('./events.service').emit('site_visit_requested', { leadId, properties: { propertyId: lead.property_id, requested_slot: when.toISOString() } });
  return row;
}

async function listVisitRequests(user, { status = 'pending' } = {}) {
  const where = [];
  const params = [];
  scope(user, where, params);
  if (status && status !== 'all') {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  const r = await pool.query(
    `SELECT r.*, c.full_name AS customer_name, c.mobile AS customer_mobile, p.title AS property_title, p.city AS property_city, p.locality AS property_locality,
            rep.full_name AS representative_name, h.full_name AS handled_by_name, sv.scheduled_at AS visit_scheduled_at, sv.status AS visit_status
     FROM site_visit_requests r JOIN leads l ON l.id = r.lead_id
     LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN properties p ON p.id = COALESCE(r.property_id, l.property_id)
     LEFT JOIN users rep ON rep.id = COALESCE(l.arb_rep_id, l.assigned_to) LEFT JOIN users h ON h.id = r.handled_by
     LEFT JOIN site_visits sv ON sv.id = r.site_visit_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY (r.status = 'pending') DESC, r.preferred_at ASC LIMIT 300`,
    params
  );
  return r.rows;
}

async function loadRequest(user, id) {
  const where = ['r.id = $1'];
  const params = [id];
  scope(user, where, params);
  const r = (
    await pool.query(
      `SELECT r.*, l.customer_id AS lead_customer_id, l.property_id AS lead_property_id, l.assigned_to, l.arb_rep_id, c.user_id AS customer_user_id, p.title AS property_title
       FROM site_visit_requests r JOIN leads l ON l.id = r.lead_id LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN properties p ON p.id = l.property_id
       WHERE ${where.join(' AND ')}`,
      params
    )
  ).rows[0];
  if (!r) throw notFound('Visit request not found');
  if (r.status !== 'pending') throw badRequest('This request has already been handled');
  return r;
}

// Schedule the visit: opens the deal for this lead if there is none yet,
// books the site visit (the customer is notified) and closes the request.
async function scheduleVisitRequest(user, id, { scheduledAt, notes }, meta = {}) {
  const r = await loadRequest(user, id);
  const when = new Date(scheduledAt || r.preferred_at);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60000) throw badRequest('Pick a date and time in the future');
  const dealService = require('./deal.service');
  let dealId = (await pool.query(`SELECT id FROM deals WHERE lead_id = $1 AND stage NOT IN ('closed_won', 'closed_lost') ORDER BY created_at DESC LIMIT 1`, [r.lead_id])).rows[0]?.id;
  if (!dealId) {
    const deal = await dealService.createDeal({ leadId: r.lead_id, brokerId: r.assigned_to || r.arb_rep_id || user.id }, user);
    dealId = deal.id;
  }
  const visit = await dealService.scheduleSiteVisit(dealId, { scheduledAt: when.toISOString(), notes: notes || r.note || 'Requested by the customer on the website' }, user);
  await pool.query(`UPDATE site_visit_requests SET status = 'scheduled', handled_by = $1, handled_at = now(), deal_id = $2, site_visit_id = $3 WHERE id = $4`, [user.id, dealId, visit.id, id]);
  await auditService.log({ actor: user, action: 'visit_request.scheduled', entityType: 'lead', entityId: r.lead_id, after: { scheduledAt: when, dealId }, ...meta });
  return { id, status: 'scheduled', dealId, siteVisitId: visit.id, scheduledAt: when };
}

async function declineVisitRequest(user, id, { reason }, meta = {}) {
  const r = await loadRequest(user, id);
  if (!reason || String(reason).trim().length < 3) throw badRequest('Give the customer a reason');
  await pool.query(`UPDATE site_visit_requests SET status = 'declined', handled_by = $1, handled_at = now(), decline_reason = $2 WHERE id = $3`, [user.id, String(reason).slice(0, 500), id]);
  await pool.query('INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, $2, $3)', [r.lead_id, user.id, `Site visit request declined: ${reason}`]);
  if (r.customer_user_id) {
    await notificationService.createNotification({
      userId: r.customer_user_id, type: 'visit_request', title: 'About your site visit request',
      message: `We could not arrange the visit${r.property_title ? ` for ${r.property_title}` : ''} at the time you asked: ${reason}. Your representative will suggest another time.`,
      relatedEntityType: 'lead', relatedEntityId: r.lead_id,
    });
  }
  await auditService.log({ actor: user, action: 'visit_request.declined', entityType: 'lead', entityId: r.lead_id, after: { reason }, ...meta });
  return { id, status: 'declined' };
}

// ------------------------------------------------------------ lead journey

// Where an enquiry stands and what the next step is (CRM lead page):
//   New -> Contacted -> Qualified -> deal opened -> deal pipeline -> Won / Lost.
const DEAL_STAGE_LABEL = {
  inquiry: 'Lead', requirement: 'Requirement', match: 'Match', site_visit: 'Site visit', negotiation: 'Negotiation', legal_coordination: 'Legal coordination',
  loan_referral: 'Loan referral', insurance_referral: 'Insurance referral', booking: 'Booking', documentation: 'Documentation', payment: 'Payment confirmation',
  closed_won: 'Closed - won', closed_lost: 'Closed - lost', on_hold: 'On hold',
};

async function leadFor(user, leadId) {
  const where = ['l.id = $1'];
  const params = [leadId];
  scope(user, where, params);
  const lead = (await pool.query(`SELECT l.* FROM leads l WHERE ${where.join(' AND ')}`, params)).rows[0];
  if (!lead) throw notFound('Enquiry not found');
  return lead;
}

async function journey(user, leadId) {
  const lead = await leadFor(user, leadId);
  const [deal, visits] = await Promise.all([
    pool.query(`SELECT id, stage::text AS stage, deal_value, created_at FROM deals WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [leadId]).then((r) => r.rows[0] || null),
    pool.query(`SELECT id, preferred_at, status, note FROM site_visit_requests WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5`, [leadId]).then((r) => r.rows),
  ]);
  const steps = [
    { key: 'new', label: 'New enquiry', done: true },
    { key: 'contacted', label: 'Contacted', done: lead.status !== 'new' || !!lead.first_contacted_at },
    { key: 'qualified', label: 'Qualified', done: ['qualified', 'hot', 'warm', 'won'].includes(lead.status) || !!deal },
    { key: 'deal', label: 'Deal opened', done: !!deal },
    { key: 'closed', label: lead.status === 'lost' ? 'Lost' : 'Closed', done: ['won', 'lost'].includes(lead.status) },
  ];
  let next;
  if (lead.status === 'lost') next = { action: null, text: 'This enquiry was closed as lost.' };
  else if (lead.status === 'won') next = { action: null, text: 'Deal closed - nothing more to do here.' };
  else if (deal) next = { action: 'open_deal', text: `The deal is at ${DEAL_STAGE_LABEL[deal.stage] || deal.stage}. Continue on the deal page - site visits, negotiation, documents and invoices are tracked there, and it moves stage by stage on its own.` };
  else if (visits.some((v) => v.status === 'pending')) next = { action: 'visit_request', text: 'The customer has asked for a site visit - schedule it from Enquiries > Site visit requests. That also opens the deal.' };
  else if (lead.status === 'new') next = { action: 'contact', text: 'Call the customer, then move the status to Contacted (this records the first response for the SLA).' };
  else if (['qualified', 'hot', 'warm'].includes(lead.status)) next = { action: 'start_deal', text: 'This enquiry is qualified - open a deal to schedule the site visit and take it through the pipeline.' };
  else next = { action: 'qualify', text: 'Confirm the need, budget and timeline. Mark it Qualified when it is a real opportunity (then open the deal), or Lost with the reason.' };
  return {
    leadId, status: lead.status, enquiryType: lead.enquiry_type, enquiryLabel: LABELS[lead.enquiry_type], enquiryTopic: lead.enquiry_topic, enquiryDetails: lead.enquiry_details || {},
    steps, next, deal: deal ? { ...deal, stageLabel: DEAL_STAGE_LABEL[deal.stage] || deal.stage } : null, visitRequests: visits,
  };
}

// Open the deal for a qualified enquiry (one open deal per lead).
async function startDeal(user, leadId, meta = {}) {
  const lead = await leadFor(user, leadId);
  if (['won', 'lost'].includes(lead.status)) throw badRequest('This enquiry is already closed');
  const existing = (await pool.query(`SELECT id FROM deals WHERE lead_id = $1 AND stage NOT IN ('closed_won', 'closed_lost') LIMIT 1`, [leadId])).rows[0];
  if (existing) return { dealId: existing.id, created: false };
  const deal = await require('./deal.service').createDeal({ leadId, brokerId: lead.assigned_to || lead.arb_rep_id || user.id }, user);
  if (['new', 'contacted', 'cold'].includes(lead.status)) await require('./lead.service').updateStatus(leadId, 'qualified', user);
  await auditService.log({ actor: user, action: 'lead.deal_started', entityType: 'lead', entityId: leadId, after: { dealId: deal.id }, ...meta });
  return { dealId: deal.id, created: true };
}

// ------------------------------------------------------------ dashboard attention

// What is waiting on this person, with the screen that handles it.
async function attention(user) {
  const staff = STAFF.includes(user.role);
  const admin = isAdmin(user.role);
  const items = [];
  const one = async (sql, params = []) => (await pool.query(sql, params).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n || 0;
  const add = (key, label, count, to, hint) => items.push({ key, label, count, to, hint });

  const w = [];
  const p = [];
  scope(user, w, p);
  const leadScope = w.length ? ` AND ${w.join(' AND ')}` : '';
  add('new_enquiries', 'New enquiries', await one(`SELECT COUNT(*)::int AS n FROM leads l WHERE l.status = 'new'${leadScope}`, p), '/app/enquiries', 'Not contacted yet');
  add('visit_requests', 'Site visit requests', (await visitRequestCounts(user)).pending, '/app/enquiries?tab=visits', 'Customers waiting for a time');
  add('response_overdue', 'Responses overdue', await one(`SELECT COUNT(*)::int AS n FROM leads l WHERE l.first_contacted_at IS NULL AND l.response_sla_due_at < now() AND l.status NOT IN ('won', 'lost')${leadScope}`, p), '/app/leads', 'Past the response time');

  if (staff) {
    add('deal_room_requests', 'Deal room access requests', await one(`SELECT COUNT(*)::int AS n FROM deal_room_access WHERE status = 'pending_approval'`), '/app/opportunities?tab=rooms', admin ? 'Approve or reject' : 'Waiting for an admin');
    add('listings_pending', 'Listings to approve', await one(`SELECT COUNT(*)::int AS n FROM properties WHERE status = 'pending_approval'`), '/app/properties?status=pending_approval', 'Pending approval');
    add('listings_review', 'Listings under review', await one(`SELECT COUNT(*)::int AS n FROM properties WHERE under_review = true AND status = 'approved'`), '/app/fraud', 'Verification & fraud desk');
    add('verifications', 'Verifications to review', await one(`SELECT COUNT(*)::int AS n FROM user_verifications WHERE status = 'pending'`), '/app/trust', 'KYC / RERA / GST');
    add('reviews', 'Reviews to moderate', await one(`SELECT COUNT(*)::int AS n FROM reviews WHERE status = 'pending_moderation'`), admin ? '/app/reviews?status=pending_moderation' : '/app/trust', 'Held by the fraud filter');
    add('disputes', 'Open disputes', await one(`SELECT COUNT(*)::int AS n FROM disputes WHERE status IN ('open', 'under_review', 'awaiting_info')`), '/app/disputes', '48-hour resolution');
    add('mandates', 'Mandates to acknowledge', await one(`SELECT COUNT(*)::int AS n FROM mandates WHERE status = 'pending_rep_ack'`), '/app/mandates', 'Exclusive mandates');
    add('invoices_overdue', 'Invoices overdue', await one(`SELECT COUNT(*)::int AS n FROM invoices WHERE status = 'overdue' OR (status = 'invoiced' AND due_date < CURRENT_DATE)`), '/app/invoices', 'Professional fee');
    add('investors', 'Investors to verify', await one(`SELECT COUNT(*)::int AS n FROM investor_profiles WHERE verification_status = 'pending'`), '/app/investors', 'NRI / HNI');
    add('institutional_intents', 'Institutional intents to screen', await one(`SELECT COUNT(*)::int AS n FROM institutional_deals WHERE status = 'active' AND stage = 'intent_received' AND screened_at IS NULL`), '/app/institutional', 'Stage 1 of the institutional pipeline');
    add('institutional_buyers', 'Institutional buyers to qualify', await one(`SELECT COUNT(*)::int AS n FROM institutional_buyers WHERE status = 'pending'`), '/app/institutional?tab=buyers', 'Buyer type and financial capacity');
    add('intake', 'Deal intake to review', await one(`SELECT COUNT(*)::int AS n FROM opportunity_ingestion_items WHERE status = 'needs_review'`), '/app/opportunities?tab=intake', 'Crawled / uploaded notices');
  }
  if (admin) {
    add('business_leads', 'New business leads', await one(`SELECT COUNT(*)::int AS n FROM bd_leads WHERE status = 'new'`), '/app/business-leads', 'Partners, careers, advertisers');
  }
  return { items, total: items.reduce((s, i) => s + i.count, 0) };
}

module.exports = { TYPES, LABELS, classify, cleanDetails, summary, list, journey, startDeal, createVisitRequest, listVisitRequests, scheduleVisitRequest, declineVisitRequest, attention };
