const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePagination, buildPagination } = require('../../src/utils/pagination');

test('parsePagination - defaults to page 1, limit 20 with no query', () => {
  assert.deepEqual(parsePagination({}), { page: 1, limit: 20, offset: 0 });
});

test('parsePagination - respects a custom default limit', () => {
  assert.deepEqual(parsePagination({}, 50), { page: 1, limit: 50, offset: 0 });
});

test('parsePagination - page/limit from the query, with correct offset', () => {
  assert.deepEqual(parsePagination({ page: '3', limit: '10' }), { page: 3, limit: 10, offset: 20 });
});

test('parsePagination - page is clamped to at least 1 (never negative or zero)', () => {
  assert.equal(parsePagination({ page: '0' }).page, 1);
  assert.equal(parsePagination({ page: '-5' }).page, 1);
});

test('parsePagination - limit of "0" is treated as not given, falling back to the default (0 is falsy)', () => {
  assert.equal(parsePagination({ limit: '0' }, 20).limit, 20);
});

test('parsePagination - limit is clamped between 1 and 100', () => {
  assert.equal(parsePagination({ limit: '500' }).limit, 100);
  assert.equal(parsePagination({ limit: '-10' }).limit, 1);
});

test('parsePagination - non-numeric input falls back to the default instead of NaN', () => {
  const result = parsePagination({ page: 'abc', limit: 'xyz' });
  assert.equal(Number.isNaN(result.page), false);
  assert.equal(Number.isNaN(result.limit), false);
  assert.equal(result.page, 1);
  assert.equal(result.limit, 20);
});

test('buildPagination - computes totalPages correctly, including a partial last page', () => {
  assert.deepEqual(buildPagination(1, 20, 45), { page: 1, limit: 20, total: 45, totalPages: 3 });
  assert.deepEqual(buildPagination(2, 10, 20), { page: 2, limit: 10, total: 20, totalPages: 2 });
});

test('buildPagination - zero results is one page of zero, not division by zero garbage', () => {
  const result = buildPagination(1, 20, 0);
  assert.equal(result.totalPages, 0);
});
