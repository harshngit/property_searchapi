const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const suspension = require('../utils/suspension');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Sec. 14 White-Label Franchise Model.
//   Organisation : a franchisee is a tenant with a permanent FR-[SLUG] code,
//                  a Franchisee Admin login and its own brokers.
//   Territory    : granted by pincode (exclusive / open / reserved). A
//                  territory step runs before the Sec. 34 cascade: the
//                  inquiry goes to the franchisee's own team first and
//                  escalates to the Franchisee Manager when they miss it.
//   Commission   : buyer + seller fee clubbed into one pool, split by role
//                  (sec. 14.6), released only after the client has paid.
//   Dues         : invoices raised to the franchisee with the automatic
//                  Day 6 / 8 / 10 / 15 / 30 ladder and 3 suspension levels.
//   Branding     : logo, colours, texts on a domain A R Buildwel owns.
//   Visibility   : a Franchisee Admin gets numbers only - never a lead, a
//                  customer or a contact (sec. 14.9).

const ADMIN = ['admin', 'super_admin'];
const BROKER_ROLES = ['broker', 'agency_admin'];
const LEVELS = ['active', 'level_1', 'level_2', 'level_3'];
const OPEN_LEAD = ['new', 'contacted', 'qualified', 'hot', 'warm', 'cold'];
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const cleanPins = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/)).map((p) => String(p).trim()).filter((p) => /^\d{6}$/.test(p)))];

async function settings() {
  const [ladder, lateFee, terms, split, gst, exempt, autoInvoice, roots] = await Promise.all([
    configService.getConfig('franchise.suspension_ladder', {}),
    configService.getConfig('franchise.late_fee', {}),
    configService.getConfig('franchise.payment_terms_days', 10),
    configService.getConfig('franchise.commission_split', {}),
    configService.getConfig('franchise.gst_percent', 18),
    configService.getConfig('franchise.exempt_tracks', ['institutional', 'auction', 'special_situation', 'nri', 'hni']),
    configService.getConfig('franchise.auto_invoice_on_close', false),
    configService.getConfig('franchise.root_domains', ['propertyserch.com', 'arbuildwel.in']),
  ]);
  return {
    ladder: { grace_days: 5, reminder_day: 6, notice_day: 8, level_1_day: 10, level_2_day: 15, level_3_day: 30, ...(ladder || {}) },
    lateFee: { level_2_percent: 2, level_3_percent: 5, ...(lateFee || {}) },
    termsDays: Number(terms) || 10,
    split: { no_broker_franchisee: 0.5, broker_side: 1 / 3, representative: 1 / 6, ...(split || {}) },
    gstPercent: Number(gst) || 18,
    exempt: Array.isArray(exempt) ? exempt : [],
    autoInvoice: autoInvoice === true || autoInvoice === 'true',
    roots: Array.isArray(roots) ? roots : [],
  };
}

const adminIds = async () => (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ANY($1) AND u.status = 'active'`, [ADMIN])).rows.map((r) => r.id);
const notify = async (ids, n) => {
  for (const id of [...new Set(ids.filter(Boolean))]) {
    await notificationService.createNotification({ userId: id, ...n }).catch(() => {});
  }
};

// ---------------------------------------------------------------- lookups

async function row(id) {
  const f = (await pool.query('SELECT * FROM franchisees WHERE id = $1', [id])).rows[0];
  if (!f) throw notFound('Franchisee not found');
  return f;
}

// The franchisee a Franchisee Admin belongs to. Everything a franchisee
// session reads or writes goes through this - there is no id in the URL.
async function mine(user) {
  if (user.role !== 'franchisee_admin' || !user.tenant_id) throw forbidden('This area is for franchisee admins');
  const f = (await pool.query('SELECT * FROM franchisees WHERE tenant_id = $1', [user.tenant_id])).rows[0];
  if (!f) throw forbidden('No franchise is linked to this account');
  return f;
}

const publicView = (f) => ({
  id: f.id,
  orgCode: f.org_code,
  orgSerial: f.org_serial,
  legalName: f.legal_name,
  gstin: f.gstin,
  pan: f.pan,
  contactName: f.contact_name,
  contactEmail: f.contact_email,
  contactMobile: f.contact_mobile,
  address: f.address,
  status: f.status,
  brandingCompliant: f.branding_compliant,
  deploymentTier: f.deployment_tier,
  agreementStart: f.agreement_start,
  agreementEnd: f.agreement_end,
  suspensionStatus: f.suspension_status,
  suspensionStartDate: f.suspension_start_date,
  totalOutstanding: Number(f.total_outstanding),
  lastPaymentDate: f.last_payment_date,
  reach: f.reach || {},
  reachComputedAt: f.reach_computed_at,
  adminUserId: f.admin_user_id,
  managerUserId: f.manager_user_id,
  notes: f.notes,
  createdAt: f.created_at,
});

// ------------------------------------------------------- suspension cache

async function refreshSuspensionCache() {
  const r = await pool.query(`SELECT tenant_id, suspension_status FROM franchisees WHERE suspension_status <> 'active' AND status = 'active'`);
  suspension.setLevels(new Map(r.rows.map((x) => [x.tenant_id, x.suspension_status])));
}
suspension.setRefresher(refreshSuspensionCache);

// ------------------------------------------------------------- territory

// A listing or requirement's pincode: its own, else the one recorded for
// its locality in the geographic master.
async function pincodeFor({ pincode, city, locality } = {}) {
  if (pincode && /^\d{6}$/.test(String(pincode).trim())) return String(pincode).trim();
  if (!locality) return null;
  const r = await pool.query(
    `SELECT COALESCE(l.pincode, (SELECT p.pincode FROM pincodes p WHERE p.locality_id = l.id AND p.is_active ORDER BY p.pincode LIMIT 1)) AS pincode
     FROM localities l JOIN cities c ON c.id = l.city_id
     WHERE lower(l.locality_name) = lower($1) AND ($2::text IS NULL OR lower(c.city_name) = lower($2))
     ORDER BY l.is_active DESC LIMIT 1`,
    [locality, city || null]
  );
  return r.rows[0]?.pincode || null;
}

// Granted territories covering a pincode, exclusive first.
async function territoriesFor(pincode) {
  if (!pincode) return [];
  const r = await pool.query(
    `SELECT t.*, f.tenant_id, f.status AS franchisee_status, f.branding_compliant, f.suspension_status, f.manager_user_id, f.admin_user_id, f.org_code
     FROM franchisee_territories t JOIN franchisees f ON f.id = t.franchisee_id
     WHERE t.status = 'active' AND t.grant_type IN ('exclusive', 'open') AND $1 = ANY(t.pincodes)
     ORDER BY (t.grant_type = 'exclusive') DESC, t.granted_on ASC`,
    [pincode]
  );
  return r.rows;
}

// NRI, HNI and institutional tracks are handled centrally whatever the pincode.
async function exemptTrack(lead, exempt) {
  if (exempt.includes(lead.enquiry_type)) return lead.enquiry_type;
  if (lead.property_id) {
    const p = (await pool.query('SELECT listing_category FROM properties WHERE id = $1', [lead.property_id])).rows[0];
    if (p && exempt.includes(p.listing_category)) return p.listing_category;
  }
  if (lead.customer_id && (exempt.includes('nri') || exempt.includes('hni'))) {
    const inv = (await pool.query('SELECT is_nri, is_hni FROM investor_profiles WHERE customer_id = $1', [lead.customer_id])).rows[0];
    if (inv?.is_nri && exempt.includes('nri')) return 'nri';
    if (inv?.is_hni && exempt.includes('hni')) return 'hni';
  }
  return null;
}

async function flagConflict({ kind, pincode, propertyId = null, leadId = null, ownerId, otherId = null, actorId = null, detail }) {
  // One open flag per subject and kind - re-checks do not pile up.
  const dup = await pool.query(
    `SELECT 1 FROM territory_conflicts WHERE kind = $1 AND status = 'open' AND property_id IS NOT DISTINCT FROM $2 AND lead_id IS NOT DISTINCT FROM $3 AND owner_franchisee_id IS NOT DISTINCT FROM $4`,
    [kind, propertyId, leadId, ownerId]
  );
  if (dup.rows.length) return;
  await pool.query(
    `INSERT INTO territory_conflicts (kind, pincode, property_id, lead_id, owner_franchisee_id, other_franchisee_id, actor_user_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [kind, pincode || null, propertyId, leadId, ownerId, otherId, actorId, detail || null]
  );
  await notify(await adminIds(), { type: 'territory_conflict', title: 'Territory conflict to review', message: detail || 'Cross-territory activity was flagged.' });
}

const franchiseeOfTenant = async (tenantId) => (tenantId ? (await pool.query('SELECT id FROM franchisees WHERE tenant_id = $1', [tenantId])).rows[0]?.id || null : null);

