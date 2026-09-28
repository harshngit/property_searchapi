const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');
const { generateOtp, getOtpExpiry } = require('../utils/otp');
const msg91Service = require('./msg91.service');
const customerService = require('./customer.service');
const referralService = require('./referral.service');
const { uploadBuffer, deleteObject, getReadUrl } = require('../utils/storage');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Roles that can always self-register through /auth/register with no token.
const PUBLIC_SELF_REGISTER_ROLES = ['customer', 'broker'];

// Which roles a given actor's role is allowed to directly register another
// user into, via /auth/register (replaces the old separate invite-link
// flow - registration and role-tree authorization now happen in one call).
// super_admin is listed under itself too, since an existing super_admin can
// mint another one; the *first* super_admin is created via the one-time
// bootstrap path in registerUser() below, which needs no actor at all.
const ROLE_CREATION_PERMISSIONS = {
  super_admin: ['admin', 'agency_admin', 'builder', 'internal_sales', 'super_admin'],
  admin: ['agency_admin', 'builder', 'internal_sales'],
};

// Throws 401 if no caller is authenticated, or 403 if the caller's role
// isn't permitted to create the target role, per ROLE_CREATION_PERMISSIONS.
function assertCanCreateRole(actingUser, targetRole) {
  if (!actingUser) {
    const err = new Error(`Authentication is required to register a '${targetRole}' user`);
    err.statusCode = 401;
    throw err;
  }

  const allowedRoles = ROLE_CREATION_PERMISSIONS[actingUser.role] || [];
  if (!allowedRoles.includes(targetRole)) {
    const err = new Error(`Your role (${actingUser.role}) is not permitted to register a '${targetRole}' user`);
    err.statusCode = 403;
    throw err;
  }
}

async function superAdminExists() {
  const result = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'super_admin' LIMIT 1`
  );
  return result.rows.length > 0;
}

async function getRoleByName(roleName) {
  const result = await pool.query('SELECT id, name FROM roles WHERE name = $1', [roleName]);
  return result.rows[0];
}

async function findUserByEmailOrMobile(identifier) {
  const result = await pool.query(
    `SELECT u.*, r.name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.email = $1 OR u.mobile = $1
     LIMIT 1`,
    [identifier]
  );
  return result.rows[0];
}

async function findUserById(id) {
  const result = await pool.query(
    `SELECT u.id, u.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
            u.role_id, r.name AS role_name, r.description AS role_description,
            u.full_name, u.email, u.mobile, u.status,
            u.email_verified, u.mobile_verified, u.profile_picture_url,
            u.created_by, u.signup_source, u.last_login_at, u.created_at, u.updated_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [id]
  );
  const user = result.rows[0];
  if (user) user.profile_picture_url = await getReadUrl(user.profile_picture_url);
  return user;
}

// Uploads a file to users/<id>/profile/... in GCS, deletes the previous
// picture (if any) and records the new object path on the user row. The
// bucket is private, so what's returned to the caller is a freshly signed,
// browsable URL - never the bare object path that's actually stored.
async function uploadProfilePicture(userId, file) {
  const existing = await pool.query('SELECT profile_picture_url FROM users WHERE id = $1', [userId]);
  if (existing.rows.length === 0) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const objectPath = await uploadBuffer(file.buffer, `users/${userId}/profile`, file.originalname, file.mimetype);

  await pool.query('UPDATE users SET profile_picture_url = $1 WHERE id = $2', [objectPath, userId]);

  if (existing.rows[0].profile_picture_url) {
    await deleteObject(existing.rows[0].profile_picture_url);
  }

  return getReadUrl(objectPath);
}

