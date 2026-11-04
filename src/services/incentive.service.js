const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Employee incentive engine (contract sec. 33.3, 33.9, 33.12, 34) - see
// migration 093 for the tables.
//
//   sync()       turns what the platform already records into scoring facts
//                for every employee holding an EM code: first contact logged
//                ("attended"), response window missed, response SLA breached,
//                site visit completed and deal closed won on their deals.
//                A related-party transaction is recorded but excluded (0
//                points) for the related employee (sec. 33.12). Points follow
//                incentive.rules when the fact is recorded.
//   Months       open -> approved (statements frozen; rupees = points x
//                rupeesPerPoint, with the minimum and cap in the rules at
//                approval) -> exported (CSV for payroll). The payout itself is
//                salary, paid by payroll - nothing is paid from here.
//   Who sees     an employee their own scorecard; a Team Leader their team;
//                admins everyone. Approval, export, rules, adjustments and
//                exits: Super Admin. EM codes are internal only.

const ADMIN = ['admin', 'super_admin'];
const KINDS = ['cascade_attended', 'cascade_missed', 'sla_breached', 'site_visit_done', 'deal_closed', 'adjustment'];
const KIND_LABEL = {
  cascade_attended: 'Inquiries attended', cascade_missed: 'Response windows missed', sla_breached: 'Response SLA breached',
  site_visit_done: 'Site visits completed', deal_closed: 'Deals closed', adjustment: 'Adjustments',
};
const DEFAULT_RULES = {
  points: { cascade_attended: 5, cascade_missed: -10, sla_breached: -5, site_visit_done: 10, deal_closed: 50 },
  dealPointsPerLakh: 1, dealPointsCap: 500, rupeesPerPoint: 0, minPointsForPayout: 0, monthlyCapInr: null,
};

const assertSuper = (u) => {
  if (u?.role !== 'super_admin') throw forbidden('Only the Super Admin manages incentives');
};

async function rules() {
  const r = (await configService.getConfig('incentive.rules', DEFAULT_RULES)) || DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...r, points: { ...DEFAULT_RULES.points, ...(r.points || {}) } };
}

