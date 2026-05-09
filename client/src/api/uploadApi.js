import api from './client';

const MAX_SIZE_BYTES = 15 * 1024 * 1024;
const ALLOWED_TYPES = ['application/pdf', 'text/plain'];

/**
 * Client-side file validation. Returns an error string, or null if valid.
 * @param {File} file
 * @returns {string|null}
 */
export function validateFile(file) {
  if (!file) return 'No file selected.';
  if (file.size === 0) return 'File is empty.';
  if (file.size > MAX_SIZE_BYTES) {
    return `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit is 15 MB.`;
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return 'Only PDF and TXT files are supported.';
  }
  return null;
}

/**
 * Uploads a file to POST /api/upload and triggers the indexing pipeline.
 * Calls onProgress(0–100) during HTTP transfer. After 100%, the server
 * runs the ingest pipeline — no further progress signals are available.
 *
 * @param {File} file
 * @param {(pct: number) => void} [onProgress]
 * @returns {Promise<{ documentId: string, filename: string, chunksCreated: number }>}
 */
export async function uploadDocument(file, onProgress) {
  const form = new FormData();
  form.append('file', file);

  const res = await api.post('/api/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120_000, // indexing large PDFs can take 30-60s
    onUploadProgress: (evt) => {
      if (onProgress && evt.total) {
        onProgress(Math.round((evt.loaded * 100) / evt.total));
      }
    },
  });

  return res.data;
}
