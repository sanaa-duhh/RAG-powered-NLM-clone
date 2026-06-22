'use strict';

const express = require('express');
const { deleteByDocumentId } = require('../rag/vectorStore');
const { logStep, logError } = require('../utils/logger');
const AppError = require('../utils/AppError');

const router = express.Router();

// DELETE /api/documents/:documentId
// Removes all Qdrant vectors for the given document.
// The client removes it from localStorage separately.
router.delete('/documents/:documentId', async (req, res, next) => {
  try {
    const { documentId } = req.params;
    if (!documentId) throw new AppError('MISSING_ID', 'documentId is required', 400);

    logStep('DELETE', `Removing documentId: ${documentId}`);
    await deleteByDocumentId(documentId);
    logStep('DELETE', `Done — all vectors removed for ${documentId}`);

    res.json({ success: true, documentId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
