'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamoDbClient } = require('../config/awsConfig');
const { ATTENDANCE_LOGS_TABLE, TASK_MANAGER_TABLE, TEAM_MEMBERS_TABLE_NAME } = require('../config/dbSetup');

// -- Guard helper --------------------------------------------------------------

function rejectIfNotAdmin(req, res) {
  if (req.user.isTeamMember) {
    res.status(403).json({ success: false, message: 'Admin access required.' });
    return true;
  }
  return false;
}

// -- GET /api/audit-logs/attendance --------------------------------------------

async function getAttendanceLogs(req, res, next) {
  try {
    if (rejectIfNotAdmin(req, res)) return;
    const { userId: adminUserId } = req.user;
    const { dateFrom, dateTo, memberId, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 200, 500);
    let items = [];

    if (memberId) {
      const params = {
        TableName: ATTENDANCE_LOGS_TABLE,
        IndexName: 'memberId-date-index',
        KeyConditionExpression: 'memberId = :mid',
        FilterExpression: 'adminUserId = :aid',
        ExpressionAttributeValues: { ':mid': memberId, ':aid': adminUserId },
        Limit: limit,
        ScanIndexForward: false,
      };
      if (dateFrom && dateTo) {
        params.KeyConditionExpression += ' AND #dt BETWEEN :df AND :dt';
        params.ExpressionAttributeNames = { '#dt': 'date' };
        params.ExpressionAttributeValues[':df'] = dateFrom;
        params.ExpressionAttributeValues[':dt'] = dateTo;
      } else if (dateFrom) {
        params.KeyConditionExpression += ' AND #dt >= :df';
        params.ExpressionAttributeNames = { '#dt': 'date' };
        params.ExpressionAttributeValues[':df'] = dateFrom;
      } else if (dateTo) {
        params.KeyConditionExpression += ' AND #dt <= :dt';
        params.ExpressionAttributeNames = { '#dt': 'date' };
        params.ExpressionAttributeValues[':dt'] = dateTo;
      }
      const result = await dynamoDbClient.send(new QueryCommand(params));
      items = result.Items || [];
    } else {
      const params = {
        TableName: ATTENDANCE_LOGS_TABLE,
        IndexName: 'adminUserId-date-index',
        KeyConditionExpression: 'adminUserId = :aid',
        ExpressionAttributeValues: { ':aid': adminUserId },
        Limit: limit,
        ScanIndexForward: false,
      };
      if (dateFrom && dateTo) {
        params.KeyConditionExpression += ' AND #dt BETWEEN :df AND :dt';
        params.ExpressionAttributeNames = { '#dt': 'date' };
        params.ExpressionAttributeValues[':df'] = dateFrom;
        params.ExpressionAttributeValues[':dt'] = dateTo;
      } else if (dateFrom) {
        params.KeyConditionExpression += ' AND #dt >= :df';
        params.ExpressionAttributeNames = { '#dt': 'date' };
        params.ExpressionAttributeValues[':df'] = dateFrom;
      } else if (dateTo) {
        params.KeyConditionExpression += ' AND #dt <= :dt';
        params.ExpressionAttributeNames = { '#dt': 'date' };
        params.ExpressionAttributeValues[':dt'] = dateTo;
      }
      const result = await dynamoDbClient.send(new QueryCommand(params));
      items = result.Items || [];
    }

    const attendanceItems = items.filter(i => i.type !== 'SUBTASK_COMPLETION');

    attendanceItems.sort((a, b) => {
      if (a.date === b.date) return (b.loginAt || '').localeCompare(a.loginAt || '');
      return (b.date || '').localeCompare(a.date || '');
    });

    return res.status(200).json({
      success: true,
      data: attendanceItems.map(mapAttendanceRecord),
      count: attendanceItems.length,
    });
  } catch (error) {
    next(error);
  }
}

// -- GET /api/audit-logs/attendance/:memberId ----------------------------------

