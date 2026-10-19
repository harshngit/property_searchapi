const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/db');
const auditService = require('./audit.service');
const imageScan = require('./imageScan.service');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 47 - the anti-fraud layers added to WFH tasks, and teams.
//
//   Track     the phone reports its position while the worker is at the
//             property. What counts is the time the server received each
//             report, so ten minutes cannot be made up in one request. The
//             pattern is then read: time inside the radius, gaps, impossible
//             speed, a position that never moves at all, mock-location.
//   Photos    a fingerprint of every photo is kept; the same picture on
//             another task is refused. A reverse image search (Google Vision
//             web detection) and an AI check for screenshots / map imagery
//             run when their keys are set.
//   Family    numbers the worker declares for their household can never be
//             submitted, and a buyer / owner who is a field partner is checked
//             against the declared Aadhaar numbers, bank account and team.
//   Risk      every submission gets a 0-100 fraud risk score from the signals
//             above; a high score is always decided by a person.
//   Teams     field partners can work as a team with a shared scoreboard.
//             Team-mates cannot be each other's buyer or owner.

const AI_MODEL = 'claude-sonnet-5';
const aiClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const wfh = () => require('./wfh.service');
const num = (c, key, fallback) => (Number.isFinite(Number(c[key])) ? Number(c[key]) : fallback);
const r1 = (v) => Math.round(v * 10) / 10;

// ------------------------------------------------------------ location track

const TRACK_ISSUES = {
  no_track: 'No location track was recorded',
  short_presence: 'Less time at the property than required',
  few_samples: 'Too few position reports',
  gaps: 'Long gaps in the location track',
  impossible_speed: 'Movement faster than is physically possible',
  no_gps_jitter: 'The position never moved at all (typical of a faked location)',
  mock_location: 'The phone reported a mock location',
};

