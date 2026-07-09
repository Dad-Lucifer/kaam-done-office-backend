'use strict';

const { Router } = require('express');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const protect = require('../middleware/protect');
const { dynamoDbClient } = require('../config/awsConfig');

const router = Router();
const dynamoDb = dynamoDbClient;

const CHAT_MESSAGES_TABLE = 'chat-messages';

/**
 * @route   GET /api/chat/rooms/:roomId/messages
 * @desc    Get all messages for a specific room (chat history)
 * @access  Private
 */
router.get('/rooms/:roomId/messages', protect, async (req, res, next) => {
  try {
    const { roomId } = req.params;

    const result = await dynamoDb.send(
      new QueryCommand({
        TableName: CHAT_MESSAGES_TABLE,
        KeyConditionExpression: 'roomId = :rid',
        ExpressionAttributeValues: {
          ':rid': roomId,
        },
      })
    );

    res.json({ success: true, data: result.Items || [] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
