const reportService = require('../services/report.service');
const { success, error } = require('../utils/response');
const { toCsv, flattenToRows } = require('../utils/csv');

function getFilters(req) {
  return { from: req.query.from, to: req.query.to };
}

// Brokers are only ever allowed to see their own numbers on the brokers
// report - force brokerId to themselves regardless of what's in the query.
function resolveBrokerId(req) {
  if (req.user.role === 'broker') return req.user.id;
  return req.query.brokerId;
}

// GET /api/reports/leads
async function getLeadsReport(req, res, next) {
  try {
    const report = await reportService.getLeadsReport(req.user, getFilters(req));
    return success(res, 200, 'Leads report generated successfully', report);
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/properties
async function getPropertiesReport(req, res, next) {
  try {
    const report = await reportService.getPropertiesReport(req.user, getFilters(req));
    return success(res, 200, 'Properties report generated successfully', report);
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/brokers
async function getBrokersReport(req, res, next) {
  try {
    const report = await reportService.getBrokersReport(req.user, getFilters(req), resolveBrokerId(req));
    return success(res, 200, 'Brokers report generated successfully', report);
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/conversion
async function getConversionFunnel(req, res, next) {
  try {
    const report = await reportService.getConversionFunnel(req.user, getFilters(req));
    return success(res, 200, 'Conversion funnel generated successfully', report);
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/payments
async function getPaymentsReport(req, res, next) {
  try {
    const report = await reportService.getPaymentsReport(req.user, getFilters(req));
    return success(res, 200, 'Payments report generated successfully', report);
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/revenue
async function getRevenueReport(req, res, next) {
  try {
    const report = await reportService.getRevenueReport(req.user, getFilters(req));
    return success(res, 200, 'Revenue report generated successfully', report);
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/export
// The one JSON-envelope exception in this module: streams a CSV file
// instead of a success()/error() body.
async function exportReport(req, res, next) {
  try {
    const reportType = req.query.report;

    if (req.user.role === 'broker' && reportType !== 'brokers') {
      return error(res, 403, 'Brokers may only export the "brokers" report');
    }

    const report = await reportService.getReportData(
      reportType,
      req.user,
      getFilters(req),
      resolveBrokerId(req)
    );

    const rows = [['metric', 'value'], ...flattenToRows(report)];
    const csv = toCsv(rows);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${reportType}-report.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getLeadsReport,
  getPropertiesReport,
  getBrokersReport,
  getConversionFunnel,
  getPaymentsReport,
  getRevenueReport,
  exportReport,
};
