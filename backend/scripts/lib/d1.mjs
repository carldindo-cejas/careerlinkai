/**
 * Shared D1 plumbing for the backup, restore and drill scripts (plan P3-5).
 *
 * One module rather than three copies, for the reason P2-1 already recorded about
 * `StudentRecommendationLists`: two copies of the same logic drift by definition, and the copy
 * that drifts here is the one that reads a *dump* — so a divergence between what the backup
 * script writes and what the restore script believes it is reading is discovered during an
 * incident, which is the worst possible moment.
 *
 * **This half does I/O**; the predicates that decide whether a dump is any good live in
 * `d1-dump.mjs`, which touches nothing, so the platform suite can import and fail them on
 * purpose. Both are re-exported here, so a script has one import either way.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export {
  argReader,
  dropOrder,
  formatBytes,
  MUST_NOT_BE_EMPTY,
  parseDump,
  reorderDataForInsert,
  stamp,
  verifyBackup,
} from './d1-dump.mjs';

/** `backend/`, with the leading slash Windows adds to `file:///C:/…` stripped off. */
export const backendDir = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Every `d1_databases` block in wrangler.toml, keyed by environment (`''` is the top level).
 *
 * **Read from the config rather than hardcoded**, because the failure mode of a hardcoded
 * database name in a backup script is silent and total: the name is a string nobody type-checks,
 * the export of a database that still exists but is no longer the one the Worker binds succeeds
 * and exits 0, and the manifest looks perfect every night until the restore.
 *
 * A deliberately small parser — TOML is not being interpreted here, only the four keys of one
 * repeated table are. `[[env.staging.d1_databases]]` opens a block; the next `[` closes it.
 */
export function d1Databases(tomlPath = join(backendDir, 'wrangler.toml')) {
  const found = {};
  let current = null;

  for (const line of readFileSync(tomlPath, 'utf8').split(/\r?\n/)) {
    const header = /^\s*\[\[(?:env\.([\w-]+)\.)?d1_databases\]\]/.exec(line);

    if (header) {
      current = { env: header[1] ?? '' };
      found[current.env] = current;
      continue;
    }

    // Any other table header ends the block we were reading. Without this a `database_name`
    // belonging to the *next* section would be attributed to the previous database.
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }

    if (!current) continue;

    const pair = /^\s*(\w+)\s*=\s*"([^"]*)"/.exec(line);

    if (pair) current[pair[1]] = pair[2];
  }

  return found;
}

/**
 * Every hostname that resolves to the **production** Worker, read from wrangler.toml.
 *
 * Two sources, because either alone misses a real way to reach production:
 *   · `[[env.production.routes]]` — the custom domains (`careerlinkai.online`, `www.…`), declared
 *     in config since the P3-1 cutover.
 *   · `[env.production.vars].FRONTEND_URL` — the origin the Worker believes it serves.
 *
 * **Derived, never hardcoded, and never matched on the word "production"** — the same reasoning
 * `d1-restore.mjs` uses for its own guard. This project's production *database* is called
 * `CareerLinkAI_Main`, and its production Worker answers `careerlinkai.online`; neither string
 * contains "production", so a substring check is exactly the guard that would wave it through.
 *
 * Used by scripts that mutate state a deployment cannot get back — see `walkthrough.mjs`, which
 * rotates both staff passwords to constants committed in this repository.
 */
