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
    /**
     * Same-origin in development, the way the deployment is same-origin in production.
     *
     * The app calls the relative path `/api/v1` everywhere (src/services/httpClient.ts). In a
     * deploy that lands on the Worker directly, because one Worker serves both halves; here Vite
     * forwards it to `wrangler dev` on :8787 instead. So the dev loop keeps HMR and still
     * exercises the exact request shape production does — relative URL, no `Origin` header, no
     * preflight, no CORS involved on either side.
     *
     * `/api` rather than `/api/v1`: the prefix is the API's boundary in the deployed Worker too
     * (`run_worker_first = ["/api/*"]` in wrangler.toml), and the two should describe the same
     * split. Everything else — `/login`, `/student/assessments`, the assets — is Vite's, matching
     * the asset-first routing the Worker applies to those same paths.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: false,
      },
    },
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
