'use strict';

const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../../src/config/awsConfig');

const dynamoDb = dynamoDbClient;

const TASK_CHANNELS_TABLE = 'task-channels';

/**
 * Lambda handler for creating a task channel.
 * Expected event: API Gateway Proxy event
 */
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { name, description, adminUserId, memberId, categoryId } = body;

    if (!name || !adminUserId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: false, message: 'Missing required fields: name, adminUserId' }),
      };
    }

    const roomId = uuidv4();
    const item = {
      roomId,
      adminUserId,
      ...(memberId && { memberId }),
      ...(categoryId && { categoryId }),
      name: name.trim(),
      description: description ? description.trim() : '',
      createdAt: new Date().toISOString(),
    };

    await dynamoDb.send(
      new PutCommand({
        TableName: TASK_CHANNELS_TABLE,
        Item: item,
      })
    );

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, data: item }),
    };
  } catch (error) {
    console.error('Error creating task channel:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, message: 'Internal Server Error', error: error.message }),
    };
  }
};
