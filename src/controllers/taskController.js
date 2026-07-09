'use strict';

const {
  PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../config/awsConfig');
const { TASK_MANAGER_TABLE, ATTENDANCE_LOGS_TABLE } = require('../config/dbSetup');
const { hasPermission } = require('../services/permissionEngine');
const config = require('../config/env');

// ── Lazy-load S3 client to avoid breaking if SDK version differs ──────────────
let s3Client = null;
function getS3Client() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_STATUSES  = ['BACKLOG', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'COMPLETED', 'CANCELLED'];
const VALID_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const VALID_VISIBILITIES = ['PUBLIC', 'PRIVATE'];
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts workspaceId and actor identity from req.user.
 * Works for both admin (Cognito) and team member (custom JWT) tokens.
 */
function extractIdentity(req) {
  const user = req.user;
  if (user.isTeamMember) {
    return {
      workspaceId: user.userId,   // adminUserId stored in team-member JWT
      actorId: user.memberId,
      actorName: user.username || 'Unknown',
      isAdmin: false,
    };
  }
  return {
    workspaceId: user.userId,
    actorId: user.userId,
    actorName: user.name || user.email || 'Admin',
    isAdmin: true,
  };
}

/**
 * Builds a PK/SK pair for the task-manager table.
 */
function taskKey(workspaceId, taskId) {
  return { PK: `WORKSPACE#${workspaceId}`, SK: `TASK#${taskId}` };
}

/**
 * Appends an activity log entry to an existing array.
 */
function buildActivityLog(type, actorId, actorName, data = {}) {
  return {
    logId: uuidv4(),
    type,
    actorId,
    actorName,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Recursively calculates completion % from a subtask tree.
 */
function calcProgress(subtasks = []) {
  if (!subtasks.length) return 0;
  let total = 0, completed = 0;
  function walk(items) {
    for (const st of items) {
      total++;
      if (st.completed) completed++;
      if (st.subtasks && st.subtasks.length) walk(st.subtasks);
    }
  }
  walk(subtasks);
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}

/**
 * Checks whether a task is visible to the requesting user.
 * Private tasks are only visible to: creator, assignees, admin, MANAGE_TASKS holders.
 */
async function canViewTask(task, workspaceId, actorId, isAdmin) {
  if (task.visibility !== 'PRIVATE') return true;
  if (isAdmin) return true;
  if (task.createdBy === actorId) return true;
  if (task.assignedUsers && task.assignedUsers.includes(actorId)) return true;

  // Check VIEW_PRIVATE_TASKS permission
  const allowed = await hasPermission(workspaceId, actorId, 'VIEW_PRIVATE_TASKS');
  return allowed;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/tasks
 * Lists tasks with optional filters and cursor-based pagination.
 *
 * Query params: status, priority, visibility, assignedTo, tags,
 *               search, page, limit, sortBy (dueDate|createdAt)
 */
async function listTasks(req, res, next) {
  try {
    const { workspaceId, actorId, isAdmin } = extractIdentity(req);
    const {
      status, priority, visibility, assignedTo, search, channelId,
      limit: rawLimit, lastKey,
    } = req.query;

    const limit = Math.min(parseInt(rawLimit) || DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

    const queryParams = {
      TableName: TASK_MANAGER_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `WORKSPACE#${workspaceId}` },
      Limit: limit,
    };

    if (lastKey) {
      try { queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(lastKey, 'base64').toString()); }
      catch (_) { /* invalid cursor — ignore */ }
    }

    const result = await dynamoDbClient.send(new QueryCommand(queryParams));
    let tasks = (result.Items || []);

    // Apply filters (DynamoDB FilterExpression could be used for efficiency,
    // but for clarity we filter in JS since all data is in memory after the query)
    if (channelId) tasks = tasks.filter(t => t.channelId === channelId);
    if (status) tasks = tasks.filter(t => t.status === status.toUpperCase());
    if (priority) tasks = tasks.filter(t => t.priority === priority.toUpperCase());
    if (visibility) tasks = tasks.filter(t => t.visibility === visibility.toUpperCase());
    if (assignedTo) {
      tasks = tasks.filter(t =>
        (t.assignedUsers || []).includes(assignedTo) ||
        (t.assignedRoles || []).includes(assignedTo)
      );
    }
    if (search) {
      const q = search.toLowerCase();
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.tags || []).some(tag => tag.toLowerCase().includes(q))
      );
    }

    // Filter private tasks the user cannot see
    const visibleTasks = [];
    for (const task of tasks) {
      if (await canViewTask(task, workspaceId, actorId, isAdmin)) {
        visibleTasks.push(mapTaskToResponse(task));
      }
    }

    const nextCursor = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return res.status(200).json({
      success: true,
      data: visibleTasks,
      nextCursor,
      count: visibleTasks.length,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/tasks
 * Creates a new task. Requires CREATE_TASK permission.
 */
async function createTask(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const {
      title, description = '', priority = 'MEDIUM', status = 'BACKLOG',
      visibility = 'PUBLIC', assignedUsers = [], assignedRoles = [],
      tags = [], estimatedHours = 0, dueDate = null, startDate = null,
      recurrenceRule = null, parentTaskId = null, channelId = null,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Task title is required.' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Valid: ${VALID_STATUSES.join(', ')}` });
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, message: `Invalid priority. Valid: ${VALID_PRIORITIES.join(', ')}` });
    }

    const taskId = uuidv4();
    const now = new Date().toISOString();

    const item = {
      PK: `WORKSPACE#${workspaceId}`,
      SK: `TASK#${taskId}`,
      taskId,
      workspaceId,
      channelId,
      title: title.trim(),
      description,
      priority,
      status,
      visibility,
      assignedUsers,
      assignedRoles,
      subtasks: [],
      attachments: [],
      comments: [],
      activityLogs: [buildActivityLog('TASK_CREATED', actorId, actorName, { title: title.trim(), status })],
      tags,
      estimatedHours: Number(estimatedHours) || 0,
      trackedTime: [],
      dueDate: dueDate || 'NONE',
      startDate: startDate || null,
      recurrenceRule: recurrenceRule || null,
      parentTaskId: parentTaskId || null,
      progress: 0,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
      // GSI projection attributes
      assigneeKey: assignedUsers.length > 0
        ? `USER#${assignedUsers[0]}`
        : assignedRoles.length > 0
          ? `ROLE#${assignedRoles[0]}`
          : 'UNASSIGNED',
    };

    await dynamoDbClient.send(new PutCommand({ TableName: TASK_MANAGER_TABLE, Item: item }));

    return res.status(201).json({ success: true, data: mapTaskToResponse(item) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tasks/:taskId
 * Returns a single task. Enforces private visibility.
 */
async function getTask(req, res, next) {
  try {
    const { workspaceId, actorId, isAdmin } = extractIdentity(req);
    const { taskId } = req.params;

    const result = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
    }));

    if (!result.Item) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    if (!(await canViewTask(result.Item, workspaceId, actorId, isAdmin))) {
      return res.status(403).json({ success: false, message: 'Access denied: private task.' });
    }

    return res.status(200).json({ success: true, data: mapTaskToResponse(result.Item) });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/tasks/:taskId
 * Updates task fields. Requires EDIT_TASK permission.
 */
async function updateTask(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const {
      title, description, priority, visibility, tags,
      estimatedHours, dueDate, startDate, recurrenceRule,
    } = req.body;

    const now = new Date().toISOString();
    const updates = [];
    const exprValues = { ':upd': now };
    const exprNames = {};
    const changes = [];

    if (title !== undefined) {
      updates.push('#title = :title');
      exprValues[':title'] = title.trim();
      exprNames['#title'] = 'title';
      if (existing.Item.title !== title.trim()) changes.push({ field: 'title', before: existing.Item.title, after: title.trim() });
    }
    if (description !== undefined) { updates.push('description = :desc'); exprValues[':desc'] = description; }
    if (priority !== undefined && VALID_PRIORITIES.includes(priority)) {
      updates.push('priority = :priority'); exprValues[':priority'] = priority;
      if (existing.Item.priority !== priority) changes.push({ field: 'priority', before: existing.Item.priority, after: priority });
    }
    if (visibility !== undefined && VALID_VISIBILITIES.includes(visibility)) {
      updates.push('visibility = :visibility'); exprValues[':visibility'] = visibility;
    }
    if (tags !== undefined) { updates.push('tags = :tags'); exprValues[':tags'] = tags; }
    if (estimatedHours !== undefined) { updates.push('estimatedHours = :est'); exprValues[':est'] = Number(estimatedHours); }
    if (dueDate !== undefined) { updates.push('dueDate = :dueDate'); exprValues[':dueDate'] = dueDate || 'NONE'; }
    if (startDate !== undefined) { updates.push('startDate = :startDate'); exprValues[':startDate'] = startDate; }
    if (recurrenceRule !== undefined) { updates.push('recurrenceRule = :rec'); exprValues[':rec'] = recurrenceRule; }

    if (!updates.length) {
      return res.status(400).json({ success: false, message: 'No valid fields to update.' });
    }

    const logEntry = buildActivityLog('TASK_UPDATED', actorId, actorName, { changes });
    const existingLogs = existing.Item.activityLogs || [];

    const result = await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: `SET ${updates.join(', ')}, updatedAt = :upd, activityLogs = :logs`,
      ExpressionAttributeValues: {
        ...exprValues,
        ':logs': [...existingLogs, logEntry].slice(-100), // keep last 100 logs
      },
      ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
      ReturnValues: 'ALL_NEW',
    }));

    return res.status(200).json({ success: true, data: mapTaskToResponse(result.Attributes) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/tasks/:taskId
 * Deletes a task. Requires DELETE_TASK permission.
 */
async function deleteTask(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    await dynamoDbClient.send(new DeleteCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));

    return res.status(200).json({ success: true, message: 'Task deleted.' });
  } catch (err) {
    next(err);
  }
}

// ── STATUS ────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/tasks/:taskId/status
 * Changes task status. Logs the transition.
 */
async function changeStatus(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;
    const { status } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Valid: ${VALID_STATUSES.join(', ')}` });
    }

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const prevStatus = existing.Item.status;
    const logEntry = buildActivityLog('STATUS_CHANGED', actorId, actorName, { from: prevStatus, to: status });
    const existingLogs = existing.Item.activityLogs || [];

    const result = await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET #status = :status, updatedAt = :upd, activityLogs = :logs',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':upd': new Date().toISOString(),
        ':logs': [...existingLogs, logEntry].slice(-100),
      },
      ReturnValues: 'ALL_NEW',
    }));

    return res.status(200).json({ success: true, data: mapTaskToResponse(result.Attributes) });
  } catch (err) {
    next(err);
  }
}

// ── ASSIGNMENT ────────────────────────────────────────────────────────────────

/**
 * PATCH /api/tasks/:taskId/assign
 * Assigns users and/or roles to a task.
 */
async function assignTask(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;
    const { assignedUsers = [], assignedRoles = [] } = req.body;

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const logEntry = buildActivityLog('TASK_ASSIGNED', actorId, actorName, { assignedUsers, assignedRoles });
    const existingLogs = existing.Item.activityLogs || [];

    const newStatus = existing.Item.status === 'BACKLOG' && (assignedUsers.length || assignedRoles.length)
      ? 'ASSIGNED'
      : existing.Item.status;

    const assigneeKey = assignedUsers.length > 0
      ? `USER#${assignedUsers[0]}`
      : assignedRoles.length > 0
        ? `ROLE#${assignedRoles[0]}`
        : 'UNASSIGNED';

    const result = await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET assignedUsers = :users, assignedRoles = :roles, assigneeKey = :akey, #status = :status, updatedAt = :upd, activityLogs = :logs',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':users': assignedUsers,
        ':roles': assignedRoles,
        ':akey': assigneeKey,
        ':status': newStatus,
        ':upd': new Date().toISOString(),
        ':logs': [...existingLogs, logEntry].slice(-100),
      },
      ReturnValues: 'ALL_NEW',
    }));

    return res.status(200).json({ success: true, data: mapTaskToResponse(result.Attributes) });
  } catch (err) {
    next(err);
  }
}

