const matchingService = require('../services/matching.service');
const leadService = require('../services/lead.service');
const customerService = require('../services/customer.service');
const { success } = require('../utils/response');
const { assertTenantVisible } = require('../utils/ownership');

const LEAD_OWNER_FIELDS = ['created_by', 'assigned_to'];

// GET /api/matching/properties/:customerId
async function getMatchesForCustomer(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.customerId);
    assertTenantVisible(req.user, customer, 'Customer not found');

    const matches = await matchingService.getMatchesForCustomer(req.params.customerId);
    return success(res, 200, 'Property matches fetched successfully', matches);
  } catch (err) {
    next(err);
  }
}

// POST /api/matching/rerun
async function rerun(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.body.customerId);
    assertTenantVisible(req.user, customer, 'Customer not found');

    const matches = await matchingService.rerunForCustomer(req.body.customerId);
    return success(res, 200, 'Property matches re-run successfully', matches);
  } catch (err) {
    next(err);
  }
}

// GET /api/matching/recommendations/:leadId
async function getRecommendationsForLead(req, res, next) {
  try {
    const lead = await leadService.getLeadById(req.params.leadId);
    assertTenantVisible(req.user, lead, 'Lead not found', { ownerFields: LEAD_OWNER_FIELDS });

    const matches = await matchingService.getRecommendationsForLead(req.params.leadId);
    return success(res, 200, 'Property recommendations fetched successfully', matches);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getMatchesForCustomer,
  rerun,
  getRecommendationsForLead,
};
