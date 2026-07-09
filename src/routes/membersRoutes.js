'use strict';

const { Router } = require('express');
const { body, validationResult } = require('express-validator');

const protect = require('../middleware/protect');
const { requireActiveSubscription, checkPlanLimit } = require('../middleware/subscription');
const { listMembers, createMember, updateMember, deleteMember } = require('../controllers/membersController');

const router = Router();

// ---- Inline validation ----

const validateCreateMember = [
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required.')
    .isLength({ min: 2, max: 60 }).withMessage('Username must be 2–60 characters.'),
  body('email')
    .optional({ nullable: true })
    .isEmail().withMessage('Please enter a valid email address.'),
  body('password')
    .notEmpty().withMessage('Password is required.')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
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
 * @route   GET /api/members
 * @desc    List all team members for the authenticated admin
 * @access  Private
 */
router.get('/', protect, listMembers);

/**
 * @route   POST /api/members
 * @desc    Create a new team member
 * @access  Private
 */
router.post('/', protect, requireActiveSubscription(), checkPlanLimit('teamMember'), validateCreateMember, createMember);

/**
 * @route   PATCH /api/members/:memberId
 * @desc    Update a member (reassign role, update username/email)
 * @access  Private
 */
router.patch('/:memberId', protect, updateMember);

/**
 * @route   DELETE /api/members/:memberId
 * @desc    Remove a team member
 * @access  Private
 */
router.delete('/:memberId', protect, deleteMember);

module.exports = router;
