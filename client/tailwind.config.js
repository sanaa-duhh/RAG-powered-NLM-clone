/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Layered dark backgrounds — void is deepest, overlay is highest
        void:     '#07090d',
        surface:  '#0d1117',
        elevated: '#141c27',
        overlay:  '#1a2535',
      },
      boxShadow: {
        'glow-green':    '0 0 20px rgba(52,211,153,0.08), 0 0 40px rgba(52,211,153,0.04)',
        'glow-green-sm': '0 0 10px rgba(52,211,153,0.07)',
        'card':          '0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)',
        'card-sm':       '0 2px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)',
      },
    },
  },
  plugins: [],
};
