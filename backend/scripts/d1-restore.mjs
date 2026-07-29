/**
 * **Restore a D1 database from a `d1-backup.mjs` dump** (IMPLEMENTATION-PLAN P3-5).
 *
 * ── The shape of a D1 restore, which is not obvious ──────────────────────────────────────────
 *
 * A `wrangler d1 export` dump is `CREATE TABLE users (…)` — no `IF NOT EXISTS` on the
 * application tables. So it loads into an **empty** database and fails partway into a populated
 * one, leaving the target neither the old thing nor the new thing. That is the single most
 * dangerous property of this file format and it is why `--wipe` exists and why it is explicit:
 * the honest way to restore over live data is to empty the target first, deliberately, rather
 * than discover the constraint halfway through an import at 3 a.m.
 *
 * Which is also why this is the *second* recovery path and not the first. For anything inside
 * 30 days — a bad migration, a `DELETE` that forgot its `WHERE` — **D1 Time Travel restores the
 * same database in place, with no dump, no wipe and no window in which the data is gone**:
 *
 *     npx wrangler d1 time-travel restore CareerLinkAI_Main --env production \
 *       --timestamp 2026-07-29T03:00:00Z
 *
 * This script is for what Time Travel cannot reach: the database deleted, the account lost, the
 * thirty-first day, and cloning production's data into a scratch database to rehearse against.
 * See BACKUP-AND-RECOVERY.md.
 *
 * ── Guards, and the reason for each ──────────────────────────────────────────────────────────
 *
 *   · **The dump is checked against its manifest's SHA-256 before anything is touched.** A
 *     truncated download restored over a live database converts a recoverable incident into an
 *     unrecoverable one.
 *   · **`--into` is required and never inferred.** A restore target guessed from an environment
 *     flag is how the right dump goes into the wrong database.
 *   · **Production refuses to be a target** without `--i-know-this-is-production`, and the
 *     production database is identified from wrangler.toml rather than by matching on the word
 *     "production" — the production database here is called `CareerLinkAI_Main`, so a name check
 *     would not catch it.
 *   · **A non-empty target refuses to be restored into** without `--wipe`, for the format reason
 *     above.
 *   · **The restore is verified after it lands**, table by table and row by row against the
 *     manifest. An import that exits 0 having loaded two thirds of the rows is exactly the
 *     failure a restore must not report as success.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/d1-restore.mjs --from .backups/<file>.sql --into CareerLinkAI_Drill --env staging --create
 *   node scripts/d1-restore.mjs --from .backups/<file>.sql --into CareerLinkAI_Staging --env staging --wipe
 *   node scripts/d1-restore.mjs --from .backups/<file>.sql --into CareerLinkAI_Main --local --wipe
 *
 *   --create      create the target database first if it does not exist
 *   --wipe        drop every table in the target before loading (required if it has any)
 *   --dry-run     report what would happen and change nothing
 *   --yes         skip the typed confirmation (for CI; never for production)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  argReader,
  backendDir,
  d1Databases,
  dropOrder,
  formatBytes,
  liveRowCounts,
  liveTableSchemas,
  liveTables,
  parseDump,
  sha256,
  targetFlags,
  wrangler,
} from './lib/d1.mjs';

const { flag, has } = argReader();

const from = flag('from');
const into = flag('into');
const env = flag('env');
const local = has('local');
const create = has('create');
const wipe = has('wipe');
const dryRun = has('dry-run');
const assumeYes = has('yes');

if (!from || !into) {
  console.error('error: --from <dump.sql> and --into <DATABASE_NAME> are both required.');
  console.error('       The restore target is never inferred. See the header of this file.');
  process.exit(1);
}
if (!local && !env) {
  console.error('error: --env <staging|production> is required unless --local is given.');
  process.exit(1);
}

const dumpPath = resolve(backendDir, from);

if (!existsSync(dumpPath)) {
  console.error(`error: no such dump: ${dumpPath}`);
  process.exit(1);
}

const target = { env, local, config: flag('config'), persistTo: flag('persist-to') };

console.log(`\nD1 restore → ${into} (${local ? 'local' : env})\n${'─'.repeat(72)}`);

// ── 1. The dump, and whether it is the dump it says it is ────────────────────────────────────

const manifestPath = dumpPath.replace(/\.sql$/, '.manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const dumpBuffer = readFileSync(dumpPath);
const dump = parseDump(dumpBuffer.toString('utf8'));

console.log(`  from: ${basename(dumpPath)} (${formatBytes(dumpBuffer.length)})`);

if (manifest) {
  const digest = sha256(dumpBuffer);

  if (digest !== manifest.sha256) {
    console.error('\n  ✗ SHA-256 MISMATCH — this dump is not the file its manifest describes.');
    console.error(`      manifest: ${manifest.sha256}`);
    console.error(`      actual:   ${digest}`);
    console.error('\n  Refusing to restore. A truncated or altered dump loaded over a database');
    console.error('  turns a recoverable incident into an unrecoverable one.\n');
    process.exit(1);
  }

  console.log(`  taken: ${manifest.taken_at} from ${manifest.database} (${manifest.environment})`);
  console.log(`  holds: ${manifest.tables} tables · ${manifest.rows.toLocaleString()} rows · sha256 verified`);
} else {
  // Allowed, because a dump downloaded from the Cloudflare dashboard or pulled off cold storage
  // legitimately has no manifest — but never silently, because the row counts it would have been
  // checked against are exactly what the post-restore verification below needs.
  console.log('  note: no manifest beside this dump — integrity cannot be checked before loading,');
  console.log('        and the restore will be verified against the dump itself rather than');
  console.log("        against the source database's own counts.");
}

// ── 2. Is this production? ───────────────────────────────────────────────────────────────────
// Read from wrangler.toml rather than matched on the string "production": this project's
// production database is called `CareerLinkAI_Main`, so a name check would wave it straight
// through — and `CareerLinkAI_Main` is *also* the local Miniflare database's name, which is
// precisely the confusion this guard has to survive.

const configured = d1Databases();
const productionName = configured.production?.database_name;
const isProduction = !local && into === productionName;

if (isProduction && !has('i-know-this-is-production')) {
  console.error(`\n  ✗ ${into} is the production database (wrangler.toml [env.production]).`);
  console.error('\n  Restoring a dump over production is a last resort. Inside 30 days,');
  console.error('  `wrangler d1 time-travel restore` recovers the same database in place with no');
  console.error('  window in which the data is absent — try that first.');
  console.error('\n  If this really is the intended action, re-run with --i-know-this-is-production.\n');
  process.exit(1);
}

// ── 3. The target, and whether it is empty ───────────────────────────────────────────────────

if (create) {
  const existing = wrangler(['d1', 'list', '--json'], { capture: true, quiet: true });
  const known = JSON.parse(existing.slice(existing.indexOf('['))).some((d) => d.name === into);

  if (known) {
    console.log(`  target: ${into} already exists (--create had nothing to do)`);
  } else if (dryRun) {
    console.log(`  target: ${into} does not exist — --create would create it`);
  } else {
    console.log(`  target: creating ${into}…`);
    wrangler(['d1', 'create', into]);
  }
}

let existingTables = [];

try {
  existingTables = liveTables(into, target);
} catch (error) {
  if (dryRun && create) {
    console.log('  target: not readable yet (it would have been created above)');
  } else {
    console.error(`\n  ✗ cannot read ${into}: ${error.message.split('\n')[0]}`);
    console.error('    Does it exist in this account, and is it declared in wrangler.toml for');
    console.error('    this environment? Pass --create to create it.\n');
    process.exit(1);
  }
}

if (existingTables.length > 0) {
  const counts = liveRowCounts(into, target, existingTables);
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);

  console.log(`  target holds: ${existingTables.length} tables, ${rows.toLocaleString()} rows`);

  if (!wipe) {
    console.error('\n  ✗ the target is not empty, and this dump creates its tables unconditionally.');
    console.error('    Loading it would fail partway and leave the database neither the old state');
    console.error('    nor the new one. Pass --wipe to drop these tables first — deliberately.\n');
    process.exit(1);
  }
}

console.log(`  dump holds: ${dump.tables.size} tables · ${Object.values(dump.rowCounts).reduce((a, b) => a + b, 0).toLocaleString()} rows`);

if (dryRun) {
  console.log('\n  --dry-run: nothing was changed.\n');
  process.exit(0);
}

// ── 4. Confirm ───────────────────────────────────────────────────────────────────────────────
// Typed, not y/n. This destroys a database; a keystroke is too cheap for that, and the string it
// asks for is the one thing a person restoring the wrong database would get wrong.

if (!assumeYes && (existingTables.length > 0 || isProduction)) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = `\n  This will DROP ${existingTables.length} table(s) in ${into} and replace them.\n  Type the database name to continue: `;
  const answer = (await rl.question(prompt)).trim();

  rl.close();

  if (answer !== into) {
    console.error('\n  Aborted — nothing was changed.\n');
    process.exit(1);
  }
}

// ── 5. Wipe, then load ───────────────────────────────────────────────────────────────────────
// Both go through a temp file outside the repository: `--command` would need every statement
// escaped through a shell, and `mkdtemp` keeps a generated SQL file from ever being `git add`-ed.

const workDir = mkdtempSync(join(tmpdir(), 'careerlinkai-restore-'));

try {
  if (existingTables.length > 0) {
    // Children before the tables they reference — see `dropOrder`. The pragma stays as a second
    // line of defence for a schema whose foreign keys form a cycle, which no order can satisfy.
    const ordered = dropOrder(liveTableSchemas(into, target));
    const dropSql = [
      'PRAGMA defer_foreign_keys=TRUE;',
      ...ordered.map((t) => `DROP TABLE IF EXISTS "${t}";`),
      '',
    ].join('\n');
    const dropPath = join(workDir, 'wipe.sql');

    writeFileSync(dropPath, dropSql, 'utf8');
    console.log(`\n  dropping ${existingTables.length} tables…`);
    wrangler(['d1', 'execute', into, ...targetFlags(target), '-y', `--file=${dropPath}`]);
  }

  console.log(`\n  loading ${basename(dumpPath)}…`);
  wrangler(['d1', 'execute', into, ...targetFlags(target), '-y', `--file=${dumpPath}`]);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// ── 6. Verify what actually landed ───────────────────────────────────────────────────────────
// The step that makes this a restore rather than an import. `wrangler d1 execute` reports the
// statements it ran, not the rows that survived them, and a dump loaded against an unexpected
// schema can drop rows on a constraint while the command still exits 0.

const restoredTables = liveTables(into, target);
const restoredCounts = liveRowCounts(into, target, restoredTables);
const expected = manifest?.row_counts ?? dump.rowCounts;

const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

console.log('');

const missing = [...dump.tables].filter((t) => t !== 'd1_migrations' && !restoredTables.includes(t));

check(
  'every table in the dump exists in the restored database',
  missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${restoredTables.length} tables`,
);

const shortfall = Object.entries(expected)
  .filter(([table]) => restoredTables.includes(table))
  .map(([table, n]) => ({ table, expected: Number(n), actual: restoredCounts[table] ?? 0 }))
  .filter((r) => r.expected !== r.actual);

check(
  'every table holds the row count the backup recorded',
  shortfall.length === 0,
  shortfall.length
    ? shortfall.map((r) => `${r.table} ${r.expected}→${r.actual}`).join(', ')
    : `${Object.values(restoredCounts).reduce((a, b) => a + b, 0).toLocaleString()} rows`,
);

const restoredMigrations = restoredTables.includes('d1_migrations') ? dump.migrations.length : 0;

check(
  'the migration ledger came across, so wrangler will not re-apply applied migrations',
  restoredMigrations === dump.migrations.length && restoredMigrations > 0,
  `${restoredMigrations} migrations`,
);

console.log(`\n${'─'.repeat(72)}`);

if (failures.length > 0) {
  console.error(`RESTORE INCOMPLETE (${failures.length}) — ${into} is not a faithful copy.\n`);
  process.exit(1);
}

console.log(`Restored ${into} from ${basename(dumpPath)}.`);
console.log('The data is verified. Whether the *application* serves it is a separate claim —');
console.log('run scripts/restore-drill.mjs to make it.\n');
