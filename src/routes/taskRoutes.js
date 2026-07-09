'use strict';

const express = require('express');
const router = express.Router();
const protect = require('../middleware/protect');
const requirePermission = require('../middleware/requirePermission');
const { requireActiveSubscription, checkPlanLimit, checkSubscriptionPermission } = require('../middleware/subscription');
const {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  changeStatus,
  assignTask,
  addComment,
  deleteComment,
  createSubtask,
  updateSubtask,
  startTimer,
  stopTimer,
  getTimeSessions,
  presignAttachment,
  getAnalytics,
} = require('../controllers/taskController');

// All task routes require authentication
router.use(protect);

// ── Analytics (before /:taskId to avoid param collision) ─────────────────────
router.get('/analytics', requirePermission('VIEW_WORKSPACE'), checkSubscriptionPermission('analyticsAccess'), getAnalytics);

// ── Task CRUD ─────────────────────────────────────────────────────────────────
router.get('/',    requirePermission('VIEW_WORKSPACE'), listTasks);
router.post('/',   requirePermission('CREATE_TASK'),    checkPlanLimit('task'), createTask);
router.get('/:taskId',    requirePermission('VIEW_WORKSPACE'), getTask);
router.patch('/:taskId',  requirePermission('EDIT_TASK'),      updateTask);
router.delete('/:taskId', requirePermission('DELETE_TASK'),    deleteTask);

// ── Status ────────────────────────────────────────────────────────────────────
router.patch('/:taskId/status', requirePermission('EDIT_TASK'), changeStatus);

// ── Assignment ────────────────────────────────────────────────────────────────
router.patch('/:taskId/assign', requirePermission('ASSIGN_TASK'), assignTask);

// ── Comments ──────────────────────────────────────────────────────────────────
router.post('/:taskId/comments', requirePermission('COMMENT_TASK'), addComment);
router.delete('/:taskId/comments/:commentId', requirePermission('COMMENT_TASK'), deleteComment);

// ── Subtasks ──────────────────────────────────────────────────────────────────
router.post('/:taskId/subtasks', requirePermission('EDIT_TASK'), createSubtask);
router.patch('/:taskId/subtasks/:subtaskId', requirePermission('VIEW_WORKSPACE'), updateSubtask);

// ── Time Tracking ─────────────────────────────────────────────────────────────
router.post('/:taskId/time/start', requirePermission('TRACK_TIME'), startTimer);
router.post('/:taskId/time/stop',  requirePermission('TRACK_TIME'), stopTimer);
router.get('/:taskId/time',        requirePermission('VIEW_WORKSPACE'), getTimeSessions);

// ── Attachments ───────────────────────────────────────────────────────────────
router.post('/:taskId/attachments/presign', requirePermission('EDIT_TASK'), presignAttachment);

module.exports = router;
