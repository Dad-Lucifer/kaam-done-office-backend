'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Payment Controller
//
// Handles Razorpay order creation and server-side payment verification.
// On successful verification, automatically creates/activates the subscription.
// ─────────────────────────────────────────────────────────────────────────────

const Razorpay = require('razorpay');
const crypto = require('crypto');
const config = require('../config/env');
const { createPaidSubscription, getCurrentUsage } = require('../services/subscriptionService');
const { PLAN_DEFINITIONS } = require('../config/planConfig');

const razorpay = new Razorpay({
  key_id:     config.RAZORPAY_KEY_ID     || process.env.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET,
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/create-order
// Creates a Razorpay order for the given amount (in paise).
// ─────────────────────────────────────────────────────────────────────────────
exports.createOrder = async (req, res) => {
  try {
    const { amount, currency = 'INR', planId } = req.body;

    if (!amount) {
      return res.status(400).json({ success: false, message: 'Amount is required.' });
    }

    if (planId && !PLAN_DEFINITIONS[planId]) {
      return res.status(400).json({ success: false, message: `Unknown plan: ${planId}` });
    }

    const options = {
      amount,   // already in paise from the frontend
      currency,
      receipt: `rcpt_${planId || 'plan'}_${Date.now()}`,
      notes: {
        workspaceId: req.user?.userId || 'unknown',
        planId: planId || 'unknown',
      },
    };

    const order = await razorpay.orders.create(options);

    res.status(200).json({
      success: true,
      order_id: order.id,
      currency: order.currency,
      amount: order.amount,
    });
  } catch (error) {
    console.error('[Payment] Error creating Razorpay order:', error);
    res.status(500).json({ success: false, message: 'Error creating order.', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify-payment
// Verifies the HMAC signature from Razorpay, then activates the subscription.
//
// Body: {
//   razorpay_order_id, razorpay_payment_id, razorpay_signature,
//   planId   (required to know which plan to activate)
// }
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment details are missing.' });
    }

    // ── 1. Verify HMAC signature ──────────────────────────────────────────────
    const secret = config.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET;
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed: signature mismatch.',
      });
    }

    // ── 2. Activate subscription ──────────────────────────────────────────────
    let subscription = null;
    let usage = null;

    if (planId && planId !== 'free' && PLAN_DEFINITIONS[planId]) {
      const workspaceId = req.user?.userId;
      if (workspaceId) {
        subscription = await createPaidSubscription({
          workspaceId,
          planId,
          razorpayOrderId:   razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
        });

        usage = await getCurrentUsage(workspaceId);
        const limits = subscription.limits || {};

        usage = {
          categories:    { current: usage.categories,    max: limits.maxCategories    ?? 0 },
          textChannels:  { current: usage.textChannels,  max: limits.maxTextChannels  ?? 0 },
          voiceChannels: { current: usage.voiceChannels, max: limits.maxVoiceChannels ?? 0 },
          taskManagers:  { current: usage.taskManagers,  max: limits.maxTaskManagers  ?? 0 },
          tasks:         { current: usage.tasks,         max: limits.maxTasks         ?? 0 },
          teamMembers:   { current: usage.teamMembers,   max: limits.maxTeamMembers   ?? 0 },
          roles:         { current: usage.roles,         max: limits.maxRoles         ?? 0 },
        };
      }
    }

    return res.status(200).json({
      success: true,
      message: subscription
        ? `Payment verified. ${subscription.planName} plan activated successfully.`
        : 'Payment verified successfully.',
      subscription,
      usage,
    });
  } catch (error) {
    console.error('[Payment] Error verifying payment:', error);
    res.status(500).json({ success: false, message: 'Error verifying payment.', error: error.message });
  }
};
