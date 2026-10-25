const pool = require('../../config/db');
const configService = require('../config.service');
const auditService = require('../audit.service');
const notificationService = require('../notification.service');
const engine = require('./orchestrator.service');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');

// AI credit wallet - everything around the spend itself (client, 25 Oct 2026):
//
//   Settings    a user's own low-balance alert and optional daily / monthly
//               spend caps (an admin can set them for a user too).
//   Top-ups     besides the gateway: a bank transfer / UPI payment the user
//               reports with its reference, credited when an admin approves.
//   Referrals   credits for introducing people - when they join, a share of
//               the AI credits they spend, and when their deal closes.
//   Invoices    a GST tax invoice for every paid purchase (PDF).
//   Validity    credits expire per kind as the Terms & Conditions say
//               (ai.credit_validity_days); unused purchased credits can be
//               refunded within ai.purchase_refund_days.

const ADMIN = ['admin', 'super_admin'];
const assertAdmin = (u) => {
  if (!ADMIN.includes(u?.role)) throw forbidden('Only an admin manages AI credits');
};

// ------------------------------------------------------------ the wallet page

async function view(user) {
  const base = await engine.wallet(user);
  const [w, lots, topups, invoices, referrals, details, refundDays] = await Promise.all([
    pool.query('SELECT low_balance_alert, daily_cap, monthly_cap FROM ai_wallets WHERE user_id = $1', [user.id]),
    pool.query(
      `SELECT expires_at, SUM(remaining)::int AS credits FROM ai_credit_lots WHERE user_id = $1 AND remaining > 0 AND expires_at IS NOT NULL
       GROUP BY expires_at ORDER BY expires_at LIMIT 5`,
      [user.id]
    ),
    pool.query(
      `SELECT t.*, k.name AS pack_name FROM ai_topup_requests t JOIN ai_credit_packs k ON k.id = t.pack_id WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 20`,
      [user.id]
    ),
    pool.query(
      `SELECT id, receipt_number, invoice_number, pack_name, credits, total_inr, gateway, status, paid_at, refunded_credits FROM ai_credit_purchases
       WHERE user_id = $1 AND invoice_number IS NOT NULL ORDER BY paid_at DESC LIMIT 50`,
      [user.id]
    ),
    pool.query(
      `SELECT kind, COUNT(*)::int AS n, COALESCE(SUM(credits), 0)::int AS credits FROM ai_referral_rewards WHERE referrer_id = $1 GROUP BY kind`,
      [user.id]
    ),
    configService.getConfig('ai.payment_details', {}),
    configService.getConfig('ai.purchase_refund_days', 7),
  ]);
  const s = w.rows[0] || {};
  const rewards = await referralRewards();
  return {
    ...base,
    settings: {
      lowBalanceAlert: s.low_balance_alert ?? null,
      defaultLowBalanceAlert: Number(await configService.getConfig('ai.low_balance_alert', 25)),
      dailyCap: s.daily_cap ?? null,
      monthlyCap: s.monthly_cap ?? null,
    },
    expiring: lots.rows.map((l) => ({ credits: l.credits, expiresAt: l.expires_at })),
    paymentDetails: details || {},
    topups: topups.rows.map(topupView),
    invoices: invoices.rows.map((i) => ({ id: i.id, receiptNumber: i.receipt_number, invoiceNumber: i.invoice_number, packName: i.pack_name, credits: i.credits, totalInr: Number(i.total_inr), gateway: i.gateway, status: i.status, paidAt: i.paid_at, refundedCredits: i.refunded_credits })),
    referrals: {
      code: (await pool.query('SELECT referral_code FROM users WHERE id = $1', [user.id])).rows[0]?.referral_code || null,
      rewards,
      earned: Object.fromEntries(referrals.rows.map((r) => [r.kind, { count: r.n, credits: r.credits }])),
    },
    refundDays: refundDays === null ? null : Number(refundDays),
  };
}

// ------------------------------------------------------------ settings

function cleanLimit(v, label) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1000000) throw badRequest(`${label} must be a whole number of credits`);
  return n;
}

