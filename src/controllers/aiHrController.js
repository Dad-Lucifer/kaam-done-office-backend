'use strict';

/**
 * aiHrController.js
 *
 * AI-HR Chatbot backend controller.
 *
 * DynamoDB tables accessed:
 *   • assigned-task   (TASK_MANAGER_TABLE)   — all workspace tasks
 *   • task-channels   (TASK_CHANNELS_TABLE)  — general task channel definitions
 *   • AI-HR-channel   (AI_HR_CHANNELS_TABLE) — specific AI-HR channels
 *   • AI-chat         (AI_CHAT_TABLE)        — persistent chat history for AI-HR
 *
 * AI Model: thudm/glm-4-32b:free  (Open-source GLM via OpenRouter)
 */

const { QueryCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../config/awsConfig');
const { TASK_MANAGER_TABLE, TASK_CHANNELS_TABLE, AI_HR_CHANNELS_TABLE, AI_CHAT_TABLE } = require('../config/dbSetup');

// ── OpenRouter / GLM Configuration ──────────────────────────────────────────────

// Free Nvidia Nemotron Ultra model via OpenRouter
const AI_MODEL = 'openai/gpt-oss-120b:free';
// Faster fallback for when the primary model is too slow or rate-limited
const FALLBACK_MODEL = 'google/gemma-4-31b-it:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function getOpenRouterKey() {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY is not set in environment variables.');
  return key;
}

// ── Identity helper ───────────────────────────────────────────────────────────

function extractIdentity(req) {
  const user = req.user;
  if (user.isTeamMember) {
    return {
      workspaceId: user.userId,   // adminUserId stored in team-member JWT
      actorId: user.memberId,
      actorName: user.username || 'Team Member',
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

// ── DynamoDB — Channels & History ─────────────────────────────────────────────

async function fetchWorkspaceTasks(workspaceId) {
  try {
    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: TASK_MANAGER_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `WORKSPACE#${workspaceId}` },
        Limit: 200,
      })
    );
    return result.Items || [];
  } catch (err) {
    console.error(`[AI-HR] assigned-task fetch error:`, err.message);
    return [];
  }
}

async function fetchWorkspaceTaskChannels(workspaceId) {
  try {
    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: TASK_CHANNELS_TABLE,
        IndexName: 'adminUserId-index',
        KeyConditionExpression: 'adminUserId = :adminId',
        ExpressionAttributeValues: { ':adminId': workspaceId },
      })
    );
    return result.Items || [];
  } catch (err) {
    console.error(`[AI-HR] task-channels fetch error:`, err.message);
    return [];
  }
}

async function fetchAiHrHistory(roomId) {
  try {
    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: AI_CHAT_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        ExpressionAttributeValues: { ':roomId': roomId },
      })
    );
    // Sort chronologically
    return (result.Items || []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  } catch (err) {
    console.error(`[AI-HR] fetch history error:`, err.message);
    return [];
  }
}

