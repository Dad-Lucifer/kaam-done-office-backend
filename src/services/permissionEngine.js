'use strict';

const { GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamoDbClient } = require('../config/awsConfig');

const ROLES_TABLE = 'roles';
const TEAM_MEMBERS_TABLE = 'team-members';
const CATEGORIES_TABLE = 'categories';
const TEXT_CHANNELS_TABLE = 'text-channels';
const VOICE_CHANNELS_TABLE = 'voice-channels';

// All 43 permission keys supported by the system
const ALL_PERMISSIONS = [
  'VIEW_WORKSPACE', 'EDIT_WORKSPACE', 'DELETE_WORKSPACE', 'MANAGE_WORKSPACE',
  'VIEW_MEMBERS', 'INVITE_MEMBERS', 'EDIT_MEMBERS', 'REMOVE_MEMBERS', 'MANAGE_ROLES',
  'VIEW_CATEGORY', 'CREATE_CATEGORY', 'EDIT_CATEGORY', 'DELETE_CATEGORY',
  'VIEW_TEXT_CHANNEL', 'CREATE_TEXT_CHANNEL', 'EDIT_TEXT_CHANNEL', 'DELETE_TEXT_CHANNEL',
  'READ_MESSAGES', 'SEND_MESSAGES', 'DELETE_MESSAGES', 'PIN_MESSAGES', 'MANAGE_MESSAGES',
  'VIEW_VOICE_CHANNEL', 'CREATE_VOICE_CHANNEL', 'EDIT_VOICE_CHANNEL', 'DELETE_VOICE_CHANNEL',
  'JOIN_VOICE', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'KICK_MEMBERS',
  'ADMINISTRATOR',
  // Task Manager permissions
  'CREATE_TASK', 'EDIT_TASK', 'DELETE_TASK', 'ASSIGN_TASK',
  'MANAGE_TASKS', 'COMMENT_TASK', 'TRACK_TIME', 'VIEW_PRIVATE_TASKS',
  // AI-HR permissions
  'USE_AI_HR', 'VIEW_AI_HR_HISTORY', 'MANAGE_AI_HR',
];

// ============================================================
//  DATA FETCHERS
// ============================================================

/**
 * Fetches a team member item from DynamoDB.
 * @param {string} workspaceId - adminUserId
 * @param {string} memberId
 * @returns {Promise<Object|null>}
 */
async function getMember(workspaceId, memberId) {
  const result = await dynamoDbClient.send(new GetCommand({
    TableName: TEAM_MEMBERS_TABLE,
    Key: { PK: `ADMIN#${workspaceId}`, SK: `MEMBER#${memberId}` },
  }));
  return result.Item || null;
}

/**
 * Fetches all role items for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<Object[]>}
 */
async function getAllRoles(workspaceId) {
  const result = await dynamoDbClient.send(new QueryCommand({
    TableName: ROLES_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `ADMIN#${workspaceId}` },
  }));
  return result.Items || [];
}

// ============================================================
//  NORMALIZATION
// ============================================================

/**
 * Normalizes a legacy boolean permissions map to the 3-state format.
 * true  → 'ALLOW'
 * false → 'DENY'
 * undefined/null → 'INHERIT'
 * Already normalized values pass through unchanged.
 *
 * @param {Object} rawPermissions
 * @returns {Object} normalized permissions
 */
function normalizePermissions(rawPermissions) {
  if (!rawPermissions) return {};
  const result = {};
  for (const key of Object.keys(rawPermissions)) {
    const val = rawPermissions[key];
    if (val === 'ALLOW' || val === 'DENY' || val === 'INHERIT') {
      result[key] = val;
    } else if (val === true) {
      result[key] = 'ALLOW';
    } else if (val === false) {
      result[key] = 'DENY';
    } else {
      result[key] = 'INHERIT';
    }
  }
  return result;
}

// ============================================================
//  MERGE LOGIC
// ============================================================

/**
 * Merges multiple per-role permission maps using the rule:
 *   DENY from any role wins.
 *   ALLOW from any role wins over INHERIT.
 *   INHERIT is the default when no role has an opinion.
 *
 * @param {Object[]} permissionMaps - Array of normalized permission objects
 * @returns {Object} merged permission map
 */
function mergeRolePermissions(permissionMaps) {
  const merged = {};
  for (const perm of ALL_PERMISSIONS) {
    let state = 'INHERIT';
    for (const map of permissionMaps) {
      const val = (map && map[perm]) ? map[perm] : 'INHERIT';
      if (val === 'DENY') { state = 'DENY'; break; }
      if (val === 'ALLOW') state = 'ALLOW';
    }
    merged[perm] = state;
  }
  return merged;
}

