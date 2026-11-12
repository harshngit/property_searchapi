// whatsapp.service.js's module.exports also pulls in pool/metaWhatsappService/
// customerService, but `pg`'s Pool connects lazily - requiring this file
// never opens a real connection as long as we only call the pure helpers below.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBudget, toLocalMobile, toInternationalMobile } = require('../../src/services/whatsapp.service');

test('parseBudget - a range with mixed units ("50L-1Cr")', () => {
  assert.deepEqual(parseBudget('50L-1Cr'), { min: 5000000, max: 10000000 });
});

test('parseBudget - "2Cr+" is an open-ended minimum', () => {
  assert.deepEqual(parseBudget('2Cr+'), { min: 20000000, max: null });
});

test('parseBudget - "above 80 lakh" is also an open-ended minimum', () => {
  assert.deepEqual(parseBudget('above 80 lakh'), { min: 8000000, max: null });
});

test('parseBudget - a plain number with no unit, on its own, is treated as a ceiling', () => {
  assert.deepEqual(parseBudget('1 crore'), { min: null, max: 10000000 });
});

test('parseBudget - a range without repeating the unit ("50-80 lakh") applies it to both', () => {
  assert.deepEqual(parseBudget('50-80 lakh'), { min: 5000000, max: 8000000 });
});

test('parseBudget - empty/unparseable text returns both null, never throws', () => {
  assert.deepEqual(parseBudget(''), { min: null, max: null });
  assert.deepEqual(parseBudget(null), { min: null, max: null });
  assert.deepEqual(parseBudget('not a budget'), { min: null, max: null });
});

test('toLocalMobile - strips the country code from a BSUID-style international number', () => {
  assert.equal(toLocalMobile('919876543210'), '9876543210');
  assert.equal(toLocalMobile('+91 98765 43210'), '9876543210');
});

test('toLocalMobile - a number already bare stays bare', () => {
  assert.equal(toLocalMobile('9876543210'), '9876543210');
});

test('toInternationalMobile - adds the country code to a bare 10-digit number (for Meta\'s `to` field)', () => {
  assert.equal(toInternationalMobile('9876543210'), '919876543210');
});

test('toLocalMobile and toInternationalMobile are inverses for a real customer mobile', () => {
  const bare = '9123456780';
  assert.equal(toLocalMobile(toInternationalMobile(bare)), bare);
});
