const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Annexure A sec. 10 + sec. 34 - Universal Inquiry Assignment Cascade.
// Every inquiry (website, portal, requirement, WhatsApp, opportunity, CRM)
// gets an A R representative the moment it is created, and is passed on
// automatically if first contact is not LOGGED within the hop window:
//   hop 1  broker on the buyer side  -> the buyer's broker's mapped RM
//          broker on the seller side -> the seller's broker's mapped RM
//          broker but no mapping     -> least-busy RM in the region (gap flagged)
//          no broker on either side  -> least-busy DM in the region
//   hop 2  buyer-broker RM missed    -> seller's broker's mapped RM
//          otherwise                 -> next least-busy RM / DM in the region
//   hop 3+ system pool               -> least-busy RM / DM platform-wide
//                                       (Area / City Head - admins - alerted)
// "Attended" = first contact logged (status moved on from New, or Log
// contact). Windows count only inside working hours. Sticky once attended;
// only admins / team leaders reassign. A rep who leaves has their open
// inquiries re-routed. Every hop is written to lead_assignment_events.

const CLOSED = ['won', 'lost'];
const ADMIN = ['admin', 'super_admin'];
const REP_ROLES = ['internal_sales', 'admin', 'super_admin'];

async function cfg() {
  const [windowMinutes, hours, openStatuses, sla, maxHops] = await Promise.all([
    configService.getConfig('assignment.response_sla_minutes', 15),
    configService.getConfig('assignment.working_hours', { start: '10:00', end: '21:00', timezone_offset_minutes: 330 }),
    configService.getConfig('assignment.open_statuses', ['new', 'contacted', 'qualified', 'hot', 'warm', 'cold']),
    configService.getConfig('mandate.response_sla_hours', { exclusive: 2, standard: 24 }),
    configService.getConfig('assignment.max_hops', 5),
  ]);
  return {
    windowMinutes: Number(windowMinutes) || 15,
    hours: { start: '10:00', end: '21:00', timezone_offset_minutes: 330, ...(hours || {}) },
    openStatuses: Array.isArray(openStatuses) ? openStatuses : ['new', 'contacted', 'qualified', 'hot', 'warm', 'cold'],
    sla: { exclusive: 2, standard: 24, ...(sla || {}) },
    maxHops: Math.max(3, Number(maxHops) || 5),
  };
}

// ------------------------------------------------------------ working hours

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

// Window end: `minutes` of working time from `from`.
function windowDue(from, minutes, hours) {
  const offset = Number(hours.timezone_offset_minutes) || 0;
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  if (!(end > start)) return new Date(from.getTime() + minutes * 60000); // 24 h operation
  let t = new Date(from.getTime());
  let left = minutes;
  for (let guard = 0; guard < 30 && left > 0; guard += 1) {
    const local = new Date(t.getTime() + offset * 60000);
    const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (mins < start) {
      t = new Date(t.getTime() + (start - mins) * 60000);
      continue;
    }
    if (mins >= end) {
      t = new Date(t.getTime() + (24 * 60 - mins + start) * 60000);
      continue;
    }
    const step = Math.min(left, end - mins);
    t = new Date(t.getTime() + step * 60000);
    left -= step;
  }
  return t;
}

// ------------------------------------------------------------ context