function analyseTrack(samples, task, c) {
  const need = num(c, 'track_minutes', 10);
  const minSamples = num(c, 'track_min_samples', 8);
  const radius = num(c, 'gps_visit_radius_m', 100);
  if (!samples || !samples.length) return { ok: false, samples: 0, minutes: 0, need, issues: ['no_track'] };
  const pts = samples.map((s) => ({ ...s, d: wfh().distance(s.lat, s.lng, task.lat, task.lng), at: Date.parse(s.r) })).sort((a, b) => a.at - b.at);
  const inside = pts.filter((p) => p.d !== null && p.d <= radius);
  const minutes = inside.length ? (inside[inside.length - 1].at - inside[0].at) / 60000 : 0;
  const issues = [];
  if (pts.some((p) => p.mock)) issues.push('mock_location');
  if (minutes + 0.05 < need) issues.push('short_presence');
  if (pts.length < minSamples) issues.push('few_samples');
  let maxGap = 0;
  let path = 0;
  let fast = false;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const step = wfh().distance(a.lat, a.lng, b.lat, b.lng) || 0;
    path += step;
    maxGap = Math.max(maxGap, b.at - a.at);
    // Reports in one batch share a server time: fall back on the phone's own clock for those.
    const dt = (b.at - a.at) / 1000 || (Date.parse(b.t) - Date.parse(a.t)) / 1000;
    if (dt >= 1 && step / dt > 45) fast = true;
  }
  if (inside.length > 1 && maxGap > 4 * 60000) issues.push('gaps');
  if (fast) issues.push('impossible_speed');
  if (pts.length >= minSamples && new Set(pts.map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`)).size === 1) issues.push('no_gps_jitter');
  // Where it was recorded: the Field app (keeps going with the screen off) or a browser.
  const sources = [...new Set(pts.map((p) => p.src || 'web'))];
  return { ok: !issues.length, samples: pts.length, minutes: r1(minutes), need, issues, pathM: Math.round(path), arrived: pts[0].d !== null && pts[0].d > radius && inside.length > 0, maxGapSeconds: Math.round(maxGap / 1000), sources };
}

async function trackOf(assignmentId) {
  return (await pool.query('SELECT samples FROM wfh_location_tracks WHERE assignment_id = $1', [assignmentId])).rows[0]?.samples || [];
}

// POST /wfh/assignments/:id/track - a batch of position reports from the phone.
async function recordTrack(user, assignmentId, points) {
  const a = (await pool.query(
    `SELECT a.id, a.worker_id, a.state, t.task_type, t.latitude AS lat, t.longitude AS lng FROM wfh_task_assignments a JOIN wfh_tasks t ON t.id = a.task_id WHERE a.id = $1`,
    [assignmentId]
  )).rows[0];
  if (!a) throw notFound('Task not found');
  if (a.worker_id !== user.id) throw forbidden('Not your task');
  if (a.state !== 'accepted') throw badRequest('Location is only recorded while the task is in progress');
  if (!Array.isArray(points) || !points.length || points.length > 30) throw badRequest('Send between 1 and 30 position reports at a time');
  const now = new Date();
  const batch = points.map((p) => {
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Not a valid position');
    const t = p.at ? new Date(p.at) : null;
    return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)), acc: Number.isFinite(Number(p.accuracy)) ? Math.round(Number(p.accuracy)) : null, t: t && !Number.isNaN(t.getTime()) ? t.toISOString() : now.toISOString(), r: now.toISOString(), mock: p.mocked === true || p.mocked === 'true', src: ['android', 'ios'].includes(p.source) ? p.source : 'web' };
  });
  // A track is capped: ten minutes needs a few dozen reports, not thousands.
  await pool.query(
    `INSERT INTO wfh_location_tracks (assignment_id, worker_id, sample_count, samples) VALUES ($1, $2, $3, $4)
     ON CONFLICT (assignment_id) DO UPDATE SET samples = CASE WHEN wfh_location_tracks.sample_count >= 600 THEN wfh_location_tracks.samples ELSE wfh_location_tracks.samples || EXCLUDED.samples END,
       sample_count = wfh_location_tracks.sample_count + CASE WHEN wfh_location_tracks.sample_count >= 600 THEN 0 ELSE EXCLUDED.sample_count END, last_at = now()`,
    [assignmentId, user.id, batch.length, JSON.stringify(batch)]
  );
  const c = await wfh().cfg();
  const result = analyseTrack(await trackOf(assignmentId), a, c);
  return { samples: result.samples, minutes: result.minutes, need: result.need, ok: result.ok, issues: result.issues.map((k) => TRACK_ISSUES[k]), sources: result.sources || [] };
}

// ------------------------------------------------------------ photos

const mockSearch = () => process.env.NODE_ENV !== 'production' && process.env.WFH_REVERSE_SEARCH_MOCK === 'true';
const providers = () => ({ reverseImageSearch: !!process.env.GOOGLE_VISION_API_KEY, aiImageCheck: !!aiClient, aiFraudReview: !!aiClient });

async function visionWebDetection(buffer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(process.env.GOOGLE_VISION_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: buffer.toString('base64') }, features: [{ type: 'WEB_DETECTION', maxResults: 5 }] }] }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    const web = data.responses?.[0]?.webDetection;
    if (!res.ok || !web) return null;
    const pages = (web.pagesWithMatchingImages || []).filter((p) => (p.fullMatchingImages || []).length);
    const full = web.fullMatchingImages || [];
    return { found: full.length > 0 || pages.length > 0, where: pages[0]?.url || full[0]?.url || null };
  } catch (err) {
    console.error('[wfh] reverse image search failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Is this photo from the internet rather than taken at the property?
// Returns { found, source, where } - found is false when nothing could check it.
async function internetCheck(file, c) {
  if (c.reverse_search_enabled === false) return { found: false, checked: [] };
  if (mockSearch()) return { found: /internet/i.test(file.originalname || ''), source: 'mock', checked: ['mock'] };
  const checked = [];
  if (process.env.GOOGLE_VISION_API_KEY) {
    checked.push('reverse_image_search');
    const web = await visionWebDetection(file.buffer);
    if (web?.found) return { found: true, source: 'reverse_image_search', where: web.where, checked };
  }
  if (aiClient) {
    checked.push('ai_image_check');
    const ai = await imageScan.originScan(file.buffer);
    if (ai && (ai.is_screenshot || ai.is_map_or_street_view || ai.is_photo_of_screen || ai.has_stock_watermark)) {
      return { found: true, source: 'ai_image_check', where: ai.is_map_or_street_view ? 'map or street-view imagery' : ai.is_screenshot ? 'a screenshot' : ai.is_photo_of_screen ? 'a photo of a screen' : 'a stock image', checked };
    }
  }
  return { found: false, checked };
}

// A flat image (one colour) has no fingerprint worth comparing.
const usable = (phash) => phash !== null && phash !== undefined && !['0', '-1'].includes(String(phash));

// Problems found by comparing fingerprints: the same picture on another task,
// or twice in this submission. `photos` are processPhotos rows (with phash).
async function fingerprintProblems(assignment, photos, c) {
  const bits = num(c, 'photo_near_duplicate_bits', 4);
  const mine = photos.filter((p) => usable(p.phash));
  if (!mine.length) return;
  const known = (await pool.query(
    `SELECT phash::text AS phash, assignment_id, worker_id FROM wfh_photo_hashes WHERE assignment_id <> $1 ORDER BY created_at DESC LIMIT 5000`,
    [assignment.id]
  )).rows;
  mine.forEach((p, i) => {
    if (mine.slice(0, i).some((q) => imageScan.hamming(p.phash, q.phash) <= Math.min(bits, 2))) p.problems.push('the same photo more than once');
    const hit = known.find((k) => imageScan.hamming(p.phash, k.phash) <= bits);
    if (hit) p.problems.push(hit.worker_id === assignment.worker_id ? 'this photo was already used for another of your tasks' : 'this photo was already submitted by someone else');
  });
}

async function storeHashes(assignmentId, workerId, photos) {
  for (const p of photos.filter((x) => usable(x.phash))) {
    await pool.query('INSERT INTO wfh_photo_hashes (assignment_id, worker_id, phash) VALUES ($1, $2, $3)', [assignmentId, workerId, p.phash]).catch((err) => console.error('[wfh] photo hash not stored:', err.message));
  }
}

// ------------------------------------------------------------ family

const RELATIONS = ['spouse', 'parent', 'child', 'sibling', 'in_law', 'other'];

async function family(userId) {
  const w = (await pool.query('SELECT family_declared_at FROM wfh_workers WHERE user_id = $1', [userId])).rows[0];
  const rows = (await pool.query('SELECT id, relation, name, phone_last4, (aadhaar_hash IS NOT NULL) AS has_aadhaar, created_at FROM wfh_worker_family WHERE worker_id = $1 ORDER BY created_at', [userId])).rows;
  return { declared: !!w?.family_declared_at, declaredAt: w?.family_declared_at || null, relations: RELATIONS, members: rows.map((r) => ({ id: r.id, relation: r.relation, name: r.name, phoneLast4: r.phone_last4, hasAadhaar: r.has_aadhaar, addedAt: r.created_at })) };
}

// Declare household members. Numbers can be added later but never removed -
// otherwise a number could be taken off the list just before it is submitted.
async function setFamily(user, data = {}, meta = {}) {
  const { sha, phoneOf, workerRow } = wfh().helpers;
  const w = await workerRow(user.id);
  if (!w) throw badRequest('Join the programme first');
  const members = Array.isArray(data.members) ? data.members : [];
  if (members.length > 15) throw badRequest('List up to 15 household members');
  if (!members.length && data.none !== true && !w.family_declared_at) throw badRequest('List your household\'s mobile numbers, or confirm that there are none');
  const rows = members.map((m) => {
    const phone = phoneOf(m.mobile);
    if (!phone || !/^[6-9]\d{9}$/.test(phone)) throw badRequest('Enter each family member\'s 10-digit mobile number');
    if (phone === phoneOf(w.mobile)) throw badRequest('That is your own number - list the others in your household');
    if (!RELATIONS.includes(m.relation)) throw badRequest(`Relation must be one of: ${RELATIONS.join(', ')}`);
    const aadhaar = m.aadhaar ? String(m.aadhaar).replace(/\D/g, '') : null;
    if (aadhaar && !/^\d{12}$/.test(aadhaar)) throw badRequest('A family member\'s Aadhaar must be 12 digits');
    return [m.relation, m.name ? String(m.name).trim().slice(0, 120) : null, sha(phone), phone.slice(-4), aadhaar ? sha(aadhaar) : null];
  });
  let added = 0;
  for (const r of rows) {
    added += (await pool.query(
      `INSERT INTO wfh_worker_family (worker_id, relation, name, phone_hash, phone_last4, aadhaar_hash) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (worker_id, phone_hash) DO UPDATE SET aadhaar_hash = COALESCE(wfh_worker_family.aadhaar_hash, EXCLUDED.aadhaar_hash)`,
      [user.id, ...r]
    )).rowCount;
  }
  await pool.query('UPDATE wfh_workers SET family_declared_at = COALESCE(family_declared_at, now()), updated_at = now() WHERE user_id = $1', [user.id]);
  await auditService.log({ actor: user, action: 'wfh.family_declared', entityType: 'wfh_worker', entityId: user.id, after: { members: added, none: !members.length }, ...meta });
  return family(user.id);
}

const surname = (name) => {
  const parts = String(name || '').trim().toLowerCase().split(/\s+/).filter((p) => /^[a-z]{3,}$/.test(p));
  return parts.length > 1 ? parts[parts.length - 1] : null;
};

// The buyer / owner must not be the worker's family (declared numbers, with an
// Aadhaar, bank-account and team cross-check when that person is on the
// platform). Throws when the task must be refused; returns flags otherwise.
async function familyCheck(worker, phone, person, partyName) {
  const { sha, phoneOf } = wfh().helpers;
  const flags = [];
  if ((await pool.query('SELECT 1 FROM wfh_worker_family WHERE worker_id = $1 AND phone_hash = $2', [worker.user_id, sha(phone)])).rows.length) {
    throw badRequest('This number belongs to someone in your household - family members cannot be submitted');
  }
  if (person) {
    const other = (await pool.query('SELECT aadhaar_hash, bank_hash FROM wfh_workers WHERE user_id = $1', [person.id])).rows[0];
    if (other) {
      if ((await pool.query('SELECT 1 FROM wfh_worker_family WHERE worker_id = $1 AND aadhaar_hash = $2', [worker.user_id, other.aadhaar_hash])).rows.length) {
        throw badRequest('Aadhaar shows this person is in your household - family members cannot be submitted');
      }
      if (other.bank_hash && worker.bank_hash && other.bank_hash === worker.bank_hash) throw badRequest('This person is paid into the same bank account as you and cannot be submitted');
      flags.push({ rule: 'party_is_worker', detail: 'The buyer / owner is also a field partner' });
    }
    const me = phoneOf(worker.mobile);
    if (me && (await pool.query('SELECT 1 FROM wfh_worker_family WHERE worker_id = $1 AND phone_hash = $2', [person.id, sha(me)])).rows.length) {
      throw badRequest('This person has listed you as a family member and cannot be submitted');
    }
    if ((await pool.query('SELECT 1 FROM wfh_team_members a JOIN wfh_team_members b ON b.team_id = a.team_id WHERE a.worker_id = $1 AND b.worker_id = $2', [worker.user_id, person.id])).rows.length) {
      throw badRequest('A member of your own team cannot be submitted as a buyer or an owner');
    }
  }
  const mine = surname(worker.full_name);
  if (mine && mine === surname(partyName || person?.full_name)) flags.push({ rule: 'possible_relative', detail: 'Same surname as the field partner' });
  return flags;
}

// ------------------------------------------------------------ fraud risk score

const WEIGHTS = {
  phone_repeat: 20, device_changed: 15,
  track_no_track: 20, track_short_presence: 15, track_few_samples: 10, track_gaps: 10, track_impossible_speed: 35, track_no_gps_jitter: 30, track_mock_location: 45,
  photo_no_camera: 10, photo_edited: 20, photo_unchecked_origin: 0,
  possible_relative: 25, party_is_worker: 15,
  shared_device: 20, high_rejection: 15, new_worker: 10, too_fast: 20, odd_hours: 10, poor_gps_accuracy: 10,
};

const AI_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['genuine', 'suspicious', 'likely_fraud'] }, reasoning: { type: 'string' } },
  required: ['verdict', 'reasoning'],
  additionalProperties: false,
};

// A second opinion on the signals. No names, numbers or addresses are sent.
async function aiOpinion(facts) {
  if (!aiClient) return null;
  try {
    const response = await aiClient.messages.create({
      model: AI_MODEL,
      max_tokens: 400,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
      messages: [{
        role: 'user',
        content:
          'You review field tasks for a real-estate platform that pays people a fixed amount per verified task (bringing a buyer to a property, photographing a property with the owner\'s consent, collecting a buyer\'s requirement). ' +
          'Fraud means: a visit that never happened, a faked GPS position, photos not taken at the property, or a buyer / owner who is the worker, a relative or an accomplice. ' +
          'Given the checks below, say whether this submission looks genuine, suspicious or likely fraud, and why in one or two sentences. A new worker or a single weak signal alone is not fraud.\n\n' +
          JSON.stringify(facts),
      }],
    });
    const block = response.content.find((b) => b.type === 'text');
    const out = block ? JSON.parse(block.text) : null;
    return out ? { verdict: out.verdict, reasoning: String(out.reasoning || '').slice(0, 600), model: AI_MODEL } : null;
  } catch (err) {
    console.error('[wfh] AI fraud review failed:', err.message);
    return null;
  }
}

// Score a submission from its flags and the worker's record. Stores the score
// on the assignment; a high score holds the task for a person (see advance()).
async function assess(assignmentId, worker, flags, c) {
  const a = (await pool.query(
    `SELECT a.id, a.worker_id, a.accepted_at, a.submitted_at, a.gps_distance_from_property_m, a.track_summary, t.task_type, t.title FROM wfh_task_assignments a JOIN wfh_tasks t ON t.id = a.task_id WHERE a.id = $1`,
    [assignmentId]
  )).rows[0];
  const type = wfh().TYPES[a.task_type];
  const signals = [...flags];
  if (worker.device_hash && (await pool.query('SELECT COUNT(*)::int AS n FROM wfh_workers WHERE device_hash = $1', [worker.device_hash])).rows[0].n > 1) signals.push({ rule: 'shared_device', detail: 'Another field partner registered from the same device' });
  if (Number(worker.rejection_rate) > num(c, 'rejection_rate_review_percent', 30)) signals.push({ rule: 'high_rejection', detail: `Rejection rate ${Number(worker.rejection_rate)}%` });
  if (Date.now() - new Date(worker.created_at).getTime() < 7 * 86400000) signals.push({ rule: 'new_worker', detail: 'Joined in the last 7 days' });
  if (type.gps && new Date(a.submitted_at) - new Date(a.accepted_at) < 3 * 60000) signals.push({ rule: 'too_fast', detail: 'Submitted within 3 minutes of accepting' });
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date(a.submitted_at))) % 24;
  if (type.gps && hour < 5) signals.push({ rule: 'odd_hours', detail: 'A visit between midnight and 5 am' });
  const reasons = signals.map((s) => ({ rule: s.rule, detail: s.detail, points: WEIGHTS[s.rule] ?? 10 })).filter((s) => s.points > 0);
  let score = Math.min(100, reasons.reduce((sum, s) => sum + s.points, 0));
  const review = num(c, 'risk_review_score', 60);
  const ai = c.ai_fraud_review === false || !reasons.length ? null : await aiOpinion({ taskType: a.task_type, gpsDistanceM: a.gps_distance_from_property_m, track: a.track_summary, signals: reasons, ruleScore: score });
  // The AI can raise a submission to a human; it never clears one.
  if (ai?.verdict === 'likely_fraud' && score < review) {
    score = review;
    reasons.push({ rule: 'ai_review', detail: ai.reasoning, points: 0 });
  }
  const band = score >= review ? 'high' : score >= num(c, 'risk_watch_score', 30) ? 'medium' : 'low';
  await pool.query('UPDATE wfh_task_assignments SET risk_score = $1, risk_band = $2, risk_reasons = $3, ai_assessment = $4 WHERE id = $5', [score, band, JSON.stringify(reasons), ai ? JSON.stringify(ai) : null, assignmentId]);
  await pool.query(
    `UPDATE wfh_workers SET risk_score = (SELECT ROUND(AVG(risk_score)) FROM (SELECT risk_score FROM wfh_task_assignments WHERE worker_id = $1 AND risk_score IS NOT NULL ORDER BY submitted_at DESC LIMIT 10) x) WHERE user_id = $1`,
    [a.worker_id]
  );
  if (band === 'high') {
    const recent = (await pool.query(`SELECT COUNT(*)::int AS n FROM wfh_task_assignments WHERE worker_id = $1 AND risk_band = 'high' AND submitted_at > now() - interval '30 days'`, [a.worker_id])).rows[0].n;
    if (recent >= 3 && !(await pool.query(`SELECT 1 FROM user_flags WHERE user_id = $1 AND reason = 'wfh_high_risk_submissions' AND resolved_at IS NULL`, [a.worker_id])).rows.length) {
      await pool.query(`INSERT INTO user_flags (user_id, reason, detail) VALUES ($1, 'wfh_high_risk_submissions', $2)`, [a.worker_id, JSON.stringify({ last30Days: recent })]);
    }
    const admins = (await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`)).rows;
    for (const u of admins) {
      await require('./notification.service').createNotification({ userId: u.id, type: 'wfh', priority: 'high', title: `High fraud risk on a field task (${score}/100)`, message: `${a.title}: ${reasons.slice(0, 3).map((r) => r.detail).join('; ')}. It is held for review.`, relatedEntityType: 'wfh_assignment', relatedEntityId: assignmentId }).catch(() => {});
    }
  }
  return { score, band, reasons, ai };
}

