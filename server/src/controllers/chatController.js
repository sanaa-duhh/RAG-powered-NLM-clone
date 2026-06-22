'use strict';

const AppError = require('../utils/AppError');
const { logStep, logError } = require('../utils/logger');
const { runPipeline } = require('../rag/ragPipeline');

/**
 * POST /api/chat — SSE streaming response.
 *
 * Event types emitted on the stream:
 *   { type: 'stage',  stage: string }                  — pipeline stage indicator
 *   { type: 'token',  content: string }                — LLM token (generation only)
 *   { type: 'done',   answer, refusal, confidence,     — final result
 *                     sources, stats }
 *   { type: 'error',  message: string }                — fatal error
 *
 * The stream always ends with 'data: [DONE]\n\n'.
 */
async function chat(req, res, next) {
  const { question, documentId, history = [] } = req.body;

  // --- Input validation (before SSE headers so errors get normal JSON) ---
  try {
    if (!question || question.trim() === '') {
      throw new AppError('MISSING_QUESTION', 'A question is required', 400);
    }
    if (!documentId) {
      throw new AppError('MISSING_DOCUMENT_ID', 'documentId is required', 400);
    }
    if (question.length > 2000) {
      throw new AppError('QUESTION_TOO_LONG', 'Question must be under 2000 characters', 400);
    }
  } catch (err) {
    return next(err);
  }

  // --- SSE setup ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  const send = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  logStep('CHAT', `"${question.slice(0, 80)}..." | documentId: ${documentId} | history: ${history.length} turns`);

  try {
    const { retrievalResult, generation } = await runPipeline(
      question,
      documentId,
      Array.isArray(history) ? history.slice(-6) : [],
      {
        onStage: (stage) => send({ type: 'stage', stage }),
        onToken: (token) => send({ type: 'token', content: token }),
      },
    );

    send({
      type: 'done',
      answer: generation.answer,
      refusal: generation.refusal,
      confidence: generation.confidence,
      sources: retrievalResult.chunks.map((c) => ({
        filename: c.metadata.filename,
        pageNumber: c.metadata.pageNumber,
        chunkIndex: c.metadata.chunkIndex,
        score: c.score,
        preview: c.metadata.textPreview.slice(0, 400),
      })),
      stats: { ...retrievalResult.stats, usage: generation.usage },
    });
  } catch (err) {
    logError('CHAT', err.message);
    send({ type: 'error', message: err.message || 'Generation failed' });
  }

  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

module.exports = { chat };
