'use strict';

/**
 * vectorStore.js — Qdrant operations: create, store, search, delete.
 *
 * Public API:
 *   initializeCollection()               — idempotent startup check
 *   upsertChunks(chunks, vectors)        — store embedded chunks
 *   similaritySearch(vec, docId, opts)   — cosine search filtered to one document
 *   deleteByDocumentId(documentId)       — full document removal (testing / future UI)
 *   getCollectionInfo()                  — raw Qdrant collection stats
 *
 * Collection design:
 *   One collection holds all documents. Per-document isolation is enforced by
 *   a `documentId` filter on every search — never cross-document results.
 *
 * Vector configuration:
 *   distance: Cosine (explicit — never relies on Qdrant defaults)
 *   size:     384    (BAAI/bge-small-en-v1.5 — must match config.qdrant.vectorSize)
 *   Mixing models between indexing and querying silently breaks retrieval.
 *   Changing the model requires recreating the collection.
 *
 * Idempotent initialization:
 *   If the collection already exists, we verify its vector size and distance
 *   match config exactly. Mismatch → hard error, never auto-delete/recreate.
 *
 * Point payload stored per chunk:
 *   text, textPreview, chunkId, documentId, filename,
 *   chunkIndex, totalChunks, pageNumber
 */

const crypto = require('crypto');
const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../config');
const { logStep, logWarn } = require('../utils/logger');

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client = null;

function getClient() {
  if (_client) return _client;

  if (!process.env.QDRANT_URL) {
    throw new Error('QDRANT_URL is not set. Add it to .env before using vector storage.');
  }

  _client = new QdrantClient({
    url: process.env.QDRANT_URL,
    // apiKey is optional — omit if undefined so the client doesn't send a blank header
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  });

  return _client;
}

// ---------------------------------------------------------------------------
// Collection initialization
// ---------------------------------------------------------------------------

/**
 * Idempotent — safe to call on every server start.
 *
 * If the collection doesn't exist: creates it with the configured vector params.
 * If it exists: verifies that vector size and distance metric match config exactly.
 * Never auto-deletes or recreates — a mismatch means data integrity risk.
 *
 * @returns {Promise<{ created: boolean, pointCount: number }>}
 */
async function initializeCollection() {
  const client = getClient();
  const { collection, vectorSize } = config.qdrant;

  logStep('QDRANT', `Checking collection "${collection}"...`);

  const { exists } = await client.collectionExists(collection);

  if (!exists) {
    logStep('QDRANT', `Collection not found — creating | dim: ${vectorSize} | distance: Cosine`);

    await client.createCollection(collection, {
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
      },
    });

    logStep('QDRANT', `Collection "${collection}" created`);
    await ensureDocumentIdIndex(client, collection);
    return { created: true, pointCount: 0 };
  }

  // Collection exists — verify it matches our config
  const info = await client.getCollection(collection);
  const vectorParams = extractVectorParams(info.config.params.vectors);

  if (!vectorParams) {
    throw new Error(
      `Collection "${collection}" has no readable vector config. ` +
        `Delete and recreate the collection.`,
    );
  }

  if (vectorParams.size !== vectorSize) {
    throw new Error(
      `Collection "${collection}" has vector size ${vectorParams.size}, ` +
        `but config.qdrant.vectorSize is ${vectorSize}. ` +
        `They must match. ` +
        `Either update config/index.js or recreate the Qdrant collection.`,
    );
  }

  if (vectorParams.distance !== 'Cosine') {
    throw new Error(
      `Collection "${collection}" uses distance metric "${vectorParams.distance}", ` +
        `expected "Cosine". ` +
        `Recreate the collection with distance: Cosine.`,
    );
  }

  const pointCount = info.points_count ?? 0;
  logStep(
    'QDRANT',
    `Collection "${collection}" verified | ${pointCount} points | dim: ${vectorParams.size} | distance: ${vectorParams.distance}`,
  );

  await ensureDocumentIdIndex(client, collection);
  return { created: false, pointCount };
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * Stores embedded chunks in Qdrant. Validates every vector before writing.
 *
 * Point IDs are fresh UUIDs (Qdrant-internal). The chunkId field in the
 * payload is the semantic identifier used by the rest of the pipeline.
 *
 * @param {Array<{ text: string, metadata: object }>} chunks — from chunk.js
 * @param {number[][]} vectors — one vector per chunk, from embeddings.js
 * @returns {Promise<{ stored: number }>}
 */