async function saveMessageToHistory(roomId, role, content) {
  try {
    const msg = {
      roomId,
      timestamp: new Date().toISOString(),
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2,9)}`,
      role,
      content
    };
    await dynamoDbClient.send(new PutCommand({ TableName: AI_CHAT_TABLE, Item: msg }));
    return msg;
  } catch (err) {
    console.error(`[AI-HR] save message error:`, err.message);
  }
}

// ── Analytics & Prompt Builder ────────────────────────────────────────────────

function buildAnalytics(tasks) {
  const now = new Date();
  const statusCounts = {};
  const priorityCounts = {};
  const memberTaskCounts = {};
  let overdueCount = 0;
  let completedCount = 0;
  let totalTrackedHours = 0;

  for (const task of tasks) {
    const status   = task.status   || 'UNKNOWN';
    const priority = task.priority || 'UNKNOWN';

    statusCounts[status]     = (statusCounts[status]   || 0) + 1;
    priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;

    if (status === 'COMPLETED') completedCount++;
    totalTrackedHours += task.trackedHours || 0;

    if (task.dueDate && status !== 'COMPLETED' && status !== 'CANCELLED') {
      if (new Date(task.dueDate) < now) overdueCount++;
    }

    for (const uid of task.assignedUsers || []) {
      memberTaskCounts[uid] = (memberTaskCounts[uid] || 0) + 1;
    }
  }

  const completionRate = tasks.length > 0
    ? Math.round((completedCount / tasks.length) * 100)
    : 0;

  return {
    statusCounts,
    priorityCounts,
    overdueCount,
    completedCount,
    completionRate,
    totalTrackedHours: Math.round(totalTrackedHours * 10) / 10,
    memberTaskCounts,
  };
}

function buildSystemPrompt(tasks, channels, analytics, actorName, isAdmin) {
  const now  = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const weekEnd = new Date(now);
  weekEnd.setDate(now.getDate() + 7);
  const dueThisWeek = tasks.filter(t =>
    t.dueDate &&
    t.status !== 'COMPLETED' &&
    t.status !== 'CANCELLED' &&
    new Date(t.dueDate) <= weekEnd &&
    new Date(t.dueDate) >= now
  ).length;

  // Limit to 40 tasks to avoid exceeding the 4k context window of the free model
  const taskLines = tasks.slice(0, 40).map((t, i) => {
    const assignees  = (t.assignedUsers  || []).join(', ') || 'Unassigned';
    const roles      = (t.assignedRoles  || []).join(', ') || '';
    const due        = t.dueDate  ? new Date(t.dueDate).toLocaleDateString('en-IN')  : 'No due date';
    const start      = t.startDate ? new Date(t.startDate).toLocaleDateString('en-IN') : '';
    const progress   = t.progress  != null ? `${t.progress}%` : 'N/A';
    const tracked    = t.trackedHours  != null ? `${t.trackedHours}h` : '0h';
    const estimated  = t.estimatedHours != null ? `${t.estimatedHours}h` : '-';
    const subtaskCnt = (t.subtasks || []).length;
    const commentCnt = (t.comments || []).length;
    const tags       = (t.tags || []).join(', ') || '';
    const channel    = t.channelId || 'None';
    const isOverdue  = t.dueDate && t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && new Date(t.dueDate) < now;

    return (
      `${i + 1}. [${t.status}] [${t.priority}] "${t.title}"` +
      `\n   Assignees: ${assignees}${roles ? ` | Roles: ${roles}` : ''}` +
      `\n   Due: ${due}${start ? ` | Start: ${start}` : ''}${isOverdue ? ' ⚠️ OVERDUE' : ''}` +
      `\n   Progress: ${progress} | Tracked: ${tracked} / Estimated: ${estimated}` +
      `\n   Channel: ${channel} | Subtasks: ${subtaskCnt} | Comments: ${commentCnt}${tags ? ` | Tags: ${tags}` : ''}` +
      (t.description ? `\n   Desc: ${t.description.slice(0, 100)}${t.description.length > 100 ? '...' : ''}` : '')
    );
  }).join('\n\n');

  const channelLines = channels.map((c, i) => {
    const displayName = c.name?.startsWith('ai-hr:') ? c.name.replace('ai-hr:', '') + ' (AI-HR)' : c.name;
    return `${i + 1}. "${displayName}" (ID: ${c.roomId})${c.description ? ` — ${c.description}` : ''}`;
  }).join('\n');

  const { statusCounts, priorityCounts, overdueCount, completionRate, totalTrackedHours, completedCount } = analytics;

  return `You are AI-HR, the intelligent workspace assistant for WorkNest — a team productivity platform.
You have been given real-time read access to the workspace tasks and channels.

Today: ${dateStr}, ${timeStr} IST
Logged-in user: ${actorName} (${isAdmin ? 'Workspace Admin' : 'Team Member'})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKSPACE SNAPSHOT (live data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Tasks      : ${tasks.length}
Completed        : ${completedCount}  (${completionRate}% completion rate)
Overdue          : ${overdueCount}
Due This Week    : ${dueThisWeek}
Total Hours Tracked : ${totalTrackedHours}h
Task Channels    : ${channels.length}

STATUS BREAKDOWN
${Object.entries(statusCounts).map(([s, c]) => `  ${s.padEnd(14)}: ${c}`).join('\n') || '  No data'}

PRIORITY BREAKDOWN
${Object.entries(priorityCounts).map(([p, c]) => `  ${p.padEnd(10)}: ${c}`).join('\n') || '  No data'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TASK CHANNELS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${channelLines || 'No channels found.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ALL TASKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${taskLines || 'No tasks found in this workspace.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Answer all questions using ONLY the data above — never invent or guess task details.
• Be concise, professional, and helpful.
• Format all dates as human-readable (e.g., "25 June 2026").
• When listing tasks, show: title, status, priority, assignees, and due date.
• If asked about a specific task, include its full details.
• If a question cannot be answered from the data, say so clearly.`;
}

/**
 * Calls the OpenRouter API with a timeout. If the primary model is
 * too slow or unavailable, it automatically retries with a faster fallback.
 */
async function callAI(systemPrompt, conversationHistory, userMessage) {
  const apiKey = getOpenRouterKey();

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  if (Array.isArray(conversationHistory)) {
    // Only keep the last 6 messages to stay within the context window
    const trimmedHistory = conversationHistory.slice(-6);
    for (const msg of trimmedHistory) {
      if (!msg.content || msg.content.trim() === '') continue;
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }
  }

  messages.push({ role: 'user', content: userMessage });

  const body = {
    messages,
    temperature: 0.4,
    max_tokens: 1500,
    top_p: 0.9,
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://worknest.app',
    'X-Title': 'WorkNest AI-HR',
  };

  // Helper: attempt one model with an AbortController timeout
  async function attemptModel(model, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, model }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const detail = errBody?.error?.message || errBody?.message || res.statusText;
        throw new Error(`OpenRouter error (HTTP ${res.status}): ${detail}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('OpenRouter returned an empty response.');
      return text;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // Try primary model with 80s timeout
  try {
    return await attemptModel(AI_MODEL, 80000);
  } catch (primaryErr) {
    const isTimeout = primaryErr.name === 'AbortError' || primaryErr.message?.includes('aborted');
    const isUnavailable = primaryErr.message?.includes('503') || primaryErr.message?.includes('529') || primaryErr.message?.includes('429');
    if (isTimeout || isUnavailable) {
      console.warn(`[AI-HR] Primary model (${AI_MODEL}) timed out or unavailable. Falling back to ${FALLBACK_MODEL}.`);
      return await attemptModel(FALLBACK_MODEL, 30000);
    }
    throw primaryErr;
  }
}

function buildSuggestions(analytics) {
  const suggestions = [];
  if (analytics.overdueCount > 0) suggestions.push(`List all ${analytics.overdueCount} overdue tasks`);
  const blocked = analytics.statusCounts['BLOCKED'] || 0;
  if (blocked > 0) suggestions.push(`What are the ${blocked} blocked tasks?`);
  const inProgress = analytics.statusCounts['IN_PROGRESS'] || 0;
  if (inProgress > 0) suggestions.push(`Show ${inProgress} tasks currently in progress`);
  suggestions.push('Give me a full workspace summary');
  return suggestions.slice(0, 5);
}

// ── Channel Handlers ──────────────────────────────────────────────────────────

async function listChannels(req, res, next) {
  try {
    const { workspaceId } = extractIdentity(req);
    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: AI_HR_CHANNELS_TABLE,
        IndexName: 'adminUserId-index',
        KeyConditionExpression: 'adminUserId = :aid',
        ExpressionAttributeValues: { ':aid': workspaceId },
      })
    );
    res.json({ success: true, data: result.Items || [] });
  } catch (error) {
    next(error);
  }
}

