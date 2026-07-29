/**
 * **The restore drill** (IMPLEMENTATION-PLAN P3-5) — prove a backup can be restored *and that the
 * application serves what comes back*, without touching anything live.
 *
 * ── Why the drill is a script and not a paragraph in a runbook ────────────────────────────────
 *
 * A restore procedure that has never been executed is a guess, and the guesses in this repo have
 * not held up: P1-2's CSP was reasoned and blocked the app's typeface on every screen; P2-2's
 * recommendation engine passed 807 tests and generated nothing for anybody on real D1. Both were
 * invisible until something ran them. A backup is the same class of claim — it looks correct in
 * the directory listing, and the first honest test of it is a day when you cannot afford a
 * surprise.
 *
 * Written re-runnably for the reason P1-2's `csp-check.mjs` was: a rehearsal performed once by
 * hand decays into a paragraph asserting it was performed once by hand.
 *
 * ── What it actually does ────────────────────────────────────────────────────────────────────
 *
 *   1. Restores a dump into a **throwaway Miniflare database** in a temp `--persist-to`
 *      directory. Not the local dev database: a drill that costs a developer their working data
 *      is a drill they run once.
 *   2. Reads the restored tables directly to pick a student who **had recommendations in the
 *      backup** — chosen from the data rather than hardcoded, so the drill keeps working as the
 *      source database changes.
 *   3. Boots the **real Worker** against that database and joins the class as that student over
 *      HTTP, through `/student-access/join` — the same passwordless path a student uses.
 *   4. `GET /student/recommendations`, and asserts the API returns the careers the backup holds,
 *      in the same order, with the same scores.
 *
 * Step 4 is the whole point, and it is a stronger claim than "the rows came back". Recommendation
 * rows reference `assessment_results`, `careers`, `programs`, `program_catalog` and `colleges`;
 * a restore that dropped a row on a foreign key, or restored the tables in an order that lost
 * one, produces a database whose `recommendations` count is perfect and whose API returns an
 * empty list. Only reading it back through the application distinguishes those.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/restore-drill.mjs --env staging                # back up staging, then drill it
 *   node scripts/restore-drill.mjs --from .backups/<file>.sql   # drill an existing dump
 *
 *   --port <n>          where the drill Worker listens          (default: 8798)
 *   --keep              leave the restored database on disk and print its path
 *
 * Offline after the export: the Worker runs on local Miniflare storage, so nothing in the drill
 * can write to staging or production even by accident.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { argReader, backendDir, d1Query, formatBytes, wranglerEntry } from './lib/d1.mjs';

const { flag, has } = argReader();

const env = flag('env');
const explicitDump = flag('from');
const port = Number(flag('port', 8798));
const keep = has('keep');

if (!env && !explicitDump) {
  console.error('error: pass --env <staging|production> to take a fresh backup and drill it,');
  console.error('       or --from <dump.sql> to drill a dump you already have.');
  process.exit(1);
}

const API = `http://127.0.0.1:${port}/api/v1`;

let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: backendDir,
    encoding: 'utf8',
    stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CI: 'true' },
  });
}

console.log(`\nRestore drill\n${'═'.repeat(72)}`);

// ── 1. The dump ──────────────────────────────────────────────────────────────────────────────

let dumpPath = explicitDump;

if (!dumpPath) {
  console.log(`\n▸ Backing up ${env} first, so the drill exercises the real backup path.\n`);
  run(process.execPath, ['scripts/d1-backup.mjs', '--env', env]);

  const dir = join(backendDir, '.backups');

  dumpPath = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => join(dir, e.f))[0];
}

if (!dumpPath || !existsSync(dumpPath)) {
  console.error(`\nerror: no dump to drill (${dumpPath ?? 'none found'}).`);
  process.exit(1);
}

console.log(`\n▸ Drilling ${basename(dumpPath)} (${formatBytes(statSync(dumpPath).size)})`);

// ── 2. Restore into a throwaway database ─────────────────────────────────────────────────────
// A fresh `--persist-to` directory is an empty database, so this exercises the real "restore
// into an empty target" path with no `--wipe` and no prompt — and leaves the developer's own
// local database untouched.

const persistTo = mkdtempSync(join(tmpdir(), 'careerlinkai-drill-'));
let worker = null;

function stopWorker() {
  if (!worker || worker.killed) return;

  // Wrangler spawns workerd as a child; killing only the wrangler process on Windows orphans it
  // and the port stays bound, which turns the next drill into a confusing "restored data is stale".
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  } else {
    try {
      process.kill(-worker.pid, 'SIGTERM');
    } catch {
      worker.kill('SIGTERM');
    }
  }
}

let removed = false;

function cleanup() {
  stopWorker();

  if (keep || removed) {
    if (keep && !removed) console.log(`\n  --keep: restored database left at ${persistTo}`);
    removed = true;
    return;
  }

  // A throw here would replace the drill's own verdict with a stack trace about a temp
  // directory, so this reports and moves on: a leftover directory in %TEMP% holds no live data
  // and is not a result worth losing a PASS over.
  try {
    rmSync(persistTo, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    removed = true;
  } catch {
    console.log(`\n  note: could not remove ${persistTo} — it holds no live data and can be deleted.`);
  }
}

/**
 * The ordinary way out. workerd keeps the SQLite file open for a moment after it is killed, and
 * an `exit` handler cannot wait — so the normal path gives it that moment here, and the handler
 * below stays as the last resort for the paths that end abruptly.
 */
