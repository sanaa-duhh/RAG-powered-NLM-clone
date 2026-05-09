import React, { useState, useRef, useEffect } from 'react';
import Input from '../ui/Input';
import Button from '../ui/Button';
import MarkdownContent from '../ui/MarkdownContent';
import { sendMessage } from '../../api/chatApi';

export default function ChatPanel({ documentId }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const msgIdRef = useRef(0);

  function nextId() {
    return ++msgIdRef.current;
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  async function submit() {
    const q = question.trim();
    if (!q || isLoading || !documentId) return;

    setQuestion('');
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: q }]);
    setIsLoading(true);

    try {
      const data = await sendMessage(q, documentId);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: data.answer,
          sources: data.sources ?? [],
          refusal: data.refusal,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: err.message || 'Something went wrong. Please try again.',
          isError: true,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const showMessages = messages.length > 0 || isLoading;

  return (
    <div className="flex flex-col h-full bg-void">
      {/* Message area */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {!documentId ? (
          <EmptyState />
        ) : !showMessages ? (
          <ReadyState />
        ) : (
          <div className="max-w-2xl mx-auto flex flex-col gap-5">
            {messages.map((msg) => (
              <Message key={msg.id} message={msg} />
            ))}
            {isLoading && <ThinkingBubble />}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-white/[6%] bg-surface px-6 py-4">
        <div className="flex gap-3 max-w-2xl mx-auto">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!documentId || isLoading}
            placeholder={
              documentId
                ? 'Ask a question about your document…'
                : 'Upload a document to start chatting'
            }
          />
          <Button
            onClick={submit}
            disabled={!documentId || isLoading || !question.trim()}
            loading={isLoading}
            size="md"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

function Message({ message }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] flex flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Bubble */}
        <div
          className={
            isUser
              ? 'px-4 py-3 rounded-2xl rounded-br-sm bg-emerald-400 text-void text-sm font-medium leading-relaxed'
              : message.isError
                ? 'px-4 py-3 rounded-2xl rounded-bl-sm bg-red-950/40 border border-red-900/30 text-red-400 text-sm leading-relaxed'
                : 'px-4 py-4 rounded-2xl rounded-bl-sm bg-elevated border border-white/[7%] shadow-card text-sm w-full'
          }
        >
          {isUser || message.isError ? (
            message.content
          ) : (
            <MarkdownContent>{message.content}</MarkdownContent>
          )}
        </div>

        {/* Citations */}
        {!isUser && !message.isError && message.sources && message.sources.length > 0 && (
          <Citations sources={message.sources} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

function Citations({ sources }) {
  const seen = new Set();
  const unique = sources.filter((s) => {
    const key = `${s.filename}:${s.pageNumber ?? '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pl-1">
      {unique.map((src, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 bg-surface border border-emerald-400/15 rounded-md px-2.5 py-1 hover:border-emerald-400/30 hover:text-slate-400 transition-colors"
        >
          <svg className="w-3 h-3 shrink-0 text-emerald-400/50" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
          </svg>
          {src.filename}
          {src.pageNumber != null ? `, p.${src.pageNumber}` : ''}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center select-none">
      <div className="w-14 h-14 rounded-2xl bg-white/[3%] border border-white/[6%] flex items-center justify-center">
        <svg className="w-6 h-6 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-slate-400">No document loaded</p>
        <p className="text-xs text-slate-600 mt-1.5">Upload a PDF or TXT file to start chatting</p>
      </div>
    </div>
  );
}

function ReadyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center select-none">
      <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-glow-green-sm" />
      <p className="text-sm text-slate-500">Document indexed — ask a question below</p>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-elevated border border-white/[7%] shadow-card flex items-center gap-2.5">
        <svg className="w-4 h-4 text-emerald-400/60 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm text-slate-500">Thinking…</span>
      </div>
    </div>
  );
}
