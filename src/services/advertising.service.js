const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { findViolations } = require('../utils/contentGuard');
const { getReadUrl, uploadBuffer } = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 17 - Advertiser & Monetization. A 100% native model: no third-party
// ad networks; only real-estate-ecosystem businesses advertise.
//
//   Onboarding   no self-signup. An "Advertise With Us" lead (or an outbound
//                prospect) is approved by an admin for eligibility; only then
//                is an AV code issued and an Advertiser Portal login created.
//   Rate card    ad_rate_config - 9 formats + 2 packages, admin-editable,
//                optional per-city override. All rates exclude GST.
//   Campaign     advertiser picks a format, creative, targeting and dates ->
//                invoice (GST 18%) -> payment (Razorpay, or recorded by
//                staff) -> admin review (prohibited claims, brand spelling,
//                RERA number for builder ads, exclusive-slot clash) ->
//                approved campaigns serve between their dates.
//   Serving      /ads/serve picks eligible campaigns for a placement by
//                targeting (city, locality, role, property type, budget,
//                device), drops any the viewer has already seen N times
//                today (frequency cap) and rotates fairly. Impressions and
//                clicks are logged with a hashed user id.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const isStaff = (u) => !!u && STAFF.includes(u.role);
const isAdmin = (u) => !!u && ADMIN.includes(u.role);

// How many ads a placement shows at once.
const SLOT_SIZE = { home_hero: 1, home_sidebar: 2, search_sponsored: 3, city_banner: 1, crm_dashboard: 1, digest_sponsored: 1, featured_listing: 1, institutional_featured: 1, login_splash: 1 };
const PLACEMENTS = Object.keys(SLOT_SIZE);
// Placements that promote a listing rather than a banner creative.
const LISTING_PLACEMENTS = ['search_sponsored', 'featured_listing', 'institutional_featured'];
const ROLES = ['buyer', 'broker', 'seller', 'nri', 'hni', 'all'];
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

