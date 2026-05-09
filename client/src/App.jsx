import React, { useState } from 'react';
import AppLayout from './components/layout/AppLayout';

export default function App() {
  // documentId is null until a document is successfully uploaded.
  // It flows down to both Sidebar (to show active doc) and ChatPanel (to scope queries).
  const [documentId, setDocumentId] = useState(null);
  const [filename, setFilename] = useState(null);

  function handleUploadComplete(id, name) {
    setDocumentId(id);
    setFilename(name);
  }

  return (
    <AppLayout
      documentId={documentId}
      filename={filename}
      onUploadComplete={handleUploadComplete}
    />
  );
}
