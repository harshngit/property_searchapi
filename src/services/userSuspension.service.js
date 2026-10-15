const pool = require('../config/db');
const auditService = require('./audit.service');
const notificationService = require('./notification.service');
const userBlock = require('../utils/userBlock');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Section 35 - User Suspension & Removal: Public Erasure Policy.
//   Suspend / remove   one atomic action: the account stops working, and its
//                      listings, requirements, share links, trust score,
//                      badges and ratings leave public view; listings and
//                      requirements leave the matching engine. Nothing is
//                      deleted (DPDP: removal from view is not deletion).
//   Commission         pending franchise commission shares due to the person
//                      are frozen until the Super Admin releases or forfeits them.
//   Active deals       the assigned representative and the other parties are
//                      told at once; the Super Admin decides how each continues.
//   Records            every action, with its reasons, time and acting
//                      authority, goes to user_suspensions (append-only) and
//                      the audit log. Afterwards only the Super Admin sees the
//                      account, marked SUSPENDED / REMOVED.
//   Reinstatement      Super Admin only, on the person's clarification. Listings
//                      and requirements come back only after a fresh review;
//                      the referral code is the same one.
// A franchise organisation's suspension (Section 14) is separate: neither
// triggers the other.

const ACTORS = ['admin', 'super_admin'];
const OPEN_DEAL = `d.stage NOT IN ('closed_won', 'closed_lost')`;
const label = (s) => (s === 'removed' ? 'REMOVED' : 'SUSPENDED');

async function refreshBlocks() {
  const rows = (await pool.query(`SELECT id, status::text AS status FROM users WHERE status IN ('suspended', 'removed')`)).rows;
  userBlock.setBlocked(new Map(rows.map((r) => [r.id, r.status])));
}
userBlock.setRefresher(refreshBlocks);

async function target(id) {
  const u = (await pool.query(`SELECT u.id, u.full_name, u.email, u.mobile, u.status::text AS status, u.referral_code, u.tenant_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id])).rows[0];
  if (!u) throw notFound('User not found');
  return u;
}

// What a suspension would take out of view - shown before the admin confirms.
async function impact(id) {
  const [props, reqs, shares, deals, commissions] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM properties p WHERE (p.created_by = $1 OR p.id IN (SELECT property_id FROM institutional_listings WHERE seller_user_id = $1)) AND p.status IN ('approved', 'pending_approval')`, [id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM requirements r LEFT JOIN customers c ON c.id = r.customer_id WHERE (r.created_by = $1 OR c.user_id = $1) AND r.status = 'active'`, [id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM requirement_shares WHERE shared_by = $1 AND status = 'pending'`, [id]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM deals d LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN properties p ON p.id = d.property_id
       WHERE ${OPEN_DEAL} AND (d.broker_id = $1 OR c.user_id = $1 OR p.created_by = $1)`,
      [id]
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM franchisee_commissions fc WHERE fc.status IN ('calculated', 'releasable') AND fc.shares @> $1::jsonb`, [JSON.stringify([{ userId: id }])]),
  ]);
  return { listings: props.rows[0].n, requirements: reqs.rows[0].n, shareLinks: shares.rows[0].n, activeDeals: deals.rows[0].n, commissionsToFreeze: commissions.rows[0].n };
}

