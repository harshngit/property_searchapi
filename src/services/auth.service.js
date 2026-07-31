const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/db');
const { generateOtp, getOtpExpiry } = require('../utils/otp');

// Roles allowed to self-register through the public /auth/register endpoint
// in production. All other roles (agency_admin, builder, internal_sales,
// admin, super_admin) must be created via the admin invite flow there.
const PUBLIC_REGISTER_ROLES = ['customer', 'broker'];

// Outside production (local/dev/test), /auth/register accepts every role,
// including admin/super_admin - purely a convenience for spinning up test
// accounts without going through the invite flow. Never enable this in a
// real deployment: it lets any unauthenticated caller grant themselves
// admin rights. Can be forced on/off explicitly via ALLOW_ALL_ROLE_REGISTRATION.
const OPEN_ROLE_REGISTRATION =
  process.env.ALLOW_ALL_ROLE_REGISTRATION !== undefined
    ? process.env.ALLOW_ALL_ROLE_REGISTRATION === 'true'
    : process.env.NODE_ENV !== 'production';

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
    `SELECT u.id, u.tenant_id, u.full_name, u.email, u.mobile, u.status,
            u.email_verified, u.mobile_verified, u.created_at, r.name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [id]
  );
  return result.rows[0];
}

async function registerUser({ fullName, email, mobile, password, role, tenantId }) {
  if (!PUBLIC_REGISTER_ROLES.includes(role) && !OPEN_ROLE_REGISTRATION) {
    const err = new Error(
      `Role '${role}' cannot self-register. This role must be created by an Admin/Super Admin via the invite flow.`
    );
    err.statusCode = 403;
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

  const passwordHash = password ? await bcrypt.hash(password, 10) : null;

  // customer -> active immediately, broker -> pending_approval (needs
  // Agency Admin/Admin activation). Roles only reachable via the
  // OPEN_ROLE_REGISTRATION dev bypass go active immediately too - there's
  // no admin/invite loop to approve them in a fresh dev setup, so leaving
  // them pending_approval would just soft-lock the account.
  const status =
    role === 'customer' || (OPEN_ROLE_REGISTRATION && !PUBLIC_REGISTER_ROLES.includes(role))
      ? 'active'
      : 'pending_approval';

  const result = await pool.query(
    `INSERT INTO users (tenant_id, role_id, full_name, email, mobile, password_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, full_name, email, mobile, status, created_at`,
    [tenantId || null, roleRecord.id, fullName, email || null, mobile || null, passwordHash, status]
  );

  return { ...result.rows[0], role };
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

  // NOTE: integrate with SMS/Email provider here to actually deliver the OTP.
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

// Which roles a given inviter role is allowed to create via the invite flow.
const INVITE_PERMISSIONS = {
  super_admin: ['admin', 'agency_admin', 'builder', 'internal_sales', 'super_admin'],
  admin: ['agency_admin', 'builder', 'internal_sales'],
};

async function createInvite({ inviterRole, inviterId, fullName, email, role, tenantId }) {
  const allowedRoles = INVITE_PERMISSIONS[inviterRole] || [];
  if (!allowedRoles.includes(role)) {
    const err = new Error(`Your role (${inviterRole}) is not permitted to invite a '${role}' user`);
    err.statusCode = 403;
    throw err;
  }

  const existingUser = await findUserByEmailOrMobile(email);
  if (existingUser) {
    const err = new Error('A user with this email already exists');
    err.statusCode = 409;
    throw err;
  }

  const roleRecord = await getRoleByName(role);
  if (!roleRecord) {
    const err = new Error('Invalid role specified');
    err.statusCode = 400;
    throw err;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(
    Date.now() + (Number(process.env.INVITE_EXPIRY_HOURS) || 72) * 60 * 60 * 1000
  );

  const result = await pool.query(
    `INSERT INTO invites (tenant_id, role_id, full_name, email, invited_by, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, full_name, email, status, expires_at, created_at`,
    [tenantId || null, roleRecord.id, fullName, email, inviterId, hashToken(rawToken), expiresAt]
  );

  // NOTE: integrate with email provider here to actually send the invite link
  // e.g. https://app.propertysearch.com/accept-invite?token=<rawToken>
  return { invite: result.rows[0], rawToken };
}

async function getInviteByToken(rawToken) {
  const result = await pool.query(
    `SELECT i.*, r.name AS role_name
     FROM invites i
     JOIN roles r ON r.id = i.role_id
     WHERE i.token_hash = $1 AND i.status = 'pending' AND i.expires_at > now()`,
    [hashToken(rawToken)]
  );
  return result.rows[0];
}

async function acceptInvite(rawToken, password) {
  const invite = await getInviteByToken(rawToken);
  if (!invite) {
    const err = new Error('Invite link is invalid, expired, or already used');
    err.statusCode = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const userResult = await pool.query(
    `INSERT INTO users (tenant_id, role_id, full_name, email, password_hash, status, email_verified)
     VALUES ($1, $2, $3, $4, $5, 'active', true)
     RETURNING id, tenant_id, full_name, email, status, created_at`,
    [invite.tenant_id, invite.role_id, invite.full_name, invite.email, passwordHash]
  );

  await pool.query(
    `UPDATE invites SET status = 'accepted', accepted_at = now() WHERE id = $1`,
    [invite.id]
  );

  return { ...userResult.rows[0], role: invite.role_name };
}

module.exports = {
  PUBLIC_REGISTER_ROLES,
  OPEN_ROLE_REGISTRATION,
  INVITE_PERMISSIONS,
  getRoleByName,
  findUserByEmailOrMobile,
  findUserById,
  registerUser,
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
  createInvite,
  getInviteByToken,
  acceptInvite,
};