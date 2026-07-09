'use strict';

const { AccessToken } = require('livekit-server-sdk');
const config = require('../config/env');

/**
 * POST /api/voice/token
 *
 * Body:
 *   { roomName: string, username?: string }
 *
 * Protected by `protect` middleware — req.user is always set.
 *
 * Returns:
 *   { success: true, token: "<jwt>", url: "<ws://...>" }
 */
async function generateToken(req, res, next) {
  try {
    // ---- Guard: LiveKit not configured ----
    if (!config.LIVEKIT_API_KEY || !config.LIVEKIT_API_SECRET || !config.LIVEKIT_URL) {
      return res.status(503).json({
        success: false,
        message:
          'LiveKit is not configured on this server. ' +
          'Please set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in your .env file.',
      });
    }

    // ---- Validate body ----
    const { roomName, username } = req.body || {};

    if (!roomName || typeof roomName !== 'string' || roomName.trim() === '') {
      return res.status(400).json({
        success: false,
        message: '`roomName` is required.',
      });
    }

    // ---- Resolve participant identity ----
    // Prefer body-supplied username, then the Cognito/JWT user name, then memberId, then email
    const identity =
      (username && username.trim()) ||
      req.user.name ||
      req.user.username ||
      req.user.email ||
      `user-${req.user.userId}`;

    // ---- Build LiveKit Access Token ----
    const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
      identity,
      name: identity,
      // Token is valid for 6 hours
      ttl: '6h',
    });

    at.addGrant({
      roomJoin: true,
      room: roomName.trim(),
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await at.toJwt();

    return res.json({
      success: true,
      token: jwt,
      url: config.LIVEKIT_URL,
      identity,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { generateToken };
