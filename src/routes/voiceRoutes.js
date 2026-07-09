'use strict';

const { Router } = require('express');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const protect = require('../middleware/protect');
const { requireActiveSubscription, checkPlanLimit } = require('../middleware/subscription');
const { generateToken } = require('../controllers/voiceController');
const createVoiceChannelLambda = require('../../lambdas/voice/createVoiceChannel');
const deleteVoiceChannelLambda = require('../../lambdas/voice/deleteVoiceChannel');
const { dynamoDbClient } = require('../config/awsConfig');

const router = Router();
const dynamoDb = dynamoDbClient;
const VOICE_CHANNELS_TABLE = 'voice-channels';

// ─── Helper: adapt Express req/res to Lambda Proxy event ─────────────────────

const invokeLambda = (lambdaHandler) => async (req, res, next) => {
  try {
    const event = {
      body: JSON.stringify({ ...req.body, adminUserId: req.user.userId }),
      pathParameters: req.params,
      queryStringParameters: req.query,
      headers: req.headers,
    };
    const result = await lambdaHandler(event);
    res.status(result.statusCode || 200).json(JSON.parse(result.body));
  } catch (error) {
    next(error);
  }
};

// ─── Voice Token ──────────────────────────────────────────────────────────────

/**
 * @route   POST /api/voice/token
 * @desc    Generate a LiveKit JWT for a voice room participant
 * @access  Private (requires valid Cognito or member JWT)
 * @body    { roomName: string, username?: string }
 */
router.post('/token', protect, generateToken);

// ─── Voice Channel CRUD ───────────────────────────────────────────────────────

/**
 * @route   GET /api/voice/channels
 * @desc    List all voice channels for the authenticated admin (or member's workspace)
 * @access  Private
 */
router.get('/channels', protect, async (req, res, next) => {
  try {
    const adminUserId = req.user.userId;

    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: VOICE_CHANNELS_TABLE,
        IndexName: 'adminUserId-index',
        KeyConditionExpression: 'adminUserId = :aid',
        ExpressionAttributeValues: { ':aid': adminUserId },
      })
    );

    res.json({ success: true, data: result.Items || [] });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/voice/channels
 * @desc    Create a new voice channel
 * @access  Private (admin)
 * @body    { name: string, description?: string }
 */
router.post('/channels', protect, requireActiveSubscription(), checkPlanLimit('voiceChannel'), invokeLambda(createVoiceChannelLambda.handler));

/**
 * @route   DELETE /api/voice/channels/:roomId
 * @desc    Delete a voice channel
 * @access  Private (admin, owner)
 */
router.delete('/channels/:roomId', protect, invokeLambda(deleteVoiceChannelLambda.handler));

module.exports = router;
