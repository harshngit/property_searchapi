const crypto = require('crypto');
const pool = require('../../config/db');
const configService = require('../config.service');
const auditService = require('../audit.service');
const notificationService = require('../notification.service');
const providers = require('./providers');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');

// AI orchestration engine + credit wallet.
//
//   run(activity, { user, system, parts | prompt, schema, entity })
//     1. looks up the activity: its model (simple -> OpenAI gpt-6-luna,
//        important -> Claude Opus 5.5), credit price and who pays;
//     2. when the user pays, takes the credits from their wallet first - not
//        enough credits stops here with a 402 and "buy credits";
//     3. calls the model, and on failure the other provider (fallback);
//     4. records the run with tokens and actual USD cost;
//     5. refunds the credits if no provider could answer.
// Staff never pay; background work (fraud filters, parsing, translation) is
// paid by the platform. 1 credit = Rs 1. Every credit movement is in the
// append-only ledger.

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const LOW_BALANCE = 25;

class InsufficientCredits extends Error {
  constructor(needed, balance, label) {
    super(`${label} needs ${needed} AI credits and you have ${balance}. Buy credits to continue.`);
    this.statusCode = 402;
    this.errors = [{ field: 'credits', code: 'insufficient_credits', needed, balance }];
  }
}
const unavailable = (msg) => Object.assign(new Error(msg), { statusCode: 503 });

// ---------------------------------------------------------------- catalogue

let cache = { at: 0, rows: null };
const invalidate = () => { cache = { at: 0, rows: null }; };
async function activities() {
  if (cache.rows && Date.now() - cache.at < 60000) return cache.rows;
  const rows = (await pool.query('SELECT * FROM ai_activities')).rows;
  cache = { at: Date.now(), rows };
  return rows;
}
async function activity(key) {
  const a = (await activities()).find((x) => x.activity_key === key);
  if (!a) throw notFound(`Unknown AI activity: ${key}`);
  return a;
}

async function priceOf(model) {
  const prices = await configService.getConfig('ai.model_prices', {});
  return prices?.[model] || null;
}
async function costUsd(model, inputTokens, outputTokens) {
  const p = await priceOf(model);
  if (!p) return 0;
  return (inputTokens * Number(p.input || 0) + outputTokens * Number(p.output || 0)) / 1e6;
}

// ---------------------------------------------------------------- wallet movements

