// Unit tests - pure functions only, no server, no database.
// Run standalone: node --test tests/unit/price.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePriceToNumber, formatInr } = require('../../src/utils/price');

test('parsePriceToNumber - crore and lakh units', () => {
  assert.equal(parsePriceToNumber('2.1 Cr'), 21000000);
  assert.equal(parsePriceToNumber('₹ 85 Lakh'), 8500000);
  assert.equal(parsePriceToNumber('Rs. 5,00,000'), 500000);
  assert.equal(parsePriceToNumber('1.5cr'), 15000000);
  assert.equal(parsePriceToNumber('50L'), 5000000);
  assert.equal(parsePriceToNumber('20k'), 20000);
});

test('parsePriceToNumber - plain numbers and no-unit text', () => {
  assert.equal(parsePriceToNumber(1000000), 1000000);
  assert.equal(parsePriceToNumber('1000000'), 1000000);
  assert.equal(parsePriceToNumber(-5), null, 'negative numbers are not a price');
});

test('parsePriceToNumber - "Price on Request" and junk return null', () => {
  assert.equal(parsePriceToNumber('Price on Request'), null);
  assert.equal(parsePriceToNumber(''), null);
  assert.equal(parsePriceToNumber(null), null);
  assert.equal(parsePriceToNumber(undefined), null);
  assert.equal(parsePriceToNumber('abc'), null);
});

test('formatInr - crore and lakh thresholds', () => {
  assert.equal(formatInr(21000000), '₹2.1 Cr');
  assert.equal(formatInr(10000000), '₹1 Cr');
  assert.equal(formatInr(8500000), '₹85 L');
  assert.equal(formatInr(100000), '₹1 L');
});

test('formatInr - below one lakh uses Indian digit grouping', () => {
  assert.equal(formatInr(85550), '₹85,550');
  assert.equal(formatInr(0), '₹0');
});

test('formatInr - invalid input returns null', () => {
  assert.equal(formatInr(null), null);
  assert.equal(formatInr(undefined), null);
  assert.equal(formatInr('not a number'), null);
});

test('parsePriceToNumber and formatInr round-trip for the invoice total used in production (₹59,000)', () => {
  const parsed = parsePriceToNumber('59000');
  assert.equal(parsed, 59000);
  assert.equal(formatInr(parsed), '₹59,000');
});
