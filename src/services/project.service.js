const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Projects don't have a created_by column (only builder_id) - map it onto
// the shape assertOwnerOrAdmin/assertTenantVisible expect (created_by).
function withOwnerShape(project) {
  if (!project) return project;
  return { ...project, created_by: project.builder_id };
}

function applyTenantScope(user, where, params) {
  if (isAdmin(user.role)) return;
  params.push(user.tenant_id || null, user.id);
  where.push(`(p.tenant_id = $${params.length - 1} OR p.builder_id = $${params.length})`);
}

async function listProjects(user, filters, page, limit) {
  const where = [];
  const params = [];

  applyTenantScope(user, where, params);

  if (filters.city) {
    params.push(filters.city);
    where.push(`p.city ILIKE $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`p.status = $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM projects p ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT p.* FROM projects p
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows.map(withOwnerShape),
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

async function getProjectById(id) {
  const result = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  const project = result.rows[0];
  if (!project) throw notFound('Project not found');
  return withOwnerShape(project);
}

async function createProject(data, user) {
  const { name, description, city, locality, address, builderId } = data;

  const resolvedBuilderId = builderId || (user.role === 'builder' ? user.id : null);
  if (!resolvedBuilderId) {
    throw badRequest('builderId is required when creating a project as admin/super_admin');
  }

  const result = await pool.query(
    `INSERT INTO projects (tenant_id, builder_id, name, description, city, locality, address, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
     RETURNING *`,
    [
      user.tenant_id || null,
      resolvedBuilderId,
      name,
      description || null,
      city,
      locality || null,
      address || null,
    ]
  );

  return withOwnerShape(result.rows[0]);
}

const UPDATABLE_PROJECT_FIELDS = {
  name: 'name',
  description: 'description',
  city: 'city',
  locality: 'locality',
  address: 'address',
  status: 'status',
};

async function updateProject(id, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_PROJECT_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE projects SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return withOwnerShape(result.rows[0]);
}

async function listUnits(projectId, filters) {
  const where = ['project_id = $1'];
  const params = [projectId];

  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT * FROM units WHERE ${where.join(' AND ')} ORDER BY unit_number ASC`,
    params
  );
  return result.rows;
}

async function createUnit(projectId, data) {
  const { unitNumber, floor, size, price } = data;

  const existing = await pool.query(
    'SELECT id FROM units WHERE project_id = $1 AND unit_number = $2',
    [projectId, unitNumber]
  );
  if (existing.rows.length > 0) {
    const err = new Error('A unit with this unit number already exists in this project');
    err.statusCode = 409;
    throw err;
  }

  const result = await pool.query(
    `INSERT INTO units (project_id, unit_number, floor, size, price, status)
     VALUES ($1, $2, $3, $4, $5, 'available')
     RETURNING *`,
    [projectId, unitNumber, floor || null, size || null, price]
  );

  return result.rows[0];
}

// Fetches a unit along with its parent project's ownership fields, so
// callers can run ownership/tenant checks without a second round trip.
async function getUnitWithProject(unitId) {
  const result = await pool.query(
    `SELECT u.*, p.builder_id AS project_builder_id, p.tenant_id AS project_tenant_id
     FROM units u
     JOIN projects p ON p.id = u.project_id
     WHERE u.id = $1`,
    [unitId]
  );
  const unit = result.rows[0];
  if (!unit) throw notFound('Unit not found');

  return {
    ...unit,
    created_by: unit.project_builder_id,
    tenant_id: unit.project_tenant_id,
  };
}

const UPDATABLE_UNIT_FIELDS = {
  unitNumber: 'unit_number',
  floor: 'floor',
  size: 'size',
  price: 'price',
};

async function updateUnit(id, data) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_UNIT_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE units SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );

  return result.rows[0];
}

async function updateUnitStatus(id, status) {
  const result = await pool.query(
    'UPDATE units SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  return result.rows[0];
}

module.exports = {
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  listUnits,
  createUnit,
  getUnitWithProject,
  updateUnit,
  updateUnitStatus,
};
