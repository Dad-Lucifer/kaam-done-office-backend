'use strict';

const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { signup, login, verifyOTP, resendOTP, memberLogin, memberLogout, getMe } = require('../controllers/authController');

const protect = require('../middleware/protect');
const {
  signupRules,
  loginRules,
  verifyRules,
  resendRules,
} = require('../middleware/validateRequest');

const router = Router();

/**
 * @route   POST /api/auth/signup
 * @desc    Register a new user (Cognito + DynamoDB)
 * @access  Public
 */
router.post('/signup', signupRules, signup);

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user and return JWT tokens
 * @access  Public
 */
router.post('/login', loginRules, login);

/**
 * @route   POST /api/auth/verify
 * @desc    Confirm user email with Cognito OTP code
 * @access  Public
 */
router.post('/verify', verifyRules, verifyOTP);

/**
 * @route   POST /api/auth/resend
 * @desc    Resend Cognito email verification code
 * @access  Public
 */
router.post('/resend', resendRules, resendOTP);

/**
 * @route   POST /api/auth/member-login
 * @desc    Authenticate team member via DynamoDB and return custom JWT
 * @access  Public
 */
router.post('/member-login', [
  body('username').notEmpty().withMessage('Username is required.'),
  body('password').notEmpty().withMessage('Password is required.'),
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
  }
], memberLogin);

/**
 * @route   POST /api/auth/member-logout
 * @desc    Close active attendance session for team member
 * @access  Private (team member JWT)
 */
router.post('/member-logout', protect, memberLogout);

/**
 * @route   GET /api/auth/me
 * @desc    Get currently logged in user
 * @access  Private
 */
router.get('/me', protect, getMe);

module.exports = router;
