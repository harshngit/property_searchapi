const dns = require('dns').promises;
const tls = require('tls');
const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const notificationService = require('./notification.service');
const tax = require('./tax.service');
const { encrypt } = require('../utils/crypto');
const { uploadBuffer, getReadUrl } = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Franchise extras (Section 14):
//   Tax profile   PAN / GSTIN of each commission recipient.
//   GST invoices  the franchisee and the broker each raise a GST invoice to
//                 A R Buildwel for their share (sec. 14.6); it is uploaded,
//                 checked against the share and approved before payout.
//   Payout        on release, each share is paid net of TDS from the unified
//                 per-PAN ledger, with one payout line per person.
//   Emails        franchisee-branded email (name, logo, colour, sender).
//   Domains       A R Buildwel owns every franchisee domain. The checker
//                 confirms the DNS record points at the platform and reads
//                 the live certificate; a TLS "ask" endpoint lets the edge
//                 server issue certificates on demand for mapped domains only.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const r2 = (v) => Math.round(Number(v) * 100) / 100;

// ------------------------------------------------------------ tax profile

async function taxProfile(userId) {
  const p = (await pool.query('SELECT * FROM payee_tax_profiles WHERE user_id = $1', [userId])).rows[0];
  const gst = (await pool.query(`SELECT reference FROM user_verifications WHERE user_id = $1 AND kind = 'gst' AND status = 'verified' ORDER BY decided_at DESC NULLS LAST LIMIT 1`, [userId])).rows[0];
  return {
    legalName: p?.legal_name || null, panLast4: p?.pan_last4 || null, hasPan: !!p?.pan_hash, panVerified: !!p?.pan_verified,
    gstin: p?.gstin || gst?.reference || null, gstRegistered: !!gst, updatedAt: p?.updated_at || null,
  };
}

async function saveTaxProfile(user, { legalName, pan, gstin }, meta = {}) {
  const P = pan ? String(pan).trim().toUpperCase() : null;
  const G = gstin ? String(gstin).trim().toUpperCase() : null;
  if (P && !tax.PAN_RE.test(P)) throw badRequest('Enter a valid PAN (e.g. ABCDE1234F)');
  if (G && !tax.GSTIN_RE.test(G)) throw badRequest('Enter a valid 15-character GSTIN');
  if (P && G && G.slice(2, 12) !== P) throw badRequest('The GSTIN does not belong to this PAN');
  const cur = (await pool.query('SELECT * FROM payee_tax_profiles WHERE user_id = $1', [user.id])).rows[0];
  // A verified PAN is not changed by the person; staff re-verify a new one.
  const panChanged = P && tax.panHash(P) !== cur?.pan_hash;
  await pool.query(
    `INSERT INTO payee_tax_profiles (user_id, legal_name, pan_encrypted, pan_hash, pan_last4, gstin) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET legal_name = COALESCE(EXCLUDED.legal_name, payee_tax_profiles.legal_name),
       pan_encrypted = COALESCE(EXCLUDED.pan_encrypted, payee_tax_profiles.pan_encrypted), pan_hash = COALESCE(EXCLUDED.pan_hash, payee_tax_profiles.pan_hash),
       pan_last4 = COALESCE(EXCLUDED.pan_last4, payee_tax_profiles.pan_last4), gstin = COALESCE(EXCLUDED.gstin, payee_tax_profiles.gstin),
       pan_verified = CASE WHEN $7 THEN false ELSE payee_tax_profiles.pan_verified END, updated_at = now()`,
    [user.id, legalName ? String(legalName).trim().slice(0, 200) : null, P ? encrypt(P) : null, P ? tax.panHash(P) : null, P ? P.slice(-4) : null, G, !!panChanged]
  );
  await auditService.log({ actor: user, action: 'tax.profile_saved', entityType: 'user', entityId: user.id, after: { panLast4: P ? P.slice(-4) : undefined, gstin: G || undefined }, ...meta });
  return taxProfile(user.id);
}

async function verifyPan(staff, userId, meta = {}) {
  if (!STAFF.includes(staff.role)) throw forbidden();
  const r = await pool.query('UPDATE payee_tax_profiles SET pan_verified = true, verified_by = $1, verified_at = now() WHERE user_id = $2 AND pan_hash IS NOT NULL RETURNING user_id', [staff.id, userId]);
  if (!r.rowCount) throw badRequest('No PAN on file for this person');
  await auditService.log({ actor: staff, action: 'tax.pan_verified', entityType: 'user', entityId: userId, ...meta });
  return taxProfile(userId);
}

