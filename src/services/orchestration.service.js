const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { formatInr } = require('../utils/price');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 40 - Transaction Orchestration Engine.
//   - Dependency tracking: a deal cannot enter a stage until the previous
//     stage is complete (its requirements are met); admins may override
//     with a logged reason.
//   - Auto-advance: as soon as the next stage's requirements are met (visit
//     scheduled / completed, deal value, ATS executed, agreement approved,
//     Sale Deed executed + everything paid) the deal moves on by itself.
//   - SLA per stage with delay alerts to the broker and admins.
//   - Deal health score (0-100) - the deal-failure early warning.
//   - Professional-fee invoices: Instalment 1 on the ATS execution date,
//     Instalment 2 on the Sale Deed execution date (execution = registration,
//     one act), a single invoice on lease execution; CGST + SGST for
//     residents, IGST for NRI / OCI; net-7 due; day-8 overdue alerts. The
//     deal is not fully closed until the instalments are paid.

const FLOW = ['inquiry', 'site_visit', 'negotiation', 'booking', 'documentation', 'payment', 'closed_won'];
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const DEFAULT_SLA = { inquiry: 2, site_visit: 5, negotiation: 7, booking: 5, documentation: 15, payment: 30 };
const STAGE_LABEL = {
  inquiry: 'Enquiry', site_visit: 'Site visit', negotiation: 'Negotiation', booking: 'Booking', documentation: 'Documentation', payment: 'Payment', closed_won: 'Closed',
};

async function cfg() {
  const [sla, auto, needPaid, rate, split, gst, gstin, dueDays, parties, note] = await Promise.all([
    configService.getConfig('orchestration.stage_sla_days', DEFAULT_SLA),
    configService.getConfig('orchestration.auto_advance', true),
    configService.getConfig('orchestration.require_invoices_paid_to_close', true),
    configService.getConfig('invoice.fee_rate_percent', 1),
    configService.getConfig('invoice.instalment_split', { instalment_1: 50, instalment_2: 50 }),
    configService.getConfig('invoice.gst', { cgst: 9, sgst: 9, igst: 18 }),
    configService.getConfig('invoice.gstin', '07DERPR1574G2ZY'),
    configService.getConfig('invoice.due_days', 7),
    configService.getConfig('invoice.parties', ['buyer']),
    configService.getConfig('invoice.sale_deed_note', ''),
  ]);
  return {
    sla: { ...DEFAULT_SLA, ...(sla || {}) },
    auto: auto !== false,
    needPaid: needPaid !== false,
    rate: Number(rate),
    split: { instalment_1: 50, instalment_2: 50, ...(split || {}) },
    gst: { cgst: 9, sgst: 9, igst: 18, ...(gst || {}) },
    gstin,
    dueDays: Number(dueDays) || 7,
    parties: parties || ['buyer'],
    note,
  };
}

