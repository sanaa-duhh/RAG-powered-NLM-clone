'use strict';

/**
 * ingest.js — Indexing pipeline orchestrator.
 *
 * Coordinates the full indexing sequence for a single uploaded file.
 * This is the ONLY file that knows the order of pipeline steps.
 *
 * Flow:
 *   1. Load file using LangChain document loaders
 *   2. Validate extracted content
 *   3. Split into overlapping chunks with preserved metadata
 *   4. Validate chunk output
 *   5. Debug log in development
 *   6. Embed chunks in batches (embeddings.js)
 *   7. Upsert to Qdrant with metadata payload (vectorStore.js)
 *   8. Return { documentId, chunksCreated }
 *
 * Cleanup guarantee:
 *   The finally block always deletes the temp file — even on failure.
 *   This prevents disk accumulation on Render's ephemeral filesystem.
 *
 * PDF loading strategy:
 *   PDFLoader with splitPages: true (default) loads one Document per page.
 *   Each Document carries metadata.loc.pageNumber (1-indexed).
 *   RecursiveCharacterTextSplitter.splitDocuments() preserves this through chunking.
 *
 * TXT loading strategy:
 *   No page concept exists. The full file becomes one Document.
 *   pageNumber is null for all TXT chunks.
 */

const fs = require('fs');
const crypto = require('crypto');
const { Document } = require('@langchain/core/documents');
const { PDFLoader } = require('@langchain/community/document_loaders/fs/pdf');

const { logStep, logError, logWarn } = require('../utils/logger');
const AppError = require('../utils/AppError');
const { chunkDocuments } = require('./chunk');
const { debugChunks } = require('./debug');

const { embedTexts } = require('./embeddings');
const { upsertChunks } = require('./vectorStore');

const MIN_DOC_CHARS = 50;
const MAX_PAGE_LOG = 10; // log individual page stats for up to this many pages

/**
 * @param {object} file — multer file object (path, originalname, mimetype, size)
 * @returns {Promise<{ documentId: string, chunksCreated: number }>}
 */
async function ingest(file) {
  const documentId = crypto.randomUUID();
  const filePath = file.path;

  try {
    logStep('INGEST', `Starting — ${file.originalname} | documentId: ${documentId}`);

    // --- Step 1: Load via LangChain loaders ---
    const docs = await extractDocuments(file);

    const totalChars = docs.reduce((sum, d) => sum + d.pageContent.length, 0);
    logStep('PARSE', `${docs.length} page(s) | ${totalChars.toLocaleString()} chars total`);

    // Log per-page stats (capped to avoid log spam on large documents)
    const previewCount = Math.min(docs.length, MAX_PAGE_LOG);
    docs.slice(0, previewCount).forEach((doc, i) => {
      const pageNum = doc.metadata?.loc?.pageNumber ?? i + 1;
      logStep('PARSE', `  page ${pageNum}: ${doc.pageContent.length} chars`);
    });
    if (docs.length > MAX_PAGE_LOG) {
      logStep('PARSE', `  ... and ${docs.length - MAX_PAGE_LOG} more page(s)`);
    }

    // Warn about pages with no extractable text (scanned images, blank pages)
    const emptyPages = docs.filter((d) => d.pageContent.trim().length === 0);
    if (emptyPages.length > 0) {
      logWarn(
        'PARSE',
        `${emptyPages.length} page(s) have no extractable text — may contain only images`,
      );
    }

    // --- Step 2: Validate extraction ---
    if (totalChars < MIN_DOC_CHARS) {
      throw new AppError(
        'EMPTY_DOCUMENT',
        'Document appears empty or unreadable. ' +
          'Possible causes: scanned images without OCR, password-protected PDF, or blank file.',
        400,
      );
    }

    // --- Step 3: Chunk with metadata preservation ---
    const chunks = await chunkDocuments(docs, { documentId, filename: file.originalname });

    // --- Step 4: Validate chunk output ---
    if (chunks.length === 0) {
      throw new AppError('NO_CHUNKS', 'Document produced no valid chunks after splitting', 400);
    }

    // Sample chunk previews for retrieval quality assessment
    const sampleChunks = chunks.slice(0, 3);
    sampleChunks.forEach((c) => {
      const preview = c.text.slice(0, 80).replace(/\n/g, ' ');
      logStep(
        'INGEST',
        `  sample chunk ${c.metadata.chunkIndex} (page ${c.metadata.pageNumber ?? 'N/A'}): "${preview}..."`,
      );
    });

    // --- Step 5: Debug log in development ---
    if (process.env.NODE_ENV !== 'production') {
      debugChunks(chunks);
    }

    // --- Step 6: Embed + store ---
    const texts = chunks.map((c) => c.text);
    // noFallback: true — prevents HF→OpenAI fallback during indexing.
    // If HF is down, we fail loudly rather than silently indexing in the
    // wrong embedding space (OpenAI 1536-dim vs collection's 384-dim).
    const vectors = await embedTexts(texts, { noFallback: true });
    logStep('EMBED', `${vectors.length} vectors | dim: ${vectors[0].length}`);

    const { stored } = await upsertChunks(chunks, vectors);
    logStep('QDRANT', `${stored} point(s) persisted`);

    logStep(
      'INGEST',
      `Done — documentId: ${documentId} | ${chunks.length} chunks embedded and stored`,
    );

    return { documentId, chunksCreated: chunks.length };
  } finally {
    // Always delete the temp file — even if any step above threw
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) logError('INGEST', `Failed to delete temp file: ${filePath}`);
    });
  }
}

