const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

/**
 * Sends a question and streams the response via SSE.
 *
 * Callbacks:
 *   onStage(stage)  — pipeline stage string ('rewriting' | 'retrieving' | 'judging' | 'correcting' | 'generating')
 *   onToken(token)  — LLM token string as it streams
 *   onDone(data)    — final { answer, refusal, confidence, sources, stats }
 *   onError(msg)    — error string
 */
export async function sendMessageStream(question, documentId, history = [], callbacks = {}) {
  const { onStage, onToken, onDone, onError } = callbacks;

  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, documentId, history }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || err.message || `Server error ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // keep the last incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;

      let event;
      try { event = JSON.parse(raw); } catch { continue; }

      if (event.type === 'stage' && onStage) onStage(event.stage);
      if (event.type === 'token' && onToken) onToken(event.content);
      if (event.type === 'done' && onDone) { onDone(event); return; }
      if (event.type === 'error') {
        if (onError) onError(event.message);
        else throw new Error(event.message);
        return;
      }
    }
  }
}