async function ensureWallet(userId, client = pool) {
  await client.query('INSERT INTO ai_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}

async function ledger(client, { userId, kind, credits, balanceAfter, activityKey = null, runId = null, purchaseId = null, note = null, actorId = null }) {
  await client.query(
    `INSERT INTO ai_credit_ledger (user_id, kind, credits, balance_after, activity_key, run_id, purchase_id, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, kind, credits, balanceAfter, activityKey, runId, purchaseId, note ? String(note).slice(0, 300) : null, actorId]
  );
}

// Take credits - only if there are enough (never below zero).
async function debit(userId, credits, { activityKey, runId, label }) {
  await ensureWallet(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query(
      'UPDATE ai_wallets SET balance = balance - $2, lifetime_spent = lifetime_spent + $2, updated_at = now() WHERE user_id = $1 AND balance >= $2 RETURNING balance',
      [userId, credits]
    )).rows[0];
    if (!w) {
      await client.query('ROLLBACK');
      const balance = (await pool.query('SELECT balance FROM ai_wallets WHERE user_id = $1', [userId])).rows[0]?.balance || 0;
      throw new InsufficientCredits(credits, balance, label);
    }
    await ledger(client, { userId, kind: 'spend', credits: -credits, balanceAfter: w.balance, activityKey, runId, note: label });
    await client.query('COMMIT');
    return w.balance;
  } catch (err) {
    if (!(err instanceof InsufficientCredits)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function credit(userId, credits, kind, { activityKey = null, runId = null, purchaseId = null, note = null, actorId = null, lifetimePurchased = false } = {}, client = null) {
  const own = !client;
  const c = client || (await pool.connect());
  try {
    if (own) await c.query('BEGIN');
    await ensureWallet(userId, c);
    const w = (await c.query(
      `UPDATE ai_wallets SET balance = balance + $2, lifetime_purchased = lifetime_purchased + CASE WHEN $3 THEN $2 ELSE 0 END,
         lifetime_spent = lifetime_spent - CASE WHEN $4 THEN $2 ELSE 0 END, updated_at = now() WHERE user_id = $1 RETURNING balance`,
      [userId, credits, lifetimePurchased, kind === 'refund']
    )).rows[0];
    await ledger(c, { userId, kind, credits, balanceAfter: w.balance, activityKey, runId, purchaseId, note, actorId });
    if (own) await c.query('COMMIT');
    return w.balance;
  } catch (err) {
    if (own) await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (own) c.release();
  }
}

// ---------------------------------------------------------------- run

/**
 * Run one AI activity.
 * @param {string} key  activity_key from ai_activities
 * @param {object} o    { user, system, prompt | parts, schema, entityType, entityId }
 * @returns {{ text, json, runId, provider, model, creditsCharged, balance }}
 */
async function run(key, o = {}) {
  if ((await configService.getConfig('ai.enabled', true)) === false) throw unavailable('AI features are switched off');
  const a = await activity(key);
  if (!a.is_active) throw unavailable(`${a.label} is switched off`);
  const parts = o.parts || [{ type: 'text', text: String(o.prompt || '') }];
  const pays = a.payer === 'user' && a.credits > 0 && o.user && !STAFF.includes(o.user.role);
  const runId = crypto.randomUUID();
  const started = Date.now();
  await pool.query(
    `INSERT INTO ai_runs (id, activity_key, user_id, payer, status, error, entity_type, entity_id) VALUES ($1, $2, $3, $4, 'failed', 'running', $5, $6)`,
    [runId, key, o.user?.id || null, pays ? 'user' : 'platform', o.entityType || null, o.entityId ? String(o.entityId) : null]
  );
  let balance = null;
  if (pays) balance = await debit(o.user.id, a.credits, { activityKey: key, runId, label: a.label }).catch(async (err) => {
    await pool.query(`UPDATE ai_runs SET error = $2 WHERE id = $1`, [runId, err.statusCode === 402 ? 'not enough credits' : String(err.message).slice(0, 300)]);
    throw err;
  });

  // A PDF goes to a provider that reads PDFs; both do, so the chain is model then fallback.
  const chain = [{ provider: a.provider, model: a.model }];
  if (a.fallback_provider && a.fallback_model) chain.push({ provider: a.fallback_provider, model: a.fallback_model });
  let result = null;
  let lastErr = null;
  let used = null;
  for (const [i, step] of chain.entries()) {
    if (!providers.configured(step.provider)) {
      lastErr = new providers.ProviderError(`${step.provider} is not configured`, { provider: step.provider });
      continue;
    }
    try {
      result = await providers.generate({ ...step, effort: a.effort, maxTokens: a.max_output_tokens, system: o.system || null, parts, schema: o.schema || null });
      used = { ...step, fallback: i > 0 };
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[ai] ${key} on ${step.provider}/${step.model} failed:`, err.message);
    }
  }

  const latency = Date.now() - started;
  if (!result) {
    if (pays) balance = await credit(o.user.id, a.credits, 'refund', { activityKey: key, runId, note: `${a.label} - no AI provider could answer, credits returned` });
    await pool.query(`UPDATE ai_runs SET status = $2, error = $3, latency_ms = $4 WHERE id = $1`, [runId, lastErr?.refusal ? 'refused' : 'failed', String(lastErr?.message || 'no provider configured').slice(0, 300), latency]);
    const err = new Error(lastErr?.refusal ? 'The AI declined this request' : `${a.label} is not available right now${pays ? ' - your credits were returned' : ''}`);
    err.statusCode = lastErr?.refusal ? 422 : 502;
    throw err;
  }
  const cost = await costUsd(result.model, result.inputTokens, result.outputTokens);
  await pool.query(
    `UPDATE ai_runs SET status = 'ok', error = NULL, provider = $2, model = $3, fallback_used = $4, input_tokens = $5, output_tokens = $6, cost_usd = $7, credits_charged = $8, latency_ms = $9 WHERE id = $1`,
    [runId, used.provider, result.model, used.fallback, result.inputTokens, result.outputTokens, cost, pays ? a.credits : 0, latency]
  );
  if (pays && balance !== null && balance < LOW_BALANCE && balance + a.credits >= LOW_BALANCE) {
    notificationService.createNotification({ userId: o.user.id, type: 'ai_credits', title: 'AI credits running low', message: `${balance} credits left. Buy a pack to keep using AI features.`, priority: 'normal' }).catch(() => {});
  }
  return { text: result.text, json: result.json, runId, provider: used.provider, model: result.model, fallbackUsed: used.fallback, creditsCharged: pays ? a.credits : 0, balance };
}