async function upsertChunks(chunks, vectors) {
  validateUpsertInput(chunks, vectors);

  const client = getClient();
  const { collection } = config.qdrant;

  const points = chunks.map((chunk, i) => ({
    id: crypto.randomUUID(), // Qdrant point ID — decoupled from chunkId
    vector: vectors[i],
    payload: {
      text: chunk.text,
      textPreview: chunk.metadata.textPreview,
      chunkId: chunk.metadata.chunkId,
      documentId: chunk.metadata.documentId,
      filename: chunk.metadata.filename,
      chunkIndex: chunk.metadata.chunkIndex,
      totalChunks: chunk.metadata.totalChunks,
      pageNumber: chunk.metadata.pageNumber ?? null,
      isSummary: chunk.metadata.isSummary ?? false,
    },
  }));

  logStep('QDRANT', `Upserting ${points.length} point(s) into "${collection}"...`);

  await client.upsert(collection, {
    wait: true, // blocks until Qdrant confirms write — ensures consistency
    points,
  });

  // Sample payload preview for debugging
  const samples = points.slice(0, Math.min(2, points.length));
  for (const pt of samples) {
    const preview = pt.payload.textPreview.replace(/\n/g, ' ').slice(0, 70);
    logStep(
      'QDRANT',
      `  stored: ${pt.payload.chunkId} | page: ${pt.payload.pageNumber ?? 'N/A'} | "${preview}..."`,
    );
  }

  logStep('QDRANT', `Upsert complete — ${points.length} point(s) persisted`);

  return { stored: points.length };
}

// ---------------------------------------------------------------------------
// Similarity search
// ---------------------------------------------------------------------------

/**
 * Cosine similarity search scoped to a single document.
 *
 * The documentId filter is always applied — callers cannot retrieve results
 * from other documents even if they try. This is the primary isolation boundary.
 *
 * @param {number[]} queryVector
 * @param {string} documentId
 * @param {{ topK?: number, minScore?: number }} options
 * @returns {Promise<Array<{ score: number, text: string, metadata: object }>>}
 */
async function similaritySearch(queryVector, documentId, options = {}) {
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    throw new Error('similaritySearch: queryVector must be a non-empty array');
  }
  if (!documentId) {
    throw new Error('similaritySearch: documentId is required');
  }

  const client = getClient();
  const { collection } = config.qdrant;

  // Retrieval config (topK, minScore) is owned by retrieve.js — vectorStore is storage-only.
  // We accept whatever the caller passes, with a safe last-resort fallback for direct calls.
  const limit = options.topK ?? 10;
  const scoreThreshold = options.minScore; // undefined = let Qdrant return all matches

  logStep(
    'QDRANT',
    `Search | documentId: ${documentId} | limit: ${limit}${scoreThreshold !== undefined ? ` | minScore: ${scoreThreshold}` : ''}`,
  );

  const rawResults = await client.search(collection, {
    vector: queryVector,
    filter: {
      must: [{ key: 'documentId', match: { value: documentId } }],
      // Exclude the summary chunk from vector search — it is always fetched
      // separately and injected by ragPipeline.js with score 1.0 and a
      // special label. Including it here pollutes cosine ranking and causes
      // the model to see it with a low relevance score (0.5x), not as a
      // priority overview.
      must_not: [{ key: 'isSummary', match: { value: true } }],
    },
    limit,
    ...(scoreThreshold !== undefined ? { score_threshold: scoreThreshold } : {}),
    with_payload: true,
  });

  logStep('QDRANT', `Found ${rawResults.length} result(s)`);

  rawResults.forEach((r, i) => {
    logStep(
      'QDRANT',
      `  [${i}] score: ${r.score.toFixed(4)} | ${r.payload.chunkId} | page: ${r.payload.pageNumber ?? 'N/A'}`,
    );
  });

  return rawResults.map((r) => ({
    score: r.score,
    text: r.payload.text,
    metadata: {
      chunkId: r.payload.chunkId,
      documentId: r.payload.documentId,
      filename: r.payload.filename,
      chunkIndex: r.payload.chunkIndex,
      totalChunks: r.payload.totalChunks,
      pageNumber: r.payload.pageNumber,
      textPreview: r.payload.textPreview,
    },
  }));
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * Removes all points belonging to a document. Used by the storage test utility
 * for cleanup, and will be wired to a DELETE /api/upload/:documentId route later.
 *
 * @param {string} documentId
 * @returns {Promise<{ deleted: boolean }>}
 */
async function deleteByDocumentId(documentId) {
  if (!documentId) throw new Error('deleteByDocumentId: documentId is required');

  const client = getClient();
  const { collection } = config.qdrant;

  logStep('QDRANT', `Deleting all points for documentId: ${documentId}`);

  await client.delete(collection, {
    wait: true,
    filter: {
      must: [{ key: 'documentId', match: { value: documentId } }],
    },
  });

  logStep('QDRANT', `Delete complete for documentId: ${documentId}`);

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Collection health / diagnostics
// ---------------------------------------------------------------------------

/**
 * Returns raw collection info for startup health checks and diagnostics.
 *
 * @returns {Promise<object>}
 */
async function getCollectionInfo() {
  const client = getClient();
  const { collection } = config.qdrant;
  return client.getCollection(collection);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validates chunks + vectors before upsert to prevent corrupt writes.
 * Called before every upsert — not just in development.
 */
function validateUpsertInput(chunks, vectors) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('upsertChunks: chunks must be a non-empty array');
  }
  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    throw new Error(
      `upsertChunks: vector count (${vectors?.length}) must match chunk count (${chunks.length})`,
    );
  }

  const { vectorSize } = config.qdrant;

  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i];

    if (!Array.isArray(vec) || vec.length !== vectorSize) {
      throw new Error(
        `upsertChunks: vector at index ${i} has dimension ${vec?.length ?? 'undefined'}, expected ${vectorSize}`,
      );
    }

    if (!vec.every((v) => typeof v === 'number' && isFinite(v))) {
      throw new Error(
        `upsertChunks: vector at index ${i} contains non-numeric or non-finite values`,
      );
    }

    const m = chunks[i]?.metadata;
    if (!m?.chunkId || !m?.documentId || !m?.filename) {
      throw new Error(
        `upsertChunks: chunk at index ${i} is missing required metadata (chunkId, documentId, filename)`,
      );
    }

    if (!chunks[i].text) {
      throw new Error(`upsertChunks: chunk at index ${i} has no text`);
    }

    if (!chunks[i].metadata.textPreview) {
      throw new Error(`upsertChunks: chunk at index ${i} has no textPreview`);
    }
  }
}

