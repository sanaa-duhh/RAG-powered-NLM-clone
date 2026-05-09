'use strict';

/**
 * embeddings.js — Embedding provider abstraction.
 *
 * Public API (used by the rest of the pipeline):
 *   embedTexts(texts[])  — batch embed, always returns number[][]
 *   embedQuery(text)     — convenience wrapper, returns number[]
 *
 * Provider routing:
 *   Controlled by EMBEDDING_PROVIDER env var (default: huggingface).
 *   To switch: change EMBEDDING_PROVIDER in .env — no other file changes needed.
 *
 * HuggingFace strategy:
 *   - wait_for_model: true  absorbs cold-start 503s at the HTTP level
 *   - 3 retries with exponential backoff for remaining transient failures
 *   - Falls back to OpenAI automatically if OPENAI_API_KEY is set
 *
 * Output shape normalization:
 *   HF feature-extraction can return 2D (batch × dim) or 3D (batch × tokens × dim).
 *   3D output is mean-pooled to produce sentence-level vectors.
 *
 * Dimension validation:
 *   Every vector is checked against config.qdrant.vectorSize.
 *   A mismatch throws immediately with a clear fix hint.
 *   Changing the embedding model requires updating qdrant.vectorSize and
 *   recreating the Qdrant collection.
 */

const axios = require('axios');
const config = require('../config');
const { logStep, logWarn, logError } = require('../utils/logger');

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_BACKOFF_FACTOR = 2; // delay doubles each attempt: 2s → 4s → 8s

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embeds a batch of texts. Always accepts array, always returns array of vectors.
 *
 * @param {string[]} texts
 * @param {{ noFallback?: boolean }} options
 *   noFallback: true — disables HuggingFace→OpenAI fallback.
 *   Use during indexing to prevent mixing embedding spaces.
 *   During retrieval (chat pipeline) the same flag keeps query vectors
 *   in the same space as the stored document vectors.
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embedTexts requires a non-empty array of strings');
  }

  for (let i = 0; i < texts.length; i++) {
    if (typeof texts[i] !== 'string' || texts[i].trim().length === 0) {
      throw new Error(`embedTexts: element at index ${i} is not a non-empty string`);
    }
  }

  const { provider } = config.embeddings;

  switch (provider) {
    case 'huggingface':
      return embedWithHuggingFace(texts, options);
    case 'openai':
      return embedWithOpenAI(texts);
    default:
      throw new Error(
        `Unknown embedding provider: "${provider}". Set EMBEDDING_PROVIDER=huggingface or openai in .env`,
      );
  }
}

/**
 * Embeds a single query string. Used by the chat pipeline for question embedding.
 * Pass { noFallback: true } to prevent HF→OpenAI fallback during retrieval,
 * keeping query vectors in the same embedding space as the indexed documents.
 *
 * @param {string} text
 * @param {{ noFallback?: boolean }} options
 * @returns {Promise<number[]>}
 */
async function embedQuery(text, options = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('embedQuery requires a non-empty string');
  }
  const vectors = await embedTexts([text], options);
  return vectors[0];
}

// ---------------------------------------------------------------------------
// HuggingFace provider
// ---------------------------------------------------------------------------

