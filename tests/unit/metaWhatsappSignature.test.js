// Security-critical: this is what stops a forged POST to /api/whatsapp/webhook
// from being treated as a real Meta message. Needs WHATSAPP_APP_SECRET from .env.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifySignature } = require('../../src/services/metaWhatsapp.service');

test('verifySignature - accepts a correctly signed body', () => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  assert.ok(secret, 'WHATSAPP_APP_SECRET must be set in .env for this test to mean anything');
  const rawBody = Buffer.from('{"entry":[]}');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  assert.equal(verifySignature(rawBody, signature), true);
});

test('verifySignature - rejects a tampered body', () => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  const rawBody = Buffer.from('{"entry":[]}');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const tamperedBody = Buffer.from('{"entry":["forged"]}');
  assert.equal(verifySignature(tamperedBody, signature), false);
});

test('verifySignature - rejects a signature signed with the wrong secret (forged request)', () => {
  const rawBody = Buffer.from('{"entry":[]}');
  const forgedSignature = `sha256=${crypto.createHmac('sha256', 'not-the-real-secret').update(rawBody).digest('hex')}`;
  assert.equal(verifySignature(rawBody, forgedSignature), false);
});

test('verifySignature - rejects a missing signature header or missing body, never throws', () => {
  assert.equal(verifySignature(Buffer.from('{}'), null), false);
  assert.equal(verifySignature(Buffer.from('{}'), ''), false);
  assert.equal(verifySignature(null, 'sha256=abc'), false);
});

test('verifySignature - a signature of the wrong length is rejected, not compared byte-by-byte unsafely', () => {
  assert.equal(verifySignature(Buffer.from('{}'), 'sha256=tooshort'), false);
});
