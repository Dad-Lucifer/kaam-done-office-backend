'use strict';

const express = require('express');
const router = express.Router();
const protect = require('../middleware/protect');
const { getAttendanceLogs, getMemberAttendance, getTaskActivity } = require('../controllers/auditLogsController');

// All audit-log routes require authentication
router.use(protect);

/**
 * @route   GET /api/audit-logs/attendance
 * @desc    Get all attendance logs for the workspace (admin only)
 * @access  Private (admin)
 * @query   dateFrom, dateTo, memberId, limit
 */
router.get('/attendance', getAttendanceLogs);

/**
 * @route   GET /api/audit-logs/attendance/:memberId
 * @desc    Get attendance records for a specific team member (admin only)
 * @access  Private (admin)
 * @query   dateFrom, dateTo, limit
 */
router.get('/attendance/:memberId', getMemberAttendance);

/**
 * @route   GET /api/audit-logs/tasks
 * @desc    Get task activity grouped by member (admin only)
 * @access  Private (admin)
 * @query   memberId, status, limit
 */
router.get('/tasks', getTaskActivity);

module.exports = router;
