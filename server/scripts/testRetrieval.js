#!/usr/bin/env node
'use strict';

/**
 * testRetrieval.js — End-to-end retrieval quality test.
 *
 * Run from the server/ directory:
 *   node scripts/testRetrieval.js
 *
 * Self-contained: creates its own test data (Singleton + Observer design pattern
 * content), runs 6 query categories, validates retrieval quality, then cleans up.
 *
 * Requires: HF_API_KEY + QDRANT_URL + QDRANT_API_KEY in .env
 *
 * What is tested:
 *   1. High-relevance query → top score > threshold
 *   2. Specific sub-topic query → correct chunk surfaces (not just any chunk)
 *   3. Adjacent-topic query → moderate score, still relevant
 *   4. Cross-document isolation → query aimed at Doc A never leaks into Doc B
 *   5. Low-relevance query → results below threshold OR warned as low-confidence
 *   6. Deduplication → over-fetching candidate pool, then trimming near-duplicates
 */

require('dotenv').config();

const crypto = require('crypto');
const { initializeCollection, upsertChunks, deleteByDocumentId } =
  require('../src/rag/vectorStore');
const { embedTexts } = require('../src/rag/embeddings');
const { retrieveChunks } = require('../src/rag/retrieve');
const config = require('../src/config');

// ---------------------------------------------------------------------------
// Test corpus
// ---------------------------------------------------------------------------

const DOC_A_ID = `test-${crypto.randomUUID()}`; // Singleton pattern
const DOC_B_ID = `test-${crypto.randomUUID()}`; // Observer pattern

const DOC_A_CONTENT = [
  {
    text: 'The Singleton design pattern ensures a class has only one instance and provides a global point of access to it. It is one of the creational design patterns from the Gang of Four. The Singleton is used when exactly one object is needed to coordinate actions across a system, such as a database connection pool or configuration manager.',
    pageNumber: 1,
  },
  {
    text: 'Lazy initialization in Singleton delays the creation of the instance until the first time it is requested. This avoids unnecessary resource allocation when the instance might never be needed. A simple lazy Singleton checks if the instance is null before creating it, then stores the instance in a static field.',
    pageNumber: 2,
  },
  {
    text: 'Thread safety in Singleton requires careful implementation in multi-threaded environments. Without synchronization, two threads could simultaneously find the instance null and both create separate instances. The synchronized keyword in Java or mutex locks in C++ solve this but introduce performance overhead on every call.',
    pageNumber: 3,
  },
  {
    text: 'Double-checked locking (DCL) is an optimization for thread-safe Singleton initialization. The pattern checks if the instance is null twice — once without locking and once after acquiring the lock. This reduces synchronization overhead by only locking during the first creation. The volatile keyword is required in Java to prevent instruction reordering.',
    pageNumber: 3,
  },
  {
    text: 'The Singleton pattern has well-known criticisms. It introduces global state into an application, making unit testing difficult because the singleton cannot easily be replaced with a mock. It also violates the Single Responsibility Principle by managing both its instance creation and its primary function.',
    pageNumber: 4,
  },
  {
    text: 'Alternatives to the Singleton pattern include dependency injection, which provides the same single-instance behavior without the global state problem. Frameworks like Spring and Angular use dependency injection containers to manage object lifecycles, achieving singleton-like behavior while remaining testable.',
    pageNumber: 5,
  },
];

const DOC_B_CONTENT = [
  {
    text: 'The Observer pattern defines a one-to-many dependency between objects so that when one object changes state, all its dependents are notified automatically. The object that changes state is called the Subject or Observable, and the dependents are called Observers or Listeners.',
    pageNumber: 1,
  },
  {
    text: 'Node.js EventEmitter is a practical implementation of the Observer pattern. Objects that emit events extend EventEmitter. Listeners register with .on() and events fire with .emit(). This decouples producers from consumers — the emitter does not know who is listening.',
    pageNumber: 2,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunks(content, documentId, filename) {
  return content.map((c, i) => ({
    text: c.text,
    metadata: {
      chunkId: `${documentId}-${i}`,
      documentId,
      filename,
      chunkIndex: i,
      totalChunks: content.length,
      pageNumber: c.pageNumber ?? null,
      textPreview: c.text.slice(0, 200),
    },
  }));
}

function bar(score, width = 20) {
  const filled = Math.round(score * width);
  return '[' + '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(width - filled, 0)) + ']';
}

function section(title) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(62)}`);
}

function subsection(title) {
  console.log(`\n  ── ${title}`);
}

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  const mark = condition ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? `\n      ${detail}` : ''}`);
  if (condition) passed++;
  else failed++;
  return condition;
}

