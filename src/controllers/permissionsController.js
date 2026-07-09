'use strict';

const { GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamoDbClient } = require('../config/awsConfig');
const { resolveAllPermissions, normalizePermissions, ALL_PERMISSIONS } = require('../services/permissionEngine');
const { logPermissionChange } = require('../services/auditLogService');

const ROLES_TABLE          = 'roles';
const CATEGORIES_TABLE     = 'categories';
const TEXT_CHANNELS_TABLE  = 'text-channels';
const VOICE_CHANNELS_TABLE = 'voice-channels';
const TASK_CHANNELS_TABLE  = 'task-channels';
const AI_HR_CHANNELS_TABLE = 'AI-HR-channel';
const AUDIT_LOG_TABLE      = 'permission-audit-logs';

// ============================================================
//  ROLE PERMISSIONS
// ============================================================

/**
 * GET /api/permissions/roles/:roleId
 * Returns the full 32-permission map for a role (normalized to ALLOW/DENY/INHERIT).
 */
async function getRolePermissions(req, res, next) {
  try {
    const { userId } = req.user;
    const { roleId } = req.params;

    const result = await dynamoDbClient.send(new GetCommand({
      TableName: ROLES_TABLE,
      Key: { PK: `ADMIN#${userId}`, SK: `ROLE#${roleId}` },
    }));

    if (!result.Item) {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }

    const permissions = normalizePermissions(result.Item.permissions || {});

    // Fill in any missing keys with INHERIT
    for (const perm of ALL_PERMISSIONS) {
      if (!permissions[perm]) permissions[perm] = 'INHERIT';
    }

    return res.status(200).json({
      success: true,
      data: {
        roleId: result.Item.roleId,
        name: result.Item.name,
        isOwner: result.Item.isOwner || false,
        permissions,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/permissions/roles/:roleId
 * Updates a role's workspace-level permissions.
 * Body: { permissions: Record<string, 'ALLOW'|'DENY'|'INHERIT'> }
 */
async function updateRolePermissions(req, res, next) {
  try {
    const { userId } = req.user;
    const { roleId } = req.params;
    const { permissions } = req.body;

    if (!permissions || typeof permissions !== 'object') {
      return res.status(422).json({ success: false, message: 'permissions must be an object.' });
    }

    // Validate values
    const validStates = ['ALLOW', 'DENY', 'INHERIT'];
    for (const [key, val] of Object.entries(permissions)) {
      if (!validStates.includes(val)) {
        return res.status(422).json({ success: false, message: `Invalid state "${val}" for permission "${key}".` });
      }
    }

    // Fetch existing item to capture before-state and check isOwner guard
    const existing = await dynamoDbClient.send(new GetCommand({
      TableName: ROLES_TABLE,
      Key: { PK: `ADMIN#${userId}`, SK: `ROLE#${roleId}` },
    }));

    if (!existing.Item) {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }

    if (existing.Item.isOwner === true) {
      return res.status(403).json({ success: false, message: 'The OWNER role cannot be modified.' });
    }

    const before = normalizePermissions(existing.Item.permissions || {});
    const now = new Date().toISOString();

    // Merge incoming changes with existing permissions
    const merged = { ...before };
    for (const [key, val] of Object.entries(permissions)) {
      if (ALL_PERMISSIONS.includes(key)) merged[key] = val;
    }

    await dynamoDbClient.send(new UpdateCommand({
      TableName: ROLES_TABLE,
      Key: { PK: `ADMIN#${userId}`, SK: `ROLE#${roleId}` },
      UpdateExpression: 'SET #perms = :perms, updatedAt = :now',
      ExpressionAttributeNames: { '#perms': 'permissions' },
      ExpressionAttributeValues: { ':perms': merged, ':now': now },
      ConditionExpression: 'attribute_exists(PK)',
    }));

    // Build change list for audit
    const changes = [];
    for (const perm of ALL_PERMISSIONS) {
      const b = before[perm] || 'INHERIT';
      const a = merged[perm] || 'INHERIT';
      if (b !== a) changes.push({ field: perm, before: b, after: a });
    }

    await logPermissionChange({
      workspaceId: userId,
      actorId: req.user.memberId || userId,
      actorName: req.user.name || req.user.username || userId,
      action: 'PERMISSION_CHANGED',
      targetType: 'ROLE',
      targetId: roleId,
      targetName: existing.Item.name || roleId,
      changes,
    });

    return res.status(200).json({ success: true, data: { roleId, permissions: merged } });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }
    next(error);
  }
}

// ============================================================
//  CATEGORY OVERRIDES
// ============================================================

/**
 * GET /api/permissions/categories/:categoryId/overrides
 * Returns all role-level permission overrides for a category.
 */
async function getCategoryOverrides(req, res, next) {
  try {
    const { categoryId } = req.params;

    const result = await dynamoDbClient.send(new GetCommand({
      TableName: CATEGORIES_TABLE,
      Key: { categoryId },
    }));

    if (!result.Item) {
      return res.status(404).json({ success: false, message: 'Category not found.' });
    }

    return res.status(200).json({
      success: true,
      data: result.Item.permissionOverrides || {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/permissions/categories/:categoryId/roles/:roleId
 * Upserts a role's permission override on a category.
 * Body: { permissions: Record<string, 'ALLOW'|'DENY'|'INHERIT'> }
 */
async function upsertCategoryOverride(req, res, next) {
  try {
    const { userId } = req.user;
    const { categoryId, roleId } = req.params;
    const { permissions } = req.body;

    if (!permissions || typeof permissions !== 'object') {
      return res.status(422).json({ success: false, message: 'permissions must be an object.' });
    }

    // Validate the category belongs to this workspace
    const catResult = await dynamoDbClient.send(new GetCommand({
      TableName: CATEGORIES_TABLE,
      Key: { categoryId },
    }));

    if (!catResult.Item || catResult.Item.adminUserId !== userId) {
      return res.status(404).json({ success: false, message: 'Category not found.' });
    }

    const now = new Date().toISOString();
    const before = (catResult.Item.permissionOverrides || {})[roleId] || {};
    const hasOverridesMap = !!catResult.Item.permissionOverrides;

    let updateExpr, attrNames, attrVals;

    if (hasOverridesMap) {
      updateExpr = 'SET #po.#rid = :perms, updatedAt = :now';
      attrNames = { '#po': 'permissionOverrides', '#rid': roleId };
      attrVals = { ':perms': permissions, ':now': now };
    } else {
      updateExpr = 'SET #po = :poMap, updatedAt = :now';
      attrNames = { '#po': 'permissionOverrides' };
      attrVals = { ':poMap': { [roleId]: permissions }, ':now': now };
    }

    await dynamoDbClient.send(new UpdateCommand({
      TableName: CATEGORIES_TABLE,
      Key: { categoryId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: attrVals,
    }));

    const changes = [];
    for (const [key, after] of Object.entries(permissions)) {
      const beforeVal = (before[key]) || 'INHERIT';
      if (beforeVal !== after) changes.push({ field: key, before: beforeVal, after });
    }

    await logPermissionChange({
      workspaceId: userId,
      actorId: req.user.memberId || userId,
      actorName: req.user.name || req.user.username || userId,
      action: 'OVERRIDE_SET',
      targetType: 'CATEGORY',
      targetId: categoryId,
      targetName: catResult.Item.name || categoryId,
      changes,
    });

    return res.status(200).json({ success: true, message: 'Category override saved.' });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  CHANNEL OVERRIDES
// ============================================================

/**
 * GET /api/permissions/channels/:channelId/overrides
 * Returns all role-level permission overrides for a channel.
 * Query param: ?type=text|voice|task|ai-hr (default: text)
 */
async function getChannelOverrides(req, res, next) {
  try {
    const { channelId } = req.params;
    const type = req.query.type;

    // Resolve DynamoDB table from channel type
    let table;
    let targetTypeLabel;
    if (type === 'voice') {
      table = VOICE_CHANNELS_TABLE;
      targetTypeLabel = 'VOICE_CHANNEL';
    } else if (type === 'task') {
      table = TASK_CHANNELS_TABLE;
      targetTypeLabel = 'TASK_CHANNEL';
    } else if (type === 'ai-hr') {
      table = AI_HR_CHANNELS_TABLE;
      targetTypeLabel = 'AI_HR_CHANNEL';
    } else {
      // default: text
      table = TEXT_CHANNELS_TABLE;
      targetTypeLabel = 'TEXT_CHANNEL';
    }

    const result = await dynamoDbClient.send(new GetCommand({
      TableName: table,
      Key: { roomId: channelId },
    }));

    if (!result.Item) {
      return res.status(404).json({ success: false, message: `${targetTypeLabel} channel not found.` });
    }

    return res.status(200).json({
      success: true,
      data: result.Item.permissionOverrides || {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/permissions/channels/:channelId/roles/:roleId
 * Upserts a role's permission override on a channel.
 * Query param: ?type=text|voice|task|ai-hr
 * Body: { permissions: Record<string, 'ALLOW'|'DENY'|'INHERIT'> }
 */
async function upsertChannelOverride(req, res, next) {
  try {
    const { userId } = req.user;
    const { channelId, roleId } = req.params;
    const { permissions } = req.body;
    const type = req.query.type;

    // Resolve DynamoDB table and audit label from channel type
    let table;
    let targetType;
    if (type === 'voice') {
      table = VOICE_CHANNELS_TABLE;
      targetType = 'VOICE_CHANNEL';
    } else if (type === 'task') {
      table = TASK_CHANNELS_TABLE;
      targetType = 'TASK_CHANNEL';
    } else if (type === 'ai-hr') {
      table = AI_HR_CHANNELS_TABLE;
      targetType = 'AI_HR_CHANNEL';
    } else {
      // default: text
      table = TEXT_CHANNELS_TABLE;
      targetType = 'TEXT_CHANNEL';
    }

    if (!permissions || typeof permissions !== 'object') {
      return res.status(422).json({ success: false, message: 'permissions must be an object.' });
    }

    const chanResult = await dynamoDbClient.send(new GetCommand({
      TableName: table,
      Key: { roomId: channelId },
    }));

    if (!chanResult.Item || chanResult.Item.adminUserId !== userId) {
      return res.status(404).json({ success: false, message: 'Channel not found.' });
    }

    const now = new Date().toISOString();
    const before = (chanResult.Item.permissionOverrides || {})[roleId] || {};
    const hasOverridesMap = !!chanResult.Item.permissionOverrides;

    let updateExpr, attrNames, attrVals;

    if (hasOverridesMap) {
      updateExpr = 'SET #po.#rid = :perms, updatedAt = :now';
      attrNames = { '#po': 'permissionOverrides', '#rid': roleId };
      attrVals = { ':perms': permissions, ':now': now };
    } else {
      updateExpr = 'SET #po = :poMap, updatedAt = :now';
      attrNames = { '#po': 'permissionOverrides' };
      attrVals = { ':poMap': { [roleId]: permissions }, ':now': now };
    }

    await dynamoDbClient.send(new UpdateCommand({
      TableName: table,
      Key: { roomId: channelId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: attrVals,
    }));

    const changes = [];
    for (const [key, after] of Object.entries(permissions)) {
      const beforeVal = (before[key]) || 'INHERIT';
      if (beforeVal !== after) changes.push({ field: key, before: beforeVal, after });
    }

    await logPermissionChange({
      workspaceId: userId,
      actorId: req.user.memberId || userId,
      actorName: req.user.name || req.user.username || userId,
      action: 'OVERRIDE_SET',
      targetType,
      targetId: channelId,
      targetName: chanResult.Item.name || channelId,
      changes,
    });

    return res.status(200).json({ success: true, message: 'Channel override saved.' });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  USER PERMISSION INSPECTOR
// ============================================================

/**
 * GET /api/permissions/users/:memberId/resolve
 * Resolves the full effective permission map for a member.
 * Query params: ?channelId=&channelType=text|voice&categoryId=
 */
async function resolveUserPermissions(req, res, next) {
  try {
    const { userId } = req.user;
    const { memberId } = req.params;
    const { channelId, channelType, categoryId } = req.query;

    const context = {};
    if (channelId) { context.channelId = channelId; context.channelType = channelType || 'text'; }
    if (categoryId) context.categoryId = categoryId;

    const resolved = await resolveAllPermissions(userId, memberId, context);

    return res.status(200).json({ success: true, data: resolved });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  AUDIT LOGS
// ============================================================

/**
 * GET /api/permissions/audit
 * Returns audit log entries for the workspace.
 * Query params: ?from=ISO8601&to=ISO8601&limit=50
 */
async function getAuditLogs(req, res, next) {
  try {
    const { userId } = req.user;
    const { from, to, limit } = req.query;
    const maxItems = Math.min(parseInt(limit, 10) || 50, 100);

    const params = {
      TableName: AUDIT_LOG_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `WORKSPACE#${userId}` },
      ScanIndexForward: false, // newest first
      Limit: maxItems,
    };

    // Optional date range filter on SK
    if (from && to) {
      params.KeyConditionExpression += ' AND SK BETWEEN :from AND :to';
      params.ExpressionAttributeValues[':from'] = `LOG#${from}`;
      params.ExpressionAttributeValues[':to'] = `LOG#${to}#\uFFFF`;
    } else if (from) {
      params.KeyConditionExpression += ' AND SK >= :from';
      params.ExpressionAttributeValues[':from'] = `LOG#${from}`;
    } else if (to) {
      params.KeyConditionExpression += ' AND SK <= :to';
      params.ExpressionAttributeValues[':to'] = `LOG#${to}#\uFFFF`;
    }

    const result = await dynamoDbClient.send(new QueryCommand(params));
    const logs = (result.Items || []).map(item => ({
      logId: item.logId,
      actorId: item.actorId,
      actorName: item.actorName,
      action: item.action,
      targetType: item.targetType,
      targetId: item.targetId,
      targetName: item.targetName,
      changes: item.changes || [],
      createdAt: item.createdAt,
    }));

    return res.status(200).json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getRolePermissions,
  updateRolePermissions,
  getCategoryOverrides,
  upsertCategoryOverride,
  getChannelOverrides,
  upsertChannelOverride,
  resolveUserPermissions,
  getAuditLogs,
};
