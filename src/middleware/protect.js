'use strict';

const { CognitoJwtVerifier } = require('aws-jwt-verify');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { dynamoDbClient } = require('../config/awsConfig');
const config = require('../config/env');

// Create a verifier for Cognito id tokens
const verifier = CognitoJwtVerifier.create({
  userPoolId: config.COGNITO_USER_POOL_ID,
  tokenUse: 'access',
  clientId: config.COGNITO_CLIENT_ID,
});

/**
 * protect — Express middleware that:
 *   1. Reads the Bearer token from Authorization header.
 *   2. Verifies it against Cognito (signature + expiry).
 *   3. Looks up the user in office-users table by cognitoSub.
 *   4. Attaches req.user = { userId, email, role } for downstream handlers.
 */
async function protect(req, res, next) {
  try {
    // 1. Extract token
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authentication required. No token provided.' });
    }

    const token = authHeader.slice(7);

    // 2. Verify token
    let payload;
    let isCognito = true;
    try {
      payload = await verifier.verify(token);
    } catch {
      // Fallback to custom JWT for team members
      try {
        const jwt = require('jsonwebtoken');
        payload = jwt.verify(token, config.JWT_SECRET);
        isCognito = false;
      } catch {
        return res.status(401).json({ success: false, message: 'Invalid or expired token. Please log in again.' });
      }
    }

    if (isCognito) {
      const cognitoSub = payload.sub;

      // 3. Look up user in office-users by cognitoSub
      const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
      const scanResult = await dynamoDbClient.send(
        new ScanCommand({
          TableName: config.DYNAMODB_TABLE_NAME,
          FilterExpression: 'cognitoSub = :sub AND SK = :sk',
          ExpressionAttributeValues: {
            ':sub': cognitoSub,
            ':sk': 'PROFILE',
          },
        })
      );

      if (!scanResult.Items || scanResult.Items.length === 0) {
        console.error(`[protect] User not found in DB for cognitoSub: ${cognitoSub}`);
        return res.status(401).json({ success: false, message: 'User not found. Please sign up.' });
      }

      const user = scanResult.Items[0];

      // 4. Attach admin user to request
      req.user = {
        userId: user.userId,
        email: user.email,
        role: user.role,
        name: user.name, // attach name for messaging
        isTeamMember: false,
      };
    } else {
      // 4. Attach team member to request
      req.user = {
        userId: payload.userId, // This is the adminUserId
        memberId: payload.memberId,
        username: payload.username,
        roleId: payload.roleId,
        isTeamMember: true,
      };
    }

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = protect;
