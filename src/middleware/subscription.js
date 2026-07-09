'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Subscription Middleware
//
// Three middleware factories that enforce subscription rules at the route level:
//   1. requireActiveSubscription() — 402 if no active subscription
//   2. checkPlanLimit(resourceType) — 403 if resource count would exceed plan limit
//   3. checkSubscriptionPermission(permission) — 403 if feature not on current plan
//
// Usage:
//   router.post('/', protect, requireActiveSubscription(), checkPlanLimit('category'), handler);
// ─────────────────────────────────────────────────────────────────────────────

const {
  getActiveSubscription,
  checkLimit,
  isSubscriptionActive,
} = require('../services/subscriptionService');

const { RESOURCE_DISPLAY_NAMES } = require('../config/planConfig');

// ─── Helper: resolve workspaceId from req.user ────────────────────────────────
// For admins: userId IS the workspaceId.
// For team members: userId = adminUserId = workspaceId.
function resolveWorkspaceId(req) {
  return req.user.userId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. requireActiveSubscription
//
// Checks that the workspace has an active subscription (any plan including free).
// Returns 402 if subscription is expired or cancelled.
// Attaches req.subscription for downstream middleware to reuse (avoids extra DB calls).
// ─────────────────────────────────────────────────────────────────────────────
function requireActiveSubscription() {
  return async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const subscription = await getActiveSubscription(workspaceId);

      if (!isSubscriptionActive(subscription)) {
        return res.status(402).json({
          success: false,
          code: 'SUBSCRIPTION_INACTIVE',
          error: 'Your subscription has expired or been cancelled. Please upgrade to continue.',
          message: 'Your subscription has expired or been cancelled. Please upgrade to continue.',
          subscription: {
            status: subscription?.status || 'none',
            planId: subscription?.planId || null,
            expiryDate: subscription?.expiryDate || null,
          },
        });
      }

      // Attach to req so downstream middleware/handlers can read it without another DB call
      req.subscription = subscription;
      next();
    } catch (error) {
      next(error);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. checkPlanLimit
//
// Verifies that creating one more resource of resourceType would not exceed
// the current plan's limit. Returns 403 with details if limit is reached.
// Must be used after requireActiveSubscription() (to avoid a double DB lookup,
// it reuses req.subscription if present).
//
// @param {string} resourceType  'category'|'textChannel'|'voiceChannel'|'teamMember'|'role'|'taskManager'|'task'
// ─────────────────────────────────────────────────────────────────────────────
function checkPlanLimit(resourceType) {
  return async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const { allowed, current, max, planName, planId } = await checkLimit(workspaceId, resourceType);

      if (!allowed) {
        const displayName = RESOURCE_DISPLAY_NAMES[resourceType] || resourceType;
        const errorMsg = `Invalid action. Upgrade your subscription to create more ${displayName}s.`;

        return res.status(403).json({
          success: false,
          code: 'PLAN_LIMIT_REACHED',
          error: errorMsg,
          message: errorMsg,
          resourceType,
          displayName,
          current,
          max,
          planName,
          planId,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. checkSubscriptionPermission
//
// Verifies that the active subscription includes a specific feature permission.
// Must be used after requireActiveSubscription() — reuses req.subscription.
//
// @param {string} permission  e.g. 'taskManagerAccess'|'analyticsAccess'|'customRolesAccess'
// ─────────────────────────────────────────────────────────────────────────────
function checkSubscriptionPermission(permission) {
  return async (req, res, next) => {
    try {
      // Reuse cached subscription from requireActiveSubscription if available
      let subscription = req.subscription;

      if (!subscription) {
        const workspaceId = resolveWorkspaceId(req);
        subscription = await getActiveSubscription(workspaceId);
        req.subscription = subscription;
      }

      const hasPermission = subscription?.permissions?.[permission] === true;

      if (!hasPermission) {
        const errorMsg = `Invalid action. Your current plan (${subscription?.planName || 'Free'}) does not include access to this feature. Upgrade your subscription to continue.`;

        return res.status(403).json({
          success: false,
          code: 'SUBSCRIPTION_PERMISSION_DENIED',
          error: errorMsg,
          message: errorMsg,
          permission,
          planId: subscription?.planId || 'free',
          planName: subscription?.planName || 'Free',
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = {
  requireActiveSubscription,
  checkPlanLimit,
  checkSubscriptionPermission,
};
