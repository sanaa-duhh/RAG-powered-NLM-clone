'use strict';

/**
 * retrieve.js — Retrieval stage of the chat pipeline.
 *
 * This module is the only place that knows HOW retrieval works.
 * The chat controller calls retrieveChunks() and gets back a structured result.
 * generate.js (Phase 3) receives that result and handles LLM interaction.
 *
 * Retrieval pipeline:
 *   1. Validate inputs
 *   2. Embed query with noFallback:true (keeps vectors in same space as indexed docs)
 *   3. Fetch candidates from Qdrant at candidateK = topK × candidateMultiplier
 *   4. Score threshold is enforced server-side by Qdrant
 *   5. Deduplicate near-identical chunks (Jaccard similarity on full text)
 *   6. Apply context budget (maxContextChunks + maxContextChars)
 *   7. Return structured result with combinedContext pre-built for Phase 3
 *
 * Deduplication strategy:
 *   Chunks overlap by ~200 chars. When a query closely matches a page boundary,
 *   Qdrant may return both sides of that boundary with similar scores.
 *   Jaccard similarity on word sets catches near-duplicates and retains the
 *   higher-scoring copy. Threshold=0.85 targets true duplicates, not neighbors.
 *
 * Context budgeting:
 *   Retrieval is always bounded by maxContextChunks AND maxContextChars.
 *   Whichever limit is hit first stops the budget. This keeps LLM prompts
 *   predictable in size regardless of document structure.
 *
 * Return value shape:
 *   {
 *     query:           string,
 *     documentId:      string,
 *     chunks:          Array<{ score, text, metadata }>,
 *     combinedContext: string,   — pre-formatted for LLM injection (Phase 3)
 *     stats:           object,   — for logging, debugging, and API response
 *   }
 *
 * Zero-result handling:
 *   Returns a valid result object with empty chunks and combinedContext.
 *   The caller (chatController, generate.js) decides what to do with no context.
 */

const { embedQuery } = require('./embeddings');
const { similaritySearch, fetchAllChunks } = require('./vectorStore');
const config = require('../config');
const AppError = require('../utils/AppError');
const { logStep, logWarn } = require('../utils/logger');

// ---------------------------------------------------------------------------
// Hybrid search helpers (keyword scoring + RRF)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','can',
  'i','you','he','she','it','we','they','this','that','these','those',
  'what','which','who','how','when','where','why','not','no','so','if',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Score a chunk by term frequency of query tokens (normalized by chunk length).
 * Returns 0.0–1.0.
 */
function keywordScore(chunkText, queryTokens) {
  if (queryTokens.length === 0) return 0;
  const words = tokenize(chunkText);
  if (words.length === 0) return 0;
  const wordSet = words.reduce((map, w) => {
    map.set(w, (map.get(w) ?? 0) + 1);
    return map;
  }, new Map());

  let matches = 0;
  for (const qt of queryTokens) {
    matches += wordSet.get(qt) ?? 0;
  }
  return matches / Math.sqrt(words.length);
}

/**
 * Reciprocal Rank Fusion of two ranked lists.
 * Chunks appearing in both lists score higher.
 * Keyword-only chunks (missed by vector search) are also surfaced.
 */
function reciprocalRankFusion(vectorChunks, keywordChunks, k = 60) {
  const scores = new Map(); // chunkId → { rrfScore, chunk }

  vectorChunks.forEach((chunk, rank) => {
    const id = chunk.metadata.chunkId;
    scores.set(id, { rrfScore: 1 / (k + rank + 1), chunk });
  });

  // Keyword list is sorted by tf score (desc); assign rank from that order
  keywordChunks.forEach((chunk, rank) => {
    const id = chunk.metadata.chunkId;
    const kwScore = 1 / (k + rank + 1);
    const existing = scores.get(id);
    if (existing) {
      existing.rrfScore += kwScore;
    } else {
      scores.set(id, { rrfScore: kwScore, chunk });
    }
  });

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ chunk }) => chunk);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieves the most relevant chunks from Qdrant for a user question.
 *
 * @param {string} question
 * @param {string} documentId
 * @param {{ topK?: number, minScore?: number }} options
 * @returns {Promise<{
 *   query: string,
 *   documentId: string,
 *   chunks: Array<{ score: number, text: string, metadata: object }>,
 *   combinedContext: string,
 *   stats: object
 * }>}
 */
