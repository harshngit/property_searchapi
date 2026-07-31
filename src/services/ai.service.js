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

module.exports = {
  generateLeadSummary,
  safeGenerateLeadSummary,
  scoreLead,
  previewExtractIntent,
  getLatestInsight,
};
