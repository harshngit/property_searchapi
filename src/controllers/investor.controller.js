const investorService = require('../services/investor.service');
const nriService = require('../services/nri.service');
const hniService = require('../services/hni.service');
const toolsService = require('../services/tools.service');
const auditService = require('../services/audit.service');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

// One controller for the Engine 3 surface (investor profiles, NRI, HNI)
// plus the public investment calculators - all thin wrappers over services.

const investors = {
  getMe: handler(async (req, res) => {
    const profile = await investorService.getProfileByUserId(req.user.id);
    return success(res, 200, profile ? 'Investor profile fetched successfully' : 'No investor profile yet', profile);
  }),
  upsertMe: handler(async (req, res) => {
    const profile = await investorService.upsertMyProfile(req.body, req.user);
    return success(res, 200, 'Investor profile saved successfully', profile);
  }),
  list: handler(async (req, res) => {
    const data = await investorService.listProfiles(req.query);
    return success(res, 200, 'Investor profiles fetched successfully', data);
  }),
  get: handler(async (req, res) => {
    const profile = await investorService.getProfileById(req.params.id);
    investorService.assertProfileAccess(profile, req.user);
    return success(res, 200, 'Investor profile fetched successfully', profile);
  }),
  verify: handler(async (req, res) => {
    const profile = await investorService.verifyProfile(req.params.id, req.body, req.user, auditService.requestMeta(req));
    return success(res, 200, 'Verification status updated', profile);
  }),
  assignManager: handler(async (req, res) => {
    const profile = await investorService.assignManager(req.params.id, req.body.managerId, req.user, auditService.requestMeta(req));
    return success(res, 200, 'Manager assigned successfully', profile);
  }),
  behaviour: handler(async (req, res) => {
    const profile = await investorService.getProfileById(req.params.id);
    investorService.assertProfileAccess(profile, req.user);
    const data = await investorService.getBehaviour(req.params.id, { days: req.query.days });
    return success(res, 200, 'Investor behaviour fetched successfully', data);
  }),
};

const nri = {
  dashboard: handler(async (req, res) => {
    const data = await nriService.getDashboard(req.user, req.query.investorId);
    return success(res, 200, 'NRI dashboard fetched successfully', data);
  }),
  listProperties: handler(async (req, res) => {
    const data = await nriService.listProperties(req.user, req.query.investorId);
    return success(res, 200, 'NRI properties fetched successfully', data);
  }),
  createProperty: handler(async (req, res) => {
    const data = await nriService.createProperty(req.body, req.user);
    return success(res, 201, 'Property added successfully', data);
  }),
  getProperty: handler(async (req, res) => {
    const data = await nriService.getProperty(req.params.id, req.user);
    return success(res, 200, 'Property fetched successfully', data);
  }),
  updateProperty: handler(async (req, res) => {
    const data = await nriService.updateProperty(req.params.id, req.body, req.user);
    return success(res, 200, 'Property updated successfully', data);
  }),
  deleteProperty: handler(async (req, res) => {
    await nriService.deleteProperty(req.params.id, req.user);
    return success(res, 200, 'Property removed successfully');
  }),
  listRent: handler(async (req, res) => {
    const data = await nriService.listRent(req.params.id, req.user);
    return success(res, 200, 'Rent records fetched successfully', data);
  }),
  recordRent: handler(async (req, res) => {
    const data = await nriService.recordRent(req.params.id, req.body, req.user);
    return success(res, 200, 'Rent recorded successfully', data);
  }),
  listRequests: handler(async (req, res) => {
    const data = await nriService.listRequests(req.user, req.query);
    return success(res, 200, 'Service requests fetched successfully', data);
  }),
  createRequest: handler(async (req, res) => {
    const data = await nriService.createRequest(req.body, req.user);
    return success(res, 201, 'Service request raised successfully', data);
  }),
  getRequest: handler(async (req, res) => {
    const data = await nriService.getRequest(req.params.id, req.user);
    return success(res, 200, 'Service request fetched successfully', data);
  }),
  addUpdate: handler(async (req, res) => {
    const data = await nriService.addUpdate(req.params.id, req.body, req.user);
    return success(res, 201, 'Update added successfully', data);
  }),
  updateStatus: handler(async (req, res) => {
    const data = await nriService.updateRequestStatus(req.params.id, req.body, req.user);
    return success(res, 200, 'Status updated successfully', data);
  }),
  assignRequest: handler(async (req, res) => {
    const data = await nriService.assignRequest(req.params.id, req.body.managerId, req.user);
    return success(res, 200, 'Request assigned successfully', data);
  }),
  listRepatriation: handler(async (req, res) => {
    const data = await nriService.listRepatriation(req.user, req.query.investorId, req.query.financialYear);
    return success(res, 200, 'Repatriation records fetched successfully', data);
  }),
  createRepatriation: handler(async (req, res) => {
    const data = await nriService.createRepatriation(req.body, req.user);
    return success(res, 201, 'Repatriation recorded successfully', data);
  }),
  updateRepatriation: handler(async (req, res) => {
    const data = await nriService.updateRepatriation(req.params.id, req.body, req.user);
    return success(res, 200, 'Repatriation updated successfully', data);
  }),
  tdsOnSale: handler(async (req, res) => {
    const data = await nriService.estimateTdsOnSale(req.body);
    return success(res, 200, 'Indicative TDS calculated', data);
  }),
  rentTds: handler(async (req, res) => {
    const data = await nriService.estimateRentTds(req.body);
    return success(res, 200, 'Indicative rent TDS calculated', data);
  }),
  fema: handler(async (req, res) => {
    const data = await nriService.getFemaGuidance();
    return success(res, 200, 'FEMA guidance fetched successfully', data);
  }),
};

