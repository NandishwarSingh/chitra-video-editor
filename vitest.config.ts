import { defineConfig } from 'vitest/config';

// Confine vitest discovery to our own source tree. Without this it walks
// every node_modules-free directory and picks up specs from sibling clones
// (e.g. a local whisper.cpp checkout used for model downloads).
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'backend/**', 'whisper.cpp/**'],
  },
});
