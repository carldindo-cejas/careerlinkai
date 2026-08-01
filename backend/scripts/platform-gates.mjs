/**
 * Platform gates (FULLPLAN §57 Phase 4.5 Step 2) — assert the Miniflare-blind limits before
 * a deploy can find them.
 *
 * Three separate bugs in this project shipped past a green 371-test suite because Miniflare
 * is not Cloudflare: the PBKDF2 per-call cap, the free Worker's unraisable CPU limit, and
 * D1's 100-bound-parameter ceiling. Each was found on a staging deploy. This script asserts
 * the *next* members of that class statically, on every push, with no Cloudflare account:
 *
 *   1. **Config shape.** No `[limits]` block anywhere (a Free-plan deploy rejects it, error
 *      100328), and every `[env.*]` block carries the full binding set including `AUTH_DO` —
 *      Wrangler environments inherit no bindings, so a missing one is a runtime `undefined`,
 *      not a deploy error.
 *   2. **The DO boundary.** `crypto.subtle.deriveBits` is called nowhere in `src/` outside
 *      `src/do/auth-guard.ts`. A derivation that creeps back into Worker-side code compiles,
 *      passes every test, and dies with error 1102 on the edge — that is exactly how D14
 *      happened.
 *   3. **Bundle size** (`--bundle`, slower — runs `wrangler deploy --dry-run`): the gzipped
 *      Worker must stay under 2.5 MB against the Free plan's 3 MB cap. The margin is the
 *      point: the gate should fire on the dependency that *approaches* the cliff, not the
 *      one that falls off it.
 *   4. **Shipped asset weight** (`--assets`, audit P1 / plan P1-3): needs a real
 *      `frontend/dist`, so it runs in the frontend CI job rather than this one. See the gate
 *      itself for why `--bundle` cannot cover it.
 *   5. **Route weight** (`--assets`, audit P2 / plan P3-3): what one *route* costs, which is not
 *      what any per-file budget measures. Reads the Vite manifest, so the answer comes from the
 *      bundler's own record of which edges are static and which are `import()`.
 *
 * Usage:  node scripts/platform-gates.mjs           # config + source gates (fast, offline)
 *         node scripts/platform-gates.mjs --bundle  # additionally build and weigh the bundle
 *         node scripts/platform-gates.mjs --assets  # additionally weigh frontend/dist
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

import { analyzeRoutes, ROUTE_GROUPS } from './lib/route-weight.mjs';

const backendDir = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const failures = [];

function gate(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}\n      ${detail}`);
    failures.push(name);
  }
}

// --- Gate 1: config shape ---------------------------------------------------------------

const wranglerToml = readFileSync(join(backendDir, 'wrangler.toml'), 'utf8');
const wranglerTestToml = readFileSync(join(backendDir, 'wrangler.test.toml'), 'utf8');

console.log('\nConfig gates (wrangler.toml, wrangler.test.toml):');

// An UNCOMMENTED [limits] block. The Free plan rejects it at deploy time (code 100328), so
// finding it here is strictly earlier than finding it in a failed deploy.
for (const [file, content] of [
  ['wrangler.toml', wranglerToml],
  ['wrangler.test.toml', wranglerTestToml],
]) {
  gate(
    `${file}: no [limits] block (Free plan rejects it, code 100328)`,
    !/^\s*\[limits\]/m.test(content),
    'Remove the [limits] block — CPU-heavy work belongs in AuthGuardDO, not a raised Worker limit.',
  );
}

// Every environment block must carry the full binding set. Environments inherit nothing:
// an omitted binding deploys fine and is `undefined` at runtime, which is the worst of the
// possible failure shapes.
const REQUIRED_SECTIONS = {
  '': [
    ['[[d1_databases]]', /^\[\[d1_databases\]\]/m],
    ['[[r2_buckets]]', /^\[\[r2_buckets\]\]/m],
    ['[[vectorize]]', /^\[\[vectorize\]\]/m],
    ['[ai]', /^\[ai\]/m],
    ['[[kv_namespaces]]', /^\[\[kv_namespaces\]\]/m],
    ['[[durable_objects.bindings]]', /^\[\[durable_objects\.bindings\]\]/m],
    ['two [[queues.producers]]', /^\[\[queues\.producers\]\]/m],
  ],
  staging: null, // filled below
  production: null,
};

for (const envName of ['staging', 'production']) {
  REQUIRED_SECTIONS[envName] = [
    [`[[env.${envName}.d1_databases]]`, new RegExp(`^\\[\\[env\\.${envName}\\.d1_databases\\]\\]`, 'm')],
    [`[[env.${envName}.r2_buckets]]`, new RegExp(`^\\[\\[env\\.${envName}\\.r2_buckets\\]\\]`, 'm')],
    [`[[env.${envName}.vectorize]]`, new RegExp(`^\\[\\[env\\.${envName}\\.vectorize\\]\\]`, 'm')],
    [`[env.${envName}.ai]`, new RegExp(`^\\[env\\.${envName}\\.ai\\]`, 'm')],
    [`[[env.${envName}.kv_namespaces]]`, new RegExp(`^\\[\\[env\\.${envName}\\.kv_namespaces\\]\\]`, 'm')],
    [
      `[[env.${envName}.durable_objects.bindings]]`,
      new RegExp(`^\\[\\[env\\.${envName}\\.durable_objects\\.bindings\\]\\]`, 'm'),
    ],
    [`[[env.${envName}.queues.producers]]`, new RegExp(`^\\[\\[env\\.${envName}\\.queues\\.producers\\]\\]`, 'm')],
  ];
}

for (const [scope, sections] of Object.entries(REQUIRED_SECTIONS)) {
  for (const [label, pattern] of sections) {
    gate(
      `wrangler.toml ${scope || 'top level'}: ${label} present`,
      pattern.test(wranglerToml),
      'Environments inherit no bindings — a missing one is a runtime undefined, not a deploy error.',
    );
  }
}

// AUTH_DO by name, in all three scopes plus the test config — the binding the whole §38
// security model now stands on.
const authDoCount = (wranglerToml.match(/name = "AUTH_DO"/g) ?? []).length;
gate(
  'wrangler.toml: AUTH_DO bound at top level and in both environments',
  authDoCount >= 3,
  `Found ${authDoCount} AUTH_DO binding(s); expected 3 (top level, staging, production).`,
);
gate(
  'wrangler.test.toml: AUTH_DO bound (auth tests cross the real DO boundary)',
  /name = "AUTH_DO"/.test(wranglerTestToml),
  'Add the [[durable_objects.bindings]] block to wrangler.test.toml.',
);

/**
 * P4-2 — **the most important gate in this file, because it is the only one guarding a secret.**
 *
 * `RESEND_API_KEY` is the one credential in the system (see wrangler.toml's [vars] note). A `[vars]`
 * block is committed to git and printed in full by `wrangler deploy`, so a key that lands there is
 * disclosed the moment it is pushed — and it would *work*, which is what makes it survivable long
 * enough to reach a public repository. Nothing else in the build would object.
 *
 * Matched across every wrangler config, not just the deployed ones: a key pasted into the test or
 * dev config leaks exactly as hard.
 */
