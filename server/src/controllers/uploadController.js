'use strict';

const AppError = require('../utils/AppError');
const { logStep } = require('../utils/logger');
const { ingest } = require('../rag/ingest');

/**
 * POST /api/upload
 *
 * By the time this runs, multer has already:
 *   - validated the file type
 *   - enforced the size limit
 *   - saved the file to uploads/
 *
 * This controller's job: validate req.file exists, then hand off to
 * the ingest pipeline. Returns documentId + chunk count on success.
 */
async function uploadDocument(req, res, next) {
  try {
    if (!req.file) {
      throw new AppError('NO_FILE', 'No file was attached to the request', 400);
    }

    logStep('UPLOAD', `${req.file.originalname} — ${(req.file.size / 1024).toFixed(1)}KB`);

    const result = await ingest(req.file);

    res.json({
      success: true,
      documentId: result.documentId,
      filename: req.file.originalname,
      chunksCreated: result.chunksCreated,
      message: 'Document indexed successfully',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { uploadDocument };
