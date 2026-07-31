// Pure aggregation layer over leads/properties/tasks - deliberately holds
// no pool.query() calls of its own for data already owned by another
// service. Every function here either composes existing list functions or
// calls a small aggregate helper that lives in the service owning that
// table (lead.service.js / property.service.js / task.service.js).
const leadService = require('./lead.service');
const propertyService = require('./property.service');
const taskService = require('./task.service');

async function getDashboard(user) {
  const [leadsByStatus, taskCounts, inventory] = await Promise.all([
    leadService.getStatusCounts(user.id),
    taskService.getDashboardCounts(user.id),
    propertyService.listProperties(user, { brokerId: user.id }, 1, 1),
  ]);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const leadsWonThisMonth = await leadService.getWonCount(user.id, { from: monthStart });

  return {
    leadsByStatus,
    tasksDueToday: taskCounts.tasksDueToday,
    overdueTasksCount: taskCounts.overdueTasksCount,
    propertiesListedCount: inventory.pagination.total,
    leadsWonThisMonth,
  };
}

async function getBrokerLeads(user, filters, page, limit) {
  return leadService.listLeads(user, { ...filters, assignedTo: user.id }, page, limit);
}

async function getBrokerInventory(user, filters, page, limit) {
  return propertyService.listProperties(user, { ...filters, brokerId: user.id }, page, limit);
}

async function getBrokerFollowups(user) {
  return taskService.getBrokerFollowups(user.id);
}

async function getPerformanceReport(user, { from, to } = {}) {
  return leadService.getConversionStats(user.id, { from, to });
}

module.exports = {
  getDashboard,
  getBrokerLeads,
  getBrokerInventory,
  getBrokerFollowups,
  getPerformanceReport,
};
