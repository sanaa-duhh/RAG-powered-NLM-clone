'use strict';

const AppError = require('../utils/AppError');
const { logStep } = require('../utils/logger');
const { runPipeline } = require('../rag/ragPipeline');

/**
 * POST /api/chat
 *
 * Accepts: { question, documentId, history? }
 * Returns: { success, answer, refusal, confidence, sources[], stats }
 *
 * Pipeline: validate → retrieve → generate → respond.
 * Each stage is a separate RAG module. This controller only orchestrates.
 *
 * Response fields:
 *   answer      — the grounded answer string (or the refusal phrase)
 *   refusal     — true if the document didn't contain relevant context
 *   confidence  — 'high' | 'low' | 'none' (from retrieval score)
 *   sources     — retrieved chunk citations (filename, page, score)
 *   stats       — retrieval and generation stats for debugging
 */
async function chat(req, res, next) {
  try {
    const { question, documentId } = req.body;

    if (!question || question.trim() === '') {
      throw new AppError('MISSING_QUESTION', 'A question is required', 400);
    }

    if (!documentId) {
      throw new AppError('MISSING_DOCUMENT_ID', 'documentId is required', 400);
    }

    if (question.length > 2000) {
      throw new AppError('QUESTION_TOO_LONG', 'Question must be under 2000 characters', 400);
    }

    logStep('CHAT', `"${question.slice(0, 80)}..." | documentId: ${documentId}`);

    const { retrievalResult, generation } = await runPipeline(question, documentId);

    res.json({
      success: true,
      documentId,
      question,
      answer: generation.answer,
      refusal: generation.refusal,
      confidence: generation.confidence,
      sources: retrievalResult.chunks.map((c) => ({
        filename: c.metadata.filename,
        pageNumber: c.metadata.pageNumber,
        chunkIndex: c.metadata.chunkIndex,
        score: c.score,
        preview: c.metadata.textPreview.slice(0, 120),
      })),
      stats: {
        ...retrievalResult.stats,
        usage: generation.usage,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { chat };
