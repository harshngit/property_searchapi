const pool = require('../../config/db');
const configService = require('../config.service');
const notificationService = require('../notification.service');
const auditService = require('../audit.service');
const opportunityService = require('../opportunity.service');
const { uploadBuffer } = require('../../utils/storage');
const { badRequest, notFound } = require('../../utils/httpError');
const { parseSource, extractFromText, readNotice, enrichWithAi } = require('./parsers');
const referenceData = require('./referenceData');

// Section 23 pipeline orchestration (master_scheduler.js in the contract):
//   Layer 1 crawl (polite fetcher) -> Layer 2 parse (adapters / regex / AI)
//   -> Layers 3-5 via opportunityService.ingestItems (normalise, dedupe,
//   score, needs_review / publish, institutional routing).
// Every run is recorded (crawler_runs) with counts, errors and the archived
// raw payload; repeated failures move a source to the dead-letter state.
//
// The contract names BullMQ + Redis for the job queue; this deployment has
// no Redis, so runs are scheduled in-process with a database lock per
// source (safe with several API instances) - same behaviour, no extra infra.

const SOURCE_FIELDS = {
  name: 'name', baseUrl: 'base_url', listUrl: 'list_url', adapter: 'adapter', config: 'config', scheduleHours: 'schedule_hours',
  defaultListingCategory: 'default_listing_category', requiresLegalReview: 'requires_legal_review', useAiParser: 'use_ai_parser',
  maxPages: 'max_pages', isEnabled: 'is_enabled', output: 'output',
};

async function listSources() {
  const result = await pool.query(
    `SELECT s.*, ap.full_name AS legal_approved_by_name,
            (SELECT row_to_json(r) FROM (SELECT status, started_at, finished_at, items_found, items_ingested, error_message
                                         FROM crawler_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) r) AS last_run,
            (SELECT COUNT(*) FROM opportunity_ingestion_items i WHERE i.crawler_source_id = s.id)::int AS items_total,
            (SELECT COUNT(*) FROM opportunity_ingestion_items i WHERE i.crawler_source_id = s.id AND i.status = 'published')::int AS items_published
     FROM crawler_sources s LEFT JOIN users ap ON ap.id = s.legal_approved_by
     ORDER BY s.category, s.name`
  );
  const flags = await pool.query(`SELECT flag_key, is_enabled FROM feature_flags WHERE flag_key LIKE 'scraper\\_%'`);
  const flagMap = new Map(flags.rows.map((f) => [f.flag_key, f.is_enabled]));
  return result.rows.map((s) => ({ ...s, feature_flag_enabled: flagMap.has(`scraper_${s.source_key}_enabled`) ? flagMap.get(`scraper_${s.source_key}_enabled`) : null }));
}

async function getSource(id) {
  const result = await pool.query('SELECT * FROM crawler_sources WHERE id = $1', [id]);
  if (!result.rows[0]) throw notFound('Crawler source not found');
  return result.rows[0];
}

async function updateSource(id, data, user, meta = {}) {
  const before = await getSource(id);
  const set = [];
  const params = [];
  for (const [key, col] of Object.entries(SOURCE_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(key === 'config' ? JSON.stringify(data[key] || {}) : data[key] === '' ? null : data[key]);
      set.push(`${col} = $${params.length}`);
    }
  }
  if (data.isEnabled === true && !before.legal_approved) throw badRequest('Legal approval (ToS / robots.txt review) is required before enabling this source');
  if (!set.length) throw badRequest('Nothing to update');
  params.push(id);
  const result = await pool.query(`UPDATE crawler_sources SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  await auditService.log({ actor: user, action: 'crawler_source.updated', entityType: 'crawler_source', entityId: id, before, after: result.rows[0], ...meta });
  return result.rows[0];
}

// Counsel's sign-off that the portal's ToS and robots.txt permit crawling.
async function setLegalApproval(id, { approved, notes }, user, meta = {}) {
  const result = await pool.query(
    `UPDATE crawler_sources
     SET legal_approved = $1::boolean, legal_approved_by = CASE WHEN $1::boolean THEN $2::uuid ELSE NULL END,
         legal_approved_at = CASE WHEN $1::boolean THEN now() ELSE NULL END, legal_notes = $3,
         is_enabled = CASE WHEN $1::boolean THEN is_enabled ELSE false END
     WHERE id = $4 RETURNING *`,
    [!!approved, user.id, notes || null, id]
  );
  if (!result.rows[0]) throw notFound('Crawler source not found');
  await auditService.log({ actor: user, action: approved ? 'crawler_source.legal_approved' : 'crawler_source.legal_withdrawn', entityType: 'crawler_source', entityId: id, after: { notes }, ...meta });
  return result.rows[0];
}

async function resetSource(id, user) {
  const result = await pool.query(
    `UPDATE crawler_sources SET status = 'idle', consecutive_failures = 0, last_error = NULL, next_run_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!result.rows[0]) throw notFound('Crawler source not found');
  await auditService.log({ actor: user, action: 'crawler_source.reset', entityType: 'crawler_source', entityId: id });
  return result.rows[0];
}

