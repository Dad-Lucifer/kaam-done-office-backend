'use strict';

const { dynamoDbClient } = require('../../src/config/awsConfig');
const { DeleteCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const VOICE_CHANNELS_TABLE = 'voice-channels';

/**
 * Lambda handler for deleting a voice channel.
 *
 * Path params: { roomId: string }
 * Body:        { adminUserId: string }  (optional ownership check)
 *
 * Steps:
 *   1. Verify the channel exists
 *   2. Verify ownership (if adminUserId provided)
 *   3. Delete the record from voice-channels
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

    // 1. Check the channel exists
    const getRes = await dynamoDbClient.send(
      new GetCommand({
        TableName: VOICE_CHANNELS_TABLE,
        Key: { roomId },
      })
    );

    const channel = getRes.Item;

    if (!channel) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Voice channel not found' }),
      };
    }

    // 2. Ownership check
    if (adminUserId && channel.adminUserId !== adminUserId) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Not authorized to delete this voice channel' }),
      };
    }

    // 3. Delete the record
    await dynamoDbClient.send(
      new DeleteCommand({
        TableName: VOICE_CHANNELS_TABLE,
        Key: { roomId },
      })
    );

    console.log(`[deleteVoiceChannel] Deleted voice channel "${roomId}"`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, message: 'Voice channel deleted successfully' }),
    };
  } catch (error) {
    console.error('[deleteVoiceChannel] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: false,
        message: 'Internal Server Error',
        error: error.message,
      }),
    };
  }
};