async function saveSettings(actor, userId, data = {}, meta = {}) {
  if (actor.id !== userId) assertAdmin(actor);
  await engine.ensureWallet(userId);
  const next = {
    low: data.lowBalanceAlert === undefined ? undefined : cleanLimit(data.lowBalanceAlert, 'The low-balance alert'),
    daily: data.dailyCap === undefined ? undefined : cleanLimit(data.dailyCap, 'The daily limit'),
    monthly: data.monthlyCap === undefined ? undefined : cleanLimit(data.monthlyCap, 'The monthly limit'),
  };
  if (next.daily === 0 || next.monthly === 0) throw badRequest('Leave a limit empty for no limit');
  if (next.daily && next.monthly && next.daily > next.monthly) throw badRequest('The daily limit cannot be more than the monthly limit');
  await pool.query(
    `UPDATE ai_wallets SET low_balance_alert = CASE WHEN $2 THEN $3::int ELSE low_balance_alert END,
       daily_cap = CASE WHEN $4 THEN $5::int ELSE daily_cap END, monthly_cap = CASE WHEN $6 THEN $7::int ELSE monthly_cap END, updated_at = now()
     WHERE user_id = $1`,
    [userId, next.low !== undefined, next.low ?? null, next.daily !== undefined, next.daily ?? null, next.monthly !== undefined, next.monthly ?? null]
  );
  await auditService.log({ actor, action: 'ai.wallet_settings', entityType: 'ai_wallet', entityId: userId, after: next, ...meta });
  const s = (await pool.query('SELECT low_balance_alert, daily_cap, monthly_cap FROM ai_wallets WHERE user_id = $1', [userId])).rows[0];
  return { lowBalanceAlert: s.low_balance_alert, dailyCap: s.daily_cap, monthlyCap: s.monthly_cap };
}

// ------------------------------------------------------------ bank / UPI top-ups

function topupView(t) {
  return {
    id: t.id, userId: t.user_id, userName: t.user_name, packId: t.pack_id, packName: t.pack_name, method: t.method, reference: t.reference,
    amountInr: Number(t.amount_inr), paidOn: t.paid_on, note: t.note, status: t.status, decisionNote: t.decision_note, decidedAt: t.decided_at, purchaseId: t.purchase_id, createdAt: t.created_at,
  };
}

// The user reports a transfer they made; nothing is credited until an admin checks it.
async function requestTopup(user, { packId, method, reference, paidOn, note } = {}, meta = {}) {
  if (!['bank', 'upi'].includes(method)) throw badRequest('Choose bank transfer or UPI');
  const ref = String(reference || '').trim();
  if (ref.length < 6) throw badRequest('Give the UTR / transaction reference of your payment');
  const pack = (await pool.query('SELECT * FROM ai_credit_packs WHERE id = $1 AND is_active', [packId])).rows[0];
  if (!pack) throw notFound('Credit pack not found');
  const gst = Number(await configService.getConfig('ai.credit_gst_percent', 18));
  const v = engine.packView(pack, gst);
  let t;
  try {
    t = (await pool.query(
      `INSERT INTO ai_topup_requests (user_id, pack_id, method, reference, amount_inr, paid_on, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [user.id, pack.id, method, ref.slice(0, 60), v.totalInr, paidOn || null, note ? String(note).slice(0, 300) : null]
    )).rows[0];
  } catch (err) {
    if (err.code === '23505') throw badRequest('This payment reference has already been reported');
    throw err;
  }
  await auditService.log({ actor: user, action: 'ai.topup_requested', entityType: 'ai_topup_request', entityId: t.id, after: { pack: pack.name, method, reference: ref, amountInr: v.totalInr }, ...meta });
  const admins = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
  for (const a of admins.rows) {
    await notificationService
      .createNotification({ userId: a.id, type: 'ai_credits', title: 'AI credit payment to check', message: `${method === 'upi' ? 'UPI' : 'Bank transfer'} of Rs ${v.totalInr} for the ${pack.name} pack (ref ${ref}) - approve it to add the credits.`, relatedEntityType: 'ai_topup_request', relatedEntityId: t.id })
      .catch(() => {});
  }
  return topupView({ ...t, pack_name: pack.name });
}

async function listTopups(admin, { status = 'pending' } = {}) {
  assertAdmin(admin);
  const r = await pool.query(
    `SELECT t.*, k.name AS pack_name, u.full_name AS user_name FROM ai_topup_requests t JOIN ai_credit_packs k ON k.id = t.pack_id JOIN users u ON u.id = t.user_id
     ${status && status !== 'all' ? 'WHERE t.status = $1' : ''} ORDER BY t.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`,
    status && status !== 'all' ? [status] : []
  );
  return r.rows.map(topupView);
}

async function decideTopup(admin, id, { action, note } = {}, meta = {}) {
  assertAdmin(admin);
  const t = (await pool.query('SELECT * FROM ai_topup_requests WHERE id = $1', [id])).rows[0];
  if (!t) throw notFound('Top-up request not found');
  if (t.status !== 'pending') throw badRequest(`This request is already ${t.status}`);
  if (action === 'reject') {
    if (!note || String(note).trim().length < 3) throw badRequest('Say why it is rejected');
    await pool.query(`UPDATE ai_topup_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, admin.id, String(note).slice(0, 300)]);
    await notificationService.createNotification({ userId: t.user_id, type: 'ai_credits', title: 'Credit payment not accepted', message: `Your ${t.method === 'upi' ? 'UPI' : 'bank'} payment (ref ${t.reference}) could not be matched: ${note}` }).catch(() => {});
  } else if (action === 'approve') {
    const pack = (await pool.query('SELECT * FROM ai_credit_packs WHERE id = $1', [t.pack_id])).rows[0];
    const p = await engine.newPurchase(pool, { id: t.user_id }, pack, t.method, { reference: t.reference, recordedBy: admin.id });
    await engine.markPaid(p, { paymentId: null, actor: admin });
    await pool.query(`UPDATE ai_topup_requests SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, purchase_id = $4 WHERE id = $1`, [id, admin.id, note ? String(note).slice(0, 300) : null, p.id]);
    await notificationService.createNotification({ userId: t.user_id, type: 'ai_credits', title: 'AI credits added', message: `${p.credits} credits from your ${pack.name} pack are in your wallet. Your GST invoice is ready to download.` }).catch(() => {});
  } else throw badRequest('action must be approve or reject');
  await auditService.log({ actor: admin, action: `ai.topup_${action === 'approve' ? 'approved' : 'rejected'}`, entityType: 'ai_topup_request', entityId: id, after: { note: note || null }, ...meta });
  return topupView({ ...(await pool.query('SELECT t.*, k.name AS pack_name FROM ai_topup_requests t JOIN ai_credit_packs k ON k.id = t.pack_id WHERE t.id = $1', [id])).rows[0] });
}

