'use strict';

const cron = require('node-cron');
const { QueryCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../config/awsConfig');
const { TASK_MANAGER_TABLE } = require('../config/dbSetup');

/**
 * Recurring Task Engine
 *
 * Runs nightly at 00:05. Scans for COMPLETED tasks that have a recurrenceRule.
 * For each match, creates a new task cloning the parent — reset to BACKLOG,
 * cleared trackedTime and activityLogs, advanced dates to the next occurrence.
 *
 * Recurrence frequencies supported:
 *   DAILY   — next occurrence = today + interval days
 *   WEEKLY  — next occurrence = today + interval weeks
 *   MONTHLY — next occurrence = today + interval months
 *   CUSTOM  — respects daysOfWeek (0=Sun … 6=Sat)
 */

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function nextOccurrence(rule, fromDate = new Date()) {
  const { frequency, interval = 1, endDate, daysOfWeek = [] } = rule;

  if (endDate && new Date(endDate) < fromDate) return null;

  let next;
  switch (frequency) {
    case 'DAILY':
      next = addDays(fromDate, interval);
      break;

    case 'WEEKLY':
      next = addDays(fromDate, interval * 7);
      break;

    case 'MONTHLY': {
      next = new Date(fromDate);
      next.setMonth(next.getMonth() + interval);
      break;
    }

    case 'CUSTOM': {
      if (!daysOfWeek.length) return null;
      next = addDays(fromDate, 1);
      let tries = 0;
      while (!daysOfWeek.includes(next.getDay()) && tries < 14) {
        next = addDays(next, 1);
        tries++;
      }
      break;
    }

    default:
      return null;
  }

  if (endDate && next > new Date(endDate)) return null;
  return next;
}

async function processRecurringTasks() {
  console.log('[RecurringTaskEngine] Starting nightly scan…');

  try {
    // Fetch ALL workspaces by scanning (acceptable for nightly cron — not user-facing)
    const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await dynamoDbClient.send(new ScanCommand({
      TableName: TASK_MANAGER_TABLE,
      FilterExpression: '#status = :completed AND attribute_exists(recurrenceRule)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':completed': 'COMPLETED' },
    }));

    const tasks = result.Items || [];
    console.log(`[RecurringTaskEngine] Found ${tasks.length} completed recurring tasks.`);

    let created = 0;
    const now = new Date();

    for (const task of tasks) {
      try {
        const rule = task.recurrenceRule;
        if (!rule || !rule.frequency) continue;

        const nextDate = nextOccurrence(rule, now);
        if (!nextDate) {
          console.log(`[RecurringTaskEngine] Task ${task.taskId} — recurrence ended.`);
          continue;
        }

        const newTaskId = uuidv4();
        const nowISO = now.toISOString();
        const nextISO = nextDate.toISOString();

        const newTask = {
          PK: task.PK,
          SK: `TASK#${newTaskId}`,
          taskId: newTaskId,
          workspaceId: task.workspaceId,
          title: task.title,
          description: task.description || '',
          priority: task.priority,
          status: 'BACKLOG',
          visibility: task.visibility || 'PUBLIC',
          assignedUsers: task.assignedUsers || [],
          assignedRoles: task.assignedRoles || [],
          subtasks: (task.subtasks || []).map(st => resetSubtask(st)),
          attachments: [],
          comments: [],
          activityLogs: [{
            logId: uuidv4(),
            type: 'TASK_CREATED',
            actorId: 'SYSTEM',
            actorName: 'Recurring Engine',
            data: { source: task.taskId, generatedBy: 'recurrence' },
            timestamp: nowISO,
          }],
          tags: task.tags || [],
          estimatedHours: task.estimatedHours || 0,
          trackedTime: [],
          trackedHours: 0,
          dueDate: nextISO,
          startDate: nextISO,
          recurrenceRule: rule,
          parentTaskId: task.taskId,
          progress: 0,
          createdBy: task.createdBy,
          createdAt: nowISO,
          updatedAt: nowISO,
          assigneeKey: task.assigneeKey || 'UNASSIGNED',
        };

        await dynamoDbClient.send(new PutCommand({ TableName: TASK_MANAGER_TABLE, Item: newTask }));
        created++;
        console.log(`[RecurringTaskEngine] Created next occurrence ${newTaskId} for task ${task.taskId}.`);
      } catch (taskErr) {
        console.error(`[RecurringTaskEngine] Error processing task ${task.taskId}:`, taskErr.message);
      }
    }

    console.log(`[RecurringTaskEngine] Done. Created ${created} new task occurrences.`);
  } catch (err) {
    console.error('[RecurringTaskEngine] Fatal error:', err.message);
  }
}

function resetSubtask(st) {
  return {
    ...st,
    subtaskId: uuidv4(),
    completed: false,
    subtasks: (st.subtasks || []).map(resetSubtask),
  };
}

/**
 * Starts the recurring task cron job.
 * Schedule: every day at 00:05 server time.
 */
function startRecurringTaskEngine() {
  cron.schedule('5 0 * * *', processRecurringTasks, {
    scheduled: true,
    timezone: 'UTC',
  });
  console.log('[RecurringTaskEngine] Scheduled nightly at 00:05 UTC.');
}

module.exports = { startRecurringTaskEngine, processRecurringTasks };
