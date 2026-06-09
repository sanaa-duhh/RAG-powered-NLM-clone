#!/usr/bin/env node
'use strict';

/**
 * testReranking.js — LLM-as-Judge reranking verification.
 *
 * Demonstrates that the judge correctly prefers conceptual chunks over
 * code-heavy chunks for broad questions, without requiring Qdrant or uploads.
 *
 * Run from server/:
 *   node scripts/testReranking.js
 *
 * What this tests:
 *   Synthetic chunks are arranged so that Qdrant's cosine scores (simulated)
 *   rank CODE chunks ABOVE conceptual chunks — the exact problem being solved.
 *   After judging, conceptual chunks should move to the top.
 *
 * Requires: OPENROUTER_API_KEY in .env
 */

require('dotenv').config();

const { judgeAndRerank } = require('../src/rag/retrievalJudge');
const config = require('../src/config');

// ---------------------------------------------------------------------------
// Test corpus
//
// Deliberately ordered so Qdrant scores rank code chunks first.
// The judge should reverse this for a broad conceptual question.
// ---------------------------------------------------------------------------

const BROAD_QUESTION = 'What is this document about?';

const MOCK_CHUNKS = [
  {
    // Qdrant rank 0 — highest cosine, but pure code
    score: 0.87,
    text: 'public class Singleton { private static volatile Singleton instance = null; private Singleton() {} public static synchronized Singleton getInstance() { if (instance == null) { instance = new Singleton(); } return instance; } }',
    metadata: {
      filename: 'singleton-pattern.pdf',
      pageNumber: 3,
      chunkIndex: 2,
      totalChunks: 6,
      textPreview: 'public class Singleton { private static volatile Singleton instance = null;',
    },
  },
  {
    // Qdrant rank 1 — second cosine, also code + serialization detail
    score: 0.83,
    text: 'To handle serialization in a Singleton, implement readResolve(): protected Object readResolve() { return getInstance(); } This prevents the JVM from creating a second instance during deserialization. Also override clone() to throw CloneNotSupportedException.',
    metadata: {
      filename: 'singleton-pattern.pdf',
      pageNumber: 5,
      chunkIndex: 4,
      totalChunks: 6,
      textPreview: 'To handle serialization in a Singleton, implement readResolve()',
    },
  },
  {
    // Qdrant rank 2 — conceptual definition (should win after judge)
    score: 0.79,
    text: 'The Singleton design pattern is a creational pattern that ensures a class has only one instance throughout the application lifecycle and provides a global point of access to that instance. It solves the problem of coordinating shared state or resources where multiple instances would cause inconsistency.',
    metadata: {
      filename: 'singleton-pattern.pdf',
      pageNumber: 1,
      chunkIndex: 0,
      totalChunks: 6,
      textPreview: 'The Singleton design pattern is a creational pattern that ensures a class',
    },
  },
  {
    // Qdrant rank 3 — motivation and use cases (also conceptual, should rank high)
    score: 0.74,
    text: 'The Singleton pattern is used when exactly one object is needed to coordinate actions across the system. Common real-world examples include a database connection pool, a logging service, or an application configuration manager. Having multiple instances of these components causes resource conflicts and inconsistent state.',
    metadata: {
      filename: 'singleton-pattern.pdf',
      pageNumber: 1,
      chunkIndex: 1,
      totalChunks: 6,
      textPreview: 'The Singleton pattern is used when exactly one object is needed to coordinate',
    },
  },
  {
    // Qdrant rank 4 — thread safety discussion (mixed: some explanation, some impl)
    score: 0.69,
    text: 'Thread safety in Singleton requires careful implementation. Without synchronization, two threads could simultaneously find the instance null and both create separate instances. The double-checked locking pattern solves this by combining a null check outside and inside a synchronized block.',
    metadata: {
      filename: 'singleton-pattern.pdf',
      pageNumber: 3,
      chunkIndex: 3,
      totalChunks: 6,
      textPreview: 'Thread safety in Singleton requires careful implementation. Without synchronization',
    },
  },
];

