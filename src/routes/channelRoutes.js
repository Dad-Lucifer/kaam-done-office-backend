'use strict';

const { Router } = require('express');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const protect = require('../middleware/protect');
const { requireActiveSubscription, checkPlanLimit } = require('../middleware/subscription');
const createChannelLambda = require('../../lambdas/channels/createChannel');
const deleteChannelLambda = require('../../lambdas/channels/deleteChannel');
const { dynamoDbClient } = require('../config/awsConfig');

const router = Router();
const dynamoDb = dynamoDbClient;
const TEXT_CHANNELS_TABLE = 'text-channels';

/**
 * Helper to adapt Express Request/Response to Lambda Proxy Event
 */
const invokeLambda = (lambdaHandler) => async (req, res, next) => {
  try {
    const event = {
      body: JSON.stringify({ ...req.body, adminUserId: req.user.isTeamMember ? req.user.userId : req.user.userId }),
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

/**
 * @route   GET /api/channels
 * @desc    List all channels for the workspace
 * @access  Private
 */
router.get('/', protect, async (req, res, next) => {
  try {
    const adminUserId = req.user.isTeamMember ? req.user.userId : req.user.userId;

    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TEXT_CHANNELS_TABLE,
        IndexName: 'adminUserId-index',
        KeyConditionExpression: 'adminUserId = :aid',
        ExpressionAttributeValues: {
          ':aid': adminUserId,
        },
      })
    );

    let channels = result.Items || [];

    // If the user is a team member, only show public channels and channels specifically for them
    if (req.user.isTeamMember) {
      channels = channels.filter(ch => !ch.memberId || ch.memberId === req.user.memberId);
    }

    res.json({ success: true, data: channels });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/channels
 * @desc    Create a new text channel
 * @access  Private (Admins only logic can be added in Lambda)
 */
router.post('/', protect, requireActiveSubscription(), checkPlanLimit('textChannel'), invokeLambda(createChannelLambda.handler));

/**
 * @route   DELETE /api/channels/:roomId
 * @desc    Delete a text channel
 * @access  Private
 */
router.delete('/:roomId', protect, invokeLambda(deleteChannelLambda.handler));

module.exports = router;
