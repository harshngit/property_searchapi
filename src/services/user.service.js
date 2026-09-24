const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { isAdmin, assertOwnerOrAdmin } = require('../utils/ownership');
const { deleteObject, getReadUrl, signUrls } = require('../utils/storage');

const USER_COLUMNS = `u.id, u.tenant_id, t.name AS tenant_name, u.full_name, u.email, u.mobile, u.status,
    u.email_verified, u.mobile_verified, u.profile_picture_url, u.signup_source,
    u.builder_rating, u.builder_experience_years, u.builder_projects_count,
    u.last_login_at, u.created_at, u.updated_at, r.name AS role_name`;
const USER_JOINS = `JOIN roles r ON r.id = u.role_id LEFT JOIN tenants t ON t.id = u.tenant_id`;

// super_admin can move a user to any role; admin is limited to the
// non-admin-tier roles, mirroring auth.service's ROLE_CREATION_PERMISSIONS.
const ROLE_CHANGE_PERMISSIONS = {
  super_admin: ['customer', 'broker', 'agency_admin', 'builder', 'internal_sales', 'admin', 'super_admin'],
  admin: ['customer', 'broker', 'agency_admin', 'builder', 'internal_sales'],
};

function notFound(message = 'User not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function forbidden(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

// Raw fetch, no URL signing - used internally wherever the *stored* value of
// profile_picture_url is needed (permission checks, or deleting the old
// picture by its stored object path/URL). Signing here would corrupt that
// value for anything downstream that isn't an HTTP response.
async function fetchUserRow(actingUser, id) {
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users u ${USER_JOINS} WHERE u.id = $1`,
    [id]
  );
  const user = result.rows[0];
  if (!user) throw notFound();

  assertOwnerOrAdmin(actingUser, user, { allowTenantManagers: ['agency_admin'], ownerFields: ['id'] });
  return user;
}

// Public/exported version - this one's result always ends up as an API
// response, so profile_picture_url is resolved to a fresh signed URL.
async function getUserById(actingUser, id) {
  const user = await fetchUserRow(actingUser, id);
  user.profile_picture_url = await getReadUrl(user.profile_picture_url);
  return user;
}

async function listUsers(actingUser, filters, page, limit) {
  const where = [];
  const params = [];

  if (!isAdmin(actingUser.role)) {
    // agency_admin (the only other role permitted to reach this endpoint,
    // enforced at the route level) is scoped to their own tenant
    params.push(actingUser.tenant_id);
    where.push(`u.tenant_id = $${params.length}`);
  } else if (filters.tenantId) {
    params.push(filters.tenantId);
    where.push(`u.tenant_id = $${params.length}`);
  }

  if (filters.role) {
    params.push(filters.role);
    where.push(`r.name = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`u.status = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.mobile ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id ${whereSql}`,
    params
  );
  const total = Number(countResult.rows[0].count);

  const offset = (page - 1) * limit;
  const result = await pool.query(
    `SELECT ${USER_COLUMNS}
     FROM users u ${USER_JOINS}
     ${whereSql}
     ORDER BY u.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    items: await signUrls(result.rows, 'profile_picture_url'),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
}

// Shared by the admin "edit user" endpoint and the self-service "edit my
// profile" endpoint - `allowedFields` controls which columns each may touch.
async function applyProfileUpdate(id, updates, allowedFields) {
  const columnMap = {
    fullName: 'full_name',
    email: 'email',
    mobile: 'mobile',
    status: 'status',
    tenantId: 'tenant_id',
    builderRating: 'builder_rating',
    builderExperienceYears: 'builder_experience_years',
    builderProjectsCount: 'builder_projects_count',
  };
  const set = [];
  const params = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      params.push(updates[field]);
      set.push(`${columnMap[field]} = $${params.length}`);
    }
  }
  if (set.length === 0) throw badRequest('No valid fields to update');

  params.push(id);
  const result = await pool.query(
    `UPDATE users SET ${set.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (result.rows.length === 0) throw notFound();
}

async function updateUser(actingUser, id, updates) {
  await fetchUserRow(actingUser, id);
  await applyProfileUpdate(id, updates, [
    'fullName',
    'email',
    'mobile',
    'status',
    'tenantId',
    'builderRating',
    'builderExperienceYears',
    'builderProjectsCount',
  ]);
  return getUserById(actingUser, id);
}

async function updateOwnProfile(userId, updates) {
  await applyProfileUpdate(userId, updates, ['fullName', 'email', 'mobile']);
  const result = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users u ${USER_JOINS} WHERE u.id = $1`,
    [userId]
  );
  return signUrls(result.rows[0], 'profile_picture_url');
}

async function changeRole(actingUser, id, newRole) {
  const target = await fetchUserRow(actingUser, id);

  const allowedRoles = ROLE_CHANGE_PERMISSIONS[actingUser.role] || [];
  if (!allowedRoles.includes(newRole)) {
    throw forbidden(`Your role (${actingUser.role}) is not permitted to assign the '${newRole}' role`);
  }

  const roleResult = await pool.query('SELECT id FROM roles WHERE name = $1', [newRole]);
  if (!roleResult.rows[0]) throw badRequest('Invalid role specified');

  await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [roleResult.rows[0].id, id]);
  return signUrls({ ...target, role_name: newRole }, 'profile_picture_url');
}

// Admin-initiated password reset - no knowledge of the current password
// required. Revokes existing sessions so the old password stops working
// immediately everywhere.
async function adminSetPassword(actingUser, id, newPassword) {
  await fetchUserRow(actingUser, id);

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
  await pool.query('UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1', [id]);
}

async function deleteUser(actingUser, id) {
  if (actingUser.id === id) throw badRequest('You cannot delete your own account');

  // Raw (unsigned) on purpose - deleteObject() needs the actual stored
  // object path/URL, not a signed one.
  const target = await fetchUserRow(actingUser, id);

  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  } catch (err) {
    if (err.code === '23503') {
      throw badRequest('Cannot delete this user - other records (properties, leads, deals, etc.) still reference them');
    }
    throw err;
  }

  if (target.profile_picture_url) {
    await deleteObject(target.profile_picture_url);
  }
}

module.exports = {
  listUsers,
  getUserById,
  updateUser,
  updateOwnProfile,
  changeRole,
  adminSetPassword,
  deleteUser,
};