// Activates a pending_approval account (currently only reachable by
// self-registered brokers - every other role goes active immediately at
// creation). agency_admin can only activate users in their own tenant;
// admin/super_admin can activate anyone.
async function activateUser(targetUserId, actingUser) {
  const result = await pool.query(
    `SELECT u.id, u.tenant_id, u.full_name, u.email, u.mobile, u.status, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [targetUserId]
  );
  const target = result.rows[0];

  if (!target) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  if (actingUser.role === 'agency_admin' && target.tenant_id !== actingUser.tenant_id) {
    const err = new Error('You can only activate users within your own tenant');
    err.statusCode = 403;
    throw err;
  }

  if (target.status !== 'pending_approval') {
    const err = new Error(`User is not pending approval (current status: ${target.status})`);
    err.statusCode = 400;
    throw err;
  }

  const updated = await pool.query(
    `UPDATE users SET status = 'active' WHERE id = $1
     RETURNING id, tenant_id, full_name, email, mobile, status, updated_at`,
    [targetUserId]
  );

  return { ...updated.rows[0], role: target.role_name };
}

// Single entry point for creating any user of any role.
//   - customer / broker: always public, no token needed.
//   - super_admin: public and token-less ONLY as a one-time bootstrap, while
//     zero super_admin accounts exist yet. Once the first one exists, every
//     further super_admin must be created by an existing super_admin's token.
//   - everything else (admin, agency_admin, builder, internal_sales): always
//     requires an authenticated actor whose role is permitted to create that
//     target role, per ROLE_CREATION_PERMISSIONS.
// `actingUser` is req.user from optionalAuthenticate - null when the caller
// sent no (or an invalid) bearer token.
async function registerUser({ fullName, email, mobile, password, role, tenantId, referralCode }, actingUser) {
  let status;
  let emailVerified = false;

  if (role === 'customer') {
    status = 'active';
  } else if (role === 'broker') {
    status = 'pending_approval';
  } else if (role === 'super_admin') {
    if (await superAdminExists()) {
      assertCanCreateRole(actingUser, role);
    }
    status = 'active';
    emailVerified = true;
  } else {
    assertCanCreateRole(actingUser, role);
    status = 'active';
    emailVerified = true;
  }

  if (!PUBLIC_SELF_REGISTER_ROLES.includes(role) && !password) {
    const err = new Error('Password is required for this role');
    err.statusCode = 400;
    throw err;
  }

  const existing = await findUserByEmailOrMobile(email || mobile);
  if (existing) {
    const err = new Error('An account with this email or mobile already exists');
    err.statusCode = 409;
    throw err;
  }

  const roleRecord = await getRoleByName(role);
  if (!roleRecord) {
    const err = new Error('Invalid role specified');
    err.statusCode = 400;
    throw err;
  }

  // Checked before the account exists so a mistyped code doesn't leave a
  // half-registered user behind.
  if (referralCode && !(await referralService.validateCode(referralCode))) {
    const err = new Error('That referral code was not found - please check it or leave it blank');
    err.statusCode = 400;
    throw err;
  }

  const passwordHash = password ? await bcrypt.hash(password, 10) : null;

  // A bearer token present at all (regardless of which role is being
  // created) means staff registered this account on someone's behalf -
  // /auth/register's token is optional only for customer/broker, so this
  // still correctly reads as 'self_registration' for the normal public
  // signup case where no token was sent.
  const signupSource = actingUser ? 'admin_created' : 'self_registration';

  const result = await pool.query(
    `INSERT INTO users (tenant_id, role_id, full_name, email, mobile, password_hash, status, email_verified, signup_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, tenant_id, full_name, email, mobile, status, signup_source, created_at`,
    [tenantId || null, roleRecord.id, fullName, email || null, mobile || null, passwordHash, status, emailVerified, signupSource]
  );
  const newUser = result.rows[0];

  // A `customer`-role login account and a CRM `customers` record are
  // different things (see customer.service.js) - without this, someone who
  // self-registers as a customer can log into the website but is invisible
  // to brokers in the CRM's Customers list. Links/creates the matching
  // customers row so they actually show up there.
  if (role === 'customer') {
    await customerService.findOrCreateCustomerByContact({ fullName, email, mobile, userId: newUser.id });
  }

  // Referral attribution (sec. 33.1A) - self sign-ups only; a blank code is
  // recorded as organic (OG-00001). Staff-created accounts aren't referrals.
  // Non-customer roles get their permanent code now; a customer gets theirs
  // once they pick buyer / seller / owner / tenant in onboarding.
  if (!actingUser) await referralService.recordReferral(newUser.id, referralCode);
  const issuedCode = await referralService.ensureReferralCode(newUser.id, role);

  return { ...newUser, role, referral_code: issuedCode };
}

// Verifies the ID token's signature, expiry and audience (must match our own
// OAuth Client ID, so a token minted for a different app can't be replayed
// here) against Google's public keys, and returns its decoded payload
// (email, name, email_verified, ...).
async function verifyGoogleIdToken(idToken) {
  if (!idToken) {
    const err = new Error('idToken is required');
    err.statusCode = 400;
    throw err;
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    const err = new Error('Google login is not configured (missing GOOGLE_CLIENT_ID)');
    err.statusCode = 500;
    throw err;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    return ticket.getPayload();
  } catch (e) {
    const err = new Error('Invalid or expired Google token');
    err.statusCode = 401;
    throw err;
  }
}

// Roles Google sign-up may self-register as - every role except
// super_admin. Unlike /auth/register (which gates admin/agency_admin/
// builder/internal_sales behind an existing admin's bearer token via
// ROLE_CREATION_PERMISSIONS), a verified Google account may self-register
// as any of these directly, no token required - by design, per product
// decision. super_admin stays blocked unconditionally; there is no
// Google-based bootstrap path for it.
const GOOGLE_SELF_REGISTER_ROLES = ['customer', 'broker', 'agency_admin', 'builder', 'internal_sales', 'admin'];

// Finds the user matching a verified Google account's email, or - only when
// allowSelfRegister is true (the public website always passes true; the CRM
// dashboard passes true from its Register page and false/omitted from its
// login-only Login page) - creates one as `role` (default 'customer' if
// omitted, e.g. the website's login-page Google button). Google already
// verified the email, so the new account is marked email_verified from
// Google's own claim and never gets a password_hash (only Google/OTP can
// ever log into it, same as an OTP-only account).
async function loginWithGoogle(googlePayload, allowSelfRegister, role, tenantId) {
  const { email, name, email_verified } = googlePayload;
  if (!email) {
    const err = new Error('This Google account has no email address');
    err.statusCode = 400;
    throw err;
  }

  let user = await findUserByEmailOrMobile(email);

  if (!user) {
    if (!allowSelfRegister) {
      const err = new Error('No account found with this Google email');
      err.statusCode = 404;
      throw err;
    }

    const targetRole = role || 'customer';
    if (!GOOGLE_SELF_REGISTER_ROLES.includes(targetRole)) {
      const err = new Error(`Cannot self-register a '${targetRole}' account via Google`);
      err.statusCode = 403;
      throw err;
    }

    const roleRecord = await getRoleByName(targetRole);
    if (!roleRecord) {
      const err = new Error('Invalid role specified');
      err.statusCode = 400;
      throw err;
    }

    // Mirrors registerUser()'s status rule: brokers still need an
    // agency_admin/admin to activate them; every other self-registerable
    // role (including agency_admin/builder/internal_sales/admin here,
    // deliberately more permissive than the token-gated /auth/register
    // path) goes active immediately.
    const status = targetRole === 'broker' ? 'pending_approval' : 'active';

    const fullName = name || email.split('@')[0];
    await pool.query(
      `INSERT INTO users (tenant_id, role_id, full_name, email, password_hash, status, email_verified, signup_source)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, 'google')`,
      [tenantId || null, roleRecord.id, fullName, email, status, !!email_verified]
    );
    user = await findUserByEmailOrMobile(email);

    // Same reasoning as registerUser() - a customer-role login account and
    // a CRM customers record are different things; without this a Google
    // signup is invisible to brokers in the CRM's Customers list.
    if (targetRole === 'customer') {
      await customerService.findOrCreateCustomerByContact({ fullName, email, userId: user.id });
    }
    await referralService.recordReferral(user.id, null);
    await referralService.ensureReferralCode(user.id, targetRole);
  } else if (user.status !== 'active') {
    const err = new Error(`Account is ${user.status.replace('_', ' ')}. Please contact admin.`);
    err.statusCode = 403;
    throw err;
  }

  return user;
}

async function validatePassword(user, password) {
  if (!user.password_hash) return false;
  return bcrypt.compare(password, user.password_hash);
}

async function updateLastLogin(userId) {
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

async function createOtp(identifier, purpose, userId = null) {
  const otpCode = generateOtp(Number(process.env.OTP_LENGTH) || 6);
  const expiresAt = getOtpExpiry(Number(process.env.OTP_EXPIRY_MINUTES) || 5);

  await pool.query(
    `INSERT INTO otp_verifications (user_id, identifier, otp_code, purpose, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, identifier, otpCode, purpose, expiresAt]
  );

  if (msg91Service.isMobileIdentifier(identifier)) {
    const templateId = msg91Service.getTemplateIdForPurpose(purpose);
    if (process.env.MSG91_AUTH_KEY && templateId) {
      await msg91Service.sendOtpSms(identifier, otpCode, templateId, purpose);
    } else if (process.env.NODE_ENV === 'production') {
      const err = new Error(`SMS delivery is not configured for purpose '${purpose}' (missing MSG91_AUTH_KEY or its template id env var)`);
      err.statusCode = 500;
      throw err;
    }
    // Else: MSG91 isn't configured for this purpose in a non-production
    // environment - fall through silently so local/dev testing keeps
    // working off the debug OTP echo in auth.controller.js, with no MSG91
    // account required.
  }
  // NOTE: email identifiers aren't delivered yet - see the SMTP TODO above.

  return otpCode;
}

