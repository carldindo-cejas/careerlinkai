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
 *
 * Usage:  node scripts/platform-gates.mjs           # config + source gates (fast, offline)
 *         node scripts/platform-gates.mjs --bundle  # additionally build and weigh the bundle
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

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

// --- Verdict -------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} platform gate(s) failed.`);
  process.exit(1);
}

console.log('\nAll platform gates passed.');