async function leadContext(leadId, client = pool) {
  const lead = (
    await client.query(
      `SELECT l.*, creator_role.name AS creator_role
       FROM leads l
       LEFT JOIN users cu ON cu.id = l.created_by
       LEFT JOIN roles creator_role ON creator_role.id = cu.role_id
       WHERE l.id = $1`,
      [leadId]
    )
  ).rows[0];
  if (!lead) throw notFound('Lead not found');
  let city = null;
  let locality = null;
  let sellerBrokerId = null;
  let exclusive = false;
  if (lead.property_id) {
    const p = (
      await client.query(
        `SELECT p.city, p.locality, p.broker_id, p.created_by, p.mandate_type, r.name AS lister_role
         FROM properties p LEFT JOIN users u ON u.id = p.created_by LEFT JOIN roles r ON r.id = u.role_id WHERE p.id = $1`,
        [lead.property_id]
      )
    ).rows[0];
    if (p) {
      city = p.city;
      locality = p.locality;
      sellerBrokerId = p.broker_id || (p.lister_role === 'broker' ? p.created_by : null);
      exclusive = p.mandate_type === 'exclusive';
    }
  }
  const req = (await client.query(`SELECT city, localities, mandate_type FROM requirements WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [leadId])).rows[0];
  if (req) {
    city = city || req.city;
    locality = locality || (Array.isArray(req.localities) ? req.localities[0] : null);
    exclusive = exclusive || req.mandate_type === 'exclusive';
  }
  if (!city) {
    // Ingested leads (portals, ads, email, Telegram) keep the parsed location.
    const inbox = (await client.query(
      `SELECT parsed_city, parsed_locality FROM lead_ingestion_inbox WHERE created_lead_id = $1 ORDER BY created_at LIMIT 1`, [leadId]
    )).rows[0];
    if (inbox) {
      city = inbox.parsed_city || null;
      locality = locality || inbox.parsed_locality || null;
    }
  }
  if (!city && lead.customer_id) {
    const pref = (await client.query(`SELECT preferred_locations FROM customer_preferences WHERE customer_id = $1`, [lead.customer_id])).rows[0];
    const locs = (Array.isArray(pref?.preferred_locations) ? pref.preferred_locations : [])
      .map((x) => (x && typeof x === 'object' ? x.city || x.locality : x)).filter(Boolean).map(String);
    for (const loc of locs) {
      const known = (await client.query(`SELECT 1 FROM cities WHERE lower(city_name) = lower($1) LIMIT 1`, [loc])).rows.length > 0;
      if (known && !city) city = loc;
      else if (!known && !locality) locality = loc;
    }
    if (!city && locs.length > 1) city = locs[locs.length - 1];
  }
  let stateCode = null;
  if (city) {
    stateCode = (
      await client.query(`SELECT s.state_code FROM cities c JOIN states s ON s.id = c.state_id WHERE lower(c.city_name) = lower($1) LIMIT 1`, [city])
    ).rows[0]?.state_code || null;
  }
  const buyerBrokerId = lead.creator_role === 'broker' ? lead.created_by : null;
  return { lead, city, locality, stateCode, buyerBrokerId, sellerBrokerId, exclusive };
}

// ------------------------------------------------------------ picking reps

const REGION_SQL = `(
  ($REG_LOC::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ar.coverage_localities) x WHERE lower(x) = lower($REG_LOC)))
  OR ($REG_CITY::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ar.assigned_cities) x WHERE lower(x) = lower($REG_CITY)))
  OR ($REG_STATE::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ar.assigned_states) x WHERE upper(x) = upper($REG_STATE))))`;

async function leastBusy(designations, ctx, exclude, { region = true } = {}) {
  const c = await cfg();
  const params = [designations, exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000'], c.openStatuses];
  let regionClause = '';
  if (region) {
    params.push(ctx.locality || null, ctx.city || null, ctx.stateCode || null);
    regionClause = `AND ${REGION_SQL.replace(/\$REG_LOC/g, '$4').replace(/\$REG_CITY/g, '$5').replace(/\$REG_STATE/g, '$6')}`;
  }
  const row = (
    await pool.query(
      `SELECT ar.user_id,
              (SELECT COUNT(*) FROM leads l WHERE l.arb_rep_id = ar.user_id AND l.status::text = ANY($3))::int AS open_load,
              (SELECT MAX(l.assigned_at) FROM leads l WHERE l.arb_rep_id = ar.user_id) AS last_assigned
       FROM arb_representatives ar
       JOIN users u ON u.id = ar.user_id AND u.status = 'active'
       WHERE ar.accepts_assignments AND ar.designation = ANY($1) AND NOT (ar.user_id = ANY($2::uuid[])) ${regionClause}
       ORDER BY open_load ASC, last_assigned ASC NULLS FIRST, ar.created_at ASC
       LIMIT 1`,
      params
    )
  ).rows[0];
  return row?.user_id || null;
}

async function mappedRm(brokerId) {
  if (!brokerId) return null;
  return (
    await pool.query(
      `SELECT m.rm_id FROM broker_rm_mapping m
       JOIN users u ON u.id = m.rm_id AND u.status = 'active'
       JOIN arb_representatives ar ON ar.user_id = m.rm_id AND ar.accepts_assignments
       WHERE m.broker_id = $1`,
      [brokerId]
    )
  ).rows[0]?.rm_id || null;
}

async function missedBy(leadId) {
  return (await pool.query(`SELECT DISTINCT from_user_id FROM lead_assignment_events WHERE lead_id = $1 AND kind IN ('missed', 'exit_reinjected') AND from_user_id IS NOT NULL`, [leadId])).rows.map((r) => r.from_user_id);
}

// Who gets `hop`, and by which route. `previousRoute` drives hop 2.
async function choose(hop, ctx, exclude, previousRoute) {
  const regional = async (designations) => (await leastBusy(designations, ctx, exclude)) || null;
  const anywhere = async (designations) => leastBusy(designations, ctx, exclude, { region: false });
  if (hop <= 1) {
    const buyerRm = await mappedRm(ctx.buyerBrokerId);
    if (buyerRm && !exclude.includes(buyerRm)) return { userId: buyerRm, route: 'buyer_broker_rm' };
    const sellerRm = await mappedRm(ctx.sellerBrokerId);
    if (sellerRm && !exclude.includes(sellerRm)) return { userId: sellerRm, route: 'seller_broker_rm' };
    if (ctx.buyerBrokerId || ctx.sellerBrokerId) {
      const id = (await regional(['rm'])) || (await regional(['rm', 'dm'])) || (await anywhere(['rm', 'dm']));
      return { userId: id, route: 'unmapped_broker_rm', mappingGap: ctx.buyerBrokerId || ctx.sellerBrokerId };
    }
    const id = (await regional(['dm'])) || (await regional(['rm', 'dm'])) || (await anywhere(['dm'])) || (await anywhere(['rm', 'dm']));
    return { userId: id, route: 'dm_least_busy' };
  }
  if (hop === 2) {
    if (previousRoute === 'buyer_broker_rm') {
      const sellerRm = await mappedRm(ctx.sellerBrokerId);
      if (sellerRm && !exclude.includes(sellerRm)) return { userId: sellerRm, route: 'seller_broker_rm' };
    }
    const id = (await regional(['rm', 'dm'])) || (await anywhere(['rm', 'dm']));
    return { userId: id, route: 'next_free' };
  }
  // Hop 3+: system pool. If everyone has already missed it, the least busy
  // of them takes it again rather than the inquiry sitting unattended.
  const id = (await anywhere(['rm', 'dm'])) || (await leastBusy(['rm', 'dm'], ctx, [], { region: false }));
  return { userId: id, route: 'system_pool' };
}

// ------------------------------------------------------------ notifications

async function teamLeaderOf(userId) {
  return (await pool.query('SELECT team_leader_id FROM arb_representatives WHERE user_id = $1', [userId])).rows[0]?.team_leader_id || null;
}

async function adminIds() {
  return (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = ANY($1) AND u.status = 'active'`, [ADMIN])).rows.map((r) => r.id);
}

