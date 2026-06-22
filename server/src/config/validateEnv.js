'use strict';

const { logInfo, logWarn, logError } = require('../utils/logger');

/**
 * These env vars are required when running in production.
 * In development, their absence is a warning (Phase 1 stubs don't call them yet).
 * In production, absence means an immediate startup failure with a clear message.
 */
const REQUIRED_IN_PRODUCTION = [
  'MISTRAL_API_KEY',
  'HF_API_KEY',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'CLIENT_URL',
];

/**
 * Run at startup before any routes are registered.
 * Fails fast in production so broken deployments are caught at boot, not at runtime.
 */
function validateEnv() {
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);

  if (process.env.NODE_ENV === 'production' && missing.length > 0) {
    logError('CONFIG', `Missing required environment variables:\n  ${missing.join('\n  ')}`);
    logError('CONFIG', 'Set these in your Render dashboard before deploying.');
    process.exit(1);
  }

  if (process.env.NODE_ENV !== 'production' && missing.length > 0) {
    logWarn(
      'CONFIG',
      `Missing env vars (not needed yet, required for Phase 2): ${missing.join(', ')}`,
    );
  }

  logInfo('Environment configuration loaded');
}

module.exports = { validateEnv };