async function suspend(actor, id, { action = 'suspended', reason, note } = {}, meta = {}) {
  if (!ACTORS.includes(actor.role)) throw forbidden('Only an admin can suspend or remove an account');
  if (!['suspended', 'removed'].includes(action)) throw badRequest('Choose suspend or remove');
  if (id === actor.id) throw badRequest('You cannot suspend your own account');
  const u = await target(id);
  if (u.role === 'super_admin') throw forbidden('A Super Admin account cannot be suspended here');
  if (u.role === 'admin' && actor.role !== 'super_admin') throw forbidden('Only the Super Admin can suspend an admin');
  if (u.status === action) throw badRequest(`This account is already ${action}`);
  if (u.status === 'removed') throw badRequest('This account has already been removed');

  const client = await pool.connect();
  let snapshot;
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE users SET status = $1::user_status, updated_at = now() WHERE id = $2`, [action, id]);
    // Already hidden by an earlier suspension? Keep that snapshot's view of what to restore.
    const listings = (await client.query(
      `UPDATE properties p SET status = 'inactive', updated_at = now() FROM (
         SELECT id, status::text AS previous FROM properties WHERE (created_by = $1 OR id IN (SELECT property_id FROM institutional_listings WHERE seller_user_id = $1)) AND status IN ('approved', 'pending_approval') FOR UPDATE
       ) x WHERE p.id = x.id RETURNING p.id, x.previous`,
      [id]
    )).rows;
    const requirements = (await client.query(
      `UPDATE requirements r SET status = 'paused', updated_at = now() WHERE r.status = 'active' AND (r.created_by = $1 OR r.customer_id IN (SELECT id FROM customers WHERE user_id = $1)) RETURNING r.id`,
      [id]
    )).rows.map((r) => r.id);
    const shares = (await client.query(`UPDATE requirement_shares SET status = 'revoked' WHERE shared_by = $1 AND status = 'pending' RETURNING id`, [id])).rows.map((r) => r.id);
    // Co-broking offers the person made or received that are still open.
    const cobroke = (await client.query(
      `UPDATE cobroke_agreements SET status = 'withdrawn', updated_at = now() WHERE status IN ('proposed', 'countered') AND (proposer_id = $1 OR partner_id = $1) RETURNING id`,
      [id]
    ).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
    const commissions = (await client.query(`SELECT id, shares FROM franchisee_commissions WHERE status IN ('calculated', 'releasable') AND shares @> $1::jsonb`, [JSON.stringify([{ userId: id }])])).rows;
    const frozen = [];
    for (const c of commissions) {
      const total = (c.shares || []).filter((s) => s.userId === id).reduce((sum, s) => sum + Number(s.total || 0), 0);
      const f = (await client.query(
        `INSERT INTO commission_freezes (user_id, commission_id, share_total) VALUES ($1, $2, $3) ON CONFLICT (user_id, commission_id) DO UPDATE SET decision = NULL, decided_by = NULL, decided_at = NULL RETURNING id`,
        [id, c.id, Math.round(total * 100) / 100]
      )).rows[0];
      frozen.push({ freezeId: f.id, commissionId: c.id, amount: Math.round(total * 100) / 100 });
    }
    const deals = (await client.query(
      `SELECT d.id, d.stage::text AS stage, d.broker_id, d.assigned_rep_id, c.user_id AS buyer_user_id, p.created_by AS lister_id, p.title, l.arb_rep_id
       FROM deals d LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN leads l ON l.id = d.lead_id
       WHERE ${OPEN_DEAL} AND (d.broker_id = $1 OR c.user_id = $1 OR p.created_by = $1)`,
      [id]
    )).rows;
    snapshot = {
      previousStatus: u.status,
      listings, requirements, shareLinks: shares, cobrokeOffers: cobroke, frozenCommissions: frozen,
      activeDeals: deals.map((d) => ({ dealId: d.id, stage: d.stage, title: d.title, role: d.broker_id === id ? 'broker' : d.buyer_user_id === id ? 'buyer' : 'lister' })),
    };
    await client.query(
      `INSERT INTO user_suspensions (user_id, action, reason, internal_note, acted_by, acted_role, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, action, reason ? String(reason).trim().slice(0, 2000) : null, note ? String(note).trim().slice(0, 2000) : null, actor.id, actor.role, JSON.stringify(snapshot)]
    );
    await client.query('COMMIT');
    snapshot.deals = deals;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Sessions end now on this server (others within 30 seconds).
  userBlock.block(id, action);
  await auditService.log({ actor, action: `user.${action}`, entityType: 'user', entityId: id, before: { status: u.status }, after: { status: action, reason: reason || null, listings: snapshot.listings.length, requirements: snapshot.requirements.length, deals: snapshot.activeDeals.length, frozenCommissions: snapshot.frozenCommissions.length }, ...meta });

  // Active deals: the representative and the other parties hear at once (never the
  // reason). Sent in the background so the admin's screen does not wait for it.
  (async () => {
    const superAdmins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'super_admin' AND u.status = 'active'`)).rows.map((r) => r.id);
    for (const d of snapshot.deals) {
      const people = new Set([d.assigned_rep_id, d.arb_rep_id, d.broker_id, d.buyer_user_id, d.lister_id].filter((x) => x && x !== id));
      for (const p of people) {
        await notificationService.createNotification({ userId: p, type: 'deal_participant_suspended', priority: 'high', title: `A participant in ${d.title || 'a deal'} is no longer active`, message: 'A R Buildwel will confirm how this deal continues.', relatedEntityType: 'deal', relatedEntityId: d.id }).catch(() => {});
      }
    }
    for (const s of superAdmins) {
      await notificationService.createNotification({ userId: s, type: 'user_suspended', priority: snapshot.activeDeals.length ? 'high' : 'normal', title: `${u.full_name} ${action === 'removed' ? 'removed' : 'suspended'}`, message: `${snapshot.activeDeals.length} active deal(s) and ${snapshot.frozenCommissions.length} frozen commission share(s) need your decision.`, relatedEntityType: 'user', relatedEntityId: id }).catch(() => {});
    }
  })().catch((err) => console.error('[suspension] notifications failed:', err.message));
  return view(actor, id);
}

async function reinstate(actor, id, { clarification } = {}, meta = {}) {
  if (actor.role !== 'super_admin') throw forbidden('Only the Super Admin can reinstate an account');
  if (!clarification || String(clarification).trim().length < 5) throw badRequest('Record the clarification received from the person');
  const u = await target(id);
  if (!['suspended', 'removed'].includes(u.status)) throw badRequest('This account is not suspended or removed');
  const last = (await pool.query(`SELECT snapshot FROM user_suspensions WHERE user_id = $1 AND action IN ('suspended', 'removed') ORDER BY acted_at DESC LIMIT 1`, [id])).rows[0];
  const snap = last?.snapshot || {};
  const listingIds = (snap.listings || []).map((l) => l.id);
  const requirementIds = snap.requirements || [];
  const client = await pool.connect();
  let republish;
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1`, [id]);
    // Fresh review: listings go back into the approval queue, requirements wait for staff.
    const l = await client.query(`UPDATE properties SET status = 'pending_approval', updated_at = now() WHERE id = ANY($1::uuid[]) AND status = 'inactive' RETURNING id`, [listingIds]);
    const r = await client.query(`UPDATE requirements SET needs_review = true, updated_at = now() WHERE id = ANY($1::uuid[]) AND status = 'paused' RETURNING id`, [requirementIds]);
    republish = { listingsForReview: l.rowCount, requirementsForReview: r.rowCount };
    await client.query(
      `INSERT INTO user_suspensions (user_id, action, reason, acted_by, acted_role, snapshot) VALUES ($1, 'reinstated', $2, $3, $4, $5)`,
      [id, String(clarification).trim().slice(0, 2000), actor.id, actor.role, JSON.stringify({ previousStatus: u.status, ...republish, referralCode: u.referral_code })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  userBlock.unblock(id);
  await auditService.log({ actor, action: 'user.reinstated', entityType: 'user', entityId: id, before: { status: u.status }, after: { status: 'active', ...republish }, ...meta });
  await notificationService.createNotification({ userId: id, type: 'account', title: 'Your account is active again', message: 'Your listings and requirements will be visible again once our team has reviewed them.', relatedEntityType: 'user', relatedEntityId: id }).catch(() => {});
  return view(actor, id);
}

// After reinstatement: a reviewed requirement goes live again.
async function republishRequirement(actor, requirementId, meta = {}) {
  if (!['internal_sales', ...ACTORS].includes(actor.role)) throw forbidden();
  const r = (await pool.query(`UPDATE requirements SET status = 'active', needs_review = false, updated_at = now() WHERE id = $1 AND needs_review RETURNING id, created_by, customer_id`, [requirementId])).rows[0];
  if (!r) throw badRequest('This requirement is not waiting for review');
  const owner = r.created_by || (await pool.query('SELECT user_id FROM customers WHERE id = $1', [r.customer_id])).rows[0]?.user_id;
  if (owner) await pool.query(`INSERT INTO user_suspensions (user_id, action, acted_by, acted_role, snapshot) VALUES ($1, 'republished', $2, $3, $4)`, [owner, actor.id, actor.role, JSON.stringify({ requirementId })]);
  await auditService.log({ actor, action: 'requirement.republished', entityType: 'requirement', entityId: requirementId, ...meta });
  require('./matchEngine.service').safeRefreshRequirement?.(requirementId);
  return { republished: true };
}

// The Super Admin's call on a deal the person was part of.
async function decideDeal(actor, userId, dealId, { decision, newBrokerId, note } = {}, meta = {}) {
  if (actor.role !== 'super_admin') throw forbidden('Only the Super Admin decides how the deal continues');
  if (!['continue', 'reassign', 'close'].includes(decision)) throw badRequest('Choose continue, reassign or close');
  const d = (await pool.query(`SELECT id, broker_id, stage::text AS stage FROM deals WHERE id = $1`, [dealId])).rows[0];
  if (!d) throw notFound('Deal not found');
  if (decision === 'reassign') {
    const b = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.status = 'active' AND r.name IN ('broker', 'agency_admin', 'internal_sales')`, [newBrokerId || null])).rows[0];
    if (!b) throw badRequest('Choose an active broker or representative to take the deal over');
    await pool.query(`UPDATE deals SET broker_id = $1, updated_at = now() WHERE id = $2`, [b.id, dealId]);
  } else if (decision === 'close') {
    await pool.query(`UPDATE deals SET stage = 'closed_lost', closed_at = now(), updated_at = now() WHERE id = $1`, [dealId]);
  }
  await pool.query(`INSERT INTO user_suspensions (user_id, action, reason, acted_by, acted_role, snapshot) VALUES ($1, 'deal_decision', $2, $3, $4, $5)`, [userId, note || null, actor.id, actor.role, JSON.stringify({ dealId, decision, newBrokerId: newBrokerId || null, previousBrokerId: d.broker_id })]);
  await auditService.log({ actor, action: 'user.suspension_deal_decided', entityType: 'deal', entityId: dealId, after: { decision, newBrokerId, userId }, ...meta });
  return view(actor, userId);
}

// Release or forfeit a frozen commission share.
async function decideCommission(actor, freezeId, { decision, note } = {}, meta = {}) {
  if (actor.role !== 'super_admin') throw forbidden('Only the Super Admin decides frozen commission');
  if (!['release', 'forfeit'].includes(decision)) throw badRequest('Choose release or forfeit');
  const f = (await pool.query(`UPDATE commission_freezes SET decision = $1, decided_by = $2, decided_at = now(), note = $3 WHERE id = $4 AND decision IS NULL RETURNING *`, [decision, actor.id, note || null, freezeId])).rows[0];
  if (!f) throw badRequest('This share has already been decided');
  await pool.query(`INSERT INTO user_suspensions (user_id, action, reason, acted_by, acted_role, snapshot) VALUES ($1, 'commission_decision', $2, $3, $4, $5)`, [f.user_id, note || null, actor.id, actor.role, JSON.stringify({ commissionId: f.commission_id, decision, amount: Number(f.share_total) })]);
  await auditService.log({ actor, action: 'user.suspension_commission_decided', entityType: 'franchisee_commission', entityId: f.commission_id, after: { decision, userId: f.user_id, amount: Number(f.share_total) }, ...meta });
  return view(actor, f.user_id);
}

// Used by the franchise commission release: a share frozen and not yet decided blocks it.
async function frozenFor(commissionId) {
  return (await pool.query(`SELECT cf.*, u.full_name FROM commission_freezes cf JOIN users u ON u.id = cf.user_id WHERE cf.commission_id = $1 AND cf.decision IS NULL`, [commissionId])).rows;
}

// Super Admin view of one account: the remark, every recorded action, and what waits for a decision.
async function view(actor, id) {
  if (!ACTORS.includes(actor.role)) throw forbidden();
  const u = await target(id);
  if (actor.role !== 'super_admin' && ['suspended', 'removed'].includes(u.status)) {
    return { id, status: u.status, remark: label(u.status), visibleToSuperAdminOnly: true };
  }
  const [events, freezes, deals, requirements] = await Promise.all([
    pool.query(`SELECT s.*, a.full_name AS actor_name FROM user_suspensions s JOIN users a ON a.id = s.acted_by WHERE s.user_id = $1 ORDER BY s.acted_at DESC`, [id]),
    pool.query(`SELECT * FROM commission_freezes WHERE user_id = $1 ORDER BY frozen_at DESC`, [id]),
    pool.query(
      `SELECT d.id, d.stage::text AS stage, d.broker_id, p.title, b.full_name AS broker_name FROM deals d LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN users b ON b.id = d.broker_id
       WHERE ${OPEN_DEAL} AND (d.broker_id = $1 OR c.user_id = $1 OR p.created_by = $1)`,
      [id]
    ),
    pool.query(`SELECT r.id, r.purpose, r.city, r.status::text AS status FROM requirements r LEFT JOIN customers c ON c.id = r.customer_id WHERE (r.created_by = $1 OR c.user_id = $1) AND r.needs_review`, [id]),
  ]);
  const decided = new Set(events.rows.filter((e) => e.action === 'deal_decision').map((e) => e.snapshot.dealId));
  return {
    id, name: u.full_name, email: u.email, mobile: u.mobile, role: u.role, status: u.status, referralCode: u.referral_code,
    remark: ['suspended', 'removed'].includes(u.status) ? label(u.status) : null,
    events: events.rows.map((e) => ({ id: e.id, action: e.action, reason: e.reason, internalNote: e.internal_note, actedBy: e.actor_name, actedRole: e.acted_role, actedAt: e.acted_at, snapshot: e.snapshot })),
    frozenCommissions: freezes.rows.map((f) => ({ id: f.id, commissionId: f.commission_id, amount: Number(f.share_total), frozenAt: f.frozen_at, decision: f.decision, decidedAt: f.decided_at, note: f.note })),
    activeDeals: deals.rows.map((d) => ({ id: d.id, stage: d.stage, title: d.title, brokerName: d.broker_name, decided: decided.has(d.id) })),
    requirementsForReview: requirements.rows,
  };
}

// Everyone suspended or removed (Super Admin only), with the latest recorded action.
async function list(actor) {
  if (actor.role !== 'super_admin') throw forbidden('Only the Super Admin sees suspended and removed accounts');
  const r = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.status::text AS status, r.name AS role, s.reason, s.acted_at, a.full_name AS actor_name,
            (SELECT COUNT(*)::int FROM commission_freezes cf WHERE cf.user_id = u.id AND cf.decision IS NULL) AS frozen
     FROM users u JOIN roles r ON r.id = u.role_id
     LEFT JOIN LATERAL (SELECT * FROM user_suspensions x WHERE x.user_id = u.id AND x.action IN ('suspended', 'removed') ORDER BY x.acted_at DESC LIMIT 1) s ON true
     LEFT JOIN users a ON a.id = s.acted_by
     WHERE u.status IN ('suspended', 'removed') ORDER BY s.acted_at DESC NULLS LAST LIMIT 500`
  );
  return r.rows.map((x) => ({ id: x.id, name: x.full_name, email: x.email, role: x.role, status: x.status, remark: label(x.status), reason: x.reason, actedAt: x.acted_at, actedBy: x.actor_name, frozenCommissions: x.frozen }));
}

// Requirements waiting for their fresh review after a reinstatement (staff queue).
async function reviewQueue() {
  return (await pool.query(
    `SELECT r.id, r.purpose, r.property_type::text AS property_type, r.city, r.budget_max, r.created_at, COALESCE(u.full_name, c.full_name) AS owner_name
     FROM requirements r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN users u ON u.id = r.created_by WHERE r.needs_review ORDER BY r.updated_at DESC LIMIT 200`
  )).rows;
}

// Section 35 / DPDP: a suspended or removed person can still ask for a copy of
// their data or its deletion. They prove who they are with their password.
async function privacyRequest({ identifier, password, kind, reason }, meta = {}) {
  const bcrypt = require('bcryptjs');
  const id = String(identifier || '').trim().toLowerCase();
  const u = (await pool.query(`SELECT u.id, u.password_hash, u.status::text AS status, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = $1 OR u.mobile = $1 LIMIT 1`, [id])).rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(String(password || ''), u.password_hash))) throw badRequest('The email / mobile or password is not correct');
  if (!['suspended', 'removed'].includes(u.status)) throw badRequest('Your account is active - sign in and use Privacy in your dashboard');
  const privacy = require('./privacy.service');
  const actor = { id: u.id, role: u.role };
  if (kind === 'deletion') return privacy.requestDeletion(actor, { reason }, meta);
  // A copy of the data: recorded for the privacy team to send out.
  await auditService.log({ actor, action: 'privacy.export_requested_while_suspended', entityType: 'user', entityId: u.id, ...meta });
  const admins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'super_admin' AND u.status = 'active'`)).rows;
  for (const a of admins) await notificationService.createNotification({ userId: a.id, type: 'privacy', priority: 'high', title: 'Data copy requested by a suspended account', message: 'Send the account holder a copy of their data within the DPDP timeline.', relatedEntityType: 'user', relatedEntityId: u.id }).catch(() => {});
  return { requested: 'export' };
}

module.exports = { impact, suspend, reinstate, republishRequirement, decideDeal, decideCommission, frozenFor, view, list, reviewQueue, privacyRequest, refreshBlocks };
