/**
 * **Take a verified, offsite backup of a D1 database** (IMPLEMENTATION-PLAN P3-5).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * Until this script, no backup procedure was documented anywhere in the repo. That is the one
 * gap on the plan's list that can lose data permanently: every other outstanding item degrades
 * the product, and this one ends it. D1 *does* carry Time Travel (30 days of point-in-time
 * restore, on every plan, with nothing to configure) and that covers the common disaster —
 * a bad migration, a `DELETE` without a `WHERE`. It does **not** cover the two that are final:
 * the database being deleted, and the account being lost. Time Travel lives inside the database
 * it protects. See BACKUP-AND-RECOVERY.md for the full division of labour.
 *
 * ── Why it is not `wrangler d1 export` in a cron entry ────────────────────────────────────────
 *
 * Because `wrangler d1 export` exits 0 on an empty database, and a backup nobody has verified is
 * not a backup, it is a hypothesis. The specific way this goes wrong is not exotic: point the
 * command at a name that still resolves but is no longer the database the Worker binds — a
 * renamed environment, a copy-pasted `--env`, a `database_id` swapped in wrangler.toml — and it
 * writes a perfectly well-formed dump of nothing, every night, exiting 0 every time. You find
 * out during the restore, which is the moment you have the least of everything.
 *
 * So this script does not trust the exit code. It reads the **live** database's table list and
 * `COUNT(*)` per table, then parses the dump it just wrote and asserts they agree, table by
 * table and row by row. A dump that is missing a table, missing rows, or empty where the source
 * is not fails the run and is written to `<name>.sql.REJECTED` rather than kept — because a bad
 * backup sitting in the backup directory is worse than no backup at all: it is the one you will
 * reach for.
 *
 * The database name comes from wrangler.toml rather than from an argument, for the same reason.
 *
 * ── Why the export is taken in two halves ────────────────────────────────────────────────────
 *
 * **A single `wrangler d1 export` produces a dump that will not load into a database that
 * enforces foreign keys**, and this was found by trying it rather than by reading about it.
 *
 * The exporter emits each table's `CREATE` followed immediately by its rows, in an order that is
 * not dependency order: in this schema `student_profiles` is created at line 133 with an inline
 * `REFERENCES shs_strands (id)` and populated from line 152, while `CREATE TABLE shs_strands`
 * does not appear until line **3841**. The file opens with `PRAGMA defer_foreign_keys=TRUE`,
 * which makes that legal — but only for a reader that runs the whole file inside one
 * transaction. D1's own import API does. `wrangler d1 execute --local --file` does not: it runs
 * the statements individually, each one auto-committing, so the deferral never spans them and
 * the load dies on `no such table: main.shs_strands`.
 *
 * The consequence is worth stating plainly, because it is the opposite of what you would assume
 * while holding a 1 MB file that says `CREATE TABLE` at the top: **a stock D1 dump is restorable
 * only by D1.** Not into Miniflare, not into a scratch SQLite for inspection, not by any tool
 * that has foreign keys switched on — which, on the day you need it, is a discovery with no good
 * options left.
 *
 * `--no-data` and `--no-schema` are two exports of the same database, and concatenating them
 * puts every `CREATE TABLE` ahead of every `INSERT`. The ordering hazard disappears, both halves
 * are still produced verbatim by Cloudflare's own exporter, and the result loads through D1's
 * importer exactly as before *and* into anything else. One extra API call against a 2 MB
 * database, for a backup that is restorable somewhere other than the platform that failed.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/d1-backup.mjs --env staging
 *   node scripts/d1-backup.mjs --env production
 *   node scripts/d1-backup.mjs --local                  # the Miniflare database
 *
 *   --out <dir>        where dumps live          (default: backend/.backups, gitignored)
 *   --keep-days <n>    prune older than this     (default: 30 — matches Time Travel's window)
 *   --keep-min <n>     never prune below this many, whatever their age (default: 7)
 *   --no-prune         keep everything
 *
 * Each run writes two files: `<db>-<env>-<stamp>.sql` and a `.manifest.json` beside it carrying
 * the SHA-256, the per-table row counts, the applied migration list, and the Time Travel
 * bookmark the export was taken at. The manifest is what `d1-restore.mjs` checks a dump against
 * before it is allowed near a database.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  argReader,
  backendDir,
  databaseFor,
  dropOrder,
  formatBytes,
  liveRowCounts,
  liveTableSchemas,
  liveTables,
  parseDump,
  reorderDataForInsert,
  sha256,
  stamp,
  targetFlags,
  verifyBackup,
  wrangler,
} from './lib/d1.mjs';

const { flag, has } = argReader();

const local = has('local');
const env = flag('env');

if (!local && !env) {
  console.error('error: --env <staging|production> is required unless --local is given.');
  process.exit(1);
}

const outDir = flag('out', join(backendDir, '.backups'));
const keepDays = Number(flag('keep-days', 30));
const keepMin = Number(flag('keep-min', 7));
const prune = !has('no-prune');

// `--persist-to` is deliberately not accepted here, unlike in d1-restore.mjs: `wrangler d1
// execute --local` takes it happily, but `wrangler d1 export --local --persist-to` dies with a
// libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, exit 0xC0000409) before writing
// anything. `--local` therefore always reads the default `.wrangler/state` database — which is
// the one `npm run dev` uses, and the only local database there is.
const target = { env, local, config: flag('config') };
const database = local ? databaseFor('') : databaseFor(env);
const label = local ? 'local' : env;

console.log(`\nD1 backup — ${database.name} (${label})\n${'─'.repeat(72)}`);

mkdirSync(outDir, { recursive: true });

const failures = [];
const warnings = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. Read the source first ─────────────────────────────────────────────────────────────────
// Before the export, not after: these are the numbers the dump is judged against, and taking
// them from the dump would be marking its own homework.

const tables = liveTables(database.name, target);
const rowCounts = liveRowCounts(database.name, target, tables);
const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);

console.log(`  source: ${tables.length} tables, ${totalRows.toLocaleString()} rows`);

/**
 * The Time Travel bookmark at the instant of the export.
 *
 * Recorded because it is the coordinate that makes the *other* recovery path usable: a bookmark
 * is how you ask D1 for this exact state again without a dump at all, and it is unguessable
 * after the fact. Remote only — Miniflare has no such notion.
 */
