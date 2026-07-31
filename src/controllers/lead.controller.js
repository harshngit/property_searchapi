const leadService = require('../services/lead.service');
const { success } = require('../utils/response');
const { assertOwnerOrAdmin, assertTenantVisible } = require('../utils/ownership');

const LEAD_OWNER_FIELDS = ['created_by', 'assigned_to'];

// GET /api/leads
async function listLeads(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      status: req.query.status,
      assignedTo: req.query.assignedTo,
      source: req.query.source,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };

    const { items, pagination } = await leadService.listLeads(req.user, filters, page, limit);
    return success(res, 200, 'Leads fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/leads/:id
async function getLead(req, res, next) {
  try {
    const lead = await leadService.getLeadById(req.params.id);
    assertTenantVisible(req.user, lead, 'Lead not found', { ownerFields: LEAD_OWNER_FIELDS });
    return success(res, 200, 'Lead fetched successfully', lead);
  } catch (err) {
    next(err);
  }
}

// POST /api/leads
async function createLead(req, res, next) {
  try {
    const lead = await leadService.createLead(req.body, req.user);
    return success(res, 201, 'Lead created successfully', lead);
  } catch (err) {
    next(err);
  }
}

// POST /api/leads/public-inquiry
async function createPublicInquiry(req, res, next) {
  try {
    const lead = await leadService.createPublicInquiry(req.body);
    return success(res, 201, 'Thank you, our team will get in touch with you shortly', lead);
  } catch (err) {
    next(err);
  }
}

// PUT /api/leads/:id
async function updateLead(req, res, next) {
  try {
    const existing = await leadService.getLeadById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: LEAD_OWNER_FIELDS,
    });

    const lead = await leadService.updateLead(req.params.id, req.body);
    return success(res, 200, 'Lead updated successfully', lead);
  } catch (err) {
    next(err);
  }
}

// PUT /api/leads/:id/assign
async function assignLead(req, res, next) {
  try {
    await leadService.getLeadById(req.params.id); // 404 if missing
    const lead = await leadService.assignLead(req.params.id, req.body.assignedTo, req.user);
    return success(res, 200, 'Lead assigned successfully', lead);
  } catch (err) {
    next(err);
  }
}

// PUT /api/leads/:id/status
async function updateStatus(req, res, next) {
  try {
    const existing = await leadService.getLeadById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: LEAD_OWNER_FIELDS,
    });

    const lead = await leadService.updateStatus(req.params.id, req.body.status, req.user);
    return success(res, 200, 'Lead status updated successfully', lead);
  } catch (err) {
    next(err);
  }
}

// POST /api/leads/:id/notes
async function addNote(req, res, next) {
  try {
    const existing = await leadService.getLeadById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: LEAD_OWNER_FIELDS,
    });

    const note = await leadService.addNote(req.params.id, req.body.note, req.user);
    return success(res, 201, 'Note added successfully', note);
  } catch (err) {
    next(err);
  }
}

// GET /api/leads/:id/timeline
async function getTimeline(req, res, next) {
  try {
    const lead = await leadService.getLeadById(req.params.id);
    assertTenantVisible(req.user, lead, 'Lead not found', { ownerFields: LEAD_OWNER_FIELDS });

    const timeline = await leadService.getTimeline(req.params.id);
    return success(res, 200, 'Lead timeline fetched successfully', timeline);
  } catch (err) {
    next(err);
  }
}

// GET /api/leads/:id/activity
async function getActivity(req, res, next) {
  try {
    const lead = await leadService.getLeadById(req.params.id);
    assertTenantVisible(req.user, lead, 'Lead not found', { ownerFields: LEAD_OWNER_FIELDS });

    const activity = await leadService.getActivity(req.params.id);
    return success(res, 200, 'Lead activity fetched successfully', activity);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listLeads,
  getLead,
  createLead,
  createPublicInquiry,
  updateLead,
  assignLead,
  updateStatus,
  addNote,
  getTimeline,
  getActivity,
};
