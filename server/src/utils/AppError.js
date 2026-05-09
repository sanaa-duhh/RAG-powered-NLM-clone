'use strict';

/**
 * AppError — predictable, typed errors for the RAG pipeline.
 *
 * Usage:
 *   throw new AppError('MISSING_QUESTION', 'A question is required', 400);
 *
 * The `code` string is what gets returned to the client.
 * The `message` is human-readable and appears in server logs only.
 */
class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

module.exports = AppError;
