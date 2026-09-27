// Same page/limit clamping every existing list controller does inline
// (page >= 1, 1 <= limit <= 100, default 20), plus the matching response
// shape, so new modules return pagination identical to the old ones.
function parsePagination(query, defaultLimit = 20) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
}

function buildPagination(page, limit, total) {
  const count = Number(total);
  return { page, limit, total: count, totalPages: Math.ceil(count / limit) };
}

module.exports = { parsePagination, buildPagination };
