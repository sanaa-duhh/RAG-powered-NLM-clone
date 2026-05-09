import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // In dev the browser hits VITE_API_BASE_URL directly (set to http://localhost:3001).
  // No proxy needed — the axios client uses the full URL from the env var.
});
