'use strict';

/**
 * chunk.js — Document splitting.
 *
 * Takes LangChain Document objects (from PDFLoader or manual construction)
 * and splits them into overlapping chunks using RecursiveCharacterTextSplitter.
 *
 * Why splitDocuments() instead of createDocuments():
 *   splitDocuments() takes existing Documents and splits their pageContent
 *   while PRESERVING all metadata — including loc.pageNumber from PDFLoader.
 *   createDocuments() creates Documents from raw strings and loses that context.
 *
 * Chunking strategy:
 *   RecursiveCharacterTextSplitter tries separators in order:
 *     "\n\n" (paragraphs) → "\n" (lines) → " " (words) → "" (characters)
 *   It falls back to the next separator only if the text still exceeds chunkSize.
 *   This means chunks respect semantic boundaries whenever possible.
 *
 * Config (from config/index.js):
 *   chunkSize: 1000    ~200-250 words — enough context per retrieval chunk
 *   chunkOverlap: 200  prevents information loss at split boundaries
 *   minChunkLength: 50 threshold below which chunks are flagged as low-quality
 *
 * Output shape per chunk:
 *   {
 *     text: string,              — the chunk's text content
 *     metadata: {
 *       chunkId:      string,    — deterministic: "${documentId}-${chunkIndex}"
 *       documentId:   string,    — UUID of the parent document (for Qdrant filtering)
 *       filename:     string,    — original upload filename (for display/citations)
 *       chunkIndex:   number,    — 0-based position in the document
 *       totalChunks:  number,    — total chunks produced from this document
 *       pageNumber:   number|null — from PDFLoader; null for TXT files
 *       textPreview:  string,    — first 200 chars for Qdrant payload inspection
 *     }
 *   }
 *
 * Why deterministic chunkIds:
 *   `${documentId}-${chunkIndex}` is stable within a single ingestion run.
 *   documentId is a fresh UUID per upload, so chunkIds stay globally unique.
 *   Determinism makes debugging easier: chunkId 0 is always the first chunk.
 */

const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const config = require('../config');
const AppError = require('../utils/AppError');
const { logStep, logWarn } = require('../utils/logger');

const TEXT_PREVIEW_LENGTH = 200;

/**
 * Splits an array of LangChain Documents into enriched, metadata-tagged chunks.
 *
 * @param {import('@langchain/core/documents').Document[]} docs
 * @param {{ documentId: string, filename: string }} baseMetadata
 * @returns {Promise<Array<{ text: string, metadata: object }>>}
 */
async function chunkDocuments(docs, { documentId, filename }) {
  const { chunkSize, chunkOverlap, minChunkLength } = config.chunking;

  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });

  // splitDocuments preserves metadata (including loc.pageNumber) from each source Document
  const rawChunks = await splitter.splitDocuments(docs);

  if (rawChunks.length === 0) {
    throw new AppError('NO_CHUNKS', 'Document produced no chunks after splitting', 400);
  }

  const totalChunks = rawChunks.length;

  const chunks = rawChunks.map((doc, index) => ({
    text: doc.pageContent,
    metadata: {
      // Deterministic: stable within one ingestion run, globally unique because documentId is a UUID
      chunkId: `${documentId}-${index}`,
      documentId,
      filename,
      chunkIndex: index,
      totalChunks,
      // loc.pageNumber comes from PDFLoader (1-indexed); null for TXT files
      pageNumber: doc.metadata?.loc?.pageNumber ?? null,
      // Payload preview for Qdrant inspection without fetching full text
      textPreview: doc.pageContent.slice(0, TEXT_PREVIEW_LENGTH),
    },
  }));

  // Warn about short chunks — they exist but may hurt retrieval quality
  const shortChunks = chunks.filter((c) => c.text.trim().length < minChunkLength);
  if (shortChunks.length > 0) {
    logWarn(
      'CHUNK',
      `${shortChunks.length} of ${totalChunks} chunks are below ${minChunkLength} chars — may reduce retrieval quality`,
    );
  }

  // Log chunk statistics for retrieval quality assessment
  const sizes = chunks.map((c) => c.text.length);
  const avgSize = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);

  logStep(
    'CHUNK',
    `${totalChunks} chunks | avg: ${avgSize} | min: ${minSize} | max: ${maxSize} chars | overlap: ${chunkOverlap}`,
  );

  return chunks;
}

module.exports = { chunkDocuments };
