const brokerService = require('../services/broker.service');
const { success } = require('../utils/response');

// GET /api/broker/dashboard
async function getDashboard(req, res, next) {
  try {
    const dashboard = await brokerService.getDashboard(req.user);
    return success(res, 200, 'Dashboard fetched successfully', dashboard);
  } catch (err) {
    next(err);
  }
}

// GET /api/broker/leads
async function getLeads(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      status: req.query.status,
      source: req.query.source,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };

    const { items, pagination } = await brokerService.getBrokerLeads(req.user, filters, page, limit);
    return success(res, 200, 'Leads fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/broker/inventory
async function getInventory(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      city: req.query.city,
      propertyType: req.query.propertyType,
      transactionType: req.query.transactionType,
      status: req.query.status,
    };

    const { items, pagination } = await brokerService.getBrokerInventory(req.user, filters, page, limit);
    return success(res, 200, 'Inventory fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/broker/followups
async function getFollowups(req, res, next) {
  try {
    const followups = await brokerService.getBrokerFollowups(req.user);
    return success(res, 200, 'Follow-ups fetched successfully', followups);
  } catch (err) {
    next(err);
  }
}

// GET /api/broker/performance-report
async function getPerformanceReport(req, res, next) {
  try {
    const report = await brokerService.getPerformanceReport(req.user, {
      from: req.query.from,
      to: req.query.to,
    });
    return success(res, 200, 'Performance report fetched successfully', report);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getDashboard,
  getLeads,
  getInventory,
  getFollowups,
  getPerformanceReport,
};
