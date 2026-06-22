'use strict';

/**
 * summarize.js — Document-level summary generation.
 *
 * Called once during ingest, after chunking.
 * Produces a short prose summary of the document that is stored as a
 * special summary chunk (chunkIndex: -1, isSummary: true) in Qdrant.
 *
 * Why a dedicated summary chunk:
 *   Broad questions ("what is this pdf about?", "give me an overview")
 *   embed to generic vectors that don't match specific content chunks.
 *   A pre-generated summary embeds like a document overview AND is always
 *   injected into LLM context by ragPipeline.js, bypassing cosine ranking.
 *
 * Failure behaviour:
 *   generateDocumentSummary() NEVER throws. Any failure — timeout, 5xx,
 *   empty output — logs a warning and returns null. Ingest always continues.
 */

const axios = require('axios');
const config = require('../config');
const { logStep, logWarn } = require('../utils/logger');

const SYSTEM_PROMPT = `You are a document summarizer. Write a concise, factual summary of the provided document content.

Rules:
1. Output ONLY the summary text. No preamble, no labels, no "This document...".
2. Cover: what the document is about, its main topics, and its purpose.
3. Write in clear prose sentences, not bullet points.
4. Keep it under 200 words.`;

/**
 * Generates a prose summary of a document from its first N chars of content.
 *
 * @param {Array<{ text: string }>} chunks — chunked document content
 * @param {string} filename
 * @returns {Promise<string|null>} — summary text, or null on failure/disabled
 */
async function generateDocumentSummary(chunks, filename) {
  if (!config.summary.enabled) {
    logStep('SUMMARIZE', 'Disabled — skipping');
    return null;
  }

  if (!config.llm.apiKey) {
    logWarn('SUMMARIZE', 'LLM API key not set — skipping summary generation');
    return null;
  }

  // Build input from the first chunks up to maxInputChars
  let inputText = '';
  for (const chunk of chunks) {
    if (inputText.length >= config.summary.maxInputChars) break;
    inputText += chunk.text + '\n\n';
  }
  inputText = inputText.slice(0, config.summary.maxInputChars).trim();

  if (!inputText) {
    logWarn('SUMMARIZE', 'No text to summarize — skipping');
    return null;
  }

  logStep(
    'SUMMARIZE',
    `Generating summary for "${filename}" | input: ${inputText.length} chars`,
  );
  const t0 = Date.now();

  try {
    const response = await axios.post(
      config.llm.baseUrl,
      {
        model: config.llm.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Document: ${filename}\n\n${inputText}` },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.llm.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 25_000,
      },
    );

    const summary = response.data.choices?.[0]?.message?.content?.trim();

    if (!summary) {
      logWarn('SUMMARIZE', 'LLM returned empty summary — skipping');
      return null;
    }

    logStep('SUMMARIZE', `Done | ${Date.now() - t0}ms | ${summary.length} chars`);
    return summary;
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 120)}`
      : err.message?.slice(0, 100) ?? 'unknown error';
    logWarn('SUMMARIZE', `Failed (${detail}) — ingest continues without summary`);
    return null;
  }
}

module.exports = { generateDocumentSummary };