export function productionHosts(tomlPath = join(backendDir, 'wrangler.toml')) {
  const hosts = new Set();
  let inRoutes = false;
  let inVars = false;

  for (const line of readFileSync(tomlPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*\[\[env\.production\.routes\]\]/.test(line)) {
      inRoutes = true;
      inVars = false;
      continue;
    }

    if (/^\s*\[env\.production\.vars\]/.test(line)) {
      inVars = true;
      inRoutes = false;
      continue;
    }

    if (/^\s*\[/.test(line)) {
      inRoutes = false;
      inVars = false;
      continue;
    }

    if (inRoutes) {
      const pattern = /^\s*pattern\s*=\s*"([^"]+)"/.exec(line);

      // A route pattern may carry a path (`example.com/api/*`); only the host identifies the target.
      if (pattern) hosts.add(pattern[1].split('/')[0].toLowerCase());
    }

    if (inVars) {
      const url = /^\s*FRONTEND_URL\s*=\s*"([^"]+)"/.exec(line);

      if (url) {
        try {
          hosts.add(new URL(url[1]).host.toLowerCase());
        } catch {
          // A malformed FRONTEND_URL is not this helper's problem to report.
        }
      }
    }
  }

  return hosts;
}

/**
 * True if `url` points at the production Worker. Compared on **host**, so a path, a port, a
 * trailing slash or `http` vs `https` cannot smuggle the same origin past the check.
 */