// First day of the month, in IST (the platform's business calendar).
const monthOf = (d) => {
  const ist = new Date(new Date(d).getTime() + 330 * 60000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-01`;
};
const validPeriod = (p) => {
  if (!/^\d{4}-\d{2}(-01)?$/.test(String(p || ''))) throw badRequest('Give the month as YYYY-MM');
  return String(p).length === 7 ? `${p}-01` : String(p);
};

// The month a fact lands in: its own month, unless that month is already
// approved - then the current open month, marked late.
async function landingPeriod(occurredAt, closedCache) {
  const own = monthOf(occurredAt);
  if (!closedCache.has(own)) return { period: own, late: false };
  return { period: monthOf(new Date()), late: true };
}

// ------------------------------------------------------------------ sync

async function sync({ days = 70 } = {}) {
  const r = await rules();
  const closed = new Set((await pool.query(`SELECT to_char(period, 'YYYY-MM-DD') AS p FROM incentive_periods WHERE status <> 'open'`)).rows.map((x) => x.p));
  const since = new Date(Date.now() - days * 86400000);
  const facts = [];

  // Sec. 34: attended inquiries count for the employee, missed ones against.
  const cascade = (await pool.query(
    `SELECT e.id, e.kind, e.from_user_id AS user_id, e.lead_id, e.created_at AS at, c.em_code,
            (e.from_user_id = ANY(l.related_party_employee_ids)) AS related
     FROM lead_assignment_events e
     JOIN employee_codes c ON c.user_id = e.from_user_id
     JOIN leads l ON l.id = e.lead_id
     WHERE e.kind IN ('contacted', 'missed', 'sla_breached') AND e.created_at >= $1
       AND NOT EXISTS (SELECT 1 FROM incentive_events i WHERE i.source_type = 'assignment_event' AND i.source_id = e.id AND i.user_id = e.from_user_id)`,
    [since]
  )).rows;
  for (const e of cascade) {
    const kind = e.kind === 'contacted' ? 'cascade_attended' : e.kind === 'missed' ? 'cascade_missed' : 'sla_breached';
    facts.push({ ...e, kind, sourceType: 'assignment_event', sourceId: e.id, dealId: null, points: Number(r.points[kind]) || 0 });
  }

  const visits = (await pool.query(
    `SELECT v.id, d.assigned_rep_id AS user_id, d.id AS deal_id, d.lead_id, COALESCE(v.actual_visit_at, v.updated_at) AS at, c.em_code,
            (d.assigned_rep_id = ANY(d.related_party_employee_ids)) AS related
     FROM site_visits v JOIN deals d ON d.id = v.deal_id JOIN employee_codes c ON c.user_id = d.assigned_rep_id
     WHERE v.status = 'completed' AND COALESCE(v.actual_visit_at, v.updated_at) >= $1
       AND NOT EXISTS (SELECT 1 FROM incentive_events i WHERE i.source_type = 'site_visit' AND i.source_id = v.id AND i.user_id = d.assigned_rep_id)`,
    [since]
  )).rows;
  for (const v of visits) facts.push({ ...v, kind: 'site_visit_done', sourceType: 'site_visit', sourceId: v.id, dealId: v.deal_id, points: Number(r.points.site_visit_done) || 0 });

  const deals = (await pool.query(
    `SELECT d.id, d.assigned_rep_id AS user_id, d.lead_id, d.deal_value, COALESCE(d.closed_at, d.stage_entered_at, d.updated_at) AS at, c.em_code,
            (d.assigned_rep_id = ANY(d.related_party_employee_ids)) AS related
     FROM deals d JOIN employee_codes c ON c.user_id = d.assigned_rep_id
     WHERE d.stage = 'closed_won' AND COALESCE(d.closed_at, d.stage_entered_at, d.updated_at) >= $1
       AND NOT EXISTS (SELECT 1 FROM incentive_events i WHERE i.source_type = 'deal' AND i.source_id = d.id AND i.user_id = d.assigned_rep_id)`,
    [since]
  )).rows;
  for (const d of deals) {
    const valuePoints = Math.min(Number(r.dealPointsCap) || Infinity, Math.floor(((Number(d.deal_value) || 0) / 1e5) * (Number(r.dealPointsPerLakh) || 0)));
    facts.push({ ...d, kind: 'deal_closed', sourceType: 'deal', sourceId: d.id, dealId: d.id, points: (Number(r.points.deal_closed) || 0) + valuePoints });
  }

  let added = 0;
  for (const f of facts) {
    const { period, late } = await landingPeriod(f.at, closed);
    const res = await pool.query(
      `INSERT INTO incentive_events (user_id, em_code, period, kind, points, excluded, exclude_reason, source_type, source_id, lead_id, deal_id, occurred_at, late)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (kind, source_type, source_id, user_id) WHERE kind <> 'adjustment' DO NOTHING`,
      [f.user_id, f.em_code, period, f.kind, f.related ? 0 : f.points, !!f.related, f.related ? 'Related-party transaction (sec. 33.12) - no incentive for the related employee' : null,
        f.sourceType, f.sourceId, f.lead_id || null, f.dealId, f.at, late]
    );
    added += res.rowCount;
  }
  return { checked: facts.length, added };
}

// ------------------------------------------------------------------ views

// Whose scores this viewer may see.
async function scopeOf(viewer) {
  if (ADMIN.includes(viewer.role)) return { all: true };
  const me = (await pool.query(`SELECT designation FROM arb_representatives WHERE user_id = $1`, [viewer.id])).rows[0];
  if (!me) throw forbidden('Incentives are for A R Buildwel employees');
  if (me.designation === 'tl') {
    const team = (await pool.query(`SELECT user_id FROM arb_representatives WHERE team_leader_id = $1`, [viewer.id])).rows.map((x) => x.user_id);
    return { ids: [viewer.id, ...team] };
  }
  return { ids: [viewer.id] };
}

function amountFor(points, r) {
  if (points < (Number(r.minPointsForPayout) || 0) || points <= 0) return 0;
  const raw = Math.round(points * (Number(r.rupeesPerPoint) || 0) * 100) / 100;
  return r.monthlyCapInr ? Math.min(raw, Number(r.monthlyCapInr)) : raw;
}

async function board(viewer, { period } = {}) {
  const p = validPeriod(period || monthOf(new Date()).slice(0, 7));
  const scope = await scopeOf(viewer);
  const [r, state] = await Promise.all([rules(), pool.query(`SELECT * FROM incentive_periods WHERE period = $1`, [p])]);
  const per = state.rows[0] || { period: p, status: 'open' };
  if (per.status !== 'open') {
    const st = (await pool.query(
      `SELECT s.*, u.full_name, u.status AS user_status FROM incentive_statements s JOIN users u ON u.id = s.user_id
       WHERE s.period = $1 AND ($2::boolean OR s.user_id = ANY($3)) ORDER BY s.points DESC`,
      [p, !!scope.all, scope.ids || []]
    )).rows;
    return {
      period: p.slice(0, 7), status: per.status, approvedAt: per.approved_at, exportedAt: per.exported_at, rules: per.rules,
      rows: st.map((s) => ({ userId: s.user_id, name: s.full_name, emCode: s.em_code, designation: s.designation, points: Number(s.points), excludedPoints: Number(s.excluded_points), breakdown: s.breakdown, amountInr: Number(s.amount_inr), active: s.user_status === 'active' })),
    };
  }
  const rows = (await pool.query(
    `SELECT c.user_id, u.full_name, c.em_code, c.designation, u.status AS user_status, e.kind,
            COALESCE(SUM(e.points) FILTER (WHERE NOT e.excluded), 0)::float AS points,
            COUNT(e.id) FILTER (WHERE NOT e.excluded)::int AS n,
            COUNT(e.id) FILTER (WHERE e.excluded)::int AS excluded
     FROM employee_codes c JOIN users u ON u.id = c.user_id
     LEFT JOIN incentive_events e ON e.user_id = c.user_id AND e.period = $1
     WHERE c.status = 'active' AND ($2::boolean OR c.user_id = ANY($3))
     GROUP BY c.user_id, u.full_name, c.em_code, c.designation, u.status, e.kind`,
    [p, !!scope.all, scope.ids || []]
  )).rows;
  const by = new Map();
  for (const x of rows) {
    const o = by.get(x.user_id) || { userId: x.user_id, name: x.full_name, emCode: x.em_code, designation: x.designation, active: x.user_status === 'active', points: 0, excludedFacts: 0, breakdown: {} };
    if (x.kind) {
      o.breakdown[x.kind] = { count: x.n, points: x.points };
      o.points += x.points;
      o.excludedFacts += x.excluded;
    }
    by.set(x.user_id, o);
  }
  const list = [...by.values()].map((o) => ({ ...o, points: Math.round(o.points * 100) / 100, amountInr: amountFor(o.points, r) })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  // Admins see only the people with something scored this month.
  return { period: p.slice(0, 7), status: 'open', rules: r, labels: KIND_LABEL, rows: scope.all ? list.filter((o) => o.points || Object.keys(o.breakdown).length) : list };
}

// One employee's facts for a month.
async function scorecard(viewer, userId, { period } = {}) {
  const p = validPeriod(period || monthOf(new Date()).slice(0, 7));
  const scope = await scopeOf(viewer);
  if (!scope.all && !scope.ids.includes(userId)) throw forbidden('Not in your team');
  const code = (await pool.query(`SELECT c.*, u.full_name FROM employee_codes c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1`, [userId])).rows[0];
  if (!code) throw notFound('This person has no employee code');
  const events = (await pool.query(`SELECT * FROM incentive_events WHERE user_id = $1 AND period = $2 ORDER BY occurred_at DESC LIMIT 500`, [userId, p])).rows;
  const total = events.filter((e) => !e.excluded).reduce((s, e) => s + Number(e.points), 0);
  return {
    period: p.slice(0, 7), userId, name: code.full_name, emCode: code.em_code, designation: code.designation, codeStatus: code.status,
    points: Math.round(total * 100) / 100, amountInr: amountFor(total, await rules()), labels: KIND_LABEL,
    events: events.map((e) => ({ id: e.id, kind: e.kind, label: KIND_LABEL[e.kind], points: Number(e.points), excluded: e.excluded, excludeReason: e.exclude_reason, leadId: e.lead_id, dealId: e.deal_id, at: e.occurred_at, note: e.note, late: e.late })),
  };
}

// ------------------------------------------------------------------ admin

async function adjust(admin, { userId, period, points, note } = {}, meta = {}) {
  assertSuper(admin);
  const p = validPeriod(period);
  const n = Number(points);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 10000) throw badRequest('Give the points to add or take away (not 0)');
  if (!note || String(note).trim().length < 5) throw badRequest('Say why');
  const code = (await pool.query(`SELECT em_code FROM employee_codes WHERE user_id = $1`, [userId])).rows[0];
  if (!code) throw notFound('This person has no employee code');
  const state = (await pool.query(`SELECT status FROM incentive_periods WHERE period = $1`, [p])).rows[0];
  if (state && state.status !== 'open') throw badRequest('That month is already approved - adjust the current month instead');
  const row = (await pool.query(
    `INSERT INTO incentive_events (user_id, em_code, period, kind, points, source_type, source_id, occurred_at, note, created_by)
     VALUES ($1, $2, $3, 'adjustment', $4, 'manual', gen_random_uuid(), now(), $5, $6) RETURNING *`,
    [userId, code.em_code, p, n, String(note).trim().slice(0, 300), admin.id]
  )).rows[0];
  await auditService.log({ actor: admin, action: 'incentive.adjusted', entityType: 'incentive_event', entityId: row.id, after: { userId, period: p, points: n, note }, ...meta });
  return { id: row.id, points: n };
}

async function approve(admin, period, meta = {}) {
  assertSuper(admin);
  const p = validPeriod(period);
  if (p >= monthOf(new Date())) throw badRequest('A month can be approved once it is over');
  await sync({ days: 400 });
  const r = await rules();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query(`SELECT status FROM incentive_periods WHERE period = $1 FOR UPDATE`, [p])).rows[0];
    if (cur && cur.status !== 'open') throw badRequest(`That month is already ${cur.status}`);
    await client.query(
      `INSERT INTO incentive_periods (period, status, rules, approved_by, approved_at) VALUES ($1, 'approved', $2, $3, now())
       ON CONFLICT (period) DO UPDATE SET status = 'approved', rules = $2, approved_by = $3, approved_at = now()`,
      [p, JSON.stringify(r), admin.id]
    );
    const rows = (await client.query(
      `SELECT e.user_id, c.em_code, c.designation, e.kind,
              COALESCE(SUM(e.points) FILTER (WHERE NOT e.excluded), 0)::float AS points, COUNT(*) FILTER (WHERE NOT e.excluded)::int AS n,
              COUNT(*) FILTER (WHERE e.excluded)::int AS excluded
       FROM incentive_events e JOIN employee_codes c ON c.user_id = e.user_id
       WHERE e.period = $1 GROUP BY e.user_id, c.em_code, c.designation, e.kind`,
      [p]
    )).rows;
    const by = new Map();
    for (const x of rows) {
      const o = by.get(x.user_id) || { emCode: x.em_code, designation: x.designation, points: 0, excluded: 0, breakdown: {} };
      o.points += x.points;
      o.excluded += x.excluded;
      o.breakdown[x.kind] = { count: x.n, points: x.points };
      by.set(x.user_id, o);
    }
    let total = 0;
    for (const [userId, o] of by) {
      const amount = amountFor(o.points, r);
      total += amount;
      await client.query(
        `INSERT INTO incentive_statements (period, user_id, em_code, designation, points, excluded_points, breakdown, amount_inr) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p, userId, o.emCode, o.designation, Math.round(o.points * 100) / 100, o.excluded, JSON.stringify(o.breakdown), amount]
      );
    }
    await client.query('COMMIT');
    await auditService.log({ actor: admin, action: 'incentive.month_approved', entityType: 'incentive_period', entityId: null, after: { period: p, employees: by.size, totalInr: total, rupeesPerPoint: r.rupeesPerPoint }, ...meta });
    return { period: p.slice(0, 7), status: 'approved', employees: by.size, totalInr: Math.round(total * 100) / 100 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// CSV for payroll (EM code is the payroll key). Marks the month exported.
async function exportCsv(admin, period, meta = {}) {
  assertSuper(admin);
  const p = validPeriod(period);
  const cur = (await pool.query(`SELECT status FROM incentive_periods WHERE period = $1`, [p])).rows[0];
  if (!cur || cur.status === 'open') throw badRequest('Approve the month first');
  const rows = (await pool.query(
    `SELECT s.*, u.full_name FROM incentive_statements s JOIN users u ON u.id = s.user_id WHERE s.period = $1 ORDER BY s.em_code`,
    [p]
  )).rows;
  const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const head = ['month', 'em_code', 'name', 'designation', 'points', 'excluded_facts', ...KINDS.map((k) => `${k}_points`), 'incentive_inr'];
  const lines = [head.join(',')];
  for (const s of rows) {
    lines.push([p.slice(0, 7), s.em_code, s.full_name, s.designation, s.points, s.excluded_points, ...KINDS.map((k) => s.breakdown?.[k]?.points ?? 0), s.amount_inr].map(esc).join(','));
  }
  await pool.query(`UPDATE incentive_periods SET status = 'exported', exported_by = $2, exported_at = now() WHERE period = $1`, [p, admin.id]);
  await auditService.log({ actor: admin, action: 'incentive.month_exported', entityType: 'incentive_period', entityId: null, after: { period: p, rows: rows.length }, ...meta });
  return { filename: `incentives-${p.slice(0, 7)}.csv`, csv: `${lines.join('\n')}\n` };
}

async function saveRules(admin, data = {}, meta = {}) {
  assertSuper(admin);
  const cur = await rules();
  const next = { ...cur };
  if (data.points !== undefined) {
    for (const [k, v] of Object.entries(data.points || {})) {
      if (!(k in DEFAULT_RULES.points)) throw badRequest(`Unknown fact: ${k}`);
      if (!Number.isFinite(Number(v)) || Math.abs(Number(v)) > 10000) throw badRequest(`Points for ${KIND_LABEL[k]} must be a number`);
      next.points = { ...next.points, [k]: Number(v) };
    }
  }
  for (const k of ['dealPointsPerLakh', 'dealPointsCap', 'rupeesPerPoint', 'minPointsForPayout']) {
    if (data[k] !== undefined) {
      const v = Number(data[k]);
      if (!Number.isFinite(v) || v < 0 || v > 1e7) throw badRequest(`${k} must be 0 or more`);
      next[k] = v;
    }
  }
  if (data.monthlyCapInr !== undefined) {
    const v = data.monthlyCapInr === null || data.monthlyCapInr === '' ? null : Number(data.monthlyCapInr);
    if (v !== null && (!Number.isFinite(v) || v <= 0)) throw badRequest('The monthly cap must be more than 0, or empty for none');
    next.monthlyCapInr = v;
  }
  await configService.updateConfig('incentive.rules', next, { reason: data.reason || 'Incentive rules updated' }, admin, meta);
  return next;
}

// Exit (resignation / termination): the code is retired for good, the
// account is switched off, and the assignment sweep re-routes their open
// inquiries (sec. 34 exit re-injection).
async function terminate(admin, userId, { reason } = {}, meta = {}) {
  assertSuper(admin);
  if (!reason || String(reason).trim().length < 5) throw badRequest('Give the reason for the exit');
  if (userId === admin.id) throw badRequest('You cannot record your own exit');
  const c = (await pool.query(
    `UPDATE employee_codes SET status = 'terminated', terminated_at = now(), exit_reason = $2,
            history = history || jsonb_build_array(jsonb_build_object('at', now(), 'event', 'terminated'))
     WHERE user_id = $1 AND status = 'active' RETURNING em_code`,
    [userId, String(reason).trim().slice(0, 300)]
  )).rows[0];
  if (!c) throw badRequest('No active employee code for this person');
  await pool.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [userId]);
  await pool.query(`UPDATE arb_representatives SET accepts_assignments = false WHERE user_id = $1`, [userId]);
  await auditService.log({ actor: admin, action: 'employee.exited', entityType: 'user', entityId: userId, after: { emCode: c.em_code, reason }, ...meta });
  return { emCode: c.em_code, status: 'terminated' };
}

// Super Admin only: every code, including retired ones.
async function codes(admin) {
  assertSuper(admin);
  return (await pool.query(
    `SELECT c.*, u.full_name, u.status AS user_status FROM employee_codes c JOIN users u ON u.id = c.user_id ORDER BY c.serial`
  )).rows.map((c) => ({ userId: c.user_id, name: c.full_name, emCode: c.em_code, serial: c.serial, designation: c.designation, status: c.status, issuedAt: c.issued_at, terminatedAt: c.terminated_at, exitReason: c.exit_reason, history: c.history }));
}

async function periods(viewer) {
  await scopeOf(viewer);
  return (await pool.query(`SELECT to_char(period, 'YYYY-MM') AS period, status, approved_at, exported_at FROM incentive_periods ORDER BY period DESC LIMIT 24`)).rows;
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sync().catch((err) => console.error('[incentives] sync failed:', err.message)), 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = { sync, board, scorecard, adjust, approve, exportCsv, rules, saveRules, terminate, codes, periods, startScheduler, monthOf, KIND_LABEL };