async function logEvent(dealId, kind, { from = null, to = null, detail = {}, actorId = null } = {}) {
  await pool.query(
    `INSERT INTO orchestration_events (deal_id, kind, from_stage, to_stage, detail, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [dealId, kind, from, to, JSON.stringify(detail), actorId]
  );
}

async function loadDeal(dealId) {
  const d = (
    await pool.query(
      `SELECT d.*, p.transaction_type, p.title AS property_title, p.created_by AS lister_id, p.city
       FROM deals d LEFT JOIN properties p ON p.id = d.property_id WHERE d.id = $1`,
      [dealId]
    )
  ).rows[0];
  if (!d) throw notFound('Deal not found');
  d.isRent = d.transaction_type === 'rent';
  return d;
}

// ------------------------------------------------------------ requirements

// What entering `stage` needs. Returns [{ key, label, met }].
async function requirementsFor(deal, stage, c) {
  const q = (sql, params = [deal.id]) => pool.query(sql, params).then((r) => r.rows[0]);
  const visits = await q(
    `SELECT COUNT(*) FILTER (WHERE status IN ('scheduled', 'completed'))::int AS any, COUNT(*) FILTER (WHERE status = 'completed')::int AS done
     FROM site_visits WHERE deal_id = $1`
  );
  const req = [];
  if (stage === 'site_visit') req.push({ key: 'visit_scheduled', label: 'A site visit is scheduled', met: visits.any > 0 });
  if (stage === 'negotiation') req.push({ key: 'visit_completed', label: 'A site visit is completed', met: visits.done > 0 });
  if (stage === 'booking') req.push({ key: 'deal_value', label: 'Agreed deal value recorded', met: Number(deal.deal_value) > 0 });
  if (stage === 'documentation') {
    if (deal.isRent) req.push({ key: 'lease_executed', label: 'Lease / leave-and-licence execution date recorded', met: !!deal.lease_execution_date });
    else req.push({ key: 'ats_executed', label: 'Agreement to Sell execution date recorded', met: !!deal.ats_execution_date });
  }
  if (stage === 'payment') {
    if (deal.isRent) {
      req.push({ key: 'lease_invoice', label: 'Lease professional-fee invoice issued', met: !!deal.lease_invoice_id });
    } else {
      const agreement = await q(
        `SELECT COUNT(*)::int AS n FROM documents
         WHERE (deal_id = $1 OR property_id = $2) AND status = 'approved' AND document_type IN ('agreement', 'agreement_to_sell')`,
        [deal.id, deal.property_id]
      );
      req.push({ key: 'agreement_approved', label: 'Signed agreement document approved', met: agreement.n > 0 });
    }
  }
  if (stage === 'closed_won') {
    if (deal.isRent) {
      const inv = deal.lease_invoice_id ? await q(`SELECT status FROM invoices WHERE id = $1`, [deal.lease_invoice_id]) : null;
      if (c.needPaid) req.push({ key: 'lease_invoice_paid', label: 'Lease invoice paid', met: ['paid', 'waived'].includes(inv?.status) });
    } else {
      req.push({ key: 'sale_deed_executed', label: 'Sale Deed execution (= registration) date recorded', met: !!deal.sale_deed_execution_date });
      const ms = await q(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('paid', 'waived'))::int AS open FROM payment_milestones WHERE deal_id = $1`);
      req.push({ key: 'milestones_paid', label: 'All payment milestones paid', met: ms.open === 0 });
      if (c.needPaid) {
        const inv = await q(
          `SELECT COUNT(*) FILTER (WHERE status NOT IN ('paid', 'waived'))::int AS open, COUNT(*)::int AS n
           FROM invoices WHERE deal_id = $1 AND kind IN ('instalment_1', 'instalment_2')`
        );
        req.push({ key: 'instalments_paid', label: 'Both professional-fee instalments paid', met: inv.n >= 1 && inv.open === 0 && !!deal.instalment_2_invoice_id });
      }
    }
  }
  return req;
}

function nextStage(stage) {
  const i = FLOW.indexOf(stage);
  return i >= 0 && i < FLOW.length - 1 ? FLOW[i + 1] : null;
}

// Guard used by deal.service.changeStage for every forward move.
async function assertCanEnter(dealId, toStage, user, { override = false, notes } = {}) {
  if (!FLOW.includes(toStage) || toStage === 'inquiry') return;
  const deal = await loadDeal(dealId);
  const c = await cfg();
  const missing = (await requirementsFor(deal, toStage, c)).filter((r) => !r.met);
  if (!missing.length) return;
  if (override) {
    if (!ADMIN.includes(user.role)) throw forbidden('Only admins can override stage requirements');
    if (!notes) throw badRequest('Give a reason for the override');
    await logEvent(dealId, 'override', { from: deal.stage, to: toStage, detail: { missing: missing.map((m) => m.key), notes }, actorId: user.id });
    return;
  }
  const err = badRequest(`Cannot move to ${STAGE_LABEL[toStage]} yet - ${missing.map((m) => m.label).join('; ')}`);
  err.details = { missing };
  throw err;
}

// ---------------------------------------------------------------- invoices

