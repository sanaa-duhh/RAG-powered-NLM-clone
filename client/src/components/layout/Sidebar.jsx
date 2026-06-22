import React, { useState, useRef, useEffect } from 'react';
import { validateFile, uploadDocument } from '../../api/uploadApi';

export default function Sidebar({
  documents,
  activeDocumentId,
  onUploadComplete,
  onSelectDocument,
  onDeleteDocument,
}) {
  const [showUpload, setShowUpload] = useState(documents.length === 0);
  const [uploadState, setUploadState] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [chunksCreated, setChunksCreated] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // Auto-show upload panel when no documents exist
  useEffect(() => {
    if (documents.length === 0) setShowUpload(true);
  }, [documents.length]);

  async function handleFile(file) {
    const validationError = validateFile(file);
    if (validationError) {
      setErrorMsg(validationError);
      setUploadState('error');
      return;
    }

    setUploadState('uploading');
    setProgress(0);
    setErrorMsg('');

    try {
      const result = await uploadDocument(file, (pct) => {
        setProgress(pct);
        if (pct === 100) setUploadState('indexing');
      });

      setChunksCreated(result.chunksCreated);
      setUploadState('success');
      onUploadComplete(result.documentId, result.filename, result.chunksCreated);

      setTimeout(() => {
        setUploadState('idle');
        setShowUpload(false);
      }, 1500);
    } catch (err) {
      setErrorMsg(err.message);
      setUploadState('error');
    }
  }

  function onFileInputChange(e) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  }

  const isBusy = uploadState === 'uploading' || uploadState === 'indexing';

  function onDragOver(e) {
    e.preventDefault();
    if (!isBusy) setIsDragging(true);
  }
  function onDragLeave(e) {
    e.preventDefault();
    setIsDragging(false);
  }
  function onDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    if (isBusy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <aside className="w-72 bg-surface border-r border-white/[6%] flex flex-col shrink-0 overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-white/[6%] flex items-center justify-between">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
          Documents
        </span>
        <button
          onClick={() => setShowUpload((v) => !v)}
          className="text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New
        </button>
      </div>

      {/* Upload panel */}
      {showUpload && (
        <div className="px-3 py-3 border-b border-white/[6%]">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            onChange={onFileInputChange}
            className="hidden"
          />
          <UploadZone
            uploadState={uploadState}
            progress={progress}
            chunksCreated={chunksCreated}
            errorMsg={errorMsg}
            isDragging={isDragging}
            isBusy={isBusy}
            onZoneClick={() => !isBusy && fileInputRef.current?.click()}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onRetry={() => { setUploadState('idle'); setErrorMsg(''); }}
          />
        </div>
      )}

      {/* Document list */}
      <div className="flex-1 overflow-y-auto py-2">
        {documents.length === 0 ? (
          <p className="text-[11px] text-slate-600 text-center mt-6 px-4">
            No documents yet. Upload a PDF or TXT to get started.
          </p>
        ) : (
          documents.map((doc) => (
            <DocumentItem
              key={doc.documentId}
              doc={doc}
              isActive={doc.documentId === activeDocumentId}
              onSelect={() => onSelectDocument(doc.documentId)}
              onDelete={(e) => {
                e.stopPropagation();
                onDeleteDocument(doc.documentId);
              }}
            />
          ))
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Document list item
// ---------------------------------------------------------------------------

function DocumentItem({ doc, isActive, onSelect, onDelete }) {
  return (
    <div
      onClick={onSelect}
      className={`group relative flex items-start gap-2.5 px-3 py-2.5 mx-1 rounded-lg cursor-pointer transition-colors ${
        isActive
          ? 'bg-emerald-400/[6%] border border-emerald-400/15'
          : 'hover:bg-white/[3%] border border-transparent'
      }`}
    >
      {/* File icon */}
      <div className={`mt-0.5 w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
        isActive ? 'bg-emerald-400/10 border border-emerald-400/20' : 'bg-white/[4%] border border-white/10'
      }`}>
        <svg className={`w-3.5 h-3.5 ${isActive ? 'text-emerald-400' : 'text-slate-500'}`} fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
        </svg>
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium truncate ${isActive ? 'text-emerald-300/90' : 'text-slate-400'}`}>
          {doc.filename}
        </p>
        <p className="text-[10px] text-slate-600 mt-0.5">
          {doc.chunkCount} chunks · {relativeTime(doc.uploadedAt)}
        </p>
      </div>

      {/* Delete button */}
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 transition-opacity mt-0.5 p-1 rounded text-slate-600 hover:text-red-400 hover:bg-red-950/30 shrink-0"
        title="Remove from history"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload zone (extracted for clarity)
// ---------------------------------------------------------------------------

function UploadZone({
  uploadState, progress, chunksCreated, errorMsg, isDragging, isBusy,
  onZoneClick, onDragOver, onDragLeave, onDrop, onRetry,
}) {
  const base = 'border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-6 gap-2 transition-all duration-200';
  const stateClass =
    uploadState === 'error' ? 'border-red-900/50 bg-red-950/20' :
    uploadState === 'success' ? 'border-emerald-400/50 bg-emerald-400/[3%]' :
    isDragging ? 'border-emerald-400/50 bg-emerald-400/5' :
    'border-white/10 hover:border-emerald-400/30 hover:bg-emerald-400/[2%]';

  return (
    <div
      onClick={onZoneClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`${base} ${stateClass} ${isBusy ? 'cursor-default' : 'cursor-pointer'}`}
    >
      {uploadState === 'idle' && (
        <>
          <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <div className="text-center">
            <p className="text-xs font-medium text-slate-300">Upload PDF or TXT</p>
            <p className="text-[10px] text-slate-500 mt-0.5">Click or drag · 15 MB max</p>
          </div>
        </>
      )}
      {uploadState === 'uploading' && (
        <div className="w-full px-4 flex flex-col items-center gap-2">
          <p className="text-[11px] font-medium text-emerald-400">Uploading… {progress}%</p>
          <div className="w-full bg-white/[6%] rounded-full h-1">
            <div className="bg-emerald-400 h-1 rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {uploadState === 'indexing' && (
        <>
          <Spinner />
          <div className="text-center">
            <p className="text-xs font-medium text-emerald-400">Indexing…</p>
            <p className="text-[10px] text-slate-500 mt-0.5">Embedding into vector store</p>
          </div>
        </>
      )}
      {uploadState === 'success' && (
        <>
          <div className="w-8 h-8 rounded-full bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center">
            <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-xs font-medium text-emerald-400">Indexed · {chunksCreated} chunks</p>
        </>
      )}
      {uploadState === 'error' && (
        <>
          <div className="w-8 h-8 rounded-full bg-red-950/50 border border-red-900/30 flex items-center justify-center">
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <p className="text-[11px] text-red-400 text-center px-3 leading-relaxed">{errorMsg}</p>
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="text-[11px] text-emerald-400 hover:text-emerald-300 underline"
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-5 h-5 text-emerald-400 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
