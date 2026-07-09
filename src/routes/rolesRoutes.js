'use strict';

const { Router } = require('express');
const { body, validationResult } = require('express-validator');

const protect = require('../middleware/protect');
const { requireActiveSubscription, checkPlanLimit, checkSubscriptionPermission } = require('../middleware/subscription');
const { listRoles, createRole, updateRole, deleteRole } = require('../controllers/rolesController');

const router = Router();

// ---- Inline validation middleware ----
const validateRole = [
  body('name').trim().notEmpty().withMessage('Role name is required.').isLength({ max: 80 }),
  body('color').trim().notEmpty().withMessage('Color is required.'),
  body('permissions').isObject().withMessage('Permissions must be an object.'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
      });
    }
    next();
  },
];

// ---- Routes (all protected) ----

/**
 * @route   GET /api/roles
 * @desc    List all roles for the authenticated admin
 * @access  Private
 */
router.get('/', protect, listRoles);

/**
 * @route   POST /api/roles
 * @desc    Create a new role
 * @access  Private
 */
router.post('/', protect, validateRole, requireActiveSubscription(), checkPlanLimit('role'), checkSubscriptionPermission('customRolesAccess'), createRole);

/**
 * @route   PUT /api/roles/:roleId
 * @desc    Update an existing role
 * @access  Private
 */
router.put('/:roleId', protect, validateRole, updateRole);

/**
 * @route   DELETE /api/roles/:roleId
 * @desc    Delete a role
 * @access  Private
 */
router.delete('/:roleId', protect, deleteRole);

module.exports = router;