// ── COMMENTS ─────────────────────────────────────────────────────────────────

/**
 * POST /api/tasks/:taskId/comments
 * Adds a comment to a task.
 */
async function addComment(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: 'Comment content is required.' });
    }

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    if (!(await canViewTask(existing.Item, workspaceId, actorId, false))) {
      return res.status(403).json({ success: false, message: 'Access denied: private task.' });
    }

    const now = new Date().toISOString();
    const comment = {
      commentId: uuidv4(),
      authorId: actorId,
      authorName: actorName,
      content: content.trim(),
      createdAt: now,
      editedAt: null,
    };

    const logEntry = buildActivityLog('COMMENT_ADDED', actorId, actorName, { commentId: comment.commentId });
    const existingComments = existing.Item.comments || [];
    const existingLogs = existing.Item.activityLogs || [];

    await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET comments = :comments, activityLogs = :logs, updatedAt = :upd',
      ExpressionAttributeValues: {
        ':comments': [...existingComments, comment],
        ':logs': [...existingLogs, logEntry].slice(-100),
        ':upd': now,
      },
    }));

    return res.status(201).json({ success: true, data: comment });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/tasks/:taskId/comments/:commentId
 * Deletes a comment (own comment or MANAGE_TASKS).
 */
async function deleteComment(req, res, next) {
  try {
    const { workspaceId, actorId, isAdmin } = extractIdentity(req);
    const { taskId, commentId } = req.params;

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const comment = (existing.Item.comments || []).find(c => c.commentId === commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found.' });

    const canDelete = isAdmin || comment.authorId === actorId ||
      await hasPermission(workspaceId, actorId, 'MANAGE_TASKS');

    if (!canDelete) return res.status(403).json({ success: false, message: 'Cannot delete this comment.' });

    const updatedComments = (existing.Item.comments || []).filter(c => c.commentId !== commentId);

    await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET comments = :comments, updatedAt = :upd',
      ExpressionAttributeValues: { ':comments': updatedComments, ':upd': new Date().toISOString() },
    }));

    return res.status(200).json({ success: true, message: 'Comment deleted.' });
  } catch (err) {
    next(err);
  }
}