const REWRITE_INFO = {
  original: BROAD_QUESTION,
  rewritten: 'What is the main topic, subject matter, and purpose of this document?',
  skipped: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCodeChunk(chunk) {
  return (
    chunk.text.includes('public class') ||
    chunk.text.includes('getInstance()') ||
    chunk.text.includes('readResolve()')
  );
}

function chunkLabel(chunk) {
  return isCodeChunk(chunk) ? '[CODE]' : '[TEXT]';
}

function section(title) {
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(68)}`);
}

let passed = 0;
let failed = 0;

function check(condition, label, detail = '') {
  const mark = condition ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? `\n      ${detail}` : ''}`);
  if (condition) passed++;
  else failed++;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('\n[FATAL] OPENROUTER_API_KEY not set — add it to server/.env\n');
    process.exit(1);
  }

  section('LLM-as-Judge Reranking Verification');
  console.log(`\n  Question : "${BROAD_QUESTION}"`);
  console.log(`  Rewritten: "${REWRITE_INFO.rewritten}"`);
  console.log(`  Model    : ${config.llm.model}`);
  console.log(`  Chunks   : ${MOCK_CHUNKS.length} (2 code, 3 conceptual)`);

  // --- BEFORE ---
  section('BEFORE: Qdrant Cosine Ranking (simulated)');
  console.log();
  MOCK_CHUNKS.forEach((c, i) => {
    const preview = c.text.slice(0, 65).replace(/\n/g, ' ');
    console.log(`  [${i}] qdrant=${c.score.toFixed(3)} ${chunkLabel(c)} "${preview}..."`);
  });

  const codeAtTop = MOCK_CHUNKS.slice(0, 2).every(isCodeChunk);
  console.log(`\n  Code chunks ranked above conceptual: ${codeAtTop ? 'YES (problem confirmed)' : 'NO'}`);

  // --- RUN JUDGE ---
  section('Running LLM Judge...');

  // Spread to avoid mutating MOCK_CHUNKS order (judge mutates chunk objects in-place)
  const chunksForJudge = MOCK_CHUNKS.map((c) => ({ ...c, metadata: { ...c.metadata } }));

  let reranked;
  try {
    reranked = await judgeAndRerank(BROAD_QUESTION, REWRITE_INFO, chunksForJudge);
  } catch (err) {
    console.error('\n[FATAL] judgeAndRerank threw unexpectedly:', err.message);
    console.error('This should never happen — judgeAndRerank must never throw.');
    process.exit(1);
  }

  // --- AFTER ---
  section('AFTER: Judge Reranking');
  console.log();
  reranked.forEach((c, i) => {
    const judgeInfo =
      c.judgeScore !== undefined
        ? `judge=${c.judgeScore} ${c.judgeVerdict}`
        : 'not judged (fallback)';
    const preview = c.text.slice(0, 60).replace(/\n/g, ' ');
    console.log(`  [${i}] ${judgeInfo} | qdrant=${c.score.toFixed(3)} ${chunkLabel(c)} "${preview}..."`);
    if (c.judgeReason) {
      console.log(`       reason: ${c.judgeReason}`);
    }
  });

  // --- VALIDATION ---
  section('Validation');

  check(Array.isArray(reranked), 'judgeAndRerank returns an array');
  check(
    reranked.length === MOCK_CHUNKS.length,
    `Chunk count preserved (${reranked.length}/${MOCK_CHUNKS.length})`,
  );

  const allHaveScores = reranked.every((c) => typeof c.judgeScore === 'number');
  check(allHaveScores, 'All chunks received a numeric judgeScore');

  const allHaveVerdicts = reranked.every((c) =>
    ['HIGH', 'MEDIUM', 'LOW'].includes(c.judgeVerdict),
  );
  check(allHaveVerdicts, 'All chunks received a valid verdict (HIGH/MEDIUM/LOW)');

  // The conceptual definition (was qdrant rank 2) and motivation (was rank 3)
  // should now rank above code chunks (ranks 0 and 1)
  const conceptualChunks = reranked.filter((c) => !isCodeChunk(c));
  const codeChunks = reranked.filter(isCodeChunk);

  const topTwo = reranked.slice(0, 2);
  const topTwoConceptual = topTwo.every((c) => !isCodeChunk(c));
  check(
    topTwoConceptual,
    'Top 2 ranked chunks are conceptual (not code)',
    `Top chunks: [${topTwo.map((c) => chunkLabel(c)).join(', ')}]`,
  );

  const topVerdict = reranked[0]?.judgeVerdict;
  check(
    topVerdict === 'HIGH',
    `Top-ranked chunk verdict is HIGH (got: ${topVerdict})`,
  );

  const codeChunksAtBottom = codeChunks.every((cc) =>
    conceptualChunks.every((tc) => (tc.judgeScore ?? 5) >= (cc.judgeScore ?? 5)),
  );
  check(
    codeChunksAtBottom,
    'All conceptual chunks score ≥ all code chunks',
    `Conceptual scores: [${conceptualChunks.map((c) => c.judgeScore).join(', ')}] vs Code scores: [${codeChunks.map((c) => c.judgeScore).join(', ')}]`,
  );

  // Verify the fallback: temporarily disable judge and confirm no-throw
  config.retrievalJudge.enabled = false;
  const fallbackResult = await judgeAndRerank(BROAD_QUESTION, REWRITE_INFO, [...chunksForJudge]);
  config.retrievalJudge.enabled = true;
  check(
    fallbackResult.length === MOCK_CHUNKS.length,
    'Disabled-path fallback returns original chunks unchanged',
  );
  check(
    fallbackResult[0].score === chunksForJudge[0].score,
    'Disabled-path preserves original Qdrant order',
    `First chunk qdrant score: ${fallbackResult[0].score.toFixed(3)}`,
  );

  // --- SUMMARY ---
  section('Results');
  console.log(`\n  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

  if (failed === 0) {
    console.log('  Status: ALL CHECKS PASSED ✓');
    console.log('  LLM-as-Judge correctly prefers conceptual content for broad questions.');
    console.log('  Code-heavy chunks are demoted; definitions and summaries rank first.');
  } else {
    console.log(`  Status: ${failed} CHECK(S) FAILED ✗`);
    console.log('  Review judge prompt or threshold calibration.');
  }
  console.log();

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
