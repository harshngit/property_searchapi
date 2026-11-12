// detectIntent() is the rules-only (no AI cost) first pass on every WhatsApp/
// Telegram message - whether it becomes a listing, a requirement lead, or is
// left to the bot's own question flow. Requiring chatIntake.service.js also
// pulls in pool/configService/etc, but nothing connects until a query runs -
// detectIntent() itself is synchronous and pure.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectIntent } = require('../../src/services/messaging/chatIntake.service');

test('detectIntent - a bare greeting is left to the bot, not treated as a listing/requirement', () => {
  assert.deepEqual(detectIntent('Hi'), { intent: 'greeting', strength: 0 });
  assert.deepEqual(detectIntent('  hello  '), { intent: 'greeting', strength: 0 });
  assert.deepEqual(detectIntent(''), { intent: 'greeting', strength: 0 });
});

test('detectIntent - a clear buy requirement', () => {
  const r = detectIntent('I want to buy a 3 BHK in Dwarka under 1.2 Cr');
  assert.equal(r.intent, 'buy');
  assert.ok(r.strength > 0);
});

test('detectIntent - a seller posting a listing', () => {
  const r = detectIntent('Selling my 2 BHK flat in Sector 50, Gurgaon for 75 lakhs');
  assert.equal(r.intent, 'sell');
  assert.ok(r.strength > 0);
});

test('detectIntent - a rent (tenant-side) requirement', () => {
  const r = detectIntent('I want to rent a 2 BHK in Noida under 25000');
  assert.equal(r.intent, 'rent');
});

test('detectIntent - a landlord posting a rental listing (rent_out, not rent)', () => {
  const r = detectIntent('To let: 2BHK available for rent, tenants wanted');
  assert.equal(r.intent, 'rent_out');
});

test('detectIntent - a vague "want" with no buy/rent word defaults to a buy lead, not left unhandled', () => {
  // The exact first real message tested against the live webhook this project used.
  const r = detectIntent('Hii I want to 2 bhk in Gurgaon under 80 Lakhs');
  assert.equal(r.intent, 'buy');
});

test('detectIntent - an institutional sale is tagged separately from a residential one', () => {
  const r = detectIntent('Selling our school campus in Pune, serious buyers only');
  assert.equal(r.intent, 'institutional_sale');
});

test('detectIntent - an institutional buy enquiry is tagged separately too', () => {
  const r = detectIntent('I want to buy a hospital in Chennai');
  assert.equal(r.intent, 'institutional_buy');
});

test('detectIntent - unrelated chit-chat is "other", not forced into a listing/requirement', () => {
  const r = detectIntent('What is the weather like today');
  assert.equal(r.intent, 'other');
});
