import React from 'react';

const SIZES = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-8 h-8' };

export default function LoadingSpinner({ size = 'md', className = '' }) {
  return (
    <svg
      className={`animate-spin text-emerald-400 ${SIZES[size] ?? SIZES.md} ${className}`}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
