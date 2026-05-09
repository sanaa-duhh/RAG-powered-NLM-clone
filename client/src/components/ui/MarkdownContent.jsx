import React from 'react';
import ReactMarkdown from 'react-markdown';

/*
 * Block-level elements (headings, paragraphs, lists, hr, blockquote) are styled
 * via the .markdown CSS class in index.css so their spacing reads as a coherent
 * document rather than as isolated React components.
 *
 * Code is handled via the components prop here because it needs bespoke dark-theme
 * styling that differs between block and inline contexts.
 */

const mdComponents = {
  // Code block container — pre wraps block code
  pre: ({ children }) => (
    <pre className="bg-void border border-white/10 rounded-lg p-4 my-3 overflow-x-auto">
      {children}
    </pre>
  ),

  // Code — differentiate block (has language-* class) from inline (no class)
  code: ({ children, className }) => {
    if (className?.startsWith('language-')) {
      // Block code inside a <pre> — just style the text
      return (
        <code className="text-xs font-mono text-emerald-300/80 block leading-relaxed">
          {children}
        </code>
      );
    }
    // Inline code
    return (
      <code className="px-1.5 py-0.5 rounded text-xs font-mono text-emerald-400 bg-void border border-white/10">
        {children}
      </code>
    );
  },
};

export default function MarkdownContent({ children }) {
  return (
    <div className="markdown">
      <ReactMarkdown components={mdComponents}>{children}</ReactMarkdown>
    </div>
  );
}
