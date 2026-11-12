// Needs DATA_ENCRYPTION_KEY from .env (same key the app uses for column-level
// AES-256-GCM - tenant phone numbers, KYC identifiers, mandate price ranges).
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt } = require('../../src/utils/crypto');

test('encrypt/decrypt round-trips plain text exactly', () => {
  const plain = 'a real seller minimum price, e.g. 8500000';
  const stored = encrypt(plain);
  assert.notEqual(stored, plain, 'the stored value must not be the plain text');
  assert.equal(decrypt(stored), plain);
});

test('encrypt - null/undefined/empty string all pass through as null (never encrypted garbage)', () => {
  assert.equal(encrypt(null), null);
  assert.equal(encrypt(undefined), null);
  assert.equal(encrypt(''), null);
});

test('decrypt - null/falsy input returns null without throwing', () => {
  assert.equal(decrypt(null), null);
  assert.equal(decrypt(''), null);
});

test('encrypt - the same plain text encrypts to a different value each time (random IV, not deterministic)', () => {
  const a = encrypt('9876543210');
  const b = encrypt('9876543210');
  assert.notEqual(a, b, 'two encryptions of the same value must differ (random IV)');
  assert.equal(decrypt(a), '9876543210');
  assert.equal(decrypt(b), '9876543210');
});

test('decrypt - a tampered auth tag fails instead of silently returning wrong data', () => {
  const stored = encrypt('8500000');
  const parts = stored.split(':');
  // Flip the first character of the 16-byte auth tag (always real data, no
  // base64 padding there) - GCM must refuse to decrypt under a wrong tag.
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  assert.throws(() => decrypt(parts.join(':')));
});

test('decrypt - an unrecognised stored format throws a clear error', () => {
  assert.throws(() => decrypt('not-the-right-format'), /Unrecognised encrypted value format/);
});
