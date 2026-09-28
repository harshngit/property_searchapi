const bdLeadService = require('../services/bdLead.service');
const auditService = require('../services/audit.service');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

module.exports = {
  // POST /api/bd-leads (public)
  create: handler(async (req, res) => {
    const { lead, duplicate, resumeAttached } = await bdLeadService.createBdLead(req.body, req.file);
    return success(
      res,
      duplicate ? 200 : 201,
      resumeAttached === false
        ? "Thank you - we've received your application, but your resume couldn't be attached. Please try sending it again."
        : 'Thank you - our team will review your enquiry and get in touch',
      { ...lead, resumeAttached }
    );
  }),

  // GET /api/bd-leads
  list: handler(async (req, res) => {
    const data = await bdLeadService.listBdLeads(req.user, req.query);
    return success(res, 200, 'Enquiries fetched successfully', data);
  }),

  // GET /api/bd-leads/city-demand
  cityDemand: handler(async (req, res) => {
    const data = await bdLeadService.getCityDemand({ days: req.query.days });
    return success(res, 200, 'City demand fetched successfully', data);
  }),

  // GET /api/bd-leads/:id
  get: handler(async (req, res) => {
    const lead = await bdLeadService.getBdLeadForUser(req.params.id, req.user);
    return success(res, 200, 'Enquiry fetched successfully', lead);
  }),

  // PUT /api/bd-leads/:id/assign
  assign: handler(async (req, res) => {
    const lead = await bdLeadService.assignBdLead(
      req.params.id,
      req.body.assignedTo,
      req.body.notes,
      req.user,
      auditService.requestMeta(req)
    );
    return success(res, 200, 'Enquiry assigned successfully', lead);
  }),

  // PUT /api/bd-leads/:id/status
  updateStatus: handler(async (req, res) => {
    const lead = await bdLeadService.updateBdLeadStatus(
      req.params.id,
      req.body.status,
      req.body.notes,
      req.user,
      auditService.requestMeta(req)
    );
    return success(res, 200, 'Enquiry status updated successfully', lead);
  }),
};