// ── SUBTASKS ──────────────────────────────────────────────────────────────────

/**
 * POST /api/tasks/:taskId/subtasks
 * Creates a subtask (or nested subtask via parentSubtaskId in body).
 */
async function createSubtask(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;
    const { title, parentSubtaskId = null, assignedUsers = [] } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Subtask title is required.' });
    }

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const newSubtask = {
      subtaskId: uuidv4(),
      title: title.trim(),
      completed: false,
      assignedUsers,
      subtasks: [],
      createdAt: new Date().toISOString(),
    };

    let subtasks = existing.Item.subtasks || [];

    if (parentSubtaskId) {
      // Insert into nested position
      function insertNested(items) {
        return items.map(st => {
          if (st.subtaskId === parentSubtaskId) {
            return { ...st, subtasks: [...(st.subtasks || []), newSubtask] };
          }
          if (st.subtasks && st.subtasks.length) {
            return { ...st, subtasks: insertNested(st.subtasks) };
          }
          return st;
        });
      }
      subtasks = insertNested(subtasks);
    } else {
      subtasks = [...subtasks, newSubtask];
    }

    const progress = calcProgress(subtasks);
    const logEntry = buildActivityLog('SUBTASK_CREATED', actorId, actorName, { title: title.trim() });
    const existingLogs = existing.Item.activityLogs || [];

    await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET subtasks = :subtasks, progress = :progress, activityLogs = :logs, updatedAt = :upd',
      ExpressionAttributeValues: {
        ':subtasks': subtasks,
        ':progress': progress,
        ':logs': [...existingLogs, logEntry].slice(-100),
        ':upd': new Date().toISOString(),
      },
    }));

    return res.status(201).json({ success: true, data: newSubtask });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/tasks/:taskId/subtasks/:subtaskId
 * Updates a subtask (title or completed status).
 */
