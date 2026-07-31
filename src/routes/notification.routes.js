const express = require('express');
const { param, query } = require('express-validator');
const router = express.Router();

const notificationController = require('../controllers/notification.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: The logged-in user's notification inbox.
 */

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: List the current user's notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: isRead
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Paginated list of notifications
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('isRead').optional().isBoolean(),
  ],
  validate,
  notificationController.listNotifications
);

/**
 * @swagger
 * /notifications/{id}/read:
 *   put:
 *     summary: Mark a single notification as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Notification marked as read
 *       404:
 *         description: Notification not found (or does not belong to the caller)
 */
router.put(
  '/:id/read',
  authenticate,
  [param('id').isUUID().withMessage('Invalid notification id')],
  validate,
  notificationController.markRead
);

/**
 * @swagger
 * /notifications/read-all:
 *   put:
 *     summary: Mark all of the current user's notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
 */
router.put('/read-all', authenticate, notificationController.markAllRead);

module.exports = router;
