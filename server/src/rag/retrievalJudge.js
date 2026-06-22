'use strict';

/**
 * retrievalJudge.js — LLM-as-Judge retrieval reranking (Phase B).
 *
 * Problem it solves:
 *   Qdrant ranks chunks by cosine similarity — geometric proximity in embedding
 *   space. For broad conceptual questions ("what is this document about?"),
 *   this often surfaces implementation-heavy chunks above conceptual explanations
 *   because code and definitions share vocabulary. A human judge would prefer
 *   the explanation; so should the system.
 *
 * Approach — single batched LLM call:
 *   All candidate chunks are evaluated in a single OpenRouter request rather
 *   than N parallel calls. Reasons:
 *     1. Cost: one system prompt shared across all chunks.
 *     2. Rate limits: free-tier models have low RPM limits; N calls in parallel
 *        almost guarantees 429s. One batched call is always within limits.
 *     3. Coherence: cross-chunk comparison happens in one context window,
 *        producing more consistent relative scores.
 *
 * Output per chunk (added as extra fields, does not replace existing fields):
 *   chunk.judgeScore:   0-10 integer
 *   chunk.judgeVerdict: 'HIGH' | 'MEDIUM' | 'LOW'
 *   chunk.judgeReason:  short string (≤120 chars)
 *
 * Failure behaviour:
 *   judgeAndRerank() NEVER throws. On any failure — timeout, 5xx, empty
 *   response, parse failure — it logs a warning and returns chunks in their
 *   original Qdrant cosine order. The pipeline is always unaffected by
 *   judge failures.
 */

const axios = require('axios');
const config = require('../config');
const { logStep, logWarn } = require('../utils/logger');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates retrieved chunks with an LLM judge and returns them sorted by
 * relevance score (descending). Ties in judge score preserve original Qdrant order.
 *
 * @param {string} originalQuestion
 * @param {{ original: string, rewritten: string, skipped: boolean }} rewriteInfo
 * @param {Array<{ score: number, text: string, metadata: object }>} chunks
 * @returns {Promise<Array>} — reranked chunks with judgeScore/judgeVerdict/judgeReason
 */
async function judgeAndRerank(originalQuestion, rewriteInfo, chunks) {
  // --- Guards ---
  if (!config.retrievalJudge.enabled) {
    logStep('JUDGE', 'Disabled — using original retrieval order');
    return chunks;
  }

  if (chunks.length <= 1) {
    logStep('JUDGE', `${chunks.length} chunk(s) — no rerank needed`);
    return chunks;
  }

  if (!config.llm.apiKey) {
    logWarn('JUDGE', 'MISTRAL_API_KEY not set — using original order');
    return chunks;
  }

  // Use the rewritten query when available — provides richer intent signal
  const rewrittenQuery = (rewriteInfo && !rewriteInfo.skipped)
    ? rewriteInfo.rewritten
    : originalQuestion;

  try {
    const scores = await callJudge(originalQuestion, rewrittenQuery, chunks);

    // Attach judge results to chunk objects in-place
    chunks.forEach((chunk, i) => {
      chunk.judgeScore = scores[i].score;
      chunk.judgeVerdict = scores[i].verdict;
      chunk.judgeReason = scores[i].reason;
    });

    // Log per-chunk evaluations
    chunks.forEach((chunk, i) => {
      logStep(
        'JUDGE',
        `Chunk ${i} | Score: ${chunk.judgeScore} | Verdict: ${chunk.judgeVerdict} | ${chunk.judgeReason.slice(0, 60)}`,
      );
    });

    // Stable descending sort: ties preserve original Qdrant cosine ordering
    const reranked = stableSort([...chunks], (a, b) => b.judgeScore - a.judgeScore);

    // Log final ranked order
    logStep('JUDGE', 'Top chunks after rerank:');
    reranked.slice(0, Math.min(5, reranked.length)).forEach((c, i) => {
      logStep(
        'JUDGE',
        `  [${i}] score ${c.judgeScore} | ${c.judgeVerdict} | page ${c.metadata.pageNumber ?? 'N/A'}`,
      );
    });

    return reranked;
  } catch (err) {
    logWarn('JUDGE', `Failed (${describeError(err)}) — using original retrieval order`);
    return chunks;
  }
}

// ---------------------------------------------------------------------------
// LLM call (throws on failure — caller catches)
// ---------------------------------------------------------------------------