async function updateSubtask(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId, subtaskId } = req.params;
    const { title, completed, assignedUsers } = req.body;

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    function updateNested(items) {
      return items.map(st => {
        if (st.subtaskId === subtaskId) {
          return {
            ...st,
            ...(title !== undefined && { title: title.trim() }),
            ...(completed !== undefined && { completed }),
            ...(assignedUsers !== undefined && { assignedUsers }),
          };
        }
        if (st.subtasks && st.subtasks.length) {
          return { ...st, subtasks: updateNested(st.subtasks) };
        }
        return st;
      });
    }

    const updatedSubtasks = updateNested(existing.Item.subtasks || []);
    const progress = calcProgress(updatedSubtasks);

    const logType = completed !== undefined ? (completed ? 'SUBTASK_COMPLETED' : 'SUBTASK_REOPENED') : 'SUBTASK_UPDATED';
    const logEntry = buildActivityLog(logType, actorId, actorName, { subtaskId });
    const existingLogs = existing.Item.activityLogs || [];

    await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET subtasks = :subtasks, progress = :progress, activityLogs = :logs, updatedAt = :upd',
      ExpressionAttributeValues: {
        ':subtasks': updatedSubtasks,
        ':progress': progress,
        ':logs': [...existingLogs, logEntry].slice(-100),
        ':upd': new Date().toISOString(),
      },
    }));

    if (completed === true) {
      const now = new Date();
      // TTL: 1 year from now
      const ttl = Math.floor(now.getTime() / 1000) + (365 * 24 * 60 * 60);
      
      let subtaskItem = null;
      function findSubtask(items) {
        if (!items) return;
        for (const st of items) {
          if (st.subtaskId === subtaskId) {
            subtaskItem = st;
            return;
          }
          findSubtask(st.subtasks);
        }
      }
      findSubtask(existing.Item.subtasks);
      
      const stTitle = title || (subtaskItem ? subtaskItem.title : 'Unknown Subtask');
      
      await dynamoDbClient.send(new PutCommand({
        TableName: ATTENDANCE_LOGS_TABLE,
        Item: {
          PK: `ADMIN#${workspaceId}`,
          SK: `TASK_COMPLETION#${actorId}#${now.toISOString()}`,
          adminUserId: workspaceId,
          type: 'SUBTASK_COMPLETION',
          memberId: actorId,
          username: actorName,
          taskId,
          taskTitle: existing.Item.title,
          subtaskId,
          subtaskTitle: stTitle,
          completedAt: now.toISOString(),
          date: now.toISOString().split('T')[0],
          ttl,
        },
      }));
    }

    return res.status(200).json({ success: true, data: { subtaskId, progress } });
  } catch (err) {
    next(err);
  }
}

