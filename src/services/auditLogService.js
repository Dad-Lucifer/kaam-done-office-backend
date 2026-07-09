'use strict';

const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../config/awsConfig');

const AUDIT_LOG_TABLE = 'permission-audit-logs';
const TTL_90_DAYS_SECONDS = 90 * 24 * 60 * 60;

/**
 * Writes a permission change audit log entry to DynamoDB.
 * Failures are swallowed and logged to console so they never break the main flow.
 *
 * @param {Object} params
 * @param {string} params.workspaceId     - adminUserId of the workspace
 * @param {string} params.actorId         - memberId or adminUserId who made the change
 * @param {string} params.actorName       - display name / username of the actor
 * @param {string} params.action          - e.g. 'ROLE_CREATED', 'PERMISSION_CHANGED', 'OVERRIDE_SET'
 * @param {string} params.targetType      - 'ROLE' | 'CATEGORY' | 'TEXT_CHANNEL' | 'VOICE_CHANNEL' | 'MEMBER'
 * @param {string} params.targetId        - ID of the affected entity
 * @param {string} params.targetName      - human-readable name of the entity
 * @param {Array}  params.changes         - [{ field, before, after }]
 */
async function logPermissionChange({
  workspaceId,
  actorId,
  actorName,
  action,
  targetType,
  targetId,
  targetName,
  changes = [],
}) {
  try {
    const logId = uuidv4();
    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + TTL_90_DAYS_SECONDS;

    const item = {
      PK: `WORKSPACE#${workspaceId}`,
      SK: `LOG#${now}#${logId}`,
      logId,
      workspaceId,
      actorId: actorId || workspaceId,
      actorName: actorName || 'Unknown',
      action,
      targetType,
      targetId: targetId || '',
      targetName: targetName || '',
      changes,
      createdAt: now,
      ttl,
    };

    await dynamoDbClient.send(new PutCommand({
      TableName: AUDIT_LOG_TABLE,
      Item: item,
    }));
  } catch (error) {
    // Audit log failure must never crash the main request
    console.error('[AuditLog] Failed to write audit log entry:', error.message);
  }
}

module.exports = { logPermissionChange };
