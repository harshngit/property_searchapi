// Wraps an async controller so a thrown/rejected error reaches errorHandler
// via next(err) - the same effect as the try/catch every older controller
// writes out by hand.
function asyncHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = asyncHandler;
