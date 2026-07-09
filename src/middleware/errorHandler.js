'use strict';

const config = require('../config/env');

/**
 * Maps AWS Cognito error codes to user-friendly messages.
 */
function mapCognitoError(errorCode, defaultMessage) {
  const cognitoErrorMap = {
    UsernameExistsException:
      'An account with this email already exists. Please log in instead.',
    UserNotConfirmedException:
      'Your email is not yet verified. Please check your inbox for the OTP.',
    NotAuthorizedException:
      'Incorrect email or password. Please try again.',
    UserNotFoundException:
      'No account found with this email address.',
    CodeMismatchException:
      'The verification code you entered is incorrect. Please try again.',
    ExpiredCodeException:
      'Your verification code has expired. Please request a new one.',
    LimitExceededException:
      'Too many attempts. Please wait a moment before trying again.',
    TooManyRequestsException:
      'Too many requests. Please slow down and try again.',
    InvalidPasswordException:
      'Password does not meet the requirements. Use 8+ characters with uppercase, lowercase, number, and symbol.',
    InvalidParameterException:
      'Invalid request parameters. Please check your input.',
  };

  return cognitoErrorMap[errorCode] || defaultMessage || 'An unexpected error occurred.';
}

/**
 * Global error-handling middleware.
 * Must be the LAST middleware registered in app.js.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const isDev = config.NODE_ENV === 'development';

  // Log the full error in non-production
  if (isDev) {
    console.error('[ErrorHandler]', err);
  } else {
    console.error(`[ErrorHandler] ${err.name}: ${err.message}`);
  }

  // Handle Cognito-specific errors
  if (err.__type || err.name) {
    const cognitoCode = err.__type || err.name;
    const friendlyMessage = mapCognitoError(cognitoCode, err.message);

    return res.status(400).json({
      success: false,
      message: friendlyMessage,
      ...(isDev && { errorCode: cognitoCode }),
    });
  }

  // Generic server error
  const statusCode = err.statusCode || err.status || 500;
  return res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500
        ? 'Internal server error. Please try again later.'
        : err.message || 'An error occurred.',
    ...(isDev && { stack: err.stack }),
  });
}

module.exports = errorHandler;
