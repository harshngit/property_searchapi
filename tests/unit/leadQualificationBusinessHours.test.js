// isBusinessHours() decides, in lead_qualification.mode='contract', whether
// ar_lead_qualification sends immediately (off-hours) or waits for the
// assigned rep's own response SLA to miss first (business hours). Pure
// function of a config object and a Date - no DB, no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBusinessHours } = require('../../src/services/leadQualification.service');

const cfg = { businessStart: '09:00', businessEnd: '21:00' };

// IST is UTC+5:30 - these UTC instants land at the stated IST clock time.
function istInstant(hour, minute = 0) {
  const istMinutes = hour * 60 + minute;
  let utcMinutes = istMinutes - 330;
  let day = 15;
  if (utcMinutes < 0) {
    utcMinutes += 1440;
    day -= 1;
  }
  return new Date(Date.UTC(2026, 0, day, Math.floor(utcMinutes / 60), utcMinutes % 60));
}

test('isBusinessHours - mid-morning (10 AM IST) is business hours', () => {
  assert.equal(isBusinessHours(cfg, istInstant(10)), true);
});

test('isBusinessHours - mid-afternoon (3 PM IST) is business hours', () => {
  assert.equal(isBusinessHours(cfg, istInstant(15)), true);
});

test('isBusinessHours - exactly at the start boundary (9:00 AM) counts as business hours', () => {
  assert.equal(isBusinessHours(cfg, istInstant(9, 0)), true);
});

test('isBusinessHours - exactly at the end boundary (9:00 PM) is NOT business hours (end is exclusive)', () => {
  assert.equal(isBusinessHours(cfg, istInstant(21, 0)), false);
});

test('isBusinessHours - late night (11 PM IST) is off-hours', () => {
  assert.equal(isBusinessHours(cfg, istInstant(23)), false);
});

test('isBusinessHours - early morning (3 AM IST) is off-hours', () => {
  assert.equal(isBusinessHours(cfg, istInstant(3)), false);
});

test('isBusinessHours - a window that wraps past midnight (e.g. a 24x7-except-3am-6am config) is handled', () => {
  const overnightCfg = { businessStart: '22:00', businessEnd: '06:00' };
  assert.equal(isBusinessHours(overnightCfg, istInstant(23)), true, '11 PM is inside a 10 PM-6 AM window');
  assert.equal(isBusinessHours(overnightCfg, istInstant(2)), true, '2 AM is inside a 10 PM-6 AM window');
  assert.equal(isBusinessHours(overnightCfg, istInstant(12)), false, 'noon is outside a 10 PM-6 AM window');
});
