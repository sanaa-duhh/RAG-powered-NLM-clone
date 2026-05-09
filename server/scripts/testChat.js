#!/usr/bin/env node
'use strict';

/**
 * testChat.js — Full RAG pipeline end-to-end test.
 *
 * Run from the server/ directory:
 *   node scripts/testChat.js
 *
 * Self-contained: indexes its own test data, runs 5 question categories,
 * validates answers, then deletes the test data.
 *
 * Requires: HF_API_KEY + QDRANT_URL + QDRANT_API_KEY + OPENROUTER_API_KEY in .env
 *
 * Test categories:
 *   1. Direct on-topic question      → grounded answer expected
 *   2. Specific sub-topic question   → precise answer + page citation expected
 *   3. Criticism / opinion question  → grounded answer from specific chunk
 *   4. Off-topic question            → hard refusal expected (no hallucination)
 *   5. Unknown detail question       → refusal or honest partial answer
 */

require('dotenv').config();

const crypto = require('crypto');
const { initializeCollection, upsertChunks, deleteByDocumentId } =
  require('../src/rag/vectorStore');
const { embedTexts } = require('../src/rag/embeddings');
const { retrieveChunks } = require('../src/rag/retrieve');
const { generateAnswer } = require('../src/rag/generate');
const config = require('../src/config');

// ---------------------------------------------------------------------------
// Test corpus: Singleton design pattern (6 chunks, 5 pages)
// ---------------------------------------------------------------------------

const DOC_ID = `test-chat-${crypto.randomUUID()}`;
const FILENAME = 'singleton-design-pattern.pdf';

const CORPUS = [
  {
    text: 'The Singleton design pattern ensures a class has only one instance and provides a global point of access to it. It is one of the original 23 design patterns from the Gang of Four book published in 1994. The Singleton is used when exactly one object is needed to coordinate actions across a system, such as a database connection pool, thread pool, logging service, or application configuration manager.',
    pageNumber: 1,
  },
  {
    text: 'Lazy initialization in Singleton delays the creation of the instance until the first time it is requested. This avoids unnecessary resource allocation when the instance might never be needed during the program lifecycle. A simple lazy Singleton in Java checks if the private static instance field is null before calling the constructor, then stores the result in that field.',
    pageNumber: 2,
  },
  {
    text: 'Thread safety in Singleton requires careful implementation in multi-threaded environments. Without synchronization, two threads could simultaneously find the instance null and both create separate instances, violating the pattern. The synchronized keyword in Java or mutex locks in C++ solve this, but introduce performance overhead because every access acquires a lock.',
    pageNumber: 3,
  },
  {
    text: 'Double-checked locking (DCL) is the standard solution for a thread-safe Singleton without permanent synchronization overhead. The pattern first checks if the instance is null without locking — if null, it acquires the lock and checks again before creating the instance. This means the lock is only acquired once during the first initialization. The volatile keyword must be applied to the instance field in Java to prevent CPU instruction reordering from breaking the pattern.',
    pageNumber: 3,
  },
  {
    text: 'The Singleton pattern has significant drawbacks. It introduces global mutable state into an application, which makes unit testing difficult because the singleton cannot easily be replaced with a test double or mock object. Tests that rely on a singleton share state between test cases, causing intermittent failures. The Singleton also violates the Single Responsibility Principle because the class manages both its lifecycle and its primary responsibility.',
    pageNumber: 4,
  },
  {
    text: 'Dependency injection is the preferred modern alternative to the Singleton pattern. Instead of having objects create or find their dependencies through a global accessor, dependencies are provided (injected) from outside. Frameworks such as Spring in Java and Angular in TypeScript use dependency injection containers that manage object lifecycle, achieving singleton-like behavior while keeping classes testable and decoupled.',
    pageNumber: 5,
  },
];

// ---------------------------------------------------------------------------
// Test questions
// ---------------------------------------------------------------------------