/**
 * Fetches the summary chunk for a document (chunkIndex: -1, isSummary: true).
 * Returns null if the document was indexed before summary support was added,
 * or if summary generation failed during ingest.
 *
 * Uses Qdrant scroll (no vector required) since we fetch by exact field match.
 *
 * @param {string} documentId
 * @returns {Promise<{ score: number, text: string, metadata: object } | null>}
 */
async function fetchSummaryChunk(documentId) {
  if (!documentId) return null;

  const client = getClient();
  const { collection } = config.qdrant;

  try {
    const result = await client.scroll(collection, {
      filter: {
        must: [
          { key: 'documentId', match: { value: documentId } },
          { key: 'isSummary', match: { value: true } },
        ],
      },
      limit: 1,
      with_payload: true,
      with_vector: false,
    });

    if (!result.points || result.points.length === 0) return null;

    const p = result.points[0].payload;
    return {
      score: 1.0, // always highest priority — not cosine-ranked
      text: p.text,
      metadata: {
        chunkId: p.chunkId,
        documentId: p.documentId,
        filename: p.filename,
        chunkIndex: p.chunkIndex,
        totalChunks: p.totalChunks,
        pageNumber: p.pageNumber,
        textPreview: p.textPreview,
        isSummary: true,
      },
    };
  } catch (err) {
    logWarn('QDRANT', `fetchSummaryChunk failed: ${err.message} — proceeding without summary`);
    return null;
  }
}

/**
 * Creates payload indexes required by Qdrant Cloud strict mode.
 * Any field used as a filter must have an explicit index.
 * createPayloadIndex is idempotent — safe to call on every startup.
 */
async function ensureDocumentIdIndex(client, collection) {
  await client.createPayloadIndex(collection, {
    field_name: 'documentId',
    field_schema: 'keyword',
    wait: true,
  });
  await client.createPayloadIndex(collection, {
    field_name: 'isSummary',
    field_schema: 'bool',
    wait: true,
  });
  logStep('QDRANT', 'Payload indexes on "documentId" and "isSummary" ready');
}

/**
 * Extracts a single VectorParams object from either format:
 *   Unnamed vectors: { size: 384, distance: "Cosine" }     → returns it directly
 *   Named vectors:   { default: { size: 384, ... }, ... }  → returns first entry
 */
function extractVectorParams(vectorsConfig) {
  if (!vectorsConfig) return null;

  // Unnamed: VectorParams has a numeric 'size' field at the top level
  if (typeof vectorsConfig.size === 'number') {
    return vectorsConfig;
  }

  // Named: { [name]: VectorParams } — take the first one
  const entries = Object.values(vectorsConfig);
  if (entries.length > 0 && typeof entries[0]?.size === 'number') {
    if (entries.length > 1) {
      logWarn(
        'QDRANT',
        'Collection has multiple named vector configs — validating first entry only',
      );
    }
    return entries[0];
  }

  return null;
}

/**
 * Fetches all non-summary chunks for a document (no vector search).
 * Used by hybrid retrieval to compute keyword scores across the full corpus.
 * Capped at maxChunks to avoid fetching huge documents on every query.
 *
 * @param {string} documentId
 * @param {number} maxChunks
 * @returns {Promise<Array<{ text: string, metadata: object }>>}
 */
async function fetchAllChunks(documentId, maxChunks = 150) {
  const client = getClient();
  const { collection } = config.qdrant;

  const result = await client.scroll(collection, {
    filter: {
      must: [{ key: 'documentId', match: { value: documentId } }],
      must_not: [{ key: 'isSummary', match: { value: true } }],
    },
    with_payload: true,
    with_vector: false,
    limit: maxChunks,
  });

  return (result.points || []).map((p) => ({
    score: 0,
    text: p.payload.text,
    metadata: {
      chunkId: p.payload.chunkId,
      documentId: p.payload.documentId,
      filename: p.payload.filename,
      chunkIndex: p.payload.chunkIndex,
      totalChunks: p.payload.totalChunks,
      pageNumber: p.payload.pageNumber,
      textPreview: p.payload.textPreview,
    },
  }));
}

module.exports = {
  initializeCollection,
  upsertChunks,
  similaritySearch,
  fetchSummaryChunk,
  fetchAllChunks,
  deleteByDocumentId,
  getCollectionInfo,
};
