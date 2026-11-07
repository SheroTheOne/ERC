import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Samma origin i utveckling som i produktion: webbläsaren pratar bara med Vite (ADR-0008).
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    sourcemap: true,
  },
});
