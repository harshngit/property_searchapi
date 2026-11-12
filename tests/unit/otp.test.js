const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateOtp, getOtpExpiry } = require('../../src/utils/otp');

test('generateOtp - default length is 6 digits', () => {
  const otp = generateOtp();
  assert.equal(otp.length, 6);
  assert.match(otp, /^\d{6}$/);
});

test('generateOtp - respects a custom length', () => {
  assert.match(generateOtp(4), /^\d{4}$/);
  assert.match(generateOtp(10), /^\d{10}$/);
});

test('generateOtp - is not the same value every time', () => {
  const codes = new Set(Array.from({ length: 20 }, () => generateOtp()));
  assert.ok(codes.size > 1, 'generateOtp should not return a constant value');
});

test('getOtpExpiry - default 5 minutes ahead of now', () => {
  const before = Date.now();
  const expiry = getOtpExpiry();
  const after = Date.now();
  const diffFromBefore = expiry.getTime() - before;
  const diffFromAfter = expiry.getTime() - after;
  assert.ok(diffFromBefore >= 5 * 60 * 1000 && diffFromAfter <= 5 * 60 * 1000, 'expiry should be ~5 minutes from now');
});

test('getOtpExpiry - respects a custom minutes value (10-minute OTP, per WFH flow spec)', () => {
  const now = Date.now();
  const expiry = getOtpExpiry(10);
  const diffMinutes = (expiry.getTime() - now) / 60000;
  assert.ok(diffMinutes > 9.9 && diffMinutes <= 10, `expected ~10 minutes, got ${diffMinutes}`);
});
