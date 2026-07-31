import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
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
  /**
   * Two projects, because one of these files needs a browser and the other 22 do not.
   *
   * ── Why `extractText.test.ts` is not in jsdom ────────────────────────────────────────────────
   *
   * It was, and **it hung in CI on every run the repository has ever had.** The two PDF cases
   * timed out at Vitest's default 5 s, then went on timing out at the 15 s below when P3-3 raised
   * it — tripling the budget changed nothing, which is what says this was a hang and not a slow
   * machine. They passed locally the whole time, so the suite was reported green in this plan
   * eleven times while the gate that was supposed to prove it was red.
   *
   * The cause is structural rather than incidental. `pdfjs-dist` disables the real `Worker`
   * whenever `isNodeJS` is true — a static block in `build/pdf.mjs` — and under Vitest it always
   * is. So the jsdom run never exercised pdf.js's real worker path at all: it took the *fake
   * worker* path, which does a raw `@vite-ignore` `import()` of a `file://` URL at the 1.25 MB
   * `pdf.worker.min.mjs`, outside Vitest's module pipeline entirely. pdf.js prints the diagnosis
   * into the log itself — "Please use the `legacy` build in Node.js environments".
   *
   * The exact failure inside CI's Linux/Node 22 was never reproduced, and this does not pretend
   * to have found it. It deletes the code path instead: in a real browser `Worker` exists, the
   * fake worker cannot run, and the test exercises what the app actually ships.
   *
   * **It is the more faithful test, not the more convenient one.** Running it in jsdom cost a
   * hand-written `DOMMatrix`, `Uint8Array.toHex`/`fromHex` polyfills, a `vi.mock` re-pointing the
   * worker URL at a filesystem path, and a `mammoth` browser-build alias — four patches whose only
   * purpose was to fake a browser for a browser library. All four are gone. `setupTests.ts` said
   * the exit out loud: "If a test ever needs real geometry, that test needs a real browser."
   */
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          globals: true,
          environment: 'jsdom',
          setupFiles: ['./src/setupTests.ts'],
          css: true,
          exclude: ['**/node_modules/**', '**/extractText.test.ts'],
          /**
           * 15 s, not Vitest's 5 s (P3-3).
           *
           * `src/routes/router.test.tsx` renders the real route table, so its `import()`s make one
           * worker transform three whole route groups — Framer Motion, Zod and nine pages — while
           * the rest of the suite runs beside it. On a busy machine that starves the
           * userEvent-heavy tests: the first full run after this change timed out four tests,
           * **three of them in files this change does not touch** (`RosterBuilder`,
           * `AssessmentFormDialog`, `QuestionWorkspace`), and all four passed on a re-run and on a
           * run with `node_modules/.vite` deleted.
           *
           * Raised rather than left to chance because CI is two cores and always cold, and a suite
           * that is green here and red there teaches people to re-run it rather than read it. It is
           * a budget for the *runner*, not a weakened assertion: a genuinely hung test still fails,
           * ten seconds later than it used to.
           *
           * It is deliberately **not** inherited by the browser project below.
           */
          testTimeout: 15_000,
          hookTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          globals: true,
          include: ['src/features/admin/utils/extractText.test.ts'],
          /**
           * No `setupFiles`. That file exists to patch jsdom into looking like a browser, and this
           * project has one — importing it here would re-install polyfills over the real APIs and
           * quietly make the test less honest than the environment it now runs in.
           *
           * The default 5 s timeout stands: pdf.js parsing a hand-built two-line PDF in real
           * Chrome is fast, and inheriting the 15 s above would hide the regression that budget
           * was raised to survive.
           */
          browser: {
            enabled: true,
            headless: true,
            /**
             * System Chrome, not a downloaded Chromium — the same choice `scripts/csp-check.mjs`
             * makes and for the same stated reason: nothing to download, and the browser under
             * test is the one on the machine. GitHub's `ubuntu-latest` image ships Chrome.
             */
            provider: playwright({ launchOptions: { channel: 'chrome' } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