// The PAN a share is paid against: the franchise's registered PAN for the
// franchisee share; the person's profile, else the PAN inside their verified GSTIN.
async function panOf(share, commission) {
  if (share.party === 'franchisee') {
    const f = (await pool.query('SELECT pan, gstin, legal_name FROM franchisees WHERE id = $1', [commission.franchisee_id])).rows[0];
    const pan = f?.pan || (f?.gstin ? f.gstin.slice(2, 12) : null);
    return pan ? { hash: tax.panHash(pan), last4: pan.slice(-4), name: f.legal_name } : { hash: null, last4: null, name: f?.legal_name };
  }
  const p = (await pool.query('SELECT pan_hash, pan_last4, legal_name FROM payee_tax_profiles WHERE user_id = $1', [share.userId])).rows[0];
  if (p?.pan_hash) return { hash: p.pan_hash, last4: p.pan_last4, name: p.legal_name || share.name };
  const g = (await pool.query(`SELECT reference FROM user_verifications WHERE user_id = $1 AND kind = 'gst' AND status = 'verified' LIMIT 1`, [share.userId])).rows[0];
  const fromGst = g?.reference && tax.GSTIN_RE.test(String(g.reference).toUpperCase()) ? String(g.reference).toUpperCase().slice(2, 12) : null;
  return fromGst ? { hash: tax.panHash(fromGst), last4: fromGst.slice(-4), name: share.name } : { hash: null, last4: null, name: share.name };
}

// ------------------------------------------------------------ GST invoices for a share

const payable = (c) => (c.shares || []).filter((s) => s.userId && ['franchisee', 'broker'].includes(s.party));

const invoiceView = (i) => ({
  id: i.id, commissionId: i.commission_id, userId: i.user_id, party: i.party, payeeName: i.payee_name, invoiceNumber: i.invoice_number, invoiceDate: i.invoice_date, supplierGstin: i.supplier_gstin,
  taxableAmount: Number(i.taxable_amount), gstAmount: Number(i.gst_amount), totalAmount: Number(i.total_amount), fileName: i.file_name, status: i.status, reviewNote: i.review_note, reviewedAt: i.reviewed_at, createdAt: i.created_at,
});

// My shares across commission calculations, with what each still needs.
async function myShares(user) {
  const rows = (await pool.query(
    `SELECT c.*, d.deal_value AS dv FROM franchisee_commissions c LEFT JOIN deals d ON d.id = c.deal_id WHERE c.shares @> $1::jsonb ORDER BY c.created_at DESC LIMIT 200`,
    [JSON.stringify([{ userId: user.id }])]
  )).rows;
  const invoices = (await pool.query(`SELECT * FROM commission_invoices WHERE user_id = $1 ORDER BY created_at DESC`, [user.id])).rows;
  const lines = (await pool.query(`SELECT * FROM commission_payout_lines WHERE user_id = $1`, [user.id])).rows;
  const need = await configService.getConfig('franchise.require_gst_invoice', true);
  return {
    profile: await taxProfile(user.id),
    shares: rows.map((c) => {
      const share = (c.shares || []).find((s) => s.userId === user.id);
      const inv = invoices.find((i) => i.commission_id === c.id && i.status !== 'rejected') || invoices.find((i) => i.commission_id === c.id) || null;
      const line = lines.find((l) => l.commission_id === c.id);
      return {
        commissionId: c.id, dealValue: Number(c.deal_value), status: c.status, createdAt: c.created_at, releasedAt: c.released_at,
        party: share.party, roles: share.roles, base: share.base, gst: share.gst, total: share.total, gstRegistered: share.gstRegistered,
        invoiceNeeded: need !== false && share.gstRegistered, invoice: inv ? invoiceView(inv) : null,
        paid: line ? { gross: Number(line.base_amount) + Number(line.gst_amount), tds: Number(line.tds_amount), tdsRate: Number(line.tds_rate), net: Number(line.net_amount) } : null,
      };
    }),
  };
}