const hni = {
  dashboard: handler(async (req, res) => {
    const data = await hniService.getDashboard(req.user, req.query.investorId);
    return success(res, 200, 'HNI dashboard fetched successfully', data);
  }),
  deals: handler(async (req, res) => {
    const data = await hniService.getCuratedDeals(req.user, req.query);
    return success(res, 200, 'Curated deals fetched successfully', data);
  }),
  trackDeal: handler(async (req, res) => {
    const data = await hniService.trackDeal(req.params.propertyId, req.body.action, req.user);
    return success(res, 201, 'Recorded', data);
  }),
  shortlist: handler(async (req, res) => {
    const data = await hniService.getShortlist(req.user);
    return success(res, 200, 'Shortlist fetched successfully', data);
  }),
  listPortfolio: handler(async (req, res) => {
    const data = await hniService.listPortfolio(req.user, req.query);
    return success(res, 200, 'Portfolio fetched successfully', data);
  }),
  summary: handler(async (req, res) => {
    const data = await hniService.getPortfolioSummary(req.user, req.query.investorId);
    return success(res, 200, 'Portfolio summary fetched successfully', data);
  }),
  createInvestment: handler(async (req, res) => {
    const data = await hniService.createInvestment(req.body, req.user);
    return success(res, 201, 'Investment added successfully', data);
  }),
  getInvestment: handler(async (req, res) => {
    const data = await hniService.getInvestment(req.params.id, req.user);
    return success(res, 200, 'Investment fetched successfully', data);
  }),
  updateInvestment: handler(async (req, res) => {
    const data = await hniService.updateInvestment(req.params.id, req.body, req.user);
    return success(res, 200, 'Investment updated successfully', data);
  }),
  deleteInvestment: handler(async (req, res) => {
    await hniService.deleteInvestment(req.params.id, req.user);
    return success(res, 200, 'Investment removed successfully');
  }),
};

const tools = {
  roi: handler(async (req, res) => success(res, 200, 'Indicative ROI calculated', await toolsService.roi(req.body))),
  rentalYield: handler(async (req, res) => success(res, 200, 'Indicative rental yield calculated', await toolsService.rentalYield(req.body))),
  appreciation: handler(async (req, res) =>
    success(res, 200, 'Indicative appreciation projected', await toolsService.appreciationProjection(req.body))
  ),
  liquidity: handler(async (req, res) => success(res, 200, 'Liquidity score calculated', await toolsService.liquidityScore(req.query))),
};

module.exports = { investors, nri, hni, tools };
