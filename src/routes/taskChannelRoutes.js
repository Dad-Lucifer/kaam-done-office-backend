'use strict';

const { Router } = require('express');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const protect = require('../middleware/protect');
const { requireActiveSubscription, checkSubscriptionPermission, checkPlanLimit } = require('../middleware/subscription');
const createTaskChannelLambda = require('../../lambdas/task-channels/createTaskChannel');
const deleteTaskChannelLambda = require('../../lambdas/task-channels/deleteTaskChannel');
const { dynamoDbClient } = require('../config/awsConfig');

const router = Router();
const dynamoDb = dynamoDbClient;
const TASK_CHANNELS_TABLE = 'task-channels';

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
 * @route   GET /api/task-channels
 * @desc    List all task channels for the workspace
 * @access  Private
 */
router.get('/', protect, async (req, res, next) => {
  try {
    const adminUserId = req.user.isTeamMember ? req.user.userId : req.user.userId;

    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: TASK_CHANNELS_TABLE,
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
 * @route   POST /api/task-channels
 * @desc    Create a new task channel (Task Manager board)
 * @access  Private — requires active subscription + taskManagerAccess permission + plan limit
 */
router.post('/', protect, requireActiveSubscription(), checkSubscriptionPermission('taskManagerAccess'), checkPlanLimit('taskManager'), invokeLambda(createTaskChannelLambda.handler));

/**
 * @route   DELETE /api/task-channels/:roomId
 * @desc    Delete a task channel
 * @access  Private
 */
router.delete('/:roomId', protect, invokeLambda(deleteTaskChannelLambda.handler));

module.exports = router;
