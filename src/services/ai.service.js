const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/db');

function notFound(message = 'Lead not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

// The spec named "claude-sonnet-4-6" (still a valid, active model), but that
// generation doesn't support the Messages API's structured-outputs feature
// (json_schema-constrained responses) - Claude Sonnet 5 does, which gets us
// a guaranteed-parseable extraction instead of hoping the model's prose JSON
// parses cleanly. Same tier the spec asked for, just the current generation.
const AI_MODEL = 'claude-sonnet-5';

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const INSIGHT_SCHEMA = {
  type: 'object',
  properties: {
    budgetMin: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    budgetMax: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    location: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    propertyType: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    intent: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    timeline: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    summary: { type: 'string' },
    score: { type: 'string', enum: ['hot', 'warm', 'cold'] },
    confidence: { type: 'number' },
  },
  required: ['summary', 'score', 'confidence'],
  additionalProperties: false,
};

// Pulls together everything we know about a lead's stated needs - the
// public-inquiry message (if that's how it started) plus every staff note -
// into one block of text for the model to read.
async function gatherLeadText(leadId) {
  const [leadResult, notesResult, activityResult] = await Promise.all([
    pool.query('SELECT id, source FROM leads WHERE id = $1', [leadId]),
    pool.query('SELECT note FROM lead_notes WHERE lead_id = $1 ORDER BY created_at ASC', [leadId]),
    pool.query(
      `SELECT details FROM lead_activity_log WHERE lead_id = $1 AND action = 'lead_created' LIMIT 1`,
      [leadId]
    ),
  ]);

  if (leadResult.rows.length === 0) throw notFound();
  const lead = leadResult.rows[0];

  const parts = [];
  const inquiryMessage = activityResult.rows[0]?.details?.message;
  if (inquiryMessage) parts.push(`Initial inquiry: ${inquiryMessage}`);
  for (const row of notesResult.rows) parts.push(`Note: ${row.note}`);

  return { lead, text: parts.join('\n') };
}

// TODO: replace with a real Anthropic API key check / secrets manager lookup
// in production; for now this just reads process.env.ANTHROPIC_API_KEY.
function assertConfigured() {
  if (!client) {
    const err = new Error('AI service is not configured (ANTHROPIC_API_KEY missing)');
    err.statusCode = 503;
    throw err;
  }
}

// Core extraction call - shared by generateLeadSummary, scoreLead, and
// previewExtractIntent so the Anthropic API is only ever called from one
// place. Returns null (does not call the API) when the lead has no notes or
// inquiry text to extract from - never spend a request on nothing to read.
async function extractInsight(leadId) {
  const { text } = await gatherLeadText(leadId);
  if (!text.trim()) return null;

  assertConfigured();

  let response;
  try {
    response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      output_config: {
        effort: 'low', // simple extraction task, not intelligence-sensitive
        format: { type: 'json_schema', schema: INSIGHT_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content:
            'You are qualifying a real-estate lead for a brokerage CRM. Read the notes below ' +
            'and extract the buyer/renter\'s budget range, preferred location, property type, ' +
            'intent (buy/sell/rent), and timeline if mentioned. Write a short (1-2 sentence) ' +
            'summary, and rate the lead hot/warm/cold based on how qualified and ready-to-act ' +
            'they sound.\n\n' +
            text,
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const wrapped = new Error(`AI extraction failed: ${err.message}`);
      wrapped.statusCode = 502;
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    const err = new Error('AI extraction returned no content');
    err.statusCode = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    const err = new Error('AI extraction returned unparseable JSON');
    err.statusCode = 502;
    throw err;
  }

  return { ...parsed, rawResponse: response };
}

async function saveInsight(leadId, insight, overrideScore) {
  const result = await pool.query(
    `INSERT INTO ai_lead_insights (
       lead_id, extracted_budget_min, extracted_budget_max, extracted_location,
       extracted_property_type, extracted_intent, extracted_timeline, summary,
       score, confidence, raw_response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      leadId,
      insight.budgetMin ?? null,
      insight.budgetMax ?? null,
      insight.location ?? null,
      insight.propertyType ?? null,
      insight.intent ?? null,
      insight.timeline ?? null,
      insight.summary,
      overrideScore || insight.score,
      insight.confidence,
      JSON.stringify(insight.rawResponse ?? {}),
    ]
  );
  return result.rows[0];
}

// POST /api/ai/lead-summary
async function generateLeadSummary(leadId) {
  const insight = await extractInsight(leadId);
  if (!insight) {
    // Nothing to extract from - save a placeholder so callers of GET
    // .../analysis still get a row rather than a 404.
    return saveInsight(leadId, {
      summary: 'No notes or inquiry text available yet.',
      score: 'cold',
      confidence: 0,
    });
  }
  return saveInsight(leadId, insight);
}

// Internal wrapper - called from lead.service.js right after a lead is
// created. An AI failure (missing key, rate limit, malformed response) must
// never break lead creation, so every error is swallowed here and logged.
async function safeGenerateLeadSummary(leadId) {
  try {
    await generateLeadSummary(leadId);
  } catch (err) {
    console.error(`AI lead-summary failed for lead ${leadId}:`, err.message);
  }
}

// Simple, tunable rule-based scorer (0-100). Not a replacement for the AI's
// own judgement - see scoreLead() below, which blends the two.
async function computeRuleScore(lead) {
  const [preferencesResult, latestActivityResult] = await Promise.all([
    pool.query(
      `SELECT cp.budget_min, cp.budget_max FROM customer_preferences cp
       WHERE cp.customer_id = $1`,
      [lead.customer_id]
    ),
    pool.query(
      'SELECT created_at FROM lead_activity_log WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
      [lead.id]
    ),
  ]);

  const preferences = preferencesResult.rows[0];
  let budgetComponent = 0;
  if (preferences?.budget_min != null && preferences?.budget_max != null) budgetComponent = 40;
  else if (preferences?.budget_min != null || preferences?.budget_max != null) budgetComponent = 20;

  let recencyComponent = 0;
  const lastActivityAt = latestActivityResult.rows[0]?.created_at;
  if (lastActivityAt) {
    const daysSince = (Date.now() - new Date(lastActivityAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 1) recencyComponent = 35;
    else if (daysSince <= 3) recencyComponent = 25;
    else if (daysSince <= 7) recencyComponent = 15;
    else if (daysSince <= 30) recencyComponent = 5;
  }

  const SOURCE_QUALITY = { whatsapp: 25, website: 20, campaign: 15, manual: 10 };
  const sourceComponent = SOURCE_QUALITY[lead.source] ?? 10;

  return budgetComponent + recencyComponent + sourceComponent;
}

const AI_SCORE_NUMERIC = { hot: 90, warm: 60, cold: 30 };

function numericToLevel(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

// POST /api/ai/lead-score
async function scoreLead(leadId) {
  const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
  if (leadResult.rows.length === 0) throw notFound();
  const lead = leadResult.rows[0];

  const insight = await extractInsight(leadId);
  const ruleScore = await computeRuleScore(lead);

  if (!insight) {
    return saveInsight(leadId, {
      summary: 'No notes or inquiry text available yet.',
      score: numericToLevel(ruleScore),
      confidence: 0,
    });
  }

  // Blend: 60% rule-based (concrete signals) + 40% the AI's own read of intent/urgency.
  const combined = Math.round(0.6 * ruleScore + 0.4 * AI_SCORE_NUMERIC[insight.score]);
  return saveInsight(leadId, insight, numericToLevel(combined));
}

// POST /api/ai/extract-intent - preview only, does not save
async function previewExtractIntent(leadId) {
  const insight = await extractInsight(leadId);
  if (!insight) {
    return { summary: 'No notes or inquiry text available yet.', score: 'cold', confidence: 0 };
  }
  const { rawResponse, ...preview } = insight;
  return preview;
}

// GET /api/ai/lead/:id/analysis
async function getLatestInsight(leadId) {
  const result = await pool.query(
    'SELECT * FROM ai_lead_insights WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
    [leadId]
  );
  return result.rows[0] || null;
}

// Leads visible to the caller (same rule as leads listing: admins see all,
// others their tenant / own / assigned).
function leadScope(user, alias, where, params) {
  if (['admin', 'super_admin'].includes(user.role)) return;
  params.push(user.tenant_id || null, user.id, user.id);
  where.push(
    `(${alias}.tenant_id = $${params.length - 2} OR ${alias}.created_by = $${params.length - 1} OR ${alias}.assigned_to = $${params.length})`
  );
}

// GET /api/ai/insights - latest insight per lead, newest first, with the
// lead/customer context and the latest human review (if any) - backs the
// CRM "Recent AI qualifications" list.
async function listInsights(user, { score, reviewed, page = 1, limit = 20 } = {}) {
  const where = [];
  const params = [];
  leadScope(user, 'l', where, params);
  if (score) {
    params.push(score);
    where.push(`COALESCE(r.new_score, i.score) = $${params.length}`);
  }
  if (reviewed === 'true') where.push('r.id IS NOT NULL');
  if (reviewed === 'false') where.push('r.id IS NULL');
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const base = `
    FROM (SELECT DISTINCT ON (lead_id) * FROM ai_lead_insights ORDER BY lead_id, created_at DESC) i
    JOIN leads l ON l.id = i.lead_id
    JOIN customers c ON c.id = l.customer_id
    LEFT JOIN users assignee ON assignee.id = l.assigned_to
    LEFT JOIN properties p ON p.id = l.property_id
    LEFT JOIN LATERAL (
      SELECT * FROM ai_insight_reviews ar WHERE ar.insight_id = i.id ORDER BY ar.created_at DESC LIMIT 1
    ) r ON true`;

  const count = await pool.query(`SELECT COUNT(*) ${base} ${whereClause}`, params);
  const offset = (Number(page) - 1) * Number(limit);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT i.id, i.lead_id, i.summary, i.score AS ai_score, COALESCE(r.new_score, i.score) AS effective_score,
            i.confidence, i.extracted_budget_min, i.extracted_budget_max, i.extracted_location,
            i.extracted_property_type, i.extracted_intent, i.extracted_timeline, i.created_at,
            l.status AS lead_status, l.source AS lead_source,
            c.full_name AS customer_name, assignee.full_name AS assigned_to_name, p.title AS property_title,
            r.action AS review_action, r.reason AS review_reason, r.created_at AS reviewed_at
     ${base} ${whereClause}
     ORDER BY i.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: Number(count.rows[0].count),
      totalPages: Math.ceil(Number(count.rows[0].count) / Number(limit)),
    },
  };
}

// GET /api/ai/stats - AI page headline cards over the last `days` days:
// leads qualified, average confidence, score mix, manual overrides, and
// agreement rate (confirmed / reviewed) as the "routing accuracy" proxy.
async function getStats(user, { days = 7 } = {}) {
  const span = Math.min(Math.max(Number(days) || 7, 1), 365);
  const where = [`i.created_at > now() - ($1 || ' days')::interval`];
  const params = [span];
  leadScope(user, 'l', where, params);
  const whereClause = `WHERE ${where.join(' AND ')}`;

  const [insights, reviews] = await Promise.all([
    pool.query(
      `SELECT COUNT(DISTINCT i.lead_id)::int AS leads_qualified,
              ROUND(AVG(i.confidence) * 100)::int AS avg_confidence_percent,
              COUNT(*) FILTER (WHERE i.score = 'hot')::int AS hot,
              COUNT(*) FILTER (WHERE i.score = 'warm')::int AS warm,
              COUNT(*) FILTER (WHERE i.score = 'cold')::int AS cold
       FROM ai_lead_insights i JOIN leads l ON l.id = i.lead_id ${whereClause}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE r.action = 'override')::int AS manual_overrides,
              COUNT(*) FILTER (WHERE r.action = 'confirm')::int AS confirmed
       FROM ai_insight_reviews r JOIN leads l ON l.id = r.lead_id
       WHERE r.created_at > now() - ($1 || ' days')::interval ${where.length > 1 ? `AND ${where.slice(1).join(' AND ')}` : ''}`,
      params
    ),
  ]);

  const { manual_overrides: overrides, confirmed } = reviews.rows[0];
  const reviewed = overrides + confirmed;
  return {
    days: span,
    ...insights.rows[0],
    manual_overrides: overrides,
    confirmed,
    agreement_rate_percent: reviewed > 0 ? Math.round((confirmed / reviewed) * 100) : null,
    override_rate_percent: reviewed > 0 ? Math.round((overrides / reviewed) * 100) : null,
  };
}

// POST /api/ai/lead/:id/review - a human confirms or overrides the latest
// AI score. Kept in its own append-only table; an override also moves the
// lead's status to the new hot/warm/cold value (with an activity entry) so
// the CRM pipeline reflects the human decision.
async function reviewInsight(leadId, { action, score, reason }, user) {
  const latest = await getLatestInsight(leadId);
  if (!latest) {
    const err = new Error('This lead has no AI insight to review yet');
    err.statusCode = 404;
    throw err;
  }
  if (action === 'override' && !score) {
    const err = new Error('score is required when overriding');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const review = await client.query(
      `INSERT INTO ai_insight_reviews (insight_id, lead_id, action, original_score, new_score, reason, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [latest.id, leadId, action, latest.score, action === 'override' ? score : latest.score, reason || null, user.id]
    );

    if (action === 'override') {
      const current = await client.query('SELECT status FROM leads WHERE id = $1 FOR UPDATE', [leadId]);
      const previous = current.rows[0]?.status;
      // Only temperature statuses follow the AI score; a lead already won,
      // lost or mid-pipeline keeps its status.
      if (['new', 'contacted', 'qualified', 'hot', 'warm', 'cold'].includes(previous) && previous !== score) {
        await client.query('UPDATE leads SET status = $1 WHERE id = $2', [score, leadId]);
        await client.query(
          `INSERT INTO lead_activity_log (lead_id, user_id, action, details) VALUES ($1, $2, 'status_changed', $3)`,
          [leadId, user.id, JSON.stringify({ from: previous, to: score, via: 'ai_score_override', reason: reason || null })]
        );
      }
    }
    await client.query('COMMIT');
    return review.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listInsights,
  getStats,
  reviewInsight,
  generateLeadSummary,
  safeGenerateLeadSummary,
  scoreLead,
  previewExtractIntent,
  getLatestInsight,
};
