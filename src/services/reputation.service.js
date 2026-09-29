const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 44 - Reputation Graph. Brokers are nodes; edges are real working
// relationships on the platform, weighted by how much they mean:
//   closed deal together (3) > co-listing / co-broking split (1) = accepted
//   duplicate / mandate routing (1) = explicit vouch (1) > accepted
//   requirement share (0.5).
// A broker's network score is the edge-weighted average of their
// neighbours' *base* trust (their trust minus their own network
// adjustment - so the graph cannot feed on itself). The trust score then
// gets a bounded adjustment: max * confidence * (network - 50) / 50,
// never more than +/- reputation.max_adjustment points.
// Anti-gaming: pairs sharing a public IP or where one created the other's
// account are dropped, same-agency vouches are ignored, accounts younger
// than the tenure minimum do not lend trust, each pair's weight is capped,
// and vouch-only or single-neighbour networks get half confidence.

const BROKER_ROLES = ['broker', 'agency_admin', 'builder'];
const PAIR_CAP = 5;

async function cfg() {
  const [max, weights, tenure, limit, minTrust] = await Promise.all([
    configService.getConfig('reputation.max_adjustment', 5),
    configService.getConfig('reputation.edge_weights', {}),
    configService.getConfig('reputation.min_tenure_days', 30),
    configService.getConfig('reputation.vouch_limit', 10),
    configService.getConfig('reputation.vouch_min_trust', 60),
  ]);
  return {
    max: Number(max) || 0,
    w: { closed_deal: 3, co_listing: 1, routing: 1, share: 0.5, vouch: 1, ...(weights || {}) },
    tenure: Number(tenure) || 0,
    vouchLimit: Number(limit) || 10,
    vouchMinTrust: Number(minTrust) || 0,
  };
}

// All raw interactions as { a, b, kind } between two distinct users.
async function rawEdges() {
  const r = await pool.query(
    `SELECT p.created_by AS a, pp.partner_user_id AS b, 'co_listing' AS kind FROM property_partners pp JOIN properties p ON p.id = pp.property_id
     UNION ALL
     SELECT shared_by, shared_with, 'share' FROM requirement_shares WHERE status = 'accepted'
     UNION ALL
     SELECT requester_id, original_lister_id, 'routing' FROM duplicate_routing_requests WHERE status = 'accepted'
     UNION ALL
     SELECT first_broker_id, later_broker_id, 'routing' FROM lead_conflicts WHERE resolution = 'mandate_routing' AND status = 'resolved'
     UNION ALL
     SELECT d.broker_id, p.created_by, 'closed_deal' FROM deals d JOIN properties p ON p.id = d.property_id WHERE d.stage = 'closed_won'
     UNION ALL
     SELECT voucher_id, vouchee_id, 'vouch' FROM broker_vouches WHERE revoked_at IS NULL`
  );
  return r.rows.filter((e) => e.a && e.b && e.a !== e.b);
}

