import React, { useState, useRef, useEffect } from 'react';
import { validateFile, uploadDocument } from '../../api/uploadApi';

export default function Sidebar({ documentId, filename, onUploadComplete }) {
  const [uploadState, setUploadState] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [chunksCreated, setChunksCreated] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (uploadState !== 'success') return;
    const timer = setTimeout(() => setUploadState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [uploadState]);

  async function handleFile(file) {
    const validationError = validateFile(file);
    if (validationError) {
      console.error('[UPLOAD] Validation failed:', validationError);
      setErrorMsg(validationError);
      setUploadState('error');
      return;
    }

    console.log(`[UPLOAD] File selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    console.log('[UPLOAD] Upload start');

    setUploadState('uploading');
    setProgress(0);
    setErrorMsg('');

    try {
      const result = await uploadDocument(file, (pct) => {
        setProgress(pct);
        if (pct === 100) {
          console.log('[UPLOAD] File transfer complete — server indexing...');
          setUploadState('indexing');
        }
      });

      console.log(`[UPLOAD] Success | documentId: ${result.documentId} | chunks: ${result.chunksCreated}`);
      setChunksCreated(result.chunksCreated);
      setUploadState('success');
      onUploadComplete(result.documentId, result.filename);
    } catch (err) {
      console.error('[UPLOAD] Error:', err.message);
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

  function onDropZoneClick() {
    if (isBusy) return;
    fileInputRef.current?.click();
  }

  function onDragOver(e) {
    e.preventDefault();
    if (isBusy) return;
    setIsDragging(true);
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

  function resetToIdle() {
    setUploadState('idle');
    setErrorMsg('');
    setProgress(0);
  }

  const dropZoneClass = [
    'border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-8 gap-2.5 transition-all duration-200',
    isBusy ? 'cursor-default' : 'cursor-pointer',
    uploadState === 'error'
      ? 'border-red-900/50 bg-red-950/20'
      : uploadState === 'success'
        ? 'border-emerald-400/50 bg-emerald-400/[3%] shadow-glow-green-sm'
        : isDragging
          ? 'border-emerald-400/50 bg-emerald-400/5 shadow-glow-green'
          : 'border-white/10 hover:border-emerald-400/30 hover:bg-emerald-400/[2%]',
  ].join(' ');

  return (
    <aside className="w-72 bg-surface border-r border-white/[6%] flex flex-col p-4 gap-5 shrink-0 overflow-y-auto">
      <section>
        <h2 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3">
          Document
        </h2>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          onChange={onFileInputChange}
          className="hidden"
        />

        <div
          onClick={onDropZoneClick}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={dropZoneClass}
        >
          {uploadState === 'idle' && <IdleContent />}
          {uploadState === 'uploading' && <UploadingContent progress={progress} />}
          {uploadState === 'indexing' && <IndexingContent />}
          {uploadState === 'success' && <SuccessContent chunks={chunksCreated} />}
          {uploadState === 'error' && (
            <ErrorContent message={errorMsg} onRetry={resetToIdle} />
          )}
        </div>
      </section>

      {documentId && filename && (
        <section>
          <h2 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2">
            Active Document
          </h2>
          <div className="bg-emerald-400/[4%] border border-emerald-400/15 rounded-xl p-3 flex items-start gap-2.5">
            <div className="w-5 h-5 rounded-md bg-emerald-400/10 border border-emerald-400/20 flex items-center justify-center shrink-0 mt-0.5">
              <svg className="w-3 h-3 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-emerald-300/80 truncate">{filename}</p>
              <p className="text-[10px] text-slate-600 mt-0.5 font-mono">{documentId.slice(0, 8)}…</p>
            </div>
          </div>
        </section>
      )}
    </aside>
  );
}

function IdleContent() {
  return (
    <>
      <div className="w-10 h-10 rounded-full bg-white/[4%] border border-white/10 flex items-center justify-center">
        <UploadIcon />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-slate-300">Upload PDF or TXT</p>
        <p className="text-xs text-slate-500 mt-1">Click or drag &amp; drop · 15 MB max</p>
      </div>
    </>
  );
}

function UploadingContent({ progress }) {
  return (
    <div className="w-full px-5 flex flex-col items-center gap-2.5">
      <p className="text-xs font-medium text-emerald-400">Uploading… {progress}%</p>
      <div className="w-full bg-white/[6%] rounded-full h-1">
        <div
          className="bg-emerald-400 h-1 rounded-full transition-all duration-200 shadow-glow-green-sm"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function IndexingContent() {
  return (
    <>
      <Spinner />
      <div className="text-center">
        <p className="text-sm font-medium text-emerald-400">Indexing document…</p>
        <p className="text-xs text-slate-500 mt-1">Embedding chunks into vector store</p>
      </div>
    </>
  );
}

function SuccessContent({ chunks }) {
  return (
    <>
      <div className="w-9 h-9 rounded-full bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center">
        <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-emerald-400">Indexed</p>
        <p className="text-xs text-slate-500 mt-1">{chunks} chunk{chunks !== 1 ? 's' : ''} ready</p>
      </div>
    </>
  );
}

function ErrorContent({ message, onRetry }) {
  return (
    <>
      <div className="w-9 h-9 rounded-full bg-red-950/50 border border-red-900/30 flex items-center justify-center">
        <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
      <p className="text-xs text-red-400 text-center px-4 leading-relaxed">{message}</p>
      <button
        onClick={(e) => { e.stopPropagation(); onRetry(); }}
        className="text-xs text-emerald-400 hover:text-emerald-300 underline decoration-emerald-400/30 cursor-pointer"
      >
        Try again
      </button>
    </>
  );
}

function Spinner() {
  return (
    <svg className="w-6 h-6 text-emerald-400 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
    </svg>
  );
}
