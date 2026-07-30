const ADMIN_ROLES = ['admin', 'super_admin'];

function isAdmin(role) {
  return ADMIN_ROLES.includes(role);
}

/**
 * Throws a 403 error unless the acting user is an admin/super_admin, the
 * creator of the resource, or (when allowed) a tenant-level manager role
 * acting on a resource that belongs to their own tenant.
 *
 * @param {object} user - req.user, expects { id, role, tenant_id }
 * @param {object} resource - must expose created_by and tenant_id
 * @param {object} [options]
 * @param {string[]} [options.allowTenantManagers] - roles (e.g. 'agency_admin')
 *        that may manage any resource within their own tenant_id, not just ones
 *        they created themselves.
 */
function assertOwnerOrAdmin(user, resource, { allowTenantManagers = [] } = {}) {
  if (isAdmin(user.role)) return;
  if (resource.created_by === user.id) return;

  if (
    allowTenantManagers.includes(user.role) &&
    resource.tenant_id &&
    user.tenant_id &&
    resource.tenant_id === user.tenant_id
  ) {
    return;
  }

  const err = new Error('You do not have permission to perform this action on this resource');
  err.statusCode = 403;
  throw err;
}

/**
 * Throws a 404 (not 403, to avoid confirming existence to outsiders) unless
 * the acting user is an admin/super_admin, created the resource, or belongs
 * to the same tenant as the resource. Used to enforce tenant isolation on
 * single-record GETs.
 */
function assertTenantVisible(user, resource, notFoundMessage = 'Not found') {
  if (isAdmin(user.role)) return;
  if (resource.created_by === user.id) return;
  if (resource.tenant_id && user.tenant_id && resource.tenant_id === user.tenant_id) return;

  const err = new Error(notFoundMessage);
  err.statusCode = 404;
  throw err;
}

module.exports = { ADMIN_ROLES, isAdmin, assertOwnerOrAdmin, assertTenantVisible };