// ── TIME TRACKING ─────────────────────────────────────────────────────────────

/**
 * POST /api/tasks/:taskId/time/start
 * Starts a new timer session for the current user.
 */
async function startTimer(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const trackedTime = existing.Item.trackedTime || [];

    // Check if user already has an open session
    const hasOpen = trackedTime.some(s => s.memberId === actorId && !s.stoppedAt);
    if (hasOpen) {
      return res.status(409).json({ success: false, message: 'Timer already running for this task.' });
    }

    const now = new Date().toISOString();
    const session = { sessionId: uuidv4(), memberId: actorId, memberName: actorName, startedAt: now, stoppedAt: null, durationMs: 0 };
    const logEntry = buildActivityLog('TIMER_STARTED', actorId, actorName, {});
    const existingLogs = existing.Item.activityLogs || [];

    await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET trackedTime = :tt, activityLogs = :logs, updatedAt = :upd',
      ExpressionAttributeValues: {
        ':tt': [...trackedTime, session],
        ':logs': [...existingLogs, logEntry].slice(-100),
        ':upd': now,
      },
    }));

    return res.status(200).json({ success: true, data: session });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/tasks/:taskId/time/stop
 * Stops the active timer session for the current user.
 */
async function stopTimer(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const now = new Date();
    const trackedTime = (existing.Item.trackedTime || []).map(s => {
      if (s.memberId === actorId && !s.stoppedAt) {
        const durationMs = now.getTime() - new Date(s.startedAt).getTime();
        return { ...s, stoppedAt: now.toISOString(), durationMs };
      }
      return s;
    });

    const totalTrackedMs = trackedTime.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const trackedHours = Math.round((totalTrackedMs / 3600000) * 100) / 100;

    const logEntry = buildActivityLog('TIMER_STOPPED', actorId, actorName, { trackedHours });
    const existingLogs = existing.Item.activityLogs || [];

    await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET trackedTime = :tt, trackedHours = :th, activityLogs = :logs, updatedAt = :upd',
      ExpressionAttributeValues: {
        ':tt': trackedTime,
        ':th': trackedHours,
        ':logs': [...existingLogs, logEntry].slice(-100),
        ':upd': now.toISOString(),
      },
    }));

    return res.status(200).json({ success: true, data: { trackedHours, sessions: trackedTime } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tasks/:taskId/time
 * Returns detailed time tracking data for a task.
 */
async function getTimeSessions(req, res, next) {
  try {
    const { workspaceId } = extractIdentity(req);
    const { taskId } = req.params;

    const result = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!result.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const sessions = result.Item.trackedTime || [];
    const byMember = {};
    sessions.forEach(s => {
      if (!byMember[s.memberId]) byMember[s.memberId] = { memberId: s.memberId, memberName: s.memberName, totalMs: 0, sessions: [] };
      byMember[s.memberId].totalMs += s.durationMs || 0;
      byMember[s.memberId].sessions.push(s);
    });

    const totalMs = sessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);

    return res.status(200).json({
      success: true,
      data: {
        totalHours: Math.round((totalMs / 3600000) * 100) / 100,
        byMember: Object.values(byMember),
        sessions,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── ATTACHMENTS ───────────────────────────────────────────────────────────────

/**
 * POST /api/tasks/:taskId/attachments/presign
 * Returns a presigned S3 upload URL for a file attachment.
 */
async function presignAttachment(req, res, next) {
  try {
    const { workspaceId, actorId, actorName } = extractIdentity(req);
    const { taskId } = req.params;
    const { fileName, contentType = 'application/octet-stream' } = req.body;

    if (!fileName) return res.status(400).json({ success: false, message: 'fileName is required.' });

    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: TASK_MANAGER_TABLE, Key: taskKey(workspaceId, taskId),
    }));
    if (!existing.Item) return res.status(404).json({ success: false, message: 'Task not found.' });

    const attachmentId = uuidv4();
    const s3Key = `tasks/${workspaceId}/${taskId}/${attachmentId}/${fileName}`;

    const s3 = getS3Client();
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: config.S3_BUCKET_NAME, Key: s3Key, ContentType: contentType }),
      { expiresIn: 3600 }
    );

    const attachment = {
      attachmentId, fileName, s3Key,
      uploadedBy: actorId, uploadedByName: actorName,
      uploadedAt: new Date().toISOString(),
      contentType,
    };

    const existingAttachments = existing.Item.attachments || [];
    const logEntry = buildActivityLog('FILE_UPLOADED', actorId, actorName, { fileName });
    const existingLogs = existing.Item.activityLogs || [];

    await dynamoDbClient.send(new UpdateCommand({
      TableName: TASK_MANAGER_TABLE,
      Key: taskKey(workspaceId, taskId),
      UpdateExpression: 'SET attachments = :atts, activityLogs = :logs, updatedAt = :upd',
      ExpressionAttributeValues: {
        ':atts': [...existingAttachments, attachment],
        ':logs': [...existingLogs, logEntry].slice(-100),
        ':upd': new Date().toISOString(),
      },
    }));

    return res.status(200).json({ success: true, data: { uploadUrl, attachment } });
  } catch (err) {
    next(err);
  }
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────

/**
 * GET /api/tasks/analytics
 * Returns workspace-level productivity analytics.
 */
async function getAnalytics(req, res, next) {
  try {
    const { workspaceId } = extractIdentity(req);

    const result = await dynamoDbClient.send(new QueryCommand({
      TableName: TASK_MANAGER_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `WORKSPACE#${workspaceId}` },
    }));

    const tasks = result.Items || [];
    const now = new Date();

    const statusCounts = {};
    VALID_STATUSES.forEach(s => (statusCounts[s] = 0));

    const priorityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    let totalTrackedMs = 0;
    let completedThisWeek = 0;
    let overdue = 0;
    const memberHours = {};

    tasks.forEach(t => {
      if (t.status) statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
      if (t.priority) priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1;

      // Overdue
      if (t.dueDate && t.dueDate !== 'NONE' && t.status !== 'COMPLETED' && t.status !== 'CANCELLED') {
        if (new Date(t.dueDate) < now) overdue++;
      }

      // Completed this week
      if (t.status === 'COMPLETED' && t.updatedAt) {
        const updDate = new Date(t.updatedAt);
        const msInWeek = 7 * 24 * 60 * 60 * 1000;
        if (now - updDate < msInWeek) completedThisWeek++;
      }

      // Time tracking
      (t.trackedTime || []).forEach(s => {
        totalTrackedMs += s.durationMs || 0;
        if (!memberHours[s.memberId]) memberHours[s.memberId] = { memberId: s.memberId, memberName: s.memberName, totalMs: 0 };
        memberHours[s.memberId].totalMs += s.durationMs || 0;
      });
    });

    const topMembers = Object.values(memberHours)
      .map(m => ({ ...m, totalHours: Math.round((m.totalMs / 3600000) * 100) / 100 }))
      .sort((a, b) => b.totalHours - a.totalHours)
      .slice(0, 10);

    return res.status(200).json({
      success: true,
      data: {
        totalTasks: tasks.length,
        statusCounts,
        priorityCounts,
        totalTrackedHours: Math.round((totalTrackedMs / 3600000) * 100) / 100,
        completedThisWeek,
        overdueCount: overdue,
        completionRate: tasks.length > 0 ? Math.round((statusCounts['COMPLETED'] / tasks.length) * 100) : 0,
        topMembers,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── RESPONSE MAPPER ───────────────────────────────────────────────────────────

function mapTaskToResponse(item) {
  return {
    taskId: item.taskId,
    workspaceId: item.workspaceId,
    title: item.title,
    description: item.description || '',
    priority: item.priority,
    status: item.status,
    visibility: item.visibility || 'PUBLIC',
    assignedUsers: item.assignedUsers || [],
    assignedRoles: item.assignedRoles || [],
    subtasks: item.subtasks || [],
    attachments: item.attachments || [],
    comments: item.comments || [],
    activityLogs: item.activityLogs || [],
    tags: item.tags || [],
    estimatedHours: item.estimatedHours || 0,
    trackedHours: item.trackedHours || 0,
    trackedTime: item.trackedTime || [],
    dueDate: item.dueDate === 'NONE' ? null : (item.dueDate || null),
    startDate: item.startDate || null,
    recurrenceRule: item.recurrenceRule || null,
    parentTaskId: item.parentTaskId || null,
    progress: item.progress || 0,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

module.exports = {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  changeStatus,
  assignTask,
  addComment,
  deleteComment,
  createSubtask,
  updateSubtask,
  startTimer,
  stopTimer,
  getTimeSessions,
  presignAttachment,
  getAnalytics,
};