const EVERY_WRANGLER_CONFIG = ['wrangler.toml', 'wrangler.test.toml', 'wrangler.local.toml', 'wrangler.dev.toml'].map(
  (file) => [file, readFileSync(join(backendDir, file), 'utf8')],
);

for (const [file, content] of EVERY_WRANGLER_CONFIG) {
  gate(
    `${file}: RESEND_API_KEY is not committed as a var`,
    !/^\s*RESEND_API_KEY\s*=/m.test(content),
    'It is a secret: `wrangler secret put RESEND_API_KEY --env <env>`, never a [vars] entry.',
  );
}

// Note there is deliberately no *second* gate spelling "and the test config must not mention it at
// all". One was written, and it failed on the comment in wrangler.test.toml that documents this
// rule — an unanchored substring match cannot tell a committed secret from a sentence about
// committed secrets. The anchored assignment check above already covers every config including the
// test one, which is the property that actually matters.

// EMAIL_FROM is a string var, so it sits outside REQUIRED_NUMERIC_VARS below — but it fails the
// same way a missing numeric one does: the send would go out `from: undefined`, be refused by
// Resend, and do it in an environment that deployed cleanly.
const emailFromCount = (wranglerToml.match(/^EMAIL_FROM = "[^"]+"/gm) ?? []).length;
gate(
  'wrangler.toml: EMAIL_FROM set in all three scopes',
  emailFromCount >= 3,
  `Found ${emailFromCount} EMAIL_FROM var(s); expected 3 (top level, staging, production).`,
);

for (const [file, content] of [
  ['wrangler.toml', wranglerToml],
  ['wrangler.test.toml', wranglerTestToml],
]) {
  gate(
    `${file}: AuthGuardDO declared in [[migrations]] as new_sqlite_classes`,
    /new_sqlite_classes = \["AuthGuardDO"\]/.test(content),
    'SQLite-backed classes are the only kind the Free plan allows.',
  );
}

// The hermeticity that keeps CI offline: the test config must NOT bind AI or Vectorize —
// they have no local emulation and dial out to Cloudflare before a single assertion runs.
gate(
  'wrangler.test.toml: no [ai] or [[vectorize]] binding (the suite must run offline)',
  !/^\[ai\]/m.test(wranglerTestToml) && !/^\[\[vectorize\]\]/m.test(wranglerTestToml),
  'Test the AI/RAG pipelines against a stubbed gateway, never a live binding.',
);

/**
 * **Every numeric `[vars]` entry `lib/config.ts` requires, in every scope** (plan P3-4).
 *
 * `requireNumber` throws on a missing or unparseable var rather than falling back to a silent
 * default, which is the right call and also raises the stakes: `API_RATE_LIMIT_PER_MINUTE` is read
 * inside `authenticate()`, so an environment that omits it does not degrade — **every
 * authenticated request in that environment 500s**. Wrangler environments inherit no vars, and a
 * `[vars]` block is exactly the sort of thing that gets copied for a new environment and edited
 * incompletely. Cheaper to fail here than at 8 a.m. on a Monday.
 */
const REQUIRED_NUMERIC_VARS = [
  'STUDENT_JOIN_CODE_TTL_DAYS',
  'STUDENT_TOKEN_TTL_HOURS',
  'STAFF_TOKEN_TTL_HOURS',
  'ASSESSMENT_GENERATION_MAX_QUESTIONS',
  'API_RATE_LIMIT_PER_MINUTE',
];

for (const name of REQUIRED_NUMERIC_VARS) {
  // Three scopes in wrangler.toml (top level, staging, production) — the same count the
  // AUTH_DO gate asserts, and for the same inheritance reason.
  const declared = (wranglerToml.match(new RegExp(`^${name} = "\\d+"`, 'gm')) ?? []).length;

  gate(
    `wrangler.toml: ${name} declared as a number in all three scopes`,
    declared >= 3,
    `Found ${declared} declaration(s); expected 3. lib/config.ts throws on a missing numeric var — for API_RATE_LIMIT_PER_MINUTE that means every authenticated request in that environment answers 500.`,
  );

  gate(
    `wrangler.test.toml: ${name} declared (the suite boots the same config code)`,
    new RegExp(`^${name} = "\\d+"`, 'm').test(wranglerTestToml),
    `Add ${name} to wrangler.test.toml's [vars].`,
  );
}

// The Phase H operational surfaces (audit H1 / M11 / observability). Each is a config-only
// capability a deploy ships fine without — so a missing one is exactly the silent kind of gap
// these gates exist to catch: a dropped dead-lettered job, unpersisted logs, no housekeeping.
const dlqCount = (wranglerToml.match(/dead_letter_queue = /g) ?? []).length;
gate(
  'wrangler.toml: every source queue consumer has a dead_letter_queue (H1)',
  dlqCount >= 6,
  `Found ${dlqCount} dead_letter_queue line(s); expected 6 (default+ai across top level, staging, production).`,
);

const observabilityCount = (wranglerToml.match(/^enabled = true$/gm) ?? []).length;
gate(
  'wrangler.toml: [observability] enabled in all three scopes',
  observabilityCount >= 3,
  `Found ${observabilityCount} "enabled = true"; expected 3 [observability] blocks (top level, staging, production).`,
);

const cronCount = (wranglerToml.match(/^crons = /gm) ?? []).length;
gate(
  'wrangler.toml: a Cron Trigger is declared in all three scopes (M11 nightly cleanup)',
  cronCount >= 3,
  'Add [triggers] crons = ["0 3 * * *"] per scope, plus the scheduled handler in src/index.ts.',
);

/**
 * **Producer/consumer parity in every profile that runs a live Worker.**
 *
 * This gate exists because of a real, shipped, user-visible outage rather than as a hygiene rule.
 * A `[[queues.producers]]` entry with no matching `[[queues.consumers]]` is not a configuration
 * error at any layer that reports errors: `wrangler dev` boots, `QUEUE_AI.send()` resolves
 * successfully, and the message is simply never delivered to anyone. Nothing throws and nothing
 * logs. The §31 AI generation flow ran on that config for an entire phase — every request
 * accepted, every job discarded, the status poll answering PENDING forever — because `npm run dev`
 * booted `wrangler.test.toml`, which is producer-only by design.
 *
 * `wrangler.test.toml` is exempt, and only it: the Vitest pool delivers no queue messages at all,
 * so its tests invoke `worker.queue(batch, env)` directly and a consumer block there would
 * describe a loop that never runs.
 */
function queueNames(content, kind) {
  const names = [];
  let inBlock = false;

  for (const line of content.split(/\r?\n/)) {
    const header = /^\s*\[\[(?:env\.[a-z]+\.)?queues\.(producers|consumers)\]\]/.exec(line);

    if (header !== null) {
      inBlock = header[1] === kind;
      continue;
    }

    if (/^\s*\[/.test(line)) {
      inBlock = false;
      continue;
    }

    const queue = /^\s*queue\s*=\s*"([^"]+)"/.exec(line);

    if (inBlock && queue !== null) {
      names.push(queue[1]);
    }
  }

  return names;
}

