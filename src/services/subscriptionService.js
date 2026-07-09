'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Subscription Service
//
// Core business logic for subscription lifecycle:
//   - Fetching the active subscription for a workspace
//   - Creating/activating subscriptions after payment
//   - Computing current resource usage counts
//   - Checking whether a resource limit would be exceeded
// ─────────────────────────────────────────────────────────────────────────────

const { PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../config/awsConfig');
const {
  SUBSCRIPTIONS_TABLE,
  TASK_MANAGER_TABLE,   // 'assigned-task'
  TASK_CHANNELS_TABLE,  // 'task-channels'
  CATEGORIES_TABLE,
  VOICE_CHANNELS_TABLE,
  TEAM_MEMBERS_TABLE_NAME,
  ROLES_TABLE_NAME,
  TEXT_CHANNELS_TABLE,
} = require('../config/dbSetup');
const { PLAN_DEFINITIONS, RESOURCE_LIMIT_MAP } = require('../config/planConfig');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the subscription is active (status + not expired).
 * Free plans never expire.
 */
function isSubscriptionActive(sub) {
  if (!sub) return false;
  if (sub.status === 'cancelled') return false;
  if (sub.planId === 'free') return sub.status === 'active'; // free never expires
  if (sub.status !== 'active' && sub.status !== 'trial') return false;
  if (sub.expiryDate && new Date(sub.expiryDate) < new Date()) return false;
  return true;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Fetches the most recent active subscription for a given workspaceId.
 * If none exists, auto-bootstraps a Free plan record so the workspace is
 * always in a defined state (no subscription = Free, not blocked).
 *
 * @param {string} workspaceId  adminUserId
 * @returns {Promise<Object>}   subscription record
 */
async function getActiveSubscription(workspaceId) {
  const result = await dynamoDbClient.send(
    new QueryCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      IndexName: 'workspaceId-index',
      KeyConditionExpression: 'workspaceId = :wid',
      ExpressionAttributeValues: { ':wid': workspaceId },
      // Sort desc by SK so newest is first — SK = SUBSCRIPTION#<uuid>
      ScanIndexForward: false,
    })
  );

  const items = result.Items || [];

  // Find the first item that is truly active
  const active = items.find(isSubscriptionActive);
  if (active) return active;

  // No active subscription found — bootstrap a Free plan
  return bootstrapFreeSubscription(workspaceId);
}

/**
 * Creates a Free plan subscription record for a workspace that has none.
 * Idempotent: if called twice, the second write silently replaces with same data.
 */
async function bootstrapFreeSubscription(workspaceId) {
  const freePlan = PLAN_DEFINITIONS.free;
  const subscriptionId = uuidv4();
  const now = new Date().toISOString();

  const item = {
    PK: `WORKSPACE#${workspaceId}`,
    SK: `SUBSCRIPTION#${subscriptionId}`,
    subscriptionId,
    workspaceId,
    ownerUserId: workspaceId,
    planId: 'free',
    planName: freePlan.planName,
    status: 'active',
    razorpayOrderId: null,
    razorpayPaymentId: null,
    startDate: now,
    expiryDate: null, // Free plan never expires
    limits: freePlan.limits,
    permissions: freePlan.permissions,
    createdAt: now,
    updatedAt: now,
  };

  await dynamoDbClient.send(
    new PutCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Item: item,
    })
  );

  console.log(`[Subscription] Bootstrapped Free plan for workspace: ${workspaceId}`);
  return item;
}

/**
 * Creates a paid subscription record after Razorpay payment verification.
 * Marks any previous active subscription as 'superseded' by writing a new record.
 * The new subscription's expiry is always 1 year from now.
 *
 * @param {Object} params
 * @param {string} params.workspaceId
 * @param {string} params.planId
 * @param {string} params.razorpayOrderId
 * @param {string} params.razorpayPaymentId
 * @returns {Promise<Object>}  the created subscription record
 */
async function createPaidSubscription({ workspaceId, planId, razorpayOrderId, razorpayPaymentId }) {
  const plan = PLAN_DEFINITIONS[planId];
  if (!plan) throw new Error(`Unknown planId: ${planId}`);

  const subscriptionId = uuidv4();
  const now = new Date();
  const expiryDate = new Date(now);
  expiryDate.setFullYear(expiryDate.getFullYear() + 1);

  const item = {
    PK: `WORKSPACE#${workspaceId}`,
    SK: `SUBSCRIPTION#${subscriptionId}`,
    subscriptionId,
    workspaceId,
    ownerUserId: workspaceId,
    planId,
    planName: plan.planName,
    status: 'active',
    razorpayOrderId: razorpayOrderId || null,
    razorpayPaymentId: razorpayPaymentId || null,
    startDate: now.toISOString(),
    expiryDate: expiryDate.toISOString(),
    limits: plan.limits,
    permissions: plan.permissions,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await dynamoDbClient.send(
    new PutCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Item: item,
    })
  );

  console.log(`[Subscription] Created ${planId} plan for workspace: ${workspaceId} (expires: ${expiryDate.toISOString()})`);
  return item;
}