async function finish(code) {
  stopWorker();
  await new Promise((r) => setTimeout(r, 1_000));
  cleanup();
  process.exit(code);
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const target = { local: true, config: 'wrangler.local.toml', persistTo };

try {
  console.log('\n▸ Restoring into a throwaway local database\n');
  run(process.execPath, [
    'scripts/d1-restore.mjs',
    '--from',
    dumpPath,
    '--into',
    'CareerLinkAI_Main',
    '--local',
    '--config',
    'wrangler.local.toml',
    '--persist-to',
    persistTo,
    '--yes',
  ]);
} catch {
  console.error('\nThe restore itself failed. The drill stops here — see the output above.\n');
  process.exit(1);
}

// ── 3. Choose a student out of the restored data ─────────────────────────────────────────────
// From the data, not from a constant: a hardcoded username rots the first time the source
// database is reseeded, and a drill that fails for its own reasons stops being trusted.

const [subject] = d1Query(
  'CareerLinkAI_Main',
  target,
  `SELECT cs.username AS username, c.join_code AS join_code, r.student_id AS student_id,
          COUNT(*) AS careers
     FROM recommendations r
     JOIN class_students cs ON cs.student_id = r.student_id AND cs.status = 'active'
     JOIN classes c ON c.id = cs.class_id AND c.status = 'active' AND c.deleted_at IS NULL
    WHERE r.match_type = 'CAREER'
    GROUP BY cs.username, c.join_code, r.student_id
    ORDER BY careers DESC
    LIMIT 1`,
);

check(
  'the restored backup contains a student with recommendations to serve',
  Boolean(subject?.username),
  subject ? `${subject.username} · ${subject.careers} careers · class ${subject.join_code}` : 'none found',
);

if (!subject?.username) {
  console.error('\n  Nothing to serve. Either the source database has no scored student, or the');
  console.error('  restore dropped rows the counts did not catch.\n');
  process.exit(1);
}

/** What the backup says this student's careers are — the answer the API has to reproduce. */
const expected = d1Query(
  'CareerLinkAI_Main',
  target,
  `SELECT careers.title AS title, r.ranking AS ranking, r.match_score AS match_score
     FROM recommendations r
     JOIN careers ON careers.id = r.target_career_id
    WHERE r.student_id = '${subject.student_id}' AND r.match_type = 'CAREER'
    ORDER BY r.ranking`,
);

// ── 4. Boot the real Worker against the restored database ────────────────────────────────────

// `[assets]` points at ../frontend/dist; `--ensure-only` creates it empty if absent rather than
// building the SPA, which the drill never serves.
run(process.execPath, ['scripts/build-frontend.mjs', '--ensure-only']);

console.log(`\n▸ Serving the restored database on :${port}\n`);

const workerLog = [];

worker = spawn(
  process.execPath,
  [
    wranglerEntry(),
    'dev',
    '--config',
    'wrangler.local.toml',
    '--persist-to',
    persistTo,
    '--port',
    String(port),
    '--ip',
    '127.0.0.1',
  ],
  {
    cwd: backendDir,
    detached: process.platform !== 'win32',
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

worker.stdout.on('data', (d) => workerLog.push(d.toString()));
worker.stderr.on('data', (d) => workerLog.push(d.toString()));

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Poll rather than sleep — a fixed wait is either slower than it needs to be or a flake. */
async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await api('/health');

      if (res.status === 200) return true;
    } catch {
      /* not listening yet */
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return false;
}

const healthy = await waitForHealth();

check('the Worker boots against the restored database', healthy, healthy ? `:${port}` : 'timed out');

if (!healthy) {
  console.error(`\n${workerLog.join('').slice(-3000)}\n`);
  process.exit(1);
}

// ── 5. The claim: a student signs in and is served their recommendations ─────────────────────

const joined = await api('/student-access/join', {
  method: 'POST',
  body: { class_code: subject.join_code, username: subject.username },
});

check(
  `${subject.username} joins with the class code from the backup`,
  joined.status === 200 && Boolean(joined.json?.data?.token),
  `status ${joined.status}`,
);

const token = joined.json?.data?.token;
const served = token ? await api('/student/recommendations', { token }) : { status: 0, json: null };
const careers = served.json?.data?.careers ?? [];

check(
  'the API serves recommendations from the restored data',
  served.status === 200 && careers.length > 0,
  `status ${served.status} · ${careers.length} careers`,
);

check(
  'the served list is the list the backup holds, in the same order',
  careers.length === expected.length &&
    careers.every((c, i) => c.career?.title === expected[i]?.title),
  `${careers.length} of ${expected.length} matched`,
);

check(
  'the match scores survived the round trip',
  careers.every((c, i) => Math.abs(Number(c.match_score) - Number(expected[i]?.match_score)) < 0.001),
  careers.length ? `top: ${careers[0]?.career?.title} ${Number(careers[0]?.match_score).toFixed(1)}` : '',
);

// The recommendation screen renders programmes beside careers, and they hang off a different
// chain of foreign keys (programs → program_catalog → colleges). A restore can lose one and not
// the other, so both are asserted.
const programs = served.json?.data?.programs ?? [];

check(
  'programmes came back too, with their colleges attached',
  programs.length > 0 && programs.every((p) => Boolean(p.program?.name) && Boolean(p.college?.name)),
  programs.length ? `${programs.length} programmes · top: ${programs[0]?.program?.name} @ ${programs[0]?.college?.name}` : 'none',
);

if (careers.length > 0) {
  console.log(`\n  ${subject.username} — served from the restored backup:`);
  for (const c of careers.slice(0, 5)) {
    console.log(`   ${String(c.ranking).padStart(2)}. ${c.career.title.padEnd(34)} ${Number(c.match_score).toFixed(1)}`);
  }
}

console.log(`\n${'═'.repeat(72)}`);

if (failures > 0) {
  console.error(`DRILL FAILED (${failures}) — this backup does not restore into a working system.\n`);
  await finish(1);
}

console.log('DRILL PASSED — the backup restores, and the application serves what came back.\n');
await finish(0);
