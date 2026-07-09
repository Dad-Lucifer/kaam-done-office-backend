'use strict';

const { Router } = require('express');
const protect = require('../middleware/protect');
const { getActive, getUsage, activate } = require('../controllers/subscriptionController');

const router = Router();

/**
 * @route   GET /api/subscriptions/active
 * @desc    Get the active subscription + usage counts for the authenticated workspace
 * @access  Private (admin and team members)
 */
router.get('/active', protect, getActive);

/**
 * @route   GET /api/subscriptions/usage
 * @desc    Get current resource usage counts vs plan limits
 * @access  Private
 */
router.get('/usage', protect, getUsage);

/**
 * @route   POST /api/subscriptions/activate
 * @desc    Activate a paid subscription after successful Razorpay payment verification
 * @access  Private (admin only)
 * @body    { planId, razorpayOrderId, razorpayPaymentId }
 */
router.post('/activate', protect, activate);

module.exports = router;