function fy(date = new Date()) {
  const y = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

async function cfg() {
  const [enabled, cap, gst, gstin, phrases, reraCats, renewDays, sends] = await Promise.all([
    configService.getConfig('ads.enabled', true),
    configService.getConfig('ads.frequency_cap_per_day', 3),
    configService.getConfig('ads.gst_percent', 18),
    configService.getConfig('ads.gstin', '07DERPR1574G2ZY'),
    configService.getConfig('ads.prohibited_phrases', []),
    configService.getConfig('ads.rera_required_categories', ['builder_developer']),
    configService.getConfig('ads.renewal_alert_days', 7),
    configService.getConfig('ads.package_send_allowance', 30),
  ]);
  return { enabled: enabled !== false, cap: Number(cap) || 3, gst: Number(gst) || 18, gstin, phrases: phrases || [], reraCats: reraCats || [], renewDays: Number(renewDays) || 7, packageSends: Number(sends) || 30 };
}

// ------------------------------------------------------------ advertisers

const advView = (a) => ({
  id: a.id, avCode: a.av_code, userId: a.user_id, businessName: a.business_name, businessCategory: a.business_category, contactName: a.contact_name, contactEmail: a.contact_email,
  contactMobile: a.contact_mobile, gstin: a.gstin, billingAddress: a.billing_address, reraNumber: a.rera_number, source: a.source, status: a.status, approvedAt: a.approved_at, notes: a.notes,
});

async function eligibleCategories() {
  return configService.getConfig('bd_leads.advertiser_eligible_categories', []);
}

// Eligibility approval: creates the advertiser (AV code) and its portal login.
async function approveAdvertiser(admin, data, meta = {}) {
  if (!isAdmin(admin)) throw forbidden('Only an admin can approve an advertiser');
  let lead = null;
  if (data.bdLeadId) {
    lead = (await pool.query(`SELECT * FROM bd_leads WHERE id = $1 AND category = 'advertiser'`, [data.bdLeadId])).rows[0];
    if (!lead) throw notFound('Advertiser enquiry not found');
    if ((await pool.query('SELECT 1 FROM advertisers WHERE bd_lead_id = $1', [lead.id])).rows.length) throw badRequest('This enquiry has already been approved');
  }
  const businessName = String(data.businessName || lead?.business_name || '').trim();
  const category = data.businessCategory || lead?.business_category;
  const email = String(data.loginEmail || lead?.email || '').trim().toLowerCase();
  if (!businessName) throw badRequest('Business name is required');
  // Eligibility is enforced here, not self-certified.
  const eligible = await eligibleCategories();
  if (!eligible.includes(category)) throw badRequest('Advertising is limited to businesses in the real-estate ecosystem - choose an eligible category');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('A login email is required for the Advertiser Portal');
  if (!data.password || String(data.password).length < 8) throw badRequest('Set an initial portal password of at least 8 characters');
  if ((await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rows.length) throw badRequest('An account with this email already exists');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = (await client.query(`SELECT id FROM roles WHERE name = 'advertiser'`)).rows[0];
    const user = (
      await client.query(
        `INSERT INTO users (role_id, full_name, email, mobile, password_hash, status, email_verified, created_by)
         VALUES ($1, $2, $3, $4, $5, 'active', true, $6) RETURNING id`,
        [role.id, data.contactName || lead?.full_name || businessName, email, data.contactMobile || lead?.mobile || null, await bcrypt.hash(String(data.password), 10), admin.id]
      )
    ).rows[0];
    const n = (await client.query(`SELECT nextval('advertiser_code_seq') AS n`)).rows[0].n;
    const adv = (
      await client.query(
        `INSERT INTO advertisers (av_code, user_id, business_name, business_category, contact_name, contact_email, contact_mobile, gstin, billing_address, rera_number, bd_lead_id, source, approved_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [`AV-${String(n).padStart(4, '0')}`, user.id, businessName, category, data.contactName || lead?.full_name || null, email, data.contactMobile || lead?.mobile || null,
          data.gstin || null, data.billingAddress || null, data.reraNumber || null, lead?.id || null, lead ? 'inbound' : 'outbound', admin.id, data.notes || null]
      )
    ).rows[0];
    if (lead) await client.query(`UPDATE bd_leads SET status = 'converted' WHERE id = $1`, [lead.id]);
    await client.query('COMMIT');
    await auditService.log({ actor: admin, action: 'advertiser.approved', entityType: 'advertiser', entityId: adv.id, after: { avCode: adv.av_code, businessName, category, source: adv.source }, ...meta });
    await notificationService.createNotification({ userId: user.id, type: 'advertising', title: `Welcome - your advertiser code is ${adv.av_code}`, message: 'Your Advertiser Portal is ready. Create your first campaign.', relatedEntityType: 'advertiser', relatedEntityId: adv.id });
    return advView(adv);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listAdvertisers() {
  const r = await pool.query(
    `SELECT a.*, (SELECT COUNT(*)::int FROM ad_campaigns c WHERE c.advertiser_id = a.id) AS campaigns,
            (SELECT COUNT(*)::int FROM ad_campaigns c WHERE c.advertiser_id = a.id AND c.status = 'approved' AND CURRENT_DATE BETWEEN c.start_date AND c.end_date) AS live,
            (SELECT COALESCE(SUM(i.amount), 0)::float FROM ad_invoices i WHERE i.advertiser_id = a.id AND i.status = 'paid') AS spend
     FROM advertisers a ORDER BY a.created_at DESC LIMIT 500`
  );
  return r.rows.map((a) => ({ ...advView(a), campaigns: a.campaigns, liveCampaigns: a.live, totalSpend: a.spend }));
}

async function updateAdvertiser(admin, id, data, meta = {}) {
  if (!isAdmin(admin)) throw forbidden('Admins only');
  const map = { status: 'status', gstin: 'gstin', billingAddress: 'billing_address', reraNumber: 'rera_number', notes: 'notes', contactName: 'contact_name', contactMobile: 'contact_mobile' };
  const cols = Object.entries(map).filter(([k]) => data[k] !== undefined);
  if (!cols.length) throw badRequest('Nothing to update');
  if (data.status && !['active', 'suspended'].includes(data.status)) throw badRequest('status must be active or suspended');
  const r = await pool.query(`UPDATE advertisers SET ${cols.map(([, c], i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} RETURNING *`, [...cols.map(([k]) => data[k] || null), id]);
  if (!r.rows[0]) throw notFound('Advertiser not found');
  await auditService.log({ actor: admin, action: 'advertiser.updated', entityType: 'advertiser', entityId: id, after: data, ...meta });
  return advView(r.rows[0]);
}

async function advertiserFor(user) {
  const a = (await pool.query('SELECT * FROM advertisers WHERE user_id = $1', [user.id])).rows[0];
  if (!a) throw forbidden('No advertiser account is linked to this login');
  if (a.status !== 'active') throw forbidden('This advertiser account is suspended');
  return a;
}

// The advertiser a request acts for: their own, or (staff) the one named.
async function actingAdvertiser(user, advertiserId) {
  if (isStaff(user)) {
    const a = (await pool.query('SELECT * FROM advertisers WHERE id = $1', [advertiserId])).rows[0];
    if (!a) throw badRequest('Choose the advertiser');
    return a;
  }
  return advertiserFor(user);
}

// ------------------------------------------------------------ rate card

const rateView = (r) => ({ id: r.id, formatKey: r.format_key, label: r.label, description: r.description, pricingUnit: r.pricing_unit, rate: Number(r.rate), minUnits: r.min_units, placements: r.placements, maxConcurrent: r.max_concurrent, city: r.city, isActive: r.is_active });

async function rateCard({ includeInactive = false, withRates = true } = {}) {
  const r = await pool.query(`SELECT * FROM ad_rate_config ${includeInactive ? '' : 'WHERE is_active'} ORDER BY sort_order, city NULLS FIRST`);
  const c = await cfg();
  return { gstPercent: c.gst, note: `All rates are exclusive of GST at ${c.gst}%.`, items: r.rows.map(rateView).map((x) => (withRates ? x : { ...x, rate: undefined })) };
}

// The rate that applies to a format in a city (city override first).
async function rateFor(formatKey, city) {
  const r = await pool.query(
    `SELECT * FROM ad_rate_config WHERE format_key = $1 AND is_active AND (city IS NULL OR lower(city) = lower($2)) ORDER BY (city IS NOT NULL) DESC LIMIT 1`,
    [formatKey, city || '']
  );
  if (!r.rows[0]) throw badRequest('This ad format is not available');
  return r.rows[0];
}

async function saveRate(admin, data, meta = {}) {
  if (!isAdmin(admin)) throw forbidden('Admins only');
  const rate = Number(data.rate);
  if (!(rate >= 0)) throw badRequest('Rate must be zero or more');
  if (data.id) {
    const r = await pool.query(
      `UPDATE ad_rate_config SET rate = $1, min_units = COALESCE($2, min_units), is_active = COALESCE($3, is_active), max_concurrent = $4, updated_by = $5, updated_at = now() WHERE id = $6 RETURNING *`,
      [rate, data.minUnits ? Number(data.minUnits) : null, data.isActive === undefined ? null : !!data.isActive, data.maxConcurrent === undefined || data.maxConcurrent === '' || data.maxConcurrent === null ? null : Number(data.maxConcurrent), admin.id, data.id]
    );
    if (!r.rows[0]) throw notFound('Rate not found');
    await auditService.log({ actor: admin, action: 'ads.rate_updated', entityType: 'ad_rate', entityId: data.id, after: { rate, minUnits: data.minUnits, isActive: data.isActive }, ...meta });
    return rateView(r.rows[0]);
  }
  // A city override of an existing format.
  if (!data.formatKey || !data.city) throw badRequest('Give the format and the city for a city rate');
  const base = (await pool.query('SELECT * FROM ad_rate_config WHERE format_key = $1 AND city IS NULL', [data.formatKey])).rows[0];
  if (!base) throw badRequest('Unknown format');
  const r = await pool.query(
    `INSERT INTO ad_rate_config (format_key, label, description, pricing_unit, rate, min_units, placements, max_concurrent, city, sort_order, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (format_key, COALESCE(lower(city), '')) DO UPDATE SET rate = EXCLUDED.rate, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
    [base.format_key, base.label, base.description, base.pricing_unit, rate, base.min_units, JSON.stringify(base.placements), base.max_concurrent, String(data.city).trim(), base.sort_order, admin.id]
  );
  await auditService.log({ actor: admin, action: 'ads.city_rate_set', entityType: 'ad_rate', entityId: r.rows[0].id, after: { formatKey: data.formatKey, city: data.city, rate }, ...meta });
  return rateView(r.rows[0]);
}

function endDateFor(startDate, units, unit) {
  const d = new Date(`${startDate}T00:00:00Z`);
  if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * units - 1);
  else if (unit === 'month') {
    d.setUTCMonth(d.getUTCMonth() + units);
    d.setUTCDate(d.getUTCDate() - 1);
  } else d.setUTCDate(d.getUTCDate() + 89); // sends: a 90-day window to use them
  return d.toISOString().slice(0, 10);
}

async function quote({ formatKey, units, startDate, city }) {
  const rate = await rateFor(formatKey, city);
  const u = Math.max(Number(units) || rate.min_units, 1);
  if (u < rate.min_units) throw badRequest(`Minimum booking is ${rate.min_units} ${rate.pricing_unit}${rate.min_units === 1 ? '' : 's'}`);
  const c = await cfg();
  const amount = r2(Number(rate.rate) * u);
  const gst = r2((amount * c.gst) / 100);
  const start = startDate || today();
  return { formatKey, label: rate.label, pricingUnit: rate.pricing_unit, rate: Number(rate.rate), units: u, minUnits: rate.min_units, placements: rate.placements, amount, gstPercent: c.gst, gstAmount: gst, total: r2(amount + gst), startDate: start, endDate: endDateFor(start, u, rate.pricing_unit), rateCity: rate.city };
}

// ------------------------------------------------------------ campaigns

function cleanTargeting(t = {}) {
  const list = (v, max = 30) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
  const roles = list(t.roles).map((r) => r.toLowerCase()).filter((r) => ROLES.includes(r));
  const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    cities: list(t.cities), localities: list(t.localities), roles: roles.includes('all') ? [] : roles, propertyTypes: list(t.propertyTypes).map((x) => x.toLowerCase()),
    budgetMin: n(t.budgetMin), budgetMax: n(t.budgetMax), device: ['mobile', 'desktop'].includes(t.device) ? t.device : 'all',
  };
}

const safeUrl = (u) => {
  if (!u) return null;
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' ? x.toString() : null;
  } catch {
    return null;
  }
};

// Automated part of the campaign approval: what the reviewer should see.
async function reviewFlags(campaign, advertiser) {
  const c = await cfg();
  const flags = [];
  const texts = [campaign.headline, campaign.body, campaign.cta_label, campaign.variant_b?.headline, campaign.variant_b?.body].filter(Boolean).join(' \n ');
  const lower = texts.toLowerCase();
  for (const p of c.phrases) if (lower.includes(String(p).toLowerCase())) flags.push({ severity: 'block', rule: 'prohibited_claim', detail: `Prohibited claim: "${p}"` });
  // Brand spelling and the platform's forbidden terms.
  for (const v of await findViolations({ creative: texts })) flags.push({ severity: 'block', rule: v.rule, detail: `${v.rule === 'brand_spelling' ? 'Brand spelling' : 'Forbidden term'}: "${v.match}"${v.suggestion ? ` - ${v.suggestion}` : ''}` });
  if (/\b(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/.test(texts)) flags.push({ severity: 'warn', rule: 'phone_in_creative', detail: 'A phone number appears in the creative - enquiries should come through the click-through link' });
  if (c.reraCats.includes(advertiser.business_category) && !(campaign.rera_number || advertiser.rera_number)) flags.push({ severity: 'block', rule: 'rera_missing', detail: 'Builder ads must show a RERA number - add it to the campaign or the advertiser' });
  // Exclusive slots: no other approved campaign in the same placement over the same dates.
  const rate = (await pool.query(`SELECT max_concurrent FROM ad_rate_config WHERE format_key = $1 AND city IS NULL`, [campaign.format_key])).rows[0];
  if (rate?.max_concurrent) {
    const clash = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ad_campaigns WHERE id <> $1 AND status IN ('approved', 'paused') AND placements ?| $2::text[] AND start_date <= $4 AND end_date >= $3 AND format_key = $5`,
      [campaign.id, campaign.placements, campaign.start_date, campaign.end_date, campaign.format_key]
    );
    if (clash.rows[0].n >= rate.max_concurrent) flags.push({ severity: 'block', rule: 'slot_taken', detail: `This slot is exclusive and already booked for part of ${String(campaign.start_date).slice(0, 10)} - ${String(campaign.end_date).slice(0, 10)}` });
  }
  if (!LISTING_PLACEMENTS.some((p) => campaign.placements.includes(p)) && !campaign.image_url && campaign.placements.some((p) => ['home_hero', 'city_banner', 'login_splash'].includes(p))) flags.push({ severity: 'warn', rule: 'no_image', detail: 'No image - banner placements work best with one' });
  return flags;
}

async function campaignRow(id) {
  const c = (await pool.query('SELECT * FROM ad_campaigns WHERE id = $1', [id])).rows[0];
  if (!c) throw notFound('Campaign not found');
  return c;
}

async function assertCampaignAccess(user, c) {
  if (isStaff(user)) return;
  const a = (await pool.query('SELECT id FROM advertisers WHERE user_id = $1', [user.id])).rows[0];
  if (!a || a.id !== c.advertiser_id) throw forbidden('Not your campaign');
}

function creativeFromInput(data, placements) {
  const listing = placements.some((p) => LISTING_PLACEMENTS.includes(p));
  const banner = placements.some((p) => !LISTING_PLACEMENTS.includes(p));
  const cta = safeUrl(data.ctaUrl);
  if (banner) {
    if (!data.headline || String(data.headline).trim().length < 3) throw badRequest('Give the ad a headline');
    if (data.ctaUrl && !cta) throw badRequest('The click-through link must be an https:// address');
    if (!cta && !listing) throw badRequest('Give the click-through link (https://)');
    if (placements.includes('digest_sponsored') && !data.body) throw badRequest('The digest slot needs a short message (body)');
  }
  if (listing && !data.propertyId) throw badRequest('Choose the listing this campaign promotes');
  let variantB = null;
  if (data.variantB && (data.variantB.headline || data.variantB.body || data.variantB.imageUrl)) {
    variantB = { headline: String(data.variantB.headline || '').slice(0, 120) || null, body: String(data.variantB.body || '').slice(0, 400) || null, imageUrl: data.variantB.imageUrl || null };
  }
  return {
    headline: data.headline ? String(data.headline).trim().slice(0, 120) : null, body: data.body ? String(data.body).trim().slice(0, 400) : null, imageUrl: data.imageUrl || null,
    ctaLabel: data.ctaLabel ? String(data.ctaLabel).trim().slice(0, 40) : null, ctaUrl: cta, reraNumber: data.reraNumber ? String(data.reraNumber).trim().slice(0, 80) : null, propertyId: data.propertyId || null, variantB,
  };
}

async function assertListing(advertiser, propertyId, placements) {
  if (!propertyId) return;
  const p = (await pool.query(`SELECT id, status::text AS status, listing_category::text AS category FROM properties WHERE id = $1`, [propertyId])).rows[0];
  if (!p || p.status !== 'approved') throw badRequest('The listing must be live to be promoted');
  if (placements.includes('institutional_featured') && p.category !== 'institutional') throw badRequest('The institutional featured slot is for an institutional listing');
  if (!placements.includes('institutional_featured') && p.category === 'institutional') throw badRequest('Institutional listings use the Institutional Deal Featured Slot');
}

// Create a campaign: priced from the rate card, invoiced at once, and
// waiting for payment. Nothing serves until it is paid and approved.
async function createCampaign(user, data, meta = {}) {
  const advertiser = await actingAdvertiser(user, data.advertiserId);
  const targeting = cleanTargeting(data.targeting);
  const q = await quote({ formatKey: data.formatKey, units: data.units, startDate: data.startDate, city: targeting.cities.length === 1 ? targeting.cities[0] : null });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.startDate || '')) || data.startDate < today()) throw badRequest('Choose a start date from today onwards');
  if (!data.name || String(data.name).trim().length < 3) throw badRequest('Name the campaign');
  const cr = creativeFromInput(data, q.placements);
  await assertListing(advertiser, cr.propertyId, q.placements);
  if (q.placements.includes('city_banner') && !targeting.cities.length) throw badRequest('Choose the city (or cities) for the area page banner');

  const c = await cfg();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const camp = (
      await client.query(
        `INSERT INTO ad_campaigns (advertiser_id, name, format_key, placements, headline, body, image_url, cta_label, cta_url, rera_number, property_id, variant_b, targeting,
           start_date, end_date, units, pricing_unit, rate, amount, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'pending_payment', $20) RETURNING *`,
        [advertiser.id, String(data.name).trim().slice(0, 160), q.formatKey, JSON.stringify(q.placements), cr.headline, cr.body, cr.imageUrl, cr.ctaLabel, cr.ctaUrl, cr.reraNumber, cr.propertyId,
          cr.variantB ? JSON.stringify(cr.variantB) : null, JSON.stringify(targeting), q.startDate, q.endDate, q.units, q.pricingUnit, q.rate, q.amount, user.id]
      )
    ).rows[0];
    const n = (await client.query(`SELECT nextval('ad_invoice_seq') AS n`)).rows[0].n;
    await client.query(
      `INSERT INTO ad_invoices (invoice_number, campaign_id, advertiser_id, amount, gst_percent, gst_amount, total_amount, gstin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`ADV/${fy()}/${String(n).padStart(6, '0')}`, camp.id, advertiser.id, q.amount, c.gst, q.gstAmount, q.total, c.gstin]
    );
    await client.query('COMMIT');
    await auditService.log({ actor: user, action: 'ads.campaign_created', entityType: 'ad_campaign', entityId: camp.id, after: { format: q.formatKey, units: q.units, amount: q.amount }, ...meta });
    // A zero-rated booking (rate not set yet / complimentary) has nothing to pay.
    if (q.total === 0) await markPaid(camp.id, { gateway: 'none', reference: 'No charge', actor: user });
    return campaignView(user, camp.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Edit the creative / targeting. A change to a campaign that was already
// approved sends it back to review.
async function updateCampaign(user, id, data, meta = {}) {
  const c = await campaignRow(id);
  await assertCampaignAccess(user, c);
  if (['ended', 'cancelled'].includes(c.status)) throw badRequest('This campaign is over');
  const advertiser = (await pool.query('SELECT * FROM advertisers WHERE id = $1', [c.advertiser_id])).rows[0];
  const merged = {
    headline: data.headline ?? c.headline, body: data.body ?? c.body, imageUrl: data.imageUrl ?? c.image_url, ctaLabel: data.ctaLabel ?? c.cta_label, ctaUrl: data.ctaUrl ?? c.cta_url,
    reraNumber: data.reraNumber ?? c.rera_number, propertyId: data.propertyId ?? c.property_id, variantB: data.variantB === undefined ? c.variant_b : data.variantB,
  };
  const cr = creativeFromInput(merged, c.placements);
  await assertListing(advertiser, cr.propertyId, c.placements);
  const targeting = data.targeting ? cleanTargeting(data.targeting) : c.targeting;
  const backToReview = ['approved', 'paused', 'rejected'].includes(c.status);
  await pool.query(
    `UPDATE ad_campaigns SET name = COALESCE($1, name), headline = $2, body = $3, image_url = $4, cta_label = $5, cta_url = $6, rera_number = $7, property_id = $8, variant_b = $9, targeting = $10,
       status = CASE WHEN $11 THEN 'pending_review' ELSE status END, submitted_at = CASE WHEN $11 THEN now() ELSE submitted_at END, review_note = CASE WHEN $11 THEN NULL ELSE review_note END
     WHERE id = $12`,
    [data.name ? String(data.name).slice(0, 160) : null, cr.headline, cr.body, cr.imageUrl, cr.ctaLabel, cr.ctaUrl, cr.reraNumber, cr.propertyId, cr.variantB ? JSON.stringify(cr.variantB) : null, JSON.stringify(targeting), backToReview, id]
  );
  await auditService.log({ actor: user, action: 'ads.campaign_updated', entityType: 'ad_campaign', entityId: id, after: { backToReview }, ...meta });
  return campaignView(user, id);
}

async function setCampaignState(user, id, action, meta = {}) {
  const c = await campaignRow(id);
  await assertCampaignAccess(user, c);
  const next = { pause: ['approved', 'paused'], resume: ['paused', 'approved'], cancel: ['pending_payment', 'cancelled'] }[action];
  if (!next) throw badRequest('Unknown action');
  if (c.status !== next[0]) throw badRequest(action === 'cancel' ? 'Only an unpaid campaign can be cancelled' : `A campaign must be ${next[0]} to ${action}`);
  await pool.query('UPDATE ad_campaigns SET status = $1 WHERE id = $2', [next[1], id]);
  if (action === 'cancel') await pool.query(`UPDATE ad_invoices SET status = 'void' WHERE campaign_id = $1 AND status = 'due'`, [id]);
  await auditService.log({ actor: user, action: `ads.campaign_${action}`, entityType: 'ad_campaign', entityId: id, ...meta });
  return campaignView(user, id);
}

// Campaign approval (creative and placement review) - a per-campaign gate,
// separate from the advertiser's one-time eligibility approval.
async function reviewCampaign(admin, id, { decision, note }, meta = {}) {
  if (!isAdmin(admin)) throw forbidden('Only an admin approves campaigns');
  const c = await campaignRow(id);
  if (c.status !== 'pending_review') throw badRequest('This campaign is not waiting for review');
  if (!['approve', 'reject'].includes(decision)) throw badRequest('decision must be approve or reject');
  if (decision === 'reject' && !note) throw badRequest('Give the advertiser the reason');
  const advertiser = (await pool.query('SELECT * FROM advertisers WHERE id = $1', [c.advertiser_id])).rows[0];
  const flags = await reviewFlags(c, advertiser);
  const blocking = flags.filter((f) => f.severity === 'block');
  if (decision === 'approve' && blocking.length) throw badRequest(`Cannot approve: ${blocking.map((f) => f.detail).join('; ')}`);
  await pool.query(
    `UPDATE ad_campaigns SET status = $1, review_flags = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $5`,
    [decision === 'approve' ? 'approved' : 'rejected', JSON.stringify(flags), note || null, admin.id, id]
  );
  await auditService.log({ actor: admin, action: `ads.campaign_${decision}d`, entityType: 'ad_campaign', entityId: id, after: { note, flags: flags.length }, ...meta });
  if (advertiser.user_id) {
    await notificationService.createNotification({
      userId: advertiser.user_id, type: 'advertising', title: decision === 'approve' ? `Campaign approved: ${c.name}` : `Campaign needs changes: ${c.name}`,
      message: decision === 'approve' ? `It runs from ${String(c.start_date).slice(0, 10)} to ${String(c.end_date).slice(0, 10)}.` : `${note} Edit the campaign to send it back for review.`,
      relatedEntityType: 'ad_campaign', relatedEntityId: id,
    });
  }
  return campaignView(admin, id);
}

// ------------------------------------------------------------ invoices & payment

async function markPaid(campaignId, { gateway, orderId = null, paymentId = null, reference = null, actor = null }) {
  const inv = (await pool.query(`UPDATE ad_invoices SET status = 'paid', paid_at = now(), gateway = $1, gateway_order_id = COALESCE($2, gateway_order_id), gateway_payment_id = $3, payment_reference = $4, recorded_by = $5
                                 WHERE campaign_id = $6 AND status = 'due' RETURNING *`, [gateway, orderId, paymentId, reference, actor?.id || null, campaignId])).rows[0];
  if (!inv) return null;
  // Paid -> the campaign goes to admin review; the automated checks run now.
  const c = await campaignRow(campaignId);
  const advertiser = (await pool.query('SELECT * FROM advertisers WHERE id = $1', [c.advertiser_id])).rows[0];
  const flags = await reviewFlags(c, advertiser);
  await pool.query(`UPDATE ad_campaigns SET status = 'pending_review', submitted_at = now(), review_flags = $1 WHERE id = $2 AND status = 'pending_payment'`, [JSON.stringify(flags), campaignId]);
  const admins = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
  for (const a of admins.rows) await notificationService.createNotification({ userId: a.id, type: 'advertising', title: 'Ad campaign to review', message: `${advertiser.business_name}: ${c.name}`, relatedEntityType: 'ad_campaign', relatedEntityId: campaignId });
  return inv;
}

async function invoiceRow(user, id) {
  const inv = (await pool.query('SELECT * FROM ad_invoices WHERE id = $1', [id])).rows[0];
  if (!inv) throw notFound('Invoice not found');
  if (!isStaff(user)) {
    const a = (await pool.query('SELECT id FROM advertisers WHERE user_id = $1', [user.id])).rows[0];
    if (!a || a.id !== inv.advertiser_id) throw forbidden('Not your invoice');
  }
  return inv;
}

const razorpay = () => (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? { keyId: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET } : null);

// Razorpay Orders API (no SDK): the portal opens Checkout with this order.
async function createRazorpayOrder(user, invoiceId) {
  const inv = await invoiceRow(user, invoiceId);
  if (inv.status !== 'due') throw badRequest('This invoice is not awaiting payment');
  const rz = razorpay();
  if (!rz) throw badRequest('Online payment is not set up yet - pay by bank transfer and share the reference with your A R Buildwel contact');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${rz.keyId}:${rz.secret}`).toString('base64')}` },
    body: JSON.stringify({ amount: Math.round(Number(inv.total_amount) * 100), currency: 'INR', receipt: inv.invoice_number.slice(0, 40), notes: { invoiceId: inv.id } }),
  });
  const order = await res.json().catch(() => null);
  if (!res.ok || !order?.id) throw badRequest(`Could not start the payment${order?.error?.description ? `: ${order.error.description}` : ''}`);
  await pool.query(`UPDATE ad_invoices SET gateway = 'razorpay', gateway_order_id = $1 WHERE id = $2`, [order.id, inv.id]);
  return { keyId: rz.keyId, orderId: order.id, amount: order.amount, currency: 'INR', invoiceNumber: inv.invoice_number };
}

// Checkout success: verify the signature before believing the payment.
async function verifyRazorpayPayment(user, invoiceId, { orderId, paymentId, signature }, meta = {}) {
  const inv = await invoiceRow(user, invoiceId);
  const rz = razorpay();
  if (!rz) throw badRequest('Online payment is not set up');
  if (!orderId || orderId !== inv.gateway_order_id) throw badRequest('This payment does not belong to this invoice');
  const expected = crypto.createHmac('sha256', rz.secret).update(`${orderId}|${paymentId}`).digest('hex');
  const ok = expected.length === String(signature || '').length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  if (!ok) throw badRequest('Payment verification failed');
  await markPaid(inv.campaign_id, { gateway: 'razorpay', orderId, paymentId, reference: paymentId, actor: user });
  await auditService.log({ actor: user, action: 'ads.invoice_paid', entityType: 'ad_invoice', entityId: inv.id, after: { gateway: 'razorpay', paymentId }, ...meta });
  return campaignView(user, inv.campaign_id);
}

// Bank transfer / cheque recorded by staff.
async function recordPayment(admin, invoiceId, { reference }, meta = {}) {
  if (!isStaff(admin)) throw forbidden('A R staff record offline payments');
  if (!reference || String(reference).trim().length < 3) throw badRequest('Give the payment reference (UTR / cheque number)');
  const inv = await invoiceRow(admin, invoiceId);
  if (inv.status !== 'due') throw badRequest('This invoice is not awaiting payment');
  await markPaid(inv.campaign_id, { gateway: 'offline', reference: String(reference).slice(0, 120), actor: admin });
  await auditService.log({ actor: admin, action: 'ads.invoice_paid', entityType: 'ad_invoice', entityId: inv.id, after: { gateway: 'offline', reference }, ...meta });
  return campaignView(admin, inv.campaign_id);
}

async function listInvoices(user) {
  const staff = isStaff(user);
  const adv = staff ? null : await advertiserFor(user);
  const r = await pool.query(
    `SELECT i.*, c.name AS campaign_name, c.format_key, a.business_name, a.av_code FROM ad_invoices i JOIN ad_campaigns c ON c.id = i.campaign_id JOIN advertisers a ON a.id = i.advertiser_id
     ${staff ? '' : 'WHERE i.advertiser_id = $1'} ORDER BY i.created_at DESC LIMIT 500`,
    staff ? [] : [adv.id]
  );
  return r.rows.map((i) => ({ id: i.id, invoiceNumber: i.invoice_number, campaignId: i.campaign_id, campaignName: i.campaign_name, formatKey: i.format_key, businessName: i.business_name, avCode: i.av_code,
    amount: Number(i.amount), gstPercent: Number(i.gst_percent), gstAmount: Number(i.gst_amount), total: Number(i.total_amount), status: i.status, gateway: i.gateway, paymentReference: i.payment_reference, paidAt: i.paid_at, createdAt: i.created_at }));
}

async function invoicePdf(user, invoiceId) {
  const inv = await invoiceRow(user, invoiceId);
  const c = await campaignRow(inv.campaign_id);
  const a = (await pool.query('SELECT * FROM advertisers WHERE id = $1', [inv.advertiser_id])).rows[0];
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (text, { size = 11, f = font, gap = 8 } = {}) => {
    page.drawText(String(text).replace(/[^\x20-\x7E]/g, ' '), { x: 50, y, size, font: f });
    y -= size + gap;
  };
  const money = (v) => `INR ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  line('A R Buildwel - PropertySerch.com', { size: 16, f: bold });
  line(`GSTIN: ${inv.gstin}`);
  y -= 6;
  line(`TAX INVOICE ${inv.invoice_number}`, { size: 14, f: bold });
  line(`Date: ${new Date(inv.created_at).toLocaleDateString('en-IN')}`);
  line(`Billed to: ${a.business_name} (${a.av_code})`);
  if (a.gstin) line(`Customer GSTIN: ${a.gstin}`);
  if (a.billing_address) line(String(a.billing_address).slice(0, 90));
  y -= 6;
  line('Advertising on PropertySerch.com', { f: bold });
  line(`Campaign: ${c.name}`);
  line(`Format: ${c.format_key.replace(/_/g, ' ')} - ${c.units} ${c.pricing_unit}${c.units === 1 ? '' : 's'} @ ${money(c.rate)} per ${c.pricing_unit}`);
  line(`Period: ${String(c.start_date).slice(0, 10)} to ${String(c.end_date).slice(0, 10)}`);
  y -= 6;
  line(`Amount: ${money(inv.amount)}`);
  line(`GST @ ${Number(inv.gst_percent)}%: ${money(inv.gst_amount)}`);
  line(`Total payable: ${money(inv.total_amount)}`, { size: 13, f: bold });
  y -= 6;
  line(`Status: ${inv.status}${inv.payment_reference ? ` (ref ${inv.payment_reference})` : ''}`, { size: 9 });
  line('All advertising rates are exclusive of GST.', { size: 9 });
  return Buffer.from(await pdf.save());
}

// ------------------------------------------------------------ stats & views

async function statsFor(campaignIds) {
  if (!campaignIds.length) return new Map();
  const r = await pool.query(
    `SELECT campaign_id, variant,
            COUNT(*) FILTER (WHERE kind = 'impression')::int AS impressions, COUNT(*) FILTER (WHERE kind = 'click')::int AS clicks,
            COUNT(*) FILTER (WHERE kind = 'impression' AND event_date = CURRENT_DATE)::int AS impressions_today,
            COUNT(*) FILTER (WHERE kind = 'impression' AND event_date > CURRENT_DATE - 7)::int AS impressions_week,
            COUNT(*) FILTER (WHERE kind = 'click' AND event_date > CURRENT_DATE - 7)::int AS clicks_week
     FROM ad_events WHERE campaign_id = ANY($1::uuid[]) GROUP BY 1, 2`,
    [campaignIds]
  );
  const out = new Map();
  for (const x of r.rows) {
    const s = out.get(x.campaign_id) || { impressions: 0, clicks: 0, impressionsToday: 0, impressionsWeek: 0, clicksWeek: 0, variants: [] };
    s.impressions += x.impressions; s.clicks += x.clicks; s.impressionsToday += x.impressions_today; s.impressionsWeek += x.impressions_week; s.clicksWeek += x.clicks_week;
    s.variants.push({ variant: x.variant, impressions: x.impressions, clicks: x.clicks, ctr: x.impressions ? r2((x.clicks / x.impressions) * 100) : 0 });
    out.set(x.campaign_id, s);
  }
  for (const s of out.values()) s.ctr = s.impressions ? r2((s.clicks / s.impressions) * 100) : 0;
  return out;
}

// Amount of the booking used so far: by elapsed days, or by sends for the digest slot.
function spendOf(c) {
  const amount = Number(c.amount);
  if (!['approved', 'paused', 'ended'].includes(c.status)) return { spent: 0, remaining: amount };
  if (c.pricing_unit === 'send') {
    const spent = r2(Math.min(c.sends_used, c.units) * Number(c.rate));
    return { spent, remaining: r2(amount - spent) };
  }
  const start = new Date(c.start_date).getTime();
  const end = new Date(c.end_date).getTime() + 86400000;
  const frac = Math.max(0, Math.min(1, (Date.now() - start) / (end - start)));
  return { spent: r2(amount * frac), remaining: r2(amount * (1 - frac)) };
}

function liveState(c) {
  if (c.status !== 'approved') return c.status;
  const t = today();
  if (t < String(c.start_date).slice(0, 10)) return 'scheduled';
  return t > String(c.end_date).slice(0, 10) ? 'ended' : 'active';
}

async function shape(c, stats, { staff }) {
  const s = stats.get(c.id) || { impressions: 0, clicks: 0, impressionsToday: 0, impressionsWeek: 0, clicksWeek: 0, ctr: 0, variants: [] };
  return {
    id: c.id, advertiserId: c.advertiser_id, businessName: c.business_name, avCode: c.av_code, name: c.name, formatKey: c.format_key, formatLabel: c.format_label || c.format_key, placements: c.placements,
    headline: c.headline, body: c.body, imageUrl: c.image_url ? await getReadUrl(c.image_url).catch(() => c.image_url) : null, imagePath: c.image_url, ctaLabel: c.cta_label, ctaUrl: c.cta_url, reraNumber: c.rera_number,
    propertyId: c.property_id, propertyTitle: c.property_title || null, variantB: c.variant_b, targeting: c.targeting, startDate: c.start_date, endDate: c.end_date, units: c.units, pricingUnit: c.pricing_unit,
    rate: Number(c.rate), amount: Number(c.amount), status: c.status, state: liveState(c), reviewNote: c.review_note, reviewFlags: staff ? c.review_flags : (c.review_flags || []).filter((f) => f.severity === 'block'),
    sendsUsed: c.sends_used, stats: s, ...spendOf(c),
    invoice: c.invoice_id ? { id: c.invoice_id, number: c.invoice_number, total: Number(c.invoice_total), status: c.invoice_status } : null, createdAt: c.created_at,
  };
}

const CAMPAIGN_SELECT = `
  SELECT c.*, a.business_name, a.av_code, r.label AS format_label, p.title AS property_title,
         i.id AS invoice_id, i.invoice_number, i.total_amount AS invoice_total, i.status AS invoice_status
  FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id
  LEFT JOIN ad_rate_config r ON r.format_key = c.format_key AND r.city IS NULL
  LEFT JOIN properties p ON p.id = c.property_id LEFT JOIN ad_invoices i ON i.campaign_id = c.id`;

async function campaignView(user, id) {
  const c = (await pool.query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id])).rows[0];
  if (!c) throw notFound('Campaign not found');
  await assertCampaignAccess(user, c);
  return shape(c, await statsFor([id]), { staff: isStaff(user) });
}

async function listCampaigns(user, { status, advertiserId } = {}) {
  const staff = isStaff(user);
  const where = [];
  const params = [];
  if (!staff) {
    params.push((await advertiserFor(user)).id);
    where.push(`c.advertiser_id = $${params.length}`);
  } else if (advertiserId) {
    params.push(advertiserId);
    where.push(`c.advertiser_id = $${params.length}`);
  }
  if (status === 'live') where.push(`c.status = 'approved' AND CURRENT_DATE BETWEEN c.start_date AND c.end_date`);
  else if (status) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  const rows = (await pool.query(`${CAMPAIGN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (c.status = 'pending_review') DESC, c.created_at DESC LIMIT 300`, params)).rows;
  const stats = await statsFor(rows.map((r) => r.id));
  const out = [];
  for (const c of rows) out.push(await shape(c, stats, { staff }));
  return out;
}

async function portalHome(user) {
  const a = await advertiserFor(user);
  const campaigns = await listCampaigns(user, {});
  const sum = (f) => campaigns.reduce((s, c) => s + f(c), 0);
  return {
    advertiser: advView(a),
    totals: { campaigns: campaigns.length, live: campaigns.filter((c) => c.state === 'active').length, impressions: sum((c) => c.stats.impressions), clicks: sum((c) => c.stats.clicks),
      spent: r2(sum((c) => c.spent)), remaining: r2(sum((c) => c.remaining)), awaitingPayment: campaigns.filter((c) => c.status === 'pending_payment').length },
    paymentOnline: !!razorpay(),
  };
}

// ------------------------------------------------------------ serving

const userHash = (key) => (key ? crypto.createHash('sha256').update(`${process.env.JWT_ACCESS_SECRET || 'ads'}|${key}`).digest('hex').slice(0, 40) : null);
const inList = (list, value) => !list?.length || (value && list.some((x) => String(x).toLowerCase() === String(value).toLowerCase()));

// Audience role of a signed-in user, for role targeting.
async function audienceRoles(user) {
  if (!user) return [];
  if (['broker', 'agency_admin', 'builder'].includes(user.role)) return ['broker'];
  if (user.role !== 'customer') return [];
  const roles = [];
  const c = (await pool.query('SELECT id, portal_roles FROM customers WHERE user_id = $1', [user.id])).rows[0];
  for (const r of c?.portal_roles || []) roles.push(['buyer', 'tenant'].includes(r) ? 'buyer' : 'seller');
  const inv = (await pool.query('SELECT is_nri, is_hni FROM investor_profiles WHERE user_id = $1', [user.id])).rows[0];
  if (inv?.is_nri) roles.push('nri');
  if (inv?.is_hni) roles.push('hni');
  return [...new Set(roles.length ? roles : ['buyer'])];
}

async function buyerBudget(user) {
  if (!user || user.role !== 'customer') return null;
  const r = (await pool.query(`SELECT r.budget_max FROM requirements r JOIN customers c ON c.id = r.customer_id WHERE c.user_id = $1 AND r.status = 'active' AND r.budget_max IS NOT NULL ORDER BY r.created_at DESC LIMIT 1`, [user.id])).rows[0];
  return r ? Number(r.budget_max) : null;
}

function matchesTargeting(t, ctx) {
  if (!inList(t.cities, ctx.city)) return false;
  if (!inList(t.localities, ctx.locality)) return false;
  if (t.roles?.length && !t.roles.some((r) => ctx.roles.includes(r))) return false;
  if (t.propertyTypes?.length && ctx.propertyType && !inList(t.propertyTypes, ctx.propertyType)) return false;
  if (t.device && t.device !== 'all' && ctx.device && t.device !== ctx.device) return false;
  // Budget targeting (loan ads): only people whose stated budget is in range.
  if (t.budgetMin !== null && t.budgetMin !== undefined || t.budgetMax !== null && t.budgetMax !== undefined) {
    if (ctx.budget === null || ctx.budget === undefined) return false;
    if (t.budgetMin !== null && t.budgetMin !== undefined && ctx.budget < t.budgetMin) return false;
    if (t.budgetMax !== null && t.budgetMax !== undefined && ctx.budget > t.budgetMax) return false;
  }
  return true;
}

// Pick the ads for a placement and log the impressions.
// `viewId` identifies one page view: a slot that re-asks during the same view
// (a re-render, the visitor's city resolving) gets the same ad back and is
// not counted as another impression.
async function serve({ placement, city, locality, propertyType, device, viewerKey, viewId, limit }, user = null) {
  if (!PLACEMENTS.includes(placement)) throw badRequest('Unknown placement');
  const c = await cfg();
  if (!c.enabled) return { placement, ads: [] };
  // The CRM banner is for brokers; advertisers and staff are not an ad audience.
  if (placement === 'crm_dashboard' && !['broker', 'agency_admin', 'builder'].includes(user?.role)) return { placement, ads: [] };
  const hash = userHash(user?.id || viewerKey);
  const view = viewId ? String(viewId).slice(0, 40) : null;
  const ctx = { city, locality, propertyType: propertyType ? String(propertyType).toLowerCase() : null, device: ['mobile', 'desktop'].includes(device) ? device : null, roles: await audienceRoles(user), budget: await buyerBudget(user) };
  const rows = (
    await pool.query(
      `SELECT c.*, a.business_name, a.rera_number AS advertiser_rera,
              (SELECT COUNT(*)::int FROM ad_events e WHERE e.campaign_id = c.id AND e.kind = 'impression' AND e.event_date = CURRENT_DATE AND e.placement = $1) AS served_today,
              (SELECT COUNT(*)::int FROM ad_events e WHERE e.campaign_id = c.id AND e.kind = 'impression' AND e.event_date = CURRENT_DATE AND e.user_hash = $2 AND ($3::varchar IS NULL OR e.view_id IS DISTINCT FROM $3)) AS seen_today,
              EXISTS (SELECT 1 FROM ad_events e WHERE e.campaign_id = c.id AND e.kind = 'impression' AND e.event_date = CURRENT_DATE AND e.placement = $1 AND e.view_id = $3::varchar) AS in_view
       FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id
       WHERE c.status = 'approved' AND a.status = 'active' AND CURRENT_DATE BETWEEN c.start_date AND c.end_date AND c.placements ? $1`,
      [placement, hash, view]
    )
  ).rows;
  const eligible = rows
    .filter((r) => matchesTargeting(r.targeting || {}, ctx))
    // Frequency cap: after N views today the slot rotates to the next advertiser.
    .filter((r) => !hash || r.seen_today < c.cap)
    .filter((r) => (placement === 'digest_sponsored' ? r.sends_used < (r.pricing_unit === 'send' ? r.units : c.packageSends * r.units) : true))
    // Fair rotation: the campaign shown least today goes first.
    .sort((x, y) => y.in_view - x.in_view || x.served_today - y.served_today || new Date(x.created_at) - new Date(y.created_at))
    .slice(0, Math.min(Number(limit) || SLOT_SIZE[placement], SLOT_SIZE[placement]));

  const ads = [];
  for (const r of eligible) {
    // A/B: a stable variant per viewer.
    const variant = r.variant_b && hash && parseInt(hash.slice(-1), 16) % 2 === 1 ? 'B' : 'A';
    const cr = variant === 'B' ? { headline: r.variant_b.headline || r.headline, body: r.variant_b.body || r.body, image: r.variant_b.imageUrl || r.image_url } : { headline: r.headline, body: r.body, image: r.image_url };
    let listing = null;
    if (r.property_id && LISTING_PLACEMENTS.includes(placement)) {
      listing = await listingCard(r.property_id);
      if (!listing) continue; // the promoted listing is no longer live
    }
    ads.push({
      campaignId: r.id, placement, variant, sponsored: true, label: placement === 'featured_listing' ? 'Featured' : 'Sponsored', advertiser: r.business_name,
      headline: cr.headline, body: cr.body, imageUrl: cr.image ? await getReadUrl(cr.image).catch(() => null) : null, ctaLabel: r.cta_label || 'Learn more', ctaUrl: r.cta_url, reraNumber: r.rera_number || r.advertiser_rera, listing,
    });
    if (!r.in_view) await pool.query(`INSERT INTO ad_events (campaign_id, kind, placement, variant, user_hash, city, device, view_id) VALUES ($1, 'impression', $2, $3, $4, $5, $6, $7)`, [r.id, placement, variant, hash, city ? String(city).slice(0, 120) : null, ctx.device, view]);
  }
  return { placement, ads };
}

// The public card of a promoted listing (institutional ones stay masked).
async function listingCard(propertyId) {
  const p = (
    await pool.query(
      `SELECT p.id, p.title, p.city, p.locality, p.price, p.price_value, p.property_type::text AS property_type, p.transaction_type::text AS transaction_type, p.bedrooms, p.area_sqft,
              p.listing_category::text AS category, p.is_verified, p.verification_level,
              (SELECT pm.url FROM property_media pm WHERE pm.property_id = p.id ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS image
       FROM properties p WHERE p.id = $1 AND p.status = 'approved'`,
      [propertyId]
    )
  ).rows[0];
  if (!p) return null;
  if (p.category === 'institutional') {
    const inst = await require('./institutional.service').listPublic({ limit: 60 }).then((r) => r.items.find((i) => i.id === propertyId)).catch(() => null);
    return inst ? { ...inst, institutional: true } : null;
  }
  return { id: p.id, title: p.title, city: p.city, locality: p.locality, price: p.price, priceValue: p.price_value === null ? null : Number(p.price_value), propertyType: p.property_type, transactionType: p.transaction_type,
    bedrooms: p.bedrooms, areaSqft: p.area_sqft === null ? null : Number(p.area_sqft), verified: !!p.is_verified, image: p.image ? await getReadUrl(p.image).catch(() => null) : null };
}

// Module 28: a sponsored listing lifted inside the search results. Returns its
// label and counts the impression (once per viewer per day; none past the frequency cap).
async function sponsoredLabel(campaignId, { viewerKey = null, userId = null, city = null } = {}) {
  const c = (await pool.query(`SELECT id, placements FROM ad_campaigns WHERE id = $1 AND status = 'approved'`, [campaignId])).rows[0];
  if (!c || !(await cfg()).enabled) return null;
  const placement = c.placements.includes('featured_listing') ? 'featured_listing' : 'search_sponsored';
  const hash = userHash(userId || viewerKey);
  const seen = hash ? (await pool.query(`SELECT 1 FROM ad_events WHERE campaign_id = $1 AND kind = 'impression' AND placement = $2 AND user_hash = $3 AND event_date = CURRENT_DATE LIMIT 1`, [c.id, placement, hash])).rows.length > 0 : false;
  if (!seen) await pool.query(`INSERT INTO ad_events (campaign_id, kind, placement, variant, user_hash, city) VALUES ($1, 'impression', $2, 'A', $3, $4)`, [c.id, placement, hash, city ? String(city).slice(0, 120) : null]);
  return { label: placement === 'featured_listing' ? 'Featured' : 'Sponsored', campaignId: c.id, placement };
}

async function click({ campaignId, placement, variant, viewerKey, city, device }, user = null) {
  const c = (await pool.query(`SELECT id, cta_url, property_id, placements FROM ad_campaigns WHERE id = $1 AND status = 'approved'`, [campaignId])).rows[0];
  if (!c) throw notFound('Campaign not found');
  const p = c.placements.includes(placement) ? placement : c.placements[0];
  await pool.query(`INSERT INTO ad_events (campaign_id, kind, placement, variant, user_hash, city, device) VALUES ($1, 'click', $2, $3, $4, $5, $6)`,
    [c.id, p, variant === 'B' ? 'B' : 'A', userHash(user?.id || viewerKey), city ? String(city).slice(0, 120) : null, ['mobile', 'desktop'].includes(device) ? device : null]);
  return { url: c.cta_url, propertyId: c.property_id };
}

// One sponsored line for a person's daily digest (counts as a "send").
async function digestSponsor(userId) {
  try {
    const user = (await pool.query(`SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0];
    const { ads } = await serve({ placement: 'digest_sponsored' }, user || null);
    if (!ads.length) return null;
    await pool.query('UPDATE ad_campaigns SET sends_used = sends_used + 1 WHERE id = $1', [ads[0].campaignId]);
    return `Sponsored: ${[ads[0].headline, ads[0].body].filter(Boolean).join(' - ')}`.slice(0, 300);
  } catch (err) {
    console.error('[ads] digest sponsor failed:', err.message);
    return null;
  }
}

// ------------------------------------------------------------ admin dashboards

async function revenue() {
  const c = await cfg();
  const [totals, byFormat, top, renewals, pending] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('month', now())), 0)::float AS month,
              COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= make_date(CASE WHEN EXTRACT(MONTH FROM now()) >= 4 THEN EXTRACT(YEAR FROM now())::int ELSE EXTRACT(YEAR FROM now())::int - 1 END, 4, 1)), 0)::float AS ytd,
              COALESCE(SUM(gst_amount) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('month', now())), 0)::float AS gst_month,
              COALESCE(SUM(total_amount) FILTER (WHERE status = 'due'), 0)::float AS outstanding
       FROM ad_invoices`
    ),
    pool.query(
      `SELECT c.format_key, COALESCE(r.label, c.format_key) AS label, COALESCE(SUM(i.amount), 0)::float AS revenue, COUNT(*)::int AS campaigns
       FROM ad_invoices i JOIN ad_campaigns c ON c.id = i.campaign_id LEFT JOIN ad_rate_config r ON r.format_key = c.format_key AND r.city IS NULL
       WHERE i.status = 'paid' GROUP BY 1, 2 ORDER BY revenue DESC`
    ),
    pool.query(`SELECT a.id, a.business_name, a.av_code, COALESCE(SUM(i.amount), 0)::float AS spend, COUNT(*)::int AS campaigns FROM ad_invoices i JOIN advertisers a ON a.id = i.advertiser_id WHERE i.status = 'paid' GROUP BY 1, 2, 3 ORDER BY spend DESC LIMIT 10`),
    pool.query(
      `SELECT c.id, c.name, c.end_date, c.format_key, a.business_name, a.av_code FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id
       WHERE c.status = 'approved' AND c.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int ORDER BY c.end_date LIMIT 50`,
      [c.renewDays]
    ),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'pending_review')::int AS review, COUNT(*) FILTER (WHERE status = 'pending_payment')::int AS payment,
                       COUNT(*) FILTER (WHERE status = 'approved' AND CURRENT_DATE BETWEEN start_date AND end_date)::int AS active FROM ad_campaigns`),
  ]);
  const leads = (await pool.query(`SELECT COUNT(*)::int AS n FROM bd_leads b WHERE b.category = 'advertiser' AND b.status NOT IN ('converted', 'rejected', 'closed') AND NOT EXISTS (SELECT 1 FROM advertisers a WHERE a.bd_lead_id = b.id)`)).rows[0].n;
  return {
    revenueThisMonth: totals.rows[0].month, revenueYtd: totals.rows[0].ytd, gstThisMonth: totals.rows[0].gst_month, outstanding: totals.rows[0].outstanding,
    activeCampaigns: pending.rows[0].active, pendingApprovals: pending.rows[0].review, awaitingPayment: pending.rows[0].payment, advertiserEnquiries: leads,
    revenueByFormat: byFormat.rows, topAdvertisers: top.rows, upcomingRenewals: renewals.rows,
  };
}

