/**
 * Everything the backup and restore scripts know about a D1 dump that does **not** require a
 * filesystem, a subprocess or a Cloudflare account (plan P3-5).
 *
 * Split from `d1.mjs` so that `test/platform/backup-verification.test.ts` can import it. That
 * suite runs inside workerd, where `node:fs` and `node:child_process` are stubs at best — so a
 * module that reaches for either at import time cannot be tested there at all, and these are
 * precisely the predicates that most need firing red on every push: they are the only thing
 * standing between "wrangler exited 0" and a year of nightly backups of an empty database.
 *
 * Nothing in this file performs I/O. That is the point of the file.
 */

/**
 * An order in which every table can be dropped — **children before the tables they reference.**
 *
 * Dropping alphabetically does not work, and the way it fails is counter-intuitive enough to be
 * worth stating: `DROP TABLE` runs an implicit `DELETE FROM`, and deleting from a *child* table
 * makes SQLite consult its **parent** to run the foreign key check. So dropping
 * `assessment_dimensions` before `question_dimensions`, which references it, fails the second
 * drop with `no such table: main.assessment_dimensions` — an error naming a table you deliberately
 * removed a moment ago, raised by a `DROP TABLE IF EXISTS` on an entirely different one.
 *
 * `PRAGMA defer_foreign_keys=TRUE` papers over this on a remote restore, because D1's import API
 * runs the whole file in one transaction and the deferral spans it. It does **not** on a local
 * one, where wrangler executes each statement on its own and every deferral ends immediately.
 * Ordering the drops correctly works in both places, and this repo has been bitten enough times
 * by "correct on one runtime" to prefer the version that does not have to know which it is on.
 */
export function dropOrder(schemas) {
  const references = new Map(
    schemas.map(({ name, sql }) => [
      name,
      new Set(
        [...(sql ?? '').matchAll(/\bREFERENCES\s+"?([A-Za-z_]\w*)"?/gi)]
          .map((m) => m[1])
          .filter((parent) => parent !== name),
      ),
    ]),
  );

  const order = [];
  const done = new Set();
  const onStack = new Set();

  // Post-order DFS along "X references Y" emits parents first; reversing it puts children first.
  // `onStack` breaks the cycles that mutually-referencing tables would otherwise spin on — a
  // cycle has no safe order anyway, and the emitted one is at least deterministic.
  function visit(name) {
    if (done.has(name) || onStack.has(name)) return;

    onStack.add(name);
    for (const parent of references.get(name) ?? []) {
      if (references.has(parent)) visit(parent);
    }
    onStack.delete(name);
    done.add(name);
    order.push(name);
  }

  for (const { name } of schemas) visit(name);

  return order.reverse();
}

/**
 * What a `wrangler d1 export` dump actually contains.
 *
 * Statement starts are matched at the beginning of a line, which is how D1 writes them (one row
 * per `INSERT`, one line per statement) — and, more to the point, a value containing a newline
 * followed by `INSERT INTO "careers"` would have to be a deliberately constructed string. The
 * counts this produces are compared against the source database's own `COUNT(*)` on every
 * backup, so a parse that drifted from reality would fail the backup rather than pass it
 * quietly, which is the property that makes the shortcut safe.
 *
 * Both quoting styles are handled because D1 emits both **in the same file**: `CREATE TABLE users`
 * bare, `INSERT INTO "users"` quoted.
 */
export function parseDump(sql) {
  const tables = new Set();
  const rowCounts = {};
  const migrations = [];
  let statements = 0;

  for (const line of sql.split('\n')) {
    if (line.startsWith('CREATE TABLE')) {
      const name = /^CREATE TABLE (?:IF NOT EXISTS )?["`]?([A-Za-z_][\w]*)["`]?/.exec(line);

      if (name) tables.add(name[1]);
      statements += 1;
      continue;
    }

    if (line.startsWith('INSERT INTO ')) {
      const name = /^INSERT INTO ["`]?([A-Za-z_][\w]*)["`]?/.exec(line);

      if (name) {
        rowCounts[name[1]] = (rowCounts[name[1]] ?? 0) + 1;

        if (name[1] === 'd1_migrations') {
          const applied = /VALUES\(\d+,'([^']+)'/.exec(line);

          if (applied) migrations.push(applied[1]);
        }
      }

      statements += 1;
      continue;
    }

    if (line.startsWith('CREATE INDEX') || line.startsWith('CREATE UNIQUE INDEX')) statements += 1;
  }

  return { tables, rowCounts, migrations, statements };
}

/**
 * Regroup a data-only dump so **every parent's rows are inserted before its children's**.
 *
 * `wrangler d1 export` writes rows in the order the tables were created, which is not dependency
 * order and is not close to it: `programs` is written well before `program_catalog`, and every
 * `programs` row carries a `program_catalog_id` referencing it. Loading that produces
 * `FOREIGN KEY constraint failed` — on the **remote** importer specifically, which is the one a
 * real recovery uses, and which no amount of local testing reveals.
 *
 * `insertOrder` is `dropOrder` reversed: the order in which tables can be dropped, run backwards,
 * is the order in which they can be filled. One graph, two directions, so the wipe and the load
 * can never disagree about the schema.
 *
 * Everything that is not an `INSERT` — the pragma, the comment header — is kept, in order, ahead
 * of the rows. Tables the graph does not know about (`sqlite_sequence`) go last, where they cannot
 * be a parent of anything.
 */
