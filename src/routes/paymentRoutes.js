'use strict';

const express = require('express');
const router = express.Router();
const protect = require('../middleware/protect');
const paymentController = require('../controllers/paymentController');

// Route to create a Razorpay order (auth required for workspace tracking)
router.post('/create-order', protect, paymentController.createOrder);

// Route to verify a Razorpay payment and activate subscription
router.post('/verify-payment', protect, paymentController.verifyPayment);

module.exports = router;
