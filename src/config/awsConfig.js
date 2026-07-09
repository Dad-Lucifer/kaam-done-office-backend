'use strict';

const config = require('./env');
const { CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { S3Client } = require('@aws-sdk/client-s3');

// --- AWS Credentials Object ---
const awsCredentials = {
  region: config.AWS_REGION,
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
};

// --- Cognito Client ---
const cognitoClient = new CognitoIdentityProviderClient(awsCredentials);

// --- DynamoDB Client ---
const dynamoDbRawClient = new DynamoDBClient(awsCredentials);

const dynamoDbClient = DynamoDBDocumentClient.from(dynamoDbRawClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
});

// --- S3 Client ---
const s3Client = new S3Client(awsCredentials);

module.exports = { cognitoClient, dynamoDbClient, s3Client };