async function embedWithHuggingFace(texts, options = {}) {
  if (!process.env.HF_API_KEY) {
    throw new Error('HF_API_KEY is not set. Add it to .env to use HuggingFace embeddings.');
  }

  const { providers, timeoutMs } = config.embeddings;
  const { model, baseUrl } = providers.huggingface;
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);

  logStep('EMBED', `HuggingFace | model: ${model} | batch: ${texts.length} | ~${totalChars} chars`);

  let lastError;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const t0 = Date.now();

      const response = await axios.post(
        `${baseUrl}/${model}`,
        { inputs: texts, options: { wait_for_model: true } },
        {
          headers: {
            Authorization: `Bearer ${process.env.HF_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: timeoutMs,
        },
      );

      const latencyMs = Date.now() - t0;
      const vectors = normalizeHuggingFaceOutput(response.data);
      validateVectors(vectors, texts.length);

      logStep(
        'EMBED',
        `HuggingFace done | dim: ${vectors[0].length} | latency: ${latencyMs}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
      );

      return vectors;
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt === RETRY_ATTEMPTS) break;

      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
      logWarn(
        'EMBED',
        `HuggingFace attempt ${attempt} failed (${describeError(err)}) — retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  // All retries exhausted — try OpenAI fallback if key is available AND not disabled.
  // noFallback: true is used during indexing to prevent mixing embedding spaces.
  // If indexing vectors are from HF (384-dim) and query vectors from OpenAI (1536-dim),
  // similarity search silently returns garbage results.
  if (!options.noFallback && process.env.OPENAI_API_KEY) {
    logWarn(
      'EMBED',
      `HuggingFace failed after ${RETRY_ATTEMPTS} attempts — falling back to OpenAI`,
    );
    return embedWithOpenAI(texts);
  }

  logError(
    'EMBED',
    `HuggingFace failed after ${RETRY_ATTEMPTS} attempts: ${describeError(lastError)}`,
  );
  throw lastError;
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

async function embedWithOpenAI(texts) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env to use OpenAI embeddings.');
  }

  const { providers } = config.embeddings;
  const { model, baseUrl } = providers.openai;
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);

  logStep('EMBED', `OpenAI | model: ${model} | batch: ${texts.length} | ~${totalChars} chars`);

  const t0 = Date.now();

  const response = await axios.post(
    baseUrl,
    { input: texts, model },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const latencyMs = Date.now() - t0;
  const vectors = response.data.data.map((item) => item.embedding);
  validateVectors(vectors, texts.length);

  logStep('EMBED', `OpenAI done | dim: ${vectors[0].length} | latency: ${latencyMs}ms`);

  return vectors;
}

// ---------------------------------------------------------------------------
// Output normalization
// ---------------------------------------------------------------------------

/**
 * HuggingFace feature-extraction can return three shapes:
 *   number[]     — single vector (edge case: single string sent, returned flat)
 *   number[][]   — correct: one sentence vector per input (BGE models do this)
 *   number[][][] — per-token embeddings: requires mean pooling along token axis
 */
function normalizeHuggingFaceOutput(data) {
  if (!Array.isArray(data)) {
    throw new Error(
      `HuggingFace returned unexpected response type: ${typeof data}. ` +
        `Expected array. Raw: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  // 3D: batch × tokens × hidden → mean-pool each item's token embeddings
  if (data.length > 0 && Array.isArray(data[0]) && Array.isArray(data[0][0])) {
    logStep('EMBED', 'HuggingFace returned per-token embeddings — applying mean pooling');
    return data.map(meanPool);
  }

  // 2D: batch × hidden — the expected format for sentence embedding models
  if (data.length > 0 && Array.isArray(data[0])) {
    return data;
  }

  // 1D: single flat vector (edge case when API didn't batch)
  if (data.length > 0 && typeof data[0] === 'number') {
    return [data];
  }

  throw new Error(
    `HuggingFace returned an unrecognized output shape. ` +
      `First element type: ${typeof data[0]}. Length: ${data.length}`,
  );
}

/**
 * Mean-pools a sequence of token embeddings into one sentence vector.
 * Input: number[][] (tokens × hidden)
 * Output: number[] (hidden)
 */
function meanPool(tokenEmbeddings) {
  const dim = tokenEmbeddings[0].length;
  const pooled = new Array(dim).fill(0);
  for (const token of tokenEmbeddings) {
    for (let i = 0; i < dim; i++) pooled[i] += token[i];
  }
  return pooled.map((v) => v / tokenEmbeddings.length);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that vectors are correctly formed and match the configured dimension.
 * Throws immediately on any mismatch — a dimension error here would silently
 * corrupt the Qdrant collection if not caught.
 */
function validateVectors(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} embedding vector(s), got ${vectors?.length ?? 0}`);
  }

  const { vectorSize } = config.qdrant;

  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];

    if (!Array.isArray(vec)) {
      throw new Error(`Vector at index ${i} is not an array (got ${typeof vec})`);
    }

    if (vec.length !== vectorSize) {
      throw new Error(
        `Dimension mismatch at index ${i}: got ${vec.length}, expected ${vectorSize}. ` +
          `If you changed the embedding model, update qdrant.vectorSize in config/index.js ` +
          `and recreate the Qdrant collection.`,
      );
    }

    if (!vec.every((v) => typeof v === 'number' && isFinite(v))) {
      throw new Error(`Vector at index ${i} contains non-numeric or non-finite values`);
    }
  }
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

function isRetryable(err) {
  if (err.response) {
    // 503: model loading / overloaded, 429: rate limit, 500/502/504: server errors
    return [500, 502, 503, 504, 429].includes(err.response.status);
  }
  // Network-level failures
  const retryableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED'];
  return retryableCodes.includes(err.code) || Boolean(err.message?.includes('timeout'));
}

function describeError(err) {
  if (err.response) {
    const body = err.response.data;
    const detail = typeof body === 'object' ? (body.error ?? body.message ?? '') : String(body);
    return `HTTP ${err.response.status}${detail ? `: ${detail}` : ''}`;
  }
  return err.message ?? String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

module.exports = { embedTexts, embedQuery };
