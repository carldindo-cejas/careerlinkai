import { describe, expect, it } from 'vitest';

// A plain .mjs script module with no type declarations. Kept on one line because
// `@ts-expect-error` suppresses the *next line*, and the diagnostic lands on the `from` clause —
// so a wrapped import moves the error out from under its own suppression.
//
// The point of this file is to exercise the **script the operator actually runs**, not a
// TypeScript re-implementation of it that could pass while the script fails. `d1-dump.mjs` and not
// `d1.mjs`: the latter reaches for node:fs and node:child_process, neither of which is real inside
// workerd.
// @ts-expect-error — untyped .mjs, deliberately
import { dropOrder, parseDump, reorderDataForInsert, verifyBackup } from '../../scripts/lib/d1-dump.mjs';

import packageJson from '../../package.json';

/**
 * **The backup gate, fired red** (plan P3-5, guarding the same class of defect as P1-3).
 *
 * `wrangler d1 export` exits 0 on an empty database. That single fact is the reason
 * `scripts/d1-backup.mjs` exists in the shape it does: point the command at a name that still
 * resolves but is no longer the database the Worker binds — a copy-pasted `--env`, a
 * `database_id` swapped in wrangler.toml — and it writes a well-formed dump of nothing, exits 0,
 * and does so again every night until somebody needs it.
 *
 * The verification that catches this cannot be proven by running a successful backup, which is
 * all a green `npm run db:backup:staging` demonstrates. Proving it live would mean deliberately
 * corrupting a real database. So the predicates were split into a pure `verifyBackup()` and are
 * driven here against synthetic dumps that are wrong in one specific way each — the P1-3 rule
 * that a gate never seen red is not known to be a gate, applied to the one item on the plan whose
 * failure mode is permanent data loss.
 */