// Territory Conflict Check for a new listing: a franchisee's user listing
// inside another franchisee's exclusive territory is flagged, not blocked.
async function checkListing(propertyId) {
  const p = (await pool.query(`SELECT p.id, p.pincode, p.city, p.locality, p.created_by, u.tenant_id FROM properties p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [propertyId])).rows[0];
  if (!p) return;
  const actorFranchisee = await franchiseeOfTenant(p.tenant_id);
  if (!actorFranchisee) return;
  const pin = await pincodeFor(p);
  const owner = (await territoriesFor(pin)).find((t) => t.grant_type === 'exclusive');
  if (owner && owner.franchisee_id !== actorFranchisee) {
    await flagConflict({ kind: 'cross_territory_listing', pincode: pin, propertyId: p.id, ownerId: owner.franchisee_id, otherId: actorFranchisee, actorId: p.created_by, detail: `A listing in pincode ${pin} (exclusive territory of ${owner.org_code}) was posted by a user of another franchisee.` });
  }
}
const safeCheckListing = (propertyId) => checkListing(propertyId).catch((err) => console.error('[franchise] listing check failed:', err.message));

// Least-busy active broker of the franchisee's own organisation.
async function teamPick(tenantId, exclude) {
  const r = await pool.query(
    `SELECT u.id, (SELECT COUNT(*) FROM leads l WHERE l.arb_rep_id = u.id AND l.status::text = ANY($3))::int AS open_load
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.tenant_id = $1 AND u.status = 'active' AND r.name = ANY($2) AND NOT (u.id = ANY($4::uuid[]))
     ORDER BY open_load ASC, u.created_at ASC LIMIT 1`,
    [tenantId, BROKER_ROLES, OPEN_LEAD, exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']]
  );
  return r.rows[0]?.id || null;
}

// The territory step that runs before the Sec. 34 cascade. Returns the
// representative to place the inquiry with, or null to let the cascade pick.
async function pickFor(lead, ctx, { reason, exclude }) {
  if (reason === 'missed') {
    // The franchisee's own team missed the window: the Franchisee Manager takes it.
    if (lead.assignment_route !== 'franchisee_team' || !lead.franchisee_id) return null;
    const f = (await pool.query('SELECT manager_user_id FROM franchisees WHERE id = $1', [lead.franchisee_id])).rows[0];
    const fm = f?.manager_user_id;
    if (!fm || exclude.includes(fm)) return null;
    const active = (await pool.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [fm])).rows.length > 0;
    return active ? { userId: fm, route: 'franchisee_manager' } : null;
  }
  if (reason !== 'new') return null;
  const s = await settings();
  if (await exemptTrack(lead, s.exempt)) return null;

  let pin = null;
  if (lead.property_id) {
    const p = (await pool.query('SELECT pincode, city, locality FROM properties WHERE id = $1', [lead.property_id])).rows[0];
    pin = p ? await pincodeFor(p) : null;
  }
  if (!pin) {
    const rq = (await pool.query('SELECT pincode FROM requirements WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1', [lead.id])).rows[0];
    pin = await pincodeFor({ pincode: rq?.pincode, city: ctx.city, locality: ctx.locality });
  }
  const granted = await territoriesFor(pin);
  if (!granted.length) return null;
  const owner = granted[0];

  // A broker of one franchisee bringing an inquiry inside another's exclusive territory.
  const actorFranchisee = await franchiseeOfTenant(lead.tenant_id);
  if (owner.grant_type === 'exclusive' && actorFranchisee && actorFranchisee !== owner.franchisee_id) {
    await flagConflict({ kind: 'cross_territory_lead', pincode: pin, leadId: lead.id, ownerId: owner.franchisee_id, otherId: actorFranchisee, actorId: lead.created_by, detail: `An inquiry in pincode ${pin} (exclusive territory of ${owner.org_code}) came from a user of another franchisee.` });
  }
  // Two open grants on the same pincode: a boundary case for Super Admin.
  if (owner.grant_type === 'open' && granted.filter((t) => t.grant_type === 'open' && t.franchisee_id !== owner.franchisee_id).length) {
    await flagConflict({ kind: 'boundary', pincode: pin, leadId: lead.id, ownerId: owner.franchisee_id, otherId: granted.find((t) => t.franchisee_id !== owner.franchisee_id).franchisee_id, detail: `Pincode ${pin} is in more than one open territory - the inquiry went to the earliest grant.` });
  }

  await pool.query('UPDATE leads SET franchisee_id = $2, territory_id = $3 WHERE id = $1', [lead.id, owner.franchisee_id, owner.id]);
  await pool.query('UPDATE deals SET franchisee_id = $2 WHERE lead_id = $1', [lead.id, owner.franchisee_id]);
  lead.franchisee_id = owner.franchisee_id;

  // Eligibility for system-routed leads: active, presenting as A R Buildwel, not at Level 2 or 3.
  const eligible = owner.franchisee_status === 'active' && owner.branding_compliant && !['level_2', 'level_3'].includes(owner.suspension_status);
  if (!eligible) {
    await pool.query('UPDATE leads SET can_broker_see = false, reassigned_to_arb_on = now() WHERE id = $1', [lead.id]);
    return null;
  }
  const member = await teamPick(owner.tenant_id, exclude);
  if (member) return { userId: member, route: 'franchisee_team' };
  if (owner.manager_user_id && !exclude.includes(owner.manager_user_id)) return { userId: owner.manager_user_id, route: 'franchisee_manager' };
  return null;
}

// ------------------------------------------------------------ admin: orgs

async function list() {
  const r = await pool.query(
    `SELECT f.*, au.full_name AS admin_name, au.email AS admin_email, mu.full_name AS manager_name, b.host, b.domain_active, b.brand_mode,
            (SELECT COUNT(*) FROM franchisee_territories t WHERE t.franchisee_id = f.id AND t.status = 'active')::int AS territories,
            (SELECT COALESCE(SUM(cardinality(t.pincodes)), 0) FROM franchisee_territories t WHERE t.franchisee_id = f.id AND t.status = 'active')::int AS pincodes,
            (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = f.tenant_id AND r.name = ANY($1) AND u.status = 'active')::int AS brokers
     FROM franchisees f LEFT JOIN users au ON au.id = f.admin_user_id LEFT JOIN users mu ON mu.id = f.manager_user_id
     LEFT JOIN franchisee_branding b ON b.franchisee_id = f.id
     ORDER BY f.created_at DESC`,
    [BROKER_ROLES]
  );
  return r.rows.map((f) => ({ ...publicView(f), adminName: f.admin_name, adminEmail: f.admin_email, managerName: f.manager_name, host: f.host, domainActive: f.domain_active, brandMode: f.brand_mode, territories: f.territories, pincodes: f.pincodes, brokers: f.brokers }));
}

async function get(id) {
  const f = await row(id);
  const [admin, manager, branding, territories] = await Promise.all([
    f.admin_user_id ? pool.query('SELECT full_name, email, mobile, status FROM users WHERE id = $1', [f.admin_user_id]) : { rows: [] },
    f.manager_user_id ? pool.query('SELECT full_name, email FROM users WHERE id = $1', [f.manager_user_id]) : { rows: [] },
    pool.query('SELECT * FROM franchisee_branding WHERE franchisee_id = $1', [id]),
    pool.query(`SELECT * FROM franchisee_territories WHERE franchisee_id = $1 ORDER BY status, granted_on DESC`, [id]),
  ]);
  return { ...publicView(f), admin: admin.rows[0] || null, manager: manager.rows[0] || null, branding: brandingView(branding.rows[0]), territories: territories.rows.map(territoryView) };
}

async function assertManager(userId) {
  if (!userId) return null;
  const u = (await pool.query(`SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.status = 'active'`, [userId])).rows[0];
  if (!u || !['internal_sales', 'admin', 'super_admin'].includes(u.name)) throw badRequest('The Franchisee Manager must be an active A R Buildwel staff member');
  // FM is an A R Buildwel employee designation - record it on their representative profile.
  await pool.query(
    `INSERT INTO arb_representatives (user_id, designation, accepts_assignments) VALUES ($1, 'fm', false)
     ON CONFLICT (user_id) DO UPDATE SET designation = CASE WHEN arb_representatives.designation IN ('rm', 'dm') THEN arb_representatives.designation ELSE 'fm' END`,
    [userId]
  );
  return userId;
}

async function create(admin, data, meta = {}) {
  const legalName = String(data.legalName || '').trim();
  const email = String(data.adminEmail || '').trim().toLowerCase();
  if (legalName.length < 2) throw badRequest('The registered firm name is required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('A login email for the Franchisee Admin is required');
  if (!data.adminPassword || String(data.adminPassword).length < 8) throw badRequest('Set an initial password of at least 8 characters');
  if ((await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rows.length) throw badRequest('An account with this email already exists');
  const slug = slugify(data.slug || legalName);
  if (slug.length < 2) throw badRequest('Give a short organisation name (letters and numbers)');
  if ((await pool.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])).rows.length) throw badRequest('That organisation slug is already used');
  const managerId = await assertManager(data.managerUserId || null);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = (await client.query(`INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`, [legalName, slug])).rows[0];
    const role = (await client.query(`SELECT id FROM roles WHERE name = 'franchisee_admin'`)).rows[0];
    const user = (
      await client.query(
        `INSERT INTO users (tenant_id, role_id, full_name, email, mobile, password_hash, status, email_verified, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', true, $7) RETURNING id`,
        [tenant.id, role.id, data.adminName || data.contactName || legalName, email, data.adminMobile || null, await bcrypt.hash(String(data.adminPassword), 10), admin.id]
      )
    ).rows[0];
    const n = (await client.query(`SELECT nextval('franchisee_org_seq') AS n`)).rows[0].n;
    const f = (
      await client.query(
        `INSERT INTO franchisees (tenant_id, org_code, org_serial, legal_name, gstin, pan, contact_name, contact_email, contact_mobile, address, admin_user_id, manager_user_id,
                                  deployment_tier, agreement_start, agreement_end, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
        [tenant.id, `FR-${slug.toUpperCase()}`, `ORG-${String(n).padStart(4, '0')}`, legalName, data.gstin || null, data.pan || null, data.contactName || data.adminName || null, data.contactEmail || email,
          data.contactMobile || data.adminMobile || null, data.address || null, user.id, managerId, data.deploymentTier || 'shared', data.agreementStart || null, data.agreementEnd || null, data.notes || null, admin.id]
      )
    ).rows[0];
    await client.query(`INSERT INTO franchisee_branding (franchisee_id, brand_name) VALUES ($1, $2)`, [f.id, data.brandName || null]);
    await client.query('COMMIT');
    await auditService.log({ actor: admin, action: 'franchise.created', entityType: 'franchisee', entityId: f.id, after: { orgCode: f.org_code, legalName }, ...meta });
    return get(f.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function update(admin, id, data, meta = {}) {
  const before = await row(id);
  const managerId = data.managerUserId !== undefined ? await assertManager(data.managerUserId || null) : before.manager_user_id;
  const pick = (key, col) => (data[key] !== undefined ? data[key] : before[col]);
  const status = pick('status', 'status');
  if (!['pending', 'active', 'terminated'].includes(status)) throw badRequest('status must be pending, active or terminated');
  await pool.query(
    `UPDATE franchisees SET legal_name = $2, gstin = $3, pan = $4, contact_name = $5, contact_email = $6, contact_mobile = $7, address = $8, manager_user_id = $9,
            status = $10, branding_compliant = $11, deployment_tier = $12, agreement_start = $13, agreement_end = $14, notes = $15 WHERE id = $1`,
    [id, pick('legalName', 'legal_name'), pick('gstin', 'gstin') || null, pick('pan', 'pan') || null, pick('contactName', 'contact_name'), pick('contactEmail', 'contact_email'), pick('contactMobile', 'contact_mobile'),
      pick('address', 'address'), managerId, status, pick('brandingCompliant', 'branding_compliant') !== false, pick('deploymentTier', 'deployment_tier'), pick('agreementStart', 'agreement_start') || null,
      pick('agreementEnd', 'agreement_end') || null, pick('notes', 'notes')]
  );
  await auditService.log({ actor: admin, action: 'franchise.updated', entityType: 'franchisee', entityId: id, before: { status: before.status, brandingCompliant: before.branding_compliant }, after: { status, brandingCompliant: pick('brandingCompliant', 'branding_compliant') !== false }, ...meta });
  // A terminated franchisee's brokers stop receiving inquiries; open ones go back to A R Buildwel.
  if (status === 'terminated' && before.status !== 'terminated') await reassignToArb(id, 'franchise terminated');
  await refreshSuspensionCache();
  return get(id);
}

// ------------------------------------------------------ admin: territories

const territoryView = (t) => ({
  id: t.id, franchiseeId: t.franchisee_id, name: t.name, grantType: t.grant_type, pincodes: t.pincodes, status: t.status,
  firstRefusalFranchiseeId: t.first_refusal_franchisee_id, grantedOn: t.granted_on, reviewOn: t.review_on, notes: t.notes,
  orgCode: t.org_code, legalName: t.legal_name,
});

// Exclusive means no other franchisee: a pincode already inside someone
// else's active grant cannot be given exclusively, and nothing can be
// granted inside another franchisee's exclusive territory.
async function overlaps(franchiseeId, grantType, pincodes, ignoreId = null) {
  const r = await pool.query(
    `SELECT t.id, t.name, t.grant_type, t.franchisee_id, f.org_code, ARRAY(SELECT unnest(t.pincodes) INTERSECT SELECT unnest($1::text[])) AS shared
     FROM franchisee_territories t LEFT JOIN franchisees f ON f.id = t.franchisee_id
     WHERE t.status = 'active' AND t.pincodes && $1::text[] AND t.id IS DISTINCT FROM $2 AND t.franchisee_id IS DISTINCT FROM $3`,
    [pincodes, ignoreId, franchiseeId]
  );
  return r.rows.filter((t) => t.grant_type === 'reserved' || t.grant_type === 'exclusive' || grantType === 'exclusive');
}

async function listTerritories() {
  const r = await pool.query(
    `SELECT t.*, f.org_code, f.legal_name FROM franchisee_territories t LEFT JOIN franchisees f ON f.id = t.franchisee_id ORDER BY t.status, t.granted_on DESC`
  );
  return r.rows.map(territoryView);
}

async function saveTerritory(admin, data, meta = {}) {
  const grantType = data.grantType;
  if (!['exclusive', 'open', 'reserved'].includes(grantType)) throw badRequest('grantType must be exclusive, open or reserved');
  const pincodes = cleanPins(data.pincodes);
  if (!pincodes.length) throw badRequest('Add at least one 6-digit pincode');
  const name = String(data.name || '').trim();
  if (name.length < 2) throw badRequest('Give the territory a name');
  const franchiseeId = grantType === 'reserved' ? null : data.franchiseeId || null;
  if (grantType !== 'reserved') {
    if (!franchiseeId) throw badRequest('Choose the franchisee this territory is granted to');
    await row(franchiseeId);
  }
  // Territory uses the geographic master - a pincode must exist there first.
  const known = (await pool.query('SELECT DISTINCT pincode FROM pincodes WHERE pincode = ANY($1) UNION SELECT DISTINCT pincode FROM localities WHERE pincode = ANY($1)', [pincodes])).rows.map((r) => r.pincode);
  const unknown = pincodes.filter((p) => !known.includes(p));
  if (unknown.length) throw badRequest(`Not in the geographic master data: ${unknown.join(', ')}. Add the pincode under Admin Panel first.`);

  const before = data.id ? (await pool.query('SELECT * FROM franchisee_territories WHERE id = $1', [data.id])).rows[0] : null;
  if (data.id && !before) throw notFound('Territory not found');
  const clash = await overlaps(franchiseeId, grantType, pincodes, data.id || null);
  if (clash.length) {
    const c = clash[0];
    // A reserved pincode goes first to the franchisee holding right of first refusal.
    throw badRequest(`Pincode ${c.shared.join(', ')} is already in "${c.name}" (${c.grant_type}${c.org_code ? `, ${c.org_code}` : ''}). ${c.grant_type === 'reserved' ? 'Grant the reserved territory instead.' : 'Exclusive territory cannot be shared.'}`);
  }
  let t;
  if (before) {
    t = (await pool.query(
      `UPDATE franchisee_territories SET franchisee_id = $2, name = $3, grant_type = $4, pincodes = $5, review_on = $6, notes = $7, first_refusal_franchisee_id = $8 WHERE id = $1 RETURNING *`,
      [before.id, franchiseeId, name, grantType, pincodes, data.reviewOn || null, data.notes || null, grantType === 'reserved' ? data.firstRefusalFranchiseeId || null : null]
    )).rows[0];
  } else {
    t = (await pool.query(
      `INSERT INTO franchisee_territories (franchisee_id, name, grant_type, pincodes, review_on, notes, first_refusal_franchisee_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [franchiseeId, name, grantType, pincodes, data.reviewOn || null, data.notes || null, grantType === 'reserved' ? data.firstRefusalFranchiseeId || null : null, admin.id]
    )).rows[0];
  }
  await auditService.log({ actor: admin, action: before ? 'franchise.territory_updated' : 'franchise.territory_granted', entityType: 'franchisee_territory', entityId: t.id, before: before ? { grantType: before.grant_type, pincodes: before.pincodes } : null, after: { franchiseeId, grantType, pincodes }, ...meta });
  return territoryView(t);
}

// Hand a reserved territory to a franchisee. The one with right of first
// refusal comes first; giving it to anyone else needs an explicit override.
async function grantReserved(admin, territoryId, { franchiseeId, grantType = 'exclusive', overrideFirstRefusal = false }, meta = {}) {
  const t = (await pool.query(`SELECT * FROM franchisee_territories WHERE id = $1 AND status = 'active'`, [territoryId])).rows[0];
  if (!t || t.grant_type !== 'reserved') throw badRequest('This is not a reserved territory');
  if (!['exclusive', 'open'].includes(grantType)) throw badRequest('Grant as exclusive or open');
  await row(franchiseeId);
  if (t.first_refusal_franchisee_id && t.first_refusal_franchisee_id !== franchiseeId && !overrideFirstRefusal) {
    throw badRequest('Another franchisee holds right of first refusal on this territory. Offer it to them first, or confirm they declined.');
  }
  const clash = await overlaps(franchiseeId, grantType, t.pincodes, t.id);
  if (clash.length) throw badRequest(`Pincode ${clash[0].shared.join(', ')} is already in "${clash[0].name}"`);
  const u = (await pool.query(`UPDATE franchisee_territories SET franchisee_id = $2, grant_type = $3, granted_on = CURRENT_DATE, first_refusal_franchisee_id = NULL WHERE id = $1 RETURNING *`, [t.id, franchiseeId, grantType])).rows[0];
  await auditService.log({ actor: admin, action: 'franchise.reserved_granted', entityType: 'franchisee_territory', entityId: t.id, after: { franchiseeId, grantType, overrideFirstRefusal: !!overrideFirstRefusal }, ...meta });
  return territoryView(u);
}

async function withdrawTerritory(admin, territoryId, reason, meta = {}) {
  const t = (await pool.query(`UPDATE franchisee_territories SET status = 'withdrawn', notes = COALESCE($2, notes) WHERE id = $1 AND status = 'active' RETURNING *`, [territoryId, reason || null])).rows[0];
  if (!t) throw notFound('Territory not found or already withdrawn');
  await auditService.log({ actor: admin, action: 'franchise.territory_withdrawn', entityType: 'franchisee_territory', entityId: t.id, after: { reason: reason || null }, ...meta });
  return territoryView(t);
}

async function listConflicts({ status = 'open' } = {}) {
  const r = await pool.query(
    `SELECT c.*, fo.org_code AS owner_code, fx.org_code AS other_code, u.full_name AS actor_name, p.title AS property_title
     FROM territory_conflicts c LEFT JOIN franchisees fo ON fo.id = c.owner_franchisee_id LEFT JOIN franchisees fx ON fx.id = c.other_franchisee_id
     LEFT JOIN users u ON u.id = c.actor_user_id LEFT JOIN properties p ON p.id = c.property_id
     WHERE ($1::text = 'all' OR c.status = $1) ORDER BY c.created_at DESC LIMIT 200`,
    [status]
  );
  return r.rows.map((c) => ({ id: c.id, kind: c.kind, pincode: c.pincode, propertyId: c.property_id, propertyTitle: c.property_title, leadId: c.lead_id, ownerCode: c.owner_code, otherCode: c.other_code, actorName: c.actor_name, detail: c.detail, status: c.status, resolution: c.resolution, createdAt: c.created_at, resolvedAt: c.resolved_at }));
}

async function resolveConflict(admin, id, resolution, meta = {}) {
  if (!resolution || String(resolution).trim().length < 3) throw badRequest('Write how this was resolved');
  const c = (await pool.query(`UPDATE territory_conflicts SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [id, String(resolution).trim(), admin.id])).rows[0];
  if (!c) throw notFound('Conflict not found or already resolved');
  await auditService.log({ actor: admin, action: 'franchise.conflict_resolved', entityType: 'territory_conflict', entityId: id, after: { resolution }, ...meta });
  return { id, status: 'resolved' };
}

// ------------------------------------------------------------- commission

async function brokerOf(userId) {
  if (!userId) return null;
  const u = (await pool.query(`SELECT u.id, u.full_name, u.tenant_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0];
  return u && [...BROKER_ROLES, 'franchisee_admin'].includes(u.role) ? u : null;
}

const gstRegistered = async (userId) => (await pool.query(`SELECT 1 FROM user_verifications WHERE user_id = $1 AND kind = 'gst' AND status = 'verified' LIMIT 1`, [userId])).rows.length > 0;

// Sec. 14.6: club both sides' fee into one pool, then split it by role.
async function calculateForDeal(dealId, { actor = null } = {}) {
  const d = (
    await pool.query(
      `SELECT d.*, l.franchisee_id AS lead_franchisee, l.created_by AS lead_creator, p.broker_id AS property_broker, p.created_by AS property_creator
       FROM deals d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN properties p ON p.id = d.property_id WHERE d.id = $1`,
      [dealId]
    )
  ).rows[0];
  if (!d || d.stage !== 'closed_won') return null;
  const routedFranchisee = d.franchisee_id || d.lead_franchisee;
  const ownFranchisee = routedFranchisee ? null : await franchiseeOfTenant(d.tenant_id);
  const franchiseeId = routedFranchisee || ownFranchisee;
  if (!franchiseeId) return null; // outside franchisee territory: the standard structure applies
  if ((await pool.query('SELECT 1 FROM franchisee_commissions WHERE deal_id = $1', [dealId])).rows.length) return null;
  const f = await row(franchiseeId);
  const s = await settings();

  // Registered / cheque value only. Fees come from the invoices raised to the two sides.
  const inv = (await pool.query(`SELECT party, SUM(fee_amount) AS fee FROM invoices WHERE deal_id = $1 AND status <> 'waived' GROUP BY party`, [dealId])).rows;
  let buyerFee = inv.filter((i) => ['buyer', 'tenant'].includes(i.party)).reduce((a, i) => a + Number(i.fee), 0);
  let sellerFee = inv.filter((i) => ['seller', 'landlord'].includes(i.party)).reduce((a, i) => a + Number(i.fee), 0);
  const dealValue = Number(d.deal_value) || 0;
  if (!inv.length) {
    buyerFee = round2(dealValue * 0.01);
    sellerFee = round2(dealValue * 0.01);
  }
  const pool_ = round2(buyerFee + sellerFee);
  if (pool_ <= 0) return null;

  const buyerBroker = (await brokerOf(d.broker_id)) || (await brokerOf(d.lead_creator));
  const sellerBroker = (await brokerOf(d.property_broker)) || (await brokerOf(d.property_creator));
  const parts = []; // { key, party, userId, name, role, fraction }
  let scenario;
  if (!routedFranchisee) {
    // Business the franchisee brought in on his own: his complete income, nothing remitted.
    scenario = 'own_business';
    parts.push({ key: 'franchisee', party: 'franchisee', userId: f.admin_user_id, name: f.legal_name, role: 'Own business - not system-routed', fraction: 1 });
  } else if (!buyerBroker && !sellerBroker) {
    scenario = 'no_broker';
    parts.push({ key: 'franchisee', party: 'franchisee', userId: f.admin_user_id, name: f.legal_name, role: 'Territory representative', fraction: Number(s.split.no_broker_franchisee) });
  } else {
    scenario = 'with_broker';
    for (const [side, b] of [['buyer side', buyerBroker], ['seller side', sellerBroker]]) {
      if (!b) continue;
      const personal = b.id === f.admin_user_id;
      parts.push({ key: personal ? 'franchisee' : b.id, party: personal ? 'franchisee' : 'broker', userId: b.id, name: personal ? f.legal_name : b.full_name, role: `Broker (${side})`, fraction: Number(s.split.broker_side) });
    }
    parts.push({ key: 'franchisee', party: 'franchisee', userId: f.admin_user_id, name: f.legal_name, role: 'A R Buildwel Representative', fraction: Number(s.split.representative) });
  }
  // Shares of the same recipient stack.
  const merged = [];
  for (const p of parts) {
    const hit = merged.find((m) => m.key === p.key);
    if (hit) {
      hit.fraction += p.fraction;
      hit.roles.push(p.role);
    } else merged.push({ key: p.key, party: p.party, userId: p.userId, name: p.name, roles: [p.role], fraction: p.fraction });
  }
  const shares = [];
  let given = 0;
  for (const m of merged) {
    const base = round2(pool_ * m.fraction);
    given += base;
    // GST only where the recipient is independently registered - never assumed.
    const registered = m.party === 'franchisee' ? !!f.gstin : await gstRegistered(m.userId);
    const gst = registered ? round2((base * s.gstPercent) / 100) : 0;
    shares.push({ party: m.party, userId: m.userId, name: m.name, roles: m.roles, fraction: Math.round(m.fraction * 1e6) / 1e6, base, gstRegistered: registered, gst, total: round2(base + gst) });
  }
  const arbBase = round2(pool_ - given);
  if (arbBase > 0.005) shares.push({ party: 'arb', userId: null, name: 'A R Buildwel', roles: ['Central share'], fraction: Math.round((arbBase / pool_) * 1e6) / 1e6, base: arbBase, gstRegistered: false, gst: 0, total: arbBase });
  const franchiseeBase = shares.filter((x) => x.party === 'franchisee').reduce((a, x) => a + x.base, 0);

  const rec = (
    await pool.query(
      `INSERT INTO franchisee_commissions (franchisee_id, deal_id, deal_value, buyer_fee, seller_fee, pool_amount, scenario, shares, franchisee_base, arb_base)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (deal_id) DO NOTHING RETURNING *`,
      [franchiseeId, dealId, dealValue, round2(buyerFee), round2(sellerFee), pool_, scenario, JSON.stringify(shares), round2(franchiseeBase), Math.max(0, arbBase)]
    )
  ).rows[0];
  if (!rec) return null;
  await auditService.log({ actor, action: 'franchise.commission_calculated', entityType: 'franchisee_commission', entityId: rec.id, after: { dealId, pool: pool_, scenario } });
  await notify([f.admin_user_id], { type: 'franchise_commission', title: 'Commission calculated for a closed deal', message: `Pool ₹${pool_.toLocaleString('en-IN')} - your share ₹${round2(franchiseeBase).toLocaleString('en-IN')}. It is released once the client invoices are collected.` });
  if (s.autoInvoice && scenario !== 'own_business' && arbBase > 0) {
    await raiseInvoice(null, franchiseeId, { kind: 'commission', dealId, baseAmount: arbBase, description: 'A R Buildwel share on a closed territory deal' }).catch((err) => console.error('[franchise] auto invoice failed:', err.message));
  }
  await refreshCollected(franchiseeId);
  return commissionView(rec);
}
const safeCalculate = (dealId) => calculateForDeal(dealId).catch((err) => console.error('[franchise] commission calculation failed:', err.message));

const commissionView = (c) => ({
  id: c.id, franchiseeId: c.franchisee_id, dealId: c.deal_id, dealValue: Number(c.deal_value), buyerFee: Number(c.buyer_fee), sellerFee: Number(c.seller_fee), pool: Number(c.pool_amount),
  scenario: c.scenario, shares: c.shares, franchiseeBase: Number(c.franchisee_base), arbBase: Number(c.arb_base), status: c.status, collectedAt: c.collected_at, releasedAt: c.released_at,
  payoutReference: c.payout_reference, createdAt: c.created_at, orgCode: c.org_code, legalName: c.legal_name,
});

// Payment gating: a share becomes releasable only when every client invoice
// on the deal has actually been collected.
async function refreshCollected(franchiseeId = null) {
  await pool.query(
    `UPDATE franchisee_commissions c SET status = 'releasable', collected_at = now()
     WHERE c.status = 'calculated' AND ($1::uuid IS NULL OR c.franchisee_id = $1)
       AND EXISTS (SELECT 1 FROM invoices i WHERE i.deal_id = c.deal_id AND i.status <> 'waived')
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.deal_id = c.deal_id AND i.status NOT IN ('paid', 'waived'))`,
    [franchiseeId]
  );
}

async function listCommissions({ franchiseeId = null } = {}) {
  await refreshCollected(franchiseeId);
  const r = await pool.query(
    `SELECT c.*, f.org_code, f.legal_name FROM franchisee_commissions c JOIN franchisees f ON f.id = c.franchisee_id
     WHERE ($1::uuid IS NULL OR c.franchisee_id = $1) ORDER BY c.created_at DESC LIMIT 500`,
    [franchiseeId]
  );
  return r.rows.map(commissionView);
}

async function releaseCommission(admin, id, payoutReference, meta = {}) {
  await refreshCollected();
  const c = (await pool.query('SELECT * FROM franchisee_commissions WHERE id = $1', [id])).rows[0];
  if (!c) throw notFound('Commission calculation not found');
  if (c.status === 'released') throw badRequest('This commission has already been released');
  if (c.status !== 'releasable') throw badRequest('Not released yet: A R Buildwel has not collected the client invoices for this deal');
  // Section 35: a share due to a suspended person waits for the Super Admin's decision.
  const frozen = await require('./userSuspension.service').frozenFor(id);
  if (frozen.length) throw badRequest(`Frozen: the share of ${frozen.map((f) => f.full_name).join(', ')} is held while the account is suspended. The Super Admin decides first.`);
  if (!payoutReference || String(payoutReference).trim().length < 3) throw badRequest('Enter the payout reference (UTR)');
  const u = (await pool.query(`UPDATE franchisee_commissions SET status = 'released', released_at = now(), released_by = $2, payout_reference = $3 WHERE id = $1 RETURNING *`, [id, admin.id, String(payoutReference).trim()])).rows[0];
  await auditService.log({ actor: admin, action: 'franchise.commission_released', entityType: 'franchisee_commission', entityId: id, after: { payoutReference }, ...meta });
  const f = await row(c.franchisee_id);
  await notify([f.admin_user_id], { type: 'franchise_commission', title: 'Commission released', message: `Your share ₹${Number(c.franchisee_base).toLocaleString('en-IN')} was paid. Reference ${String(payoutReference).trim()}.` });
  return commissionView(u);
}

// Correction of a settled calculation: Super Admin deletes it; the audit log keeps the record.
async function deleteCommission(admin, id, reason, meta = {}) {
  if (admin.role !== 'super_admin') throw forbidden('Only a Super Admin can delete a commission calculation');
  if (!reason || String(reason).trim().length < 5) throw badRequest('Give the reason for deleting this calculation');
  const c = (await pool.query('DELETE FROM franchisee_commissions WHERE id = $1 RETURNING *', [id])).rows[0];
  if (!c) throw notFound('Commission calculation not found');
  await auditService.log({ actor: admin, action: 'franchise.commission_deleted', entityType: 'franchisee_commission', entityId: id, before: { dealId: c.deal_id, pool: Number(c.pool_amount), shares: c.shares, status: c.status }, after: { reason: String(reason).trim() }, ...meta });
  return { id, deleted: true };
}

// ------------------------------------------------- dues and the suspension

const invoiceView = (i) => {
  const due = new Date(i.payment_due_date);
  const open = ['pending', 'overdue'].includes(i.payment_status);
  return {
    id: i.id, franchiseeId: i.franchisee_id, dealId: i.deal_id, invoiceNumber: i.invoice_number, kind: i.kind, description: i.description,
    baseAmount: Number(i.base_amount), gstAmount: Number(i.gst_amount), amount: Number(i.invoice_amount), lateFee: Number(i.late_fee), totalDue: open ? round2(Number(i.invoice_amount) + Number(i.late_fee)) : 0,
    status: i.payment_status, invoiceDate: i.invoice_date, dueDate: i.payment_due_date, paidAt: i.payment_received_date,
    daysOverdue: open ? Math.max(0, Math.floor((Date.now() - due.getTime()) / 86400000)) : 0,
    suspensionStatus: i.suspension_status, lastReminderSent: i.last_reminder_sent, paymentReference: i.payment_reference, paymentClaimedAt: i.payment_claimed_at,
    orgCode: i.org_code, legalName: i.legal_name,
  };
};

async function raiseInvoice(admin, franchiseeId, { kind = 'other', dealId = null, baseAmount, description, invoiceDate = null }, meta = {}) {
  const f = await row(franchiseeId);
  const base = round2(baseAmount);
  if (!(base > 0)) throw badRequest('Enter the amount');
  if (!['commission', 'setup_fee', 'annual_fee', 'domain', 'other'].includes(kind)) throw badRequest('Unknown invoice kind');
  const s = await settings();
  const gst = round2((base * s.gstPercent) / 100);
  const issued = invoiceDate ? new Date(invoiceDate) : new Date();
  if (Number.isNaN(issued.getTime())) throw badRequest('Invalid invoice date');
  const n = (await pool.query(`SELECT nextval('franchisee_invoice_seq') AS n`)).rows[0].n;
  const number = `FRI-${issued.getFullYear()}-${String(n).padStart(5, '0')}`;
  const inv = (
    await pool.query(
      `INSERT INTO franchisee_payment_tracking (franchisee_id, deal_id, invoice_number, kind, description, base_amount, gst_amount, invoice_amount, invoice_date, payment_due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9::timestamptz + make_interval(days => $10), $11) RETURNING *`,
      [franchiseeId, dealId, number, kind, description || null, base, gst, round2(base + gst), issued, s.termsDays, admin?.id || null]
    )
  ).rows[0];
  await auditService.log({ actor: admin, action: 'franchise.invoice_raised', entityType: 'franchisee_invoice', entityId: inv.id, after: { number, kind, amount: round2(base + gst) }, ...meta });
  await notify([f.admin_user_id], { type: 'franchise_invoice', title: `Invoice ${number} raised`, message: `₹${round2(base + gst).toLocaleString('en-IN')} is due by ${new Date(inv.payment_due_date).toLocaleDateString('en-IN')}.` });
  await recomputeFranchisee(franchiseeId);
  return invoiceView(inv);
}

async function listInvoices({ franchiseeId = null, status = null } = {}) {
  const r = await pool.query(
    `SELECT i.*, f.org_code, f.legal_name FROM franchisee_payment_tracking i JOIN franchisees f ON f.id = i.franchisee_id
     WHERE ($1::uuid IS NULL OR i.franchisee_id = $1) AND ($2::text IS NULL OR i.payment_status = $2) ORDER BY i.invoice_date DESC LIMIT 500`,
    [franchiseeId, status]
  );
  return r.rows.map(invoiceView);
}

// The franchisee's level is the worst level among its unpaid invoices.
async function recomputeFranchisee(franchiseeId) {
  const before = await row(franchiseeId);
  const agg = (
    await pool.query(
      `SELECT COALESCE(SUM(invoice_amount + late_fee), 0) AS outstanding,
              COALESCE(MAX(CASE suspension_status WHEN 'level_3' THEN 3 WHEN 'level_2' THEN 2 WHEN 'level_1' THEN 1 ELSE 0 END), 0) AS worst
       FROM franchisee_payment_tracking WHERE franchisee_id = $1 AND payment_status IN ('pending', 'overdue')`,
      [franchiseeId]
    )
  ).rows[0];
  const level = LEVELS[Number(agg.worst)];
  await pool.query(
    `UPDATE franchisees SET total_outstanding = $2, suspension_status = $3::varchar,
            suspension_start_date = CASE WHEN $3::varchar = 'active' THEN NULL WHEN suspension_status = 'active' THEN now() ELSE suspension_start_date END WHERE id = $1`,
    [franchiseeId, agg.outstanding, level]
  );
  await refreshSuspensionCache();
  if (level !== before.suspension_status) {
    await auditService.log({ actor: null, action: 'franchise.suspension_changed', entityType: 'franchisee', entityId: franchiseeId, before: { level: before.suspension_status }, after: { level } });
    const brokers = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND r.name = ANY($2) AND u.status = 'active'`, [before.tenant_id, BROKER_ROLES])).rows.map((r) => r.id);
    if (level === 'active') {
      // Instant reinstatement: access restored, leads resume.
      await pool.query(`UPDATE leads SET can_broker_see = true WHERE franchisee_id = $1 AND reassigned_to_arb_on IS NULL`, [franchiseeId]);
      await notify([before.admin_user_id, ...brokers], { type: 'franchise_reinstated', title: 'Service restored', message: 'Payment received - full access is back and new inquiries will resume.' });
    } else {
      const text = { level_1: 'Payment overdue. Access is unchanged for now; please clear the invoice.', level_2: 'No new inquiries or matches until the overdue invoice is paid. A late fee applies.', level_3: 'Service suspended for non-payment. Open inquiries have moved to A R Buildwel representatives.' }[level];
      await notify([before.admin_user_id, ...(level === 'level_1' ? [] : brokers)], { type: 'franchise_suspension', title: `Franchise ${level.replace('_', ' ').replace('l', 'L')}`, message: text });
      await notify(await adminIds(), { type: 'franchise_suspension', title: `${before.org_code} is at ${level.replace('_', ' ')}`, message: `Outstanding ₹${Number(agg.outstanding).toLocaleString('en-IN')}.` });
    }
    if (level === 'level_3') await reassignToArb(franchiseeId, 'franchise suspended (level 3)');
  }
  return level;
}

// Level 3 / termination: every open inquiry held by the franchisee's team
// goes back into the A R Buildwel cascade.
async function reassignToArb(franchiseeId, reason) {
  const f = await row(franchiseeId);
  const leads = await pool.query(
    `UPDATE leads l SET can_broker_see = false, reassigned_to_arb_on = now(), assigned_to = NULL
     WHERE l.status::text = ANY($3) AND l.reassigned_to_arb_on IS NULL
       AND (l.franchisee_id = $1 OR l.arb_rep_id IN (SELECT id FROM users WHERE tenant_id = $2))
     RETURNING l.id`,
    [franchiseeId, f.tenant_id, OPEN_LEAD]
  );
  const assignment = require('./assignment.service');
  for (const l of leads.rows) {
    await assignment.route(l.id, { reason: 'exit' }).catch((err) => console.error('[franchise] reassign failed:', err.message));
  }
  if (leads.rows.length) await auditService.log({ actor: null, action: 'franchise.inquiries_reassigned', entityType: 'franchisee', entityId: franchiseeId, after: { count: leads.rows.length, reason } });
  return leads.rows.length;
}

async function settle(inv, { reference, gateway = null, orderId = null, paymentId = null, actor = null }, meta = {}) {
  const u = (
    await pool.query(
      `UPDATE franchisee_payment_tracking SET payment_status = 'paid', payment_received_date = now(), suspension_status = 'active', payment_reference = COALESCE($2, payment_reference),
              gateway = COALESCE($3, gateway), gateway_order_id = COALESCE($4, gateway_order_id), gateway_payment_id = $5, recorded_by = $6, ladder_step = 'paid'
       WHERE id = $1 AND payment_status IN ('pending', 'overdue') RETURNING *`,
      [inv.id, reference || null, gateway, orderId, paymentId, actor?.id || null]
    )
  ).rows[0];
  if (!u) throw badRequest('This invoice is not awaiting payment');
  await pool.query('UPDATE franchisees SET last_payment_date = now() WHERE id = $1', [inv.franchisee_id]);
  await auditService.log({ actor, action: 'franchise.invoice_paid', entityType: 'franchisee_invoice', entityId: inv.id, after: { reference: reference || paymentId, gateway }, ...meta });
  await recomputeFranchisee(inv.franchisee_id);
  return invoiceView(u);
}

async function recordPayment(admin, invoiceId, reference, meta = {}) {
  const inv = (await pool.query('SELECT * FROM franchisee_payment_tracking WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) throw notFound('Invoice not found');
  if (!reference || String(reference).trim().length < 3) throw badRequest('Enter the payment reference (UTR / cheque number)');
  return settle(inv, { reference: String(reference).trim(), actor: admin }, meta);
}

async function writeOff(admin, invoiceId, reason, meta = {}) {
  if (!reason || String(reason).trim().length < 5) throw badRequest('Give the reason for writing this invoice off');
  const u = (await pool.query(`UPDATE franchisee_payment_tracking SET payment_status = 'written_off', suspension_status = 'active', ladder_step = 'written_off' WHERE id = $1 AND payment_status IN ('pending', 'overdue') RETURNING *`, [invoiceId])).rows[0];
  if (!u) throw notFound('Invoice not found or not open');
  await auditService.log({ actor: admin, action: 'franchise.invoice_written_off', entityType: 'franchisee_invoice', entityId: invoiceId, after: { reason }, ...meta });
  await recomputeFranchisee(u.franchisee_id);
  return invoiceView(u);
}

// Franchisee side ------------------------------------------------------

async function myInvoice(user, invoiceId) {
  const f = await mine(user);
  const inv = (await pool.query('SELECT * FROM franchisee_payment_tracking WHERE id = $1 AND franchisee_id = $2', [invoiceId, f.id])).rows[0];
  if (!inv) throw notFound('Invoice not found');
  return inv;
}

async function paymentStatus(user) {
  const f = await mine(user);
  const worst = (await pool.query(`SELECT MIN(payment_due_date) AS due FROM franchisee_payment_tracking WHERE franchisee_id = $1 AND payment_status IN ('pending', 'overdue')`, [f.id])).rows[0];
  return {
    status: f.suspension_status,
    outstandingAmount: Number(f.total_outstanding),
    daysOverdue: worst.due ? Math.max(0, Math.floor((Date.now() - new Date(worst.due).getTime()) / 86400000)) : 0,
    suspensionStartDate: f.suspension_start_date,
    paymentOnline: !!razorpay(),
  };
}

// The franchisee says they have paid by bank transfer; an admin confirms it.
async function claimPayment(user, invoiceId, reference, meta = {}) {
  const inv = await myInvoice(user, invoiceId);
  if (!['pending', 'overdue'].includes(inv.payment_status)) throw badRequest('This invoice is not awaiting payment');
  if (!reference || String(reference).trim().length < 3) throw badRequest('Enter the payment reference (UTR)');
  const u = (await pool.query('UPDATE franchisee_payment_tracking SET payment_reference = $2, payment_claimed_at = now() WHERE id = $1 RETURNING *', [inv.id, String(reference).trim()])).rows[0];
  await auditService.log({ actor: user, action: 'franchise.payment_claimed', entityType: 'franchisee_invoice', entityId: inv.id, after: { reference }, ...meta });
  await notify(await adminIds(), { type: 'franchise_invoice', title: `Payment reported for ${inv.invoice_number}`, message: `Reference ${String(reference).trim()} - verify it and record the payment.` });
  return invoiceView(u);
}

const razorpay = () => (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? { keyId: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET } : null);

async function createRazorpayOrder(user, invoiceId) {
  const inv = await myInvoice(user, invoiceId);
  if (!['pending', 'overdue'].includes(inv.payment_status)) throw badRequest('This invoice is not awaiting payment');
  const rz = razorpay();
  if (!rz) throw badRequest('Online payment is not set up yet - pay by bank transfer and report the reference here');
  const amount = round2(Number(inv.invoice_amount) + Number(inv.late_fee));
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${rz.keyId}:${rz.secret}`).toString('base64')}` },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt: inv.invoice_number.slice(0, 40), notes: { invoiceId: inv.id } }),
  });
  const order = await res.json().catch(() => null);
  if (!res.ok || !order?.id) throw badRequest(`Could not start the payment${order?.error?.description ? `: ${order.error.description}` : ''}`);
  await pool.query(`UPDATE franchisee_payment_tracking SET gateway = 'razorpay', gateway_order_id = $1 WHERE id = $2`, [order.id, inv.id]);
  return { keyId: rz.keyId, orderId: order.id, amount: order.amount, currency: 'INR', invoiceNumber: inv.invoice_number };
}

// Checkout success: verify the signature, then reinstate at once.
async function verifyRazorpayPayment(user, invoiceId, { orderId, paymentId, signature }, meta = {}) {
  const inv = await myInvoice(user, invoiceId);
  const rz = razorpay();
  if (!rz) throw badRequest('Online payment is not set up');
  if (!orderId || orderId !== inv.gateway_order_id) throw badRequest('This payment does not belong to this invoice');
  const expected = crypto.createHmac('sha256', rz.secret).update(`${orderId}|${paymentId}`).digest('hex');
  const ok = expected.length === String(signature || '').length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  if (!ok) throw badRequest('Payment verification failed');
  return settle(inv, { reference: paymentId, gateway: 'razorpay', orderId, paymentId, actor: user }, meta);
}

// The automatic ladder (sec. 14.7), counted from the invoice date (Day 0).
async function sweep() {
  const s = await settings();
  const L = s.ladder;
  const open = await pool.query(
    `SELECT i.*, f.admin_user_id, f.contact_mobile, f.org_code, floor(extract(epoch FROM (now() - i.invoice_date)) / 86400)::int AS day
     FROM franchisee_payment_tracking i JOIN franchisees f ON f.id = i.franchisee_id WHERE i.payment_status IN ('pending', 'overdue')`
  );
  const touched = new Set();
  const order = ['issued', 'reminder', 'notice', 'level_1', 'level_2', 'level_3'];
  for (const i of open.rows) {
    const target = i.day >= L.level_3_day ? 'level_3' : i.day >= L.level_2_day ? 'level_2' : i.day >= L.level_1_day ? 'level_1' : i.day >= L.notice_day ? 'notice' : i.day >= L.reminder_day ? 'reminder' : 'issued';
    if (order.indexOf(target) <= order.indexOf(i.ladder_step)) continue;
    const amount = Number(i.invoice_amount);
    const lateFee = target === 'level_3' ? round2((amount * s.lateFee.level_3_percent) / 100) : target === 'level_2' ? round2((amount * s.lateFee.level_2_percent) / 100) : Number(i.late_fee);
    const level = ['level_1', 'level_2', 'level_3'].includes(target) ? target : 'active';
    await pool.query(
      `UPDATE franchisee_payment_tracking SET ladder_step = $2, suspension_status = $3::varchar, late_fee = GREATEST(late_fee, $4::numeric), last_reminder_sent = now(),
              payment_status = CASE WHEN now() > payment_due_date THEN 'overdue' ELSE payment_status END,
              suspension_start_date = CASE WHEN $3::varchar <> 'active' AND suspension_start_date IS NULL THEN now() ELSE suspension_start_date END
       WHERE id = $1`,
      [i.id, target, level, lateFee]
    );
    const message = {
      reminder: `A reminder that invoice ${i.invoice_number} (₹${amount.toLocaleString('en-IN')}) is awaiting payment.`,
      notice: `Formal notice: invoice ${i.invoice_number} is unpaid. Suspension levels begin on day ${L.level_1_day}.`,
    }[target];
    if (message) await notify([i.admin_user_id], { type: 'franchise_invoice', title: target === 'notice' ? 'Formal payment notice' : 'Payment reminder', message });
    touched.add(i.franchisee_id);
  }
  for (const id of touched) await recomputeFranchisee(id);
  await refreshCollected();
  await computeReach();
  await refreshSuspensionCache();
  return { invoices: open.rows.length, changed: touched.size };
}

// ------------------------------------------------------------------ reach

// Reach-based sizing inputs: active brokers, SLA compliance and closure rate.
async function computeReach(franchiseeId = null) {
  const fs = await pool.query(`SELECT id, tenant_id FROM franchisees WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1)`, [franchiseeId]);
  for (const f of fs.rows) {
    const m = (
      await pool.query(
        `SELECT (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $2 AND r.name = ANY($3) AND u.status = 'active')::int AS brokers,
                COUNT(*) FILTER (WHERE l.created_at > now() - interval '90 days')::int AS leads,
                COUNT(*) FILTER (WHERE l.created_at > now() - interval '90 days' AND l.first_contacted_at IS NOT NULL AND l.first_contacted_at <= l.response_sla_due_at)::int AS in_sla,
                COUNT(*) FILTER (WHERE l.created_at > now() - interval '90 days' AND l.status::text = 'won')::int AS won,
                (SELECT COALESCE(SUM(cardinality(t.pincodes)), 0) FROM franchisee_territories t WHERE t.franchisee_id = $1 AND t.status = 'active')::int AS pincodes
         FROM leads l WHERE l.franchisee_id = $1`,
        [f.id, f.tenant_id, BROKER_ROLES]
      )
    ).rows[0];
    const sla = m.leads ? Math.round((m.in_sla / m.leads) * 100) : null;
    const closure = m.leads ? Math.round((m.won / m.leads) * 100) : null;
    // Simple, explainable guide: strong reach earns wider coverage; under-servicing does not keep it.
    const perBroker = m.brokers ? m.pincodes / m.brokers : m.pincodes;
    const suggestion = m.leads < 5 ? 'Too little activity to judge yet' : sla !== null && sla < 60 ? 'Under-servicing: review the granted pincodes at renewal' : sla >= 85 && closure >= 10 && perBroker <= 3 ? 'Strong reach: can take wider coverage' : 'Coverage matches current reach';
    await pool.query('UPDATE franchisees SET reach = $2, reach_computed_at = now() WHERE id = $1', [f.id, JSON.stringify({ brokers: m.brokers, pincodes: m.pincodes, leads90d: m.leads, slaCompliancePercent: sla, closureRatePercent: closure, suggestion })]);
  }
}

// --------------------------------------------------------------- branding

const BRAND_FIELDS = ['brandName', 'logoUrl', 'faviconUrl', 'primaryColor', 'secondaryColor', 'fontFamily', 'headerText', 'footerText', 'emailFromName'];
const BRAND_COLS = { brandName: 'brand_name', logoUrl: 'logo_url', faviconUrl: 'favicon_url', primaryColor: 'primary_color', secondaryColor: 'secondary_color', fontFamily: 'font_family', headerText: 'header_text', footerText: 'footer_text', emailFromName: 'email_from_name' };
const FONTS = ['Plus Jakarta Sans', 'Inter', 'Poppins', 'Roboto', 'Lato', 'Open Sans', 'Montserrat', 'Noto Sans'];

function brandingView(b) {
  if (!b) return null;
  const live = Object.fromEntries(BRAND_FIELDS.map((k) => [k, b[BRAND_COLS[k]] || null]));
  return { ...live, brandMode: b.brand_mode, legalPages: b.legal_pages || {}, draft: b.draft || {}, publishedAt: b.published_at, domainModel: b.domain_model, host: b.host, domainActive: b.domain_active };
}

function cleanBranding(data) {
  const out = {};
  for (const k of BRAND_FIELDS) {
    if (data[k] === undefined) continue;
    const v = data[k] === null ? null : String(data[k]).trim();
    if (v && ['primaryColor', 'secondaryColor'].includes(k) && !/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest('Colours must be a hex value like #E51C23');
    if (v && ['logoUrl', 'faviconUrl'].includes(k) && !/^https:\/\/[^\s"'<>]+$/.test(v)) throw badRequest('Logo and favicon must be https links');
    if (v && k === 'fontFamily' && !FONTS.includes(v)) throw badRequest(`Choose one of: ${FONTS.join(', ')}`);
    if (v && v.length > (k === 'footerText' ? 600 : 200)) throw badRequest('That text is too long');
    out[k] = v || null;
  }
  if (data.legalPages && typeof data.legalPages === 'object') {
    out.legalPages = {};
    for (const key of ['terms', 'privacy', 'disclaimer']) {
      if (data.legalPages[key] != null) out.legalPages[key] = String(data.legalPages[key]).replace(/<[^>]*>/g, '').slice(0, 20000);
    }
  }
  return out;
}

async function myBranding(user) {
  const f = await mine(user);
  const b = (await pool.query('SELECT * FROM franchisee_branding WHERE franchisee_id = $1', [f.id])).rows[0];
  return { ...brandingView(b), fonts: FONTS, orgCode: f.org_code };
}

// Self-service: the franchisee edits a draft, previews it, then publishes.
async function saveBrandingDraft(user, data, meta = {}) {
  const f = await mine(user);
  const draft = cleanBranding(data);
  await pool.query(`UPDATE franchisee_branding SET draft = $2, updated_at = now() WHERE franchisee_id = $1`, [f.id, JSON.stringify(draft)]);
  await auditService.log({ actor: user, action: 'franchise.branding_draft_saved', entityType: 'franchisee', entityId: f.id, ...meta });
  return myBranding(user);
}

async function publishBranding(user, meta = {}) {
  const f = await mine(user);
  const b = (await pool.query('SELECT * FROM franchisee_branding WHERE franchisee_id = $1', [f.id])).rows[0];
  const d = b.draft || {};
  if (!Object.keys(d).length) throw badRequest('There is no saved draft to publish');
  const val = (k) => (d[k] !== undefined ? d[k] : b[BRAND_COLS[k]]);
  await pool.query(
    `UPDATE franchisee_branding SET brand_name = $2, logo_url = $3, favicon_url = $4, primary_color = $5, secondary_color = $6, font_family = $7, header_text = $8, footer_text = $9, email_from_name = $10,
            legal_pages = $11, draft = '{}'::jsonb, published_at = now(), updated_at = now() WHERE franchisee_id = $1`,
    [f.id, ...BRAND_FIELDS.map(val), JSON.stringify({ ...(b.legal_pages || {}), ...(d.legalPages || {}) })]
  );
  await auditService.log({ actor: user, action: 'franchise.branding_published', entityType: 'franchisee', entityId: f.id, ...meta });
  return myBranding(user);
}

// Domains are created and held by A R Buildwel only (sec. 14.8).
async function setDomain(admin, franchiseeId, { domainModel, host, domainActive, brandMode }, meta = {}) {
  await row(franchiseeId);
  const s = await settings();
  const cleanHost = host ? String(host).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
  if (cleanHost) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cleanHost)) throw badRequest('Enter a valid host name, e.g. propertyindia.propertyserch.com');
    if (!['subdomain', 'own_domain'].includes(domainModel)) throw badRequest('Choose the domain model');
    const underRoot = s.roots.some((r) => cleanHost.endsWith(`.${r}`));
    if (domainModel === 'subdomain' && !underRoot) throw badRequest(`A subdomain must sit under an A R Buildwel domain (${s.roots.join(', ')})`);
    if (domainModel === 'own_domain' && (underRoot || s.roots.includes(cleanHost))) throw badRequest('That host is an A R Buildwel subdomain - choose the subdomain model');
    if ((await pool.query('SELECT 1 FROM franchisee_branding WHERE host = $1 AND franchisee_id <> $2', [cleanHost, franchiseeId])).rows.length) throw badRequest('That host is already mapped to another franchisee');
  }
  if (brandMode && !['arb_representative', 'white_label'].includes(brandMode)) throw badRequest('Unknown brand mode');
  await pool.query(
    `UPDATE franchisee_branding SET domain_model = $2, host = $3, domain_active = $4, brand_mode = COALESCE($5, brand_mode), updated_at = now() WHERE franchisee_id = $1`,
    [franchiseeId, cleanHost ? domainModel : null, cleanHost, !!cleanHost && domainActive === true, brandMode || null]
  );
  await auditService.log({ actor: admin, action: 'franchise.domain_set', entityType: 'franchisee', entityId: franchiseeId, after: { host: cleanHost, domainModel, domainActive: !!domainActive, brandMode }, ...meta });
  return get(franchiseeId);
}

// Public: what a browser needs to brand the page for the host it opened.
// Never the registered firm name's tax details, never an id.
async function brandingForHost(host, { preview = null, user = null } = {}) {
  let b = null;
  let draft = false;
  if (preview && user?.role === 'franchisee_admin') {
    const f = await mine(user);
    b = (await pool.query(`SELECT b.*, f.legal_name FROM franchisee_branding b JOIN franchisees f ON f.id = b.franchisee_id WHERE f.id = $1`, [f.id])).rows[0];
    draft = true;
  } else {
    const h = String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
    if (!h) return null;
    b = (await pool.query(`SELECT b.*, f.legal_name FROM franchisee_branding b JOIN franchisees f ON f.id = b.franchisee_id WHERE b.host = $1 AND b.domain_active AND f.status = 'active'`, [h])).rows[0];
  }
  if (!b) return null;
  const v = (k) => (draft && b.draft?.[k] !== undefined ? b.draft[k] : b[BRAND_COLS[k]]) || null;
  if (b.brand_mode !== 'white_label') {
    // Phase 1 public identity: presents as A R Buildwel; the firm's own name small, subordinate.
    return { brandMode: 'arb_representative', partnerName: v('brandName') || b.legal_name };
  }
  return {
    brandMode: 'white_label', brandName: v('brandName'), logoUrl: v('logoUrl'), faviconUrl: v('faviconUrl'), primaryColor: v('primaryColor'), secondaryColor: v('secondaryColor'),
    fontFamily: v('fontFamily'), headerText: v('headerText'), footerText: v('footerText'), legalPages: { ...(b.legal_pages || {}), ...(draft ? b.draft?.legalPages || {} : {}) },
  };
}

// ------------------------------------------------- franchisee: dashboard

// Numbers only (sec. 14.9): counts and sums, never a lead, a name or a contact.
async function dashboard(user) {
  let f = await mine(user);
  if (!f.reach_computed_at) {
    await computeReach(f.id);
    f = await mine(user);
  }
  const scope = `(l.franchisee_id = $1 OR l.tenant_id = $2)`;
  const [leads, stages, top, revenue, invoices, demand, kyc, tickets, territories] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE l.created_at >= date_trunc('month', now()))::int AS this_month, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE l.status::text = 'won')::int AS converted FROM leads l WHERE ${scope}`,
      [f.id, f.tenant_id]
    ),
    pool.query(`SELECT d.stage::text AS stage, COUNT(*)::int AS n FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.franchisee_id = $1 OR d.tenant_id = $2 OR l.franchisee_id = $1 GROUP BY d.stage ORDER BY n DESC`, [f.id, f.tenant_id]),
    pool.query(
      `SELECT u.full_name AS name, COUNT(d.id) FILTER (WHERE d.stage::text = 'closed_won')::int AS deals_closed
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN deals d ON d.broker_id = u.id
       WHERE u.tenant_id = $1 AND r.name = ANY($2) GROUP BY u.id ORDER BY deals_closed DESC, u.full_name LIMIT 5`,
      [f.tenant_id, BROKER_ROLES]
    ),
    pool.query(
      `SELECT COALESCE(SUM(franchisee_base), 0) AS earned, COALESCE(SUM(franchisee_base) FILTER (WHERE status = 'released'), 0) AS released,
              COALESCE(SUM(franchisee_base) FILTER (WHERE status <> 'released'), 0) AS pending, COALESCE(SUM(deal_value), 0) AS deal_volume, COUNT(*)::int AS deals
       FROM franchisee_commissions WHERE franchisee_id = $1`,
      [f.id]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE payment_status IN ('pending', 'overdue'))::int AS open, COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid, COUNT(*)::int AS total
       FROM franchisee_payment_tracking WHERE franchisee_id = $1`,
      [f.id]
    ),
    pool.query(
      `SELECT loc AS area, COUNT(*)::int AS requirements FROM requirements rq, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(rq.localities) = 'array' THEN rq.localities ELSE '[]'::jsonb END) loc
       WHERE rq.pincode = ANY(SELECT unnest(t.pincodes) FROM franchisee_territories t WHERE t.franchisee_id = $1 AND t.status = 'active')
          OR lower(loc) IN (SELECT lower(lc.locality_name) FROM localities lc WHERE lc.pincode = ANY(SELECT unnest(t.pincodes) FROM franchisee_territories t WHERE t.franchisee_id = $1 AND t.status = 'active'))
       GROUP BY loc ORDER BY requirements DESC LIMIT 8`,
      [f.id]
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM user_verifications v JOIN users u ON u.id = v.user_id WHERE u.tenant_id = $1 AND v.status = 'pending'`, [f.tenant_id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM franchisee_tickets WHERE franchisee_id = $1 AND status IN ('open', 'in_progress')`, [f.id]),
    pool.query(`SELECT * FROM franchisee_territories WHERE franchisee_id = $1 AND status = 'active' ORDER BY granted_on`, [f.id]),
  ]);
  const L = leads.rows[0];
  const inv = invoices.rows[0];
  return {
    franchise: { orgCode: f.org_code, orgSerial: f.org_serial, legalName: f.legal_name, status: f.status, brandingCompliant: f.branding_compliant },
    suspension: { status: f.suspension_status, outstandingAmount: Number(f.total_outstanding), since: f.suspension_start_date },
    leads: { thisMonth: L.this_month, total: L.total, converted: L.converted, conversionRatePercent: L.total ? Math.round((L.converted / L.total) * 1000) / 10 : 0 },
    pipeline: stages.rows,
    topBrokers: top.rows,
    revenue: { commissionEarned: Number(revenue.rows[0].earned), released: Number(revenue.rows[0].released), pending: Number(revenue.rows[0].pending), dealVolume: Number(revenue.rows[0].deal_volume), deals: revenue.rows[0].deals },
    invoices: { open: inv.open, paid: inv.paid, collectionRatePercent: inv.total ? Math.round((inv.paid / inv.total) * 100) : null },
    areaDemand: demand.rows,
    kycQueue: kyc.rows[0].n,
    openTickets: tickets.rows[0].n,
    territories: territories.rows.map(territoryView),
    reach: f.reach || {},
  };
}

// ---------------------------------------------- franchisee: broker network

// Own brokers with performance summaries - counts and a score, no lead data.
async function myBrokers(user) {
  const f = await mine(user);
  const r = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.status, u.created_at, u.last_login_at, r.name AS role, ts.score AS trust_score,
            (SELECT COUNT(*) FROM leads l WHERE (l.assigned_to = u.id OR l.arb_rep_id = u.id))::int AS leads,
            (SELECT COUNT(*) FROM leads l WHERE (l.assigned_to = u.id OR l.arb_rep_id = u.id) AND l.first_contacted_at IS NOT NULL AND l.first_contacted_at <= l.response_sla_due_at)::int AS in_sla,
            (SELECT COUNT(*) FROM deals d WHERE d.broker_id = u.id AND d.stage::text = 'closed_won')::int AS deals_closed,
            (SELECT COUNT(*) FROM properties p WHERE p.created_by = u.id AND p.status::text = 'approved')::int AS live_listings,
            (SELECT COUNT(*) FROM user_verifications v WHERE v.user_id = u.id AND v.status = 'verified')::int AS verifications
     FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN trust_scores ts ON ts.user_id = u.id
     WHERE u.tenant_id = $1 AND r.name = ANY($2) ORDER BY u.created_at DESC`,
    [f.tenant_id, BROKER_ROLES]
  );
  return r.rows.map((b) => {
    const sla = b.leads ? Math.round((b.in_sla / b.leads) * 100) : null;
    // Activity score: closed deals, live listings, response discipline and verification.
    const activity = Math.min(100, b.deals_closed * 15 + Math.min(b.live_listings, 10) * 3 + (sla ?? 50) * 0.4 + Math.min(b.verifications, 3) * 5);
    return { id: b.id, name: b.full_name, email: b.email, role: b.role, status: b.status, joinedAt: b.created_at, lastLoginAt: b.last_login_at, trustScore: b.trust_score, leadsHandled: b.leads, slaCompliancePercent: sla, dealsClosed: b.deals_closed, liveListings: b.live_listings, activityScore: Math.round(activity) };
  });
}