// ============================================================
//  RESOLUTION ENGINE
// ============================================================

/**
 * Resolves the effective permission state for a single permission key.
 *
 * Resolution order:
 *   1. OWNER role → return ALLOW (bypass all checks)
 *   2. ADMINISTRATOR permission → return ALLOW
 *   3. Channel-level override → if not INHERIT, return it
 *   4. Category-level override → if not INHERIT, return it
 *   5. Workspace role-level permission → if not INHERIT, return it
 *   6. Default → DENY
 *
 * @param {string} workspaceId - adminUserId of the workspace
 * @param {string} memberId
 * @param {string} permission - one of ALL_PERMISSIONS
 * @param {{ channelId?: string, channelType?: 'text'|'voice', categoryId?: string }} [context]
 * @returns {Promise<{ state: 'ALLOW'|'DENY', source: string }>}
 */
async function resolveEffectivePermission(workspaceId, memberId, permission, context = {}) {
  const member = await getMember(workspaceId, memberId);
  if (!member) return { state: 'DENY', source: 'DEFAULT' };

  // Build roleIds array (supports both old single roleId and new array)
  const roleIds = member.roleIds || (member.roleId ? [member.roleId] : []);
  if (roleIds.length === 0) return { state: 'DENY', source: 'DEFAULT' };

  // Fetch all workspace roles once
  const allRoles = await getAllRoles(workspaceId);
  const memberRoles = allRoles.filter(r => roleIds.includes(r.roleId));

  // ── Step 1: OWNER bypass ──────────────────────────────────────────────────
  if (memberRoles.some(r => r.isOwner === true)) {
    return { state: 'ALLOW', source: 'OWNER' };
  }

  // Build normalized workspace-level permissions per role
  const normalizedMaps = memberRoles.map(r => normalizePermissions(r.permissions));
  const workspacePerms = mergeRolePermissions(normalizedMaps);

  // ── Step 2: ADMINISTRATOR grants all ──────────────────────────────────────
  if (workspacePerms['ADMINISTRATOR'] === 'ALLOW') {
    return { state: 'ALLOW', source: 'ADMINISTRATOR' };
  }

  // ── Step 3: Channel-level override ────────────────────────────────────────
  if (context.channelId) {
    const table = context.channelType === 'voice' ? VOICE_CHANNELS_TABLE : TEXT_CHANNELS_TABLE;
    const chanResult = await dynamoDbClient.send(new GetCommand({
      TableName: table,
      Key: { roomId: context.channelId },
    }));
    const chanItem = chanResult.Item;
    if (chanItem && chanItem.permissionOverrides) {
      const overrideMaps = roleIds
        .filter(rid => chanItem.permissionOverrides[rid])
        .map(rid => chanItem.permissionOverrides[rid]);
      if (overrideMaps.length > 0) {
        const merged = mergeRolePermissions(overrideMaps);
        if (merged[permission] && merged[permission] !== 'INHERIT') {
          return { state: merged[permission], source: 'CHANNEL_OVERRIDE' };
        }
      }
    }
  }

  // ── Step 4: Category-level override ───────────────────────────────────────
  if (context.categoryId) {
    const catResult = await dynamoDbClient.send(new GetCommand({
      TableName: CATEGORIES_TABLE,
      Key: { categoryId: context.categoryId },
    }));
    const catItem = catResult.Item;
    if (catItem && catItem.permissionOverrides) {
      const overrideMaps = roleIds
        .filter(rid => catItem.permissionOverrides[rid])
        .map(rid => catItem.permissionOverrides[rid]);
      if (overrideMaps.length > 0) {
        const merged = mergeRolePermissions(overrideMaps);
        if (merged[permission] && merged[permission] !== 'INHERIT') {
          return { state: merged[permission], source: 'CATEGORY_OVERRIDE' };
        }
      }
    }
  }

  // ── Step 5: Workspace role permission ─────────────────────────────────────
  const wsState = workspacePerms[permission] || 'INHERIT';
  if (wsState !== 'INHERIT') {
    return { state: wsState, source: 'WORKSPACE_ROLE' };
  }

  // ── Step 6: Default deny ──────────────────────────────────────────────────
  return { state: 'DENY', source: 'DEFAULT' };
}