// ------------------------------------------------------------ referral credits

async function referralRewards() {
  const r = (await configService.getConfig('ai.referral_rewards', {})) || {};
  return { join: Number(r.join) || 0, usagePercent: Number(r.usagePercent) || 0, dealClosed: Number(r.dealClosed) || 0 };
}

async function referrerOf(userId) {
  return (await pool.query('SELECT referrer_id FROM referral_tree WHERE referred_id = $1 AND referrer_id IS NOT NULL', [userId])).rows[0]?.referrer_id || null;
}

async function reward(referrerId, referredId, kind, credits, { dealId = null, note } = {}) {
  if (!referrerId || credits <= 0) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `INSERT INTO ai_referral_rewards (referrer_id, referred_id, kind, deal_id, credits) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
      [referrerId, referredId, kind, dealId, credits]
    )).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null; // already rewarded (join / this deal)
    }
    await engine.credit(referrerId, credits, 'referral', { note }, client);
    await client.query('COMMIT');
    return credits;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Someone joined with a referral code.
async function onJoined(referredId) {
  const referrer = await referrerOf(referredId);
  const { join } = await referralRewards();
  if (!referrer || !join) return null;
  const got = await reward(referrer, referredId, 'join', join, { note: 'Someone you introduced joined PropertySerch' });
  if (got) notificationService.createNotification({ userId: referrer, type: 'ai_credits', title: `${got} AI credits earned`, message: 'Someone you introduced joined PropertySerch.' }).catch(() => {});
  return got;
}

// An introduced user spent AI credits: their introducer earns a share, carried
// as a fraction until it makes a whole credit.
async function onSpend(userId, credits) {
  const referrer = await referrerOf(userId);
  const { usagePercent } = await referralRewards();
  if (!referrer || !usagePercent || !credits) return null;
  const share = Math.round(((credits * usagePercent) / 100) * 100) / 100;
  await engine.ensureWallet(referrer);
  const w = (await pool.query(`UPDATE ai_wallets SET referral_accrued = referral_accrued + $2 WHERE user_id = $1 RETURNING referral_accrued`, [referrer, share])).rows[0];
  const whole = Math.floor(Number(w.referral_accrued));
  if (whole < 1) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taken = (await client.query(`UPDATE ai_wallets SET referral_accrued = referral_accrued - $2 WHERE user_id = $1 AND referral_accrued >= $2 RETURNING 1`, [referrer, whole])).rows[0];
    if (!taken) {
      await client.query('ROLLBACK');
      return 0;
    }
    await client.query(`INSERT INTO ai_referral_rewards (referrer_id, referred_id, kind, credits) VALUES ($1, $2, 'usage', $3)`, [referrer, userId, whole]);
    await engine.credit(referrer, whole, 'referral', { note: 'Share of AI use by someone you introduced' }, client);
    await client.query('COMMIT');
    return whole;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// A deal closed: the introducer of each person on it (buyer, broker, lister) is rewarded once.
async function onDealClosed(dealId) {
  const { dealClosed } = await referralRewards();
  if (!dealClosed) return [];
  const d = (await pool.query(
    `SELECT d.broker_id, p.created_by AS lister_id, c.user_id AS buyer_id FROM deals d LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = $1`,
    [dealId]
  )).rows[0];
  if (!d) return [];
  const out = [];
  for (const person of [...new Set([d.buyer_id, d.broker_id, d.lister_id].filter(Boolean))]) {
    const referrer = await referrerOf(person);
    if (!referrer || referrer === person) continue;
    const got = await reward(referrer, person, 'deal_closed', dealClosed, { dealId, note: 'A deal closed for someone you introduced' });
    if (got) {
      out.push({ referrer, person, credits: got });
      notificationService.createNotification({ userId: referrer, type: 'ai_credits', title: `${got} AI credits earned`, message: 'A deal closed for someone you introduced.' }).catch(() => {});
    }
  }
  return out;
}

const safe = (fn, label) => (...args) => fn(...args).catch((err) => console.error(`[ai-wallet] ${label}:`, err.message));

// ------------------------------------------------------------ GST invoice

async function invoicePdf(user, purchaseId) {
  const p = (await pool.query('SELECT p.*, u.full_name, u.email FROM ai_credit_purchases p JOIN users u ON u.id = p.user_id WHERE p.id = $1', [purchaseId])).rows[0];
  if (!p || (p.user_id !== user.id && !ADMIN.includes(user.role))) throw notFound('Invoice not found');
  if (!p.invoice_number) throw badRequest('An invoice is issued once the payment is confirmed');
  const gst = { cgst: 9, sgst: 9, igst: 18, ...((await configService.getConfig('invoice.gst', {})) || {}) };
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
  const half = Math.round(Number(p.gst_inr) * 50) / 100;
  line('A R Buildwel - PropertySerch.com', { size: 16, f: bold });
  line(`GSTIN: ${p.gstin || '07DERPR1574G2ZY'}`);
  y -= 6;
  line(`TAX INVOICE ${p.invoice_number}`, { size: 14, f: bold });
  line(`Date: ${new Date(p.invoiced_at || p.paid_at).toLocaleDateString('en-IN')}    Receipt: ${p.receipt_number}`);
  line(`Billed to: ${p.buyer_name || p.full_name}${p.email ? ` (${p.email})` : ''}`);
  if (p.buyer_gstin) line(`Customer GSTIN: ${p.buyer_gstin}`);
  y -= 6;
  line('AI credits - online information and database access services (SAC 998431)', { f: bold });
  line(`${p.pack_name} pack: ${p.credits} AI credits (1 credit = Rs 1 of AI usage)`);
  y -= 6;
  line(`Taxable value: ${money(p.amount_inr)}`);
  line(`CGST @ ${gst.cgst}%: ${money(half)}    SGST @ ${gst.sgst}%: ${money(Number(p.gst_inr) - half)}`);
  line(`(or IGST @ ${gst.igst}%: ${money(p.gst_inr)} for supplies outside Delhi)`, { size: 9 });
  line(`Total: ${money(p.total_inr)}`, { size: 13, f: bold });
  y -= 6;
  line(`Paid by ${p.gateway === 'razorpay' ? 'Razorpay' : p.gateway === 'upi' ? 'UPI' : p.gateway === 'bank' ? 'bank transfer' : 'transfer recorded by A R Buildwel'}${p.reference ? ` (ref ${p.reference})` : ''}${p.gateway_payment_id ? ` (payment ${p.gateway_payment_id})` : ''}`, { size: 9 });
  if (p.refunded_credits) line(`Refunded: ${p.refunded_credits} unused credits, ${money(p.refund_inr || 0)}${p.refunded_at ? ` on ${new Date(p.refunded_at).toLocaleDateString('en-IN')}` : ''}`, { size: 9 });
  line('Credit validity and refunds follow the PropertySerch Terms & Conditions.', { size: 9 });
  return { buffer: Buffer.from(await pdf.save()), fileName: `${p.invoice_number}.pdf` };
}

// ------------------------------------------------------------ validity + refunds

// Credits past their validity leave the wallet (hourly).
async function expireCredits() {
  const due = (await pool.query(`SELECT id, user_id, remaining, kind FROM ai_credit_lots WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now() ORDER BY expires_at LIMIT 500`)).rows;
  let expired = 0;
  for (const lot of due) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const l = (await client.query('SELECT remaining FROM ai_credit_lots WHERE id = $1 AND remaining > 0 FOR UPDATE', [lot.id])).rows[0];
      if (!l) {
        await client.query('ROLLBACK');
        continue;
      }
      const w = (await client.query('UPDATE ai_wallets SET balance = GREATEST(balance - $2, 0), updated_at = now() WHERE user_id = $1 RETURNING balance', [lot.user_id, l.remaining])).rows[0];
      await client.query('UPDATE ai_credit_lots SET remaining = 0 WHERE id = $1', [lot.id]);
      await engine.ledger(client, { userId: lot.user_id, kind: 'expire', credits: -l.remaining, balanceAfter: w.balance, note: `${lot.kind === 'purchase' ? 'Purchased' : lot.kind === 'referral' ? 'Referral' : 'Free'} credits reached the end of their validity` });
      await client.query('COMMIT');
      expired += l.remaining;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[ai-wallet] expiry failed:', err.message);
    } finally {
      client.release();
    }
  }
  return { lots: due.length, credits: expired };
}

// Refund the unused credits of one purchase within the T&C window (admin).
// The money goes back through the gateway / bank by finance; this takes the
// credits out and records the amount.
async function refundPurchase(admin, purchaseId, { note } = {}, meta = {}) {
  assertAdmin(admin);
  const p = (await pool.query('SELECT * FROM ai_credit_purchases WHERE id = $1', [purchaseId])).rows[0];
  if (!p) throw notFound('Purchase not found');
  if (p.status !== 'paid') throw badRequest(`This purchase is ${p.status}`);
  const days = await configService.getConfig('ai.purchase_refund_days', 7);
  if (days === null || days === undefined) throw badRequest('Refunds of AI credits are not offered under the current Terms & Conditions');
  if (Date.now() - new Date(p.paid_at).getTime() > Number(days) * 86400000) throw badRequest(`Refunds are possible within ${days} days of purchase`);
  if (!note || String(note).trim().length < 5) throw badRequest('Say why it is refunded');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lot = (await client.query('SELECT id, remaining FROM ai_credit_lots WHERE purchase_id = $1 AND kind = $2 FOR UPDATE', [p.id, 'purchase'])).rows[0];
    const unused = lot?.remaining || 0;
    if (!unused) throw badRequest('All credits of this purchase have been used');
    const w = (await client.query('UPDATE ai_wallets SET balance = balance - $2, lifetime_purchased = lifetime_purchased - $2, updated_at = now() WHERE user_id = $1 AND balance >= $2 RETURNING balance', [p.user_id, unused])).rows[0];
    if (!w) throw badRequest('The wallet no longer holds these credits');
    await client.query('UPDATE ai_credit_lots SET remaining = 0 WHERE id = $1', [lot.id]);
    const refund = Math.round((Number(p.total_inr) * unused) / p.credits * 100) / 100;
    await client.query(
      `UPDATE ai_credit_purchases SET status = 'refunded', refunded_credits = $2, refund_inr = $3, refunded_at = now(), refund_note = $4 WHERE id = $1`,
      [p.id, unused, refund, String(note).slice(0, 300)]
    );
    await engine.ledger(client, { userId: p.user_id, kind: 'refund_out', credits: -unused, balanceAfter: w.balance, purchaseId: p.id, note: `Unused credits of ${p.receipt_number} refunded (Rs ${refund})`, actorId: admin.id });
    await client.query('COMMIT');
    await auditService.log({ actor: admin, action: 'ai.purchase_refunded', entityType: 'ai_credit_purchase', entityId: p.id, after: { credits: unused, refundInr: refund, note }, ...meta });
    return { purchaseId: p.id, refundedCredits: unused, refundInr: refund, balance: w.balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => expireCredits().catch((err) => console.error('[ai-wallet] expiry sweep failed:', err.message)), 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = {
  view, saveSettings, requestTopup, listTopups, decideTopup,
  referralRewards, onJoined, onSpend, onDealClosed, safeOnJoined: safe(onJoined, 'join reward'), safeOnDealClosed: safe(onDealClosed, 'deal reward'),
  invoicePdf, expireCredits, refundPurchase, startScheduler,
};
