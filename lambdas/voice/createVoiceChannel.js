'use strict';

const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../../src/config/awsConfig');

const dynamoDb = dynamoDbClient;

const VOICE_CHANNELS_TABLE = 'voice-channels';

/**
 * Lambda handler for creating a voice channel.
 * Expected event: API Gateway Proxy event
 *
 * Body: { name: string, description?: string, adminUserId: string }
 *
 * Returns the newly created item:
 *   { roomId, adminUserId, name, description, createdAt }
 */
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { name, description, adminUserId, categoryId } = body;

    if (!name || !adminUserId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          success: false,
          message: 'Missing required fields: name, adminUserId',
        }),
      };
    }

    const roomId = uuidv4();
    const item = {
      roomId,
      adminUserId,
      ...(categoryId && { categoryId }),
      name: name.trim(),
      description: description ? description.trim() : '',
      createdAt: new Date().toISOString(),
    };

    await dynamoDb.send(
      new PutCommand({
        TableName: VOICE_CHANNELS_TABLE,
        Item: item,
      })
    );

    console.log(`[createVoiceChannel] Created voice channel "${item.name}" (${roomId}) for admin ${adminUserId}`);

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, data: item }),
    };
  } catch (error) {
    console.error('[createVoiceChannel] Error:', error);
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