/**
 * Resolves ALL effective permissions for a member at once.
 * Fetches roles and overrides only once and reuses data for all permissions.
 *
 * @param {string} workspaceId
 * @param {string} memberId
 * @param {{ channelId?: string, channelType?: 'text'|'voice', categoryId?: string }} [context]
 * @returns {Promise<Record<string, { state: 'ALLOW'|'DENY', source: string }>>}
 */
async function resolveAllPermissions(workspaceId, memberId, context = {}) {
  const member = await getMember(workspaceId, memberId);
  if (!member) {
    return Object.fromEntries(ALL_PERMISSIONS.map(p => [p, { state: 'DENY', source: 'DEFAULT' }]));
  }

  const roleIds = member.roleIds || (member.roleId ? [member.roleId] : []);
  if (roleIds.length === 0) {
    return Object.fromEntries(ALL_PERMISSIONS.map(p => [p, { state: 'DENY', source: 'DEFAULT' }]));
  }

  const allRoles = await getAllRoles(workspaceId);
  const memberRoles = allRoles.filter(r => roleIds.includes(r.roleId));

  // OWNER bypass — all permissions are ALLOW
  if (memberRoles.some(r => r.isOwner === true)) {
    return Object.fromEntries(ALL_PERMISSIONS.map(p => [p, { state: 'ALLOW', source: 'OWNER' }]));
  }

  const normalizedMaps = memberRoles.map(r => normalizePermissions(r.permissions));
  const workspacePerms = mergeRolePermissions(normalizedMaps);

  // ADMINISTRATOR — all permissions ALLOW
  if (workspacePerms['ADMINISTRATOR'] === 'ALLOW') {
    return Object.fromEntries(ALL_PERMISSIONS.map(p => [p, { state: 'ALLOW', source: 'ADMINISTRATOR' }]));
  }

  // Fetch channel and category overrides once
  let chanOverrides = null;
  if (context.channelId) {
    const table = context.channelType === 'voice' ? VOICE_CHANNELS_TABLE : TEXT_CHANNELS_TABLE;
    const r = await dynamoDbClient.send(new GetCommand({ TableName: table, Key: { roomId: context.channelId } }));
    if (r.Item && r.Item.permissionOverrides) chanOverrides = r.Item.permissionOverrides;
  }

  let catOverrides = null;
  if (context.categoryId) {
    const r = await dynamoDbClient.send(new GetCommand({ TableName: CATEGORIES_TABLE, Key: { categoryId: context.categoryId } }));
    if (r.Item && r.Item.permissionOverrides) catOverrides = r.Item.permissionOverrides;
  }

  const result = {};
  for (const perm of ALL_PERMISSIONS) {
    // Channel override
    if (chanOverrides) {
      const maps = roleIds.filter(rid => chanOverrides[rid]).map(rid => chanOverrides[rid]);
      if (maps.length > 0) {
        const merged = mergeRolePermissions(maps);
        if (merged[perm] && merged[perm] !== 'INHERIT') {
          result[perm] = { state: merged[perm], source: 'CHANNEL_OVERRIDE' };
          continue;
        }
      }
    }
    // Category override
    if (catOverrides) {
      const maps = roleIds.filter(rid => catOverrides[rid]).map(rid => catOverrides[rid]);
      if (maps.length > 0) {
        const merged = mergeRolePermissions(maps);
        if (merged[perm] && merged[perm] !== 'INHERIT') {
          result[perm] = { state: merged[perm], source: 'CATEGORY_OVERRIDE' };
          continue;
        }
      }
    }
    // Workspace role
    const wsState = workspacePerms[perm] || 'INHERIT';
    if (wsState !== 'INHERIT') {
      result[perm] = { state: wsState, source: 'WORKSPACE_ROLE' };
    } else {
      result[perm] = { state: 'DENY', source: 'DEFAULT' };
    }
  }

  return result;
}

/**
 * Quick boolean check — returns true if the member has the given permission.
 *
 * @param {string} workspaceId
 * @param {string} memberId
 * @param {string} permission
 * @param {Object} [context]
 * @returns {Promise<boolean>}
 */
async function hasPermission(workspaceId, memberId, permission, context = {}) {
  const { state } = await resolveEffectivePermission(workspaceId, memberId, permission, context);
  return state === 'ALLOW';
}

module.exports = {
  resolveEffectivePermission,
  resolveAllPermissions,
  hasPermission,
  normalizePermissions,
  mergeRolePermissions,
  ALL_PERMISSIONS,
};
