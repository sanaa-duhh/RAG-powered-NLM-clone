'use strict';

/**
 * ragPipeline.js — Advanced RAG + CRAG orchestration layer.
 *
 * chatController.js delegates here. This is the only file that changes
 * as new RAG phases are added. chatController does not change again.
 *
 * Pipeline (Phase A → D):
 *
 *   question
 *     → rewriteQuery()              Phase A: retrieval-optimized query
 *     → retrieveChunks()            embed + Qdrant search
 *     → confidence gate             skip / refuse / run judge based on topScore
 *     → judgeAndRerank()            Phase B: LLM re-scores candidates (uncertain zone only)
 *     → CRAG corrective pass        Phase D: retry with original question on MEDIUM verdict
 *     → generateAnswer()            Phase A infrastructure, unchanged
 *
 * Confidence gate tiers (by Qdrant cosine topScore):
 *   topScore < hardRefuseBelow (0.35):  refuse immediately — too far off-topic for judge to help
 *   topScore ≥ skipJudgeAbove (0.65):   skip judge — cosine already reliable at this score
 *   [0.35, 0.65):                       uncertain zone → judge → act on verdict
 *
 * Judge verdict actions (uncertain zone only):
 *   HIGH   → generate normally
 *   MEDIUM → one corrective retrieval pass (CRAG); use whichever has higher top judge score
 *   LOW    → hard refuse (judge confirmed irrelevance; corrective pass won't help)
 *
 * All new components (judge, corrective pass) never throw — they degrade gracefully.
 */

const { rewriteQuery } = require('./queryRewriter');
const { retrieveChunks } = require('./retrieve');
const { judgeAndRerank } = require('./retrievalJudge');
const { generateAnswer, REFUSAL_PHRASE } = require('./generate');
const config = require('../config');
const { logStep, logWarn } = require('../utils/logger');

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {string} question   — raw user question
 * @param {string} documentId — scopes all retrieval to one document
 * @returns {Promise<{ retrievalResult, generation, rewriteInfo }>}
 */
async function runPipeline(question, documentId) {
  logStep('PIPELINE', `Start | documentId: ${documentId.slice(0, 8)}...`);

  // ── Phase A: query rewriting ──────────────────────────────────────────────
  const rewriteInfo = await rewriteQuery(question);
  const retrievalResult = await retrieveChunks(rewriteInfo.rewritten, documentId);
  // Restore original question so the LLM answers what the user actually asked
  retrievalResult.query = question;

  // ── No results ────────────────────────────────────────────────────────────
  if (retrievalResult.chunks.length === 0) {
    logStep('PIPELINE', 'No chunks retrieved — hard refuse');
    const generation = await generateAnswer(retrievalResult); // returns REFUSAL_PHRASE via existing logic
    logDone(rewriteInfo, null, generation, 'no-results');
    return { retrievalResult, generation, rewriteInfo };
  }

  const { topScore } = retrievalResult.stats;
  const { hardRefuseBelow, skipJudgeAbove } = config.confidenceGate;

  // ── Tier 1: extremely low cosine → refuse without judge ───────────────────
  if (topScore < hardRefuseBelow) {
    logStep(
      'PIPELINE',
      `Cosine ${topScore.toFixed(3)} < ${hardRefuseBelow} — refusing (skip judge)`,
    );
    logDone(rewriteInfo, null, null, 'hard-refuse-cosine');
    return hardRefuse(retrievalResult, rewriteInfo);
  }

  // ── Tier 2: high cosine → skip judge, generate directly ──────────────────
  if (topScore >= skipJudgeAbove) {
    logStep('PIPELINE', `Cosine ${topScore.toFixed(3)} ≥ ${skipJudgeAbove} — skipping judge`);
    const generation = await generateAnswer(retrievalResult);
    logDone(rewriteInfo, null, generation, 'high-cosine');
    return { retrievalResult, generation, rewriteInfo };
  }

  // ── Tier 3: uncertain zone [hardRefuseBelow, skipJudgeAbove) → run judge ──
  logStep(
    'PIPELINE',
    `Cosine ${topScore.toFixed(3)} in uncertain zone — running judge`,
  );

  // Phase B: LLM-as-Judge reranking (never throws)
  const rerankedChunks = await judgeAndRerank(question, rewriteInfo, retrievalResult.chunks);
  retrievalResult.chunks = rerankedChunks;

  const topChunk = rerankedChunks[0];
  // null means judge fell back (timeout/error) — degrade to Qdrant order, generate normally
  const topVerdict = topChunk?.judgeVerdict ?? null;
  const topJudgeScore = topChunk?.judgeScore ?? 5;

  // ── LOW → judge confirmed irrelevance → hard refuse ───────────────────────
  if (topVerdict === 'LOW') {
    logStep('PIPELINE', `Judge verdict LOW (${topJudgeScore}) — refusing`);
    logDone(rewriteInfo, topChunk, null, 'hard-refuse-judge');
    return hardRefuse(retrievalResult, rewriteInfo);
  }

  // ── MEDIUM → CRAG corrective retrieval pass ───────────────────────────────
  if (topVerdict === 'MEDIUM') {
    logStep(
      'PIPELINE',
      `Judge verdict MEDIUM (${topJudgeScore}) — attempting corrective retrieval`,
    );
    const corrected = await correctivePass(question, documentId, rerankedChunks);
    if (corrected) {
      retrievalResult.chunks = corrected;
    }
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  const generation = await generateAnswer(retrievalResult);
  const verdictLabel = topVerdict ? topVerdict.toLowerCase() : 'fallback';
  logDone(rewriteInfo, retrievalResult.chunks[0], generation, 'judge-' + verdictLabel);
  return { retrievalResult, generation, rewriteInfo };
}

// ---------------------------------------------------------------------------
// CRAG corrective retrieval pass
// ---------------------------------------------------------------------------

/**
 * Attempts a second retrieval using the original (unrewritten) question.
 * Returns the corrected chunks if they score better than the first pass,
 * or null to keep the original result.
 *
 * Uses the original question because the Phase A rewrite may have shifted
 * the embedding in a direction that missed relevant content. The original
 * question embeds differently and may surface different candidates.
 *
 * @param {string} originalQuestion
 * @param {string} documentId
 * @param {Array} previousChunks — Phase B reranked chunks from pass 1
 * @returns {Promise<Array|null>}
 */
async function correctivePass(originalQuestion, documentId, previousChunks) {
  const prevTopScore = previousChunks[0]?.judgeScore ?? 0;

  // Retrieve with original question (different embedding path)
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

  // Judge the corrective candidates (pass null for rewriteInfo — no rewrite on this pass)
  const corrReranked = await judgeAndRerank(originalQuestion, null, corrResult.chunks);
  const corrTopScore = corrReranked[0]?.judgeScore ?? 0;

  logStep(
    'PIPELINE',
    `Corrective: pass-1 top=${prevTopScore} → pass-2 top=${corrTopScore}`,
  );

  if (corrTopScore > prevTopScore) {
    logStep('PIPELINE', 'Corrective retrieval improved score — using corrected chunks');
    return corrReranked;
  }

  logStep('PIPELINE', 'Corrective retrieval did not improve — keeping original chunks');
  return null;
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