async function retrieveChunks(question, documentId, options = {}) {
  // --- Input validation ---
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    throw new AppError('INVALID_QUESTION', 'Question must be a non-empty string', 400);
  }
  if (!documentId) {
    throw new AppError('MISSING_DOCUMENT_ID', 'documentId is required for retrieval', 400);
  }

  const {
    defaultTopK,
    defaultMinScore,
    candidateMultiplier,
    maxContextChunks,
    maxContextChars,
    dedupeThreshold,
    lowConfidenceWarnScore,
  } = config.retrieval;

  const topK = options.topK ?? defaultTopK;
  const minScore = options.minScore ?? defaultMinScore;

  logStep(
    'RETRIEVE',
    `Query: "${question.slice(0, 80)}${question.length > 80 ? '...' : ''}" | documentId: ${documentId}`,
  );

  // --- Step 1: Embed the query ---
  const t0 = Date.now();

  let queryVector;
  try {
    // noFallback: true — if HuggingFace is down, fail loudly rather than embedding
    // the query with OpenAI (1536-dim) while indexed chunks are HF (384-dim).
    // Dimension mismatch would produce silently wrong results without this guard.
    queryVector = await embedQuery(question, { noFallback: true });
  } catch (err) {
    throw new AppError('EMBED_FAILED', `Failed to embed query: ${err.message}`, 503);
  }

  const embedMs = Date.now() - t0;
  logStep('RETRIEVE', `Query embedded | dim: ${queryVector.length} | ${embedMs}ms`);

  // --- Step 2: Fetch candidates (over-fetch for deduplication headroom) ---
  const candidateK = topK * candidateMultiplier;

  const t1 = Date.now();
  const rawResults = await similaritySearch(queryVector, documentId, {
    topK: candidateK,
    minScore,
  });
  const searchMs = Date.now() - t1;

  const scoreStr =
    rawResults.length > 0 ? rawResults.map((r) => r.score.toFixed(3)).join(', ') : 'none';
  logStep('RETRIEVE', `Raw results: ${rawResults.length} | scores: [${scoreStr}] | ${searchMs}ms`);

  // --- Step 3: Handle empty results ---
  if (rawResults.length === 0) {
    logWarn(
      'RETRIEVE',
      `No chunks matched for documentId ${documentId} (minScore: ${minScore}). ` +
        `Check that the document was indexed and the documentId is correct.`,
    );
    return buildResult(question, documentId, [], queryVector.length, { rawCount: 0 });
  }

  // --- Step 4: Warn on low-confidence retrieval ---
  if (rawResults[0].score < lowConfidenceWarnScore) {
    logWarn(
      'RETRIEVE',
      `Low-confidence retrieval — top score ${rawResults[0].score.toFixed(3)} < ${lowConfidenceWarnScore}. ` +
        `Retrieved context may be weakly relevant to the query.`,
    );
  }

  // --- Step 4.5: Hybrid search — keyword scoring + RRF fusion ---
  // Fetches all document chunks, scores by term frequency, merges with RRF.
  // Surfaces chunks that vector search missed (exact keyword matches).
  // Skipped for very large documents (>150 chunks) to avoid latency.
  let hybridResults = rawResults;
  const queryTokens = tokenize(question);
  if (queryTokens.length > 0) {
    try {
      const allChunks = await fetchAllChunks(documentId, 150);
      if (allChunks.length > 0 && allChunks.length <= 150) {
        // Score all chunks by keyword relevance, sort descending
        const keywordRanked = allChunks
          .map((chunk) => ({ ...chunk, _kwScore: keywordScore(chunk.text, queryTokens) }))
          .filter((c) => c._kwScore > 0)
          .sort((a, b) => b._kwScore - a._kwScore)
          .slice(0, candidateK);

        if (keywordRanked.length > 0) {
          hybridResults = reciprocalRankFusion(rawResults, keywordRanked);
          logStep('RETRIEVE', `Hybrid: vector ${rawResults.length} + keyword ${keywordRanked.length} → RRF ${hybridResults.length}`);
        }
      }
    } catch (err) {
      logWarn('RETRIEVE', `Hybrid search failed (${err.message}) — using vector-only results`);
    }
  }

  // --- Step 5: Deduplicate near-identical chunks ---
  const deduped = deduplicateChunks(hybridResults, dedupeThreshold);
  if (deduped.length < rawResults.length) {
    logStep(
      'RETRIEVE',
      `Dedup: ${rawResults.length} → ${deduped.length} (removed ${rawResults.length - deduped.length} near-duplicate(s))`,
    );
  }

  // --- Step 6: Apply context budget ---
  const budgeted = applyBudget(deduped, maxContextChunks, maxContextChars);
  if (budgeted.length < deduped.length) {
    const totalChars = budgeted.reduce((s, c) => s + c.text.length, 0);
    logStep(
      'RETRIEVE',
      `Budget: ${deduped.length} → ${budgeted.length} chunks (${totalChars} chars)`,
    );
  }

  // --- Step 7: Log final selected chunks ---
  budgeted.forEach((r, i) => {
    const preview = r.metadata.textPreview.replace(/\n/g, ' ').slice(0, 60);
    logStep(
      'RETRIEVE',
      `  [${i}] score: ${r.score.toFixed(4)} | ${r.metadata.chunkId} | page: ${r.metadata.pageNumber ?? 'N/A'} | "${preview}..."`,
    );
  });

  return buildResult(question, documentId, budgeted, queryVector.length, {
    rawCount: rawResults.length,
    afterDedupeCount: deduped.length,
  });
}

