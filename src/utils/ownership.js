const ADMIN_ROLES = ['admin', 'super_admin'];

function isAdmin(role) {
  return ADMIN_ROLES.includes(role);
}

/**
 * Throws a 403 error unless the acting user is an admin/super_admin, an
 * owner of the resource (matches one of `ownerFields`, e.g. created_by or
 * assigned_to), or (when allowed) a tenant-level manager role acting on a
 * resource that belongs to their own tenant.
 *
 * @param {object} user - req.user, expects { id, role, tenant_id }
 * @param {object} resource - must expose tenant_id and whichever ownerFields are checked
 * @param {object} [options]
 * @param {string[]} [options.allowTenantManagers] - roles (e.g. 'agency_admin')
 *        that may manage any resource within their own tenant_id, not just ones
 *        they own themselves.
 * @param {string[]} [options.ownerFields] - resource fields compared against
 *        user.id to determine ownership. Defaults to ['created_by'].
 */
function assertOwnerOrAdmin(user, resource, { allowTenantManagers = [], ownerFields = ['created_by'] } = {}) {
  if (isAdmin(user.role)) return;
  if (ownerFields.some((field) => resource[field] === user.id)) return;

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
 * the acting user is an admin/super_admin, owns the resource (matches one of
 * `ownerFields`), or belongs to the same tenant as the resource. Used to
 * enforce tenant isolation on single-record GETs.
 */
function assertTenantVisible(user, resource, notFoundMessage = 'Not found', { ownerFields = ['created_by'] } = {}) {
  if (isAdmin(user.role)) return;
  if (ownerFields.some((field) => resource[field] === user.id)) return;
  if (resource.tenant_id && user.tenant_id && resource.tenant_id === user.tenant_id) return;

  const err = new Error(notFoundMessage);
  err.statusCode = 404;
  throw err;
}

module.exports = { ADMIN_ROLES, isAdmin, assertOwnerOrAdmin, assertTenantVisible };