function fyOf(date) {
  const d = new Date(date);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

async function partyInfo(deal, party) {
  let customer = null;
  if (party === 'buyer' || party === 'tenant') {
    customer = (await pool.query('SELECT id, user_id, full_name FROM customers WHERE id = $1', [deal.customer_id])).rows[0];
  } else {
    const lister = (await pool.query(`SELECT u.id, u.full_name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [deal.lister_id])).rows[0];
    if (!lister || lister.role !== 'customer') return null; // seller invoiced only when they are a platform customer
    customer = (await pool.query('SELECT id, user_id, full_name FROM customers WHERE user_id = $1', [lister.id])).rows[0] || { id: null, user_id: lister.id, full_name: lister.full_name };
  }
  if (!customer) return null;
  const nri = customer.user_id
    ? (await pool.query(`SELECT 1 FROM investor_profiles WHERE user_id = $1 AND (is_nri OR residency_status IN ('nri', 'oci', 'pio'))`, [customer.user_id])).rows.length > 0
    : false;
  return { ...customer, nri };
}

async function createInvoice(deal, kind, party, triggerDate, c) {
  if (!(c.rate >= 1)) throw badRequest('Professional fee rate is locked at 1% minimum - invoice refused');
  const who = await partyInfo(deal, party);
  if (!who) return null;
  const gross = Number(deal.deal_value);
  if (!(gross > 0)) {
    await logEvent(deal.id, 'blocked', { detail: { reason: 'deal_value_missing_for_invoice', kind } });
    return null;
  }
  const exists = (await pool.query(`SELECT * FROM invoices WHERE deal_id = $1 AND kind = $2 AND party = $3`, [deal.id, kind, party])).rows[0];
  if (exists) return exists;
  const share = kind === 'lease' ? 100 : Number(c.split[kind]) || 50;
  // Lease: one month's gross rent (deal value holds the monthly rent).
  const fee = kind === 'lease' ? gross : Math.round(gross * (c.rate / 100) * (share / 100) * 100) / 100;
  const r2 = (x) => Math.round(x * 100) / 100;
  const cgst = who.nri ? 0 : r2((fee * c.gst.cgst) / 100);
  const sgst = who.nri ? 0 : r2((fee * c.gst.sgst) / 100);
  const igst = who.nri ? r2((fee * c.gst.igst) / 100) : 0;
  const n = (await pool.query(`SELECT nextval('invoice_number_seq') AS n`)).rows[0].n;
  const number = `ARB/${fyOf(new Date())}/${String(n).padStart(6, '0')}`;
  const note =
    kind === 'instalment_2' ? c.note
    : kind === 'lease' ? 'Professional fee for the lease / leave-and-licence: one month\'s gross rent.'
    : 'Instalment 1 of the professional fee, raised on execution of the Agreement to Sell.';
  const inv = (
    await pool.query(
      `INSERT INTO invoices (invoice_number, deal_id, kind, party, liable_customer_id, liable_user_id, liable_name, gross_value, fee_rate_percent,
         instalment_percent, fee_amount, gst_type, cgst_amount, sgst_amount, igst_amount, total_amount, gstin, note, trigger_date, due_date, sent_channels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, CURRENT_DATE + $20::int, $21)
       RETURNING *`,
      [number, deal.id, kind, party, who.id, who.user_id, who.full_name, gross, Math.max(1, c.rate), share, fee, who.nri ? 'igst' : 'cgst_sgst',
        cgst, sgst, igst, r2(fee + cgst + sgst + igst), c.gstin, note, triggerDate, c.dueDays, JSON.stringify(['in_app'])]
    )
  ).rows[0];
  if (party === 'buyer' || party === 'tenant') {
    const col = { instalment_1: 'instalment_1_invoice_id', instalment_2: 'instalment_2_invoice_id', lease: 'lease_invoice_id' }[kind];
    await pool.query(`UPDATE deals SET ${col} = $1 WHERE id = $2`, [inv.id, deal.id]);
    deal[col] = inv.id;
  }
  if (who.user_id) {
    await notificationService.createNotification({
      userId: who.user_id,
      type: 'invoice',
      title: `Invoice ${number} - ${formatInr(inv.total_amount)}`,
      message: `${kind === 'lease' ? 'Lease' : kind === 'instalment_1' ? 'Instalment 1' : 'Instalment 2'} professional fee for ${deal.property_title || 'your deal'}. Due by ${new Date(inv.due_date).toLocaleDateString('en-IN')}.`,
      relatedEntityType: 'invoice',
      relatedEntityId: inv.id,
    });
  }
  await logEvent(deal.id, 'invoice', { detail: { invoiceId: inv.id, number, kind, party, total: Number(inv.total_amount) } });
  return inv;
}

async function generateInvoices(deal, c) {
  const out = [];
  if (deal.isRent) {
    if (deal.lease_execution_date) out.push(await createInvoice(deal, 'lease', 'tenant', deal.lease_execution_date, c));
    return out.filter(Boolean);
  }
  for (const party of c.parties) {
    if (deal.ats_execution_date) out.push(await createInvoice(deal, 'instalment_1', party, deal.ats_execution_date, c));
    if (deal.sale_deed_execution_date) out.push(await createInvoice(deal, 'instalment_2', party, deal.sale_deed_execution_date, c));
  }
  return out.filter(Boolean);
}

// ----------------------------------------------------------------- health

async function computeHealth(deal, c) {
  const factors = [];
  const add = (points, label) => factors.push({ points, label });
  if (['closed_won', 'closed_lost'].includes(deal.stage)) return { score: null, band: null, factors: [] };
  if (deal.stage === 'on_hold') add(-20, 'Deal is on hold');
  const days = (Date.now() - new Date(deal.stage_entered_at).getTime()) / 86400000;
  const limit = c.sla[deal.stage];
  if (limit) {
    if (days > limit) add(-Math.min(30, 5 + Math.round((days - limit) * 3)), `${Math.round(days - limit)} day(s) over the ${limit}-day ${STAGE_LABEL[deal.stage]} SLA`);
    else if (days >= limit * 0.75) add(-5, `${STAGE_LABEL[deal.stage]} SLA due soon`);
  }
  const [activity, milestones, invoices, dd, disputes, noShows] = await Promise.all([
    pool.query(
      `SELECT GREATEST(
         (SELECT MAX(created_at) FROM deal_stage_history WHERE deal_id = $1),
         (SELECT MAX(updated_at) FROM site_visits WHERE deal_id = $1),
         (SELECT MAX(updated_at) FROM payments WHERE deal_id = $1),
         (SELECT MAX(created_at) FROM lead_notes WHERE lead_id = $2),
         (SELECT MAX(created_at) FROM orchestration_events WHERE deal_id = $1 AND kind <> 'sla_alert')
       ) AS last`,
      [deal.id, deal.lead_id]
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM payment_milestones WHERE deal_id = $1 AND (status = 'overdue' OR (status = 'pending' AND due_date < now()))`, [deal.id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE deal_id = $1 AND (status = 'overdue' OR (status = 'invoiced' AND due_date < CURRENT_DATE))`, [deal.id]),
    deal.property_id ? pool.query(`SELECT status, risk_flags FROM property_due_diligence WHERE property_id = $1`, [deal.property_id]) : { rows: [] },
    pool.query(`SELECT COUNT(*)::int AS n FROM disputes WHERE (deal_id = $1 OR property_id = $2) AND status IN ('open', 'under_review', 'awaiting_info')`, [deal.id, deal.property_id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM site_visits WHERE deal_id = $1 AND status = 'no_show'`, [deal.id]),
  ]);
  const last = activity.rows[0].last ? new Date(activity.rows[0].last) : new Date(deal.created_at);
  const idle = (Date.now() - last.getTime()) / 86400000;
  if (idle > 14) add(-15, `No activity for ${Math.floor(idle)} days`);
  else if (idle > 7) add(-8, `No activity for ${Math.floor(idle)} days`);
  if (milestones.rows[0].n) add(-Math.min(25, 10 * milestones.rows[0].n), `${milestones.rows[0].n} payment milestone(s) overdue`);
  if (invoices.rows[0].n) add(-15, 'Professional-fee invoice overdue');
  const ddRow = dd.rows[0];
  if (ddRow?.status === 'issues') {
    const high = (ddRow.risk_flags || []).filter((f) => f.severity === 'high').length;
    add(-Math.min(20, 10 + 3 * high), `Due-diligence issues on the property${high ? ` (${high} high)` : ''}`);
  }
  if (disputes.rows[0].n) add(-15, 'Open dispute on this deal / property');
  if (noShows.rows[0].n) add(-10, `${noShows.rows[0].n} site-visit no-show(s)`);
  const score = Math.max(0, Math.min(100, 100 + factors.reduce((s, f) => s + f.points, 0)));
  const band = score >= 70 ? 'healthy' : score >= 40 ? 'at_risk' : 'critical';
  await pool.query(`UPDATE deals SET health_score = $1, health_band = $2, health_factors = $3, health_computed_at = now() WHERE id = $4`, [score, band, JSON.stringify(factors), deal.id]);
  return { score, band, factors, failureRisk: Math.round(100 - score) };
}

// --------------------------------------------------------------- evaluate

// Re-evaluate a deal: issue due invoices, auto-advance while the next
// stage's requirements are met, refresh health. Safe to call often.
async function evaluate(dealId, { actor = null } = {}) {
  const c = await cfg();
  let deal = await loadDeal(dealId);
  const invoices = await generateInvoices(deal, c);
  const advanced = [];
  let guard = 0;
  while (c.auto && guard < FLOW.length) {
    guard += 1;
    if (['closed_won', 'closed_lost', 'on_hold'].includes(deal.stage)) break;
    const next = nextStage(deal.stage);
    if (!next) break;
    const reqs = await requirementsFor(deal, next, c);
    if (reqs.some((r) => !r.met)) break;
    // System move: deal_stage_history.changed_by stays null (or the user whose action triggered it).
    await require('./deal.service').changeStage(deal.id, next, { id: actor?.id || null, role: 'system' }, `Auto-advanced: ${reqs.map((r) => r.label).join('; ')}`, { orchestrated: true });
    await logEvent(deal.id, 'auto_advance', { from: deal.stage, to: next, detail: { met: reqs.map((r) => r.key) }, actorId: actor?.id || null });
    advanced.push(next);
    deal = await loadDeal(dealId);
    if (next === 'closed_won') break;
  }
  const health = await computeHealth(deal, c);
  const next = nextStage(deal.stage);
  const nextRequirements = next && !['closed_won', 'closed_lost'].includes(deal.stage) ? await requirementsFor(deal, next, c) : [];
  return { stage: deal.stage, advanced, invoices: invoices.map((i) => i.invoice_number), next, nextRequirements, health };
}

function safeEvaluate(dealId) {
  if (!dealId) return;
  evaluate(dealId).catch((err) => console.error(`[orchestration] evaluate ${dealId} failed:`, err.message));
}

async function evaluateForProperty(propertyId) {
  const r = await pool.query(`SELECT id FROM deals WHERE property_id = $1 AND stage NOT IN ('closed_won', 'closed_lost')`, [propertyId]);
  for (const d of r.rows) safeEvaluate(d.id);
}

// Rep records the key execution dates (ATS / Sale Deed / lease).
async function recordDates(user, dealId, { atsExecutionDate, saleDeedExecutionDate, leaseExecutionDate }, meta = {}) {
  const deal = await loadDeal(dealId);
  if (!STAFF.includes(user.role) && deal.broker_id !== user.id) throw forbidden('Only the A R representative or the deal broker records execution dates');
  const set = [];
  const params = [];
  const add = (col, v) => {
    if (v === undefined) return;
    if (v && new Date(v) > new Date()) throw badRequest('Execution dates cannot be in the future');
    params.push(v || null);
    set.push(`${col} = $${params.length}`);
  };
  if (deal.isRent) add('lease_execution_date', leaseExecutionDate);
  else {
    add('ats_execution_date', atsExecutionDate);
    if (saleDeedExecutionDate !== undefined && !(atsExecutionDate || deal.ats_execution_date)) throw badRequest('Record the Agreement to Sell execution date first');
    add('sale_deed_execution_date', saleDeedExecutionDate);
  }
  if (!set.length) throw badRequest(deal.isRent ? 'Give the lease execution date' : 'Give the ATS and / or Sale Deed execution date');
  params.push(dealId);
  await pool.query(`UPDATE deals SET ${set.join(', ')} WHERE id = $${params.length}`, params);
  await auditService.log({ actor: user, action: 'deal.execution_dates', entityType: 'deal', entityId: dealId, after: { atsExecutionDate, saleDeedExecutionDate, leaseExecutionDate }, ...meta });
  return evaluate(dealId, { actor: user });
}

async function recordInvoicePayment(user, invoiceId, { reference, waive = false, note }, meta = {}) {
  const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) throw notFound('Invoice not found');
  if (['paid', 'waived'].includes(inv.status)) throw badRequest('Invoice already settled');
  if (waive && !ADMIN.includes(user.role)) throw forbidden('Only admins can waive an invoice');
  if (waive && !note) throw badRequest('A reason is required to waive');
  await pool.query(
    `UPDATE invoices SET status = $1::varchar, paid_at = CASE WHEN $1::varchar = 'paid' THEN now() ELSE NULL END, payment_reference = $2, recorded_by = $3 WHERE id = $4`,
    [waive ? 'waived' : 'paid', reference || note || null, user.id, invoiceId]
  );
  await auditService.log({ actor: user, action: waive ? 'invoice.waived' : 'invoice.paid', entityType: 'invoice', entityId: invoiceId, after: { reference, note }, ...meta });
  await logEvent(inv.deal_id, 'invoice', { detail: { invoiceId, status: waive ? 'waived' : 'paid' }, actorId: user.id });
  return evaluate(inv.deal_id, { actor: user });
}

async function listInvoices(user, { status, dealId } = {}) {
  const where = [];
  const params = [];
  if (!STAFF.includes(user.role)) {
    params.push(user.id);
    where.push(`(i.liable_user_id = $${params.length} OR d.broker_id = $${params.length})`);
  }
  if (status === 'overdue') where.push(`(i.status = 'overdue' OR (i.status = 'invoiced' AND i.due_date < CURRENT_DATE))`);
  else if (status) {
    params.push(status);
    where.push(`i.status = $${params.length}`);
  }
  if (dealId) {
    params.push(dealId);
    where.push(`i.deal_id = $${params.length}`);
  }
  const r = await pool.query(
    `SELECT i.*, p.title AS property_title, (i.status IN ('invoiced', 'overdue') AND i.due_date < CURRENT_DATE) AS is_overdue,
            GREATEST(0, CURRENT_DATE - i.due_date) AS days_overdue
     FROM invoices i JOIN deals d ON d.id = i.deal_id LEFT JOIN properties p ON p.id = d.property_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.created_at DESC LIMIT 500`,
    params
  );
  return r.rows;
}

async function invoicePdf(user, invoiceId) {
  const inv = (
    await pool.query(
      `SELECT i.*, p.title AS property_title, d.broker_id FROM invoices i JOIN deals d ON d.id = i.deal_id LEFT JOIN properties p ON p.id = d.property_id WHERE i.id = $1`,
      [invoiceId]
    )
  ).rows[0];
  if (!inv || (!STAFF.includes(user.role) && inv.liable_user_id !== user.id && inv.broker_id !== user.id)) throw notFound('Invoice not found');
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (text, { size = 11, f = font, x = 50, color = rgb(0.1, 0.1, 0.15) } = {}) => {
    page.drawText(String(text), { x, y, size, font: f, color });
    y -= size + 8;
  };
  const money = (v) => `INR ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  line('A R Buildwel - PropertySerch.com', { size: 16, f: bold });
  line(`GSTIN: ${inv.gstin}`);
  y -= 6;
  line(`TAX INVOICE ${inv.invoice_number}`, { size: 14, f: bold });
  line(`Issue date: ${new Date(inv.issue_date).toLocaleDateString('en-IN')}    Due date: ${new Date(inv.due_date).toLocaleDateString('en-IN')}`);
  line(`Billed to: ${inv.liable_name || '-'} (${inv.party})`);
  if (inv.property_title) line(`Property: ${inv.property_title}`);
  y -= 6;
  const kind = { instalment_1: 'Instalment 1 - on Agreement to Sell execution', instalment_2: 'Instalment 2 - on Sale Deed execution', lease: 'Lease professional fee' }[inv.kind];
  line(kind, { f: bold });
  line(`Trigger date: ${new Date(inv.trigger_date).toLocaleDateString('en-IN')}`);
  line(`Gross transaction value: ${money(inv.gross_value)}`);
  if (inv.kind !== 'lease') line(`Professional fee: ${Number(inv.instalment_percent)}% of ${Number(inv.fee_rate_percent)}% of gross value`);
  line(`Professional fee: ${money(inv.fee_amount)}`, { f: bold });
  if (inv.gst_type === 'igst') line(`IGST @ 18%: ${money(inv.igst_amount)}`);
  else {
    line(`CGST @ 9%: ${money(inv.cgst_amount)}`);
    line(`SGST @ 9%: ${money(inv.sgst_amount)}`);
  }
  line(`Total payable: ${money(inv.total_amount)}`, { size: 13, f: bold });
  y -= 10;
  if (inv.note) {
    const words = String(inv.note).split(' ');
    let buf = '';
    for (const w of words) {
      if ((buf + w).length > 90) {
        line(buf, { size: 9 });
        buf = '';
      }
      buf += `${w} `;
    }
    if (buf) line(buf, { size: 9 });
  }
  line(`Status: ${inv.status}${inv.payment_reference ? ` (ref ${inv.payment_reference})` : ''}`, { size: 9 });
  return Buffer.from(await pdf.save());
}

// -------------------------------------------------------------- scheduler

async function slaSweep() {
  const c = await cfg();
  const deals = await pool.query(
    `SELECT d.id, d.stage, d.stage_entered_at, d.broker_id, d.lead_id, p.title FROM deals d LEFT JOIN properties p ON p.id = d.property_id
     WHERE d.stage NOT IN ('closed_won', 'closed_lost', 'on_hold') AND d.sla_alerted_stage IS DISTINCT FROM d.stage::text`
  );
  const admins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`)).rows.map((r) => r.id);
  let alerted = 0;
  for (const d of deals.rows) {
    const limit = c.sla[d.stage];
    if (!limit) continue;
    const days = (Date.now() - new Date(d.stage_entered_at).getTime()) / 86400000;
    if (days <= limit) continue;
    for (const uid of new Set([d.broker_id, ...admins].filter(Boolean))) {
      await notificationService.createNotification({
        userId: uid,
        type: 'deal_sla',
        title: `Deal stuck in ${STAGE_LABEL[d.stage]}`,
        message: `${d.title || 'A deal'} has been in ${STAGE_LABEL[d.stage]} for ${Math.floor(days)} days (SLA ${limit}).`,
        relatedEntityType: 'deal',
        relatedEntityId: d.id,
      });
    }
    await pool.query(`UPDATE deals SET sla_alerted_stage = stage::text WHERE id = $1`, [d.id]);
    await logEvent(d.id, 'sla_alert', { from: d.stage, detail: { days: Math.floor(days), limit } });
    alerted += 1;
  }
  return { alerted };
}