/** A minimal but structurally honest dump, in the shape `wrangler d1 export` actually emits. */
function dumpText({
  tables = ['users', 'careers', 'colleges', 'programs'],
  rows = { users: 2, careers: 3, colleges: 1, programs: 1 },
  migrations = ['0001_identity_and_access.sql'],
} = {}) {
  const lines = ['PRAGMA defer_foreign_keys=TRUE;'];

  lines.push('CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY, name TEXT);');
  migrations.forEach((name, i) => {
    lines.push(`INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(${i + 1},'${name}','x');`);
  });

  for (const table of tables) {
    lines.push(`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL);`);
    for (let i = 0; i < (rows[table as keyof typeof rows] ?? 0); i += 1) {
      lines.push(`INSERT INTO "${table}" ("id") VALUES('${table}-${i}');`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function verify(overrides: Record<string, unknown> = {}) {
  const sql = (overrides.sql as string) ?? dumpText();
  const dump = parseDump(sql);
  const tables = (overrides.tables as string[]) ?? ['users', 'careers', 'colleges', 'programs'];
  const counts =
    (overrides.counts as Record<string, number>) ?? { users: 2, careers: 3, colleges: 1, programs: 1 };

  return verifyBackup({
    tables,
    countsBefore: counts,
    countsAfter: (overrides.countsAfter as Record<string, number>) ?? counts,
    dump,
    dumpBytes: (overrides.dumpBytes as number) ?? sql.length,
    repoMigrations: (overrides.repoMigrations as string[]) ?? ['0001_identity_and_access.sql'],
  }) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[]; warnings: string[] };
}

/** The name of every check that failed — asserted by substring so wording can change. */
function failed(result: ReturnType<typeof verify>) {
  return result.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('backup verification (P3-5)', () => {
  it('passes a faithful dump', () => {
    const result = verify();

    expect(failed(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a schema-perfect dump of an empty database — the mistargeted --env', () => {
    // The defect this whole design exists for: every table present, every CREATE correct, no
    // rows. `wrangler d1 export` exits 0 and the file looks entirely plausible in a listing.
    const result = verify({
      sql: dumpText({ rows: { users: 0, careers: 0, colleges: 0, programs: 0 } }),
      counts: { users: 0, careers: 0, colleges: 0, programs: 0 },
    });

    expect(result.ok).toBe(false);
    expect(failed(result).join(' ')).toContain('load-bearing');
  });

  it('rejects a dump that is missing a table the database has', () => {
    const result = verify({ sql: dumpText({ tables: ['users', 'careers', 'colleges'] }) });

    expect(result.ok).toBe(false);
    expect(failed(result).join(' ')).toContain('CREATE TABLE');
  });

  it('rejects a dump that lost rows', () => {
    // Not zero — one row short. A truncated download or an export cut off mid-table produces
    // exactly this, and it is invisible to every structural check.
    const result = verify({ sql: dumpText({ rows: { users: 2, careers: 2, colleges: 1, programs: 1 } }) });

    expect(result.ok).toBe(false);
    expect(failed(result).join(' ')).toContain('rows');
  });

  it('rejects a dump with more rows than the database ever held', () => {
    const result = verify({ sql: dumpText({ rows: { users: 9, careers: 3, colleges: 1, programs: 1 } }) });

    expect(result.ok).toBe(false);
  });

  it('accepts a count that moved during the export, within the bracket', () => {
    // A production backup runs against a database taking writes. The snapshot legitimately lands
    // between the two observations, and a strict equality check would fail a *correct* backup —
    // which is how a check gets removed rather than fixed.
    const result = verify({
      sql: dumpText({ rows: { users: 4, careers: 3, colleges: 1, programs: 1 } }),
      counts: { users: 2, careers: 3, colleges: 1, programs: 1 },
      countsAfter: { users: 7, careers: 3, colleges: 1, programs: 1 },
    });

    expect(failed(result)).toEqual([]);
  });

  it('still rejects a count outside the bracket, so the range is not a licence', () => {
    const result = verify({
      sql: dumpText({ rows: { users: 99, careers: 3, colleges: 1, programs: 1 } }),
      counts: { users: 2, careers: 3, colleges: 1, programs: 1 },
      countsAfter: { users: 7, careers: 3, colleges: 1, programs: 1 },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a dump carrying a migration this checkout does not have', () => {
    // The database is ahead of the code. Restoring it produces a schema the deployed Worker does
    // not expect, and the person running the restore has to learn that before, not after.
    const result = verify({
      sql: dumpText({ migrations: ['0001_identity_and_access.sql', '0099_from_the_future.sql'] }),
    });

    expect(result.ok).toBe(false);
    expect(failed(result).join(' ')).toContain('migration');
  });

  it('warns, but does not fail, when the database is behind the repo', () => {
    // A database without today's migration still backs up perfectly. Failing here would block
    // backups precisely while a deploy is half-done — the worst possible time not to have one.
    const result = verify({
      repoMigrations: ['0001_identity_and_access.sql', '0002_audit_logs.sql'],
    });

    expect(failed(result)).toEqual([]);
    expect(result.warnings.join(' ')).toContain('0002_audit_logs.sql');
  });

  it('rejects an empty file outright', () => {
    const result = verify({ sql: '', dumpBytes: 0 });

    expect(result.ok).toBe(false);
  });
});

describe('dump parsing (P3-5)', () => {
  it('counts one row per INSERT and reads the migration ledger', () => {
    const dump = parseDump(dumpText({ migrations: ['0001_a.sql', '0002_b.sql'] })) as {
      tables: Set<string>;
      rowCounts: Record<string, number>;
      migrations: string[];
    };

    expect(dump.rowCounts.careers).toBe(3);
    expect(dump.tables.has('colleges')).toBe(true);
    expect(dump.migrations).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('reads quoted and unquoted table names alike', () => {
    // D1 writes `CREATE TABLE users (` unquoted and `INSERT INTO "users"` quoted, in the same
    // file. A parser that handled only one form would report every table as missing its rows.
    const dump = parseDump(
      'CREATE TABLE plain (id TEXT);\nCREATE TABLE "quoted" (id TEXT);\n' +
        'INSERT INTO plain ("id") VALUES(1);\nINSERT INTO "quoted" ("id") VALUES(2);\n',
    ) as { tables: Set<string>; rowCounts: Record<string, number> };

    expect([...dump.tables].sort()).toEqual(['plain', 'quoted']);
    expect(dump.rowCounts).toEqual({ plain: 1, quoted: 1 });
  });
});

describe('drop order (P3-5)', () => {
  /**
   * The wipe that a `--wipe` restore performs, and the reason it cannot be alphabetical.
   *
   * `DROP TABLE` runs an implicit `DELETE FROM`, and deleting from a *child* makes SQLite consult
   * its **parent** for the foreign key check — so dropping the parent first fails the child's drop
   * with `no such table: main.<parent>`, an error naming a table you removed deliberately, raised
   * by a `DROP TABLE IF EXISTS` on a different one. This was found by running it, not by reading.
   */
  it('drops a child before the table it references', () => {
    const order = dropOrder([
      { name: 'assessment_dimensions', sql: 'CREATE TABLE assessment_dimensions (id TEXT PRIMARY KEY)' },
      {
        name: 'question_dimensions',
        sql: 'CREATE TABLE question_dimensions (id TEXT, dimension_id TEXT REFERENCES assessment_dimensions (id))',
      },
    ]) as string[];

    expect(order.indexOf('question_dimensions')).toBeLessThan(order.indexOf('assessment_dimensions'));
  });

  it('orders a chain end to end', () => {
    const order = dropOrder([
      { name: 'a', sql: 'CREATE TABLE a (id TEXT)' },
      { name: 'b', sql: 'CREATE TABLE b (a_id TEXT REFERENCES a (id))' },
      { name: 'c', sql: 'CREATE TABLE c (b_id TEXT REFERENCES b (id))' },
    ]) as string[];

    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('emits every table exactly once even when the references form a cycle', () => {
    // Mutually-referencing tables have no safe order at all. The guarantee is that the wipe still
    // names each table once — `PRAGMA defer_foreign_keys` is the fallback for the rest.
    const order = dropOrder([
      { name: 'x', sql: 'CREATE TABLE x (y_id TEXT REFERENCES y (id))' },
      { name: 'y', sql: 'CREATE TABLE y (x_id TEXT REFERENCES x (id))' },
    ]) as string[];

    expect([...order].sort()).toEqual(['x', 'y']);
  });

  it('ignores a self-reference', () => {
    const order = dropOrder([
      { name: 'towns', sql: 'CREATE TABLE towns (id TEXT, parent_id TEXT REFERENCES towns (id))' },
    ]) as string[];

    expect(order).toEqual(['towns']);
  });
});

/**
 * **Insert order** (P3-5), the other half of the same graph.
 *
 * `wrangler d1 export` writes rows in table-creation order, which is not dependency order:
 * `programs` is written well before `program_catalog`, and every `programs` row references it. The
 * remote importer rejects that with `FOREIGN KEY constraint failed` — and **only** the remote one
 * does, so this was invisible until a dump was pushed at a real D1 database. Ordering the rows is
 * what makes a backup restorable by the path an actual recovery takes.
 */
describe('insert order (P3-5)', () => {
  const schemas = [
    { name: 'colleges', sql: 'CREATE TABLE colleges (id TEXT PRIMARY KEY)' },
    { name: 'program_catalog', sql: 'CREATE TABLE program_catalog (id TEXT PRIMARY KEY)' },
    {
      name: 'programs',
      sql: 'CREATE TABLE programs (id TEXT, college_id TEXT REFERENCES colleges (id), program_catalog_id TEXT REFERENCES program_catalog (id))',
    },
  ];

  /** The order the backup writes rows in: `dropOrder` run backwards. One graph, two directions. */
  const insertOrder = () => (dropOrder(schemas) as string[]).slice().reverse();

  function tableSequence(sql: string) {
    return sql
      .split('\n')
      .map((line) => /^INSERT INTO "([A-Za-z_]\w*)"/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name))
      .filter((name, i, all) => all[i - 1] !== name);
  }

  it('puts every parent ahead of the tables that reference it', () => {
    // The export's own order, which is the one that fails: programs before program_catalog.
    const exported = [
      'PRAGMA defer_foreign_keys=TRUE;',
      'INSERT INTO "colleges" ("id") VALUES(\'c1\');',
      'INSERT INTO "programs" ("id") VALUES(\'p1\');',
      'INSERT INTO "program_catalog" ("id") VALUES(\'pc1\');',
      '',
    ].join('\n');

    const order = tableSequence(reorderDataForInsert(exported, insertOrder()) as string);

    expect(order.indexOf('programs')).toBeGreaterThan(order.indexOf('program_catalog'));
    expect(order.indexOf('programs')).toBeGreaterThan(order.indexOf('colleges'));
  });

  it('loses no rows and invents none', () => {
    // The reordering rewrites the file, so the check that matters is that it is still the same
    // file. `verifyBackup` compares the result against the live database, but that comparison is
    // only meaningful if a lost row is possible in the first place — so assert it directly.
    const exported = [
      'PRAGMA defer_foreign_keys=TRUE;',
      ...Array.from({ length: 5 }, (_, i) => `INSERT INTO "programs" ("id") VALUES('p${i}');`),
      ...Array.from({ length: 3 }, (_, i) => `INSERT INTO "colleges" ("id") VALUES('c${i}');`),
      '',
    ].join('\n');

    const dump = parseDump(reorderDataForInsert(exported, insertOrder()) as string) as {
      rowCounts: Record<string, number>;
    };

    expect(dump.rowCounts).toEqual({ programs: 5, colleges: 3 });
  });

  it('keeps each table rows in their original order, for self-references', () => {
    // A table referencing itself (towns → towns) has no table-level ordering that helps; the
    // exporter's row order is the only thing that does, so regrouping must not disturb it.
    const exported = ['INSERT INTO "colleges" ("id") VALUES(\'a\');', 'INSERT INTO "colleges" ("id") VALUES(\'b\');', ''].join('\n');
    const out = reorderDataForInsert(exported, insertOrder()) as string;

    expect(out.indexOf("'a'")).toBeLessThan(out.indexOf("'b'"));
  });

  it('keeps the pragma ahead of every row and parks unknown tables last', () => {
    // `sqlite_sequence` is in the dump and not in the schema graph. It is bookkeeping, never a
    // parent, so the safe place for it is after everything the graph does know about.
    const exported = [
      'PRAGMA defer_foreign_keys=TRUE;',
      'INSERT INTO "sqlite_sequence" ("name","seq") VALUES(\'x\',1);',
      'INSERT INTO "colleges" ("id") VALUES(\'c1\');',
      '',
    ].join('\n');

    const out = reorderDataForInsert(exported, insertOrder()) as string;

    expect(out.startsWith('PRAGMA defer_foreign_keys=TRUE;')).toBe(true);
    expect(out.indexOf('sqlite_sequence')).toBeGreaterThan(out.indexOf('colleges'));
  });
});

/**
 * The npm surface, guarded the way `seed-chain.test.ts` guards the seed chain: these are shell
 * strings that nothing type-checks, and the runbook, a fresh machine and any future cron all read
 * them. A `db:backup:production` silently pointing at staging is the defect this file's first
 * test describes, arriving through the other door.
 */
describe('backup scripts (P3-5)', () => {
  const scripts: Record<string, string> = packageJson.scripts;

  it('exposes a backup runner for each deployed environment, pointed at its own environment', () => {
    expect(scripts['db:backup:staging']).toContain('--env staging');
    expect(scripts['db:backup:production']).toContain('--env production');
  });

  it('routes every backup through the verifying script, never through raw `wrangler d1 export`', () => {
    // `wrangler d1 export ... --output x.sql` in package.json would look like a backup, exit 0,
    // and skip every check in this file.
    const rawExports = Object.entries(scripts)
      // `_comment:*` keys are this package.json's documentation convention — prose, never run.
      .filter(([name]) => !name.startsWith('_comment:'))
      .filter(([, command]) => command.includes('d1 export'))
      .map(([name]) => name);

    expect(rawExports).toEqual([]);
  });

  it('keeps the drill runnable, since a backup nobody has restored is a hypothesis', () => {
    expect(scripts['db:restore:drill']).toContain('restore-drill.mjs');
  });
});
