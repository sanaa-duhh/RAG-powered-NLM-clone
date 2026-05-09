import React from 'react';
import LoadingSpinner from './LoadingSpinner';

const VARIANTS = {
  primary:   'bg-emerald-400 text-void font-semibold hover:bg-emerald-300 focus:ring-emerald-400/30 shadow-glow-green-sm',
  secondary: 'bg-elevated text-slate-300 border border-white/10 hover:bg-overlay hover:border-white/20 focus:ring-slate-400/20',
  ghost:     'text-slate-400 hover:text-slate-200 hover:bg-white/5 focus:ring-slate-400/20',
};

const SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-sm',
};

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  type = 'button',
  onClick,
  className = '',
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`
        inline-flex items-center justify-center gap-2 rounded-lg
        focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-surface
        transition-all duration-150
        disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none
        ${VARIANTS[variant] ?? VARIANTS.primary} ${SIZES[size] ?? SIZES.md} ${className}
      `}
    >
      {loading ? <LoadingSpinner size="sm" className="text-current" /> : null}
      {children}
    </button>
  );
}
