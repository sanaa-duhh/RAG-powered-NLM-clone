import React from 'react';

export default function Input({
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled = false,
  type = 'text',
  className = '',
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      className={`
        w-full text-sm rounded-lg px-4 py-2.5
        bg-elevated border border-white/10 text-slate-200 placeholder:text-slate-500
        focus:outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/25
        disabled:opacity-40 disabled:cursor-not-allowed
        transition-colors duration-150
        ${className}
      `}
    />
  );
}
