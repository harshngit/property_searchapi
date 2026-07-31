const pool = require('../config/db');
const { isAdmin } = require('../utils/ownership');
const notificationService = require('./notification.service');

function notFound(message = 'Task not found') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Non-admin roles see their own tasks (assigned or created); agency_admin
// additionally sees every task in their tenant; admin/super_admin see all.
function applyTaskScope(user, where, params) {
  if (isAdmin(user.role)) return;

  if (user.role === 'agency_admin') {
    params.push(user.tenant_id || null);
    where.push(`tenant_id = $${params.length}`);
    return;
  }

  params.push(user.id, user.id);
  where.push(`(assigned_to = $${params.length - 1} OR created_by = $${params.length})`);
}

// Flips any task whose due_date has passed into 'overdue' and raises a
// task_overdue notification to its assignee - run from every task-reading
// entry point in this service so the status is always fresh without
// needing a separate scheduled job.
async function syncOverdueTasks() {
  const result = await pool.query(
    `UPDATE tasks SET status = 'overdue'
     WHERE status IN ('pending', 'in_progress') AND due_date < now()
     RETURNING id, tenant_id, assigned_to, title`
  );

  for (const task of result.rows) {
    if (!task.assigned_to) continue;
    await notificationService.createNotification({
      userId: task.assigned_to,
      tenantId: task.tenant_id,
      type: 'task_overdue',
      title: 'Task overdue',
      message: `"${task.title}" is now overdue`,
      relatedEntityType: 'task',
      relatedEntityId: task.id,
    });
  }
}

