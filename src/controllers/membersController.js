'use strict';

const { PutCommand, QueryCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const { dynamoDbClient } = require('../config/awsConfig');
const { TEAM_MEMBERS_TABLE_NAME } = require('../config/dbSetup');

// ============================================================
//  LIST MEMBERS
// ============================================================

/**
 * GET /api/members
 * Returns all team members belonging to the authenticated admin.
 */
async function listMembers(req, res, next) {
  try {
    const { userId } = req.user;

    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: TEAM_MEMBERS_TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `ADMIN#${userId}` },
      })
    );

    const members = (result.Items || []).map(mapItemToMember);
    return res.status(200).json({ success: true, data: members });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  CREATE MEMBER
// ============================================================

/**
 * POST /api/members
 * Creates a new team member scoped to the authenticated admin.
 * Body: { username, email?, roleId?, roleName? }
 *
 * NOTE: This stores member credentials/info in DynamoDB only.
 * The admin manages who gets access — these are workspace users,
 * not Cognito-authenticated users (they could be invited later).
 */
async function createMember(req, res, next) {
  try {
    const { userId } = req.user;
    const { username, email, password, roleId, roleName, roleIds } = req.body;

    const trimmedUsername = username.trim();

    // Check if username is already taken globally
    const existingUser = await dynamoDbClient.send(
      new QueryCommand({
        TableName: TEAM_MEMBERS_TABLE_NAME,
        IndexName: 'username-index',
        KeyConditionExpression: 'username = :un',
        ExpressionAttributeValues: { ':un': trimmedUsername },
      })
    );

    if (existingUser.Items && existingUser.Items.length > 0) {
      return res.status(409).json({ success: false, message: 'Username is already taken. Please choose another.' });
    }

    const memberId = uuidv4();
    const now = new Date().toISOString();

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Support both new multi-role array and legacy single roleId
    const resolvedRoleIds = roleIds && Array.isArray(roleIds) && roleIds.length > 0
      ? roleIds
      : (roleId ? [roleId] : []);
    const primaryRoleId = resolvedRoleIds[0] || null;

    const item = {
      PK: `ADMIN#${userId}`,
      SK: `MEMBER#${memberId}`,
      memberId,
      adminUserId: userId,
      username: trimmedUsername,
      password: hashedPassword,
      email: email ? email.trim().toLowerCase() : null,
      roleIds: resolvedRoleIds,
      roleId: primaryRoleId,       // legacy compat
      roleName: roleName || null,
      createdAt: now,
      updatedAt: now,
    };

    await dynamoDbClient.send(
      new PutCommand({
        TableName: TEAM_MEMBERS_TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return res.status(201).json({ success: true, data: mapItemToMember(item) });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  UPDATE MEMBER (reassign role)
// ============================================================

/**
 * PATCH /api/members/:memberId
 * Updates a member's role assignment (or username/email).
 * Body: { username?, email?, roleId?, roleName? }
 */
async function updateMember(req, res, next) {
  try {
    const { userId } = req.user;
    const { memberId } = req.params;
    const { username, email, roleId, roleName, roleIds } = req.body;

    const now = new Date().toISOString();

    // Build update expression dynamically
    const updates = [];
    const names = {};
    const values = { ':uid': userId, ':now': now };

    if (username !== undefined) { updates.push('#un = :un'); names['#un'] = 'username'; values[':un'] = username.trim(); }
    if (email !== undefined)    { updates.push('#em = :em'); names['#em'] = 'email';    values[':em'] = email ? email.trim().toLowerCase() : null; }
    if (roleName !== undefined) { updates.push('#rn = :rn'); names['#rn'] = 'roleName'; values[':rn'] = roleName || null; }

    // Handle roleIds (multi-role) and legacy roleId
    if (roleIds !== undefined && Array.isArray(roleIds)) {
      const primaryRoleId = roleIds[0] || null;
      updates.push('#rids = :rids'); names['#rids'] = 'roleIds'; values[':rids'] = roleIds;
      updates.push('#ri = :ri');    names['#ri']   = 'roleId';  values[':ri']   = primaryRoleId;
    } else if (roleId !== undefined) {
      const resolvedRoleIds = roleId ? [roleId] : [];
      updates.push('#rids = :rids'); names['#rids'] = 'roleIds'; values[':rids'] = resolvedRoleIds;
      updates.push('#ri = :ri');    names['#ri']   = 'roleId';  values[':ri']   = roleId || null;
    }

    updates.push('updatedAt = :now');

    const result = await dynamoDbClient.send(
      new UpdateCommand({
        TableName: TEAM_MEMBERS_TABLE_NAME,
        Key: { PK: `ADMIN#${userId}`, SK: `MEMBER#${memberId}` },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK) AND adminUserId = :uid',
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );

    return res.status(200).json({ success: true, data: mapItemToMember(result.Attributes) });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ success: false, message: 'Member not found or access denied.' });
    }
    next(error);
  }
}

// ============================================================
//  DELETE MEMBER
// ============================================================

/**
 * DELETE /api/members/:memberId
 * Removes a team member. Only succeeds if they belong to this admin.
 */
async function deleteMember(req, res, next) {
  try {
    const { userId } = req.user;
    const { memberId } = req.params;

    await dynamoDbClient.send(
      new DeleteCommand({
        TableName: TEAM_MEMBERS_TABLE_NAME,
        Key: { PK: `ADMIN#${userId}`, SK: `MEMBER#${memberId}` },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return res.status(200).json({ success: true, message: 'Member removed successfully.' });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }
    next(error);
  }
}

// ============================================================
//  HELPER
// ============================================================

function mapItemToMember(item) {
  return {
    id: item.memberId,
    username: item.username,
    email: item.email || null,
    roleId: item.roleId || null,
    roleName: item.roleName || null,
    roleIds: item.roleIds || (item.roleId ? [item.roleId] : []),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

module.exports = { listMembers, createMember, updateMember, deleteMember };
