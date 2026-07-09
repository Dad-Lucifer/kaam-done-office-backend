const {
  SignUpCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

const { cognitoClient, dynamoDbClient } = require('../config/awsConfig');
const config = require('../config/env');
const { computeSecretHash } = require('../config/cognitoHelper');
const { TEAM_MEMBERS_TABLE_NAME, ATTENDANCE_LOGS_TABLE } = require('../config/dbSetup');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ── Days of week helper ───────────────────────────────────────────────────────
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];


// ============================================================
//  SIGN UP
// ============================================================

/**
 * POST /api/auth/signup
 * Registers a new user in Cognito and stores their profile in DynamoDB.
 */
async function signup(req, res, next) {
  try {
    const { name, email, password } = req.body;

    const secretHash = computeSecretHash(email);

    // 1. Register user in Cognito
    const signUpCommand = new SignUpCommand({
      ClientId: config.COGNITO_CLIENT_ID,
      Username: email,
      Password: password,
      ...(secretHash && { SecretHash: secretHash }),
      UserAttributes: [
        { Name: 'name', Value: name },
        { Name: 'email', Value: email },
      ],
    });

    const cognitoResponse = await cognitoClient.send(signUpCommand);
    const cognitoSub = cognitoResponse.UserSub; // Unique Cognito user ID

    // 2. Save user profile to DynamoDB
    const userId = uuidv4();
    const now = new Date().toISOString();

    const putCommand = new PutCommand({
      TableName: config.DYNAMODB_TABLE_NAME,
      Item: {
        PK: `USER#${userId}`,
        SK: `PROFILE`,
        userId,
        cognitoSub,
        name,
        email,
        role: 'admin',       // First registrant is admin
        plan: 'free',        // Default subscription
        isVerified: false,
        createdAt: now,
        updatedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    });

    await dynamoDbClient.send(putCommand);

    return res.status(201).json({
      success: true,
      message:
        'Account created successfully! Please check your email for the verification code.',
      data: { email },
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  LOGIN
// ============================================================

/**
 * POST /api/auth/login
 * Authenticates a user via Cognito USER_PASSWORD_AUTH flow.
 * Returns Cognito ID/Access/Refresh tokens on success.
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const secretHash = computeSecretHash(email);

    const authCommand = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
        ...(secretHash && { SECRET_HASH: secretHash }),
      },
    });

    const response = await cognitoClient.send(authCommand);
    const tokens = response.AuthenticationResult;

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        accessToken: tokens.AccessToken,
        idToken: tokens.IdToken,
        refreshToken: tokens.RefreshToken,
        expiresIn: tokens.ExpiresIn,
      },
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  VERIFY OTP
// ============================================================

/**
 * POST /api/auth/verify
 * Confirms a user's email address using the OTP sent by Cognito.
 */
async function verifyOTP(req, res, next) {
  try {
    const { email, code } = req.body;

    const secretHash = computeSecretHash(email);

    const confirmCommand = new ConfirmSignUpCommand({
      ClientId: config.COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      ...(secretHash && { SecretHash: secretHash }),
    });

    await cognitoClient.send(confirmCommand);

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully! You can now log in.',
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  RESEND OTP
// ============================================================

/**
 * POST /api/auth/resend
 * Resends the Cognito email verification code.
 */
async function resendOTP(req, res, next) {
  try {
    const { email } = req.body;

    const secretHash = computeSecretHash(email);

    const resendCommand = new ResendConfirmationCodeCommand({
      ClientId: config.COGNITO_CLIENT_ID,
      Username: email,
      ...(secretHash && { SecretHash: secretHash }),
    });

    await cognitoClient.send(resendCommand);

    return res.status(200).json({
      success: true,
      message: 'A new verification code has been sent to your email.',
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  TEAM MEMBER LOGIN
// ============================================================

/**
 * POST /api/auth/member-login
 * Authenticates a team member stored in DynamoDB via username and password.
 * Returns a custom JWT.
 */
async function memberLogin(req, res, next) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    // Query team members by username GSI
    const queryResult = await dynamoDbClient.send(
      new QueryCommand({
        TableName: TEAM_MEMBERS_TABLE_NAME,
        IndexName: 'username-index',
        KeyConditionExpression: 'username = :un',
        ExpressionAttributeValues: { ':un': username.trim() },
      })
    );

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const member = queryResult.Items[0];

    // Verify password
    const isMatch = await bcrypt.compare(password, member.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    // Issue custom JWT for the team member
    const payload = {
      userId: member.adminUserId, // the workspace owner
      memberId: member.memberId,
      username: member.username,
      roleId: member.roleId,
      isTeamMember: true,
    };

    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: '1d' });

    // ── Record attendance LOGIN (fire-and-forget, never blocks auth) ──────────
    setImmediate(async () => {
      try {
        const now = new Date();
        const loginAt = now.toISOString();
        const date = loginAt.slice(0, 10); // "YYYY-MM-DD"
        const dayOfWeek = DAYS[now.getDay()];
        const logId = uuidv4();
        const TTL_1_YEAR = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

        await dynamoDbClient.send(new PutCommand({
          TableName: ATTENDANCE_LOGS_TABLE,
          Item: {
            PK: `ADMIN#${member.adminUserId}`,
            SK: `SESSION#${member.memberId}#${loginAt}`,
            logId,
            adminUserId: member.adminUserId,
            memberId: member.memberId,
            username: member.username,
            loginAt,
            logoutAt: null,
            date,
            dayOfWeek,
            workingHoursMs: null,
            workingHours: null,
            ttl: TTL_1_YEAR,
          },
        }));
      } catch (e) {
        console.error('[Attendance] Failed to write LOGIN record:', e.message);
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        accessToken: token,
        member: {
          id: member.memberId,
          username: member.username,
          roleId: member.roleId,
          roleName: member.roleName,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  TEAM MEMBER LOGOUT
// ============================================================

/**
 * POST /api/auth/member-logout
 * Closes the most recent open attendance session for the authenticated team member.
 * Computes workingHoursMs / workingHours by diffing loginAt → now.
 */
async function memberLogout(req, res, next) {
  try {
    if (!req.user.isTeamMember) {
      return res.status(403).json({ success: false, message: 'Only team members can call member-logout.' });
    }

    const { userId: adminUserId, memberId } = req.user;
    const now = new Date();
    const logoutAt = now.toISOString();

    // Find the most recent open session (logoutAt = null) for this member
    const result = await dynamoDbClient.send(new QueryCommand({
      TableName: ATTENDANCE_LOGS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: 'attribute_not_exists(logoutAt) OR logoutAt = :null',
      ExpressionAttributeValues: {
        ':pk': `ADMIN#${adminUserId}`,
        ':prefix': `SESSION#${memberId}#`,
        ':null': null,
      },
      ScanIndexForward: false, // most recent first
      Limit: 5,
    }));

    const openSession = (result.Items || []).find(item => !item.logoutAt);

    if (!openSession) {
      return res.status(404).json({ success: false, message: 'No open login session found.' });
    }

    const loginTime = new Date(openSession.loginAt);
    const workingHoursMs = now.getTime() - loginTime.getTime();
    const workingHours = parseFloat((workingHoursMs / (1000 * 60 * 60)).toFixed(2));

    await dynamoDbClient.send(new UpdateCommand({
      TableName: ATTENDANCE_LOGS_TABLE,
      Key: { PK: openSession.PK, SK: openSession.SK },
      UpdateExpression: 'SET logoutAt = :lo, workingHoursMs = :ms, workingHours = :hrs',
      ExpressionAttributeValues: {
        ':lo':  logoutAt,
        ':ms':  workingHoursMs,
        ':hrs': workingHours,
      },
    }));

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully.',
      data: { logoutAt, workingHours },
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================
//  GET ME
// ============================================================

/**
 * GET /api/auth/me
 * Retrieves the profile of the currently logged-in user.
 */
async function getMe(req, res, next) {
  try {
    if (req.user.isTeamMember) {
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');
      const { TEAM_MEMBERS_TABLE_NAME } = require('../config/dbSetup');
      
      const getResult = await dynamoDbClient.send(
        new GetCommand({
          TableName: TEAM_MEMBERS_TABLE_NAME,
          Key: {
            PK: `ADMIN#${req.user.userId}`,
            SK: `MEMBER#${req.user.memberId}`
          }
        })
      );
      
      if (!getResult.Item) {
         return res.status(404).json({ success: false, message: 'Member not found' });
      }
      
      return res.status(200).json({
        success: true,
        data: {
          id: req.user.memberId,
          name: getResult.Item.username,
          role: 'Team member',
          isTeamMember: true,
        }
      });
    } else {
      return res.status(200).json({
        success: true,
        data: {
          id: req.user.userId,
          name: req.user.name,
          role: 'admin',
          isTeamMember: false,
        }
      });
    }
  } catch (error) {
    next(error);
  }
}

module.exports = { signup, login, verifyOTP, resendOTP, memberLogin, memberLogout, getMe };