async function verifyOtp(identifier, otpCode, purpose) {
  const result = await pool.query(
    `SELECT * FROM otp_verifications
     WHERE identifier = $1 AND purpose = $2 AND is_verified = false
     ORDER BY created_at DESC LIMIT 1`,
    [identifier, purpose]
  );

  const record = result.rows[0];
  if (!record) {
    const err = new Error('No pending OTP found for this identifier');
    err.statusCode = 400;
    throw err;
  }

  if (new Date(record.expires_at) < new Date()) {
    const err = new Error('OTP has expired');
    err.statusCode = 400;
    throw err;
  }

  if (record.attempts >= 5) {
    const err = new Error('Maximum OTP attempts exceeded');
    err.statusCode = 429;
    throw err;
  }

  if (record.otp_code !== otpCode) {
    await pool.query('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    const err = new Error('Invalid OTP');
    err.statusCode = 400;
    throw err;
  }

  await pool.query('UPDATE otp_verifications SET is_verified = true WHERE id = $1', [record.id]);
  return true;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function storeRefreshToken(userId, token, expiresAt) {
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), expiresAt]
  );
}

async function isRefreshTokenValid(userId, token) {
  const result = await pool.query(
    `SELECT * FROM refresh_tokens
     WHERE user_id = $1 AND token_hash = $2 AND is_revoked = false AND expires_at > now()`,
    [userId, hashToken(token)]
  );
  return result.rows.length > 0;
}

