const crypto = require('crypto');

// Column-level AES-256-GCM for sensitive fields (Annexure A sec. 18.3):
// tenant phone numbers, KYC identifiers, confidential price ranges.
// DATA_ENCRYPTION_KEY is 32 bytes as 64 hex chars. Stored format is
// "v1:<iv b64>:<auth tag b64>:<ciphertext b64>" so the key/algorithm can
// be rotated later without guessing which rows use which scheme.
const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function getKey() {
  const hex = process.env.DATA_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    const err = new Error('Field encryption is not configured (DATA_ENCRYPTION_KEY must be 64 hex characters)');
    err.statusCode = 500;
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!stored) return null;
  const [version, ivB64, tagB64, dataB64] = String(stored).split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unrecognised encrypted value format');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