/**
 * Loads a file using the appropriate LangChain document loader.
 *
 * PDF — PDFLoader (from @langchain/community):
 *   splitPages: true (default) → one Document per page
 *   Each Document has metadata.loc.pageNumber (1-indexed)
 *   metadata.source is set to the temp file path (internal, not shown to user)
 *
 * TXT — Manual Document construction:
 *   No native LangChain TextLoader without the heavy `langchain` package.
 *   We construct a Document directly using @langchain/core/documents.
 *   Behavior is identical to TextLoader: one Document, pageNumber: null.
 *
 * @param {object} file — multer file object
 * @returns {Promise<import('@langchain/core/documents').Document[]>}
 */
async function extractDocuments(file) {
  if (file.mimetype === 'application/pdf') {
    logStep('PARSE', `Loading PDF via PDFLoader: ${file.originalname}`);

    let docs;
    try {
      const loader = new PDFLoader(file.path); // splitPages: true is the default
      docs = await loader.load();
    } catch (err) {
      throw new AppError('PARSE_FAILED', `PDF parsing failed: ${err.message}`, 400);
    }

    if (!docs || docs.length === 0) {
      throw new AppError(
        'EMPTY_DOCUMENT',
        'PDF loaded but contained no pages with extractable text.',
        400,
      );
    }

    return docs;
  }

  if (file.mimetype === 'text/plain') {
    logStep('PARSE', `Loading TXT: ${file.originalname}`);

    let text;
    try {
      text = await fs.promises.readFile(file.path, 'utf-8');
    } catch (err) {
      throw new AppError('PARSE_FAILED', `Failed to read text file: ${err.message}`, 400);
    }

    if (!text || text.trim().length === 0) {
      throw new AppError('EMPTY_DOCUMENT', 'Text file appears to be empty', 400);
    }

    // Wrap in a LangChain Document so the rest of the pipeline is uniform
    return [
      new Document({
        pageContent: text,
        metadata: { source: file.originalname },
        // No loc.pageNumber — TXT files have no page concept
      }),
    ];
  }

  // Should not reach here — multer's fileFilter already blocks other types
  throw new AppError('UNSUPPORTED_TYPE', `Unsupported file type: ${file.mimetype}`, 400);
}

module.exports = { ingest };
