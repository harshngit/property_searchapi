const { test } = require('node:test');
const assert = require('node:assert/strict');
const { httpError, badRequest, forbidden, notFound, conflict, unprocessable } = require('../../src/utils/httpError');

test('httpError - sets statusCode and message on a real Error instance', () => {
  const err = httpError(418, "I'm a teapot");
  assert.ok(err instanceof Error);
  assert.equal(err.statusCode, 418);
  assert.equal(err.message, "I'm a teapot");
});

test('httpError - attaches errors only when given (never an empty array/object by default)', () => {
  assert.equal(httpError(400, 'bad').errors, undefined);
  assert.deepEqual(httpError(400, 'bad', [{ field: 'x' }]).errors, [{ field: 'x' }]);
});

test('badRequest / notFound / conflict - correct status codes', () => {
  assert.equal(badRequest('bad').statusCode, 400);
  assert.equal(notFound().statusCode, 404);
  assert.equal(conflict('dup').statusCode, 409);
});

test('forbidden - has a sensible default message when none is given', () => {
  const err = forbidden();
  assert.equal(err.statusCode, 403);
  assert.match(err.message, /permission/i);
});

test('notFound - has a sensible default message', () => {
  assert.equal(notFound().message, 'Not found');
});

test('unprocessable - carries validation errors (content-guard violations, field errors, etc.)', () => {
  const violations = [{ field: 'title', rule: 'forbidden_term', match: 'guaranteed returns' }];
  const err = unprocessable('Content failed validation', violations);
  assert.equal(err.statusCode, 422);
  assert.deepEqual(err.errors, violations);
});
