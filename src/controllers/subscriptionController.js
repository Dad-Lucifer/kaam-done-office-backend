'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Subscription Controller
//
// REST handlers for the /api/subscriptions resource:
//   GET  /active   — return the active subscription + usage counts
//   GET  /usage    — return just the usage counts
//   POST /activate — called after client-side Razorpay payment + server verification
// ─────────────────────────────────────────────────────────────────────────────

const {
  getActiveSubscription,
  createPaidSubscription,
  getCurrentUsage,
} = require('../services/subscriptionService');

const { PLAN_DEFINITIONS } = require('../config/planConfig');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/active
// Returns the active subscription for the workspace, plus current usage counts.
// ─────────────────────────────────────────────────────────────────────────────
async function getActive(req, res, next) {
  try {
    const workspaceId = req.user.userId;

    const [subscription, usage] = await Promise.all([
      getActiveSubscription(workspaceId),
      getCurrentUsage(workspaceId),
    ]);

    // Build usage envelope with current + max for each resource
    const limits = subscription.limits || {};
    const usageWithLimits = {
      categories:    { current: usage.categories,    max: limits.maxCategories    ?? 0 },
      textChannels:  { current: usage.textChannels,  max: limits.maxTextChannels  ?? 0 },
      voiceChannels: { current: usage.voiceChannels, max: limits.maxVoiceChannels ?? 0 },
      taskManagers:  { current: usage.taskManagers,  max: limits.maxTaskManagers  ?? 0 },
      tasks:         { current: usage.tasks,         max: limits.maxTasks         ?? 0 },
      teamMembers:   { current: usage.teamMembers,   max: limits.maxTeamMembers   ?? 0 },
      roles:         { current: usage.roles,         max: limits.maxRoles         ?? 0 },
    };

    return res.status(200).json({
      success: true,
      data: {
        subscription,
        usage: usageWithLimits,
      },
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/usage
// Returns just the usage counts for the workspace's current plan.
// ─────────────────────────────────────────────────────────────────────────────
async function getUsage(req, res, next) {
  try {
    const workspaceId = req.user.userId;

    const [subscription, usage] = await Promise.all([
      getActiveSubscription(workspaceId),
      getCurrentUsage(workspaceId),
    ]);

    const limits = subscription.limits || {};

    return res.status(200).json({
      success: true,
      data: {
        planId:   subscription.planId,
        planName: subscription.planName,
        usage: {
          categories:    { current: usage.categories,    max: limits.maxCategories    ?? 0 },
          textChannels:  { current: usage.textChannels,  max: limits.maxTextChannels  ?? 0 },
          voiceChannels: { current: usage.voiceChannels, max: limits.maxVoiceChannels ?? 0 },
          taskManagers:  { current: usage.taskManagers,  max: limits.maxTaskManagers  ?? 0 },
          tasks:         { current: usage.tasks,         max: limits.maxTasks         ?? 0 },
          teamMembers:   { current: usage.teamMembers,   max: limits.maxTeamMembers   ?? 0 },
          roles:         { current: usage.roles,         max: limits.maxRoles         ?? 0 },
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscriptions/activate
// Called after Razorpay payment is verified on the client.
// Creates a paid subscription record. The payment signature must already be
// verified by /api/payments/verify-payment before this is called.
//
// Body: { planId, razorpayOrderId, razorpayPaymentId, razorpaySignature }
// ─────────────────────────────────────────────────────────────────────────────
async function activate(req, res, next) {
  try {
    const workspaceId = req.user.userId;
    const { planId, razorpayOrderId, razorpayPaymentId } = req.body;

    if (!planId || !razorpayOrderId || !razorpayPaymentId) {
      return res.status(400).json({
        success: false,
        message: 'planId, razorpayOrderId, and razorpayPaymentId are required.',
      });
    }

    if (!PLAN_DEFINITIONS[planId]) {
      return res.status(400).json({
        success: false,
        message: `Unknown plan: ${planId}. Valid plans: ${Object.keys(PLAN_DEFINITIONS).join(', ')}`,
      });
    }

    if (planId === 'free') {
      return res.status(400).json({
        success: false,
        message: 'Cannot activate a Free plan via payment. Free plans are automatically assigned.',
      });
    }

    const subscription = await createPaidSubscription({
      workspaceId,
      planId,
      razorpayOrderId,
      razorpayPaymentId,
    });

    const usage = await getCurrentUsage(workspaceId);
    const limits = subscription.limits || {};

    return res.status(201).json({
      success: true,
      message: `Successfully activated ${subscription.planName} plan.`,
      data: {
        subscription,
        usage: {
          categories:    { current: usage.categories,    max: limits.maxCategories    ?? 0 },
          textChannels:  { current: usage.textChannels,  max: limits.maxTextChannels  ?? 0 },
          voiceChannels: { current: usage.voiceChannels, max: limits.maxVoiceChannels ?? 0 },
          taskManagers:  { current: usage.taskManagers,  max: limits.maxTaskManagers  ?? 0 },
          tasks:         { current: usage.tasks,         max: limits.maxTasks         ?? 0 },
          teamMembers:   { current: usage.teamMembers,   max: limits.maxTeamMembers   ?? 0 },
          roles:         { current: usage.roles,         max: limits.maxRoles         ?? 0 },
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getActive, getUsage, activate };
