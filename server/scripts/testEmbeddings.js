#!/usr/bin/env node
'use strict';

/**
 * testEmbeddings.js — Standalone embedding test utility.
 *
 * Run from the server/ directory:
 *   node scripts/testEmbeddings.js
 *   EMBEDDING_PROVIDER=openai node scripts/testEmbeddings.js
 *
 * What it tests:
 *   1. Provider connectivity — does the API respond?
 *   2. Output shape — correct dimensions?
 *   3. Batch correctness — N texts → N vectors?
 *   4. Semantic coherence — related texts should score higher than unrelated?
 *   5. Latency — usable for production?
 */

require('dotenv').config();

const { embedTexts } = require('../src/rag/embeddings');
const config = require('../src/config');

// ---------------------------------------------------------------------------
// Test corpus
// ---------------------------------------------------------------------------

const PAIRS = [
  {
    label: 'Near-synonyms (should be HIGH similarity)',
    a: 'debugging nodejs applications',
    b: 'node.js debugging techniques and tools',
    expectAbove: 0.8,
  },
  {
    label: 'Related domain (should be MODERATE-HIGH similarity)',
    a: 'machine learning model training',
    b: 'neural network optimization and backpropagation',
    expectAbove: 0.7,
  },
  {
    label: 'Loosely related (should be MODERATE similarity)',
    a: 'express.js REST API design',
    b: 'web server request handling',
    expectAbove: 0.5,
  },
  {
    label: 'Unrelated (should be LOW similarity)',
    a: 'debugging nodejs applications',
    b: 'chocolate cake baking recipe with icing',
    expectBelow: 0.5,
  },
  {
    label: 'Completely unrelated (should be VERY LOW similarity)',
    a: 'javascript async await promises callbacks',
    b: 'sourdough bread baking fermentation guide',
    expectBelow: 0.5,
  },
];

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosine(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function bar(score, width = 30) {
  const filled = Math.round(score * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function pass(score, pair) {
  if (pair.expectAbove !== undefined) return score >= pair.expectAbove;
  if (pair.expectBelow !== undefined) return score < pair.expectBelow;
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { provider } = config.embeddings;
  const providerConfig = config.embeddings.providers[provider];
  const { vectorSize } = config.qdrant;

  console.log('\n======================================================');
  console.log('  Embedding Test Utility');
  console.log('======================================================');
  console.log(`  Provider  : ${provider}`);
  console.log(`  Model     : ${providerConfig?.model ?? 'unknown'}`);
  console.log(`  Expected dim: ${vectorSize}`);
  console.log('======================================================\n');

  // Collect all unique texts for a single batch call
  const allTexts = [];
  const seen = new Map();
  for (const pair of PAIRS) {
    if (!seen.has(pair.a)) { seen.set(pair.a, allTexts.length); allTexts.push(pair.a); }
    if (!seen.has(pair.b)) { seen.set(pair.b, allTexts.length); allTexts.push(pair.b); }
  }

  console.log(`Embedding ${allTexts.length} unique texts in a single batch call...`);
  const t0 = Date.now();

  let vectors;
  try {
    vectors = await embedTexts(allTexts);
  } catch (err) {
    console.error('\n[FAIL] embedTexts threw an error:');
    console.error(' ', err.message);
    process.exit(1);
  }

  const totalMs = Date.now() - t0;

  // Verify shape
  console.log(`\n--- Batch Result ---`);
  console.log(`  Texts sent   : ${allTexts.length}`);
  console.log(`  Vectors got  : ${vectors.length}`);
  console.log(`  Dimension    : ${vectors[0].length} ${vectors[0].length === vectorSize ? '✓' : `✗ (expected ${vectorSize})`}`);
  console.log(`  Total latency: ${totalMs}ms`);
  console.log(`  Per-text avg : ${Math.round(totalMs / allTexts.length)}ms`);

  if (vectors.length !== allTexts.length) {
    console.error(`\n[FAIL] Vector count mismatch: expected ${allTexts.length}, got ${vectors.length}`);
    process.exit(1);
  }

  if (vectors[0].length !== vectorSize) {
    console.error(`\n[FAIL] Dimension mismatch: got ${vectors[0].length}, expected ${vectorSize}`);
    process.exit(1);
  }

  // Semantic similarity evaluation
  console.log('\n--- Semantic Similarity ---\n');

  let passed = 0;
  let total = PAIRS.length;

  for (const pair of PAIRS) {
    const vecA = vectors[seen.get(pair.a)];
    const vecB = vectors[seen.get(pair.b)];
    const score = cosine(vecA, vecB);
    const ok = pass(score, pair);
    if (ok) passed++;

    const threshold = pair.expectAbove !== undefined
      ? `expect ≥ ${pair.expectAbove}`
      : `expect < ${pair.expectBelow}`;

    console.log(`  ${ok ? '✓' : '✗'} ${pair.label}`);
    console.log(`    A: "${pair.a}"`);
    console.log(`    B: "${pair.b}"`);
    console.log(`    Similarity: ${score.toFixed(4)}  ${bar(score)}  (${threshold})`);
    console.log();
  }

  // Norm check on first vector (sanity)
  const norm = Math.sqrt(vectors[0].reduce((s, v) => s + v * v, 0));
  console.log(`--- Vector Sanity ---`);
  console.log(`  L2 norm of first vector: ${norm.toFixed(6)} ${Math.abs(norm - 1) < 0.05 ? '(unit-normalized ✓)' : '(not unit-normalized — cosine still works)'}`);

  // Final verdict
  console.log('\n======================================================');
  console.log(`  Semantic tests: ${passed}/${total} passed`);
  if (passed === total) {
    console.log('  Status: ALL TESTS PASSED ✓');
  } else {
    console.log(`  Status: ${total - passed} TEST(S) FAILED ✗`);
    console.log('  (Low scores may indicate a cold model — try again)');
  }
  console.log('======================================================\n');

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