// ---------------------------------------------------------------------------
// Result builder
// ---------------------------------------------------------------------------

function buildResult(question, documentId, chunks, queryDim, extra = {}) {
  const combinedContext = formatContext(chunks);
  const totalContextChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  const scores = chunks.map((c) => c.score);
  const pagesCovered = [
    ...new Set(
      chunks.map((c) => c.metadata.pageNumber).filter((p) => p !== null && p !== undefined),
    ),
  ].sort((a, b) => a - b);
  const chunkIds = chunks.map((c) => c.metadata.chunkId);

  return {
    query: question,
    documentId,
    chunks,
    combinedContext,
    stats: {
      queryDim,
      rawCount: extra.rawCount ?? chunks.length,
      afterDedupeCount: extra.afterDedupeCount ?? chunks.length,
      finalCount: chunks.length,
      totalContextChars,
      topScore: scores.length > 0 ? scores[0] : 0,
      lowScore: scores.length > 0 ? scores[scores.length - 1] : 0,
      pagesCovered,
      chunkIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Context formatter
// ---------------------------------------------------------------------------

/**
 * Formats retrieved chunks into a single context string for LLM injection.
 * Each chunk gets a source header so the model can cite specific locations.
 *
 * Output (one block per chunk):
 *   [Source: filename | Page N | Chunk X/Y]
 *   <chunk text>
 */
function formatContext(chunks) {
  if (chunks.length === 0) return '';

  return chunks
    .map((c) => {
      const pageLabel =
        c.metadata.pageNumber !== null && c.metadata.pageNumber !== undefined
          ? `Page ${c.metadata.pageNumber}`
          : 'No page info';
      const chunkLabel = `Chunk ${c.metadata.chunkIndex + 1}/${c.metadata.totalChunks}`;
      const header = `[Source: ${c.metadata.filename} | ${pageLabel} | ${chunkLabel}]`;
      return `${header}\n${c.text}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Removes near-duplicate chunks, keeping the higher-scoring copy.
 *
 * Input is assumed sorted by score descending (Qdrant returns this order).
 * For each chunk, we skip it if it's too similar to an already-kept chunk.
 * "Too similar" = Jaccard similarity of word sets above dedupeThreshold.
 *
 * Jaccard on word sets is an O(n²) comparison on at most candidateK chunks
 * (default: 12) — negligible cost. It reliably detects:
 *   - True duplicates (same chunk stored twice): Jaccard ~1.0
 *   - Near-duplicates (minor word differences): Jaccard > 0.85
 * It does NOT remove:
 *   - Adjacent overlapping chunks (share ~20% words): Jaccard ~0.11-0.20
 */
function deduplicateChunks(chunks, threshold) {
  const kept = [];

  for (const chunk of chunks) {
    const isNearDuplicate = kept.some((k) => jaccardSimilarity(k.text, chunk.text) > threshold);
    if (!isNearDuplicate) {
      kept.push(chunk);
    }
  }

  return kept;
}

/**
 * Jaccard similarity on word sets.
 * Returns 0.0 (no overlap) to 1.0 (identical word sets).
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

function tokenize(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Context budgeting
// ---------------------------------------------------------------------------

/**
 * Enforces two limits: maximum chunk count and maximum total character count.
 * Whichever limit is hit first stops the selection.
 * Input must already be sorted by score descending.
 */
function applyBudget(chunks, maxChunks, maxChars) {
  const result = [];
  let totalChars = 0;

  for (const chunk of chunks) {
    if (result.length >= maxChunks) break;
    if (totalChars + chunk.text.length > maxChars) break;
    result.push(chunk);
    totalChars += chunk.text.length;
  }

  return result;
}

// ---------------------------------------------------------------------------

module.exports = { retrieveChunks };
