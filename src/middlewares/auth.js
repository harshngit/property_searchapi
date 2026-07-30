const { verifyAccessToken } = require('../utils/jwt');
const { error } = require('../utils/response');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return error(res, 401, 'Access token is missing');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded; // { id, role, tenant_id }
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

module.exports = { authenticate, authorize };
