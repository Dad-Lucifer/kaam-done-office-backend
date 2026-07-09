'use strict';

const { Router } = require('express');
const protect = require('../middleware/protect');
const {
  getRolePermissions,
  updateRolePermissions,
  getCategoryOverrides,
  upsertCategoryOverride,
  getChannelOverrides,
  upsertChannelOverride,
  resolveUserPermissions,
  getAuditLogs,
} = require('../controllers/permissionsController');

const router = Router();

// ── Role Permissions ──────────────────────────────────────────────────────────
/** @route GET /api/permissions/roles/:roleId — Get full permission map for a role */
router.get('/roles/:roleId', protect, getRolePermissions);

/** @route PUT /api/permissions/roles/:roleId — Update workspace-level permissions for a role */
router.put('/roles/:roleId', protect, updateRolePermissions);

// ── Category Overrides ────────────────────────────────────────────────────────
/** @route GET /api/permissions/categories/:categoryId/overrides — Get all role overrides on a category */
router.get('/categories/:categoryId/overrides', protect, getCategoryOverrides);

/** @route PUT /api/permissions/categories/:categoryId/roles/:roleId — Upsert override for a role on a category */
router.put('/categories/:categoryId/roles/:roleId', protect, upsertCategoryOverride);

// ── Channel Overrides ─────────────────────────────────────────────────────────
/** @route GET /api/permissions/channels/:channelId/overrides?type=text|voice — Get all role overrides on a channel */
router.get('/channels/:channelId/overrides', protect, getChannelOverrides);

/** @route PUT /api/permissions/channels/:channelId/roles/:roleId?type=text|voice — Upsert override for a role on a channel */
router.put('/channels/:channelId/roles/:roleId', protect, upsertChannelOverride);

// ── User Inspector ────────────────────────────────────────────────────────────
/** @route GET /api/permissions/users/:memberId/resolve — Resolve full effective permissions for a member */
router.get('/users/:memberId/resolve', protect, resolveUserPermissions);

// ── Audit Logs ────────────────────────────────────────────────────────────────
/** @route GET /api/permissions/audit?from=ISO&to=ISO&limit=50 — Fetch audit log entries */
router.get('/audit', protect, getAuditLogs);

module.exports = router;