async function createChannel(req, res, next) {
  try {
    const { name, categoryId } = req.body;
    const { workspaceId, isAdmin } = extractIdentity(req);

    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Only admins can create AI-HR channels.' });
    }

    if (!name) return res.status(400).json({ success: false, message: 'Channel name is required.' });

    const channel = {
      roomId: uuidv4(),
      name,
      // Normalize: 'root' and empty/missing all mean no category (filter-safe)
      categoryId: (!categoryId || categoryId === 'root') ? '' : categoryId,
      adminUserId: workspaceId,
      createdAt: new Date().toISOString(),
      type: 'ai-hr',
    };

    await dynamoDbClient.send(new PutCommand({ TableName: AI_HR_CHANNELS_TABLE, Item: channel }));

    // Send a greeting message to history to kick off the channel
    await saveMessageToHistory(channel.roomId, 'assistant', `Hello! I'm **AI-HR**, your intelligent workspace assistant.\n\nI have access to all your workspace task data — assignments, statuses, deadlines, priorities, and channels. Ask me anything!\n\nHere are some things you can ask:\n- What tasks are overdue?\n- Give me a summary of this workspace\n- Which tasks are blocked?\n- Who has the most tasks assigned?`);

    res.status(201).json({ success: true, data: channel });
  } catch (error) {
    next(error);
  }
}

