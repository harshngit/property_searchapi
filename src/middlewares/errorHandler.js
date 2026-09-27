const { error } = require('../utils/response');

function notFoundHandler(req, res, next) {
  error(res, 404, `Route not found: ${req.originalUrl}`);
}

function errorHandler(err, req, res, next) {
  console.error(err);
  // multer (file size/type) errors don't set statusCode - treat as 400s
  const statusCode = err.statusCode || (err.name === 'MulterError' ? 400 : 500);
  error(res, statusCode, err.message || 'Internal server error', err.errors || null);
}

module.exports = { notFoundHandler, errorHandler };
