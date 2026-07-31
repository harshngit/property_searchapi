const express = require('express');
const { body, param, query } = require('express-validator');

const taskController = require('../controllers/task.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');

const TASK_PRIORITIES = ['low', 'medium', 'high'];
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'overdue'];
const RELATED_ENTITY_TYPES = ['lead', 'customer', 'deal', 'property'];
const CREATE_ROLES = ['broker', 'agency_admin', 'internal_sales', 'admin', 'super_admin'];

const taskRouter = express.Router();
const followupRouter = express.Router();

/**
 * @swagger
 * tags:
 *   name: Tasks
 *   description: >
 *     Tasks & follow-ups. All endpoints require authentication and are
 *     tenant-scoped for non-admin roles: brokers/internal_sales see only
 *     tasks they created or are assigned; agency_admin sees every task in
 *     their tenant; admin/super_admin see everything.
 */

/**
 * @swagger
 * /tasks:
 *   get:
 *     summary: List tasks (scoped per role - see tag description)
 *     tags: [Tasks]
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
 *         name: status
 *         schema: { type: string, enum: [pending, in_progress, completed, overdue] }
 *       - in: query
 *         name: priority
 *         schema: { type: string, enum: [low, medium, high] }
 *       - in: query
 *         name: assignedTo
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: dueDateFrom
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: dueDateTo
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Paginated list of tasks
 *       401:
 *         description: Not authenticated
 */
taskRouter.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(TASK_STATUSES),
    query('priority').optional().isIn(TASK_PRIORITIES),
    query('assignedTo').optional().isUUID(),
    query('dueDateFrom').optional().isISO8601(),
    query('dueDateTo').optional().isISO8601(),
  ],
  validate,
  taskController.listTasks
);

/**
 * @swagger
 * /tasks/overdue:
 *   get:
 *     summary: List overdue tasks (scoped to the current user, or all for admin/super_admin)
 *     description: Overdue status is computed automatically - any pending/in_progress task past its due_date is flipped to `overdue` (and its assignee notified) before this list is built.
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Overdue tasks fetched successfully
 */
taskRouter.get('/overdue', authenticate, taskController.getOverdueTasks);

/**
 * @swagger
 * /tasks/today:
 *   get:
 *     summary: List tasks due today (scoped to the current user, or all for admin/super_admin)
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Today's tasks fetched successfully
 */
taskRouter.get('/today', authenticate, taskController.getTodayTasks);

/**
 * @swagger
 * /tasks:
 *   post:
 *     summary: Create a new task
 *     description: Allowed roles broker, agency_admin, internal_sales, admin, super_admin. If assigned to someone other than the creator, a `task_assigned` notification is raised automatically.
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TaskCreateRequest'
 *     responses:
 *       201:
 *         description: Task created successfully
 *       403:
 *         description: Role not permitted to create tasks
 *       422:
 *         description: Validation failed
 */
taskRouter.post(
  '/',
  authenticate,
  authorize(...CREATE_ROLES),
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('dueDate').isISO8601().withMessage('A valid dueDate is required'),
    body('priority').optional().isIn(TASK_PRIORITIES),
    body('relatedEntityType').optional().isIn(RELATED_ENTITY_TYPES),
    body('relatedEntityId').optional().isUUID(),
    body('assignedTo').optional().isUUID(),
  ],
  validate,
  taskController.createTask
);

/**
 * @swagger
 * /tasks/{id}:
 *   put:
 *     summary: Update a task (title, description, due date, priority, relation, or reassignment)
 *     description: Only the task's creator, assignee, an agency_admin within the same tenant, or admin/super_admin may update. Status transitions to `completed` only happen via `PUT /tasks/{id}/complete`. Reassigning raises a `task_assigned` notification to the new assignee.
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TaskUpdateRequest'
 *     responses:
 *       200:
 *         description: Task updated successfully
 *       403:
 *         description: Not the owner/assignee/tenant manager/admin
 *       404:
 *         description: Task not found
 */
taskRouter.put(
  '/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid task id'),
    body('dueDate').optional().isISO8601(),
    body('priority').optional().isIn(TASK_PRIORITIES),
    body('relatedEntityType').optional().isIn(RELATED_ENTITY_TYPES),
    body('relatedEntityId').optional().isUUID(),
    body('assignedTo').optional().isUUID(),
  ],
  validate,
  taskController.updateTask
);

/**
 * @swagger
 * /tasks/{id}/complete:
 *   put:
 *     summary: Mark a task as completed
 *     description: Sets status to `completed` and completed_at to now(). If the completer is not the task's creator, a `task_completed` notification is raised to the creator automatically.
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Task marked as completed
 *       403:
 *         description: Not the owner/assignee/tenant manager/admin
 *       404:
 *         description: Task not found
 */
taskRouter.put(
  '/:id/complete',
  authenticate,
  [param('id').isUUID().withMessage('Invalid task id')],
  validate,
  taskController.completeTask
);

/**
 * @swagger
 * /followups:
 *   get:
 *     summary: List follow-up tasks (tasks linked to a lead), sorted by due date ascending
 *     description: An alias view over the tasks table, scoped the same way as GET /tasks, filtered to `related_entity_type = 'lead'`.
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated list of lead follow-up tasks
 *       401:
 *         description: Not authenticated
 */
followupRouter.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  taskController.getFollowups
);

module.exports = { taskRouter, followupRouter };
