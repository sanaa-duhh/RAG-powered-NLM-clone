import React from 'react';

export default function Card({ children, className = '' }) {
  return (
    <div className={`bg-elevated rounded-xl border border-white/[8%] shadow-card-sm ${className}`}>
      {children}
    </div>
  );
}
