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
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
      { cwd: backendDir, stdio: 'pipe', shell: process.platform === 'win32' },
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