// What the fraud checks are doing, for the staff screen.
async function fraudOverview() {
  const [bands, rules, held] = await Promise.all([
    pool.query(`SELECT COALESCE(risk_band, 'unscored') AS band, COUNT(*)::int AS n FROM wfh_task_assignments WHERE submitted_at > now() - interval '30 days' GROUP BY 1`),
    pool.query(`SELECT r->>'rule' AS rule, COUNT(*)::int AS n FROM wfh_task_assignments a, jsonb_array_elements(a.risk_reasons) r WHERE a.submitted_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
    pool.query(`SELECT COUNT(*)::int AS n FROM wfh_task_assignments WHERE state = 'submitted' AND verification_status = 'pending' AND risk_band = 'high'`),
  ]);
  return { last30Days: Object.fromEntries(bands.rows.map((b) => [b.band, b.n])), topSignals: rules.rows, heldForReview: held.rows[0].n, providers: providers() };
}

// ------------------------------------------------------------ teams

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const teamCode = () => `T${Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')}`;
// Team-mates see a first name and an initial, not a full identity.
const shortName = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] || 'Field partner';
};

async function eligible(user) {
  const { workerRow } = wfh().helpers;
  const w = await workerRow(user.id);
  if (!w) throw badRequest('Join the programme first');
  if (w.status !== 'active' || w.kyc_status !== 'verified') throw badRequest('Teams are for field partners whose KYC is verified');
  return w;
}

const TEAM_STATS = `
  SELECT m.team_id, COUNT(*) FILTER (WHERE a.verification_status = 'passed')::int AS verified_total,
         COUNT(*) FILTER (WHERE a.verification_status = 'passed' AND a.verified_at >= date_trunc('month', now()))::int AS verified_month
  FROM wfh_team_members m LEFT JOIN wfh_task_assignments a ON a.worker_id = m.worker_id AND a.verified_at >= m.joined_at GROUP BY m.team_id`;

async function myTeam(user) {
  const t = (await pool.query(`SELECT t.* FROM wfh_team_members m JOIN wfh_teams t ON t.id = m.team_id WHERE m.worker_id = $1 AND t.status = 'active'`, [user.id])).rows[0];
  const c = await wfh().cfg();
  if (!t) return { team: null, maxSize: num(c, 'team_max_size', 10) };
  const members = (await pool.query(
    `SELECT m.worker_id, m.joined_at, u.full_name,
            (SELECT COUNT(*)::int FROM wfh_task_assignments a WHERE a.worker_id = m.worker_id AND a.verification_status = 'passed' AND a.verified_at >= m.joined_at) AS verified_total,
            (SELECT COUNT(*)::int FROM wfh_task_assignments a WHERE a.worker_id = m.worker_id AND a.verification_status = 'passed' AND a.verified_at >= GREATEST(m.joined_at, date_trunc('month', now()))) AS verified_month
     FROM wfh_team_members m JOIN users u ON u.id = m.worker_id WHERE m.team_id = $1 ORDER BY m.joined_at`,
    [t.id]
  )).rows;
  const board = (await pool.query(`SELECT t.id, COALESCE(s.verified_month, 0) AS verified_month FROM wfh_teams t LEFT JOIN (${TEAM_STATS}) s ON s.team_id = t.id WHERE t.status = 'active'`)).rows;
  const month = members.reduce((sum, m) => sum + m.verified_month, 0);
  return {
    maxSize: num(c, 'team_max_size', 10),
    team: {
      id: t.id, name: t.name, code: t.code, city: t.city, createdAt: t.created_at, isLeader: t.leader_id === user.id,
      members: members.map((m) => ({ userId: m.worker_id, name: m.worker_id === user.id ? m.full_name : shortName(m.full_name), isLeader: m.worker_id === t.leader_id, isYou: m.worker_id === user.id, joinedAt: m.joined_at, verifiedThisMonth: m.verified_month, verifiedTotal: m.verified_total })),
      stats: { verifiedThisMonth: month, verifiedTotal: members.reduce((sum, m) => sum + m.verified_total, 0), rank: board.filter((b) => b.verified_month > month).length + 1, teams: board.length },
    },
  };
}

async function createTeam(user, { name }, meta = {}) {
  const w = await eligible(user);
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 3 || clean.length > 60) throw badRequest('Give the team a name of 3 to 60 characters');
  if ((await pool.query('SELECT 1 FROM wfh_team_members WHERE worker_id = $1', [user.id])).rows.length) throw badRequest('Leave your current team first');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query('INSERT INTO wfh_teams (name, code, leader_id, city) VALUES ($1, $2, $3, $4) RETURNING id', [clean, teamCode(), user.id, w.city || null])).rows[0];
    await client.query('INSERT INTO wfh_team_members (worker_id, team_id) VALUES ($1, $2)', [user.id, t.id]);
    await client.query('COMMIT');
    await auditService.log({ actor: user, action: 'wfh.team_created', entityType: 'wfh_team', entityId: t.id, after: { name: clean }, ...meta });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw badRequest('A team with that name already exists');
    throw err;
  } finally {
    client.release();
  }
  return myTeam(user);
}