async function callJudge(originalQuestion, rewrittenQuery, chunks) {
  const { chunkPreviewLength, temperature, timeoutMs } = config.retrievalJudge;

  const systemPrompt = buildSystemPrompt(originalQuestion, rewrittenQuery);
  const userMessage = buildChunkList(chunks, chunkPreviewLength);

  logStep('JUDGE', `Sending ${chunks.length} chunks for evaluation...`);
  const t0 = Date.now();

  const response = await axios.post(
    config.llm.baseUrl,
    {
      model: config.llm.model,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    },
  );

  const latencyMs = Date.now() - t0;
  const rawText = response.data.choices?.[0]?.message?.content;

  if (!rawText) {
    throw new Error('LLM returned no content');
  }

  logStep('JUDGE', `Response in ${latencyMs}ms — parsing scores...`);

  const { scores, parsedCount } = parseJudgeResponse(rawText, chunks.length);

  if (parsedCount === 0) {
    throw new Error(
      `Could not parse any chunk scores. Raw response: "${rawText.slice(0, 200)}"`,
    );
  }

  if (parsedCount < chunks.length) {
    logWarn(
      'JUDGE',
      `Parsed ${parsedCount}/${chunks.length} scores — missing chunks defaulted to MEDIUM/5`,
    );
  }

  return scores;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(originalQuestion, rewrittenQuery) {
  const querySection =
    rewrittenQuery !== originalQuestion
      ? `Original question: "${originalQuestion}"\nSearch query used:  "${rewrittenQuery}"`
      : `Question: "${originalQuestion}"`;

  return `You are a retrieval quality judge for a document question-answering system.

Your task: score each retrieved chunk on how well it helps answer the user's question.

${querySection}

SCORING GUIDE:
8-10 (HIGH)   The chunk directly and clearly addresses the question. Contains definitions,
              explanations, key facts, summaries, motivations, or conclusions relevant to
              the question. A good answer can be generated primarily from this chunk.
4-7  (MEDIUM) Related to the topic but only partially helpful, or provides useful background
              context without directly answering the question.
0-3  (LOW)    Off-topic, consists mainly of raw code or boilerplate without explanation,
              or contains no information relevant to answering the question.

IMPORTANT — for broad or conceptual questions (e.g. "what is this document about?",
"explain the main concept", "overview of X", "what is Y?"):
  - Textual explanations, definitions, summaries, motivations → score HIGHER (8-10)
  - Raw code listings and implementation boilerplate with no surrounding explanation → score LOWER (0-3)

OUTPUT FORMAT — output exactly one line per chunk, no other text:
CHUNK_0: score=N verdict=HIGH|MEDIUM|LOW reason=one short sentence`;
}

function buildChunkList(chunks, previewLength) {
  const parts = ['CHUNKS TO EVALUATE:\n'];

  chunks.forEach((chunk, i) => {
    const pageLabel =
      chunk.metadata.pageNumber != null ? `page ${chunk.metadata.pageNumber}` : 'no page';
    const preview = chunk.text.slice(0, previewLength);
    const suffix = chunk.text.length > previewLength ? '...[truncated]' : '';

    parts.push(`--- CHUNK_${i} (${pageLabel}, retrieval score=${chunk.score.toFixed(3)}) ---`);
    parts.push(preview + suffix);
    parts.push('');
  });

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parses the judge's line-per-chunk output into structured scores.
 *
 * Handles common model variations in output format:
 *   "CHUNK_0: score=8 verdict=HIGH reason=..."       (canonical)
 *   "CHUNK 0: score=8, verdict=HIGH, reason=..."     (spaces + commas)
 *   "chunk_0: score=8 VERDICT=HIGH reason=..."       (mixed case)
 *   "CHUNK_0: score=8 verdict=HIGH reason=..."        (leading whitespace)
 *
 * Chunks without a matching line default to { score: 5, verdict: 'MEDIUM', reason: 'not evaluated' }.
 *
 * @returns {{ scores: Array<{ score: number, verdict: string, reason: string }>, parsedCount: number }}
 */
function parseJudgeResponse(rawText, chunkCount) {
  const results = new Array(chunkCount).fill(null);
  let parsedCount = 0;

  // Accepts: CHUNK_N, CHUNK N, chunk_n, chunk n
  // Accepts: = or : as separator after field names
  // Accepts: optional commas between fields
  const lineRegex =
    /chunk[_ ]?(\d+)\s*:?\s*score\s*[=:]\s*(\d+)\s*,?\s*verdict\s*[=:]\s*(\w+)\s*,?\s*reason\s*[=:]\s*(.+)/gi;

  let match;
  while ((match = lineRegex.exec(rawText)) !== null) {
    const idx = parseInt(match[1]);
    if (idx < 0 || idx >= chunkCount) continue;
    if (results[idx] !== null) continue; // first match per chunk wins

    const rawScore = parseInt(match[2]);
    const score = isNaN(rawScore) ? 5 : Math.min(10, Math.max(0, rawScore));

    const verdictRaw = match[3].toUpperCase().trim();
    const verdict = ['HIGH', 'MEDIUM', 'LOW'].includes(verdictRaw)
      ? verdictRaw
      : scoreToVerdict(score);

    const reason = match[4].trim().slice(0, 120);

    results[idx] = { score, verdict, reason };
    parsedCount++;
  }

  // Fill any unparsed slots with defaults
  for (let i = 0; i < chunkCount; i++) {
    if (!results[i]) {
      results[i] = { score: 5, verdict: 'MEDIUM', reason: 'not evaluated' };
    }
  }

  return { scores: results, parsedCount };
}

function scoreToVerdict(score) {
  const { highThreshold, lowThreshold } = config.retrievalJudge;
  if (score >= highThreshold) return 'HIGH';
  if (score <= lowThreshold) return 'LOW';
  return 'MEDIUM';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable descending sort.
 * Equal-score items preserve their original relative order (stable by index).
 * Array.sort is stable in Node.js >= 11; the index tie-break makes this explicit.
 */
function stableSort(arr, compareFn) {
  return arr
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => compareFn(a.item, b.item) || a.idx - b.idx)
    .map(({ item }) => item);
}

function describeError(err) {
  if (err.code === 'ECONNABORTED') return 'timeout';
  if (err.response) {
    const body = err.response.data;
    const detail =
      typeof body === 'object' ? (body.error?.message ?? body.message ?? '') : '';
    return `HTTP ${err.response.status}${detail ? `: ${detail.slice(0, 80)}` : ''}`;
  }
  return err.message?.slice(0, 80) ?? 'unknown error';
}

// ---------------------------------------------------------------------------

module.exports = { judgeAndRerank };
