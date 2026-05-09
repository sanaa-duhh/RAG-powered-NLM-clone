'use strict';

/**
 * Lightweight pipeline logger.
 *
 * Outputs structured, prefix-tagged lines so log output is scannable:
 *   [UPLOAD]   research_paper.pdf — 2.3MB
 *   [CHUNK]    18 chunks created — avg 856 chars
 *   [RETRIEVE] top-4 results | scores: 0.87, 0.81, 0.76, 0.71
 *   [ERROR]    EMBEDDING_FAILED: connection timeout
 *
 * Morgan handles HTTP-level request logs separately (in index.js).
 * This logger is for application/pipeline-level events.
 */

function logInfo(message) {
  console.log(`[INFO]     ${message}`);
}

function logStep(step, message) {
  const label = step.toUpperCase().padEnd(10);
  console.log(`[${label}] ${message}`);
}

function logWarn(step, message) {
  const label = step.toUpperCase().padEnd(10);
  console.warn(`[${label}] WARN: ${message}`);
}

function logError(step, message) {
  const label = step.toUpperCase().padEnd(10);
  console.error(`[${label}] ERROR: ${message}`);
}

module.exports = { logInfo, logStep, logWarn, logError };
