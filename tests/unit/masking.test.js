const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maskPhone, maskEmail } = require('../../src/utils/masking');

test('maskPhone - standard 10-digit mobile shows first 2 and last 2 (Controlled Contact Architecture sec. 11.2)', () => {
  assert.equal(maskPhone('9876543210'), '98XXXXXX10');
});

test('maskPhone - a number with a country code still shows the last-10-digit local part', () => {
  assert.equal(maskPhone('919876543210'), '98XXXXXX10');
  assert.equal(maskPhone('+91 98765 43210'), '98XXXXXX10');
});

test('maskPhone - too short to mask meaningfully returns the placeholder', () => {
  assert.equal(maskPhone('12'), 'XXXX');
});

test('maskPhone - falsy input (null/undefined/empty string) returns null, never throws', () => {
  assert.equal(maskPhone(null), null);
  assert.equal(maskPhone(undefined), null);
  assert.equal(maskPhone(''), null);
});

test('maskEmail - shows first letter and domain only', () => {
  assert.equal(maskEmail('rahul@example.com'), 'r*@example.com');
  assert.equal(maskEmail('a@test.co.in'), 'a*@test.co.in');
});

test('maskEmail - invalid input returns null', () => {
  assert.equal(maskEmail('not-an-email'), null);
  assert.equal(maskEmail(''), null);
  assert.equal(maskEmail(null), null);
});

test('maskPhone never leaks the full number for a real-looking test customer record', () => {
  const masked = maskPhone('9123456780');
  assert.ok(!masked.includes('123456'), 'the masked value must not contain the hidden middle digits');
});
