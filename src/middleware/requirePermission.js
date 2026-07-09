'use strict';

const { hasPermission } = require('../services/permissionEngine');

/**
 * requirePermission(permission, getContext?)
 *
 * Express middleware factory that checks if the authenticated team member
 * has the specified permission. Admin (Cognito) users always pass through.
 *
 * @param {string} permission - One of the ALL_PERMISSIONS keys
 * @param {Function} [getContext] - Optional (req) => { channelId, channelType, categoryId }
 * @returns {Function} Express middleware
 *
 * @example
 * router.delete('/:id', protect, requirePermission('DELETE_CATEGORY'), handler);
 * router.post('/', protect, requirePermission('SEND_MESSAGES', req => ({ channelId: req.params.id })), handler);
 */
function requirePermission(permission, getContext) {
  return async (req, res, next) => {
    try {
      const user = req.user;

      // Admin users (Cognito-authenticated workspace owners) always pass
      if (!user.isTeamMember) return next();

      // workspaceId = adminUserId stored in the team-member JWT as userId
      const workspaceId = user.userId;
      const memberId = user.memberId;

      if (!memberId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied: member identity not found.',
        });
      }

      const context = getContext ? getContext(req) : {};
      const allowed = await hasPermission(workspaceId, memberId, permission, context);

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: `Access denied: missing permission "${permission}".`,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = requirePermission;
