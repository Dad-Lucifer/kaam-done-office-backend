'use strict';

const { dynamoDbClient } = require('../../src/config/awsConfig');
const { DeleteCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const TEXT_CHANNELS_TABLE = 'text-channels';
const CHAT_MESSAGES_TABLE = 'chat-messages';

/**
 * Lambda handler for deleting a text channel.
 * Deletes:
 * 1. The channel record from text-channels
 * 2. ALL messages for that room from chat-messages
 */
exports.handler = async (event) => {
  try {
    const roomId = event.pathParameters?.roomId;

    if (!roomId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Missing roomId in path parameters' }),
      };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const adminUserId = body.adminUserId;

    // 1. Check if channel exists and ownership
    const getRes = await dynamoDbClient.send(
      new GetCommand({
        TableName: TEXT_CHANNELS_TABLE,
        Key: { roomId },
      })
    );

    const channel = getRes.Item;
    if (!channel) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Channel not found' }),
      };
    }

    if (adminUserId && channel.adminUserId !== adminUserId) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Not authorized to delete this channel' }),
      };
    }

    // 2. Delete the channel record
    await dynamoDbClient.send(
      new DeleteCommand({
        TableName: TEXT_CHANNELS_TABLE,
        Key: { roomId },
      })
    );

    // 3. Delete ALL messages for this room from chat-messages
    // Query all messages first (roomId is partition key, timestamp is sort key)
    let lastKey = undefined;
    let deletedCount = 0;

    do {
      const queryRes = await dynamoDbClient.send(
        new QueryCommand({
          TableName: CHAT_MESSAGES_TABLE,
          KeyConditionExpression: 'roomId = :rid',
          ExpressionAttributeValues: { ':rid': roomId },
          ProjectionExpression: 'roomId, #ts',
          ExpressionAttributeNames: { '#ts': 'timestamp' },
          ExclusiveStartKey: lastKey,
        })
      );

      const items = queryRes.Items || [];

      // Delete each message individually (DynamoDB requires per-item delete)
      await Promise.all(
        items.map((item) =>
          dynamoDbClient.send(
            new DeleteCommand({
              TableName: CHAT_MESSAGES_TABLE,
              Key: { roomId: item.roomId, timestamp: item.timestamp },
            })
          )
        )
      );

      deletedCount += items.length;
      lastKey = queryRes.LastEvaluatedKey;
    } while (lastKey);

    console.log(`[deleteChannel] Deleted channel "${roomId}" and ${deletedCount} messages.`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        message: `Channel deleted successfully along with ${deletedCount} messages`,
      }),
    };
  } catch (error) {
    console.error('Error deleting channel:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, message: 'Internal Server Error', error: error.message }),
    };
  }
};