// Advertiser enquiries waiting for the eligibility decision.
async function pendingEnquiries() {
  const eligible = await eligibleCategories();
  const r = await pool.query(
    `SELECT b.id, b.full_name, b.business_name, b.business_category, b.email, b.mobile, b.desired_placement, b.budget_range, b.message, b.status, b.created_at
     FROM bd_leads b WHERE b.category = 'advertiser' AND b.status NOT IN ('converted', 'rejected', 'closed') AND NOT EXISTS (SELECT 1 FROM advertisers a WHERE a.bd_lead_id = b.id)
     ORDER BY b.created_at DESC LIMIT 200`
  );
  return r.rows.map((b) => ({ ...b, eligible: eligible.includes(b.business_category) }));
}

// Outbound prospecting: who to approach, from the platform's own activity.
// (Lender / advocate / insurer partner records arrive with the Phase 2
// partner ecosystem; until then the signals are listing volume and the
// demand for loan, insurance and legal help in each city.)
async function suggestions() {
  const existing = new Set((await pool.query('SELECT lower(business_name) AS n FROM advertisers')).rows.map((r) => r.n));
  const firms = await pool.query(
    `SELECT u.id, u.full_name, r.name AS role, COALESCE(t.name, u.full_name) AS business, p.city, COUNT(*)::int AS listings
     FROM properties p JOIN users u ON u.id = COALESCE(p.builder_id, p.broker_id, p.created_by) JOIN roles r ON r.id = u.role_id LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE p.status = 'approved' AND r.name IN ('builder', 'broker', 'agency_admin') AND p.city IS NOT NULL
     GROUP BY 1, 2, 3, 4, 5 HAVING COUNT(*) >= 3 ORDER BY listings DESC LIMIT 40`
  ).catch(() => ({ rows: [] }));
  const demand = await pool.query(
    `SELECT COALESCE(NULLIF(l.enquiry_details->>'city', ''), p.city, 'Unspecified') AS city, l.enquiry_type, COUNT(*)::int AS enquiries
     FROM leads l LEFT JOIN properties p ON p.id = l.property_id
     WHERE l.enquiry_type IN ('home_loan', 'insurance', 'legal') AND l.created_at > now() - interval '90 days' GROUP BY 1, 2 HAVING COUNT(*) >= 2 ORDER BY enquiries DESC LIMIT 30`
  );
  const advertisingIn = await pool.query(
    `SELECT DISTINCT a.business_category, lower(city.value) AS city FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id, jsonb_array_elements_text(c.targeting->'cities') AS city(value)
     WHERE c.status = 'approved' AND c.end_date >= CURRENT_DATE`
  );
  const covered = new Set(advertisingIn.rows.map((r) => `${r.business_category}|${r.city}`));
  const want = { home_loan: ['bank', 'nbfc'], insurance: ['insurance'], legal: ['legal_services'] };
  const label = { home_loan: 'Banks and NBFCs', insurance: 'Insurers', legal: 'Law firms / legal services' };
  return {
    firms: firms.rows.filter((f) => !existing.has(String(f.business).toLowerCase())).map((f) => ({ userId: f.id, business: f.business, type: f.role === 'builder' ? 'Builder / developer' : 'Broker firm', city: f.city, activity: f.listings, reason: `${f.listings} live listings in ${f.city} and not advertising` })),
    categories: demand.rows.filter((d) => !want[d.enquiry_type].some((cat) => covered.has(`${cat}|${String(d.city).toLowerCase()}`))).map((d) => ({ city: d.city, approach: label[d.enquiry_type], activity: d.enquiries, reason: `${d.enquiries} ${d.enquiry_type.replace('_', ' ')} enquiries in ${d.city} in 90 days and no advertiser of this kind there` })),
  };
}

