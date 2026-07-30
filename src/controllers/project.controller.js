const projectService = require('../services/project.service');
const { success } = require('../utils/response');
const { assertOwnerOrAdmin, assertTenantVisible } = require('../utils/ownership');

// GET /api/projects
async function listProjects(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = { city: req.query.city, status: req.query.status };

    const { items, pagination } = await projectService.listProjects(req.user, filters, page, limit);
    return success(res, 200, 'Projects fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/projects/:id
async function getProject(req, res, next) {
  try {
    const project = await projectService.getProjectById(req.params.id);
    assertTenantVisible(req.user, project, 'Project not found');
    return success(res, 200, 'Project fetched successfully', project);
  } catch (err) {
    next(err);
  }
}

// POST /api/projects
async function createProject(req, res, next) {
  try {
    const project = await projectService.createProject(req.body, req.user);
    return success(res, 201, 'Project created successfully', project);
  } catch (err) {
    next(err);
  }
}

// PUT /api/projects/:id
async function updateProject(req, res, next) {
  try {
    const existing = await projectService.getProjectById(req.params.id);
    assertOwnerOrAdmin(req.user, existing);

    const project = await projectService.updateProject(req.params.id, req.body);
    return success(res, 200, 'Project updated successfully', project);
  } catch (err) {
    next(err);
  }
}

// GET /api/projects/:id/units
async function listUnits(req, res, next) {
  try {
    const project = await projectService.getProjectById(req.params.id);
    assertTenantVisible(req.user, project, 'Project not found');

    const units = await projectService.listUnits(req.params.id, { status: req.query.status });
    return success(res, 200, 'Units fetched successfully', units);
  } catch (err) {
    next(err);
  }
}

// POST /api/projects/:id/units
async function createUnit(req, res, next) {
  try {
    const project = await projectService.getProjectById(req.params.id);
    assertOwnerOrAdmin(req.user, project);

    const unit = await projectService.createUnit(req.params.id, req.body);
    return success(res, 201, 'Unit created successfully', unit);
  } catch (err) {
    next(err);
  }
}

// PUT /api/units/:id
async function updateUnit(req, res, next) {
  try {
    const existing = await projectService.getUnitWithProject(req.params.id);
    assertOwnerOrAdmin(req.user, existing);

    const unit = await projectService.updateUnit(req.params.id, req.body);
    return success(res, 200, 'Unit updated successfully', unit);
  } catch (err) {
    next(err);
  }
}

// PUT /api/units/:id/status
async function updateUnitStatus(req, res, next) {
  try {
    const existing = await projectService.getUnitWithProject(req.params.id);
    assertOwnerOrAdmin(req.user, existing);

    const unit = await projectService.updateUnitStatus(req.params.id, req.body.status);
    return success(res, 200, 'Unit status updated successfully', unit);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listProjects,
  getProject,
  createProject,
  updateProject,
  listUnits,
  createUnit,
  updateUnit,
  updateUnitStatus,
};