for (const file of ['wrangler.toml', 'wrangler.local.toml', 'wrangler.dev.toml']) {
  const content = readFileSync(join(backendDir, file), 'utf8');
  const produced = new Set(queueNames(content, 'producers'));
  const consumed = new Set(queueNames(content, 'consumers'));
  const orphaned = [...produced].filter((queue) => !consumed.has(queue));

  gate(
    `${file}: every produced queue has a consumer (a producer-only queue silently drops jobs)`,
    produced.size > 0 && orphaned.length === 0,
    produced.size === 0
      ? 'No [[queues.producers]] found — has this profile lost its queue bindings?'
      : `No [[queues.consumers]] for: ${orphaned.join(', ')}. send() will resolve and the message will never be delivered; a queued job's status poll then hangs forever.`,
  );
}

/**
 * **Single-Worker routing: the SPA fallback must not shadow the API.**
 *
 * `not_found_handling = "single-page-application"` is evaluated by the asset router *before* the
 * Worker script is invoked. On its own that means a request to /api/v1/health returns
 * `index.html` with a 200 — the API is unreachable from the address bar, from curl, and from any
 * health check, while client-side `fetch()` from the loaded app keeps working. That last part is
 * what makes this worth a gate rather than a comment: the app looks completely fine, and the
 * first symptom is an uptime monitor that has been green on an HTML page for a week.
 *
 * `run_worker_first = ["/api/*"]` is the fix, and it has to be present in *every* profile that
 * declares assets — including `wrangler.local.toml`, or `npm run preview` proves the wrong thing.
 */
