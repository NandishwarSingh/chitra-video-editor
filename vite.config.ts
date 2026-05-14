import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api/* is proxied to the Rust backend so the browser sees a
// same-origin URL and no CORS preflight is needed. In production, put the
// frontend behind a reverse proxy that maps /api to the same backend.
const BACKEND_URL = process.env.CHITRA_BACKEND_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        // SSE / WebSocket support — required for the chat stream.
        ws: true,
        // Transcribing a real clip can take minutes on CPU. Vite's default
        // proxy timeout (30 s) returns 502 long before whisper.cpp finishes;
        // raise both timeouts to 10 min so any reasonable transcription job
        // completes through the proxy.
        timeout: 10 * 60 * 1000,
        proxyTimeout: 10 * 60 * 1000,
      },
    },
  },
});
