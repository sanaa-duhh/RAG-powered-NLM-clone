'use strict';

/**
 * debug.js — Chunk inspection utility.
 *
 * Call debugChunks() after chunkDocuments() to verify:
 *   - chunk sizes are reasonable
 *   - page numbers are preserved correctly
 *   - overlap between consecutive chunks is working
 *   - chunk metadata is complete
 *
 * Only called in development (NODE_ENV !== 'production').
 * Has no side effects on the pipeline — purely observational.
 */

const config = require('../config');
const { logStep } = require('../utils/logger');

/**
 * Prints a detailed analysis of the first N chunks and their overlap behavior.
 *
 * @param {Array<{ text: string, metadata: object }>} chunks
 * @param {number} showCount — number of chunks to display in detail (default 3)
 */
function debugChunks(chunks, showCount = 3) {
  if (!chunks || chunks.length === 0) {
    logStep('DEBUG', 'No chunks to analyze');
    return;
  }

  const display = Math.min(showCount, chunks.length);
  const sizes = chunks.map((c) => c.text.length);
  const avgSize = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  const pages = [...new Set(chunks.map((c) => c.metadata.pageNumber).filter(Boolean))].sort(
    (a, b) => a - b,
  );

  logStep('DEBUG', '=== Chunk Debug Report ===');
  logStep('DEBUG', `Total chunks : ${chunks.length}`);
  logStep('DEBUG', `Avg size     : ${avgSize} chars`);
  logStep('DEBUG', `Size range   : ${Math.min(...sizes)}–${Math.max(...sizes)} chars`);
  logStep('DEBUG', `Pages covered: ${pages.length > 0 ? pages.join(', ') : 'N/A (TXT file)'}`);
  logStep('DEBUG', `documentId   : ${chunks[0].metadata.documentId}`);
  logStep('DEBUG', `filename     : ${chunks[0].metadata.filename}`);
  logStep('DEBUG', '');

  // Print first N chunks with full metadata
  for (let i = 0; i < display; i++) {
    const c = chunks[i];
    const preview = c.text.slice(0, 120).replace(/\n/g, '↵').replace(/\s+/g, ' ');
    logStep('DEBUG', `--- Chunk ${i} of ${chunks.length - 1} ---`);
    logStep(
      'DEBUG',
      `  chunkId    : ${c.metadata.chunkId.slice(0, 8)}... | page: ${c.metadata.pageNumber ?? 'N/A'} | len: ${c.text.length} chars`,
    );
    logStep('DEBUG', `  "${preview}${c.text.length > 120 ? '...' : ''}"`);
  }

  // Overlap analysis between consecutive chunk pairs
  if (chunks.length >= 2) {
    const { chunkOverlap } = config.chunking;
    logStep('DEBUG', '');
    logStep('DEBUG', `--- Overlap Analysis (expected ~${chunkOverlap} chars) ---`);

    for (let i = 0; i < Math.min(display, chunks.length - 1); i++) {
      const result = analyzeOverlap(chunks[i].text, chunks[i + 1].text, chunkOverlap);
      if (result.chars > 0) {
        logStep(
          'DEBUG',
          `  Chunk ${i}→${i + 1}: detected ${result.chars} chars overlap | "${result.sample}"`,
        );
      } else {
        logStep(
          'DEBUG',
          `  Chunk ${i}→${i + 1}: no overlap detected (chunks may be from different pages)`,
        );
      }
    }
  }

  logStep('DEBUG', '=== End Chunk Report ===');
}

/**
 * Finds the overlapping text between the end of textA and the start of textB.
 *
 * The RecursiveCharacterTextSplitter places the last ~chunkOverlap chars of
 * chunk[i] at the beginning of chunk[i+1]. This function detects that overlap.
 *
 * Returns the longest suffix of textA that textB starts with, up to a search bound.
 *
 * @param {string} textA
 * @param {string} textB
 * @param {number} expectedOverlap — the configured chunkOverlap
 * @returns {{ chars: number, sample: string }}
 */
function analyzeOverlap(textA, textB, expectedOverlap) {
  // Search window: a bit wider than expected overlap to account for boundary rounding
  const searchBound = Math.min(expectedOverlap + 100, textA.length, 500);

  for (let len = searchBound; len >= 20; len--) {
    const candidate = textA.slice(-len);
    // Check if textB starts with this suffix (the overlap region)
    if (textB.slice(0, len + 20).includes(candidate)) {
      const sample = candidate.slice(0, 60).replace(/\n/g, '↵').replace(/\s+/g, ' ');
      return { chars: len, sample: `...${sample}...` };
    }
  }

  return { chars: 0, sample: '' };
}

module.exports = { debugChunks };
