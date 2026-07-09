'use strict';

const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { dynamoDbClient } = require('../../src/config/awsConfig');

const CATEGORIES_TABLE = 'categories';

/**
 * Lambda handler for creating a workspace category.
 *
 * Body: { name: string, adminUserId: string }
 *
 * Returns: { categoryId, adminUserId, name, createdAt }
 */
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { name, adminUserId } = body;

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

    const categoryId = uuidv4();
    const item = {
      categoryId,
      adminUserId,
      name: name.trim(),
      createdAt: new Date().toISOString(),
    };

    await dynamoDbClient.send(
      new PutCommand({
        TableName: CATEGORIES_TABLE,
        Item: item,
      })
    );

    console.log(`[createCategory] Created category "${item.name}" (${categoryId}) for admin ${adminUserId}`);

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, data: item }),
    };
  } catch (error) {
    console.error('[createCategory] Error:', error);
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
