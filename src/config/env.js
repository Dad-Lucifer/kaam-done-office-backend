'use strict';

require('dotenv').config();

const required = [
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'DYNAMODB_TABLE_NAME',
];

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `[Config] Missing required environment variables: ${missing.join(', ')}\n` +
      'Please copy .env.example to .env and fill in the values.'
  );
  process.exit(1);
}

module.exports = {
  PORT: parseInt(process.env.PORT || '5000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // AWS
  AWS_REGION: process.env.AWS_REGION,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,

  // Cognito
  COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
  COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
  
  // S3
  S3_BUCKET_NAME: process.env.S3_BUCKET_NAME || 'worknest-chat-history',

  // Optional — only needed if App Client was created WITH a client secret
  COGNITO_CLIENT_SECRET: process.env.COGNITO_CLIENT_SECRET || null,

  // DynamoDB
  DYNAMODB_TABLE_NAME: process.env.DYNAMODB_TABLE_NAME,

  // CORS
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // Custom JWT for Team Members
  JWT_SECRET: process.env.JWT_SECRET || 'fallback_secret_for_dev_only_change_in_prod',

  // LiveKit — Voice Channels
  LIVEKIT_URL: process.env.LIVEKIT_URL || '',
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || '',
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || '',

  // Razorpay
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',

  // DynamoDB Table Names
  SUBSCRIPTIONS_TABLE_NAME: process.env.SUBSCRIPTIONS_TABLE_NAME || 'subscriptions',

  // Gemini AI
  GEMINI_KEY: process.env.GEMINI_KEY || '',
};