console.log('\nAsset routing gates (single-Worker deployment):');

const ASSET_PROFILES = [
  ['wrangler.toml', wranglerToml],
  ['wrangler.local.toml', readFileSync(join(backendDir, 'wrangler.local.toml'), 'utf8')],
  ['wrangler.dev.toml', readFileSync(join(backendDir, 'wrangler.dev.toml'), 'utf8')],
];

for (const [file, content] of ASSET_PROFILES) {
  // Every [assets] / [env.*.assets] block in the file, as its own chunk of lines.
  const blocks = [];
  let current = null;

  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[(?:env\.[a-z]+\.)?assets\]/.test(line)) {
      current = [];
      blocks.push(current);
      continue;
    }

    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }

    current?.push(line);
  }

  // wrangler.toml carries three scopes (top level, staging, production); the dev profiles one.
  const expected = file === 'wrangler.toml' ? 3 : 1;

  gate(
    `${file}: [assets] declared in all ${expected} scope(s)`,
    blocks.length >= expected,
    `Found ${blocks.length} [assets] block(s); expected ${expected}. Environments may not inherit it — a missing block deploys an API with no frontend.`,
  );

  for (const [index, block] of blocks.entries()) {
    const text = block.join('\n');
    const label = `${file} [assets] #${index + 1}`;

    gate(
      `${label}: directory points at the Vite build output`,
      /directory\s*=\s*"\.\.\/frontend\/dist"/.test(text),
      'Expected directory = "../frontend/dist" — the one build output every profile shares.',
    );

    gate(
      `${label}: not_found_handling = "single-page-application" (React Router owns /login, /student/*, …)`,
      /not_found_handling\s*=\s*"single-page-application"/.test(text),
      'Without it a hard refresh on any nested route 404s before the app ever boots.',
    );

    gate(
      `${label}: run_worker_first includes "/api/*" (else the SPA fallback swallows the API)`,
      /run_worker_first\s*=\s*\[[^\]]*"\/api\/\*"/.test(text),
      'not_found_handling runs BEFORE the Worker: without this pattern, GET /api/v1/health returns index.html with a 200 and every direct API hit is silently served the HTML shell.',
    );
  }
}