async function getMemberAttendance(req, res, next) {
  try {
    if (rejectIfNotAdmin(req, res)) return;
    const { userId: adminUserId } = req.user;
    const { memberId } = req.params;
    const { dateFrom, dateTo, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 100, 500);

    const params = {
      TableName: ATTENDANCE_LOGS_TABLE,
      IndexName: 'memberId-date-index',
      KeyConditionExpression: 'memberId = :mid',
      FilterExpression: 'adminUserId = :aid',
      ExpressionAttributeValues: { ':mid': memberId, ':aid': adminUserId },
      ScanIndexForward: false,
      Limit: limit,
    };

    if (dateFrom && dateTo) {
      params.KeyConditionExpression += ' AND #dt BETWEEN :df AND :dt';
      params.ExpressionAttributeNames = { '#dt': 'date' };
      params.ExpressionAttributeValues[':df'] = dateFrom;
      params.ExpressionAttributeValues[':dt'] = dateTo;
    } else if (dateFrom) {
      params.KeyConditionExpression += ' AND #dt >= :df';
      params.ExpressionAttributeNames = { '#dt': 'date' };
      params.ExpressionAttributeValues[':df'] = dateFrom;
    }

    const result = await dynamoDbClient.send(new QueryCommand(params));
    const rawItems = result.Items || [];
    const items = rawItems.filter(i => i.type !== 'SUBTASK_COMPLETION').sort((a, b) => (b.loginAt || '').localeCompare(a.loginAt || ''));

    const completedSessions = items.filter(i => i.workingHours !== null && i.workingHours !== undefined);
    const totalHours = completedSessions.reduce((sum, i) => sum + (i.workingHours || 0), 0);
    const avgHours = completedSessions.length
      ? parseFloat((totalHours / completedSessions.length).toFixed(2))
      : 0;

    return res.status(200).json({
      success: true,
      data: {
        memberId,
        records: items.map(mapAttendanceRecord),
        stats: {
          totalSessions: items.length,
          completedSessions: completedSessions.length,
          totalHours: parseFloat(totalHours.toFixed(2)),
          avgHoursPerDay: avgHours,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

// -- GET /api/audit-logs/tasks -------------------------------------------------

async function getTaskActivity(req, res, next) {
  try {
    if (rejectIfNotAdmin(req, res)) return;
    const { userId: workspaceId } = req.user;
    const { memberId: filterMemberId, status, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 100, 300);

    const params = {
      TableName: TASK_MANAGER_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `WORKSPACE#${workspaceId}` },
      Limit: limit,
    };

    if (status) {
      params.FilterExpression = '#st = :status';
      params.ExpressionAttributeNames = { '#st': 'status' };
      params.ExpressionAttributeValues[':status'] = status.toUpperCase();
    }

    const result = await dynamoDbClient.send(new QueryCommand(params));
    const tasks = result.Items || [];

    const membersResult = await dynamoDbClient.send(new QueryCommand({
      TableName: TEAM_MEMBERS_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `ADMIN#${workspaceId}` },
    }));
    const membersMap = {};
    (membersResult.Items || []).forEach(m => { membersMap[m.memberId] = m.username; });

    const memberSummaries = {};

    function countSubtasks(subtasks) {
      if (!subtasks || !subtasks.length) return { total: 0, completed: 0 };
      let total = 0, completed = 0;
      for (const st of subtasks) {
        total++;
        if (st.completed) completed++;
        if (st.subtasks && st.subtasks.length) {
          const child = countSubtasks(st.subtasks);
          total += child.total;
          completed += child.completed;
        }
      }
      return { total, completed };
    }

    const completionsResult = await dynamoDbClient.send(new QueryCommand({
      TableName: ATTENDANCE_LOGS_TABLE,
      IndexName: 'adminUserId-date-index',
      KeyConditionExpression: 'adminUserId = :aid',
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':aid': workspaceId, ':type': 'SUBTASK_COMPLETION' },
    }));
    
    const allCompletions = completionsResult.Items || [];
    allCompletions.sort((a, b) => b.completedAt.localeCompare(a.completedAt));

    for (const task of tasks) {
      const assignedUsers = task.assignedUsers || [];
      const completionsForTask = allCompletions.filter(c => c.taskId === task.taskId);
      const membersWhoCompleted = completionsForTask.map(c => c.memberId);
      
      const involvedUsers = [...new Set([...assignedUsers, ...membersWhoCompleted])];

      if (filterMemberId && !involvedUsers.includes(filterMemberId)) continue;
      const targetMembers = filterMemberId
        ? involvedUsers.filter(id => id === filterMemberId)
        : involvedUsers;
      const subtaskCounts = countSubtasks(task.subtasks);

      for (const mId of targetMembers) {
        if (!memberSummaries[mId]) {
          memberSummaries[mId] = {
            memberId: mId,
            username: membersMap[mId] || 'Unknown',
            tasksAssigned: [],
            recentCompletions: [],
            totalSubtasks: 0,
            completedSubtasks: 0,
          };
        }
        memberSummaries[mId].tasksAssigned.push({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate || null,
          progress: task.progress || 0,
          subtasks: { total: subtaskCounts.total, completed: subtaskCounts.completed },
          assignedUsers: task.assignedUsers || [],
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
        memberSummaries[mId].totalSubtasks += subtaskCounts.total;
        memberSummaries[mId].completedSubtasks += subtaskCounts.completed;
      }
    }



    for (const comp of allCompletions) {
      if (!memberSummaries[comp.memberId]) {
        if (filterMemberId && comp.memberId !== filterMemberId) continue;
        memberSummaries[comp.memberId] = {
          memberId: comp.memberId,
          username: comp.username || membersMap[comp.memberId] || 'Unknown',
          tasksAssigned: [],
          recentCompletions: [],
          totalSubtasks: 0,
          completedSubtasks: 0,
        };
      }
    }

    for (const mId of Object.keys(memberSummaries)) {
      memberSummaries[mId].recentCompletions = allCompletions
        .filter(c => c.memberId === mId)
        .slice(0, 20); // Keep top 20 completions per member
    }

    const summaries = Object.values(memberSummaries).map(s => ({
      ...s,
      taskCount: s.tasksAssigned.length,
      subtaskCompletionRate: s.totalSubtasks > 0
        ? parseFloat(((s.completedSubtasks / s.totalSubtasks) * 100).toFixed(1))
        : 0,
    })).sort((a, b) => b.taskCount - a.taskCount);

    return res.status(200).json({ success: true, data: summaries, totalTasks: tasks.length });
  } catch (error) {
    next(error);
  }
}

// -- Mapper --------------------------------------------------------------------

function mapAttendanceRecord(item) {
  return {
    logId:          item.logId,
    memberId:       item.memberId,
    username:       item.username,
    date:           item.date,
    dayOfWeek:      item.dayOfWeek,
    loginAt:        item.loginAt,
    logoutAt:       item.logoutAt || null,
    workingHoursMs: item.workingHoursMs || null,
    workingHours:   item.workingHours !== undefined ? item.workingHours : null,
    isActive:       !item.logoutAt,
  };
}

module.exports = { getAttendanceLogs, getMemberAttendance, getTaskActivity };
