const taskService = require('../services/task.service');
const { success } = require('../utils/response');
const { assertOwnerOrAdmin } = require('../utils/ownership');

const TASK_OWNER_FIELDS = ['created_by', 'assigned_to'];

// GET /api/tasks
async function listTasks(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      status: req.query.status,
      priority: req.query.priority,
      assignedTo: req.query.assignedTo,
      dueDateFrom: req.query.dueDateFrom,
      dueDateTo: req.query.dueDateTo,
    };

    const { items, pagination } = await taskService.listTasks(req.user, filters, page, limit);
    return success(res, 200, 'Tasks fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// POST /api/tasks
async function createTask(req, res, next) {
  try {
    const task = await taskService.createTask(req.body, req.user);
    return success(res, 201, 'Task created successfully', task);
  } catch (err) {
    next(err);
  }
}

// PUT /api/tasks/:id
async function updateTask(req, res, next) {
  try {
    const existing = await taskService.getTaskById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: TASK_OWNER_FIELDS,
    });

    const task = await taskService.updateTask(req.params.id, req.body, req.user);
    return success(res, 200, 'Task updated successfully', task);
  } catch (err) {
    next(err);
  }
}

// PUT /api/tasks/:id/complete
async function completeTask(req, res, next) {
  try {
    const existing = await taskService.getTaskById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: TASK_OWNER_FIELDS,
    });

    const task = await taskService.completeTask(req.params.id, req.user);
    return success(res, 200, 'Task marked as completed', task);
  } catch (err) {
    next(err);
  }
}

// GET /api/tasks/overdue
async function getOverdueTasks(req, res, next) {
  try {
    const tasks = await taskService.getOverdueTasks(req.user);
    return success(res, 200, 'Overdue tasks fetched successfully', tasks);
  } catch (err) {
    next(err);
  }
}

// GET /api/tasks/today
async function getTodayTasks(req, res, next) {
  try {
    const tasks = await taskService.getTodayTasks(req.user);
    return success(res, 200, "Today's tasks fetched successfully", tasks);
  } catch (err) {
    next(err);
  }
}

// GET /api/followups
async function getFollowups(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const { items, pagination } = await taskService.getFollowups(req.user, page, limit);
    return success(res, 200, 'Follow-ups fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listTasks,
  createTask,
  updateTask,
  completeTask,
  getOverdueTasks,
  getTodayTasks,
  getFollowups,
};