/**
 * Counts current resource usage for a workspace.
 * All queries run in parallel for performance (single DynamoDB round-trip per resource).
 *
 * "taskManagers" counts rows in the task-channels table (each task channel/board
 * is what users refer to as a "Task Manager").
 * "tasks" counts individual task items in the assigned-task table.
 *
 * @param {string} workspaceId  adminUserId
 * @returns {Promise<Object>}   { categories, textChannels, voiceChannels, teamMembers, roles, taskManagers, tasks }
 */
async function getCurrentUsage(workspaceId) {
  const [categories, textChannels, voiceChannels, teamMembers, roles, taskManagers, tasks] = await Promise.all([
    // Categories
    dynamoDbClient.send(new QueryCommand({
      TableName: CATEGORIES_TABLE,
      IndexName: 'adminUserId-index',
      KeyConditionExpression: 'adminUserId = :aid',
      ExpressionAttributeValues: { ':aid': workspaceId },
      Select: 'COUNT',
    })).then(r => r.Count || 0),

    // Text Channels
    dynamoDbClient.send(new QueryCommand({
      TableName: TEXT_CHANNELS_TABLE,
      IndexName: 'adminUserId-index',
      KeyConditionExpression: 'adminUserId = :aid',
      ExpressionAttributeValues: { ':aid': workspaceId },
      Select: 'COUNT',
    })).then(r => r.Count || 0),

    // Voice Channels
    dynamoDbClient.send(new QueryCommand({
      TableName: VOICE_CHANNELS_TABLE,
      IndexName: 'adminUserId-index',
      KeyConditionExpression: 'adminUserId = :aid',
      ExpressionAttributeValues: { ':aid': workspaceId },
      Select: 'COUNT',
    })).then(r => r.Count || 0),

    // Team Members
    dynamoDbClient.send(new QueryCommand({
      TableName: TEAM_MEMBERS_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `ADMIN#${workspaceId}` },
      Select: 'COUNT',
    })).then(r => r.Count || 0),

    // Roles
    dynamoDbClient.send(new QueryCommand({
      TableName: ROLES_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `ADMIN#${workspaceId}` },
      Select: 'COUNT',
    })).then(r => r.Count || 0),

    // Task Managers — count task channel/board rows (adminUserId-index on task-channels table)
    dynamoDbClient.send(new QueryCommand({
      TableName: TASK_CHANNELS_TABLE,
      IndexName: 'adminUserId-index',
      KeyConditionExpression: 'adminUserId = :aid',
      ExpressionAttributeValues: { ':aid': workspaceId },
      Select: 'COUNT',
    })).then(r => r.Count || 0).catch(() => 0),

    // Individual Tasks — query via WORKSPACE# partition key on assigned-task table
    dynamoDbClient.send(new QueryCommand({
      TableName: TASK_MANAGER_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `WORKSPACE#${workspaceId}` },
      Select: 'COUNT',
    })).then(r => r.Count || 0).catch(() => 0),
  ]);

  return {
    categories,
    textChannels,
    voiceChannels,
    teamMembers,
    roles,
    taskManagers, // count of task boards/channels (user-facing "Task Managers")
    tasks,        // count of individual task items
  };
}

/**
 * Checks if creating a new resource would exceed the plan limit.
 *
 * @param {string} workspaceId
 * @param {string} resourceType  'category'|'textChannel'|'voiceChannel'|'teamMember'|'role'|'taskManager'|'task'
 * @returns {Promise<{ allowed: boolean, current: number, max: number, planName: string, planId: string, subscription: Object }>}
 */
async function checkLimit(workspaceId, resourceType) {
  const [subscription, usage] = await Promise.all([
    getActiveSubscription(workspaceId),
    getCurrentUsage(workspaceId),
  ]);

  const limitField = RESOURCE_LIMIT_MAP[resourceType];
  if (!limitField) {
    throw new Error(`Unknown resourceType for limit check: ${resourceType}`);
  }

  const max = subscription.limits?.[limitField] ?? 0;

  // Maps each resource type to the corresponding field in the usage object
  const usageFieldMap = {
    category:    'categories',
    textChannel: 'textChannels',
    voiceChannel:'voiceChannels',
    teamMember:  'teamMembers',
    role:        'roles',
    taskManager: 'taskManagers',
    task:        'tasks',
  };

  const current = usage[usageFieldMap[resourceType]] ?? 0;

  return {
    allowed: current < max,
    current,
    max,
    planName: subscription.planName,
    planId: subscription.planId,
    subscription,
  };
}

module.exports = {
  getActiveSubscription,
  createPaidSubscription,
  bootstrapFreeSubscription,
  getCurrentUsage,
  checkLimit,
  isSubscriptionActive,
};