async function listTasks(user, filters, page, limit) {
  await syncOverdueTasks();

  const where = [];
  const params = [];

  applyTaskScope(user, where, params);

  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.priority) {
    params.push(filters.priority);
    where.push(`priority = $${params.length}`);
  }
  if (filters.assignedTo) {
    params.push(filters.assignedTo);
    where.push(`assigned_to = $${params.length}`);
  }
  if (filters.dueDateFrom) {
    params.push(filters.dueDateFrom);
    where.push(`due_date >= $${params.length}`);
  }
  if (filters.dueDateTo) {
    params.push(filters.dueDateTo);
    where.push(`due_date <= $${params.length}`);
  }
  if (filters.relatedEntityType) {
    params.push(filters.relatedEntityType);
    where.push(`related_entity_type = $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM tasks ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM tasks
     ${whereClause}
     ORDER BY due_date ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows,
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

async function getTaskById(id) {
  await syncOverdueTasks();

  const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  const task = result.rows[0];
  if (!task) throw notFound();
  return task;
}

async function createTask(data, user) {
  const { title, description, relatedEntityType, relatedEntityId, assignedTo, dueDate, priority } = data;

  const result = await pool.query(
    `INSERT INTO tasks (
       tenant_id, title, description, related_entity_type, related_entity_id,
       assigned_to, created_by, due_date, priority, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING *`,
    [
      user.tenant_id || null,
      title,
      description || null,
      relatedEntityType || null,
      relatedEntityId || null,
      assignedTo || null,
      user.id,
      dueDate,
      priority || 'medium',
    ]
  );
  const task = result.rows[0];

  if (task.assigned_to && task.assigned_to !== user.id) {
    await notificationService.createNotification({
      userId: task.assigned_to,
      tenantId: task.tenant_id,
      type: 'task_assigned',
      title: 'New task assigned to you',
      message: task.title,
      relatedEntityType: 'task',
      relatedEntityId: task.id,
    });
  }

  return task;
}

const UPDATABLE_TASK_FIELDS = {
  title: 'title',
  description: 'description',
  relatedEntityType: 'related_entity_type',
  relatedEntityId: 'related_entity_id',
  dueDate: 'due_date',
  priority: 'priority',
};

// Status changes go exclusively through completeTask() (below), so the
// side effects of completion can never be bypassed via a generic edit.
async function updateTask(id, data, user) {
  const set = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_TASK_FIELDS)) {
    if (data[key] !== undefined) {
      params.push(data[key]);
      set.push(`${column} = $${params.length}`);
    }
  }

  let reassigned = false;
  if (data.assignedTo !== undefined) {
    params.push(data.assignedTo);
    set.push(`assigned_to = $${params.length}`);
    reassigned = true;
  }

  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(id);
  const result = await pool.query(
    `UPDATE tasks SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  const task = result.rows[0];

  if (reassigned && task.assigned_to && task.assigned_to !== user.id) {
    await notificationService.createNotification({
      userId: task.assigned_to,
      tenantId: task.tenant_id,
      type: 'task_assigned',
      title: 'Task assigned to you',
      message: task.title,
      relatedEntityType: 'task',
      relatedEntityId: task.id,
    });
  }

  return task;
}

async function completeTask(id, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
    if (current.rows.length === 0) throw notFound();
    const previous = current.rows[0];

    const result = await client.query(
      `UPDATE tasks SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    const task = result.rows[0];

    if (previous.created_by && previous.created_by !== user.id) {
      await notificationService.createNotification(
        {
          userId: previous.created_by,
          tenantId: task.tenant_id,
          type: 'task_completed',
          title: 'Task completed',
          message: `"${task.title}" was marked complete`,
          relatedEntityType: 'task',
          relatedEntityId: task.id,
        },
        client
      );
    }

    await client.query('COMMIT');
    return task;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getOverdueTasks(user) {
  await syncOverdueTasks();

  const where = [`status = 'overdue'`];
  const params = [];

  if (!isAdmin(user.role)) {
    params.push(user.id);
    where.push(`assigned_to = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY due_date ASC`,
    params
  );
  return result.rows;
}

async function getTodayTasks(user) {
  await syncOverdueTasks();

  const where = [`due_date::date = CURRENT_DATE`];
  const params = [];

  if (!isAdmin(user.role)) {
    params.push(user.id);
    where.push(`assigned_to = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY due_date ASC`,
    params
  );
  return result.rows;
}

async function getFollowups(user, page, limit) {
  await syncOverdueTasks();

  const where = [`related_entity_type = 'lead'`];
  const params = [];

  applyTaskScope(user, where, params);

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`SELECT COUNT(*) FROM tasks ${whereClause}`, params);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM tasks
     ${whereClause}
     ORDER BY due_date ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: result.rows,
    pagination: {
      page,
      limit,
      total: Number(countResult.rows[0].count),
      totalPages: Math.ceil(Number(countResult.rows[0].count) / limit),
    },
  };
}

// Used by the Broker CRM dashboard (GET /api/broker/followups) - tasks
// strictly assigned to this user, linked to a lead, due today or already
// overdue. Lives here (not broker.service.js) since this service owns all
// tasks-table querying.
async function getBrokerFollowups(userId) {
  await syncOverdueTasks();

  const result = await pool.query(
    `SELECT * FROM tasks
     WHERE assigned_to = $1
       AND related_entity_type = 'lead'
       AND status != 'completed'
       AND due_date::date <= CURRENT_DATE
     ORDER BY due_date ASC`,
    [userId]
  );
  return result.rows;
}

// Used by the Broker CRM dashboard summary - counts of this user's tasks
// due today and currently overdue.
async function getDashboardCounts(userId) {
  await syncOverdueTasks();

  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE due_date::date = CURRENT_DATE AND status != 'completed') AS due_today,
       COUNT(*) FILTER (WHERE status = 'overdue') AS overdue
     FROM tasks
     WHERE assigned_to = $1`,
    [userId]
  );

  return {
    tasksDueToday: Number(result.rows[0].due_today),
    overdueTasksCount: Number(result.rows[0].overdue),
  };
}

module.exports = {
  listTasks,
  getTaskById,
  createTask,
  updateTask,
  completeTask,
  getOverdueTasks,
  getTodayTasks,
  getFollowups,
  getBrokerFollowups,
  getDashboardCounts,
};