async function nodeInfo(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(
    `SELECT u.id, u.full_name, u.tenant_id, u.created_by, u.created_at, r.name AS role,
            COALESCE(t.score, 0) AS trust, COALESCE(rs.adjustment, 0) AS adjustment
     FROM users u JOIN roles r ON r.id = u.role_id
     LEFT JOIN trust_scores t ON t.user_id = u.id LEFT JOIN reputation_scores rs ON rs.user_id = u.id
     WHERE u.id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(r.rows.map((n) => [n.id, { ...n, trust: Number(n.trust), base: Number(n.trust) - Number(n.adjustment) }]));
}

async function sharedIpPairs(ids) {
  if (!ids.length) return new Set();
  const r = await pool.query(
    `SELECT DISTINCT a.user_id AS a, b.user_id AS b FROM user_ips a JOIN user_ips b ON a.ip = b.ip AND a.user_id < b.user_id
     WHERE a.user_id = ANY($1::uuid[]) AND b.user_id = ANY($1::uuid[])`,
    [ids]
  );
  return new Set(r.rows.map((x) => `${x.a}|${x.b}`));
}

const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Build the cleaned, weighted graph: Map<pairKey, { a, b, weight, kinds }>,
// plus the list of dropped pairs with reasons.
async function buildGraph(c) {
  const edges = await rawEdges();
  const ids = [...new Set(edges.flatMap((e) => [e.a, e.b]))];
  const nodes = await nodeInfo(ids);
  const ipPairs = await sharedIpPairs(ids);
  const pairs = new Map();
  const excluded = [];
  for (const e of edges) {
    const A = nodes.get(e.a);
    const B = nodes.get(e.b);
    if (!A || !B || !BROKER_ROLES.includes(A.role) || !BROKER_ROLES.includes(B.role)) continue;
    const k = key(e.a, e.b);
    let reason = null;
    if (ipPairs.has(k)) reason = 'shared_ip';
    else if (A.created_by === B.id || B.created_by === A.id) reason = 'created_account';
    else if (e.kind === 'vouch' && A.tenant_id && A.tenant_id === B.tenant_id) reason = 'same_agency_vouch';
    if (reason) {
      if (!excluded.find((x) => x.pair === k && x.reason === reason)) excluded.push({ pair: k, a: e.a, b: e.b, reason });
      continue;
    }
    const p = pairs.get(k) || { a: e.a, b: e.b, weight: 0, kinds: {} };
    p.weight = Math.min(PAIR_CAP, p.weight + (Number(c.w[e.kind]) || 0));
    p.kinds[e.kind] = (p.kinds[e.kind] || 0) + 1;
    pairs.set(k, p);
  }
  return { pairs, nodes, excluded };
}

function scoreFor(userId, pairs, nodes, c) {
  let W = 0;
  let sum = 0;
  const neighbours = [];
  let nonVouch = false;
  for (const p of pairs.values()) {
    if (p.a !== userId && p.b !== userId) continue;
    const other = nodes.get(p.a === userId ? p.b : p.a);
    if (!other) continue;
    const ageDays = (Date.now() - new Date(other.created_at).getTime()) / 86400000;
    if (ageDays < c.tenure) continue; // new accounts do not lend trust
    W += p.weight;
    sum += p.weight * other.base;
    neighbours.push(other.id);
    if (Object.keys(p.kinds).some((k) => k !== 'vouch')) nonVouch = true;
  }
  if (!W) return { networkScore: null, confidence: 0, adjustment: 0, neighbours: 0, weightedDegree: 0 };
  const networkScore = sum / W;
  let confidence = Math.min(1, Math.sqrt(W) / 3);
  if (neighbours.length < 2 || !nonVouch) confidence /= 2;
  const adjustment = Math.max(-c.max, Math.min(c.max, (c.max * confidence * (networkScore - 50)) / 50));
  return {
    networkScore: Math.round(networkScore * 100) / 100,
    confidence: Math.round(confidence * 1000) / 1000,
    adjustment: Math.round(adjustment * 100) / 100,
    neighbours: neighbours.length,
    weightedDegree: Math.round(W * 100) / 100,
  };
}

// Nightly (and on demand): recompute every broker's network score, then
// the trust scores whose adjustment changed.
async function recomputeAll() {
  const c = await cfg();
  const { pairs, nodes, excluded } = await buildGraph(c);
  const known = (await pool.query('SELECT user_id, adjustment FROM reputation_scores')).rows;
  const ids = new Set([...nodes.keys(), ...known.map((k) => k.user_id)]);
  const before = new Map(known.map((k) => [k.user_id, Number(k.adjustment)]));
  const changed = [];
  for (const id of ids) {
    const s = scoreFor(id, pairs, nodes, c);
    const ex = excluded.filter((x) => x.a === id || x.b === id).map((x) => ({ with: x.a === id ? x.b : x.a, reason: x.reason }));
    await pool.query(
      `INSERT INTO reputation_scores (user_id, network_score, confidence, adjustment, neighbours, weighted_degree, excluded, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET network_score = EXCLUDED.network_score, confidence = EXCLUDED.confidence, adjustment = EXCLUDED.adjustment,
         neighbours = EXCLUDED.neighbours, weighted_degree = EXCLUDED.weighted_degree, excluded = EXCLUDED.excluded, computed_at = now()`,
      [id, s.networkScore, s.confidence, s.adjustment, s.neighbours, s.weightedDegree, JSON.stringify(ex)]
    );
    if ((before.get(id) || 0) !== s.adjustment) changed.push(id);
  }
  const trust = require('./trust.service');
  for (const id of changed) await trust.recompute(id).catch(() => {});
  return { nodes: ids.size, edges: pairs.size, excluded: excluded.length, trustUpdated: changed.length };
}

// Ego network of a user (1 hop, plus the links among those neighbours).
async function egoGraph(userId) {
  const c = await cfg();
  const { pairs, nodes } = await buildGraph(c);
  const ids = new Set([userId]);
  for (const p of pairs.values()) if (p.a === userId || p.b === userId) ids.add(p.a === userId ? p.b : p.a);
  return shape([...ids], pairs, nodes, userId);
}

async function globalGraph({ limit = 150 } = {}) {
  const c = await cfg();
  const { pairs, nodes } = await buildGraph(c);
  const degree = new Map();
  for (const p of pairs.values()) {
    degree.set(p.a, (degree.get(p.a) || 0) + p.weight);
    degree.set(p.b, (degree.get(p.b) || 0) + p.weight);
  }
  const ids = [...degree.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([id]) => id);
  return shape(ids, pairs, nodes, null);
}

async function shape(ids, pairs, nodes, center) {
  const set = new Set(ids);
  const scores = ids.length
    ? new Map((await pool.query('SELECT * FROM reputation_scores WHERE user_id = ANY($1::uuid[])', [ids])).rows.map((r) => [r.user_id, r]))
    : new Map();
  const missing = ids.filter((id) => !nodes.has(id));
  if (missing.length) for (const [k, v] of await nodeInfo(missing)) nodes.set(k, v);
  return {
    center,
    nodes: ids.map((id) => {
      const n = nodes.get(id) || {};
      const s = scores.get(id);
      return {
        id,
        name: n.full_name,
        role: n.role,
        trust: n.trust ?? null,
        networkScore: s?.network_score != null ? Number(s.network_score) : null,
        adjustment: s ? Number(s.adjustment) : 0,
        neighbours: s?.neighbours || 0,
      };
    }),
    edges: [...pairs.values()].filter((p) => set.has(p.a) && set.has(p.b)).map((p) => ({ source: p.a, target: p.b, weight: p.weight, kinds: p.kinds })),
  };
}

async function summary(userId) {
  const r = (await pool.query('SELECT * FROM reputation_scores WHERE user_id = $1', [userId])).rows[0];
  const vouches = await pool.query(
    `SELECT v.id, v.note, v.created_at, v.voucher_id, v.vouchee_id, a.full_name AS voucher_name, b.full_name AS vouchee_name
     FROM broker_vouches v JOIN users a ON a.id = v.voucher_id JOIN users b ON b.id = v.vouchee_id
     WHERE v.revoked_at IS NULL AND (v.voucher_id = $1 OR v.vouchee_id = $1) ORDER BY v.created_at DESC`,
    [userId]
  );
  return {
    networkScore: r?.network_score != null ? Number(r.network_score) : null,
    confidence: r ? Number(r.confidence) : 0,
    adjustment: r ? Number(r.adjustment) : 0,
    neighbours: r?.neighbours || 0,
    weightedDegree: r ? Number(r.weighted_degree) : 0,
    excluded: r?.excluded || [],
    computedAt: r?.computed_at || null,
    given: vouches.rows.filter((v) => v.voucher_id === userId),
    received: vouches.rows.filter((v) => v.vouchee_id === userId),
  };
}

async function vouch(user, voucheeId, { note } = {}, meta = {}) {
  if (!BROKER_ROLES.includes(user.role)) throw forbidden('Only brokers, agencies and builders can vouch');
  if (voucheeId === user.id) throw badRequest('You cannot vouch for yourself');
  const c = await cfg();
  const target = (await pool.query(`SELECT u.id, u.tenant_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [voucheeId])).rows[0];
  if (!target || !BROKER_ROLES.includes(target.role)) throw notFound('Broker not found');
  const trust = (await pool.query('SELECT score FROM trust_scores WHERE user_id = $1', [user.id])).rows[0];
  if ((Number(trust?.score) || 0) < c.vouchMinTrust) throw forbidden(`A trust score of ${c.vouchMinTrust}+ is needed to vouch for another broker`);
  const live = (await pool.query('SELECT COUNT(*)::int AS n FROM broker_vouches WHERE voucher_id = $1 AND revoked_at IS NULL', [user.id])).rows[0].n;
  if (live >= c.vouchLimit) throw badRequest(`You can vouch for at most ${c.vouchLimit} brokers - revoke one first`);
  const r = await pool
    .query(`INSERT INTO broker_vouches (voucher_id, vouchee_id, note) VALUES ($1, $2, $3) RETURNING *`, [user.id, voucheeId, note ? String(note).slice(0, 500) : null])
    .catch((err) => {
      if (err.code === '23505') throw badRequest('You already vouch for this broker');
      throw err;
    });
  await auditService.log({ actor: user, action: 'reputation.vouch', entityType: 'user', entityId: voucheeId, after: { note }, ...meta });
  await notificationService.createNotification({
    userId: voucheeId,
    type: 'reputation',
    title: `${user.full_name || 'A broker'} vouched for you`,
    message: 'Vouches from established brokers strengthen your network reputation.',
    relatedEntityType: 'user',
    relatedEntityId: user.id,
  });
  return r.rows[0];
}

async function revokeVouch(user, vouchId, meta = {}) {
  const r = await pool.query(
    `UPDATE broker_vouches SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND (voucher_id = $2 OR $3) RETURNING *`,
    [vouchId, user.id, ['admin', 'super_admin'].includes(user.role)]
  );
  if (!r.rows[0]) throw notFound('Vouch not found');
  await auditService.log({ actor: user, action: 'reputation.vouch_revoked', entityType: 'user', entityId: r.rows[0].vouchee_id, ...meta });
  return r.rows[0];
}

let timer = null;
function startScheduler() {
  if (timer) return;
  const run = () => recomputeAll().catch((err) => console.error('[reputation] recompute failed:', err.message));
  // First run a minute after boot, then daily.
  setTimeout(run, 60 * 1000).unref?.();
  timer = setInterval(run, 24 * 60 * 60 * 1000);
}

module.exports = { recomputeAll, egoGraph, globalGraph, summary, vouch, revokeVouch, startScheduler, scoreFor };