/**
 * The Pages SPA rule, which does *not* work here and does not announce it.
 *
 * `frontend/public/_redirects` held `/*  /index.html  200` for Cloudflare Pages. Workers static
 * assets read `_redirects` too but implement only true redirect statuses (301/302/303/307/308) —
 * a 200-status rewrite is ignored. Left in place it reads like the SPA fallback is configured
 * when the thing actually doing the work is `not_found_handling`, and the day someone "simplifies"
 * that setting away, the file will look like it has the situation covered.
 */
const redirectsPath = join(backendDir, '..', 'frontend', 'public', '_redirects');

gate(
  'frontend/public/_redirects is gone (a Pages-only rule that Workers assets silently ignore)',
  !existsSync(redirectsPath),
  'Delete it — SPA fallback is owned by [assets] not_found_handling. A 200-status rewrite in _redirects does nothing on Workers.',
);

gate(
  'frontend/public/_headers exists (hashed assets get immutable caching)',
  existsSync(join(backendDir, '..', 'frontend', 'public', '_headers')),
  'Without it every asset serves as max-age=0, must-revalidate — including the 5 MB of content-hashed JavaScript that never changes.',
);

// --- Gate 2: the DO boundary --------------------------------------------------------------

console.log('\nSource gates (src/):');

function walk(dir) {
  const files = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else if (entry.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

const srcDir = join(backendDir, 'src');
// A call site (`deriveBits(`) rather than the bare word, so prose in a comment that merely
// *mentions* the API does not trip the gate.
const offenders = walk(srcDir)
  .filter((file) => /deriveBits\s*\(/.test(readFileSync(file, 'utf8')))
  .map((file) => relative(backendDir, file).replaceAll('\\', '/'))
  .filter((file) => file !== 'src/do/auth-guard.ts');

gate(
  'deriveBits is called nowhere outside src/do/auth-guard.ts',
  offenders.length === 0,
  `Derivation found in: ${offenders.join(', ')} — a Worker-side derivation passes every local test and dies with error 1102 on the edge (D14).`,
);

// --- Gate 3: bundle size (--bundle only) ---------------------------------------------------

if (process.argv.includes('--bundle')) {
  console.log('\nBundle gate (wrangler deploy --dry-run):');

  const outDir = join(backendDir, '.bundle-gate');

  try {
    execFileSync(
      'npx',
      ['wrangler', 'deploy', '--dry-run', `--outdir=${outDir}`],
      {
        cwd: backendDir,
        stdio: 'pipe',
        shell: process.platform === 'win32',
        // `[build] command` in wrangler.toml builds the React app before every deploy, and a dry
        // run is a deploy as far as that hook is concerned. This gate weighs the **Worker script**
        // — static assets are stored separately and count against no bundle limit — so the build
        // is pure cost here, and in CI it would fail outright: the backend job installs backend
        // dependencies only. See scripts/build-frontend.mjs.
        env: { ...process.env, SKIP_FRONTEND_BUILD: '1' },
      },
    );

    let gzippedBytes = 0;

    for (const file of walkJs(outDir)) {
      gzippedBytes += gzipSync(readFileSync(file)).length;
    }

    const limit = 2.5 * 1024 * 1024;

    gate(
      `gzipped bundle ${(gzippedBytes / 1024).toFixed(0)} KiB ≤ 2560 KiB (Free cap: 3 MB)`,
      gzippedBytes > 0 && gzippedBytes <= limit,
      'The Free plan caps the gzipped Worker at 3 MB. A server-side PDF parser is the classic way to blow it — extraction belongs in the browser (§33).',
    );
  } catch (error) {
    gate('wrangler deploy --dry-run succeeds', false, String(error.stderr ?? error.message));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function walkJs(dir) {
  const files = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      files.push(...walkJs(path));
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      files.push(path);
    }
  }

  return files;
}

// --- Gate 4: shipped asset weight (--assets only) ------------------------------------------

/**
 * **The guard audit finding P1 shipped without.**
 *
 * A 3.26 MB master PNG was the login screen's logo for the whole of the project's life, and
 * nothing anywhere measured it. Gate 3 above cannot: it weighs the **Worker script**, and
 * Cloudflare stores static assets separately, against no bundle limit at all. So the one number
 * CI reported was the one number the defect could not move. It was found by looking at a build
 * log by hand — which is not a gate, it is a habit, and habits do not survive a deadline.
 *
 * Three budgets, because the failure has three shapes:
 *
 *   a. **One heavy media file** (≤ 600 KiB). The literal P1 shape — someone imports
 *      `logo-master.png` instead of `logo-256.png` and the login screen quietly costs 4 MB again.
 *   b. **Total media weight** (≤ 1.5 MiB). Ten 300 KiB images pass (a) individually and are the
 *      same problem; a per-file cap alone would wave them through.
 *   c. **One heavy script chunk** (≤ 1000 KiB). See the note on the number below.
 *
 * **This walks all of `dist/`, not just `dist/assets/`.** Files in `frontend/public/` are copied
 * to the root of `dist` verbatim and unhashed (`logo.png` is there today), so a master asset
 * dropped in `public/` ships exactly the same bytes to exactly the same browsers while evading a
 * gate that looks only at `assets/`. Two ways in, one gate.
 *
 * Source maps are excluded: `.assetsignore` keeps them out of the upload, so they cost a student
 * nothing. This gate measures what is *served*.
 */
if (process.argv.includes('--assets')) {
  console.log('\nAsset weight gate (frontend/dist):');

  const distDir = join(backendDir, '..', 'frontend', 'dist');

  // `scripts/build-frontend.mjs --ensure-only` creates an empty `dist/` so Wrangler's config can
  // load without a Vite build. Weighing that would report a comfortable pass on nothing at all —
  // the most dangerous result a size gate can produce.
  if (!existsSync(join(distDir, 'index.html'))) {
    gate(
      'frontend/dist holds a real build',
      false,
      `No index.html under ${distDir}. Run \`npm run build\` in ../frontend first — an empty or ensure-only dist/ would pass every budget below while measuring nothing.`,
    );
  } else {
    // Anything that is not code and not a Cloudflare control file is media: images, fonts,
    // video, audio. Extension-allowlisting the *code* side (rather than listing image formats)
    // means a format nobody thought of — .avif, .heic, a stray .mp4 — is measured by default.
    const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.wasm'];
    // `.vite/manifest.json` is the build's own record, read by the route-weight gate below and
    // kept out of the upload by `.assetsignore` — measuring it would weigh a file no browser gets.
    const IGNORED = [
      '.map',
      '.assetsignore',
      '_headers',
      '_redirects',
      '.DS_Store',
      '.vite/manifest.json',
    ];

    /** The pdfjs worker: a vendor artifact, fetched only by the one screen that parses a PDF. */
    const CHUNK_EXEMPT = /(^|[\\/])pdf\.worker\./;

    const MEDIA_FILE_LIMIT = 600 * 1024;
    const MEDIA_TOTAL_LIMIT = 1536 * 1024;
    const CHUNK_LIMIT = 550 * 1024;

    const shipped = [];

    for (const path of walkAll(distDir)) {
      const name = relative(distDir, path).replaceAll('\\', '/');

      if (IGNORED.some((suffix) => name.endsWith(suffix))) {
        continue;
      }

      shipped.push({
        name,
        bytes: statSync(path).size,
        isCode: CODE_EXTENSIONS.some((extension) => name.endsWith(extension)),
      });
    }

    const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;
    const media = shipped.filter((file) => !file.isCode);
    const chunks = shipped.filter((file) => file.isCode && !CHUNK_EXEMPT.test(file.name));

    const heavyMedia = media.filter((file) => file.bytes > MEDIA_FILE_LIMIT);
    const heaviestMedia = Math.max(0, ...media.map((file) => file.bytes));

    gate(
      `no media file over ${kib(MEDIA_FILE_LIMIT)} (heaviest: ${kib(heaviestMedia)})`,
      heavyMedia.length === 0,
      `${heavyMedia.map((file) => `${file.name} = ${kib(file.bytes)}`).join(', ')} — this is audit P1 recurring. Export a sized derivative (the logo is 14 kB at 256 px; the hero plate is 66 kB as WebP) and import that, not the master.`,
    );

    const mediaTotal = media.reduce((sum, file) => sum + file.bytes, 0);

    gate(
      `total media weight ${kib(mediaTotal)} ≤ ${kib(MEDIA_TOTAL_LIMIT)} (${media.length} files)`,
      mediaTotal <= MEDIA_TOTAL_LIMIT,
      'Ten images just under the per-file cap are the same defect as one over it. Optimize, or drop what nothing renders — Phase 0 found two assets no import referenced at all.',
    );

    /**
     * **550 KiB — lowered from 1000 KiB by P3-3, which is what the ratchet was waiting for.**
     *
     * It was 1000 KiB because `index-*.js` was 921 KiB: one chunk holding every admin, counselor
     * and student page (audit P2). That chunk is now 204 KiB, and the two heaviest things in
     * `dist/` are the lazy document parsers a student never fetches — mammoth (486 KiB) and
     * pdf.js (415 KiB), both behind the `import()` in `extractText.ts`. 550 KiB sits just above
     * mammoth, so the largest *route* chunk (admin, 112 KiB) now has four times its own size in
     * headroom while a vendor dependency that grows past the parsers still trips the gate.
     *
     * A per-file budget is still the wrong instrument for what P3-3 actually fixed — nothing here
     * would have fired on 921 KiB of route code split across seven 130 KiB chunks that every
     * visitor downloads anyway. That is what the route-weight gate below measures.
     */
    const heavyChunks = chunks.filter((file) => file.bytes > CHUNK_LIMIT);
    const heaviestChunk = Math.max(0, ...chunks.map((file) => file.bytes));

    gate(
      `no script/style chunk over ${kib(CHUNK_LIMIT)} (heaviest: ${kib(heaviestChunk)}; pdf.worker exempt)`,
      heavyChunks.length === 0,
      `${heavyChunks.map((file) => `${file.name} = ${kib(file.bytes)}`).join(', ')} — this is a ratchet set just above the lazy document parsers, so it firing means a vendor dependency grew past mammoth. Split it behind an import() rather than raising the number.`,
    );

    // --- Gate 5: route weight (plan P3-3, audit P2) -----------------------------------------
    weighRoutes(distDir, kib);
  }
}

/**
 * **What one route costs, which no per-file budget can see.**
 *
 * Audit P2 was a single 921 KiB chunk holding every admin, counselor and student page: a student
 * downloaded the assessment builder and the pdf.js integration in order to answer sixty questions.
 * Splitting it (P3-3) is only worth anything if the split *stays* split, and a code split does not
 * fail loudly — one stray static `import` from a file the entry already reaches folds a whole
 * group back into the first byte every visitor downloads, and the build, the type-check and all
 * 171 frontend tests stay green. This is the gate that notices.
 *
 * Two structural assertions and two budgets:
 *
 *   • every group in `ROUTE_GROUPS` is still a **dynamic** entry, and none of them is inside the
 *     entry chunk's static closure (the two shapes the split dies in);
 *   • the heaviest route's cold load, and the student screen's, stay under their ratchets.
 *
 * The budgets are raw bytes, matching the audit's own framing ("one 936 kB chunk"). Gzipped
 * transfer size is reported beside every row because that is what actually crosses the wire, but
 * it is not what is asserted — a dependency that compresses well is still parsed and executed at
 * full size on a mid-range Android phone, which is the device this is for.
 */
function weighRoutes(distDir, kib) {
  console.log('\nRoute weight gate (dist/.vite/manifest.json):');

  const manifestPath = join(distDir, '.vite', 'manifest.json');

  if (!existsSync(manifestPath)) {
    gate(
      'the build emitted .vite/manifest.json',
      false,
      `Not found at ${manifestPath}. \`build.manifest\` must stay true in frontend/vite.config.ts — without it there is no record of which import edges are static, and route weight cannot be measured at all.`,
    );

    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const gzipped = new Map();

  const sizeOf = (file) => {
    const path = join(distDir, file);

    if (!gzipped.has(file)) {
      gzipped.set(file, gzipSync(readFileSync(path)).length);
    }

    return statSync(path).size;
  };

  // Measured twice from one manifest walk: `sizeOf` reports the raw byte count the budgets are
  // written in and caches the gzipped length of the same file, so `analyzeRoutes` run a second
  // time over a gzip-reporting `sizeOf` returns the transfer sizes with no second traversal.
  const report = analyzeRoutes(manifest, sizeOf);
  const transfer = analyzeRoutes(manifest, (file) => gzipped.get(file) ?? 0);

  gate(
    `all ${ROUTE_GROUPS.length} route groups are split and none has folded back into the entry`,
    report.problems.length === 0,
    report.problems.join('; '),
  );

  if (report.entry === null) {
    return;
  }

  /**
   * **The floor, and the reason P3-3 could not reach the 350 KiB its own line asked for.**
   *
   * This is React, React DOM, React Router, TanStack Query, axios and Zustand — reached by
   * `main.tsx`, `providers.tsx` and `ProtectedRoute`, all of which must run *before* the app knows
   * which shell to fetch. No route split moves it, because every route needs all of it. Measured
   * separately so that the number is stated rather than hidden inside each route's total, and so
   * that a dependency added to the app shell is visible as what it is: a cost paid by every screen.
   */
  const ENTRY_BUDGET = 430 * 1024;
  const ROUTE_COLD_BUDGET = 700 * 1024;
  const STUDENT_SCREEN_BUDGET = 530 * 1024;

  /**
   * **`/join` is the only screen with a budget of its own, because it is the only screen a
   * student reaches before they have signed in to anything** — the link a counselor pastes into
   * a group chat, opened on a phone on school wifi, with nothing cached.
   *
   * 460 KiB against 433 KiB today. That is ~27 KiB of headroom on a two-field sign-in form: room
   * for the form to grow, and nowhere near enough to re-admit either of the two libraries P4-15
   * and P4-16 took off it (Framer Motion 121 KiB, Zod 61 KiB). One `import { z } from 'zod'` in
   * `StudentAccessPage.tsx` is a one-line change that builds, type-checks and passes all 195 tests
   * while putting 61 KiB back on the student's first screen — `heaviest route cold load` cannot
   * see it, since `/join` is nowhere near the heaviest route and never will be. That gap is
   * exactly the shape of P3-3's "the split dies quietly", and this is the instrument for it.
   */
  const JOIN_SCREEN_BUDGET = 460 * 1024;

  const rows = [
    ['entry (framework floor)', report.entry, transfer.entry],
    ...report.groups.map((group, index) => [
      `${group.name}  ${group.screen}`,
      group.cold,
      transfer.groups[index].cold,
    ]),
    ['student path (join + shell)', report.student, transfer.student],
  ];

  console.log(`      ${'route'.padEnd(34)} ${'raw'.padStart(9)} ${'gzip'.padStart(9)}   chunks`);

  for (const [label, raw, gzip] of rows) {
    console.log(
      `      ${label.padEnd(34)} ${kib(raw.total).padStart(9)} ${kib(gzip.total).padStart(9)}   ${raw.chunks}`,
    );
  }

  gate(
    `entry closure ${kib(report.entry.total)} ≤ ${kib(ENTRY_BUDGET)} — the cost every screen pays`,
    report.entry.total <= ENTRY_BUDGET,
    'Something new is being imported by main.tsx, providers.tsx or ProtectedRoute. Everything they reach is downloaded before the router can decide which shell to fetch, so it is charged to the landing page, the login screen and a student on a phone alike.',
  );

  const heaviest = report.groups.reduce((worst, group) =>
    group.cold.total > worst.cold.total ? group : worst,
  );

  gate(
    `heaviest route cold load ${kib(heaviest.cold.total)} ≤ ${kib(ROUTE_COLD_BUDGET)} (${heaviest.name})`,
    heaviest.cold.total <= ROUTE_COLD_BUDGET,
    `${heaviest.name} costs ${kib(heaviest.cold.total)} on a cold load. Move what only one screen needs behind its own import(), the way extractText.ts holds pdf.js and mammoth.`,
  );

  gate(
    `student screen cold load ${kib(report.studentScreen.total)} ≤ ${kib(STUDENT_SCREEN_BUDGET)} (audit P2)`,
    report.studentScreen.total <= STUDENT_SCREEN_BUDGET,
    `A student now pays ${kib(report.studentScreen.total)} to open a student screen. This is the number audit P2 is about — check what the student group has started importing.`,
  );

  // Not `join` — that is `node:path`'s, imported at the top of this file, and shadowing it here
  // puts the manifest read above into its temporal dead zone. Caught by running the gate.
  const joinScreen = report.groups.find((group) => group.name === 'access');

  gate(
    `join screen cold load ${kib(joinScreen?.cold.total ?? 0)} ≤ ${kib(JOIN_SCREEN_BUDGET)} (the student's first screen)`,
    joinScreen !== undefined && joinScreen.cold.total <= JOIN_SCREEN_BUDGET,
    joinScreen === undefined
      ? 'The "access" route group is gone from the manifest, so the join screen cannot be weighed at all.'
      : `/join now costs ${kib(joinScreen.cold.total)} cold. It is a class code and a username: check what StudentAccessPage or StudentAccessLayout has started importing. P4-15 and P4-16 took Framer Motion and Zod off this screen precisely because a library that is cheap on an admin page is not cheap here.`,
  );
}

function walkAll(dir) {
  const files = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      files.push(...walkAll(path));
    } else {
      files.push(path);
    }
  }

  return files;
}

// --- Verdict -------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} platform gate(s) failed.`);
  process.exit(1);
}

console.log('\nAll platform gates passed.');