async function joinTeam(user, { code }, meta = {}) {
  const w = await eligible(user);
  const c = await wfh().cfg();
  const t = (await pool.query(`SELECT * FROM wfh_teams WHERE code = $1 AND status = 'active'`, [String(code || '').trim().toUpperCase()])).rows[0];
  if (!t) throw notFound('No team with that code');
  if ((await pool.query('SELECT 1 FROM wfh_team_members WHERE worker_id = $1', [user.id])).rows.length) throw badRequest('Leave your current team first');
  const size = (await pool.query('SELECT COUNT(*)::int AS n FROM wfh_team_members WHERE team_id = $1', [t.id])).rows[0].n;
  if (size >= num(c, 'team_max_size', 10)) throw badRequest('This team is full');
  await pool.query('INSERT INTO wfh_team_members (worker_id, team_id) VALUES ($1, $2)', [user.id, t.id]);
  await auditService.log({ actor: user, action: 'wfh.team_joined', entityType: 'wfh_team', entityId: t.id, after: { size: size + 1 }, ...meta });
  await require('./notification.service').createNotification({ userId: t.leader_id, type: 'wfh', title: 'A field partner joined your team', message: `${shortName(w.full_name)} joined ${t.name}.`, relatedEntityType: 'wfh_team', relatedEntityId: t.id }).catch(() => {});
  return myTeam(user);
}

