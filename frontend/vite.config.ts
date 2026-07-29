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
  build: {
    /**
     * Emit `dist/.vite/manifest.json` so the route-weight gate can be answered by the bundler
     * rather than by a regex over minified output (P3-3, `platform-gates.mjs --assets`).
     *
     * The gate has to know which chunks a browser downloads *for one route group* — that is the
     * transitive closure of static imports from the entry plus the group's own dynamic chunk, and
     * `dist/` alone does not record which edges are static and which are `import()`. Scraping the
     * built files for it would make the budget depend on how the minifier spelled the import that
     * week, which is precisely the kind of gate that goes quietly wrong rather than red.
     *
     * `.vite/` is added to `.assetsignore` by `backend/scripts/build-frontend.mjs`, so this is a
     * build artifact and is never uploaded or served.
     */
    manifest: true,
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
     * 15 s, not Vitest's 5 s (P3-3).
     *
     * `src/routes/router.test.tsx` renders the real route table, so its `import()`s make one worker
     * transform three whole route groups — Framer Motion, Zod and nine pages — while the rest of
     * the suite runs beside it. On a busy machine that starves the userEvent-heavy tests: the first
     * full run after this change timed out four tests, **three of them in files this change does
     * not touch** (`RosterBuilder`, `AssessmentFormDialog`, `QuestionWorkspace`), and all four
     * passed on a re-run and on a run with `node_modules/.vite` deleted.
     *
     * Raised rather than left to chance because CI is two cores and always cold, and a suite that
     * is green here and red there teaches people to re-run it rather than read it. It is a budget
     * for the *runner*, not a weakened assertion: a genuinely hung test still fails, ten seconds
     * later than it used to.
     */
    testTimeout: 15_000,
    hookTimeout: 15_000,
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
