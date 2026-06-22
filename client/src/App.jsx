import React, { useState } from 'react';
import AppLayout from './components/layout/AppLayout';
import { useLocalStorage } from './hooks/useLocalStorage';
import { deleteDocument } from './api/uploadApi';

export default function App() {
  // Persisted document registry: [{ documentId, filename, uploadedAt, chunkCount }]
  const [documents, setDocuments] = useLocalStorage('rag_documents', []);
  // Currently active document
  const [activeDocumentId, setActiveDocumentId] = useState(
    () => documents[0]?.documentId ?? null,
  );

  function handleUploadComplete(documentId, filename, chunkCount) {
    const newDoc = {
      documentId,
      filename,
      chunkCount,
      uploadedAt: new Date().toISOString(),
    };
    setDocuments((prev) => [newDoc, ...prev]);
    setActiveDocumentId(documentId);
  }

  function handleSelectDocument(documentId) {
    setActiveDocumentId(documentId);
  }

  async function handleDeleteDocument(documentId) {
    // Remove from UI immediately for snappy feel
    setDocuments((prev) => prev.filter((d) => d.documentId !== documentId));
    if (activeDocumentId === documentId) {
      const remaining = documents.filter((d) => d.documentId !== documentId);
      setActiveDocumentId(remaining[0]?.documentId ?? null);
    }
    try { localStorage.removeItem(`rag_chat_${documentId}`); } catch { /* ignore */ }

    // Best-effort Qdrant cleanup — don't block UI on this
    try { await deleteDocument(documentId); } catch { /* ignore — vectors stay in Qdrant but that's OK */ }
  }

  const activeDoc = documents.find((d) => d.documentId === activeDocumentId) ?? null;

  return (
    <AppLayout
      documents={documents}
      activeDocumentId={activeDocumentId}
      activeFilename={activeDoc?.filename ?? null}
      onUploadComplete={handleUploadComplete}
      onSelectDocument={handleSelectDocument}
      onDeleteDocument={handleDeleteDocument}
    />
  );
}