async function addBroker(user, data, meta = {}) {
  const f = await mine(user);
  if (f.status !== 'active') throw badRequest('This franchise is not active');
  const email = String(data.email || '').trim().toLowerCase();
  const name = String(data.fullName || '').trim();
  if (name.length < 2) throw badRequest("The broker's name is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('A valid email is required');
  if (!data.password || String(data.password).length < 8) throw badRequest('Set an initial password of at least 8 characters');
  if ((await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rows.length) throw badRequest('An account with this email already exists');
  const mobile = data.mobile ? String(data.mobile).replace(/\D/g, '').slice(-10) : null;
  if (mobile && (await pool.query('SELECT 1 FROM users WHERE mobile = $1', [mobile])).rows.length) throw badRequest('An account with this mobile number already exists');
  const role = (await pool.query(`SELECT id FROM roles WHERE name = 'broker'`)).rows[0];
  const u = (
    await pool.query(
      `INSERT INTO users (tenant_id, role_id, full_name, email, mobile, password_hash, status, email_verified, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'active', true, $7) RETURNING id`,
      [f.tenant_id, role.id, name, email, mobile, await bcrypt.hash(String(data.password), 10), user.id]
    )
  ).rows[0];
  await auditService.log({ actor: user, action: 'franchise.broker_added', entityType: 'user', entityId: u.id, after: { email, franchisee: f.org_code }, ...meta });
  return { id: u.id };
}

async function ownBroker(f, brokerId) {
  const u = (await pool.query(`SELECT u.id, u.status FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.tenant_id = $2 AND r.name = ANY($3)`, [brokerId, f.tenant_id, BROKER_ROLES])).rows[0];
  if (!u) throw notFound('Broker not found in your organisation');
  return u;
}

async function setBrokerStatus(user, brokerId, status, meta = {}) {
  const f = await mine(user);
  if (!['active', 'inactive'].includes(status)) throw badRequest('status must be active or inactive');
  const b = await ownBroker(f, brokerId);
  await pool.query(`UPDATE users SET status = $2::user_status WHERE id = $1`, [b.id, status]);
  await auditService.log({ actor: user, action: 'franchise.broker_status', entityType: 'user', entityId: b.id, before: { status: b.status }, after: { status }, ...meta });
  // An inactive broker's open inquiries move on through the cascade.
  if (status === 'inactive') {
    const assignment = require('./assignment.service');
    const open = await pool.query(`SELECT id FROM leads WHERE arb_rep_id = $1 AND status::text = ANY($2)`, [b.id, OPEN_LEAD]);
    for (const l of open.rows) await assignment.route(l.id, { reason: 'exit' }).catch(() => {});
  }
  return { id: b.id, status };
}

// KYC approvals for the franchisee's own brokers.
async function kycQueue(user) {
  const f = await mine(user);
  const r = await pool.query(
    `SELECT v.id, v.kind, v.status, v.created_at, u.full_name, right(COALESCE(v.reference, ''), 4) AS reference_last4, (v.document_path IS NOT NULL) AS has_document
     FROM user_verifications v JOIN users u ON u.id = v.user_id WHERE u.tenant_id = $1 AND v.status = 'pending' ORDER BY v.created_at`,
    [f.tenant_id]
  );
  return r.rows.map((v) => ({ id: v.id, kind: v.kind, status: v.status, brokerName: v.full_name, referenceLast4: v.reference_last4 || null, hasDocument: v.has_document, submittedAt: v.created_at }));
}

async function decideKyc(user, verificationId, action, notes, meta = {}) {
  const f = await mine(user);
  const v = (await pool.query(`SELECT v.id FROM user_verifications v JOIN users u ON u.id = v.user_id WHERE v.id = $1 AND u.tenant_id = $2`, [verificationId, f.tenant_id])).rows[0];
  if (!v) throw notFound('Verification not found in your organisation');
  return require('./review.service').decideVerification(user, verificationId, action, notes, meta);
}

// ---------------------------------------------------------------- tickets

const ticketView = (t) => ({ id: t.id, ticketNumber: t.ticket_number, category: t.category, subject: t.subject, status: t.status, createdAt: t.created_at, updatedAt: t.updated_at, orgCode: t.org_code, legalName: t.legal_name, messages: t.messages });

async function listTickets({ user = null, status = null } = {}) {
  const f = user?.role === 'franchisee_admin' ? await mine(user) : null;
  const r = await pool.query(
    `SELECT t.*, fr.org_code, fr.legal_name FROM franchisee_tickets t JOIN franchisees fr ON fr.id = t.franchisee_id
     WHERE ($1::uuid IS NULL OR t.franchisee_id = $1) AND ($2::text IS NULL OR t.status = $2) ORDER BY t.updated_at DESC LIMIT 300`,
    [f?.id || null, status]
  );
  return r.rows.map(ticketView);
}

async function ticketFor(user, id) {
  const t = (await pool.query(`SELECT t.*, fr.org_code, fr.legal_name, fr.admin_user_id FROM franchisee_tickets t JOIN franchisees fr ON fr.id = t.franchisee_id WHERE t.id = $1`, [id])).rows[0];
  if (!t) throw notFound('Ticket not found');
  if (user.role === 'franchisee_admin') {
    const f = await mine(user);
    if (t.franchisee_id !== f.id) throw notFound('Ticket not found');
  } else if (!ADMIN.includes(user.role)) throw forbidden('Not allowed');
  return t;
}

async function getTicket(user, id) {
  const t = await ticketFor(user, id);
  const m = await pool.query(`SELECT m.id, m.body, m.from_staff, m.created_at, u.full_name FROM franchisee_ticket_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.ticket_id = $1 ORDER BY m.created_at`, [id]);
  return ticketView({ ...t, messages: m.rows.map((x) => ({ id: x.id, body: x.body, fromStaff: x.from_staff, author: x.from_staff ? 'A R Buildwel support' : x.full_name, createdAt: x.created_at })) });
}

async function openTicket(user, { subject, category = 'general', body }, meta = {}) {
  const f = await mine(user);
  if (!subject || String(subject).trim().length < 3) throw badRequest('Add a subject');
  if (!body || String(body).trim().length < 5) throw badRequest('Describe the issue');
  if (!['general', 'billing', 'territory', 'branding', 'brokers', 'technical'].includes(category)) throw badRequest('Unknown category');
  const n = (await pool.query(`SELECT nextval('franchisee_ticket_seq') AS n`)).rows[0].n;
  const t = (await pool.query(`INSERT INTO franchisee_tickets (ticket_number, franchisee_id, raised_by, category, subject) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [`FT-${String(n).padStart(5, '0')}`, f.id, user.id, category, String(subject).trim()])).rows[0];
  await pool.query(`INSERT INTO franchisee_ticket_messages (ticket_id, author_id, from_staff, body) VALUES ($1, $2, false, $3)`, [t.id, user.id, String(body).trim()]);
  await auditService.log({ actor: user, action: 'franchise.ticket_opened', entityType: 'franchisee_ticket', entityId: t.id, ...meta });
  await notify(await adminIds(), { type: 'franchise_ticket', title: `Support ticket from ${f.org_code}`, message: String(subject).trim() });
  return getTicket(user, t.id);
}

async function replyTicket(user, id, { body, status = null }, meta = {}) {
  const t = await ticketFor(user, id);
  const staff = ADMIN.includes(user.role);
  if (body && String(body).trim().length >= 2) {
    await pool.query(`INSERT INTO franchisee_ticket_messages (ticket_id, author_id, from_staff, body) VALUES ($1, $2, $3, $4)`, [id, user.id, staff, String(body).trim()]);
  } else if (!status) throw badRequest('Write a reply');
  let next = t.status;
  if (status) {
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) throw badRequest('Unknown status');
    if (!staff && !['closed', 'open'].includes(status)) throw forbidden('Only A R Buildwel support can set that status');
    next = status;
  } else if (staff && t.status === 'open') next = 'in_progress';
  else if (!staff && ['resolved', 'closed'].includes(t.status)) next = 'open';
  await pool.query('UPDATE franchisee_tickets SET status = $2, updated_at = now() WHERE id = $1', [id, next]);
  await auditService.log({ actor: user, action: 'franchise.ticket_reply', entityType: 'franchisee_ticket', entityId: id, after: { status: next }, ...meta });
  if (staff) await notify([t.admin_user_id], { type: 'franchise_ticket', title: `Reply on ticket ${t.ticket_number}`, message: t.subject });
  else await notify(await adminIds(), { type: 'franchise_ticket', title: `Franchisee replied on ${t.ticket_number}`, message: t.subject });
  return getTicket(user, id);
}

// -------------------------------------------------------------- scheduler

function startScheduler() {
  refreshSuspensionCache().catch(() => {});
  const run = () => sweep().catch((err) => console.error('[franchise] sweep failed:', err.message));
  setTimeout(run, 45000);
  setInterval(run, 60 * 60 * 1000);
}

module.exports = {
  settings, mine, pincodeFor, territoriesFor, pickFor, safeCheckListing, checkListing, refreshSuspensionCache,
  list, get, create, update,
  listTerritories, saveTerritory, grantReserved, withdrawTerritory, listConflicts, resolveConflict,
  calculateForDeal, safeCalculate, listCommissions, releaseCommission, deleteCommission, refreshCollected,
  raiseInvoice, listInvoices, recordPayment, writeOff, paymentStatus, claimPayment, createRazorpayOrder, verifyRazorpayPayment, recomputeFranchisee, sweep, computeReach,
  myBranding, saveBrandingDraft, publishBranding, setDomain, brandingForHost,
  dashboard, myBrokers, addBroker, setBrokerStatus, kycQueue, decideKyc,
  listTickets, getTicket, openTicket, replyTicket,
  startScheduler,
};
