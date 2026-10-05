const pool = require('../config/db');
const configService = require('./config.service');
const authService = require('./auth.service');
const leadService = require('./lead.service');
const customerService = require('./customer.service');
const { badRequest, notFound } = require('../utils/httpError');

// Guest Browsing & Guest Interest (Annexure A): an unregistered visitor can
// say "I'm Interested" in a listing or a posted requirement with only a
// mobile number + OTP - no role, no onboarding, no account.
//   - The lead is tied to the phone number (customers.mobile), not a user.
//   - It goes through the same Universal Inquiry Assignment Cascade as any
//     enquiry (rep within 60 s, same SLA / escalation); the guest sees only
//     the assigned representative's name and platform number.
//   - Registering later with the same mobile attaches that customer record
//     (so every lead and interest) to the new account - nothing is lost or
//     duplicated (auth.service -> findOrCreateCustomerByContact).
//   - A guest gets no dashboard, no referral code, no matching.

const OTP_PURPOSE = 'guest_interest';

function normaliseMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const ten = digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  if (!/^[6-9]\d{9}$/.test(ten)) throw badRequest('Enter a valid 10-digit Indian mobile number');
  return ten;
}

async function requestOtp({ mobile }) {
  const m = normaliseMobile(mobile);
  const recent = await pool.query(
    `SELECT COUNT(*)::int AS n FROM otp_verifications WHERE identifier = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'`,
    [m, OTP_PURPOSE]
  );
  if (recent.rows[0].n >= 5) {
    const err = new Error('Too many codes requested for this number - try again in an hour');
    err.statusCode = 429;
    throw err;
  }
  const otp = await authService.createOtp(m, OTP_PURPOSE);
  return { mobile: m, expiresInMinutes: Number(process.env.OTP_EXPIRY_MINUTES) || 5, ...(process.env.NODE_ENV !== 'production' ? { otp } : {}) };
}

async function describeTarget({ propertyId, requirementId }) {
  if (propertyId) {
    const p = (await pool.query(`SELECT id, title, city, locality, status FROM properties WHERE id = $1`, [propertyId])).rows[0];
    if (!p || p.status !== 'approved') throw notFound('This listing is no longer available');
    return { property: p, label: `listing "${p.title}" (${[p.locality, p.city].filter(Boolean).join(', ')})` };
  }
  if (requirementId) {
    const r = (await pool.query(`SELECT id, purpose, property_type, city, localities, status FROM requirements WHERE id = $1`, [requirementId])).rows[0];
    if (!r || r.status !== 'active') throw notFound('This requirement is no longer open');
    return { requirement: r, label: `posted requirement: ${r.purpose} ${String(r.property_type || '').replace(/_/g, ' ')} in ${[...(r.localities || []).slice(0, 2), r.city].filter(Boolean).join(', ')}` };
  }
  throw badRequest('Say which listing or requirement you are interested in');
}

async function submit({ mobile, otp, fullName, propertyId, requirementId, message, anonymousId, attribution }) {
  const m = normaliseMobile(mobile);
  const target = await describeTarget({ propertyId, requirementId });
  await authService.verifyOtp(m, String(otp || ''), OTP_PURPOSE);

  const name = String(fullName || '').trim().slice(0, 150) || `Guest ${m.slice(-4)}`;
  const note = `Guest interest (mobile verified by OTP) in ${target.label}.${message ? ` Message: ${String(message).trim().slice(0, 1000)}` : ''}`;
  const customer = await customerService.findOrCreateCustomerByContact({ fullName: name, mobile: m });

  // Same guest, same listing / requirement, lead still open -> add to it.
  const days = Number(await configService.getConfig('guest_interest.reuse_lead_days', 30)) || 30;
  const open = (
    await pool.query(
      `SELECT l.id FROM leads l
       WHERE l.customer_id = $1 AND l.status NOT IN ('won', 'lost') AND l.created_at > now() - ($2::int || ' days')::interval
         AND (($3::uuid IS NOT NULL AND l.property_id = $3::uuid)
           OR ($4::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM guest_interests g WHERE g.lead_id = l.id AND g.requirement_id = $4::uuid)))
       ORDER BY l.created_at DESC LIMIT 1`,
      [customer.id, days, propertyId || null, requirementId || null]
    )
  ).rows[0];

  let leadId;
  let representative = null;
  const assignment = require('./assignment.service');
  if (open) {
    leadId = open.id;
    await pool.query('INSERT INTO lead_notes (lead_id, user_id, note) VALUES ($1, NULL, $2)', [leadId, `Repeat ${note}`]);
    const rep = (await pool.query('SELECT arb_rep_id FROM leads WHERE id = $1', [leadId])).rows[0];
    representative = await assignment.repCard(rep?.arb_rep_id);
  } else {
    const lead = await leadService.createPublicInquiry({ fullName: name, mobile: m, propertyId: propertyId || undefined, message: note, source: 'website', anonymousId });
    leadId = lead.id;
    representative = lead.representative || null;
  }

  await pool.query(
    `INSERT INTO guest_interests (mobile, full_name, customer_id, lead_id, property_id, requirement_id, message, anonymous_id, attribution, reused_lead)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [m, name, customer.id, leadId, propertyId || null, requirementId || null, message ? String(message).slice(0, 2000) : null,
      anonymousId ? String(anonymousId).slice(0, 80) : null, JSON.stringify(attribution && typeof attribution === 'object' ? attribution : {}), !!open]
  );

  // The guest's whole view of the result: a reference and who will call.
  return {
    reference: `GI-${String(leadId).slice(0, 8).toUpperCase()}`,
    alreadyRegistered: !!open,
    representative: representative ? { name: representative.name, platformNumber: representative.platformNumber, designation: representative.designation } : null,
    message: representative
      ? `${representative.name} from A R Buildwel will contact you shortly.`
      : 'An A R Buildwel representative will contact you shortly.',
  };
}

// Posted requirements a guest may browse: area and locality only (Controlled
// Contact Architecture) - no person, no contact, no budget.
async function publicRequirements({ city, purpose, limit = 30 } = {}) {
  const where = [`r.status = 'active'`, `(r.expires_at IS NULL OR r.expires_at > now())`];
  const params = [];
  if (city) {
    params.push(city);
    where.push(`r.city ILIKE $${params.length}`);
  }
  if (purpose) {
    params.push(purpose);
    where.push(`r.purpose = $${params.length}`);
  }
  params.push(Math.min(60, Number(limit) || 30));
  const rows = await pool.query(
    `SELECT r.id, r.purpose, r.property_type, r.city, r.localities, r.bedrooms, r.area_min_sqft, r.area_max_sqft, r.urgency, r.created_at
     FROM requirements r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.rows.map((r) => ({
    id: r.id, purpose: r.purpose, propertyType: r.property_type, city: r.city, localities: (r.localities || []).slice(0, 5), bedrooms: r.bedrooms,
    areaMinSqft: r.area_min_sqft, areaMaxSqft: r.area_max_sqft, urgency: r.urgency, postedAt: r.created_at,
  }));
}

module.exports = { requestOtp, submit, publicRequirements, normaliseMobile };
