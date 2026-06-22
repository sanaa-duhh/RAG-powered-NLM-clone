'use strict';

/**
 * ragPipeline.js — Advanced RAG + CRAG orchestration layer.
 *
 * Pipeline (Phase A → D):
 *   question
 *     → rewriteQuery()              Phase A: retrieval-optimized query
 *     → retrieveChunks()            embed + Qdrant search
 *     → confidence gate             skip / refuse / run judge based on topScore
 *     → judgeAndRerank()            Phase B: LLM re-scores candidates (uncertain zone only)
 *     → CRAG corrective pass        Phase D: retry with original question on MEDIUM verdict
 *     → generateAnswer()            Phase A infrastructure, unchanged
 *
 * onStage(stage) is called at each pipeline step for SSE stage indicators.
 * onToken(token) is forwarded to generateAnswer for streaming LLM output.
 */

const { rewriteQuery } = require('./queryRewriter');
const { retrieveChunks } = require('./retrieve');
const { judgeAndRerank } = require('./retrievalJudge');
const { generateAnswer, REFUSAL_PHRASE } = require('./generate');
const { fetchSummaryChunk } = require('./vectorStore');
const config = require('../config');
const { logStep, logWarn } = require('../utils/logger');

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {string} question
 * @param {string} documentId
 * @param {Array}  history   — last N chat turns for multi-turn context
 * @param {object} options   — { onStage, onToken } for SSE streaming
 */
async function runPipeline(question, documentId, history = [], options = {}) {
  const { onStage = () => {}, onToken = null } = options;

  logStep('PIPELINE', `Start | documentId: ${documentId.slice(0, 8)}...`);

  // ── Phase A: query rewriting + speculative original embedding (parallel) ──
  onStage('rewriting');
  const { embedQuery } = require('./embeddings');
  const [rewriteInfo] = await Promise.all([
    rewriteQuery(question),
    embedQuery(question, { noFallback: true }).catch(() => null), // warm cache only
  ]);

  onStage('retrieving');
  const retrievalResult = await retrieveChunks(rewriteInfo.rewritten, documentId);
  retrievalResult.query = question;

  // ── No results ────────────────────────────────────────────────────────────
  if (retrievalResult.chunks.length === 0) {
    logStep('PIPELINE', 'No chunks retrieved — hard refuse');
    const generation = await generateAnswer(retrievalResult, history);
    logDone(rewriteInfo, null, generation, 'no-results');
    return { retrievalResult, generation, rewriteInfo };
  }

  const { topScore } = retrievalResult.stats;
  const { hardRefuseBelow, skipJudgeAbove } = config.confidenceGate;

  // ── Tier 1: extremely low cosine → refuse without judge ───────────────────
  if (topScore < hardRefuseBelow) {
    logStep('PIPELINE', `Cosine ${topScore.toFixed(3)} < ${hardRefuseBelow} — refusing (skip judge)`);
    logDone(rewriteInfo, null, null, 'hard-refuse-cosine');
    return hardRefuse(retrievalResult, rewriteInfo);
  }

  // ── Tier 2: high cosine → skip judge, generate directly ──────────────────
  if (topScore >= skipJudgeAbove) {
    logStep('PIPELINE', `Cosine ${topScore.toFixed(3)} ≥ ${skipJudgeAbove} — skipping judge`);
    await injectSummaryChunk(retrievalResult, documentId);
    onStage('generating');
    const generation = await generateAnswer(retrievalResult, history, onToken);
    logDone(rewriteInfo, null, generation, 'high-cosine');
    return { retrievalResult, generation, rewriteInfo };
  }

  // ── Tier 3: uncertain zone → run judge ───────────────────────────────────
  logStep('PIPELINE', `Cosine ${topScore.toFixed(3)} in uncertain zone — running judge`);
  onStage('judging');
  const rerankedChunks = await judgeAndRerank(question, rewriteInfo, retrievalResult.chunks);
  retrievalResult.chunks = rerankedChunks;

  const topChunk = rerankedChunks[0];
  const topVerdict = topChunk?.judgeVerdict ?? null;
  const topJudgeScore = topChunk?.judgeScore ?? 5;

  if (topJudgeScore === 0) {
    logStep('PIPELINE', `Judge score 0 — completely off-topic, refusing`);
    logDone(rewriteInfo, topChunk, null, 'hard-refuse-judge');
    return hardRefuse(retrievalResult, rewriteInfo);
  }

  if (topVerdict === 'LOW' || topVerdict === 'MEDIUM') {
    logStep('PIPELINE', `Judge verdict ${topVerdict} (${topJudgeScore}) — attempting corrective retrieval`);
    onStage('correcting');
    const corrected = await correctivePass(question, documentId, rerankedChunks);
    if (corrected) {
      retrievalResult.chunks = corrected;
    } else if (topVerdict === 'LOW') {
      logStep('PIPELINE', `Corrective did not improve LOW context — refusing`);
      logDone(rewriteInfo, topChunk, null, 'hard-refuse-after-corrective');
      return hardRefuse(retrievalResult, rewriteInfo);
    }
  }

  // ── Inject summary chunk ──────────────────────────────────────────────────
  await injectSummaryChunk(retrievalResult, documentId);

  // ── Generate ──────────────────────────────────────────────────────────────
  onStage('generating');
  const generation = await generateAnswer(retrievalResult, history, onToken);
  const verdictLabel = topVerdict ? topVerdict.toLowerCase() : 'fallback';
  logDone(rewriteInfo, retrievalResult.chunks[0], generation, 'judge-' + verdictLabel);
  return { retrievalResult, generation, rewriteInfo };
}

