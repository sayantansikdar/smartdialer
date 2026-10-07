import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying `/api` to the backend means the dashboard makes same-origin requests in
    // development. That avoids CORS entirely and — more importantly — means the SSE stream
    // is a plain same-origin EventSource, with no preflight to get wrong.
    //
    // Overridable so the end-to-end run (scripts/e2e.mjs) can point a second dashboard at its
    // own isolated API instead of the developer's.
    proxy: {
      '/api': {
        target: process.env['API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