// For background callers that must never fail the request: null on any error.
async function tryRun(key, o) {
  try {
    return await run(key, o);
  } catch (err) {
    if (err.statusCode !== 503) console.error(`[ai] ${key}:`, err.message);
    return null;
  }
}

// Is this activity usable right now (switched on, a provider configured)?
async function available(key) {
  if ((await configService.getConfig('ai.enabled', true)) === false) return false;
  const a = (await activities()).find((x) => x.activity_key === key);
  return !!a && a.is_active && (providers.configured(a.provider) || (!!a.fallback_provider && providers.configured(a.fallback_provider)));
}

// ---------------------------------------------------------------- wallet (user)

const packView = (p, gst) => {
  const price = Number(p.price_inr);
  const tax = Math.round(price * gst) / 100;
  return { id: p.id, name: p.name, priceInr: price, gstInr: tax, totalInr: Math.round((price + tax) * 100) / 100, credits: p.credits, bonusCredits: p.bonus_credits, totalCredits: p.credits + p.bonus_credits };
};
const razorpay = () => (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? { keyId: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET } : null);

async function wallet(user) {
  await ensureWallet(user.id);
  const gst = Number(await configService.getConfig('ai.credit_gst_percent', 18));
  const [w, history, packs, priced] = await Promise.all([
    pool.query('SELECT * FROM ai_wallets WHERE user_id = $1', [user.id]),
    pool.query(`SELECT l.*, a.label FROM ai_credit_ledger l LEFT JOIN ai_activities a ON a.activity_key = l.activity_key WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 50`, [user.id]),
    pool.query('SELECT * FROM ai_credit_packs WHERE is_active ORDER BY sort_order, price_inr'),
    pool.query(`SELECT activity_key, label, description, credits, tier FROM ai_activities WHERE is_active AND payer = 'user' AND credits > 0 ORDER BY credits`),
  ]);
  return {
    balance: w.rows[0].balance,
    lifetimePurchased: w.rows[0].lifetime_purchased,
    lifetimeSpent: w.rows[0].lifetime_spent,
    staffFree: STAFF.includes(user.role),
    paymentOnline: !!razorpay(),
    gstPercent: gst,
    packs: packs.rows.map((p) => packView(p, gst)),
    prices: priced.rows.map((r) => ({ key: r.activity_key, label: r.label, description: r.description, credits: r.credits, tier: r.tier })),
    history: history.rows.map((l) => ({ id: l.id, kind: l.kind, credits: l.credits, balanceAfter: l.balance_after, label: l.label || l.note, note: l.note, at: l.created_at })),
  };
}

