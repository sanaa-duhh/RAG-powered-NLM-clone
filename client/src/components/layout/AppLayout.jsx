import React, { useState } from 'react';
import Header from './Header';
import Sidebar from './Sidebar';
import ChatPanel from './ChatPanel';

export default function AppLayout({
  documents,
  activeDocumentId,
  activeFilename,
  onUploadComplete,
  onSelectDocument,
  onDeleteDocument,
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleSelect(documentId) {
    onSelectDocument(documentId);
    setSidebarOpen(false);
  }

  return (
    <div className="flex flex-col h-screen bg-void">
      <Header onMenuClick={() => setSidebarOpen((v) => !v)} />
      <div className="flex flex-1 min-h-0 relative">
        {/* Sidebar — hidden on mobile unless open */}
        <div className={`
          md:relative md:flex md:flex-col md:shrink-0
          fixed inset-y-0 left-0 z-30 transition-transform duration-200
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}>
          <Sidebar
            documents={documents}
            activeDocumentId={activeDocumentId}
            onUploadComplete={(id, name, chunks) => { onUploadComplete(id, name, chunks); setSidebarOpen(false); }}
            onSelectDocument={handleSelect}
            onDeleteDocument={onDeleteDocument}
          />
        </div>

        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-20 bg-black/50 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <main className="flex-1 min-w-0">
          <ChatPanel documentId={activeDocumentId} filename={activeFilename} />
        </main>
      </div>
    </div>
  );
}