let bookmark = null;

if (!local) {
  try {
    const raw = wrangler(['d1', 'time-travel', 'info', database.name, '--env', env, '--json'], {
      capture: true,
      quiet: true,
    });

    bookmark = JSON.parse(raw.slice(raw.indexOf('{'))).bookmark ?? null;
  } catch {
    // A missing bookmark degrades the manifest; it does not invalidate the dump. Recorded as a
    // warning rather than swallowed, so "no bookmark" is never mistaken for "not looked for".
    warnings.push('Time Travel bookmark unavailable — the dump is still valid.');
  }
}

// ── 2. Export, schema first and data second ──────────────────────────────────────────────────
// See the header. The two halves are concatenated verbatim — whatever Cloudflare's exporter
// writes is what lands in the file; only the order of the two blocks is this script's doing.

const base = `${database.name}-${label}-${stamp()}`;
const sqlPath = join(outDir, `${base}.sql`);
const manifestPath = join(outDir, `${base}.manifest.json`);
const workDir = mkdtempSync(join(tmpdir(), 'careerlinkai-backup-'));
const schemaPath = join(workDir, 'schema.sql');
const dataPath = join(workDir, 'data.sql');

try {
  wrangler(['d1', 'export', database.name, ...targetFlags(target), '-y', '--no-data', '--output', schemaPath]);
  wrangler(['d1', 'export', database.name, ...targetFlags(target), '-y', '--no-schema', '--output', dataPath]);

  if (!existsSync(schemaPath) || !existsSync(dataPath)) {
    console.error('\n  wrangler exited 0 but wrote no file. Nothing was backed up.\n');
    process.exit(1);
  }

  // Every table before the tables that reference it — `dropOrder` run backwards. The graph comes
  // from the live schema rather than from parsing the dump, because the live schema is exact.
  const insertOrder = dropOrder(liveTableSchemas(database.name, target)).reverse();

  writeFileSync(
    sqlPath,
    [
      `-- CareerLinkAI backup of ${database.name} (${label}), ${new Date().toISOString()}`,
      '-- Written by backend/scripts/d1-backup.mjs. Schema first, then rows in dependency order:',
      '-- a stock `wrangler d1 export` produces neither, and is not loadable by any importer.',
      '-- Restore with backend/scripts/d1-restore.mjs. See BACKUP-AND-RECOVERY.md.',
      '',
      readFileSync(schemaPath, 'utf8'),
      reorderDataForInsert(readFileSync(dataPath, 'utf8'), insertOrder),
    ].join('\n'),
    'utf8',
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const dumpText = readFileSync(sqlPath, 'utf8');
const dumpBytes = statSync(sqlPath).size;
const dump = parseDump(dumpText);

/**
 * The same counts again, *after* the export.
 *
 * A D1 export is a consistent snapshot taken at one bookmark; the counts read either side of it
 * are not that snapshot. On a quiescent database they are identical and the dump must match them
 * exactly. On a database taking writes — which production will be, at whatever hour the cron
 * fires — a strict equality check would fail on a *correct* backup, and a check that cries wolf
 * on production is one that gets removed. So the invariant asserted below is the one that is
 * actually true: the snapshot was taken between these two observations, so every table's count
 * in the dump must lie between them.
 */
const rowCountsAfter = liveRowCounts(database.name, target, tables);
const drifted = tables.filter((t) => (rowCounts[t] ?? 0) !== (rowCountsAfter[t] ?? 0));

console.log(`\n  dump: ${formatBytes(dumpBytes)}, ${dump.statements.toLocaleString()} statements`);
if (drifted.length > 0) {
  console.log(`  note: ${drifted.length} table(s) were written to during the export — counts are checked as a range`);
}
console.log('');

// ── 3. Verify the dump against the source it claims to be a copy of ──────────────────────────
// The predicates live in lib/d1.mjs as a pure function so they can be driven red by
// test/platform/backup-verification.test.ts. Proving them here would mean corrupting a real
// database on purpose.

const repoMigrations = existsSync(join(backendDir, 'migrations'))
  ? readdirSync(join(backendDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  : [];

const verdict = verifyBackup({
  tables,
  countsBefore: rowCounts,
  countsAfter: rowCountsAfter,
  dump,
  dumpBytes,
  repoMigrations,
});

for (const { name, ok, detail } of verdict.checks) check(name, ok, detail);
warnings.push(...verdict.warnings);

// ── 4. Manifest, or rejection ────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  // Renamed, not deleted: the dump is evidence about what went wrong, and it must not be
  // reachable by a restore. `d1-restore.mjs` requires a manifest, and a rejected dump has none.
  const rejected = `${sqlPath}.REJECTED`;

  rmSync(rejected, { force: true });
  renameSync(sqlPath, rejected);

  console.error(`\n${'─'.repeat(72)}`);
  console.error(`BACKUP FAILED (${failures.length}) — this dump is NOT a usable backup.`);
  for (const f of failures) console.error(`  · ${f}`);
  console.error(`\n  Kept for inspection at ${rejected}`);
  console.error('  Nothing in the backup directory has changed. The last good backup is still\n  the last good backup.\n');
  process.exit(1);
}

const manifest = {
  database: database.name,
  database_id: database.id ?? null,
  environment: label,
  taken_at: new Date().toISOString(),
  time_travel_bookmark: bookmark,
  file: `${base}.sql`,
  bytes: dumpBytes,
  sha256: sha256(readFileSync(sqlPath)),
  tables: tables.length,
  // The **dump's** counts, not the live database's. This is what `d1-restore.mjs` asserts a
  // restored database against, so it has to describe the artefact rather than its source: if a
  // row landed between the two reads above, the restore reproduces the dump — and should not be
  // reported as incomplete for reproducing it exactly.
  rows: tables.reduce((total, t) => total + (dump.rowCounts[t] ?? 0), 0),
  row_counts: Object.fromEntries(tables.map((t) => [t, dump.rowCounts[t] ?? 0])),
  migrations: dump.migrations,
  wrangler: wrangler(['--version'], { capture: true, quiet: true }).trim().split('\n').pop()?.trim() ?? null,
  verified: {
    tables_present: true,
    row_counts_match: true,
    load_bearing_populated: true,
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// ── 5. Retention ─────────────────────────────────────────────────────────────────────────────
// Only pairs this script wrote, for this database and environment, are eligible — a file
// somebody dropped in the directory by hand is never deleted by an automated sweep. `keepMin`
// is a floor beneath the age rule, so a month of downtime cannot age out the last good copy.

let pruned = 0;

if (prune && Number.isFinite(keepDays)) {
  const prefix = `${database.name}-${label}-`;
  const mine = readdirSync(outDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.manifest.json'))
    .map((f) => ({ manifest: f, mtime: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;

  for (const entry of mine.slice(Math.max(keepMin, 1))) {
    if (entry.mtime >= cutoff) continue;

    rmSync(join(outDir, entry.manifest), { force: true });
    rmSync(join(outDir, entry.manifest.replace(/\.manifest\.json$/, '.sql')), { force: true });
    pruned += 1;
  }
}

console.log(`\n${'─'.repeat(72)}`);
for (const w of warnings) console.log(`  note: ${w}`);
console.log(`  ${sqlPath}`);
console.log(`  ${formatBytes(dumpBytes)} · ${tables.length} tables · ${totalRows.toLocaleString()} rows · sha256 ${manifest.sha256.slice(0, 16)}…`);
if (bookmark) console.log(`  Time Travel bookmark: ${bookmark}`);
if (pruned) console.log(`  pruned ${pruned} backup(s) older than ${keepDays} days (floor: ${keepMin})`);
console.log('\nPASS — verified against the live database, table by table and row by row.\n');