// ---------------------------------------------------------------------------
// CRAG corrective retrieval pass
// ---------------------------------------------------------------------------

async function correctivePass(originalQuestion, documentId, previousChunks) {
  const prevTopScore = previousChunks[0]?.judgeScore ?? 0;

  let corrResult;
  try {
    corrResult = await retrieveChunks(originalQuestion, documentId);
  } catch (err) {
    logWarn('PIPELINE', `Corrective retrieval failed: ${err.message} — keeping original`);
    return null;
  }

  if (corrResult.chunks.length === 0) {
    logWarn('PIPELINE', 'Corrective retrieval: no chunks returned — keeping original');
    return null;
  }

  const corrReranked = await judgeAndRerank(originalQuestion, null, corrResult.chunks);
  const corrTopScore = corrReranked[0]?.judgeScore ?? 0;

  logStep('PIPELINE', `Corrective: pass-1 top=${prevTopScore} → pass-2 top=${corrTopScore}`);

  if (corrTopScore > prevTopScore) {
    logStep('PIPELINE', 'Corrective retrieval improved score — using corrected chunks');
    return corrReranked;
  }

  logStep('PIPELINE', 'Corrective retrieval did not improve — keeping original chunks');
  return null;
}

// ---------------------------------------------------------------------------
// Summary chunk injection
// ---------------------------------------------------------------------------

async function injectSummaryChunk(retrievalResult, documentId) {
  try {
    const summary = await fetchSummaryChunk(documentId);
    if (!summary) return;

    retrievalResult.chunks = retrievalResult.chunks.filter(
      (c) => c.metadata.chunkId !== summary.metadata.chunkId,
    );
    retrievalResult.chunks.unshift(summary);
    logStep('PIPELINE', `Summary chunk injected | ${summary.text.length} chars`);
  } catch (err) {
    logWarn('PIPELINE', `Summary injection failed: ${err.message} — proceeding without it`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hardRefuse(retrievalResult, rewriteInfo) {
  return {
    retrievalResult,
    generation: { answer: REFUSAL_PHRASE, confidence: 'none', refusal: true, usage: null },
    rewriteInfo,
  };
}

function logDone(rewriteInfo, topChunk, generation, path) {
  const judgeInfo =
    topChunk?.judgeScore !== undefined
      ? ` | judge: ${topChunk.judgeScore} ${topChunk.judgeVerdict}`
      : '';
  const genInfo = generation
    ? ` | refusal: ${generation.refusal} | confidence: ${generation.confidence}`
    : ' | refusal: true | confidence: none';
  logStep('PIPELINE', `Done [${path}] | rewrite: ${rewriteInfo.skipped ? 'skip' : 'ok'}${judgeInfo}${genInfo}`);
}

// ---------------------------------------------------------------------------

module.exports = { runPipeline };