async function listRuns(sourceId, limit = 30) {
  const result = await pool.query(
    `SELECT r.*, u.full_name AS triggered_by_name FROM crawler_runs r LEFT JOIN users u ON u.id = r.triggered_by
     WHERE ($1::uuid IS NULL OR r.source_id = $1) ORDER BY r.started_at DESC LIMIT $2`,
    [sourceId || null, Math.min(Number(limit) || 30, 200)]
  );
  return result.rows;
}

async function archiveRaw(source, raw) {
  if (!process.env.GCS_BUCKET_NAME) return null;
  try {
    return await uploadBuffer(Buffer.from(JSON.stringify(raw)), `crawler-raw/${source.source_key}/${new Date().toISOString().slice(0, 10)}`, 'run.json', 'application/json');
  } catch (err) {
    console.error(`[crawler] raw archive failed for ${source.source_key}:`, err.message);
    return null;
  }
}

async function notifyAdmins(title, message) {
  const admins = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
  for (const a of admins.rows) await notificationService.createNotification({ userId: a.id, type: 'crawler_health', title, message });
}

// One crawl of one source. trigger: schedule | manual | test (test = parse
// only, nothing ingested - for checking a new field mapping).
async function runSource(sourceId, { trigger = 'manual', user = null } = {}) {
  const source = await getSource(sourceId);
  if (trigger !== 'test' && !source.legal_approved) throw badRequest('This source is not legally approved yet');

  // Lock: only one run per source at a time, across instances.
  const locked = await pool.query(
    `UPDATE crawler_sources SET status = 'running', last_run_at = now() WHERE id = $1 AND status <> 'running' RETURNING id`,
    [sourceId]
  );
  if (!locked.rows[0]) throw badRequest('This source is already running');

  const run = await pool.query(`INSERT INTO crawler_runs (source_id, trigger, triggered_by) VALUES ($1, $2, $3) RETURNING id`, [sourceId, trigger, user?.id || null]);
  const runId = run.rows[0].id;
  const finish = async (fields, sourceUpdate) => {
    const cols = Object.keys(fields);
    await pool.query(
      `UPDATE crawler_runs SET finished_at = now(), ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
      [...cols.map((c) => (c === 'sample' ? JSON.stringify(fields[c]) : fields[c])), runId]
    );
    const s = Object.keys(sourceUpdate);
    await pool.query(`UPDATE crawler_sources SET ${s.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${s.length + 1}`, [...Object.values(sourceUpdate), sourceId]);
  };
  const nextRun = new Date(Date.now() + source.schedule_hours * 3600 * 1000);

  try {
    const { items, raw, pages, ocrPages = 0 } = await parseSource(source);
    const rawPath = trigger === 'test' ? null : await archiveRaw(source, raw);
    // Reference-data modules (crawler_rera / crawler_nhb_rbi / crawler_portal_market).
    if (source.output !== 'opportunity') {
      const stored = await referenceData.store(source, items, { dryRun: trigger === 'test' });
      await finish(
        {
          status: stored.received ? 'success' : 'partial',
          pages_fetched: pages,
          items_found: stored.received,
          items_ingested: stored.stored + stored.updated,
          items_skipped: stored.rejected,
          ocr_pages: ocrPages,
          raw_object_path: rawPath,
          sample: stored.sample,
          recovery_action: stored.received ? null : 'No rows found - check the item selector / field mapping (or rowPattern for PDFs)',
        },
        trigger === 'test'
          ? { status: 'idle' }
          : { status: 'healthy', consecutive_failures: 0, last_success_at: new Date(), last_error: null, next_run_at: nextRun }
      );
      if (trigger !== 'test' && source.output !== 'rera_projects') require('../market.service').clearCache();
      return { runId, pages, found: stored.received, summary: stored, sample: stored.sample, output: source.output, ocrPages };
    }
    let summary = { received: items.length, published: 0, needs_review: 0, duplicate: 0, skipped_existing: 0 };
    if (trigger !== 'test' && items.length) {
      summary = await opportunityService.ingestItems(
        items.slice(0, 1000),
        { sourceName: source.name, dataSource: 'crawler', defaultCategory: source.default_listing_category, crawlerSourceId: source.id, requiresLegalReview: source.requires_legal_review },
        user
      );
    }
    await finish(
      {
        status: items.length ? 'success' : 'partial',
        pages_fetched: pages,
        items_found: items.length,
        items_ingested: (summary.needs_review || 0) + (summary.published || 0),
        items_duplicate: summary.duplicate || 0,
        items_skipped: summary.skipped_existing || 0,
        ocr_pages: ocrPages,
        raw_object_path: rawPath,
        sample: items.slice(0, 5),
        recovery_action: items.length ? null : 'No items found - check the item selector / field mapping',
      },
      { status: 'healthy', consecutive_failures: 0, last_success_at: new Date(), last_error: null, next_run_at: nextRun }
    );
    return { runId, pages, found: items.length, summary, sample: items.slice(0, 5) };
  } catch (err) {
    const type = err.type || 'internal';
    const failures = source.consecutive_failures + 1;
    const deadAfter = Number(await configService.getConfig('crawler.dead_letter_after_failures', 5)) || 5;
    const dead = trigger !== 'test' && failures >= deadAfter && !['not_configured', 'robots_blocked'].includes(type);
    const recovery = {
      robots_blocked: 'robots.txt disallows this page - the source must stay off (contract rule). Pick an allowed URL or disable it.',
      not_configured: 'Complete the listing URL and field mapping, then run a test.',
      http_error: 'The portal returned an error - retried on the next schedule.',
      timeout: 'The portal did not respond in time - retried on the next schedule.',
      network: 'Could not reach the portal - retried on the next schedule.',
      parse_error: 'The page or PDF could not be parsed - check the mapping or enable the AI parser.',
    }[type] || 'Unexpected error - check the logs.';
    // Back off: retry sooner than the schedule for transient errors, but not hammering.
    const backoffHours = Math.min(source.schedule_hours, Math.max(1, failures));
    await finish(
      {
        status: type === 'robots_blocked' ? 'blocked_robots' : type === 'not_configured' ? 'not_configured' : 'failed',
        error_type: type,
        error_message: String(err.message).slice(0, 2000),
        recovery_action: recovery,
      },
      trigger === 'test'
        ? { status: source.status === 'running' ? 'idle' : source.status === 'dead_letter' ? 'dead_letter' : 'idle' }
        : {
            status: dead ? 'dead_letter' : 'failing',
            consecutive_failures: failures,
            last_error: String(err.message).slice(0, 2000),
            next_run_at: new Date(Date.now() + backoffHours * 3600 * 1000),
          }
    );
    if (dead) await notifyAdmins('Crawler moved to dead-letter', `${source.name} failed ${failures} times in a row (${err.message}). It is paused until reset.`);
    const wrapped = new Error(`${source.name}: ${err.message}`);
    wrapped.statusCode = type === 'not_configured' || type === 'robots_blocked' ? 400 : 502;
    wrapped.details = { runId, type, recovery };
    throw wrapped;
  }
}

// Staff upload of a single notice (PDF / text) - parsed by the same Layer 2
// (regex + AI) and queued for review. Useful for notices from sources that
// are not crawled (newspaper cuttings, e-mailed bank notices).
async function parseUploadedNotice(file, { sourceName, listingCategory, legalReview }, user) {
  if (!file) throw badRequest('Upload a PDF, a scan / photo of the notice, or a text file');
  const isPdf = (file.mimetype || '').includes('pdf') || /\.pdf$/i.test(file.originalname || '');
  // Scanned PDFs and photos of newspaper cuttings are read with OCR.
  const { text, method, ocrPages, confidence } = await readNotice(file.buffer, isPdf ? 'application/pdf' : file.mimetype || 'text/plain');
  if (!text.trim()) throw badRequest('No readable text in this file - the scan could not be read by OCR. Try a clearer scan.');
  const item = await enrichWithAi({ ...extractFromText(text), auction_reference_id: `upload-${Date.now()}` }, text, true);
  const summary = await opportunityService.ingestItems(
    [item],
    { sourceName: sourceName || 'Uploaded notice', dataSource: 'crawler', defaultCategory: listingCategory || 'auction', requiresLegalReview: String(legalReview) === 'true' },
    user
  );
  return { parsed: item, summary, reader: { method, ocrPages, confidence: confidence ?? null } };
}

async function healthSummary() {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_enabled)::int AS enabled,
            COUNT(*) FILTER (WHERE legal_approved)::int AS approved,
            COUNT(*) FILTER (WHERE status = 'healthy')::int AS healthy,
            COUNT(*) FILTER (WHERE status = 'failing')::int AS failing,
            COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter
     FROM crawler_sources`
  );
  const runs = await pool.query(
    `SELECT COUNT(*)::int AS runs_24h, COALESCE(SUM(items_found), 0)::int AS items_24h,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_24h
     FROM crawler_runs WHERE started_at > now() - interval '24 hours'`
  );
  const legal = await pool.query(
    `SELECT COUNT(*)::int AS n FROM opportunity_ingestion_items WHERE requires_legal_review AND legal_reviewed_at IS NULL AND status IN ('needs_review', 'duplicate')`
  );
  return { ...result.rows[0], ...runs.rows[0], awaiting_legal_review: legal.rows[0].n, schedulerEnabled: !!(await configService.getConfig('crawler.enabled', false)) };
}

// ------------------------------------------------------------ scheduler

let timer = null;

async function dueSources() {
  const result = await pool.query(
    `SELECT s.id FROM crawler_sources s
     WHERE s.is_enabled AND s.legal_approved AND s.status NOT IN ('running', 'dead_letter')
       AND (s.next_run_at IS NULL OR s.next_run_at <= now())
       AND NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.flag_key = 'scraper_' || s.source_key || '_enabled' AND f.is_enabled = false)
     ORDER BY s.next_run_at NULLS FIRST`
  );
  return result.rows.map((r) => r.id);
}

async function tick() {
  // Recover sources stuck in "running" (crashed instance) after 2 hours.
  await pool.query(`UPDATE crawler_sources SET status = 'failing', last_error = 'Run did not finish (instance restarted?)' WHERE status = 'running' AND last_run_at < now() - interval '2 hours'`);
  if (!(await configService.getConfig('crawler.enabled', false))) return;
  for (const id of await dueSources()) {
    try {
      await runSource(id, { trigger: 'schedule' });
    } catch (err) {
      console.error('[crawler]', err.message);
    }
  }
}

// Started from server.js when CRAWLER_SCHEDULER_ENABLED=true. Checks every
// 5 minutes; each source runs on its own schedule_hours.
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick().catch((err) => console.error('[crawler] tick failed:', err.message)), 5 * 60 * 1000);
  setTimeout(() => tick().catch(() => {}), 30 * 1000);
  console.log('[crawler] scheduler started');
}

module.exports = { listSources, getSource, updateSource, setLegalApproval, resetSource, listRuns, runSource, parseUploadedNotice, healthSummary, startScheduler, tick };
