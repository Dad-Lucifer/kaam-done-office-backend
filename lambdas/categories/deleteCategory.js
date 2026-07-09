'use strict';

const {
  GetCommand,
  DeleteCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const { dynamoDbClient } = require('../../src/config/awsConfig');

const CATEGORIES_TABLE    = 'categories';
const TEXT_CHANNELS_TABLE = 'text-channels';
const VOICE_CHANNELS_TABLE = 'voice-channels';
const CHAT_MESSAGES_TABLE = 'chat-messages';

/**
 * Helper — delete every chat message that belongs to a text-channel roomId.
 */
async function deleteChatMessages(roomId) {
  let lastKey;
  do {
    const res = await dynamoDbClient.send(
      new QueryCommand({
        TableName: CHAT_MESSAGES_TABLE,
        KeyConditionExpression: 'roomId = :rid',
        ExpressionAttributeValues: { ':rid': roomId },
        ProjectionExpression: 'roomId, #ts',
        ExpressionAttributeNames: { '#ts': 'timestamp' },
        ExclusiveStartKey: lastKey,
      })
    );

    await Promise.all(
      (res.Items || []).map((item) =>
        dynamoDbClient.send(
          new DeleteCommand({
            TableName: CHAT_MESSAGES_TABLE,
            Key: { roomId: item.roomId, timestamp: item.timestamp },
          })
        )
      )
    );

    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
}

/**
 * Helper — query ALL channels (text or voice) for an admin and filter by categoryId.
 * Returns matching items.
 */
async function getChannelsForCategory(tableName, adminUserId, categoryId) {
  const matched = [];
  let lastKey;

  do {
    const res = await dynamoDbClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'adminUserId-index',
        KeyConditionExpression: 'adminUserId = :aid',
        FilterExpression: 'categoryId = :cid',
        ExpressionAttributeValues: {
          ':aid': adminUserId,
          ':cid': categoryId,
        },
        ExclusiveStartKey: lastKey,
      })
    );
    matched.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return matched;
}

/**
 * Lambda handler for deleting a category.
 * Cascade-deletes:
 *   1. All text-channels whose categoryId === this category (+ their chat messages)
 *   2. All voice-channels whose categoryId === this category
 *   3. The category record itself
 *
 * Path params: { categoryId }
 * Body:        { adminUserId }   (optional — used for ownership check)
 */
exports.handler = async (event) => {
  try {
    const { categoryId } = event.pathParameters || {};

    if (!categoryId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Missing categoryId in path parameters' }),
      };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const adminUserId = body.adminUserId;

    // 1. Verify the category exists + ownership
    const getRes = await dynamoDbClient.send(
      new GetCommand({ TableName: CATEGORIES_TABLE, Key: { categoryId } })
    );

    const category = getRes.Item;
    if (!category) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Category not found' }),
      };
    }

    if (adminUserId && category.adminUserId !== adminUserId) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Not authorized to delete this category' }),
      };
    }

    const ownerAdminId = category.adminUserId;

    // 2. Cascade-delete all text-channels in this category (+ their chat messages)
    const textChannels = await getChannelsForCategory(TEXT_CHANNELS_TABLE, ownerAdminId, categoryId);
    for (const ch of textChannels) {
      await deleteChatMessages(ch.roomId);
      await dynamoDbClient.send(
        new DeleteCommand({ TableName: TEXT_CHANNELS_TABLE, Key: { roomId: ch.roomId } })
      );
    }

    // 3. Cascade-delete all voice-channels in this category
    const voiceChannels = await getChannelsForCategory(VOICE_CHANNELS_TABLE, ownerAdminId, categoryId);
    for (const ch of voiceChannels) {
      await dynamoDbClient.send(
        new DeleteCommand({ TableName: VOICE_CHANNELS_TABLE, Key: { roomId: ch.roomId } })
      );
    }

    // 4. Delete the category record
    await dynamoDbClient.send(
      new DeleteCommand({ TableName: CATEGORIES_TABLE, Key: { categoryId } })
    );

    console.log(
      `[deleteCategory] Deleted category "${categoryId}" with ${textChannels.length} text + ${voiceChannels.length} voice channels.`
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        message: `Category deleted with ${textChannels.length} text and ${voiceChannels.length} voice channels`,
      }),
    };
  } catch (error) {
    console.error('[deleteCategory] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, message: 'Internal Server Error', error: error.message }),
    };
  }
};
