'use strict';

/**
 * queryRewriter.js — Pre-retrieval query optimization.
 *
 * Converts a user's natural-language question into a complete, retrieval-optimized
 * search query better suited for semantic vector search.
 *
 * Why rewriting helps:
 *   BGE-small-en-v1.5 embeds questions and document chunks into the same
 *   vector space, but vague or short questions embed to imprecise vectors.
 *   Expanding the question into a specific, well-formed search query closes
 *   that gap without losing the user's intent or named entities.
 *
 * Failure behaviour:
 *   rewriteQuery() NEVER throws. On any failure — timeout, 5xx, empty output,
 *   validation failure — it logs a warning and returns the original question.
 *   The pipeline always proceeds; the rewrite is best-effort only.
 *
 * Configuration:
 *   config.queryRewriting.enabled — set false to bypass rewriting entirely.
 *   Uses config.llm.model and config.llm.baseUrl (no additional credentials).
 */

const axios = require('axios');
const config = require('../config');
const { logStep, logWarn } = require('../utils/logger');

const REWRITE_TEMPERATURE = 0.05; // near-deterministic; suppresses creative drift
const REWRITE_TIMEOUT_MS = 5_000; // aggressive — must not block the pipeline

// Minimum/maximum sanity bounds on the rewritten output.
// Too short → model failed or refused. Too long → model ignored the length rule.
const MIN_REWRITE_LENGTH = 5;
const MAX_REWRITE_LENGTH = 250;

const SYSTEM_PROMPT = `You are a search query optimizer for a document retrieval system.

Your task: rewrite the user's question into a complete, natural-language search query that retrieves the most relevant passages from an uploaded document.

Rules:
1. Output ONLY the rewritten search query. No preamble, no explanation, no quotation marks.
2. Write a complete, grammatically correct search query — never reduce it to a keyword list or fragment.
3. Preserve the user's intent exactly. Keep specific entities, technical terms, and named concepts verbatim.
4. Expand vague or brief inputs into a more specific, searchable form. Do not shorten or compress the query.
5. Do not output fewer words than the original question unless the original is already highly specific.
6. Keep the output under 35 words.

Examples:
  Input:  What is this document about?
  Output: What is the main topic, subject matter, and purpose of this document?

  Input:  tell me about the main concept
  Output: What is the primary concept or central idea discussed in this document?

  Input:  What does it say about this topic?
  Output: What does this document say about this topic and what are the key points covered?`;

// ---------------------------------------------------------------------------

/**
 * Rewrites a user question into a retrieval-optimized phrase.
 *
 * @param {string} question — the raw user question
 * @returns {Promise<{ original: string, rewritten: string, skipped: boolean }>}
 *   skipped: true means the original question was used (rewriting was skipped or failed)
 */
async function rewriteQuery(question) {
  // --- Guard: disabled via config ---
  if (!config.queryRewriting.enabled) {
    logStep('REWRITE', 'Disabled — using original query');
    return { original: question, rewritten: question, skipped: true };
  }

  // --- Guard: missing API key ---
  if (!process.env.OPENROUTER_API_KEY) {
    logWarn('REWRITE', 'OPENROUTER_API_KEY not set — using original query');
    return { original: question, rewritten: question, skipped: true };
  }

  const { model, baseUrl } = config.llm;

  logStep('REWRITE', `Original: "${question.slice(0, 80)}${question.length > 80 ? '...' : ''}"`);

  try {
    const t0 = Date.now();

    const response = await axios.post(
      baseUrl,
      {
        model,
        temperature: REWRITE_TEMPERATURE,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: question },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.CLIENT_URL || 'http://localhost:3001',
          'X-Title': 'NotebookLM RAG',
        },
        timeout: REWRITE_TIMEOUT_MS,
      },
    );

    const latencyMs = Date.now() - t0;
    const raw = response.data.choices?.[0]?.message?.content;

    if (!raw) {
      logWarn('REWRITE', 'Model returned no content — using original query');
      return { original: question, rewritten: question, skipped: true };
    }

    const rewritten = raw.trim();

    // Validate output length
    if (rewritten.length < MIN_REWRITE_LENGTH || rewritten.length > MAX_REWRITE_LENGTH) {
      logWarn(
        'REWRITE',
        `Output length ${rewritten.length} out of bounds [${MIN_REWRITE_LENGTH}, ${MAX_REWRITE_LENGTH}] — using original query`,
      );
      return { original: question, rewritten: question, skipped: true };
    }

    logStep(
      'REWRITE',
      `Done | ${latencyMs}ms | Rewritten: "${rewritten.slice(0, 80)}${rewritten.length > 80 ? '...' : ''}"`,
    );

    return { original: question, rewritten, skipped: false };
  } catch (err) {
    const detail = describeError(err);
    logWarn('REWRITE', `Failed (${detail}) — using original query`);
    return { original: question, rewritten: question, skipped: true };
  }
}

// ---------------------------------------------------------------------------

function describeError(err) {
  if (err.code === 'ECONNABORTED') return 'timeout';
  if (err.response) {
    const body = err.response.data;
    const detail = typeof body === 'object' ? (body.error?.message ?? body.message ?? '') : '';
    return `HTTP ${err.response.status}${detail ? `: ${detail.slice(0, 80)}` : ''}`;
  }
  return err.message?.slice(0, 80) ?? 'unknown error';
}

// ---------------------------------------------------------------------------

module.exports = { rewriteQuery };
