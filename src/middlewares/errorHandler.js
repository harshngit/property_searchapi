const { error } = require('../utils/response');

function notFoundHandler(req, res, next) {
  error(res, 404, `Route not found: ${req.originalUrl}`);
}

function errorHandler(err, req, res, next) {
  console.error(err);
  const statusCode = err.statusCode || 500;
  error(res, statusCode, err.message || 'Internal server error');
}

module.exports = { notFoundHandler, errorHandler };
