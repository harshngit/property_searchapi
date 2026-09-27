const aiService = require('../services/ai.service');
const leadService = require('../services/lead.service');
const { success } = require('../utils/response');
const { assertTenantVisible } = require('../utils/ownership');

const LEAD_OWNER_FIELDS = ['created_by', 'assigned_to'];

async function assertLeadAccess(req) {
  const lead = await leadService.getLeadById(req.body.leadId || req.params.id);
  assertTenantVisible(req.user, lead, 'Lead not found', { ownerFields: LEAD_OWNER_FIELDS });
  return lead;
}

// POST /api/ai/lead-summary
async function leadSummary(req, res, next) {
  try {
    await assertLeadAccess(req);
    const insight = await aiService.generateLeadSummary(req.body.leadId);
    return success(res, 201, 'Lead summary generated successfully', insight);
  } catch (err) {
    next(err);
  }
}

// POST /api/ai/lead-score
async function leadScore(req, res, next) {
  try {
    await assertLeadAccess(req);
    const insight = await aiService.scoreLead(req.body.leadId);
    return success(res, 201, 'Lead score computed successfully', insight);
  } catch (err) {
    next(err);
  }
}

// POST /api/ai/extract-intent
async function extractIntent(req, res, next) {
  try {
    await assertLeadAccess(req);
    const preview = await aiService.previewExtractIntent(req.body.leadId);
    return success(res, 200, 'Intent extracted successfully', preview);
  } catch (err) {
    next(err);
  }
}

// GET /api/ai/lead/:id/analysis
async function getAnalysis(req, res, next) {
  try {
    await assertLeadAccess(req);
    const insight = await aiService.getLatestInsight(req.params.id);
    return success(res, 200, 'Lead analysis fetched successfully', insight);
  } catch (err) {
    next(err);
  }
}

// GET /api/ai/insights
async function listInsights(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const data = await aiService.listInsights(req.user, { score: req.query.score, reviewed: req.query.reviewed, page, limit });
    return success(res, 200, 'AI insights fetched successfully', data);
  } catch (err) {
    next(err);
  }
}

// GET /api/ai/stats
async function getStats(req, res, next) {
  try {
    const stats = await aiService.getStats(req.user, { days: req.query.days });
    return success(res, 200, 'AI qualification stats fetched successfully', stats);
  } catch (err) {
    next(err);
  }
}

// POST /api/ai/lead/:id/review
async function reviewInsight(req, res, next) {
  try {
    await assertLeadAccess(req);
    const review = await aiService.reviewInsight(req.params.id, req.body, req.user);
    return success(res, 201, req.body.action === 'override' ? 'AI score overridden' : 'AI score confirmed', review);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listInsights,
  getStats,
  reviewInsight,
  leadSummary,
  leadScore,
  extractIntent,
  getAnalysis,
};