export function reorderDataForInsert(dataSql, insertOrder) {
  const preamble = [];
  const byTable = new Map(insertOrder.map((t) => [t, []]));
  const unknown = new Map();

  for (const line of dataSql.split('\n')) {
    const match = /^INSERT INTO ["`]?([A-Za-z_][\w]*)["`]?/.exec(line);

    if (!match) {
      if (line.trim() !== '') preamble.push(line);
      continue;
    }

    const bucket = byTable.get(match[1]) ?? unknown.get(match[1]) ?? [];

    if (!byTable.has(match[1]) && !unknown.has(match[1])) unknown.set(match[1], bucket);
    bucket.push(line);
  }

  return [
    ...preamble,
    ...insertOrder.flatMap((t) => byTable.get(t) ?? []),
    ...[...unknown.values()].flat(),
    '',
  ].join('\n');
}

/**
 * Tables whose emptiness means the backup is of the wrong thing.
 *
 * Deliberately not "every table": `notifications` is legitimately empty on a fresh deployment and
 * a gate that fires on that is a gate someone switches off. These four are populated by the
 * production runbook's own steps 4 and 5, so a real database has them and a mistargeted export
 * does not.
 */
export const MUST_NOT_BE_EMPTY = ['users', 'careers', 'colleges', 'programs'];

/**
 * **Is this dump a faithful copy of the database it was taken from?**
 *
 * A pure function so the gate can be fired red on demand — plan item P1-3's rule, applied to the
 * one item on the plan whose failure mode is permanent data loss. Proving these live would mean
 * deliberately corrupting a real database; `test/platform/backup-verification.test.ts` drives
 * them against synthetic dumps that are each wrong in exactly one way.
 *
 * `countsBefore` and `countsAfter` bracket the export. On a quiescent database they are equal and
 * this is exact equality; on one taking writes they differ, and the honest invariant is that the
 * snapshot fell between them. A stricter rule would fail *correct* production backups, and a
 * check that cries wolf on production is a check that gets removed rather than fixed.
 */
export function verifyBackup({ tables, countsBefore, countsAfter, dump, dumpBytes, repoMigrations }) {
  const checks = [];
  const warnings = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  add('the dump is not empty', dumpBytes > 0, formatBytes(dumpBytes));

  const missingTables = tables.filter((t) => !dump.tables.has(t));

  add(
    'every source table has a CREATE TABLE in the dump',
    missingTables.length === 0,
    missingTables.length ? `missing: ${missingTables.join(', ')}` : `${tables.length} tables`,
  );

  const mismatched = tables
    .map((t) => ({
      table: t,
      low: Math.min(countsBefore[t] ?? 0, countsAfter[t] ?? 0),
      high: Math.max(countsBefore[t] ?? 0, countsAfter[t] ?? 0),
      dumped: dump.rowCounts[t] ?? 0,
    }))
    .filter((r) => r.dumped < r.low || r.dumped > r.high);

  add(
    'every table holds the number of rows the database held when the snapshot was taken',
    mismatched.length === 0,
    mismatched.length
      ? mismatched
          .map((r) => `${r.table} ${r.low === r.high ? r.low : `${r.low}–${r.high}`}→${r.dumped}`)
          .join(', ')
      : `${tables.reduce((n, t) => n + (dump.rowCounts[t] ?? 0), 0).toLocaleString()} rows`,
  );

  // The mistargeted-export trap. A dump with a full schema and no rows passes every structural
  // check above and is the exact artefact a wrong `--env` produces. Judged on the **dump**, not
  // on the live read: the dump is the artefact that has to be usable.
  const empty = MUST_NOT_BE_EMPTY.filter((t) => (dump.rowCounts[t] ?? 0) === 0);

  add(
    'the load-bearing tables are populated (this is not a backup of an empty database)',
    empty.length === 0,
    empty.length ? `empty: ${empty.join(', ')}` : MUST_NOT_BE_EMPTY.join(', '),
  );

  /**
   * Migration state, both directions.
   *
   * *Behind* the repo is a fact about the deployment, not a fault in the backup — a database that
   * has not had today's migration applied still backs up perfectly, and failing here would block
   * backups precisely while a deploy is half-done. *Ahead* of the repo is different: it means this
   * checkout cannot be the code that wrote the data, so a restore from this dump produces a schema
   * the deployed Worker does not expect, and whoever runs that restore needs to know before.
   */
  const unknown = dump.migrations.filter((m) => !repoMigrations.includes(m));
  const pending = repoMigrations.filter((m) => !dump.migrations.includes(m));

  add(
    'every migration in the dump exists in this checkout',
    unknown.length === 0,
    unknown.length ? `not in migrations/: ${unknown.join(', ')}` : `${dump.migrations.length} applied`,
  );

  if (pending.length > 0) {
    warnings.push(
      `${pending.length} migration(s) in migrations/ are not applied to this database: ${pending.join(', ')}`,
    );
  }

  return { checks, warnings, ok: checks.every((c) => c.ok) };
}

/** `2026-07-29T04-31-12Z` — sortable, and legal in a filename on every platform. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

export function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

/** `--flag value` / `--flag`, the argument shape every other script in this repo uses. */
export function argReader(argv = process.argv.slice(2)) {
  return {
    flag: (name, fallback) => {
      const i = argv.indexOf(`--${name}`);

      return i === -1 ? fallback : argv[i + 1];
    },
    has: (name) => argv.includes(`--${name}`),
    all: argv,
  };
}