async function uploadInvoice(user, commissionId, file, data = {}, meta = {}) {
  const c = (await pool.query('SELECT * FROM franchisee_commissions WHERE id = $1', [commissionId])).rows[0];
  if (!c) throw notFound('Commission not found');
  const share = payable(c).find((s) => s.userId === user.id);
  if (!share) throw forbidden('You have no share in this commission');
  if (c.status === 'released') throw badRequest('This commission has already been paid');
  if (!share.gstRegistered) throw badRequest('Your share is paid without GST, so no GST invoice is needed');
  if (!file) throw badRequest('Attach the invoice (PDF or image)');
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype)) throw badRequest('The invoice must be a PDF, JPG or PNG');
  if (file.size > 10 * 1024 * 1024) throw badRequest('The file is larger than 10 MB');
  const number = String(data.invoiceNumber || '').trim();
  if (number.length < 1 || number.length > 60) throw badRequest('Enter your invoice number');
  const date = String(data.invoiceDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > new Date().toISOString().slice(0, 10)) throw badRequest('Enter the invoice date (not in the future)');
  const gstin = String(data.supplierGstin || '').trim().toUpperCase();
  if (!tax.GSTIN_RE.test(gstin)) throw badRequest('Enter your 15-character GSTIN as printed on the invoice');
  const taxable = r2(data.taxableAmount);
  const gst = r2(data.gstAmount);
  // The invoice must be for the calculated share - not more, not less (Rs 1 rounding allowed).
  if (Math.abs(taxable - share.base) > 1) throw badRequest(`The taxable amount must be your share, Rs ${share.base.toLocaleString('en-IN')}`);
  if (Math.abs(gst - share.gst) > 1) throw badRequest(`The GST must be Rs ${share.gst.toLocaleString('en-IN')}`);
  if ((await pool.query(`SELECT 1 FROM commission_invoices WHERE commission_id = $1 AND user_id = $2 AND status <> 'rejected'`, [commissionId, user.id])).rows.length) {
    throw badRequest('An invoice for this share is already with A R Buildwel');
  }
  const path = !process.env.GCS_BUCKET_NAME && process.env.NODE_ENV !== 'production' ? `not-stored/commission-invoices/${commissionId}/${file.originalname}` : await uploadBuffer(file.buffer, `commission-invoices/${commissionId}`, file.originalname, file.mimetype);
  const inv = (await pool.query(
    `INSERT INTO commission_invoices (commission_id, user_id, party, invoice_number, invoice_date, supplier_gstin, taxable_amount, gst_amount, total_amount, file_path, file_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [commissionId, user.id, share.party, number, date, gstin, taxable, gst, r2(taxable + gst), path, String(file.originalname).slice(0, 200)]
  )).rows[0];
  await auditService.log({ actor: user, action: 'franchise.gst_invoice_uploaded', entityType: 'franchisee_commission', entityId: commissionId, after: { invoiceNumber: number, total: r2(taxable + gst) }, ...meta });
  const admins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active' LIMIT 20`)).rows;
  for (const a of admins) await notificationService.createNotification({ userId: a.id, type: 'franchise_commission', title: `GST invoice ${number} to review`, message: `${share.name}: Rs ${r2(taxable + gst).toLocaleString('en-IN')} for their commission share.`, relatedEntityType: 'franchisee_commission', relatedEntityId: commissionId }).catch(() => {});
  return invoiceView(inv);
}

async function listInvoices({ status } = {}) {
  const rows = (await pool.query(
    `SELECT i.*, u.full_name AS payee_name FROM commission_invoices i JOIN users u ON u.id = i.user_id ${status ? 'WHERE i.status = $1' : ''} ORDER BY i.created_at DESC LIMIT 300`,
    status ? [status] : []
  )).rows;
  const out = [];
  for (const r of rows) out.push({ ...invoiceView(r), fileUrl: await getReadUrl(r.file_path).catch(() => null) });
  return out;
}

async function reviewInvoice(staff, id, { decision, note } = {}, meta = {}) {
  if (!ADMIN.includes(staff.role)) throw forbidden('Only an admin approves commission invoices');
  if (!['approve', 'reject'].includes(decision)) throw badRequest('Approve or reject');
  if (decision === 'reject' && (!note || String(note).trim().length < 5)) throw badRequest('Say why - the sender is told');
  const r = (await pool.query(
    `UPDATE commission_invoices SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $4 AND status = 'submitted' RETURNING *`,
    [decision === 'approve' ? 'approved' : 'rejected', note ? String(note).trim().slice(0, 500) : null, staff.id, id]
  )).rows[0];
  if (!r) throw badRequest('This invoice has already been reviewed');
  await auditService.log({ actor: staff, action: `franchise.gst_invoice_${decision === 'approve' ? 'approved' : 'rejected'}`, entityType: 'commission_invoice', entityId: id, after: { note }, ...meta });
  await notificationService.createNotification({ userId: r.user_id, type: 'franchise_commission', title: decision === 'approve' ? `Invoice ${r.invoice_number} approved` : `Invoice ${r.invoice_number} not accepted`, message: decision === 'approve' ? 'Your share is paid once A R Buildwel releases this commission.' : String(note).trim(), relatedEntityType: 'franchisee_commission', relatedEntityId: r.commission_id }).catch(() => {});
  return invoiceView(r);
}