// Remove a member (leaving, or removed by the leader). The longest-serving
// member takes over when the leader goes; an empty team is closed.
async function dropMember(teamId, workerId) {
  await pool.query('DELETE FROM wfh_team_members WHERE worker_id = $1 AND team_id = $2', [workerId, teamId]);
  const next = (await pool.query('SELECT worker_id FROM wfh_team_members WHERE team_id = $1 ORDER BY joined_at LIMIT 1', [teamId])).rows[0];
  if (!next) await pool.query(`UPDATE wfh_teams SET status = 'disbanded' WHERE id = $1`, [teamId]);
  else await pool.query('UPDATE wfh_teams SET leader_id = $1 WHERE id = $2 AND leader_id = $3', [next.worker_id, teamId, workerId]);
}

async function leaveTeam(user, meta = {}) {
  const m = (await pool.query('SELECT team_id FROM wfh_team_members WHERE worker_id = $1', [user.id])).rows[0];
  if (!m) throw badRequest('You are not in a team');
  await dropMember(m.team_id, user.id);
  await auditService.log({ actor: user, action: 'wfh.team_left', entityType: 'wfh_team', entityId: m.team_id, ...meta });
  return myTeam(user);
}

async function removeMember(user, memberId, meta = {}) {
  const t = (await pool.query(`SELECT t.id, t.name FROM wfh_teams t WHERE t.leader_id = $1 AND t.status = 'active'`, [user.id])).rows[0];
  if (!t) throw forbidden('Only the team leader can remove a member');
  if (memberId === user.id) throw badRequest('Use "Leave team" to leave your own team');
  if (!(await pool.query('SELECT 1 FROM wfh_team_members WHERE worker_id = $1 AND team_id = $2', [memberId, t.id])).rows.length) throw notFound('That person is not in your team');
  await dropMember(t.id, memberId);
  await auditService.log({ actor: user, action: 'wfh.team_member_removed', entityType: 'wfh_team', entityId: t.id, after: { memberId }, ...meta });
  await require('./notification.service').createNotification({ userId: memberId, type: 'wfh', title: 'You were removed from a team', message: `The leader of ${t.name} removed you from the team.`, relatedEntityType: 'wfh_team', relatedEntityId: t.id }).catch(() => {});
  return myTeam(user);
}

