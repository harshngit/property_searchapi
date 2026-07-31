const notificationService = require('../services/notification.service');
const { success } = require('../utils/response');

// GET /api/notifications
async function listNotifications(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      isRead: req.query.isRead !== undefined ? req.query.isRead === 'true' : undefined,
    };

    const { items, pagination } = await notificationService.listNotifications(
      req.user.id,
      filters,
      page,
      limit
    );
    return success(res, 200, 'Notifications fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// PUT /api/notifications/:id/read
async function markRead(req, res, next) {
  try {
    const notification = await notificationService.markRead(req.params.id, req.user.id);
    return success(res, 200, 'Notification marked as read', notification);
  } catch (err) {
    next(err);
  }
}

// PUT /api/notifications/read-all
async function markAllRead(req, res, next) {
  try {
    const result = await notificationService.markAllRead(req.user.id);
    return success(res, 200, 'All notifications marked as read', result);
  } catch (err) {
    next(err);
  }
}

module.exports = { listNotifications, markRead, markAllRead };
