import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json';

/**
 * **`db:seed` must never reach a superseded catalog seed** (plan P1-3, guarding P1-0; extended to
 * seed 0004 when 0005 reset the catalog to Region VII).
 *
 * Seeds 0002 and 0004 both contain "UP Diliman", "Software Engineer", "Teacher" and a dozen more
 * of the same names under *different ids*, and neither `colleges.name` nor `careers.title` carries
 * a unique index — so `INSERT OR IGNORE` has nothing to collide on and both rows survive. Phase 0
 * chained `0001 → 0002 → 0004 → 0003` and produced 25 colleges and 78 careers with 15 duplicates.
 *
 * That is not a cosmetic problem. §27 ranks every active career, so two identically-coded
 * "Software Engineer" rows both land in the same student's top ten and the duplicate card is
 * **visible on the recommendations screen**.
 *
 * The reason this is worth a test rather than a comment: the defect is a *shell string* in
 * `package.json`. No type-checks it, no linter reads it, and the only symptom is a duplicate card
 * on a screen nobody re-checks after seeding. `db:seed` is also the command a new machine, a fresh
 * CI runner and the production runbook all run, so a regression here reaches every environment at
 * once — and it is one `&&` away at all times.
 *
 * The chain is **resolved transitively rather than string-matched.** Asserting
 * `!scripts['db:seed'].includes('0002')` would pass trivially (it names no seed file directly, only
 * other scripts) and a substring check for `db:seed:catalog` matches `db:seed:catalog:full` — the
 * one script that must be there. Following the `npm run` edges to the actual `--file=` targets is
 * the only check that asserts what is really run, and it keeps holding if the scripts are renamed.
 */

const scripts: Record<string, string> = packageJson.scripts;

/** Every `seeds/*.sql` file reached by running `npm run <name>`, in execution order. */
function resolveSeedFiles(name: string, seen: string[] = []): string[] {
  const command = scripts[name];

  // `throw` rather than `expect(...).toBeDefined()`: this runs inside a recursive walk, and an
  // assertion that does not narrow the type leaves the next line reading `command as string` —
  // a cast that would happily produce "undefined".split() if the guard were ever removed.
  if (command === undefined) {
    throw new Error(
      `package.json has no "${name}" script (chain: ${[...seen, name].join(' → ')})`,
    );
  }

  expect(seen, `"${name}" is chained into itself — npm would recurse forever`).not.toContain(
    name,
  );

  const files: string[] = [];

  // `&&`-separated segments, in order: `npm run a && npm run b` runs a then b.
  for (const segment of command.split('&&')) {
    const chained = /\bnpm\s+run\s+([\w:.-]+)/.exec(segment);

    if (chained?.[1] !== undefined) {
      files.push(...resolveSeedFiles(chained[1], [...seen, name]));
      continue;
    }

    const seedFile = /--file=\.\/seeds\/([\w.-]+\.sql)/.exec(segment);

    if (seedFile?.[1] !== undefined) {
      files.push(seedFile[1]);
    }
  }

  return files;
}

/**
 * The superseded catalogs. Both are kept on disk and both are reachable by an explicit local
 * runner; neither may be chained into `db:seed` or pointed at a deployed database.
 *
 * 0002 is the pre-audit ten-career fixture (P1-0). 0004 joined it when seed 0005 reset the catalog
 * to Region VII: it seeds 20 institutions from Diliman to Iligan, and one of them — Silliman
 * University, in Dumaguete — is not in Region VII at all any more, RA 12000 having moved Negros
 * Oriental into the Negros Island Region. Running 0004 after 0005 does not merge the two catalogs;
 * it puts the nationwide one back on top of the regional one, and because 0005's institutions do
 * not overlap 0004's by name, `INSERT OR IGNORE` collides on nothing and every row survives.
 */
const SUPERSEDED_SEEDS = ['0002_', '0004_'];

describe('db:seed chain (P1-0 regression guard)', () => {
  it('runs staff → 0005 → ai-policy, and never a superseded catalog', () => {
    expect(resolveSeedFiles('db:seed')).toEqual([
      '0001_staff_accounts.sql',
      '0005_region7_catalog_reset.sql',
      '0003_ai_policy.sql',
    ]);
  });

  it('keeps both superseded catalogs reachable on their own', () => {
    // The fix for P1-0 was to unchain 0002, not to delete it, and 0005 treats 0004 the same way.
    // If a future change removed these scripts entirely, the assertion above would still pass
    // while a documented capability quietly disappeared — so the guard states both halves.
    expect(resolveSeedFiles('db:seed:catalog')).toEqual(['0002_academic_catalog.sql']);
    expect(resolveSeedFiles('db:seed:catalog:full')).toEqual([
      '0004_academic_catalog_expansion.sql',
    ]);
  });

  it('exposes no runner that applies a superseded catalog to a deployed database', () => {
    // `--local` targets a Miniflare SQLite file you can delete; `--remote` targets staging or
    // production, where P2-2 had to archive duplicate "Data Scientist" and "TEACHER"/"Teacher"
    // rows by hand. Reproducing a superseded catalog is a local activity, so every remote runner
    // must point at 0005.
    const remoteSuperseded = Object.entries(scripts)
      .filter(([name]) => name.startsWith('db:seed'))
      .filter(([, command]) => command.includes('--remote'))
      .filter(([, command]) => SUPERSEDED_SEEDS.some((seed) => command.includes(seed)))
      .map(([name]) => name);

    expect(remoteSuperseded).toEqual([]);
  });

  it('applies the staff seed before the catalog', () => {
    // 0001 creates the seeded staff accounts every later fixture and the runbook's step 4 assume.
    const order = resolveSeedFiles('db:seed');

    expect(order.indexOf('0001_staff_accounts.sql')).toBe(0);
  });
});
