import React from 'react';
import Header from './Header';
import Sidebar from './Sidebar';
import ChatPanel from './ChatPanel';

export default function AppLayout({ documentId, filename, onUploadComplete }) {
  return (
    <div className="flex flex-col h-screen bg-void">
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar
          documentId={documentId}
          filename={filename}
          onUploadComplete={onUploadComplete}
        />
        <main className="flex-1 min-w-0">
          <ChatPanel documentId={documentId} />
        </main>
      </div>
    </div>
  );
}
