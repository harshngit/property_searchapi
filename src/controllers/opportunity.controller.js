const opportunityService = require('../services/opportunity.service');
const auditService = require('../services/audit.service');
const { success } = require('../utils/response');
const { parseCsv } = require('../utils/csv');
const { badRequest } = require('../utils/httpError');
const handler = require('../utils/asyncHandler');

module.exports = {
  // GET /api/opportunities/public
  listPublic: handler(async (req, res) => {
    const data = await opportunityService.listPublicTeasers(req.query, req.user);
    return success(res, 200, 'Opportunities fetched successfully', data);
  }),

  // GET /api/opportunities
  list: handler(async (req, res) => {
    const data = await opportunityService.listForInvestor(req.query, req.user);
    return success(res, 200, 'Opportunities fetched successfully', data);
  }),

  // GET /api/opportunities/summary
  summary: handler(async (req, res) => {
    const data = await opportunityService.getSummary();
    return success(res, 200, 'Opportunity summary fetched successfully', data);
  }),

  // GET /api/opportunities/access
  access: handler(async (req, res) => {
    const access = await opportunityService.getAccess(req.user);
    return success(res, 200, 'Access fetched successfully', {
      full: access.full,
      reason: access.full ? null : access.reason,
      investorProfileStatus: access.profile?.verification_status || null,
    });
  }),

  // GET /api/opportunities/:id
  get: handler(async (req, res) => {
    const data = await opportunityService.getOpportunity(req.params.id, req.user);
    return success(res, 200, 'Opportunity fetched successfully', data);
  }),

  // POST /api/opportunities/:id/interest
  expressInterest: handler(async (req, res) => {
    const { interest, created } = await opportunityService.expressInterest(req.params.id, req.body, req.user);
    return success(
      res,
      created ? 201 : 200,
      created ? 'Interest registered - your A R Buildwel representative will contact you' : 'You have already expressed interest in this deal',
      interest
    );
  }),

  // POST /api/opportunities/:id/rescore
  rescore: handler(async (req, res) => {
    const data = await opportunityService.rescore(req.params.id);
    return success(res, 200, 'Opportunity rescored successfully', data);
  }),

  // POST /api/opportunities/:id/send-alerts
  sendAlerts: handler(async (req, res) => {
    const data = await opportunityService.sendAlerts(req.params.id);
    return success(res, 200, `${data.sent} alert(s) sent`, data);
  }),

  // GET /api/opportunities/interests
  listInterests: handler(async (req, res) => {
    const data = await opportunityService.listInterests(req.query, req.user);
    return success(res, 200, 'Interests fetched successfully', data);
  }),

  // GET /api/opportunities/interests/:id
  getInterest: handler(async (req, res) => {
    const data = await opportunityService.getInterestForUser(req.params.id, req.user);
    return success(res, 200, 'Interest fetched successfully', data);
  }),

  // PUT /api/opportunities/interests/:id/stage
  updateStage: handler(async (req, res) => {
    const data = await opportunityService.updateInterestStage(req.params.id, req.body.stage, req.body.notes, req.user);
    return success(res, 200, 'Stage updated successfully', data);
  }),

  // PUT /api/opportunities/interests/:id/assign
  assignInterest: handler(async (req, res) => {
    const data = await opportunityService.assignInterest(req.params.id, req.body.assignedTo, req.user, auditService.requestMeta(req));
    return success(res, 200, 'Interest assigned successfully', data);
  }),

  // POST /api/opportunities/ingest
  ingest: handler(async (req, res) => {
    const data = await opportunityService.ingestItems(
      req.body.items,
      {
        sourceName: req.body.sourceName,
        dataSource: req.user ? 'api' : 'crawler',
        defaultCategory: req.body.listingCategory || 'auction',
      },
      req.user
    );
    return success(res, 201, 'Ingestion completed', data);
  }),

  // POST /api/opportunities/ingest/csv
  ingestCsv: handler(async (req, res) => {
    const text = req.file ? req.file.buffer.toString('utf8') : req.body.csv;
    if (!text) throw badRequest('Provide a CSV file (field "file") or a "csv" string');
    const rows = parseCsv(text);
    const sourceName = req.body.sourceName || `csv_upload${req.file ? `:${req.file.originalname}` : ''}`;
    const data = await opportunityService.ingestItems(
      rows,
      { sourceName, dataSource: 'csv_import', defaultCategory: req.body.listingCategory || 'auction' },
      req.user
    );
    return success(res, 201, 'CSV ingestion completed', data);
  }),

  // GET /api/opportunities/ingest/queue
  listQueue: handler(async (req, res) => {
    const data = await opportunityService.listQueue(req.query);
    return success(res, 200, 'Ingestion queue fetched successfully', data);
  }),

  // GET /api/opportunities/ingest/:id
  getQueueItem: handler(async (req, res) => {
    const data = await opportunityService.getQueueItem(req.params.id);
    return success(res, 200, 'Ingestion item fetched successfully', data);
  }),

  // POST /api/opportunities/ingest/:id/publish
  publish: handler(async (req, res) => {
    const property = await opportunityService.publishItem(req.params.id, req.body || {}, req.user);
    return success(res, 201, 'Opportunity published successfully', property);
  }),

  // POST /api/opportunities/ingest/:id/reject
  reject: handler(async (req, res) => {
    const data = await opportunityService.rejectItem(req.params.id, req.body.notes, req.user);
    return success(res, 200, 'Ingestion item rejected', data);
  }),
};