// ------------------------------------------------------------ release: invoices, TDS, payout lines

// What stops a release, and the payout line for each person if it goes ahead.
async function releasePlan(c, on = new Date()) {
  const need = await configService.getConfig('franchise.require_gst_invoice', true);
  const shares = payable(c);
  const invoices = (await pool.query(`SELECT * FROM commission_invoices WHERE commission_id = $1 AND status <> 'rejected'`, [c.id])).rows;
  const missing = need === false ? [] : shares.filter((s) => s.gstRegistered && !invoices.some((i) => i.user_id === s.userId && i.status === 'approved')).map((s) => s.name);
  const lines = [];
  for (const s of shares) {
    const pan = await panOf(s, c);
    const t = await tax.compute({ panHash: pan.hash, userId: s.userId, gross: s.base, on });
    const inv = invoices.find((i) => i.user_id === s.userId && i.status === 'approved');
    lines.push({ userId: s.userId, party: s.party, payeeName: pan.name || s.name, base: s.base, gst: s.gst, tdsRate: t.rate, tds: t.tds, net: r2(s.base + s.gst - t.tds), panHash: pan.hash, panLast4: pan.last4, fy: t.fy, invoiceId: inv?.id || null });
  }
  return { missingInvoices: missing, lines };
}

async function recordRelease(client, c, lines) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO commission_payout_lines (commission_id, user_id, party, payee_name, base_amount, gst_amount, tds_rate, tds_amount, net_amount, pan_last4, invoice_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (commission_id, user_id) DO NOTHING`,
      [c.id, l.userId, l.party, l.payeeName, l.base, l.gst, l.tdsRate, l.tds, l.net, l.panLast4, l.invoiceId]
    );
    await tax.record({ panHash: l.panHash, panLast4: l.panLast4, userId: l.userId, payeeName: l.payeeName, source: 'commission', sourceRef: c.id, fy: l.fy, gross: l.base, rate: l.tdsRate, tds: l.tds }, client);
  }
}

async function payoutLines(commissionId) {
  return (await pool.query('SELECT * FROM commission_payout_lines WHERE commission_id = $1 ORDER BY party', [commissionId])).rows.map((l) => ({
    userId: l.user_id, party: l.party, payeeName: l.payee_name, base: Number(l.base_amount), gst: Number(l.gst_amount), tdsRate: Number(l.tds_rate), tds: Number(l.tds_amount), net: Number(l.net_amount), panLast4: l.pan_last4,
  }));
}

// ------------------------------------------------------------ branded email

const DEFAULT_BRAND = { brandName: 'PropertySerch', firm: 'A R Buildwel', logoUrl: null, primaryColor: '#E51C23', fromName: 'PropertySerch', fromAddress: null, replyTo: null, footer: 'PropertySerch, a brand of A R Buildwel, G-53, Vardhman Location Plaza-II, Rajouri Garden, New Delhi - 110027' };

// The brand an email to this person carries: their franchise's published
// white-label branding, else PropertySerch / A R Buildwel.
async function brandFor(userId) {
  const b = (await pool.query(
    `SELECT b.*, f.status AS fstatus FROM users u JOIN franchisees f ON f.tenant_id = u.tenant_id JOIN franchisee_branding b ON b.franchisee_id = f.id
     WHERE u.id = $1 AND f.status = 'active' AND b.published_at IS NOT NULL AND b.brand_mode = 'white_label' LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }))).rows[0];
  if (!b) return { ...DEFAULT_BRAND, franchise: false };
  return {
    franchise: true, brandName: b.brand_name || DEFAULT_BRAND.brandName, firm: b.brand_name || DEFAULT_BRAND.firm, logoUrl: b.logo_url || null, primaryColor: /^#[0-9a-f]{6}$/i.test(b.primary_color || '') ? b.primary_color : DEFAULT_BRAND.primaryColor,
    fromName: b.email_from_name || b.brand_name || DEFAULT_BRAND.fromName, fromAddress: b.email_from_address || null, replyTo: b.email_reply_to || null, footer: b.footer_text || DEFAULT_BRAND.footer,
  };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The HTML of a branded email (also the template to load into the email provider).
