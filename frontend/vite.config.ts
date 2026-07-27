import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    css: true,
    /**
     * Load `mammoth`'s **browser** build, which is what the app gets and what `extractText` is
     * written against.
     *
     * mammoth's `browser` field swaps `lib/unzip.js` (Node `fs`; accepts only a path or a Buffer)
     * for `browser/unzip.js` (accepts an `arrayBuffer`) — and `extractText` passes an
     * `arrayBuffer`. Vitest resolves `node_modules` with Node conditions, so without this every
     * DOCX test fails with mammoth's "Could not find file in options" while the real browser is
     * perfectly fine. A test environment that fails for a reason the product does not have is
     * worse than no test: it trains you to distrust the suite.
     */
    alias: {
      mammoth: 'mammoth/mammoth.browser.js',
    },
  },
});
