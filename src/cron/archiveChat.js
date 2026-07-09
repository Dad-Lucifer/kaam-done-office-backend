'use strict';

const cron = require('node-cron');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamoDbClient, s3Client } = require('../config/awsConfig');
const config = require('../config/env');

const TEXT_CHANNELS_TABLE = 'text-channels';
const CHAT_MESSAGES_TABLE = 'chat-messages';
const BUCKET_NAME = config.S3_BUCKET_NAME;

/**
 * Runs daily at 2:00 AM.
 * Scans all rooms, queries yesterday's messages, and uploads them to S3.
 */
function initChatArchiver() {
  // '0 2 * * *' = every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] Starting daily chat archival to S3...');
    try {
      await archiveYesterdaysChat();
      console.log('[CRON] Chat archival completed successfully.');
    } catch (err) {
      console.error('[CRON] Error archiving chat:', err);
    }
  });
  console.log('[CRON] Chat archiver scheduled.');
}

async function archiveYesterdaysChat() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const startOfDay = new Date(yesterday.setUTCHours(0, 0, 0, 0)).toISOString();
  const endOfDay = new Date(yesterday.setUTCHours(23, 59, 59, 999)).toISOString();
  const dateString = startOfDay.split('T')[0]; // YYYY-MM-DD

  // 1. Get all room IDs
  const scanCmd = new ScanCommand({
    TableName: TEXT_CHANNELS_TABLE,
    ProjectionExpression: 'roomId',
  });
  
  let rooms = [];
  try {
    const res = await dynamoDbClient.send(scanCmd);
    rooms = res.Items || [];
  } catch (e) {
    console.error('Failed to fetch rooms for archival:', e);
    return;
  }

  // 2. Query messages for each room and upload to S3
  for (const room of rooms) {
    const roomId = room.roomId;

    try {
      const qCmd = new QueryCommand({
        TableName: CHAT_MESSAGES_TABLE,
        KeyConditionExpression: 'roomId = :rid AND #ts BETWEEN :start AND :end',
        ExpressionAttributeNames: {
          '#ts': 'timestamp',
        },
        ExpressionAttributeValues: {
          ':rid': roomId,
          ':start': startOfDay,
          ':end': endOfDay,
        },
      });

      const qRes = await dynamoDbClient.send(qCmd);
      const messages = qRes.Items || [];

      if (messages.length > 0) {
        // We have messages to archive for this room!
        const fileContent = JSON.stringify(messages, null, 2);
        const s3Key = `chat-history/${roomId}/${dateString}.json`;

        await s3Client.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: s3Key,
          Body: fileContent,
          ContentType: 'application/json',
        }));

        console.log(`[CRON] Archived ${messages.length} messages for room ${roomId}`);
      }
    } catch (err) {
      console.error(`[CRON] Failed to archive messages for room ${roomId}:`, err);
    }
  }
}

module.exports = { initChatArchiver, archiveYesterdaysChat };