export function isProductionUrl(url, hosts = productionHosts()) {
  if (!url) return false;

  try {
    return hosts.has(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}

/** The database bound as `DB` in `env`, or a thrown error naming what is actually configured. */
export function databaseFor(env) {
  const all = d1Databases();
  const entry = all[env ?? ''];

  if (!entry?.database_name) {
    throw new Error(
      `wrangler.toml declares no d1_databases for env "${env ?? '(top level)'}" — found: ${
        Object.keys(all)
          .map((k) => k || '(top level)')
          .join(', ') || 'none'
      }`,
    );
  }

  return { name: entry.database_name, id: entry.database_id, env: env ?? '' };
}

/**
 * Wrangler's own entry point, run through `node` rather than through `npx`.
 *
 * Not a micro-optimisation. `npx` on Windows is `npx.cmd`, which Node will only spawn with
 * `shell: true`, and a shelled `execFileSync` concatenates its arguments without quoting them —
 * so `--command "SELECT name FROM sqlite_master"` arrives at wrangler as thirteen arguments and
 * fails with `Unknown arguments: name, FROM, sqlite_master, …`. Resolving the module instead
 * keeps `shell: false`, which passes arguments as arguments on every platform, and pins the
 * wrangler this package depends on rather than whatever is first on the PATH.
 */
function resolveWrangler() {
  // `require.resolve('wrangler/bin/wrangler.js')` does not work: the package's `exports` map
  // deliberately hides the bin path. Its own `bin` field is the supported way to name it, so it
  // is read from the manifest rather than hardcoded — that is the field npm itself uses.
  for (const root of [join(backendDir, 'node_modules'), join(backendDir, '..', 'node_modules')]) {
    const manifest = join(root, 'wrangler', 'package.json');

    if (!existsSync(manifest)) continue;

    const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin?.wrangler;
    const entry = join(root, 'wrangler', bin ?? 'bin/wrangler.js');

    if (existsSync(entry)) return entry;
  }

  throw new Error('wrangler is not installed — run `npm ci` in backend/.');
}

// Resolved on first use, not at import. `d1-dump.mjs` is the module the platform suite imports,
// but a stray import of *this* one from a test would otherwise throw at load time inside workerd
// — where `node:fs` is a stub and no `node_modules` exists — long before reaching an assertion.
let wranglerBin = null;

/** The resolved wrangler entry point, for callers that need to spawn it themselves. */
export function wranglerEntry() {
  wranglerBin ??= resolveWrangler();

  return wranglerBin;
}

/** Run wrangler in `backend/`, inheriting stdio. Throws on a non-zero exit. */
export function wrangler(args, { capture = false, quiet = false } = {}) {
  const result = execFileSync(process.execPath, [wranglerEntry(), ...args], {
    cwd: backendDir,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', quiet ? 'pipe' : 'inherit'] : 'inherit',
    maxBuffer: 256 * 1024 * 1024,
    // Wrangler prompts before touching a remote database; every call site here has already
    // decided, and an unanswered prompt in a 3 a.m. cron is a backup that did not happen.
    env: { ...process.env, CI: 'true' },
  });

  return capture ? result : '';
}

/**
 * `--remote --env x` / `--local --config … [--persist-to …]`, the flags every command needs.
 *
 * `persistTo` is what keeps the restore drill from being destructive: a local restore has to
 * wipe the database it loads into, and the default local database is the one `npm run dev` uses
 * all day. Pointing the drill at a temp directory means a rehearsal costs a developer nothing —
 * and a rehearsal that costs something is a rehearsal that stops being run.
 */
export function targetFlags({ env, local, config, persistTo }) {
  if (!local) return ['--remote', '--env', env];

  return [
    '--local',
    '--config',
    config ?? 'wrangler.test.toml',
    ...(persistTo ? ['--persist-to', persistTo] : []),
  ];
}

/**
 * One SQL statement against a D1 database, as parsed rows.
 *
 * `--json` sends the banner to stderr and nothing but JSON to stdout, but the slice below is
 * kept anyway: a future wrangler that prints one deprecation line to stdout would otherwise turn
 * every caller into a `JSON.parse` crash with no indication of why.
 */
export function d1Query(database, target, sql) {
  const raw = wrangler(
    ['d1', 'execute', database, ...targetFlags(target), '-y', '--json', '--command', sql],
    { capture: true, quiet: true },
  );
  const start = raw.indexOf('[');

  if (start === -1) throw new Error(`wrangler returned no JSON for: ${sql}\n${raw}`);

  return JSON.parse(raw.slice(start))[0]?.results ?? [];
}

/**
 * Application tables — everything SQLite's *and D1's* own bookkeeping is not.
 *
 * `sqlite_%` is the obvious exclusion. **`_cf_%` is not, and leaving it out breaks this whole
 * design on real D1 while passing locally**, which is the fidelity trap this project has now hit
 * four times (see `src/lib/d1-batching.ts`). A deployed D1 database carries an internal `_cf_KV`
 * table that `sqlite_master` happily lists, `wrangler d1 export` deliberately omits, and **any**
 * query against fails outright with `not authorized: SQLITE_AUTH`. So a backup verification that
 * compared `sqlite_master` against the dump would report a missing table on every single run,
 * and a `COUNT(*)` sweep including it would not run at all — neither reproducible against
 * Miniflare, which creates no such table.
 */
export function liveTables(database, target) {
  return d1Query(
    database,
    target,
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).map((row) => row.name);
}

/** Each application table with the `CREATE TABLE` that made it — the foreign keys are in there. */
export function liveTableSchemas(database, target) {
  return d1Query(
    database,
    target,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  );
}

/**
 * `COUNT(*)` for every table, in as few round trips as D1 allows.
 *
 * **Scalar subqueries in the select list, not `UNION ALL`** — and that is a platform fact, not a
 * style preference. D1 sets SQLite's compound-SELECT limit to **five terms**: a 45-table
 * `SELECT … UNION ALL SELECT …` sweep is rejected with `too many terms in compound SELECT
 * [code: 7500]`, and six terms is already too many. Miniflare uses stock SQLite, whose default
 * is 500, so the `UNION ALL` version of this function worked perfectly on every local database
 * and failed on the first real one.
 *
 * The subquery form has no such ceiling — it is one SELECT with N result columns — but it is
 * still chunked, because a schema is a thing that grows and `SQLITE_MAX_COLUMN` is the next wall
 * along. Cheapness matters here: this comparison only protects a backup if it is affordable
 * enough to run on every single one.
 */
const COUNT_COLUMNS_PER_QUERY = 40;

export function liveRowCounts(database, target, tables) {
  const counts = {};

  for (let i = 0; i < tables.length; i += COUNT_COLUMNS_PER_QUERY) {
    const batch = tables.slice(i, i + COUNT_COLUMNS_PER_QUERY);
    const sql = `SELECT ${batch.map((t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`).join(', ')}`;

    for (const [table, n] of Object.entries(d1Query(database, target, sql)[0] ?? {})) {
      counts[table] = Number(n);
    }
  }

  return counts;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