async function notify(ids, { type, title, message, leadId }) {
  for (const userId of new Set(ids.filter(Boolean))) {
    await notificationService
      .createNotification({ userId, type, title, message, relatedEntityType: 'lead', relatedEntityId: leadId })
      .catch(() => {});
  }
}

async function logEvent(leadId, { hop, kind, route = null, from = null, to = null, actor = null, detail = {} }, client = pool) {
  await client.query(
    `INSERT INTO lead_assignment_events (lead_id, hop, kind, route, from_user_id, to_user_id, actor_id, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
    [leadId, hop, kind, route, from, to, actor, JSON.stringify(detail)]
  );
}

// ------------------------------------------------------------ core

// Assign (or pass on) one inquiry. `reason`: new | missed | exit.
async function route(leadId, { reason = 'new' } = {}) {
  const c = await cfg();
  const ctx = await leadContext(leadId);
  const { lead } = ctx;
  if (CLOSED.includes(lead.status)) return null;
  if (reason !== 'exit' && lead.first_contacted_at) return null; // sticky once attended

  // A lead created with an assignee already (e.g. an investor's own RM) keeps
  // them as hop 1.
  if (reason === 'new' && lead.assigned_to && !lead.assigned_at) {
    const isRep = (await pool.query(`SELECT 1 FROM arb_representatives ar JOIN users u ON u.id = ar.user_id AND u.status = 'active' WHERE ar.user_id = $1`, [lead.assigned_to])).rows.length > 0;
    if (isRep) return place(lead, ctx, c, { userId: lead.assigned_to, route: 'preassigned_rm' }, 1, null);
  }
  if (reason === 'new' && lead.assigned_at) return null; // already in the cascade

  // Past the hop cap the inquiry stays with its last representative; admins
  // are told once instead of it circling the pool indefinitely.
  if (reason === 'missed' && lead.assignment_hop >= c.maxHops) {
    const stopped = (await pool.query(
      `UPDATE leads SET assignment_due_at = NULL WHERE id = $1 AND assignment_hop = $2 AND first_contacted_at IS NULL AND assignment_due_at IS NOT NULL RETURNING id`,
      [leadId, lead.assignment_hop]
    )).rows[0];
    if (stopped) {
      await logEvent(leadId, { hop: lead.assignment_hop, kind: 'missed', from: lead.arb_rep_id, detail: { final: true, reason: 'hop cap reached - left with last representative' } });
      await notify(await adminIds(), {
        type: 'inquiry_unattended', title: `Inquiry unattended after ${lead.assignment_hop} hops`,
        message: `${ctx.locality ? `${ctx.locality}, ` : ''}${ctx.city || 'Location not given'} - no representative logged contact. Reassign it manually.`, leadId,
      });
    }
    return null;
  }
  const exclude = await missedBy(leadId);
  let hop = reason === 'missed' ? lead.assignment_hop + 1 : reason === 'exit' ? 1 : Math.max(1, lead.assignment_hop || 0);
  // The rep who just missed (or left) is never handed it straight back - their
  // 'missed' event is only written in place(), after this choice.
  if ((reason === 'exit' || reason === 'missed') && lead.arb_rep_id) exclude.push(lead.arb_rep_id);
  const pick = await choose(hop, ctx, exclude, lead.assignment_route);
  if (!pick.userId) return null; // no representative configured at all - picked up by the sweep later
  if (reason === 'exit') hop = Math.max(1, hop);
  return place(lead, ctx, c, pick, hop, reason === 'new' ? null : lead.arb_rep_id, reason);
}

async function place(lead, ctx, c, pick, hop, previous, reason = 'new') {
  const now = new Date();
  const due = windowDue(now, c.windowMinutes, c.hours);
  const firstAssignment = !lead.assigned_at;
  const slaHours = Number(ctx.exclusive ? c.sla.exclusive : c.sla.standard);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = (
      await client.query(
        `UPDATE leads SET arb_rep_id = $2,
           -- the CRM work queue follows the rep unless a broker / agency owns it
           assigned_to = CASE WHEN assigned_to IS NULL OR assigned_to = arb_rep_id THEN $2 ELSE assigned_to END,
           assignment_hop = $3, assignment_route = $4, assigned_at = $5, assignment_due_at = $6,
           response_sla_hours = COALESCE(response_sla_hours, $7),
           response_sla_due_at = COALESCE(response_sla_due_at, $8)
         WHERE id = $1 AND status <> ALL($9::lead_status[])
           -- optimistic guard: only move it from the state we read (no double hops when sweeps overlap)
           AND assignment_hop = $10 AND arb_rep_id IS NOT DISTINCT FROM $11
           AND ($12 OR first_contacted_at IS NULL)
         RETURNING id`,
        [lead.id, pick.userId, hop, pick.route, now, reason === 'exit' && lead.first_contacted_at ? null : due, slaHours,
          new Date(new Date(lead.created_at).getTime() + slaHours * 3600000), CLOSED,
          lead.assignment_hop, lead.arb_rep_id || null, reason === 'exit']
      )
    ).rows[0];
    if (!updated) {
      await client.query('ROLLBACK');
      return null;
    }
    if (previous && reason === 'missed') {
      await logEvent(lead.id, { hop: lead.assignment_hop, kind: 'missed', route: lead.assignment_route, from: previous, detail: { window_due_at: lead.assignment_due_at } }, client);
    }
    if (previous && reason === 'exit') {
      await logEvent(lead.id, { hop, kind: 'exit_reinjected', from: previous, to: pick.userId, route: pick.route, detail: { reason: 'representative no longer active' } }, client);
    }
    await logEvent(lead.id, { hop, kind: previous ? 'transferred' : 'assigned', route: pick.route, from: previous, to: pick.userId, detail: { window_due_at: due } }, client);
    if (pick.mappingGap) await logEvent(lead.id, { hop, kind: 'mapping_gap', detail: { broker_id: pick.mappingGap } }, client);
    // The deal follows the inquiry's live owner (contact access moves with it).
    await client.query(`UPDATE deals SET assigned_rep_id = $2 WHERE lead_id = $1`, [lead.id, pick.userId]);
    if (lead.arb_rep_id !== pick.userId) {
      await client.query(`INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, NULL, 'assigned', $2)`, [
        lead.id, JSON.stringify({ from: previous || null, to: pick.userId, hop, route: pick.route, auto: true, arb_rep: true }),
      ]).catch(() => {});
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const label = `${ctx.locality ? `${ctx.locality}, ` : ''}${ctx.city || 'location not given'}`;
  const tl = await teamLeaderOf(pick.userId);
  await notify([pick.userId, tl], {
    type: 'inquiry_assigned',
    title: `${previous ? 'Inquiry transferred to you' : 'New inquiry assigned'} (hop ${hop})`,
    message: `${label}. Log first contact by ${due.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} or it moves on automatically.${ctx.exclusive ? ` Exclusive Mandate - ${c.sla.exclusive} h response SLA.` : ''}`,
    leadId: lead.id,
  });
  if (previous && reason === 'missed') {
    await notify([previous, await teamLeaderOf(previous)], {
      type: 'inquiry_missed', title: 'Inquiry window missed', message: `No first contact was logged in time - the inquiry (${label}) moved to the next representative.`, leadId: lead.id,
    });
  }
  if (hop >= 3) {
    await notify(await adminIds(), {
      type: 'inquiry_system_pool', title: `Inquiry reached the system pool (hop ${hop})`, message: `${label} - missed by ${hop - 1} representative(s).`, leadId: lead.id,
    });
  }
  if (pick.mappingGap) {
    await notify(await adminIds(), {
      type: 'broker_mapping_gap', title: 'Broker has no mapped RM', message: 'An inquiry for an unmapped broker went to the least-busy RM. Map the broker to an RM in Representatives.', leadId: lead.id,
    });
  }
  return { userId: pick.userId, hop, route: pick.route, dueAt: due };
}

// Best-effort hook for every lead creation path - never breaks the caller.
function safeAssign(leadId) {
  return route(leadId, { reason: 'new' }).catch((err) => {
    console.error('[assignment] assign failed:', err.message);
    return null;
  });
}

// First contact logged - stops the cascade (sticky from here).
async function markContacted(leadId, user, via = 'status_change') {
  const lead = (await pool.query('SELECT id, arb_rep_id, assignment_hop, first_contacted_at FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) throw notFound('Lead not found');
  if (lead.first_contacted_at) return { alreadyContacted: true };
  if (lead.arb_rep_id !== user.id && !ADMIN.includes(user.role)) {
    throw forbidden('Only the assigned representative can log first contact');
  }
  await pool.query(`UPDATE leads SET first_contacted_at = now(), first_contacted_by = $2, assignment_due_at = NULL WHERE id = $1 AND first_contacted_at IS NULL`, [leadId, user.id]);
  await logEvent(leadId, { hop: lead.assignment_hop, kind: 'contacted', from: user.id, actor: user.id, detail: { via } });
  return { contacted: true };
}

// Manual reassignment (admins / team leaders) - sticky, logged.
async function recordManual(leadId, fromUserId, toUserId, actor) {
  const hop = (await pool.query('SELECT assignment_hop FROM leads WHERE id = $1', [leadId])).rows[0]?.assignment_hop || 0;
  const c = await cfg();
  const due = windowDue(new Date(), c.windowMinutes, c.hours);
  await pool.query(
    `UPDATE leads SET assigned_at = now(), assignment_route = 'manual', assignment_due_at = CASE WHEN first_contacted_at IS NULL THEN $2::timestamptz ELSE NULL END,
       assignment_hop = GREATEST(assignment_hop, 1) WHERE id = $1`,
    [leadId, due]
  );
  await pool.query(`UPDATE deals SET assigned_rep_id = $2 WHERE lead_id = $1`, [leadId, toUserId]);
  await logEvent(leadId, { hop, kind: 'manual_reassign', from: fromUserId, to: toUserId, actor: actor.id, route: 'manual' });
}

// ------------------------------------------------------------ sweep

async function sweep() {
  const out = { assigned: 0, transferred: 0, reinjected: 0, slaAlerts: 0 };
  // 1. Never assigned (e.g. no representative existed when it came in) -
  //    only inquiries since the cascade went live, not the old backlog.
  const since = await configService.getConfig('assignment.cascade_start', null);
  const unassigned = await pool.query(
    `SELECT id FROM leads WHERE assigned_at IS NULL AND first_contacted_at IS NULL AND status <> ALL($1::lead_status[])
       AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
     ORDER BY created_at LIMIT 200`,
    [CLOSED, since]
  );
  for (const r of unassigned.rows) if (await safeAssign(r.id)) out.assigned += 1;
  // 2. Window missed - next hop.
  // Every due window is handled each sweep (batches; a transfer moves the
  // due time forward, a capped one clears it, so the loop always shrinks).
  const handled = new Set();
  for (let batch = 0; batch < 50; batch += 1) {
    const missed = await pool.query(
      `SELECT id FROM leads WHERE first_contacted_at IS NULL AND assignment_due_at IS NOT NULL AND assignment_due_at <= now()
         AND status <> ALL($1::lead_status[]) AND NOT (id = ANY($2::uuid[])) ORDER BY assignment_due_at LIMIT 200`,
      [CLOSED, [...handled]]
    );
    if (!missed.rows.length) break;
    for (const r of missed.rows) {
      handled.add(r.id);
      const res = await route(r.id, { reason: 'missed' }).catch((err) => console.error('[assignment] transfer failed:', err.message));
      if (res) out.transferred += 1;
    }
  }
  // 3. Assignee left / deactivated - re-inject, same routing as a new inquiry.
  const orphaned = await pool.query(
    `SELECT l.id FROM leads l JOIN users u ON u.id = l.arb_rep_id
     WHERE u.status <> 'active' AND l.status <> ALL($1::lead_status[]) LIMIT 200`,
    [CLOSED]
  );
  for (const r of orphaned.rows) {
    const res = await route(r.id, { reason: 'exit' }).catch((err) => console.error('[assignment] re-inject failed:', err.message));
    if (res) out.reinjected += 1;
  }
  // 4. Overall response SLA (2 h Exclusive Mandate / 24 h standard) breached.
  const late = await pool.query(
    `SELECT id, arb_rep_id AS assigned_to, assignment_hop, response_sla_hours FROM leads
     WHERE first_contacted_at IS NULL AND response_sla_due_at <= now() AND response_sla_alerted_at IS NULL AND status <> ALL($1::lead_status[]) LIMIT 200`,
    [CLOSED]
  );
  const admins = late.rows.length ? await adminIds() : [];
  for (const r of late.rows) {
    await pool.query(`UPDATE leads SET response_sla_alerted_at = now() WHERE id = $1`, [r.id]);
    await logEvent(r.id, { hop: r.assignment_hop, kind: 'sla_breached', from: r.assigned_to, detail: { sla_hours: r.response_sla_hours } });
    await notify([r.assigned_to, await teamLeaderOf(r.assigned_to), ...admins], {
      type: 'inquiry_sla_breached', title: `Inquiry response SLA breached (${r.response_sla_hours} h)`, message: 'No first contact logged within the response SLA.', leadId: r.id,
    });
    out.slaAlerts += 1;
  }
  return out;
}

let timer = null;
async function startScheduler() {
  if (timer) return;
  const seconds = Number(await configService.getConfig('assignment.sweep_seconds', 30)) || 30;
  timer = setInterval(() => sweep().catch((err) => console.error('[assignment] sweep failed:', err.message)), seconds * 1000);
}

// ------------------------------------------------------------ reads / admin

// Name + platform number shown to buyer and seller (never their own contact).
async function repCard(userId) {
  if (!userId) return null;
  const r = (
    await pool.query(
      `SELECT u.full_name, ar.platform_number, ar.designation FROM users u LEFT JOIN arb_representatives ar ON ar.user_id = u.id WHERE u.id = $1`,
      [userId]
    )
  ).rows[0];
  return r ? { name: r.full_name, platformNumber: r.platform_number || null, designation: r.designation || null } : null;
}

async function leadAssignment(leadId) {
  const lead = (
    await pool.query(
      `SELECT l.arb_rep_id, l.assignment_hop, l.assignment_route, l.assigned_at, l.assignment_due_at, l.first_contacted_at,
              l.response_sla_hours, l.response_sla_due_at, fc.full_name AS first_contacted_by_name
       FROM leads l LEFT JOIN users fc ON fc.id = l.first_contacted_by WHERE l.id = $1`,
      [leadId]
    )
  ).rows[0];
  if (!lead) throw notFound('Lead not found');
  const events = (
    await pool.query(
      `SELECT e.hop, e.kind, e.route, e.detail, e.created_at, f.full_name AS from_name, t.full_name AS to_name, a.full_name AS actor_name
       FROM lead_assignment_events e
       LEFT JOIN users f ON f.id = e.from_user_id LEFT JOIN users t ON t.id = e.to_user_id LEFT JOIN users a ON a.id = e.actor_id
       WHERE e.lead_id = $1 ORDER BY e.created_at`,
      [leadId]
    )
  ).rows;
  return { ...lead, representative: await repCard(lead.arb_rep_id), events };
}

async function listReps() {
  const rows = (
    await pool.query(
      `SELECT u.id AS user_id, u.full_name, u.email, u.status, r.name AS role,
              ar.designation, ar.platform_number, ar.assigned_states, ar.assigned_cities, ar.coverage_localities,
              ar.team_leader_id, tl.full_name AS team_leader_name, ar.accepts_assignments, (ar.user_id IS NOT NULL) AS is_rep,
              (SELECT COUNT(*) FROM leads l WHERE l.arb_rep_id = u.id AND l.status NOT IN ('won', 'lost'))::int AS open_load,
              (SELECT COUNT(*) FROM lead_assignment_events e WHERE e.from_user_id = u.id AND e.kind = 'contacted')::int AS attended,
              (SELECT COUNT(*) FROM lead_assignment_events e WHERE e.from_user_id = u.id AND e.kind = 'missed')::int AS missed,
              (SELECT COUNT(*) FROM broker_rm_mapping m WHERE m.rm_id = u.id)::int AS mapped_brokers
       FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN arb_representatives ar ON ar.user_id = u.id
       LEFT JOIN users tl ON tl.id = ar.team_leader_id
       WHERE r.name = ANY($1)
       ORDER BY (ar.user_id IS NULL), u.full_name`,
      [REP_ROLES]
    )
  ).rows;
  return rows;
}

const cleanList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : []);

async function upsertRep(userId, data, actor) {
  if (!ADMIN.includes(actor.role)) throw forbidden('Only an admin can configure representatives');
  const u = (await pool.query(`SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [userId])).rows[0];
  if (!u || !REP_ROLES.includes(u.role)) throw badRequest('Representatives must be A R staff (internal sales or admin)');
  if (data.designation && !['rm', 'dm', 'tl', 'tc'].includes(data.designation)) throw badRequest('designation must be rm, dm, tl or tc');
  if (data.teamLeaderId && data.teamLeaderId === userId) throw badRequest('A representative cannot lead themselves');
  const row = (
    await pool.query(
      `INSERT INTO arb_representatives (user_id, designation, platform_number, assigned_states, assigned_cities, coverage_localities, team_leader_id, accepts_assignments)
       VALUES ($1, COALESCE($2, 'rm'), $3, $4, $5, $6, $7, COALESCE($8, true))
       ON CONFLICT (user_id) DO UPDATE SET
         designation = COALESCE($2, arb_representatives.designation),
         platform_number = CASE WHEN $9 THEN $3 ELSE arb_representatives.platform_number END,
         assigned_states = CASE WHEN $10 THEN $4 ELSE arb_representatives.assigned_states END,
         assigned_cities = CASE WHEN $11 THEN $5 ELSE arb_representatives.assigned_cities END,
         coverage_localities = CASE WHEN $12 THEN $6 ELSE arb_representatives.coverage_localities END,
         team_leader_id = CASE WHEN $13 THEN $7 ELSE arb_representatives.team_leader_id END,
         accepts_assignments = COALESCE($8, arb_representatives.accepts_assignments)
       RETURNING *`,
      [
        userId, data.designation || null, data.platformNumber || null,
        cleanList(data.assignedStates).map((s) => s.toUpperCase()), cleanList(data.assignedCities), cleanList(data.coverageLocalities),
        data.teamLeaderId || null, typeof data.acceptsAssignments === 'boolean' ? data.acceptsAssignments : null,
        data.platformNumber !== undefined, data.assignedStates !== undefined, data.assignedCities !== undefined,
        data.coverageLocalities !== undefined, data.teamLeaderId !== undefined,
      ]
    )
  ).rows[0];
  await require('./audit.service').log({ actor, action: 'representative.updated', entityType: 'arb_representative', entityId: userId, after: row });
  return row;
}

