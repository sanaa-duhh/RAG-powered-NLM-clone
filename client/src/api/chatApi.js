import api from './client';

/**
 * Sends a question to POST /api/chat and returns the grounded answer.
 *
 * @param {string} question
 * @param {string} documentId
 * @returns {Promise<{
 *   answer: string,
 *   refusal: boolean,
 *   confidence: 'high' | 'low' | 'none',
 *   sources: Array<{ filename: string, pageNumber: number|null, score: number, preview: string }>,
 *   stats: object,
 * }>}
 */
export async function sendMessage(question, documentId) {
  const res = await api.post('/api/chat', { question, documentId });
  return res.data;
}
