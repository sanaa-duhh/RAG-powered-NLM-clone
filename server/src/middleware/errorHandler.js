'use strict';

/**
 * Centralized error handler — must be registered LAST in index.js.
 *
 * Handles three categories of error:
 *   1. MulterError — file upload failures (wrong type, too large)
 *   2. AppError    — our own typed, predictable errors
 *   3. Everything else — unexpected server errors (500)
 *
 * Client always receives: { success: false, error: "MACHINE_READABLE_CODE" }
 * Stack traces are logged server-side only and never sent to the client.
 */

const { logError } = require('../utils/logger');

// _next is required for Express to recognize this as an error handler (4-arg signature)
function errorHandler(err, req, res, _next) {
  // Multer upload errors (file size limit, file count, etc.)
  if (err.name === 'MulterError') {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR';
    logError('UPLOAD', `Multer: ${err.message}`);
    return res.status(400).json({ success: false, error: code });
  }

  // File type rejected by multer fileFilter
  if (err.code === 'UNSUPPORTED_TYPE') {
    logError('UPLOAD', err.message);
    return res.status(400).json({ success: false, error: 'UNSUPPORTED_TYPE' });
  }

  // Our own AppError — predictable, typed
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';

  logError('SERVER', `${code}: ${err.message}`);

  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  res.status(status).json({ success: false, error: code });
}

module.exports = errorHandler;