async function deleteChannel(req, res, next) {
  try {
    const { roomId } = req.params;
    const { workspaceId, isAdmin } = extractIdentity(req);

    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Only admins can delete AI-HR channels.' });
    }

    await dynamoDbClient.send(
      new DeleteCommand({
        TableName: AI_HR_CHANNELS_TABLE,
        Key: { roomId },
      })
    );

    res.json({ success: true, message: 'Channel deleted successfully.' });
  } catch (error) {
    next(error);
  }
}

// ── Chat Handlers ─────────────────────────────────────────────────────────────

async function getChatHistory(req, res, next) {
  try {
    const { roomId } = req.params;
    const history = await fetchAiHrHistory(roomId);
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
}

async function chat(req, res, next) {
  try {
    // Log the received body for debugging
    console.log('[AI-HR] POST /chat body:', JSON.stringify(req.body));

    const { roomId, message } = req.body;

    if (!roomId || typeof roomId !== 'string' || roomId.trim().length === 0) {
      console.warn('[AI-HR] 400: roomId missing or empty. Received body:', req.body);
      return res.status(400).json({ success: false, message: 'roomId is required and must be a non-empty string.' });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      console.warn('[AI-HR] 400: message missing or empty. Received body:', req.body);
      return res.status(400).json({ success: false, message: 'message is required and must be a non-empty string.' });
    }

    const { workspaceId, actorName, isAdmin } = extractIdentity(req);

    // Save user message immediately to DB
    await saveMessageToHistory(roomId, 'user', message.trim());

    // Fetch prior conversation from DB
    const historyDb = await fetchAiHrHistory(roomId);
    
    // Filter history for API (exclude the one we just added to send as 'userMessage')
    const priorHistory = historyDb.slice(0, -1);

    const [tasks, channels] = await Promise.all([
      fetchWorkspaceTasks(workspaceId),
      fetchWorkspaceTaskChannels(workspaceId),
    ]);

    const analytics   = buildAnalytics(tasks);
    const systemPrompt = buildSystemPrompt(tasks, channels, analytics, actorName, isAdmin);

    const reply = await callAI(systemPrompt, priorHistory, message.trim());

    // Save AI response to DB
    const savedReply = await saveMessageToHistory(roomId, 'assistant', reply);

    const suggestedQuestions = buildSuggestions(analytics);

    return res.json({
      success: true,
      data: {
        message: savedReply,
        suggestedQuestions,
        contextStats: {
          tasksLoaded:      tasks.length,
          channelsLoaded:   channels.length,
          overdueCount:     analytics.overdueCount,
          completionRate:   analytics.completionRate,
          totalHoursTracked: analytics.totalTrackedHours,
          modelUsed:        AI_MODEL,
          tablesQueried:    [TASK_MANAGER_TABLE, AI_CHAT_TABLE],
        },
      },
    });
  } catch (error) {
    const msg = error.message || 'Unknown error';
    console.error('[AI-HR] Chat error:', msg);

    // OpenRouter/GLM errors are descriptive — pass them through as 503
    if (msg.includes('OpenRouter') || msg.includes('OPENROUTER_KEY') || msg.includes('Network error') || msg.includes('GLM')) {
      return res.status(503).json({ success: false, message: msg });
    }

    next(error);
  }
}

module.exports = {
  listChannels,
  createChannel,
  deleteChannel,
  getChatHistory,
  chat,
};
