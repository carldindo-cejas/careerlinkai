/**
 * The frontend half of a single-Worker deploy.
 *
 * `wrangler.toml`'s `[build] command` points here, so `wrangler deploy` — with no other
 * arguments, which is the stated deployment contract — builds `../frontend` into
 * `frontend/dist` before Wrangler bundles the Worker and uploads the assets that
 * `[assets] directory` points at.
 *
 * Why a script rather than `command = "npm --prefix ../frontend run build"`:
 *
 *   1. **The bundle gate must not build the frontend.** `npm run gate:bundle` runs
 *      `wrangler deploy --dry-run`, which executes `[build]` like any other deploy. In CI that
 *      job installs backend dependencies only, so a bare npm command there fails on a missing
 *      `frontend/node_modules` — a green pipeline turning red for a reason that has nothing to
 *      do with what the gate measures. `SKIP_FRONTEND_BUILD=1` opts out (see below).
 *   2. **A missing `dist/` should say so in one line.** Wrangler's error for an absent assets
 *      directory does not mention the frontend at all.
 *
 * There is deliberately **no per-environment build**. Since the consolidation the frontend
 * calls the relative path `/api/v1` and is same-origin with its API in every environment, so
 * one artifact is correct for local, staging and production alike — the `--mode staging` build
 * that existed to bake in a different `VITE_API_BASE_URL` has no remaining purpose.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const backendDir = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const frontendDir = join(backendDir, '..', 'frontend');
const distDir = join(frontendDir, 'dist');

/**
 * Ensure-only mode: create `dist/` if absent and build nothing.
 *
 * Wrangler resolves `[assets] directory` for *any* command that reads the config — including
 * `wrangler deploy --dry-run` and `wrangler dev` — and errors if the path does not exist. On a
 * clean checkout it does not, because `dist/` is gitignored. Two callers need the config to load
 * without paying for a Vite build:
 *
 *   • `npm run gate:bundle` — a dry run uploads no asset, so the contents are irrelevant to what
 *     it measures (the gzipped Worker script). It passes SKIP_FRONTEND_BUILD=1 through Wrangler,
 *     which is the only channel available: `[build] command` takes no arguments from the caller.
 *   • `npm run dev` — the offline API loop, where the frontend is served by Vite on :5173 with a
 *     proxy, so the Worker's own copy is unused. `npm run preview` is the script that wants a
 *     real one.
 *
 * The env var and the flag are the same switch reached two ways: the flag because inline
 * `VAR=1 cmd` is not valid syntax in the cmd.exe shell npm uses on Windows, the env var because
 * the Wrangler-invoked path cannot take a flag.
 */
if (process.env.SKIP_FRONTEND_BUILD === '1' || process.argv.includes('--ensure-only')) {
  mkdirSync(distDir, { recursive: true });
  console.log('[build-frontend] ensure-only — dist/ exists, no build run.');
  process.exit(0);
}

if (!existsSync(join(frontendDir, 'node_modules'))) {
  console.error(
    '[build-frontend] frontend/node_modules is missing.\n' +
      '                 Run `npm ci` in ../frontend before deploying.',
  );
  process.exit(1);
}

console.log('[build-frontend] Building the React app (vite build)…');

execFileSync('npm', ['run', 'build'], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const indexHtml = join(distDir, 'index.html');

if (!existsSync(indexHtml)) {
  console.error(
    `[build-frontend] The build reported success but ${indexHtml} does not exist.\n` +
      '                 Deploying now would ship a Worker whose SPA fallback has no page to fall back to.',
  );
  process.exit(1);
}

/**
 * `.assetsignore` keeps deploy-time junk out of the asset store. Written here rather than
 * committed because it belongs to `dist/`, which is a build artifact and gitignored.
 *
 * `_redirects` and `_headers` are Cloudflare's own control files: `_headers` is *consumed* by
 * the asset router (it is what sets the immutable cache policy on hashed chunks) and must not be
 * ignored, but source maps are dead weight — they are uploaded, counted, and served to nobody.
 *
 * `.vite/` holds the build manifest that `platform-gates.mjs --assets` reads to weigh each route
 * group (P3-3). Nothing at runtime asks for it: the app is a plain SPA whose entry is named in
 * `index.html`, so the manifest is for the build's own tooling and stays out of the asset store.
 */
writeFileSync(
  join(distDir, '.assetsignore'),
  ['*.map', '.assetsignore', '.vite/', ''].join('\n'),
  'utf8',
);

console.log('[build-frontend] Done.');
