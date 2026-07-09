'use strict';

const { PutCommand, QueryCommand, DeleteCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

const { dynamoDbClient } = require('../config/awsConfig');
const { ROLES_TABLE_NAME } = require('../config/dbSetup');
const { normalizePermissions } = require('../services/permissionEngine');
const { logPermissionChange } = require('../services/auditLogService');

// ============================================================
//  LIST ROLES
// ============================================================

/**
 * GET /api/roles
 * Returns all roles belonging to the authenticated admin.
 */
async function listRoles(req, res, next) {
  try {
    const { userId } = req.user;

    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: ROLES_TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `ADMIN#${userId}`,
        },
      })
    );

    const roles = (result.Items || []).map(mapItemToRole);

    return res.status(200).json({ success: true, data: roles });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  CREATE ROLE
// ============================================================

/**
 * POST /api/roles
 * Creates a new role scoped to the authenticated admin.
 * Body: { name, color, permissions, channelAccess }
 */
async function createRole(req, res, next) {
  try {
    const { userId } = req.user;
    const { name, color, icon, position, permissions, channelAccess } = req.body;

    const roleId = uuidv4();
    const now = new Date().toISOString();

    // Normalize any incoming permissions to 3-state format
    const normalizedPerms = permissions
      ? normalizePermissions(permissions)
      : {
          VIEW_WORKSPACE: 'ALLOW',
          VIEW_MEMBERS: 'ALLOW',
          VIEW_CATEGORY: 'ALLOW',
          VIEW_TEXT_CHANNEL: 'ALLOW',
          READ_MESSAGES: 'ALLOW',
          SEND_MESSAGES: 'ALLOW',
          VIEW_VOICE_CHANNEL: 'ALLOW',
          JOIN_VOICE: 'ALLOW',
        };

    const item = {
      PK: `ADMIN#${userId}`,
      SK: `ROLE#${roleId}`,
      roleId,
      adminUserId: userId,
      name: name || 'New Role',
      color: color || '#99aab5',
      icon: icon || null,
      position: typeof position === 'number' ? position : 0,
      isOwner: false,
      permissions: normalizedPerms,
      channelAccess: channelAccess || {},
      createdAt: now,
      updatedAt: now,
    };

    await dynamoDbClient.send(
      new PutCommand({
        TableName: ROLES_TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    await logPermissionChange({
      workspaceId: userId,
      actorId: userId,
      actorName: req.user.name || userId,
      action: 'ROLE_CREATED',
      targetType: 'ROLE',
      targetId: roleId,
      targetName: item.name,
      changes: [],
    });

    return res.status(201).json({ success: true, data: mapItemToRole(item) });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  UPDATE ROLE
// ============================================================

/**
 * PUT /api/roles/:roleId
 * Updates an existing role. Replaces the full item (put-based upsert
 * with ownership check via ConditionExpression).
 * Body: { name, color, permissions, channelAccess }
 */
async function updateRole(req, res, next) {
  try {
    const { userId } = req.user;
    const { roleId } = req.params;
    const { name, color, icon, position, permissions, channelAccess } = req.body;

    // Fetch current item to enforce OWNER guard
    const existing = await dynamoDbClient.send(
      new GetCommand({
        TableName: ROLES_TABLE_NAME,
        Key: { PK: `ADMIN#${userId}`, SK: `ROLE#${roleId}` },
      })
    );

    if (!existing.Item) {
      return res.status(404).json({ success: false, message: 'Role not found or access denied.' });
    }

    if (existing.Item.isOwner === true) {
      return res.status(403).json({ success: false, message: 'The OWNER role cannot be modified.' });
    }

    const now = new Date().toISOString();
    const normalizedPerms = permissions ? normalizePermissions(permissions) : existing.Item.permissions;

    const item = {
      PK: `ADMIN#${userId}`,
      SK: `ROLE#${roleId}`,
      roleId,
      adminUserId: userId,
      name: name !== undefined ? name : existing.Item.name,
      color: color !== undefined ? color : existing.Item.color,
      icon: icon !== undefined ? icon : (existing.Item.icon || null),
      position: position !== undefined ? position : (existing.Item.position || 0),
      isOwner: false,
      permissions: normalizedPerms,
      channelAccess: channelAccess !== undefined ? channelAccess : (existing.Item.channelAccess || {}),
      createdAt: existing.Item.createdAt,
      updatedAt: now,
    };

    await dynamoDbClient.send(
      new PutCommand({
        TableName: ROLES_TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_exists(PK) AND adminUserId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
      })
    );

    await logPermissionChange({
      workspaceId: userId,
      actorId: userId,
      actorName: req.user.name || userId,
      action: 'ROLE_UPDATED',
      targetType: 'ROLE',
      targetId: roleId,
      targetName: item.name,
      changes: [{ field: 'name', before: existing.Item.name, after: item.name }],
    });

    return res.status(200).json({ success: true, data: mapItemToRole(item) });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ success: false, message: 'Role not found or access denied.' });
    }
    next(error);
  }
}

// ============================================================
//  DELETE ROLE
// ============================================================

/**
 * DELETE /api/roles/:roleId
 * Deletes a role. Only succeeds if the role belongs to the authenticated admin.
 */
async function deleteRole(req, res, next) {
  try {
    const { userId } = req.user;
    const { roleId } = req.params;

    // Fetch item first to enforce OWNER guard
    const existing = await dynamoDbClient.send(
      new GetCommand({
        TableName: ROLES_TABLE_NAME,
        Key: { PK: `ADMIN#${userId}`, SK: `ROLE#${roleId}` },
      })
    );

    if (!existing.Item) {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }

    if (existing.Item.isOwner === true) {
      return res.status(403).json({ success: false, message: 'The OWNER role cannot be deleted.' });
    }

    await dynamoDbClient.send(
      new DeleteCommand({
        TableName: ROLES_TABLE_NAME,
        Key: { PK: `ADMIN#${userId}`, SK: `ROLE#${roleId}` },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    await logPermissionChange({
      workspaceId: userId,
      actorId: userId,
      actorName: req.user.name || userId,
      action: 'ROLE_DELETED',
      targetType: 'ROLE',
      targetId: roleId,
      targetName: existing.Item.name || roleId,
      changes: [],
    });

    return res.status(200).json({ success: true, message: 'Role deleted successfully.' });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }
    next(error);
  }
}

// ============================================================
//  HELPER
// ============================================================

function mapItemToRole(item) {
  return {
    id: item.roleId,
    name: item.name,
    color: item.color,
    icon: item.icon || null,
    position: item.position || 0,
    isOwner: item.isOwner || false,
    permissions: normalizePermissions(item.permissions || {}),
    channelAccess: item.channelAccess || {},
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

module.exports = { listRoles, createRole, updateRole, deleteRole };
