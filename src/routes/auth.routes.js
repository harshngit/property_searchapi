const express = require('express');
const { body } = require('express-validator');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');

/**
 * @swagger
 * tags:
 *   name: Authentication
 *   description: Authentication & Access APIs
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     description: >
 *       Public self-registration endpoint. The **role** dropdown lists every
 *       role used across PropertySerch.com for reference, but only
 *       `customer` and `broker` are permitted to self-register here.
 *
 *       - `customer` → account is created with status `active` immediately.
 *       - `broker` → account is created with status `pending_approval` and
 *         must be activated by an Agency Admin/Admin.
 *       - `agency_admin`, `builder`, `internal_sales`, `admin`, `super_admin`
 *         → **not allowed** through this endpoint (returns `403`). These
 *         roles are created only by an Admin/Super Admin via the invite flow.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterRequest'
 *           examples:
 *             customer:
 *               summary: Customer self-registration (allowed)
 *               value:
 *                 fullName: Rahul Sharma
 *                 email: rahul@example.com
 *                 mobile: "9876543210"
 *                 password: Passw0rd!123
 *                 role: customer
 *                 tenantId: null
 *             broker:
 *               summary: Broker self-registration (allowed, needs approval)
 *               value:
 *                 fullName: Priya Mehta
 *                 email: priya@example.com
 *                 mobile: "9876500000"
 *                 password: Passw0rd!123
 *                 role: broker
 *                 tenantId: null
 *             agencyAdminBlocked:
 *               summary: agency_admin (blocked - returns 403)
 *               value:
 *                 fullName: Suresh Rao
 *                 email: suresh@agency.com
 *                 password: Passw0rd!123
 *                 role: agency_admin
 *                 tenantId: null
 *     responses:
 *       201:
 *         description: Registration successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Registration successful }
 *                 data:
 *                   $ref: '#/components/schemas/RegisteredUser'
 *       403:
 *         description: Role not allowed to self-register (e.g. agency_admin, builder, admin, super_admin)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Account already exists with this email/mobile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       422:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/register',
  [
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('mobile').optional().isMobilePhone().withMessage('Valid mobile number required'),
    body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['customer', 'broker']).withMessage('Role must be customer or broker'),
  ],
  validate,
  authController.register
);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login with email/mobile and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identifier, password]
 *             properties:
 *               identifier:
 *                 type: string
 *                 example: rahul@example.com
 *               password:
 *                 type: string
 *                 example: Passw0rd!123
 *     responses:
 *       200:
 *         description: Login successful, returns access & refresh tokens
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Account not active
 */
router.post(
  '/login',
  [
    body('identifier').notEmpty().withMessage('Email or mobile is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  authController.login
);

/**
 * @swagger
 * /auth/otp/send:
 *   post:
 *     summary: Send OTP to email or mobile
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identifier, purpose]
 *             properties:
 *               identifier:
 *                 type: string
 *                 example: "9876543210"
 *               purpose:
 *                 type: string
 *                 enum: [register, login, reset_password, mobile_verification]
 *                 example: login
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       404:
 *         description: No account found (for login purpose)
 */
router.post(
  '/otp/send',
  [
    body('identifier').notEmpty().withMessage('Identifier (email/mobile) is required'),
    body('purpose')
      .isIn(['register', 'login', 'reset_password', 'mobile_verification'])
      .withMessage('Invalid OTP purpose'),
  ],
  validate,
  authController.sendOtp
);

/**
 * @swagger
 * /auth/otp/verify:
 *   post:
 *     summary: Verify OTP sent to email or mobile
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identifier, otp, purpose]
 *             properties:
 *               identifier:
 *                 type: string
 *                 example: "9876543210"
 *               otp:
 *                 type: string
 *                 example: "482913"
 *               purpose:
 *                 type: string
 *                 enum: [register, login, reset_password, mobile_verification]
 *                 example: login
 *     responses:
 *       200:
 *         description: OTP verified successfully
 *       400:
 *         description: Invalid or expired OTP
 */
router.post(
  '/otp/verify',
  [
    body('identifier').notEmpty().withMessage('Identifier (email/mobile) is required'),
    body('otp').notEmpty().withMessage('OTP is required'),
    body('purpose')
      .isIn(['register', 'login', 'reset_password', 'mobile_verification'])
      .withMessage('Invalid OTP purpose'),
  ],
  validate,
  authController.verifyOtp
);

/**
 * @swagger
 * /auth/refresh-token:
 *   post:
 *     summary: Get a new access token using a valid refresh token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New access token issued
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post(
  '/refresh-token',
  [body('refreshToken').notEmpty().withMessage('Refresh token is required')],
  validate,
  authController.refreshToken
);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout and revoke refresh token
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: Not authenticated
 */
router.post('/logout', authenticate, authController.logout);

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Request a password reset link/token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identifier]
 *             properties:
 *               identifier:
 *                 type: string
 *                 example: rahul@example.com
 *     responses:
 *       200:
 *         description: Reset link generated / sent if account exists
 */
router.post(
  '/forgot-password',
  [body('identifier').notEmpty().withMessage('Email or mobile is required')],
  validate,
  authController.forgotPassword
);

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Reset password using a valid reset token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 example: NewPassw0rd!123
 *     responses:
 *       200:
 *         description: Password reset successfully
 *       400:
 *         description: Invalid or expired reset token
 */
router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate,
  authController.resetPassword
);

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Get the currently logged-in user's profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile fetched
 *       401:
 *         description: Not authenticated
 */
router.get('/me', authenticate, authController.getMe);

/**
 * @swagger
 * /auth/change-password:
 *   put:
 *     summary: Change password for logged-in user
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       401:
 *         description: Current password incorrect / not authenticated
 */
router.put(
  '/change-password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  validate,
  authController.changePassword
);

module.exports = router;