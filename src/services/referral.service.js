const crypto = require('crypto');
const pool = require('../config/db');
const configService = require('./config.service');
const { badRequest } = require('../utils/httpError');

// Permanent referral codes and the referral tree (Annexure A sec. 33.1 /
// 33.1A). Phase 1 only records attribution - no commission reads these.

// Body alphabet: A-Z and 2-9 without O, 0, I, 1, L (misread over the phone).
const BODY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ORGANIC_CODE = 'OG-00001';

// Category prefix by portal role (customers) or login role (everyone else).
const PORTAL_ROLE_PREFIX = { buyer: 'BU', seller: 'SE', owner: 'OW', tenant: 'TE' };
const LOGIN_ROLE_PREFIX = {
  broker: 'BR',
  builder: 'BD',
  agency_admin: 'FR',
  internal_sales: 'ST',
  admin: 'ST',
  super_admin: 'ST',
};

function randomBody() {
  const bytes = crypto.randomBytes(5);
  return Array.from(bytes, (b) => BODY_ALPHABET[b % BODY_ALPHABET.length]).join('');
}

function prefixFor(loginRole, portalRoles = []) {
  if (LOGIN_ROLE_PREFIX[loginRole]) return LOGIN_ROLE_PREFIX[loginRole];
  const first = portalRoles.find((role) => PORTAL_ROLE_PREFIX[role]);
  return first ? PORTAL_ROLE_PREFIX[first] : null;
}

// Issues the user's code if they don't have one yet and returns it. A
// customer only gets a code once they have picked a portal role (the code
// carries that category); returns null until then. The code never changes
// afterwards (DB trigger).
async function ensureReferralCode(userId, loginRole, portalRoles = []) {
  const existing = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;

  const prefix = prefixFor(loginRole, portalRoles);
  if (!prefix) return null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `${prefix}-${randomBody()}`;
    try {
      const result = await pool.query(
        'UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL RETURNING referral_code',
        [code, userId]
      );
      if (result.rows[0]) return result.rows[0].referral_code;
      // Someone else issued it concurrently - read theirs.
      const again = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
      return again.rows[0]?.referral_code || null;
    } catch (err) {
      if (err.code !== '23505') throw err; // unique clash - retry with a new body
    }
  }
  throw new Error('Could not issue a unique referral code');
}

// Records who referred a newly registered user - first touch only. A blank
// code attributes the sign-up to the house code OG-00001. An unknown code is
// rejected so the person can correct a typo rather than silently losing it.
async function recordReferral(referredUserId, referralCode) {
  const code = referralCode ? String(referralCode).trim().toUpperCase() : '';
  let referrerId = null;
  if (code && code !== ORGANIC_CODE) {
    const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (!referrer.rows[0]) throw badRequest('That referral code was not found - please check it or leave it blank');
    referrerId = referrer.rows[0].id;
    if (referrerId === referredUserId) throw badRequest('You cannot use your own referral code');
  }
  await pool.query(
    `INSERT INTO referral_tree (referrer_id, referred_id, referral_code)
     VALUES ($1, $2, $3)
     ON CONFLICT (referred_id) DO NOTHING`,
    [referrerId, referredUserId, code && code !== ORGANIC_CODE ? code : ORGANIC_CODE]
  );
}

async function validateCode(referralCode) {
  const code = String(referralCode || '').trim().toUpperCase();
  if (!code || code === ORGANIC_CODE) return true;
  const result = await pool.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
  return result.rows.length > 0;
}

async function countReferrals(userId) {
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM referral_tree WHERE referrer_id = $1', [userId]);
  return result.rows[0].n;
}

async function getShareMessage(code) {
  const template = await configService.getConfig(
    'referral_share_message',
    "Join PropertySerch.com - India's Real Estate Transaction Operating System - using my code [CODE]."
  );
  return String(template).replace('[CODE]', code);
}

module.exports = { ensureReferralCode, recordReferral, validateCode, countReferrals, getShareMessage, ORGANIC_CODE };
