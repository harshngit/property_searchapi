const { validationResult } = require('express-validator');
const { error } = require('../utils/response');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, 422, 'Validation failed', errors.array());
  }
  next();
}

module.exports = validate;
