/**
 * The guard in front of re-seeding a **remote** catalog (2026-09-22).
 *
 * Seed 0005 is a RESET: it deletes every college, program, canonical program, career and link, and
 * with them every student's stored recommendations, then writes the Bohol catalog from
 * `build-region7-seed.mjs`. That was the right tool while the seed script was the catalog's source
 * of truth. Since migrations 0040 and 0041 the catalog is edited in /admin — what each program leads
 * to, how strongly, each program's strand — and the database is the source of truth. Re-running the
 * seed against it now silently throws all of that away.
 *
 * So the remote runners go through here. Without `--confirm-delete-admin-edits` this prints what the
 * reset would destroy and exits non-zero; with it, it runs the seed exactly as before. Local
 * development (`db:seed:catalog:region7`) is untouched — a disposable database has nothing to lose.
 *
 *   node scripts/reset-catalog-remote.mjs --env production
 *   node scripts/reset-catalog-remote.mjs --env production --confirm-delete-admin-edits
 *
 * Before confirming: take a time-travel bookmark (`wrangler d1 time-travel info …`), and consider
 * exporting the mapping first (Canonical programs → Export CSV) so it can be imported back.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRANGLER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  'wrangler',
  'bin',
  'wrangler.js',
);

const DATABASES = {
  staging: 'CareerLinkAI_Staging',
  production: 'CareerLinkAI_Main',
};

const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const env = envIndex >= 0 ? args[envIndex + 1] : undefined;
const confirmed = args.includes('--confirm-delete-admin-edits');

if (env === undefined || !(env in DATABASES)) {
  console.error('reset-catalog-remote: pass --env staging or --env production.');
  process.exit(2);
}

const database = DATABASES[env];

function wrangler(extra) {
  // wrangler's own entry point under this Node, not `npx` through a shell: on Windows a shell
  // re-splits the SQL argument on its spaces and quotes, and the probe silently reads nothing.
  return spawnSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', database, '--remote', '--env', env, ...extra],
    { encoding: 'utf8' },
  );
}

/** What the reset would destroy — admin edits since the seed, and students' saved results. */
const probe = wrangler([
  '--json',
  '--command',
  [
    "SELECT 'catalog edits made in /admin' AS what, COUNT(*) AS n FROM audit_logs WHERE module = 'AcademicCatalog'",
    "SELECT 'students with saved recommendations', COUNT(DISTINCT student_id) FROM recommendations",
    "SELECT 'canonical program links', COUNT(*) FROM program_catalog_careers",
    "SELECT 'college-specific extra links', COUNT(*) FROM program_careers",
  ].join(' UNION ALL '),
]);

console.log(`\nRe-seeding the ${env} catalog (${database}) DELETES and rewrites it.\n`);

try {
  const rows = JSON.parse(probe.stdout)[0].results;

  for (const row of rows) {
    console.log(`  ${String(row.n).padStart(6)}  ${row.what}`);
  }
} catch {
  console.log('  (Could not read the current counts — is wrangler logged in with D1 access?)');
}

console.log(
  '\nEvery link, strand and grade edited in /admin is replaced by the seed script, and every' +
    "\nstudent's recommendations are deleted (they regenerate on demand).",
);

if (!confirmed) {
  console.error(
    '\nRefusing without --confirm-delete-admin-edits. Take a time-travel bookmark first:' +
      `\n  npx wrangler d1 time-travel info ${database} --env ${env}\n`,
  );
  process.exit(1);
}

console.log('\nConfirmed. Running seed 0005…\n');

const result = wrangler(['-y', '--file=./seeds/0005_region7_catalog_reset.sql']);

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