function printResult(result, verbose = false) {
  const { chunks, stats } = result;
  console.log(`\n    Query   : "${result.query.slice(0, 70)}"`);
  console.log(`    Results : ${stats.finalCount} chunks | raw: ${stats.rawCount} | deduped: ${stats.afterDedupeCount}`);
  console.log(`    Context : ${stats.totalContextChars} chars | pages: [${stats.pagesCovered.join(', ') || 'none'}]`);

  if (chunks.length > 0) {
    console.log(`    Scores  : top=${stats.topScore.toFixed(4)} | low=${stats.lowScore.toFixed(4)}`);
    if (verbose) {
      chunks.forEach((c, i) => {
        const preview = c.metadata.textPreview.replace(/\n/g, ' ').slice(0, 70);
        console.log(`    [${i}] ${bar(c.score)} ${c.score.toFixed(4)} | p${c.metadata.pageNumber ?? '?'} | "${preview}..."`);
      });
    }
  } else {
    console.log(`    Scores  : no results`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Retrieval Quality Test');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Provider  : ${config.embeddings.provider}`);
  console.log(`  Model     : ${config.embeddings.providers[config.embeddings.provider]?.model}`);
  console.log(`  Dim       : ${config.qdrant.vectorSize}`);
  console.log(`  Collection: ${config.qdrant.collection}`);
  console.log(`  topK      : ${config.retrieval.defaultTopK} | candidateMultiplier: ${config.retrieval.candidateMultiplier}`);
  console.log(`  minScore  : ${config.retrieval.defaultMinScore} | dedupeThreshold: ${config.retrieval.dedupeThreshold}`);
  console.log(`  maxChunks : ${config.retrieval.maxContextChunks} | maxChars: ${config.retrieval.maxContextChars}`);

  // ── Setup ─────────────────────────────────────────────────────────────────
  section('Setup: initializing collection and indexing test data');

  try {
    const initResult = await initializeCollection();
    console.log(`  Collection "${config.qdrant.collection}": ${initResult.created ? 'created' : 'exists'} | ${initResult.pointCount} existing points`);
    assert(true, 'Qdrant reachable and collection initialized');
  } catch (err) {
    assert(false, 'Qdrant reachable and collection initialized', err.message);
    console.error('\n[FATAL] Cannot proceed without Qdrant.');
    process.exit(1);
  }

  const docAChunks = makeChunks(DOC_A_CONTENT, DOC_A_ID, 'singleton-pattern.pdf');
  const docBChunks = makeChunks(DOC_B_CONTENT, DOC_B_ID, 'observer-pattern.pdf');
  const allChunks = [...docAChunks, ...docBChunks];
  const allTexts = allChunks.map((c) => c.text);

  console.log(`\n  Embedding ${allTexts.length} chunks...`);
  let allVectors;
  try {
    allVectors = await embedTexts(allTexts);
    assert(allVectors.length === allTexts.length, `Got ${allVectors.length} vectors`);
  } catch (err) {
    assert(false, 'Batch embedding succeeded', err.message);
    console.error('\n[FATAL] Cannot proceed without embeddings.');
    process.exit(1);
  }

  try {
    await upsertChunks(docAChunks, allVectors.slice(0, docAChunks.length));
    await upsertChunks(docBChunks, allVectors.slice(docAChunks.length));
    assert(true, `Indexed ${allChunks.length} chunks (${docAChunks.length} Doc A + ${docBChunks.length} Doc B)`);
  } catch (err) {
    assert(false, 'Upsert succeeded', err.message);
    process.exit(1);
  }

  // ── Query 1: High-relevance, direct match ────────────────────────────────
  section('Query 1: High-relevance — direct match');

  subsection('Q: "What is the Singleton design pattern?"');
  {
    const result = await retrieveChunks('What is the Singleton design pattern?', DOC_A_ID);
    printResult(result, true);
    assert(result.chunks.length > 0, 'Returned results');
    assert(result.stats.topScore > 0.7, `Top score ${result.stats.topScore.toFixed(4)} > 0.70`);
    const topText = result.chunks[0]?.text ?? '';
    assert(
      topText.toLowerCase().includes('singleton') || topText.toLowerCase().includes('instance'),
      'Top chunk mentions Singleton/instance',
    );
  }

  // ── Query 2: Specific sub-topic ───────────────────────────────────────────
  section('Query 2: Specific sub-topic — double-checked locking');

  subsection('Q: "How does double-checked locking work in thread-safe Singleton?"');
  {
    const result = await retrieveChunks(
      'How does double-checked locking work in thread-safe Singleton?',
      DOC_A_ID,
    );
    printResult(result, true);
    assert(result.chunks.length > 0, 'Returned results');

    const topChunk = result.chunks[0];
    if (topChunk) {
      const text = topChunk.text.toLowerCase();
      const mentionsDCL = text.includes('double-checked') || text.includes('lock') || text.includes('synchronized');
      assert(mentionsDCL, `Top chunk is about locking/synchronization`, `Page: ${topChunk.metadata.pageNumber}`);
      assert(topChunk.score > 0.6, `DCL chunk scores > 0.60 (got ${topChunk.score.toFixed(4)})`);
    }
  }

  // ── Query 3: Broader topic, still relevant ────────────────────────────────
  section('Query 3: Broader topic — design pattern criticism');

  subsection('Q: "What are the problems and criticisms of Singleton?"');
  {
    const result = await retrieveChunks(
      'What are the problems and criticisms of Singleton?',
      DOC_A_ID,
    );
    printResult(result, true);
    assert(result.chunks.length > 0, 'Returned results');
    assert(result.stats.topScore > 0.5, `Top score > 0.50 (got ${result.stats.topScore.toFixed(4)})`);

    const mentionsCriticism = result.chunks.some(
      (c) => c.text.toLowerCase().includes('criticism') ||
             c.text.toLowerCase().includes('global state') ||
             c.text.toLowerCase().includes('testing'),
    );
    assert(mentionsCriticism, 'At least one chunk discusses Singleton criticism/global state/testing');
  }

  // ── Query 4: Cross-document isolation ────────────────────────────────────
  section('Query 4: Cross-document isolation — same query, different documentId');

  subsection('Q: "What is Singleton?" against Doc B (Observer pattern)');
  {
    const resultDocA = await retrieveChunks('What is the Singleton pattern?', DOC_A_ID);
    const resultDocB = await retrieveChunks('What is the Singleton pattern?', DOC_B_ID);

    printResult(resultDocA);
    console.log(`\n    ── Same query against Doc B (Observer pattern) ──`);
    printResult(resultDocB);

    assert(
      resultDocA.chunks.every((c) => c.metadata.documentId === DOC_A_ID),
      'Doc A query only returns Doc A chunks',
    );
    assert(
      resultDocB.chunks.every((c) => c.metadata.documentId === DOC_B_ID),
      'Doc B filter only returns Doc B chunks',
    );

    if (resultDocA.stats.topScore > 0 && resultDocB.stats.topScore > 0) {
      assert(
        resultDocA.stats.topScore > resultDocB.stats.topScore,
        `Doc A scores higher on Singleton query than Doc B ` +
          `(${resultDocA.stats.topScore.toFixed(4)} > ${resultDocB.stats.topScore.toFixed(4)})`,
      );
    }
  }

  // ── Query 5: Low-relevance / off-topic ───────────────────────────────────
  section('Query 5: Off-topic query — expects low scores or zero results');

  subsection('Q: "How do I bake a chocolate cake with icing?"');
  {
    const result = await retrieveChunks(
      'How do I bake a chocolate cake with icing?',
      DOC_A_ID,
      { minScore: config.retrieval.defaultMinScore },
    );
    printResult(result);

    const noResults = result.chunks.length === 0;
    const lowTopScore = result.stats.topScore < config.retrieval.lowConfidenceWarnScore;

    assert(
      noResults || lowTopScore,
      `Off-topic query returns empty results OR low-confidence score (${result.stats.topScore.toFixed(4)})`,
    );

    if (result.chunks.length > 0) {
      console.log(`    [note] ${result.chunks.length} chunk(s) returned above minScore — retrieval threshold may need tuning`);
    }
  }

  // ── Query 6: Deduplication validation ────────────────────────────────────
  section('Query 6: Deduplication — candidate over-fetch and near-duplicate removal');

  subsection('Q: "Singleton instance creation" with high candidateK');
  {
    // Use minScore=0.0 and high topK to force lots of candidates, then check
    // that deduplication correctly reduces the count where applicable
    const result = await retrieveChunks(
      'Singleton instance creation single instance',
      DOC_A_ID,
      { topK: DOC_A_CONTENT.length, minScore: 0.0 },
    );
    printResult(result);

    console.log(`\n    Raw: ${result.stats.rawCount} | After dedupe: ${result.stats.afterDedupeCount} | Final: ${result.stats.finalCount}`);

    assert(result.stats.rawCount > 0, `Fetched candidates (raw: ${result.stats.rawCount})`);
    assert(
      result.stats.finalCount <= config.retrieval.maxContextChunks,
      `Final count ${result.stats.finalCount} ≤ maxContextChunks ${config.retrieval.maxContextChunks}`,
    );
    assert(
      result.stats.totalContextChars <= config.retrieval.maxContextChars,
      `Total chars ${result.stats.totalContextChars} ≤ maxContextChars ${config.retrieval.maxContextChars}`,
    );
    assert(
      result.stats.afterDedupeCount <= result.stats.rawCount,
      `Deduplication never increases count (${result.stats.afterDedupeCount} ≤ ${result.stats.rawCount})`,
    );

    // Check combinedContext format
    const hasHeaders = result.combinedContext.includes('[Source:');
    assert(hasHeaders, 'combinedContext contains [Source:...] headers for LLM citation');
  }

  // ── Context format validation ─────────────────────────────────────────────
  section('Context format check');

  {
    const result = await retrieveChunks('What is Singleton?', DOC_A_ID);
    if (result.chunks.length > 0) {
      const lines = result.combinedContext.split('\n');
      const firstLine = lines[0];
      assert(firstLine.startsWith('[Source:'), `combinedContext starts with [Source: header]`);
      assert(firstLine.includes('singleton-pattern.pdf'), `Header contains filename`);
      assert(firstLine.includes('Page'), `Header contains page reference`);
      assert(firstLine.includes('Chunk'), `Header contains chunk index`);

      console.log(`\n    Context preview (first 300 chars):`);
      console.log(`    ${result.combinedContext.slice(0, 300).replace(/\n/g, '\n    ')}`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('Cleanup: removing test data');

  try {
    await deleteByDocumentId(DOC_A_ID);
    await deleteByDocumentId(DOC_B_ID);

    // Verify cleanup
    const checkA = await retrieveChunks('singleton', DOC_A_ID, { minScore: 0.0 });
    const checkB = await retrieveChunks('observer', DOC_B_ID, { minScore: 0.0 });

    assert(checkA.chunks.length === 0, `Doc A data fully deleted`);
    assert(checkB.chunks.length === 0, `Doc B data fully deleted`);
  } catch (err) {
    assert(false, 'Cleanup succeeded', err.message);
  }

  // ── Final verdict ─────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  if (failed === 0) {
    console.log('  Status: ALL TESTS PASSED ✓');
    console.log('  Retrieval pipeline is ready for Phase 3 (generation)');
  } else {
    console.log(`  Status: ${failed} TEST(S) FAILED ✗`);
    console.log('  Review failed assertions above before proceeding to Phase 3');
  }
  console.log('══════════════════════════════════════════════════════════════\n');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
