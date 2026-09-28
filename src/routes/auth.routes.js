const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const userController = require('../controllers/user.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth');
const { uploadProfilePicture } = require('../middlewares/upload');

const ALL_ROLES = ['customer', 'broker', 'agency_admin', 'builder', 'internal_sales', 'admin', 'super_admin'];

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
 *     summary: Register a new user of any role
 *     description: >
 *       Single endpoint for creating a user of any role. An optional bearer
 *       token determines what you're allowed to create:
 *
 *       - `customer` → always public, no token. Status `active` immediately.
 *       - `broker` → always public, no token. Status `pending_approval`,
 *         needs an Agency Admin/Admin to activate.
 *       - `super_admin` → public and token-less **only while no super_admin
 *         account exists yet** (one-time bootstrap). Once the first one
 *         exists, creating another `super_admin` requires a bearer token
 *         from an existing `super_admin`.
 *       - `admin`, `agency_admin`, `builder`, `internal_sales` → always
 *         require a bearer token from an actor permitted to create that
 *         role: a `super_admin` can create `admin`/`agency_admin`/`builder`/
 *         `internal_sales`/`super_admin`; an `admin` can create
 *         `agency_admin`/`builder`/`internal_sales`. No token → `401`;
 *         wrong role → `403`.
 *
 *       All roles other than `customer`/`broker` require `password` in the
 *       body (they log in immediately, there's no separate activation step).
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *       - {}
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
 *             agencyAdminByAdmin:
 *               summary: agency_admin (requires a super_admin/admin bearer token)
 *               value:
 *                 fullName: Suresh Rao
 *                 email: suresh@agency.com
 *                 password: Passw0rd!123
 *                 role: agency_admin
 *                 tenantId: null
 *             superAdminBootstrap:
 *               summary: super_admin (no token needed only while none exist yet)
 *               value:
 *                 fullName: Founding Super Admin
 *                 email: root@propertyserch.com
 *                 password: Passw0rd!123
 *                 role: super_admin
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
 *       401:
 *         description: A bearer token is required to register this role, and none (or an invalid one) was provided
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: The caller's role is not permitted to register this target role
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
  optionalAuthenticate,
  [
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('mobile').optional().isMobilePhone().withMessage('Valid mobile number required'),
    body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(ALL_ROLES).withMessage(`Role must be one of: ${ALL_ROLES.join(', ')}`),
    body('referralCode').optional({ checkFalsy: true }).isString().isLength({ max: 8 }),
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
 * /auth/google:
 *   post:
 *     summary: Login (or, with allowSelfRegister, sign up) with a Google ID token
 *     description: >
 *       Verifies the ID token from Google Identity Services against
 *       GOOGLE_CLIENT_ID, then finds the user by the token's email. If none
 *       exists and `allowSelfRegister` is true, creates one as `role`
 *       (default `customer` if omitted) with `email_verified` taken from
 *       Google's own claim. Any role except `super_admin` may self-register
 *       this way with no bearer token - deliberately more permissive than
 *       /auth/register's ROLE_CREATION_PERMISSIONS gate for admin/
 *       agency_admin/builder/internal_sales, since a verified Google
 *       identity is considered sufficient here. `broker` still starts
 *       `pending_approval`, same as through /auth/register. If
 *       `allowSelfRegister` is false/omitted and no account exists, this is
 *       login-only and returns 404 - used by the CRM dashboard's Login page
 *       (its Register page passes allowSelfRegister: true instead).
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: The ID token (JWT credential) returned by Google Identity Services
 *               allowSelfRegister:
 *                 type: boolean
 *                 default: false
 *                 description: true to allow first-time sign-in to create an account (public website always; CRM dashboard's Register page); false/omitted is login-only (CRM dashboard's Login page)
 *               role:
 *                 type: string
 *                 enum: [customer, broker, agency_admin, builder, internal_sales, admin]
 *                 default: customer
 *                 description: Only used the first time a given Google email signs in (allowSelfRegister true) - ignored for an existing account. super_admin is never allowed here.
 *               tenantId:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *                 description: Only used on first self-registration, same as /auth/register
 *     responses:
 *       200:
 *         description: Login successful, returns access & refresh tokens
 *       401:
 *         description: Invalid or expired Google token
 *       403:
 *         description: Account not active, or role is not self-registerable via Google (e.g. super_admin)
 *       404:
 *         description: No account found with this Google email (allowSelfRegister was false)
 */
router.post(
  '/google',
  [
    body('idToken').notEmpty().withMessage('idToken is required'),
    body('allowSelfRegister').optional().isBoolean(),
    // super_admin is intentionally excluded - loginWithGoogle() also
    // rejects it explicitly, this just gives a cleaner 422 up front.
    body('role').optional().isIn(['customer', 'broker', 'agency_admin', 'builder', 'internal_sales', 'admin']),
  ],
  validate,
  authController.googleLogin
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
 * /auth/me:
 *   put:
 *     summary: Edit the currently logged-in user's own profile
 *     description: >
 *       Self-service profile edit - fullName/email/mobile only. To change
 *       password use `PUT /auth/change-password`; to change role or another
 *       user's details, an admin/agency_admin must use the `/users` endpoints.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fullName: { type: string, example: Rahul Sharma }
 *               email: { type: string, example: rahul@example.com }
 *               mobile: { type: string, example: "9876543210" }
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *       401:
 *         description: Not authenticated
 *       422:
 *         description: Validation failed
 */
router.put(
  '/me',
  authenticate,
  [
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('mobile').optional().isMobilePhone().withMessage('Valid mobile number required'),
  ],
  validate,
  userController.updateOwnProfile
);

/**
 * @swagger
 * /auth/me/profile-picture:
 *   post:
 *     summary: Upload/replace the current user's profile picture
 *     description: >
 *       Uploads the file to `users/{userId}/profile/...` in the GCS bucket
 *       and stores the resulting public URL on the user's row (replacing and
 *       deleting the previous picture, if any). Postgres stores only the URL.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Profile picture updated successfully
 *       400:
 *         description: Missing/oversized/unsupported file
 *       401:
 *         description: Not authenticated
 */
router.post(
  '/me/profile-picture',
  authenticate,
  uploadProfilePicture.single('file'),
  authController.uploadProfilePicture
);

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

/**
 * @swagger
 * /auth/users/{id}/activate:
 *   put:
 *     summary: Activate a pending_approval user (currently only reachable by self-registered brokers)
 *     description: >
 *       Allowed roles agency_admin, admin, super_admin. An agency_admin may
 *       only activate users within their own tenant; admin/super_admin can
 *       activate anyone. Only works while the target user's status is
 *       `pending_approval` — returns `400` otherwise.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User activated successfully
 *       400:
 *         description: User is not currently pending_approval
 *       403:
 *         description: Role not permitted, or agency_admin targeting a user outside their tenant
 *       404:
 *         description: User not found
 */
router.put(
  '/users/:id/activate',
  authenticate,
  authorize('agency_admin', 'admin', 'super_admin'),
  [param('id').isUUID().withMessage('Invalid user id')],
  validate,
  authController.activateUser
);

module.exports = router;