async function listBrokerMappings() {
  return (
    await pool.query(
      `SELECT b.id AS broker_id, b.full_name AS broker_name, b.email AS broker_email, t.name AS agency,
              m.rm_id, rm.full_name AS rm_name, m.mapped_at
       FROM users b JOIN roles r ON r.id = b.role_id AND r.name = 'broker'
       LEFT JOIN tenants t ON t.id = b.tenant_id
       LEFT JOIN broker_rm_mapping m ON m.broker_id = b.id
       LEFT JOIN users rm ON rm.id = m.rm_id
       WHERE b.status = 'active'
       ORDER BY (m.rm_id IS NOT NULL), b.full_name`
    )
  ).rows;
}

async function mapBroker(brokerId, rmId, actor) {
  if (!ADMIN.includes(actor.role)) throw forbidden('Only an admin can map brokers to RMs');
  const broker = (await pool.query(`SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND r.name = 'broker'`, [brokerId])).rows[0];
  if (!broker) throw badRequest('Not a broker');
  if (!rmId) {
    await pool.query('DELETE FROM broker_rm_mapping WHERE broker_id = $1', [brokerId]);
  } else {
    const rep = (await pool.query(`SELECT 1 FROM arb_representatives ar JOIN users u ON u.id = ar.user_id AND u.status = 'active' WHERE ar.user_id = $1`, [rmId])).rows[0];
    if (!rep) throw badRequest('The RM must be an active representative');
    await pool.query(
      `INSERT INTO broker_rm_mapping (broker_id, rm_id, mapped_by) VALUES ($1, $2, $3)
       ON CONFLICT (broker_id) DO UPDATE SET rm_id = EXCLUDED.rm_id, mapped_by = EXCLUDED.mapped_by, mapped_at = now()`,
      [brokerId, rmId, actor.id]
    );
  }
  await require('./audit.service').log({ actor, action: 'broker_rm_mapping.updated', entityType: 'broker', entityId: brokerId, after: { rm_id: rmId || null } });
  return { brokerId, rmId: rmId || null };
}

module.exports = {
  windowDue,
  leadContext,
  route,
  safeAssign,
  markContacted,
  recordManual,
  sweep,
  startScheduler,
  repCard,
  leadAssignment,
  listReps,
  upsertRep,
  listBrokerMappings,
  mapBroker,
};
