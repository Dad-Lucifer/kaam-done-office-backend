'use strict';

const express = require('express');
const router = express.Router();
const protect = require('../middleware/protect');
const {
  listChannels,
  createChannel,
  deleteChannel,
  getChatHistory,
  chat
} = require('../controllers/aiHrController');

router.use(protect);

// ── Channels ──
router.get('/channels', listChannels);
router.post('/channels', createChannel);
router.delete('/channels/:roomId', deleteChannel);

// ── Chat ──
router.get('/chat/:roomId', getChatHistory);
router.post('/chat', chat);

module.exports = router;
