'use strict';

const crypto = require('crypto');
const config = require('./env');

/**
 * Computes the SECRET_HASH required by AWS Cognito when an App Client
 * has a client secret enabled.
 *
 * Formula: Base64( HMAC-SHA256( username + clientId, clientSecret ) )
 *
 * @param {string} username - The Cognito username (email in our case)
 * @returns {string|undefined} - The computed hash, or undefined if no secret is configured
 */
function computeSecretHash(username) {
  if (!config.COGNITO_CLIENT_SECRET) {
    // No client secret configured — don't include SECRET_HASH
    return undefined;
  }

  const message = username + config.COGNITO_CLIENT_ID;
  const hash = crypto
    .createHmac('sha256', config.COGNITO_CLIENT_SECRET)
    .update(message)
    .digest('base64');

  return hash;
}

module.exports = { computeSecretHash };
