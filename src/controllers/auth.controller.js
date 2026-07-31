const authService = require('../services/auth.service');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { success, error } = require('../utils/response');

// POST /api/auth/register
async function register(req, res, next) {
  try {
    const { fullName, email, mobile, password, role, tenantId } = req.body;

    const user = await authService.registerUser(
      { fullName, email, mobile, password, role, tenantId },
      req.user // set by optionalAuthenticate - null if no/invalid bearer token was sent
    );

    return success(res, 201, 'Registration successful', user);
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { identifier, password } = req.body;

    const user = await authService.findUserByEmailOrMobile(identifier);
    if (!user) {
      return error(res, 401, 'Invalid credentials');
    }

    if (user.status !== 'active') {
      return error(res, 403, `Account is ${user.status.replace('_', ' ')}. Please contact admin.`);
    }

    const isValid = await authService.validatePassword(user, password);
    if (!isValid) {
      return error(res, 401, 'Invalid credentials');
    }

    const payload = { id: user.id, role: user.role_name, tenant_id: user.tenant_id };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    const decodedRefresh = require('jsonwebtoken').decode(refreshToken);
    await authService.storeRefreshToken(user.id, refreshToken, new Date(decodedRefresh.exp * 1000));
    await authService.updateLastLogin(user.id);

    return success(res, 200, 'Login successful', {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        mobile: user.mobile,
        role: user.role_name,
        tenantId: user.tenant_id,
      },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/otp/send
async function sendOtp(req, res, next) {
  try {
    const { identifier, purpose } = req.body;

    const user = await authService.findUserByEmailOrMobile(identifier);
    if (purpose === 'login' && !user) {
      return error(res, 404, 'No account found with this identifier');
    }

    const otpCode = await authService.createOtp(identifier, purpose, user ? user.id : null);

    // In development, return OTP in response for testing.
    // In production, this must be removed - OTP is sent via SMS/Email provider only.
    const debugOtp = process.env.NODE_ENV !== 'production' ? { otp: otpCode } : {};

    return success(res, 200, 'OTP sent successfully', { identifier, purpose, ...debugOtp });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/otp/verify
async function verifyOtp(req, res, next) {
  try {
    const { identifier, otp, purpose } = req.body;

    await authService.verifyOtp(identifier, otp, purpose);

    const user = await authService.findUserByEmailOrMobile(identifier);

    if (user && purpose === 'register') {
      const field = identifier.includes('@') ? 'email' : 'mobile';
      await authService.markVerified(user.id, field);
    }

    // For OTP-based login, issue tokens directly after verification
    if (purpose === 'login' && user) {
      const payload = { id: user.id, role: user.role_name, tenant_id: user.tenant_id };
      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(payload);
      const decodedRefresh = require('jsonwebtoken').decode(refreshToken);
      await authService.storeRefreshToken(user.id, refreshToken, new Date(decodedRefresh.exp * 1000));
      await authService.updateLastLogin(user.id);

      return success(res, 200, 'OTP verified, login successful', { accessToken, refreshToken });
    }

    return success(res, 200, 'OTP verified successfully');
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/refresh-token
async function refreshToken(req, res, next) {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return error(res, 400, 'Refresh token is required');

    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch (e) {
      return error(res, 401, 'Invalid or expired refresh token');
    }

    const isValid = await authService.isRefreshTokenValid(decoded.id, token);
    if (!isValid) {
      return error(res, 401, 'Refresh token has been revoked or is invalid');
    }

    const payload = { id: decoded.id, role: decoded.role, tenant_id: decoded.tenant_id };
    const newAccessToken = generateAccessToken(payload);

    return success(res, 200, 'Access token refreshed', { accessToken: newAccessToken });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/logout
async function logout(req, res, next) {
  try {
    const { refreshToken: token } = req.body;
    if (token && req.user) {
      await authService.revokeRefreshToken(req.user.id, token);
    }
    return success(res, 200, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/forgot-password
async function forgotPassword(req, res, next) {
  try {
    const { identifier } = req.body;

    const user = await authService.findUserByEmailOrMobile(identifier);
    // Always return a generic success message to avoid user enumeration
    if (user) {
      const resetToken = await authService.createPasswordResetToken(user.id);
      // In development only - remove in production
      if (process.env.NODE_ENV !== 'production') {
        return success(res, 200, 'Password reset link generated', { resetToken });
      }
    }

    return success(res, 200, 'If an account exists, a password reset link has been sent');
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/reset-password
async function resetPassword(req, res, next) {
  try {
    const { token, newPassword } = req.body;

    const record = await authService.consumePasswordResetToken(token);
    await authService.updatePassword(record.user_id, newPassword);
    await authService.revokeAllRefreshTokens(record.user_id);

    return success(res, 200, 'Password has been reset successfully');
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/me
async function getMe(req, res, next) {
  try {
    const user = await authService.findUserById(req.user.id);
    if (!user) return error(res, 404, 'User not found');
    return success(res, 200, 'User profile fetched', user);
  } catch (err) {
    next(err);
  }
}

// PUT /api/auth/change-password
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;

    // fetch full user record with password_hash via id
    const fullUser = await require('../config/db').query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const record = fullUser.rows[0];

    if (!record) return error(res, 404, 'User not found');

    const isValid = await authService.validatePassword(record, currentPassword);
    if (!isValid) return error(res, 401, 'Current password is incorrect');

    await authService.updatePassword(req.user.id, newPassword);
    await authService.revokeAllRefreshTokens(req.user.id);

    return success(res, 200, 'Password changed successfully. Please login again.');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  sendOtp,
  verifyOtp,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  getMe,
  changePassword,
};
