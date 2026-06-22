'use strict';

/**
 * Central configuration for the RAG pipeline.
 *
 * All constants live here. No other file hardcodes these values.
 * Changing behavior (chunk size, top-k, model) requires edits only here.
 *
 * Values that vary by environment come from process.env.
 * dotenv must be loaded before this module is required.
 */

module.exports = {
  // --- File upload ---
  upload: {
    maxSizeBytes: 15 * 1024 * 1024, // 15MB
    allowedMimeTypes: ['application/pdf', 'text/plain'],
  },

  // --- Document chunking ---
  chunking: {
    chunkSize: 1000, // characters per chunk (~200-250 words)
    chunkOverlap: 200, // overlap preserves context at boundaries
    minChunkLength: 50, // chunks shorter than this are warned as low-quality
  },

  // --- Embeddings ---
  embeddings: {
    provider: process.env.EMBEDDING_PROVIDER || 'huggingface',
    timeoutMs: 60_000, // HuggingFace cold starts can take 20-40s

    providers: {
      huggingface: {
        model: process.env.EMBEDDING_MODEL || 'BAAI/bge-small-en-v1.5',
        vectorSize: 384,
        baseUrl: 'https://router.huggingface.co/hf-inference/models',
      },
      openai: {
        model: 'text-embedding-3-small',
        vectorSize: 1536,
        baseUrl: 'https://api.openai.com/v1/embeddings',
      },
    },
  },

  // --- Vector store (Qdrant) ---
  qdrant: {
    collection: process.env.COLLECTION_NAME || 'documents',
    // Vector size must match the active embedding model's output dimension.
    // Changing the model requires recreating the collection.
    vectorSize: 384,
  },

  // --- Retrieval ---
  retrieval: {
    defaultTopK: 5,
    defaultMinScore: 0.4,

    // Candidate over-fetch multiplier — retrieve.js fetches topK * this
    // before deduplication so the final topK slots have more to choose from.
    candidateMultiplier: 3,

    // Context budget for semantic chunks (summary chunk is always prepended
    // on top of this by ragPipeline.js, outside the budget).
    // At ~250 words/1000 chars, 5000 chars ≈ 1250 words of context.
    maxContextChunks: 5,
    maxContextChars: 5000,

    // Jaccard similarity above this between two chunks → near-duplicate → drop lower score.
    // 0.85 catches true duplicates; lower (0.5) would also remove heavy-overlap pairs.
    dedupeThreshold: 0.85,

    // Warn if top retrieval score is below this — suggests weakly relevant context.
    lowConfidenceWarnScore: 0.5,
  },

  // --- Query rewriting (Phase A) ---
  queryRewriting: {
    // Rewrites user questions into retrieval-optimized phrases before embedding.
    // Uses config.llm.model and OPENROUTER_API_KEY — no additional credentials needed.
    // Set to false to bypass rewriting and embed the raw user question directly.
    enabled: true,
  },

  // --- Confidence gate + CRAG (Phase C/D) ---
  confidenceGate: {
    // Cosine score below this → refuse immediately, skip judge (clearly off-topic)
    hardRefuseBelow: 0.35,
    // Cosine score at or above this → skip judge, generate directly (clearly on-topic)
    skipJudgeAbove: 0.65,
    // In the uncertain zone [hardRefuseBelow, skipJudgeAbove):
    //   judge verdict HIGH   → generate normally
    //   judge verdict MEDIUM → attempt one corrective retrieval pass (CRAG)
    //   judge verdict LOW    → refuse (judge confirmed irrelevance)
    maxCorrectiveAttempts: 1,
  },

  // --- Retrieval judge (Phase B) ---
  retrievalJudge: {
    // LLM-as-Judge: re-scores and reranks retrieved chunks before generation.
    // A single batched LLM call evaluates all candidates; see retrievalJudge.js.
    // Set to false to skip reranking and use original Qdrant cosine order.
    enabled: true,
    timeoutMs: 12_000,
    temperature: 0.0,   // deterministic — scores must be consistent across runs
    // Maximum chars of each chunk's text sent to the judge.
    // Keeps token usage predictable; 400 chars is enough to assess content type.
    chunkPreviewLength: 400,
    // Score thresholds for verdict labels (inclusive).
    highThreshold: 7,   // score >= 7 → HIGH
    lowThreshold: 3,    // score <= 3 → LOW; else MEDIUM
  },

  // --- Document summary (generated once on ingest) ---
  summary: {
    // LLM-generated prose summary stored as a special chunk (chunkIndex: -1).
    // Always injected into LLM context by ragPipeline.js, bypassing cosine ranking.
    // Fixes broad "what is this about?" queries where specific chunks score low.
    enabled: true,
    // Max chars of document content fed to the LLM for summary generation.
    // First ~1000 words — enough to capture the document's scope and purpose.
    maxInputChars: 4000,
  },

  // --- LLM (Mistral AI) ---
  llm: {
    model: process.env.LLM_MODEL || 'mistral-small-latest',
    apiKey: process.env.MISTRAL_API_KEY,
    temperature: 0.1, // low = deterministic, prevents creative hallucinations
    timeoutMs: 30_000,
    baseUrl: 'https://api.mistral.ai/v1/chat/completions',

    // Retry on 5xx / rate limits — free tier models can be briefly unavailable
    maxRetries: 2,
    retryDelayMs: 1_500,

    // Guard rail: if system prompt + context + question exceed this, log a warning.
    // retrieve.js budgets context at 4000 chars; system prompt ~600; question ~2000.
    // 12 000 chars is well above normal usage — catches runaway prompts only.
    maxPromptChars: 12_000,
  },
};
