const masterDataService = require('../services/masterData.service');
const configService = require('../services/config.service');
const auditService = require('../services/audit.service');
const { success } = require('../utils/response');
const { parseCsv } = require('../utils/csv');
const { badRequest } = require('../utils/httpError');

// GET /api/admin/master
async function listEntities(req, res, next) {
  try {
    return success(res, 200, 'Master data entities fetched successfully', masterDataService.listEntities());
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/master/:entity
async function listRecords(req, res, next) {
  try {
    const data = await masterDataService.list(req.params.entity, req.query);
    return success(res, 200, 'Records fetched successfully', data);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/master/:entity/:id
async function getRecord(req, res, next) {
  try {
    const row = await masterDataService.getById(req.params.entity, req.params.id);
    return success(res, 200, 'Record fetched successfully', row);
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/master/:entity
async function createRecord(req, res, next) {
  try {
    const row = await masterDataService.create(req.params.entity, req.body, req.user, auditService.requestMeta(req));
    return success(res, 201, 'Record created successfully', row);
  } catch (err) {
    next(err);
  }
}

// PUT /api/admin/master/:entity/:id
async function updateRecord(req, res, next) {
  try {
    const row = await masterDataService.update(req.params.entity, req.params.id, req.body, req.user, auditService.requestMeta(req));
    return success(res, 200, 'Record updated successfully', row);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/admin/master/:entity/:id
async function deleteRecord(req, res, next) {
  try {
    await masterDataService.remove(req.params.entity, req.params.id, req.user, auditService.requestMeta(req));
    return success(res, 200, 'Record deleted successfully');
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/master/:entity/import
// Accepts a multipart `file` (CSV), or JSON { csv: "..." } / { rows: [...] }.
async function importRecords(req, res, next) {
  try {
    let rows;
    if (req.file) rows = parseCsv(req.file.buffer.toString('utf8'));
    else if (typeof req.body.csv === 'string') rows = parseCsv(req.body.csv);
    else if (Array.isArray(req.body.rows)) rows = req.body.rows;
    else throw badRequest('Provide a CSV file (field "file"), a "csv" string, or a "rows" array');

    const dryRun = String(req.query.dryRun || req.body.dryRun || '').toLowerCase() === 'true';
    const result = await masterDataService.importRows(req.params.entity, rows, req.user, { dryRun }, auditService.requestMeta(req));
    return success(res, dryRun ? 200 : 201, dryRun ? 'Import validated - nothing saved (dry run)' : 'Import completed successfully', result);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/config
async function listConfig(req, res, next) {
  try {
    const rows = await configService.listConfig({ category: req.query.category });
    return success(res, 200, 'Configuration fetched successfully', rows);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/config/:key
async function getConfig(req, res, next) {
  try {
    const row = await configService.getConfigEntry(req.params.key);
    return success(res, 200, 'Configuration fetched successfully', row);
  } catch (err) {
    next(err);
  }
}

// PUT /api/admin/config/:key
async function updateConfig(req, res, next) {
  try {
    const row = await configService.updateConfig(
      req.params.key,
      req.body.value,
      { reason: req.body.reason },
      req.user,
      auditService.requestMeta(req)
    );
    return success(res, 200, 'Configuration updated successfully', row);
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/audit-logs
async function listAuditLogs(req, res, next) {
  try {
    const data = await auditService.listLogs(req.query);
    return success(res, 200, 'Audit logs fetched successfully', data);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listEntities,
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  importRecords,
  listConfig,
  getConfig,
  updateConfig,
  listAuditLogs,
};