async function newPurchase(client, user, pack, gateway, extra = {}) {
  const gst = Number(await configService.getConfig('ai.credit_gst_percent', 18));
  const v = packView(pack, gst);
  const seq = (await client.query(`SELECT nextval('ai_credit_receipt_seq') AS n`)).rows[0].n;
  return (await client.query(
    `INSERT INTO ai_credit_purchases (receipt_number, user_id, pack_id, pack_name, credits, amount_inr, gst_percent, gst_inr, total_inr, gateway, reference, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [`AIC-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`, user.id, pack.id, pack.name, v.totalCredits, v.priceInr, gst, v.gstInr, v.totalInr, gateway, extra.reference || null, extra.recordedBy || null]
  )).rows[0];
}

// Buy a pack: a Razorpay order the app opens Checkout with.
async function startPurchase(user, packId) {
  const pack = (await pool.query('SELECT * FROM ai_credit_packs WHERE id = $1 AND is_active', [packId])).rows[0];
  if (!pack) throw notFound('Credit pack not found');
  const rz = razorpay();
  if (!rz) throw badRequest('Online payment is not set up yet - ask your A R Buildwel contact to add credits after a bank transfer');
  const p = await newPurchase(pool, user, pack, 'razorpay');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${rz.keyId}:${rz.secret}`).toString('base64')}` },
    body: JSON.stringify({ amount: Math.round(Number(p.total_inr) * 100), currency: 'INR', receipt: p.receipt_number, notes: { purchaseId: p.id, credits: String(p.credits) } }),
  });
  const order = await res.json().catch(() => null);
  if (!res.ok || !order?.id) {
    await pool.query(`UPDATE ai_credit_purchases SET status = 'failed' WHERE id = $1`, [p.id]);
    throw badRequest(`Could not start the payment${order?.error?.description ? `: ${order.error.description}` : ''}`);
  }
  await pool.query('UPDATE ai_credit_purchases SET gateway_order_id = $2 WHERE id = $1', [p.id, order.id]);
  return { purchaseId: p.id, receiptNumber: p.receipt_number, keyId: rz.keyId, orderId: order.id, amount: order.amount, currency: 'INR', credits: p.credits };
}

// Checkout success: verify the signature, then add the credits (once).
async function verifyPurchase(user, purchaseId, { orderId, paymentId, signature } = {}, meta = {}) {
  const p = (await pool.query('SELECT * FROM ai_credit_purchases WHERE id = $1 AND user_id = $2', [purchaseId, user.id])).rows[0];
  if (!p) throw notFound('Purchase not found');
  if (p.status === 'paid') return wallet(user);
  const rz = razorpay();
  if (!rz) throw badRequest('Online payment is not set up');
  if (!orderId || orderId !== p.gateway_order_id) throw badRequest('This payment does not belong to this purchase');
  const expected = crypto.createHmac('sha256', rz.secret).update(`${orderId}|${paymentId}`).digest('hex');
  const ok = expected.length === String(signature || '').length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  if (!ok) throw badRequest('Payment verification failed');
  await markPaid(p, { paymentId, actor: user });
  await auditService.log({ actor: user, action: 'ai.credits_purchased', entityType: 'ai_credit_purchase', entityId: p.id, after: { credits: p.credits, totalInr: Number(p.total_inr), paymentId }, ...meta });
  return wallet(user);
}

async function markPaid(p, { paymentId = null, actor = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const done = (await client.query(`UPDATE ai_credit_purchases SET status = 'paid', paid_at = now(), gateway_payment_id = $2 WHERE id = $1 AND status <> 'paid' RETURNING id`, [p.id, paymentId])).rows[0];
    if (done) await credit(p.user_id, p.credits, 'purchase', { purchaseId: p.id, note: `${p.pack_name} pack (${p.receipt_number})`, actorId: actor?.id || null, lifetimePurchased: true }, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- admin

const assertAdmin = (u) => { if (!ADMIN.includes(u.role)) throw forbidden('Only an admin manages AI credits'); };
const assertSuper = (u) => { if (u.role !== 'super_admin') throw forbidden('Only the Super Admin changes AI models and prices'); };

const activityView = (a) => ({
  key: a.activity_key, label: a.label, description: a.description, tier: a.tier, provider: a.provider, model: a.model,
  fallbackProvider: a.fallback_provider, fallbackModel: a.fallback_model, effort: a.effort, maxOutputTokens: a.max_output_tokens,
  credits: a.credits, payer: a.payer, active: a.is_active, updatedAt: a.updated_at,
});

async function adminOverview(user) {
  assertAdmin(user);
  const gst = Number(await configService.getConfig('ai.credit_gst_percent', 18));
  const [acts, packs, usage, revenue, prices] = await Promise.all([
    pool.query('SELECT * FROM ai_activities ORDER BY tier DESC, label'),
    pool.query('SELECT * FROM ai_credit_packs ORDER BY sort_order, price_inr'),
    pool.query(
      `SELECT activity_key, COALESCE(model, '-') AS model, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE status <> 'ok')::int AS failed,
              COUNT(*) FILTER (WHERE fallback_used)::int AS fallbacks, SUM(input_tokens)::bigint AS input_tokens, SUM(output_tokens)::bigint AS output_tokens,
              SUM(cost_usd)::float AS cost_usd, SUM(credits_charged)::int AS credits
       FROM ai_runs WHERE created_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY cost_usd DESC NULLS LAST`
    ),
    pool.query(`SELECT COUNT(*)::int AS purchases, COALESCE(SUM(amount_inr), 0)::float AS revenue_inr, COALESCE(SUM(credits), 0)::int AS credits_sold FROM ai_credit_purchases WHERE status = 'paid' AND paid_at > now() - interval '30 days'`),
    configService.getConfig('ai.model_prices', {}),
  ]);
  return {
    providers: { openai: providers.configured('openai'), claude: providers.configured('claude') },
    activities: acts.rows.map(activityView),
    packs: packs.rows.map((p) => ({ ...packView(p, gst), active: p.is_active, sortOrder: p.sort_order })),
    usage30d: usage.rows,
    revenue30d: revenue.rows[0],
    modelPrices: prices,
    gstPercent: gst,
  };
}

async function updateActivity(user, key, data = {}, meta = {}) {
  assertSuper(user);
  const a = await activity(key);
  const prices = await configService.getConfig('ai.model_prices', {});
  const pick = (k, col) => (data[k] === undefined ? a[col] : data[k]);
  const next = {
    provider: pick('provider', 'provider'), model: pick('model', 'model'), fallback_provider: pick('fallbackProvider', 'fallback_provider') || null, fallback_model: pick('fallbackModel', 'fallback_model') || null,
    effort: pick('effort', 'effort'), max_output_tokens: Number(pick('maxOutputTokens', 'max_output_tokens')), credits: Number(pick('credits', 'credits')), payer: pick('payer', 'payer'), is_active: pick('active', 'is_active'),
  };
  if (!['openai', 'claude'].includes(next.provider)) throw badRequest('provider must be openai or claude');
  if (!prices[next.model]) throw badRequest(`Add a price for ${next.model} in the model price list first (ai.model_prices)`);
  if ((next.provider === 'claude') !== String(next.model).startsWith('claude')) throw badRequest('That model does not belong to that provider');
  if (next.fallback_provider && (!next.fallback_model || !prices[next.fallback_model])) throw badRequest('Give a priced fallback model, or no fallback');
  if (!Number.isInteger(next.credits) || next.credits < 0 || next.credits > 100000) throw badRequest('Credits must be a whole number');
  const r = (await pool.query(
    `UPDATE ai_activities SET provider = $2, model = $3, fallback_provider = $4, fallback_model = $5, effort = $6, max_output_tokens = $7, credits = $8, payer = $9, is_active = $10, updated_by = $11, updated_at = now() WHERE activity_key = $1 RETURNING *`,
    [key, next.provider, next.model, next.fallback_provider, next.fallback_model, next.effort, next.max_output_tokens, next.credits, next.payer, !!next.is_active, user.id]
  )).rows[0];
  invalidate();
  await auditService.log({ actor: user, action: 'ai.activity_updated', entityType: 'ai_activity', entityId: null, before: activityView(a), after: activityView(r), ...meta });
  return activityView(r);
}

async function savePack(user, id, data = {}, meta = {}) {
  assertSuper(user);
  const price = Number(data.priceInr);
  const credits = Number(data.credits);
  const bonus = Number(data.bonusCredits || 0);
  if (!data.name || String(data.name).trim().length < 2) throw badRequest('Name the pack');
  if (!(price > 0) || !Number.isInteger(credits) || credits <= 0 || !Number.isInteger(bonus) || bonus < 0) throw badRequest('Give a price, whole credits and whole bonus credits');
  const r = id
    ? (await pool.query('UPDATE ai_credit_packs SET name = $2, price_inr = $3, credits = $4, bonus_credits = $5, is_active = $6, sort_order = $7 WHERE id = $1 RETURNING *', [id, String(data.name).trim(), price, credits, bonus, data.active !== false, Number(data.sortOrder) || 0])).rows[0]
    : (await pool.query('INSERT INTO ai_credit_packs (name, price_inr, credits, bonus_credits, is_active, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [String(data.name).trim(), price, credits, bonus, data.active !== false, Number(data.sortOrder) || 0])).rows[0];
  if (!r) throw notFound('Pack not found');
  await auditService.log({ actor: user, action: 'ai.pack_saved', entityType: 'ai_credit_pack', entityId: r.id, after: { name: r.name, price, credits, bonus }, ...meta });
  return r;
}

// Credits added by an admin: a bank-transfer purchase (with its reference) or a goodwill grant.
async function adminCredit(user, { userId, credits, packId, reference, note } = {}, meta = {}) {
  assertAdmin(user);
  const target = (await pool.query('SELECT id FROM users WHERE id = $1', [userId])).rows[0];
  if (!target) throw notFound('User not found');
  if (packId) {
    if (!reference || String(reference).trim().length < 4) throw badRequest('Give the bank transfer / UTR reference');
    const pack = (await pool.query('SELECT * FROM ai_credit_packs WHERE id = $1', [packId])).rows[0];
    if (!pack) throw notFound('Credit pack not found');
    const p = await newPurchase(pool, { id: userId }, pack, 'manual', { reference: String(reference).trim(), recordedBy: user.id });
    await markPaid(p, { paymentId: null, actor: user });
    await auditService.log({ actor: user, action: 'ai.credits_purchase_recorded', entityType: 'ai_credit_purchase', entityId: p.id, after: { userId, credits: p.credits, reference }, ...meta });
  } else {
    const n = Number(credits);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) throw badRequest('Give a whole number of credits');
    if (!note || String(note).trim().length < 5) throw badRequest('Say why');
    if (n < 0) {
      const bal = (await pool.query('SELECT balance FROM ai_wallets WHERE user_id = $1', [userId])).rows[0]?.balance || 0;
      if (bal + n < 0) throw badRequest(`The wallet has only ${bal} credits`);
    }
    await credit(userId, n, n > 0 ? 'grant' : 'adjust', { note, actorId: user.id });
    await auditService.log({ actor: user, action: 'ai.credits_adjusted', entityType: 'ai_wallet', entityId: userId, after: { credits: n, note }, ...meta });
  }
  return wallet({ id: userId, role: 'customer' });
}

module.exports = { run, tryRun, available, activity, activities, invalidate, InsufficientCredits, wallet, startPurchase, verifyPurchase, adminOverview, updateActivity, savePack, adminCredit };