async function invoiceSweep() {
  const r = await pool.query(
    `UPDATE invoices SET status = 'overdue', overdue_alerted_at = now()
     WHERE status = 'invoiced' AND due_date < CURRENT_DATE AND overdue_alerted_at IS NULL
     RETURNING id, deal_id, invoice_number, liable_user_id, total_amount`
  );
  const admins = r.rows.length ? (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`)).rows.map((x) => x.id) : [];
  for (const inv of r.rows) {
    const deal = (await pool.query(`SELECT d.broker_id, l.assigned_to FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.id = $1`, [inv.deal_id])).rows[0] || {};
    for (const uid of new Set([inv.liable_user_id, deal.broker_id, deal.assigned_to, ...admins].filter(Boolean))) {
      await notificationService.createNotification({
        userId: uid,
        type: 'invoice_overdue',
        title: `Invoice ${inv.invoice_number} overdue`,
        message: `${formatInr(inv.total_amount)} is past its due date.`,
        relatedEntityType: 'invoice',
        relatedEntityId: inv.id,
      });
    }
    await logEvent(inv.deal_id, 'invoice_overdue', { detail: { invoiceId: inv.id } });
  }
  return { overdue: r.rows.length };
}

async function healthSweep() {
  const r = await pool.query(`SELECT id FROM deals WHERE stage NOT IN ('closed_won', 'closed_lost')`);
  const c = await cfg();
  for (const { id } of r.rows) {
    try {
      await computeHealth(await loadDeal(id), c);
    } catch (err) {
      console.error(`[orchestration] health ${id}:`, err.message);
    }
  }
  return { deals: r.rows.length };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      await slaSweep();
      await invoiceSweep();
      await healthSweep();
    } catch (err) {
      console.error('[orchestration] sweep failed:', err.message);
    }
  }, 60 * 60 * 1000);
}

async function dealView(user, dealId) {
  const deal = await loadDeal(dealId);
  if (!STAFF.includes(user.role) && deal.broker_id !== user.id) throw forbidden('Not your deal');
  const c = await cfg();
  const next = nextStage(deal.stage);
  const [events, invoices, health] = await Promise.all([
    pool.query(`SELECT e.*, u.full_name AS actor_name FROM orchestration_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.deal_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [dealId]),
    listInvoices({ role: 'admin' }, { dealId }),
    computeHealth(deal, c),
  ]);
  const days = (Date.now() - new Date(deal.stage_entered_at).getTime()) / 86400000;
  return {
    dealId,
    stage: deal.stage,
    stageEnteredAt: deal.stage_entered_at,
    daysInStage: Math.floor(days),
    slaDays: c.sla[deal.stage] || null,
    slaOverdue: c.sla[deal.stage] ? days > c.sla[deal.stage] : false,
    next,
    nextRequirements: next && !['closed_won', 'closed_lost'].includes(deal.stage) ? await requirementsFor(deal, next, c) : [],
    flow: FLOW,
    isRent: deal.isRent,
    dates: { atsExecutionDate: deal.ats_execution_date, saleDeedExecutionDate: deal.sale_deed_execution_date, leaseExecutionDate: deal.lease_execution_date },
    health,
    invoices,
    events: events.rows,
  };
}

