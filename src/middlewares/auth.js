const { verifyAccessToken } = require('../utils/jwt');
const { error } = require('../utils/response');
const suspension = require('../utils/suspension');
const userBlock = require('../utils/userBlock');

// Sec. 14.7 Level 3 - Full Suspension: the franchisee's brokers are blocked
// until the overdue invoice is paid. The Franchisee Admin stays able to sign
// in and pay.
const SUSPENDED_ROLES = ['broker', 'agency_admin'];
const suspended = (user) => user && SUSPENDED_ROLES.includes(user.role) && suspension.levelOf(user.tenant_id) === 'level_3';
// Sec. 14.9 lead visibility hierarchy: a Franchisee Admin gets aggregate
// numbers only. The session can reach its own dashboard endpoints and the
// account basics - every other API (leads, customers, deals, inquiries,
// documents ...) answers 403 and the attempt is written to the audit log.
const FRANCHISEE_ALLOWED = /^\/api\/(auth|franchisee|branding|notifications|i18n|user|push)(\/|\?|$)/;
function franchiseeBlocked(req, user) {
  if (user.role !== 'franchisee_admin' || FRANCHISEE_ALLOWED.test(req.originalUrl || '')) return false;
  require('../services/audit.service')
    .log({ actor: user, action: 'security.cross_org_access_blocked', entityType: 'franchisee', entityId: null, after: { method: req.method, path: String(req.originalUrl || '').split('?')[0] }, ip: req.ip })
    .catch(() => {});
  return true;
}

// Level 2 - No New Leads: the same brokers cannot see new matches.
const matchesPaused = (user) => user && SUSPENDED_ROLES.includes(user.role) && suspension.levelOf(user.tenant_id) === 'level_2';

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return error(res, 401, 'Access token is missing');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded; // { id, role, tenant_id }
    // Section 35: a suspended or removed account is turned away at once, except for
    // signing out and the DPDP routes (download my data / ask for deletion).
    const blockedAs = userBlock.stateOf(decoded.id);
    if (blockedAs && !/^\/api\/(auth\/(logout|me)|user)(\/|\?|$)/.test(req.originalUrl || '')) {
      return error(res, 403, blockedAs === 'removed' ? 'This account has been removed from the platform.' : 'This account has been suspended. Reinstatement is at the discretion of the platform.');
    }
    if (suspended(decoded) && !/^\/api\/(auth|notifications)\b/.test(req.originalUrl || '')) {
      return error(res, 403, 'Service suspended due to non-payment by your franchise. Access returns as soon as the overdue invoice is paid.');
    }
    if (franchiseeBlocked(req, decoded)) {
      return error(res, 403, 'This area is not available to a franchisee account');
    }
    if (matchesPaused(decoded) && /^\/api\/matching\b/.test(req.originalUrl || '')) {
      return error(res, 403, 'New matches are paused: your franchise has an overdue invoice. They resume as soon as it is paid.');
    }
    next();
  } catch (err) {
    return error(res, 401, 'Invalid or expired access token');
  }
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return error(res, 403, 'You do not have permission to perform this action');
    }
    next();
  };
}

// Like authenticate, but never rejects the request - used by endpoints that
// are reachable both anonymously (e.g. customer/broker self-registration)
// and by an authenticated actor (e.g. an admin registering another admin).
// A missing or invalid token just leaves req.user null; it's up to the
// route's own logic to decide what's allowed without one.
function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    req.user = verifyAccessToken(token);
  } catch (err) {
    req.user = null;
  }

  next();
}

module.exports = { authenticate, authorize, optionalAuthenticate };
