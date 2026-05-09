import React from 'react';

export default function Header() {
  return (
    <header className="h-14 bg-surface border-b border-white/[6%] flex items-center px-6 shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-lg bg-emerald-400/10 border border-emerald-400/20 flex items-center justify-center shrink-0 shadow-glow-green-sm">
          <svg className="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
          </svg>
        </div>
        <span className="font-semibold text-slate-100 text-sm tracking-tight">NotebookLM RAG</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-glow-green-sm" />
        <span className="text-xs text-slate-500 font-mono tracking-wider">ONLINE</span>
      </div>
    </header>
  );
}