async function revokeRefreshToken(userId, token) {
  await pool.query(
    `UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1 AND token_hash = $2`,
    [userId, hashToken(token)]
  );
}

async function revokeAllRefreshTokens(userId) {
  await pool.query(`UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1`, [userId]);
}

async function createPasswordResetToken(userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(
    Date.now() + (Number(process.env.RESET_TOKEN_EXPIRY_MINUTES) || 30) * 60 * 1000
  );

  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(rawToken), expiresAt]
  );

  // NOTE: integrate with email provider to actually send the reset link.
  return rawToken;
}

async function consumePasswordResetToken(rawToken) {
  const result = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1 AND is_used = false AND expires_at > now()`,
    [hashToken(rawToken)]
  );

  const record = result.rows[0];
  if (!record) {
    const err = new Error('Reset link is invalid or has expired');
    err.statusCode = 400;
    throw err;
  }

  await pool.query('UPDATE password_reset_tokens SET is_used = true WHERE id = $1', [record.id]);
  return record;
}

async function updatePassword(userId, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
}

async function markVerified(userId, field) {
  const column = field === 'email' ? 'email_verified' : 'mobile_verified';
  await pool.query(`UPDATE users SET ${column} = true WHERE id = $1`, [userId]);

  // if pending_approval users only need verification (not role approval), you could
  // auto-activate here for customer role. Left explicit for admin approval flows.
}

module.exports = {
  PUBLIC_SELF_REGISTER_ROLES,
  ROLE_CREATION_PERMISSIONS,
  getRoleByName,
  findUserByEmailOrMobile,
  findUserById,
  uploadProfilePicture,
  activateUser,
  registerUser,
  verifyGoogleIdToken,
  loginWithGoogle,
  validatePassword,
  updateLastLogin,
  createOtp,
  verifyOtp,
  storeRefreshToken,
  isRefreshTokenValid,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  createPasswordResetToken,
  consumePasswordResetToken,
  updatePassword,
  markVerified,
};