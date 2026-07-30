const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const adminController = require('../controllers/admin.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

/**
 * @swagger
 * tags:
 *   name: Admin - User Invites
 *   description: >
 *     Restricted-role user creation. `agency_admin`, `builder`,
 *     `internal_sales`, `admin`, and `super_admin` are NOT created via
 *     /auth/register — they are invited here by an existing admin/super_admin
 *     and the invitee sets their own password via the accept-invite link.
 */

/**
 * @swagger
 * /admin/users/invite:
 *   post:
 *     summary: Invite a new admin-side user (agency_admin, builder, internal_sales, admin, super_admin)
 *     description: >
 *       - `super_admin` can invite: admin, agency_admin, builder, internal_sales, super_admin.
 *       - `admin` can invite: agency_admin, builder, internal_sales only.
 *     tags: [Admin - User Invites]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, email, role]
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: Suresh Rao
 *               email:
 *                 type: string
 *                 example: suresh@agency.com
 *               role:
 *                 type: string
 *                 enum: [admin, agency_admin, builder, internal_sales, super_admin]
 *                 example: agency_admin
 *               tenantId:
 *                 type: string
 *                 nullable: true
 *                 example: null
 *     responses:
 *       201:
 *         description: Invite created and sent
 *       403:
 *         description: Not authorized to invite this role
 *       409:
 *         description: User with this email already exists
 */
router.post(
  '/users/invite',
  authenticate,
  authorize('super_admin', 'admin'),
  [
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('role')
      .isIn(['admin', 'agency_admin', 'builder', 'internal_sales', 'super_admin'])
      .withMessage('Invalid role'),
  ],
  validate,
  adminController.inviteUser
);

/**
 * @swagger
 * /admin/users/invite/{token}/verify:
 *   get:
 *     summary: Verify an invite token before showing the accept-invite form
 *     tags: [Admin - User Invites]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Invite is valid
 *       400:
 *         description: Invite invalid or expired
 */
router.get(
  '/users/invite/:token/verify',
  [param('token').notEmpty()],
  validate,
  adminController.verifyInvite
);

/**
 * @swagger
 * /admin/users/accept-invite:
 *   post:
 *     summary: Accept an invite and set password to activate the account
 *     tags: [Admin - User Invites]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token:
 *                 type: string
 *               password:
 *                 type: string
 *                 example: Passw0rd!123
 *     responses:
 *       201:
 *         description: Account created successfully
 *       400:
 *         description: Invite invalid or expired
 */
router.post(
  '/users/accept-invite',
  [
    body('token').notEmpty().withMessage('Invite token is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate,
  adminController.acceptInvite
);

module.exports = router;