// Website: a buyer / tenant's own deals - where each stands, what happens
// next, and their invoices. No internal health factors.
async function customerDeals(user) {
  const deals = await pool.query(
    `SELECT d.id, d.stage, d.stage_entered_at, d.deal_value, d.ats_execution_date, d.sale_deed_execution_date, d.lease_execution_date,
            p.id AS property_id, p.title AS property_title, p.city, p.locality, p.transaction_type, b.full_name AS broker_name
     FROM deals d JOIN customers c ON c.id = d.customer_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN users b ON b.id = d.broker_id
     WHERE c.user_id = $1 ORDER BY d.updated_at DESC`,
    [user.id]
  );
  const invoices = await listInvoices(user, {});
  const c = await cfg();
  const out = [];
  for (const d of deals.rows) {
    const next = nextStage(d.stage);
    const full = await loadDeal(d.id);
    const reqs = next && !['closed_won', 'closed_lost'].includes(d.stage) ? await requirementsFor(full, next, c) : [];
    out.push({
      ...d,
      flow: FLOW,
      next,
      nextSteps: reqs.filter((r) => !r.met).map((r) => r.label),
      invoices: invoices.filter((i) => i.deal_id === d.id),
    });
  }
  return out;
}

module.exports = {
  FLOW,
  customerDeals,
  assertCanEnter,
  evaluate,
  safeEvaluate,
  evaluateForProperty,
  recordDates,
  recordInvoicePayment,
  listInvoices,
  invoicePdf,
  dealView,
  slaSweep,
  invoiceSweep,
  healthSweep,
  startScheduler,
  computeHealth,
};
