// Shared error constructors for the service layer - errorHandler.js turns
// `statusCode` into the HTTP status, and `errors` into the response body's
// `errors` field (e.g. which content-guard rule a field failed).
function httpError(statusCode, message, errors = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (errors) err.errors = errors;
  return err;
}

const badRequest = (message, errors) => httpError(400, message, errors);
const forbidden = (message = 'You do not have permission to perform this action') => httpError(403, message);
const notFound = (message = 'Not found') => httpError(404, message);
const conflict = (message) => httpError(409, message);
const unprocessable = (message, errors) => httpError(422, message, errors);

module.exports = { httpError, badRequest, forbidden, notFound, conflict, unprocessable };