function renderEmail(brand, { title, body, ctaLabel, ctaUrl }) {
  const c = brand.primaryColor;
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${c};padding:18px 24px">${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.brandName)}" height="32" style="display:block">` : `<span style="color:#ffffff;font-size:20px;font-weight:bold">${esc(brand.brandName)}</span>`}</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 12px;font-size:20px">${esc(title)}</h1><p style="margin:0;font-size:15px;line-height:22px;white-space:pre-line">${esc(body)}</p>
${ctaUrl ? `<p style="margin:20px 0 0"><a href="${esc(ctaUrl)}" style="background:${c};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold;display:inline-block">${esc(ctaLabel || 'Open')}</a></p>` : ''}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eeeeee;font-size:12px;color:#6b7280">${esc(brand.footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

async function emailPreview(user, { title = 'Your site visit is confirmed', body = 'Your representative will meet you at the property on Saturday at 11 am.' } = {}) {
  const brand = await brandFor(user.id);
  return { brand, html: renderEmail(brand, { title, body, ctaLabel: 'View details', ctaUrl: 'https://propertyserch.com' }) };
}

// ------------------------------------------------------------ domains and SSL

// Pure decision from what DNS and the certificate say (kept apart for tests).
function domainState({ host, target, cnames = [], addresses = [], targetAddresses = [], cert = null, now = Date.now() }) {
  const t = String(target || '').toLowerCase().replace(/\.$/, '');
  const pointsByCname = cnames.some((c) => String(c).toLowerCase().replace(/\.$/, '') === t);
  const pointsByIp = addresses.length > 0 && (addresses.some((a) => a === t) || addresses.some((a) => targetAddresses.includes(a)));
  if (!pointsByCname && !pointsByIp) {
    return { status: 'pending_dns', detail: addresses.length || cnames.length ? `${host} points somewhere else (${[...cnames, ...addresses].slice(0, 3).join(', ')}). Point it to ${t}.` : `${host} does not resolve yet. Create a CNAME record to ${t}.` };
  }
  if (!cert) return { status: 'ssl_pending', detail: 'DNS is correct. The certificate has not been issued yet - it is issued on the first visit to the domain.' };
  const expires = new Date(cert.validTo).getTime();
  const names = [cert.subjectCN, ...(cert.altNames || [])].map((n) => String(n || '').toLowerCase());
  const covers = names.some((n) => n === host || (n.startsWith('*.') && host.endsWith(n.slice(1)) && host.split('.').length === n.split('.').length));
  if (!covers) return { status: 'error', detail: `The certificate served is for ${names.filter(Boolean).slice(0, 2).join(', ')}, not ${host}.` };
  if (expires <= now) return { status: 'error', detail: 'The certificate has expired.' };
  return { status: 'live', detail: `Secure. Certificate from ${cert.issuer || 'the certificate authority'}, valid until ${new Date(expires).toISOString().slice(0, 10)}.` };
}

function readCert(host, port = 443) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
      const c = socket.getPeerCertificate();
      socket.end();
      if (!c || !c.valid_to) return resolve(null);
      resolve({ validTo: c.valid_to, issuer: c.issuer?.O || c.issuer?.CN || null, subjectCN: c.subject?.CN, altNames: String(c.subjectaltname || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean), trusted: socket.authorized });
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function checkDomain(franchiseeId, { actor } = {}) {
  const b = (await pool.query('SELECT * FROM franchisee_branding WHERE franchisee_id = $1', [franchiseeId])).rows[0];
  if (!b) throw notFound('Franchisee not found');
  if (!b.host) {
    await pool.query(`UPDATE franchisee_branding SET domain_status = 'none', dns_detail = NULL, dns_checked_at = now() WHERE franchisee_id = $1`, [franchiseeId]);
    return { status: 'none', detail: 'No domain is mapped yet.' };
  }
  const target = String(await configService.getConfig('franchise.domain_target', 'partners.propertyserch.com'));
  const safe = (p) => p.catch(() => []);
  const [cnames, addresses, targetAddresses] = await Promise.all([safe(dns.resolveCname(b.host)), safe(dns.resolve4(b.host)), /^\d+\.\d+\.\d+\.\d+$/.test(target) ? [target] : safe(dns.resolve4(target))]);
  const dnsOk = domainState({ host: b.host, target, cnames, addresses, targetAddresses }).status !== 'pending_dns';
  const cert = dnsOk ? await readCert(b.host) : null;
  const state = domainState({ host: b.host, target, cnames, addresses, targetAddresses, cert });
  await pool.query(
    `UPDATE franchisee_branding SET domain_status = $2, dns_detail = $3, dns_checked_at = now(), ssl_issuer = $4, ssl_expires_at = $5, ssl_checked_at = CASE WHEN $6 THEN now() ELSE ssl_checked_at END WHERE franchisee_id = $1`,
    [franchiseeId, state.status, state.detail, cert?.issuer || null, cert ? new Date(cert.validTo) : null, dnsOk]
  );
  if (actor) await auditService.log({ actor, action: 'franchise.domain_checked', entityType: 'franchisee', entityId: franchiseeId, after: { host: b.host, status: state.status } });
  return { host: b.host, target, ...state, sslExpiresAt: cert ? new Date(cert.validTo) : null, sslIssuer: cert?.issuer || null };
}

// For the edge server's on-demand TLS ("ask" URL): issue a certificate only
// for a host mapped to an active franchisee whose domain is switched on.
async function tlsAllowed(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return (await pool.query(`SELECT 1 FROM franchisee_branding b JOIN franchisees f ON f.id = b.franchisee_id WHERE b.host = $1 AND b.domain_active AND f.status IN ('active', 'pending')`, [h])).rows.length > 0;
}

// Daily: re-check every mapped domain; warn the admins about certificates near expiry.
async function sweepDomains() {
  const rows = (await pool.query(`SELECT franchisee_id FROM franchisee_branding WHERE host IS NOT NULL`)).rows;
  const warnDays = Number(await configService.getConfig('franchise.ssl_warn_days', 14)) || 14;
  let warned = 0;
  for (const r of rows) {
    const s = await checkDomain(r.franchisee_id).catch(() => null);
    if (s?.sslExpiresAt && new Date(s.sslExpiresAt) - Date.now() < warnDays * 86400000) {
      warned += 1;
      const admins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'super_admin' AND u.status = 'active' LIMIT 20`)).rows;
      for (const a of admins) await notificationService.createNotification({ userId: a.id, type: 'franchise_domain', priority: 'high', title: `Certificate for ${s.host} expires soon`, message: `Valid until ${new Date(s.sslExpiresAt).toISOString().slice(0, 10)}. Check the edge server's automatic renewal.`, relatedEntityType: 'franchisee', relatedEntityId: r.franchisee_id }).catch(() => {});
    }
  }
  return { checked: rows.length, warned };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweepDomains().catch((err) => console.error('[franchise] domain sweep failed:', err.message)), 6 * 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = {
  taxProfile, saveTaxProfile, verifyPan, panOf, myShares, uploadInvoice, listInvoices, reviewInvoice, releasePlan, recordRelease, payoutLines,
  brandFor, renderEmail, emailPreview, domainState, checkDomain, tlsAllowed, sweepDomains, startScheduler,
};

// The sending address of a franchisee's branded email. A R Buildwel owns the
// domains, so only an admin sets it, on a domain the email provider has verified.
async function setEmailSender(admin, franchiseeId, { fromAddress, replyTo } = {}, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Only an admin sets the sending address');
  const email = (v) => (v ? String(v).trim().toLowerCase() : null);
  const from = email(fromAddress);
  const reply = email(replyTo);
  const ok = (v) => !v || /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v);
  if (!ok(from) || !ok(reply)) throw badRequest('Enter valid email addresses');
  const r = await pool.query('UPDATE franchisee_branding SET email_from_address = $2, email_reply_to = $3, updated_at = now() WHERE franchisee_id = $1', [franchiseeId, from, reply]);
  if (!r.rowCount) throw notFound('Franchisee not found');
  await auditService.log({ actor: admin, action: 'franchise.email_sender_set', entityType: 'franchisee', entityId: franchiseeId, after: { fromAddress: from, replyTo: reply }, ...meta });
  return { fromAddress: from, replyTo: reply };
}
module.exports.setEmailSender = setEmailSender;