// ------------------------------------------------------------ jobs & upload

async function sweep() {
  const c = await cfg();
  const ended = await pool.query(
    `UPDATE ad_campaigns SET status = 'ended' WHERE status IN ('approved', 'paused') AND (end_date < CURRENT_DATE OR (pricing_unit = 'send' AND sends_used >= units)) RETURNING id`
  );
  const due = await pool.query(
    `UPDATE ad_campaigns c SET renewal_alerted_at = now() FROM advertisers a
     WHERE a.id = c.advertiser_id AND c.status = 'approved' AND c.renewal_alerted_at IS NULL AND c.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
     RETURNING c.id, c.name, c.end_date, a.user_id`,
    [c.renewDays]
  );
  for (const d of due.rows) {
    if (d.user_id) await notificationService.createNotification({ userId: d.user_id, type: 'advertising', title: `Campaign ending soon: ${d.name}`, message: `It ends on ${String(new Date(d.end_date).toISOString()).slice(0, 10)}. Book again to keep the slot.`, relatedEntityType: 'ad_campaign', relatedEntityId: d.id });
  }
  return { ended: ended.rows.length, renewalReminders: due.rows.length };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((err) => console.error('[ads] sweep failed:', err.message)), 60 * 60 * 1000);
}

async function uploadCreative(user, file) {
  if (!file) throw badRequest('Choose an image');
  if (!isStaff(user)) await advertiserFor(user);
  const path = await uploadBuffer(file.buffer, `ads/creatives/${user.id}`, file.originalname, file.mimetype);
  return { path, url: await getReadUrl(path).catch(() => null) };
}

module.exports = {
  PLACEMENTS, SLOT_SIZE, LISTING_PLACEMENTS,
  approveAdvertiser, listAdvertisers, updateAdvertiser, pendingEnquiries, eligibleCategories,
  rateCard, saveRate, quote,
  createCampaign, updateCampaign, setCampaignState, reviewCampaign, campaignView, listCampaigns, portalHome,
  listInvoices, invoicePdf, createRazorpayOrder, verifyRazorpayPayment, recordPayment,
  serve, click, sponsoredLabel, digestSponsor, revenue, suggestions, sweep, startScheduler, uploadCreative,
};
