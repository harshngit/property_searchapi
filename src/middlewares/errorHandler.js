const { error } = require('../utils/response');

function notFoundHandler(req, res, next) {
  error(res, 404, `Route not found: ${req.originalUrl}`);
}

function errorHandler(err, req, res, next) {
  // The database refuses an employee assignment on their own related-party transaction (sec. 33.12).
  if (err.code === 'P0403' && err.message === 'related_party_self_assignment') {
    return error(res, 403, 'This transaction involves the employee or their disclosed family, so it cannot be assigned to them. Choose another representative.');
  }
  console.error(err);
  // multer (file size/type) errors don't set statusCode - treat as 400s
  const statusCode = err.statusCode || (err.name === 'MulterError' ? 400 : 500);
  error(res, statusCode, err.message || 'Internal server error', err.errors || null);
}

module.exports = { notFoundHandler, errorHandler };
