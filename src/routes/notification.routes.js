const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const notificationController = require('../controllers/notification.controller');
const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const push = require('../services/push.service');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: The logged-in user's notification inbox.
 */

/**
 * @swagger
 * /notifications/unread-count:
 *   get:
 *     summary: Unread notification count for the header bell
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: "{ count }" }
 */
router.get('/unread-count', authenticate, notificationController.getUnreadCount);

/**
 * @swagger
 * /notifications/push:
 *   get:
 *     summary: Web push status for the caller - whether push is configured, the VAPID public key, how many browsers are subscribed
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ configured, publicKey, subscriptions }" } }
 *   post:
 *     summary: Subscribe this browser to push (PushSubscription.toJSON() from the service worker)
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint, keys]
 *             properties:
 *               endpoint: { type: string }
 *               keys: { type: object, properties: { p256dh: { type: string }, auth: { type: string } } }
 *               app: { type: string, enum: [website, crm] }
 *     responses: { 201: { description: Subscribed } }
 *   delete:
 *     summary: Unsubscribe this browser
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Removed } }
 */
router.get('/push', authenticate, asyncHandler(async (req, res) => success(res, 200, 'Push status', await push.status(req.user))));
router.post(
  '/push',
  authenticate,
  [body('endpoint').isString().isLength({ min: 10, max: 2000 }), body('keys.p256dh').isString(), body('keys.auth').isString(), body('app').optional().isIn(['website', 'crm'])],
  validate,
  asyncHandler(async (req, res) => success(res, 201, 'Push enabled on this device', await push.subscribe(req.user, req.body, req.headers['user-agent'])))
);
router.delete('/push', authenticate, [body('endpoint').isString()], validate, asyncHandler(async (req, res) => success(res, 200, 'Push disabled on this device', await push.unsubscribe(req.user, req.body))));

/**
 * @swagger
 * /notifications/push/test:
 *   post:
 *     summary: Send a test push to the caller's subscribed browsers
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: "{ sent, removed }" } }
 */
router.post('/push/test', authenticate, asyncHandler(async (req, res) => success(res, 200, 'Test push sent', await push.sendToUser(req.user.id, { title: 'PropertySerch', body: 'Push notifications are working on this device.', tag: 'test' }))));

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
