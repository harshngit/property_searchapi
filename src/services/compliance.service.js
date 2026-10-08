const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 32 - Compliance & Risk Alerts.
//
// Each rule is a query that returns the records currently breaking it. The
// sweep (hourly, or on demand) opens an alert for every new one, keeps
// existing alerts fresh, and closes alerts whose record is now in order -
// so the desk always shows what is wrong right now, with how long it has
// been wrong. Staff acknowledge an alert they are working on, or dismiss
// one that is a known exception (with a reason); a dismissed alert stays
// quiet while the same condition lasts.
//
// Rules, their severity and thresholds live in compliance_rules and are
// switched on / off by an admin.

const ADMIN = ['admin', 'super_admin'];
const SEVERITY_ORDER = `CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

// Every query returns: entity_type, entity_id, title, detail, city, owner_user_id.
// $1 is the rule's params (jsonb).
const RULES = {
  rera_missing_builder_listing: `
    SELECT 'property', p.id::text, 'No RERA number: ' || p.title, 'Builder listing is live without a RERA registration number.', p.city, COALESCE(p.builder_id, p.created_by)
    FROM properties p JOIN users u ON u.id = COALESCE(p.builder_id, p.created_by) JOIN roles r ON r.id = u.role_id
    WHERE p.status = 'approved' AND r.name = 'builder' AND COALESCE(btrim(p.rera_number), '') = ''`,
  verification_expired: `
    SELECT 'user_verification', v.id::text, upper(v.kind) || ' verification expired: ' || u.full_name, 'Ask for the renewed ' || upper(v.kind) || ' document and verify it again.', NULL::varchar, v.user_id
    FROM user_verifications v JOIN users u ON u.id = v.user_id WHERE v.status = 'expired' AND u.status = 'active'`,
  professional_unverified_live: `
    SELECT 'user', u.id::text, 'Unverified ' || r.name || ' with live listings: ' || u.full_name, COUNT(*) || ' live listing(s) and no approved KYC on the profile.', MODE() WITHIN GROUP (ORDER BY p.city), u.id
    FROM properties p JOIN users u ON u.id = COALESCE(p.broker_id, p.builder_id, p.created_by) JOIN roles r ON r.id = u.role_id
    WHERE p.status = 'approved' AND r.name IN ('broker', 'builder', 'agency_admin') AND u.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM user_verifications v WHERE v.user_id = u.id AND v.kind = 'kyc' AND v.status = 'verified')
    GROUP BY u.id, u.full_name, r.name HAVING COUNT(*) >= COALESCE(($1::jsonb->>'min_listings')::int, 1)`,
  fraud_listing_live: `
    SELECT 'property', p.id::text, 'High fraud risk and live: ' || p.title, 'Fraud band ' || p.fraud_band || COALESCE(' (score ' || p.fraud_score || ')', '') || '. Review or take it down.', p.city, p.created_by
    FROM properties p WHERE p.status = 'approved' AND p.fraud_band IN ('red', 'critical')`,
  listing_review_overdue: `
    SELECT 'property', p.id::text, 'Review overdue: ' || p.title, 'Held for manual review since ' || to_char(p.review_due_at, 'DD Mon HH24:MI') || ' deadline passed.', p.city, p.created_by
    FROM properties p WHERE p.under_review AND p.review_due_at < now() AND p.status IN ('approved', 'pending_approval')`,
  invoice_overdue: `
    SELECT 'invoice', i.id::text, 'Invoice overdue: ' || i.invoice_number, 'Rs ' || to_char(i.total_amount, 'FM99,99,99,99,990') || ' was due on ' || to_char(i.due_date, 'DD Mon YYYY') || COALESCE(' from ' || i.liable_name, '') || '.', NULL::varchar, i.liable_user_id
    FROM invoices i WHERE i.status IN ('invoiced', 'overdue') AND i.due_date < CURRENT_DATE - COALESCE(($1::jsonb->>'grace_days')::int, 0)`,
  mandate_breached: `
    SELECT 'mandate', m.id::text, 'Mandate breached: ' || m.mandate_number, COALESCE(m.status_reason, 'Marked as breached.') || ' Send the breach letter and record the follow-up.', NULL::varchar, m.user_id
    FROM mandates m WHERE m.status = 'breached'`,
  dispute_sla_breached: `
    SELECT 'dispute', d.id::text, 'Dispute past deadline: ' || d.case_number, d.title || ' - due ' || to_char(d.sla_due_at, 'DD Mon HH24:MI') || '.', NULL::varchar, d.assigned_to
    FROM disputes d WHERE d.status IN ('open', 'under_review', 'awaiting_info') AND d.sla_due_at < now()`,
  lead_response_overdue: `
    SELECT 'lead', l.id::text, 'Enquiry unanswered' || COALESCE(': ' || p.title, ''), 'Response was due ' || to_char(l.response_sla_due_at, 'DD Mon HH24:MI') || ' and no first contact is recorded.', p.city, COALESCE(l.arb_rep_id, l.assigned_to)
    FROM leads l LEFT JOIN properties p ON p.id = l.property_id
    WHERE l.first_contacted_at IS NULL AND l.status = 'new' AND l.response_sla_due_at < now() - (COALESCE(($1::jsonb->>'grace_hours')::int, 4) || ' hours')::interval
      AND l.created_at > now() - interval '60 days'`,
  dpdp_request_due: `
    SELECT 'data_request', d.id::text, 'Data request ' || d.request_number || CASE WHEN d.due_at < now() THEN ' is overdue' ELSE ' is due soon' END,
           initcap(d.kind) || ' request, status ' || d.status || ', due ' || to_char(d.due_at, 'DD Mon YYYY') || '.', NULL::varchar, NULL::uuid
    FROM data_requests d WHERE d.kind <> 'export' AND d.status IN ('pending', 'on_hold') AND d.due_at < now() + (COALESCE(($1::jsonb->>'warn_days')::int, 5) || ' days')::interval`,
  consent_missing: `
    SELECT 'platform', 'consent', COUNT(*) || ' active user(s) have no consent on record', 'They signed up before consent logging or under an older policy version. Ask them to accept the current policy at next sign-in.', NULL::varchar, NULL::uuid
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.status = 'active' AND u.anonymised_at IS NULL AND r.name NOT IN ('internal_sales', 'admin', 'super_admin')
      AND NOT EXISTS (SELECT 1 FROM consent_logs c WHERE c.user_id = u.id AND c.granted)
    HAVING COUNT(*) > 0`,
  crawler_without_legal_approval: `
    SELECT 'crawler_source', s.id::text, 'Crawler on without legal approval: ' || s.name, 'Switch it off or record the legal approval.', NULL::varchar, NULL::uuid
    FROM crawler_sources s WHERE s.is_enabled AND s.requires_legal_review AND NOT COALESCE(s.legal_approved, false)`,
};

// Where the alert's record is handled in the CRM.
const LINKS = {
  property: (id) => `/app/properties/${id}`, user: () => '/app/trust', user_verification: () => '/app/trust', invoice: () => '/app/invoices', mandate: () => '/app/mandates',
  dispute: () => '/app/disputes', lead: (id) => `/app/leads/${id}`, data_request: () => '/app/compliance?tab=privacy', crawler_source: () => '/app/opportunities', platform: () => '/app/compliance?tab=privacy',
};

async function sweep() {
  if ((await configService.getConfig('compliance.enabled', true)) === false) return { enabled: false };
  const rules = (await pool.query('SELECT * FROM compliance_rules')).rows;
  let opened = 0;
  let resolved = 0;
  const fresh = [];
  for (const rule of rules) {
    const sql = RULES[rule.rule_key];
    if (!sql) continue;
    if (!rule.is_active) {
      // A switched-off rule closes its alerts.
      resolved += (await pool.query(`UPDATE compliance_alerts SET status = 'resolved', resolved_at = now(), auto_resolved = true, note = COALESCE(note, 'Rule switched off') WHERE rule_key = $1 AND status IN ('open', 'acknowledged')`, [rule.rule_key])).rowCount;
      continue;
    }
    const hits = (await pool.query(`SELECT * FROM (${sql}) AS s(entity_type, entity_id, title, detail, city, owner_user_id)`, sql.includes('$1') ? [JSON.stringify(rule.params || {})] : [])).rows;
    for (const h of hits) {
      const r = (await pool.query(
        `INSERT INTO compliance_alerts (rule_key, entity_type, entity_id, title, detail, city, owner_user_id, severity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (rule_key, entity_id) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, city = EXCLUDED.city, owner_user_id = EXCLUDED.owner_user_id, severity = EXCLUDED.severity, last_seen_at = now(),
           -- back again after being put right: reopen it
           status = CASE WHEN compliance_alerts.status = 'resolved' THEN 'open' ELSE compliance_alerts.status END,
           first_seen_at = CASE WHEN compliance_alerts.status = 'resolved' THEN now() ELSE compliance_alerts.first_seen_at END,
           note = CASE WHEN compliance_alerts.status = 'resolved' THEN NULL ELSE compliance_alerts.note END,
           resolved_at = NULL, auto_resolved = false
         RETURNING id, (xmax = 0) AS inserted, status, first_seen_at = last_seen_at AS reopened`,
        [rule.rule_key, h.entity_type, h.entity_id, String(h.title).slice(0, 200), h.detail, h.city, h.owner_user_id, rule.severity]
      )).rows[0];
      if (r.inserted || r.reopened) {
        opened += 1;
        fresh.push({ severity: rule.severity, title: String(h.title).slice(0, 200) });
      }
    }
    // No longer breaking the rule: close it. (A dismissed alert that has cleared is closed too.)
    resolved += (await pool.query(
      `UPDATE compliance_alerts SET status = 'resolved', resolved_at = now(), auto_resolved = true
       WHERE rule_key = $1 AND status IN ('open', 'acknowledged', 'dismissed') AND entity_id <> ALL($2::text[])`,
      [rule.rule_key, hits.map((h) => h.entity_id)]
    )).rowCount;
  }
  // One notification per sweep for new critical / high alerts, not one each.
  const urgent = fresh.filter((f) => ['critical', 'high'].includes(f.severity));
  if (urgent.length) {
    const admins = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
    for (const a of admins.rows) {
      await notificationService.createNotification({ userId: a.id, type: 'compliance', title: `${urgent.length} new compliance alert${urgent.length === 1 ? '' : 's'}`, message: urgent.slice(0, 3).map((u) => u.title).join(' · ') + (urgent.length > 3 ? ` · +${urgent.length - 3} more` : ''), relatedEntityType: 'compliance', relatedEntityId: null }).catch(() => {});
    }
  }
  return { enabled: true, opened, resolved };
}

const view = (a) => ({
  id: a.id, ruleKey: a.rule_key, ruleLabel: a.label, area: a.area, entityType: a.entity_type, entityId: a.entity_id, title: a.title, detail: a.detail, city: a.city, ownerName: a.owner_name || null,
  severity: a.severity, status: a.status, note: a.note, firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at, handledByName: a.handler_name || null, handledAt: a.handled_at, resolvedAt: a.resolved_at, autoResolved: a.auto_resolved,
  ageDays: Math.floor((Date.now() - new Date(a.first_seen_at).getTime()) / 86400000), link: LINKS[a.entity_type]?.(a.entity_id) || null,
});

async function list({ status = 'active', severity, area, rule, search } = {}) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (status === 'active') where.push(`a.status IN ('open', 'acknowledged')`);
  else if (status && status !== 'all') add('a.status = ?', status);
  if (severity) add('a.severity = ?', severity);
  if (area) add('r.area = ?', area);
  if (rule) add('a.rule_key = ?', rule);
  if (search) add('(lower(a.title) LIKE ? )', `%${String(search).toLowerCase()}%`);
  const rows = (await pool.query(
    `SELECT a.*, r.label, r.area, o.full_name AS owner_name, h.full_name AS handler_name
     FROM compliance_alerts a JOIN compliance_rules r ON r.rule_key = a.rule_key LEFT JOIN users o ON o.id = a.owner_user_id LEFT JOIN users h ON h.id = a.handled_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (a.status IN ('open', 'acknowledged')) DESC, ${SEVERITY_ORDER}, a.first_seen_at ASC LIMIT 500`, params)).rows;
  return rows.map(view);
}

async function summary() {
  const [bySeverity, byRule, last] = await Promise.all([
    pool.query(`SELECT severity, COUNT(*)::int AS n FROM compliance_alerts WHERE status IN ('open', 'acknowledged') GROUP BY 1`),
    pool.query(
      `SELECT r.rule_key, r.label, r.description, r.area, r.severity, r.is_active, r.params,
              COUNT(a.id) FILTER (WHERE a.status = 'open')::int AS open, COUNT(a.id) FILTER (WHERE a.status = 'acknowledged')::int AS acknowledged,
              COUNT(a.id) FILTER (WHERE a.status = 'resolved' AND a.resolved_at > now() - interval '30 days')::int AS resolved_30d,
              MIN(a.first_seen_at) FILTER (WHERE a.status IN ('open', 'acknowledged')) AS oldest
       FROM compliance_rules r LEFT JOIN compliance_alerts a ON a.rule_key = r.rule_key GROUP BY r.rule_key ORDER BY r.sort_order`
    ),
    pool.query(`SELECT MAX(last_seen_at) AS at FROM compliance_alerts`),
  ]);
  const n = (s) => bySeverity.rows.find((x) => x.severity === s)?.n || 0;
  return {
    totals: { critical: n('critical'), high: n('high'), medium: n('medium'), low: n('low'), active: bySeverity.rows.reduce((s, x) => s + x.n, 0) },
    lastCheckedAt: last.rows[0].at,
    rules: byRule.rows.map((r) => ({ ruleKey: r.rule_key, label: r.label, description: r.description, area: r.area, severity: r.severity, isActive: r.is_active, params: r.params, open: r.open, acknowledged: r.acknowledged, resolved30d: r.resolved_30d, oldest: r.oldest })),
  };
}

async function act(user, id, { action, note }, meta = {}) {
  const next = { acknowledge: 'acknowledged', dismiss: 'dismissed', reopen: 'open' }[action];
  if (!next) throw badRequest('action must be acknowledge, dismiss or reopen');
  if (action === 'dismiss') {
    if (!ADMIN.includes(user.role)) throw forbidden('Only an admin can dismiss an alert');
    if (!note || String(note).trim().length < 5) throw badRequest('Give the reason this is an accepted exception');
  }
  const from = { acknowledge: ['open'], dismiss: ['open', 'acknowledged'], reopen: ['acknowledged', 'dismissed'] }[action];
  const r = (await pool.query(
    `UPDATE compliance_alerts SET status = $1, note = COALESCE($2, note), handled_by = $3, handled_at = now() WHERE id = $4 AND status = ANY($5::text[]) RETURNING id, status`,
    [next, note ? String(note).trim().slice(0, 1000) : null, user.id, id, from]
  )).rows[0];
  if (!r) {
    if (!(await pool.query('SELECT 1 FROM compliance_alerts WHERE id = $1', [id])).rows.length) throw notFound('Alert not found');
    throw badRequest(`This alert cannot be ${next} from its current state`);
  }
  await auditService.log({ actor: user, action: `compliance.alert_${next}`, entityType: 'compliance_alert', entityId: id, after: { note }, ...meta });
  return r;
}

async function updateRule(admin, ruleKey, { isActive, severity, params }, meta = {}) {
  if (!ADMIN.includes(admin.role)) throw forbidden('Admins only');
  if (severity !== undefined && !['critical', 'high', 'medium', 'low'].includes(severity)) throw badRequest('Unknown severity');
  let merged = null;
  if (params !== undefined) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw badRequest('params must be an object');
    const current = (await pool.query('SELECT params FROM compliance_rules WHERE rule_key = $1', [ruleKey])).rows[0];
    if (!current) throw notFound('Rule not found');
    // Only thresholds the rule already has, and only whole numbers.
    merged = { ...current.params };
    for (const [k, v] of Object.entries(params)) {
      if (!(k in current.params)) throw badRequest(`This rule has no "${k}" setting`);
      if (!Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 3650) throw badRequest(`${k} must be a whole number`);
      merged[k] = Number(v);
    }
  }
  const r = (await pool.query(
    `UPDATE compliance_rules SET is_active = COALESCE($1, is_active), severity = COALESCE($2, severity), params = COALESCE($3, params), updated_by = $4, updated_at = now() WHERE rule_key = $5 RETURNING *`,
    [isActive === undefined ? null : !!isActive, severity || null, merged ? JSON.stringify(merged) : null, admin.id, ruleKey]
  )).rows[0];
  if (!r) throw notFound('Rule not found');
  await auditService.log({ actor: admin, action: 'compliance.rule_updated', entityType: 'compliance_rule', entityId: null, after: { ruleKey, isActive, severity, params }, ...meta });
  await sweep();
  return r;
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((err) => console.error('[compliance] sweep failed:', err.message)), 60 * 60 * 1000);
}

module.exports = { sweep, list, summary, act, updateRule, startScheduler };