const TESTS = [
  {
    id: 'Q1',
    label: 'Direct on-topic: definition',
    question: 'What is the Singleton design pattern and what is it used for?',
    expectRefusal: false,
    expectKeywords: ['singleton', 'instance', 'global'],
    expectMinLength: 80,
  },
  {
    id: 'Q2',
    label: 'Sub-topic: double-checked locking',
    question: 'How does double-checked locking work and why is volatile needed?',
    expectRefusal: false,
    expectKeywords: ['volatile', 'lock', 'thread'],
    expectMinLength: 80,
  },
  {
    id: 'Q3',
    label: 'Criticism question: testing problems',
    question: 'Why is the Singleton pattern bad for unit testing?',
    expectRefusal: false,
    expectKeywords: ['test', 'global', 'state'],
    expectMinLength: 60,
  },
  {
    id: 'Q4',
    label: 'Off-topic: expects hard refusal',
    question: 'What is the best recipe for chocolate lava cake?',
    expectRefusal: true,
    expectKeywords: [],
    expectMinLength: 0,
  },
  {
    id: 'Q5',
    label: 'Missing detail: author names not in document',
    question: 'What are the names of the authors who invented the Singleton pattern?',
    expectRefusal: null, // acceptable either way — GoF mentioned but not named
    expectKeywords: [],
    expectMinLength: 0,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeChunks(corpus, documentId, filename) {
  return corpus.map((c, i) => ({
    text: c.text,
    metadata: {
      chunkId: `${documentId}-${i}`,
      documentId,
      filename,
      chunkIndex: i,
      totalChunks: corpus.length,
      pageNumber: c.pageNumber ?? null,
      textPreview: c.text.slice(0, 200),
    },
  }));
}

function section(title) {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(65)}`);
}

function confidenceBadge(confidence) {
  return { high: '[HIGH]', low: '[LOW] ', none: '[NONE]' }[confidence] ?? '[?]   ';
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

function printAnswer(generation, retrievalResult) {
  const { answer, confidence, refusal, usage } = generation;
  const { stats } = retrievalResult;

  console.log(`\n  Confidence : ${confidenceBadge(confidence)} (top score: ${stats.topScore.toFixed(4)})`);
  console.log(`  Refusal    : ${refusal}`);
  console.log(`  Sources    : ${stats.pagesCovered.length > 0 ? `pages ${stats.pagesCovered.join(', ')}` : 'none'} (${stats.finalCount} chunk(s))`);
  if (usage) console.log(`  Tokens     : ${usage.totalTokens} (prompt: ${usage.promptTokens}, completion: ${usage.completionTokens})`);
  console.log(`\n  Answer:\n  ${'─'.repeat(60)}`);
  const lines = answer.split('\n');
  for (const line of lines) console.log(`  ${line}`);
  console.log(`  ${'─'.repeat(60)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Check required env vars upfront
  const missing = [];
  if (!process.env.HF_API_KEY) missing.push('HF_API_KEY');
  if (!process.env.QDRANT_URL) missing.push('QDRANT_URL');
  if (!process.env.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');

  if (missing.length > 0) {
    console.error(`\n[FATAL] Missing required environment variables: ${missing.join(', ')}`);
    console.error('  Add them to server/.env before running this test.\n');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Full RAG Pipeline End-to-End Test');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Embedding  : ${config.embeddings.provider} / ${config.embeddings.providers[config.embeddings.provider]?.model}`);
  console.log(`  LLM        : ${config.llm.model}`);
  console.log(`  Collection : ${config.qdrant.collection}`);
  console.log(`  Test doc   : ${FILENAME} (${CORPUS.length} chunks)`);
  console.log(`  Doc ID     : ${DOC_ID.slice(0, 35)}...`);

  // ── Setup: index test data ────────────────────────────────────────────────
  section('Setup: indexing test data');

  try {
    await initializeCollection();
    assert(true, 'Qdrant collection initialized');
  } catch (err) {
    assert(false, 'Qdrant collection initialized', err.message);
    process.exit(1);
  }

  const chunks = makeChunks(CORPUS, DOC_ID, FILENAME);

  console.log(`\n  Embedding ${chunks.length} chunks...`);
  let vectors;
  try {
    vectors = await embedTexts(chunks.map((c) => c.text));
    assert(vectors.length === chunks.length, `${vectors.length} vectors generated`);
  } catch (err) {
    assert(false, 'Embedding succeeded', err.message);
    process.exit(1);
  }

  try {
    await upsertChunks(chunks, vectors);
    assert(true, `${chunks.length} chunks stored in Qdrant`);
  } catch (err) {
    assert(false, 'Upsert succeeded', err.message);
    process.exit(1);
  }

  // ── Run test questions ────────────────────────────────────────────────────
  for (let qi = 0; qi < TESTS.length; qi++) {
    const test = TESTS[qi];
    if (qi > 0) await sleep(2000); // avoid free-tier rate limits between calls
    section(`${test.id}: ${test.label}`);
    console.log(`\n  Question: "${test.question}"\n`);

    let retrievalResult;
    let generation;

    try {
      retrievalResult = await retrieveChunks(test.question, DOC_ID);
    } catch (err) {
      assert(false, 'Retrieval succeeded', err.message);
      continue;
    }

    try {
      generation = await generateAnswer(retrievalResult);
    } catch (err) {
      assert(false, 'Generation succeeded', err.message);
      continue;
    }

    printAnswer(generation, retrievalResult);
    console.log();

    // ── Validate ──────────────────────────────────────────────────────────
    if (test.expectRefusal === true) {
      assert(generation.refusal === true, `[${test.id}] Correctly refused off-topic question`);
      assert(
        generation.confidence === 'low' || generation.confidence === 'none' || generation.stats?.topScore < 0.6,
        `[${test.id}] Low/no confidence on off-topic question`,
        `confidence: ${generation.confidence}`,
      );
    } else if (test.expectRefusal === false) {
      assert(generation.refusal === false, `[${test.id}] Did not refuse — returned a grounded answer`);
      assert(
        generation.answer.length >= test.expectMinLength,
        `[${test.id}] Answer is substantive (≥ ${test.expectMinLength} chars, got ${generation.answer.length})`,
      );

      if (test.expectKeywords.length > 0) {
        const answerLower = generation.answer.toLowerCase();
        const foundKeywords = test.expectKeywords.filter((kw) => answerLower.includes(kw));
        assert(
          foundKeywords.length >= Math.ceil(test.expectKeywords.length * 0.6),
          `[${test.id}] Answer contains expected keywords`,
          `Found: [${foundKeywords.join(', ')}] of [${test.expectKeywords.join(', ')}]`,
        );
      }

      assert(
        retrievalResult.stats.finalCount > 0,
        `[${test.id}] Retrieved at least one chunk`,
        `chunks: ${retrievalResult.stats.finalCount}`,
      );
    } else {
      // null = acceptable either way (Q5)
      console.log(`  ℹ Ambiguous case — refusal: ${generation.refusal} (either is acceptable)`);
      console.log(`    Answer length: ${generation.answer.length} chars`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('Cleanup: removing test data');

  try {
    await deleteByDocumentId(DOC_ID);
    // Verify deletion by attempting retrieval
    const check = await retrieveChunks('singleton pattern', DOC_ID, { minScore: 0.0 });
    assert(check.stats.finalCount === 0, 'Test data fully deleted from Qdrant');
  } catch (err) {
    assert(false, 'Cleanup succeeded', err.message);
  }

  // ── Final verdict ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

  if (failed === 0) {
    console.log('  Status: ALL TESTS PASSED ✓');
    console.log('  Full RAG pipeline is operational');
    console.log('  Grounding and refusal behavior validated');
  } else {
    console.log(`  Status: ${failed} TEST(S) FAILED ✗`);
    console.log('  Review failed assertions above');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