// Staff: every team with its output and the signs of a team working together to cheat.
async function listTeams() {
  const r = await pool.query(
    `SELECT t.id, t.name, t.code, t.city, t.status, t.created_at, u.full_name AS leader_name, COALESCE(s.verified_total, 0) AS verified_total, COALESCE(s.verified_month, 0) AS verified_month,
            (SELECT COUNT(*)::int FROM wfh_team_members m WHERE m.team_id = t.id) AS members,
            (SELECT COUNT(*)::int FROM wfh_team_members m JOIN wfh_task_assignments a ON a.worker_id = m.worker_id WHERE m.team_id = t.id AND a.risk_band = 'high' AND a.submitted_at > now() - interval '30 days') AS high_risk,
            EXISTS (SELECT 1 FROM wfh_team_members m JOIN wfh_workers w ON w.user_id = m.worker_id WHERE m.team_id = t.id AND w.device_hash IS NOT NULL GROUP BY w.device_hash HAVING COUNT(*) > 1) AS shared_device,
            EXISTS (SELECT 1 FROM wfh_team_members m JOIN wfh_workers w ON w.user_id = m.worker_id WHERE m.team_id = t.id AND w.bank_hash IS NOT NULL GROUP BY w.bank_hash HAVING COUNT(*) > 1) AS shared_bank
     FROM wfh_teams t JOIN users u ON u.id = t.leader_id LEFT JOIN (${TEAM_STATS}) s ON s.team_id = t.id ORDER BY (t.status = 'active') DESC, COALESCE(s.verified_month, 0) DESC, t.created_at DESC LIMIT 300`
  );
  return r.rows.map((t) => ({ id: t.id, name: t.name, code: t.code, city: t.city, status: t.status, createdAt: t.created_at, leaderName: t.leader_name, members: t.members, verifiedThisMonth: t.verified_month, verifiedTotal: t.verified_total, highRiskLast30Days: t.high_risk, sharedDevice: t.shared_device, sharedBankAccount: t.shared_bank }));
}

module.exports = {
  TRACK_ISSUES, RELATIONS, WEIGHTS, analyseTrack, trackOf, recordTrack, internetCheck, fingerprintProblems, storeHashes, providers,
  family, setFamily, familyCheck, assess, fraudOverview, myTeam, createTeam, joinTeam, leaveTeam, removeMember, listTeams,
};
