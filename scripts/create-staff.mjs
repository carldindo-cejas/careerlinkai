/**
 * Create (or reset) **one** staff account in a remote D1 database, with a chosen email.
 *
 * ── Why this exists alongside `bootstrap-staff.mjs` ──────────────────────────────────────
 *
 * `bootstrap-staff.mjs` writes *the two seed accounts* — fixed UUIDs, fixed
 * `@careerlinkai.online` addresses — because a fresh database needs exactly those two rows and
 * needs them to match `seeds/0001` so audit rows stay meaningful across either route. It cannot
 * make a third account, and it should not learn how: its whole contract is "the database now
 * looks like a bootstrapped one".
 *
 * This script is the other job — adding a staff member at a **real, reachable mailbox**. P4-2
 * made that a functional requirement rather than a convenience: `/auth/forgot-password` now
 * emails the reset link, and the two seeded addresses are on a domain that, until Email Routing
 * was enabled, had no MX records at all. An account whose email cannot receive mail cannot use
 * the feature, and Resend reports that send as a *success* — the bounce happens downstream,
 * where nothing in this system can see it.
 *
 * Everything security-shaped is inherited from `bootstrap-staff.mjs` deliberately, because the
 * reasoning has already been paid for there and divergence is the failure mode:
 *
 *   - The hash is **derived here at run time**, never read from a file. A committed hash
 *     publishes the password it encodes.
 *   - The derivation is the *chained* PBKDF2 of `src/do/auth-guard.ts` — 600,000 iterations in
 *     100,000-iteration rounds. Node has no per-call cap, so a single 600k call would succeed
 *     here and produce a hash the deployed Worker **cannot verify**. That is not hypothetical;
 *     it is what `bootstrap-staff.mjs` did on its first run, and it is why `--verify-url` exists.
 *   - The SQL is written to a temp file *outside the repository* and removed in a `finally`.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────────────
 *   node scripts/create-staff.mjs --database CareerLinkAI_Main --env production \
 *     --role admin --name 'Carl Cejas' --email you@example.com --password '…'
 *
 *   --must-change     land the account with must_change_password = 1 (see below)
 *   --print           emit the SQL and apply nothing
 *   --verify-url URL  log in against a deployment afterwards and report the result
 *
 * ── On `must_change_password`, which defaults to 0 here and to 1 there ────────────────────
 *
 * `bootstrap-staff.mjs` forces rotation because its password is *generated* — printed once,
 * possibly to a terminal that scrolls into a log, and belonging to nobody. §13.1 makes the first
 * login the activation step precisely so that value dies quickly.
 *
 * Here the password is **supplied by the operator**, who intends to keep using it. Forcing a
 * rotation would silently discard the credential they just chose and leave them locked out of
 * the account they just made — the opposite of the intent. `--must-change` restores the seed
 * behaviour when this is used to issue someone else's temporary password, which is the case
 * where §13.1 actually applies.
 */
import { execFileSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirrors src/do/auth-guard.ts. See the header: a mismatch here yields an account that is
// written successfully and cannot be logged into, which is the worst shape a bug can take.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_MAX_ITERATIONS_PER_CALL = 100_000;
const PBKDF2_KEY_BITS = 256;
const SALT_BYTES = 16;

const BACKEND_DIR = new URL('../backend/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * wrangler is invoked as `node node_modules/wrangler/bin/wrangler.js`, not as `npx wrangler`, and
 * that is load-bearing on Windows.
 *
 * `npx` is a `.cmd` shim, which `execFileSync` can only launch with `shell: true` — and that hands
 * the argv back to `cmd` to re-split on whitespace. `--command "SELECT id, role FROM users …"`
 * then arrives as a dozen separate arguments and wrangler exits on its own usage text, having
 * never seen a query. Going straight to the JS entry point means `shell: false`, which passes argv
 * through verbatim on every platform. `bootstrap-staff.mjs` never met this because `--file=<path>`
 * has no spaces to split on.
 */
const WRANGLER_JS = join(BACKEND_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const wrangler = (wranglerArgs, options = {}) =>
  execFileSync(process.execPath, [WRANGLER_JS, ...wranglerArgs], {
    cwd: BACKEND_DIR,
    env: { ...process.env, CI: 'true' },
    ...options,
  });

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const database = flag('database');
const env = flag('env');
const role = flag('role');
const name = flag('name');
const email = flag('email')?.trim().toLowerCase();
const password = flag('password');
const mustChange = has('must-change') ? 1 : 0;
const printOnly = has('print');

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

if (!database) fail('--database <NAME> is required (e.g. CareerLinkAI_Main).');
if (!env) fail('--env <staging|production> is required.');
if (role !== 'admin' && role !== 'counselor') fail("--role must be 'admin' or 'counselor'.");
if (!name) fail('--name "Full Name" is required.');
if (!email) fail('--email <address> is required.');
if (!password) fail('--password <value> is required.');

// The app lower-cases on every lookup (`forgotPassword` normalizes before querying, and the
// unique index is on the raw column), so an address stored with capitals is an account that
// silently cannot be found by the flow this script exists to enable.
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`--email does not look like an address: ${email}`);

/** The chain from src/do/auth-guard.ts — see the constants above for why it is a chain. */
async function deriveKey(secret, salt, iterations) {
  let input = new TextEncoder().encode(secret);
  let derived = new Uint8Array();
  let remaining = iterations;

  while (remaining > 0) {
    const rounds = Math.min(remaining, PBKDF2_MAX_ITERATIONS_PER_CALL);
    const keyMaterial = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
      keyMaterial,
      PBKDF2_KEY_BITS,
    );

    derived = new Uint8Array(bits);
    input = derived;
    remaining -= rounds;
  }

  return derived;
}

async function hashPassword(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(secret, salt, PBKDF2_ITERATIONS);
  const b64 = (u8) => Buffer.from(u8).toString('base64');

  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(derived)}`;
}

/** Proves this script's own arithmetic only. `--verify-url` is what proves the Worker agrees. */
async function verifyHash(secret, stored) {
  const [, iterations, saltRaw, hashRaw] = stored.split('$');
  const derived = await deriveKey(
    secret,
    Uint8Array.from(Buffer.from(saltRaw, 'base64')),
    Number(iterations),
  );

  return Buffer.from(derived).toString('base64') === hashRaw;
}

/**
 * Run a query and hand back its rows.
 *
 * `--json` rather than scraping the human table: wrangler prints a banner, a colo line and a
 * timings block around the result, and a regex over that is a parser waiting to break on the
 * next wrangler release.
 *
 * **`--command`, never `--file`, and that is the opposite of how the write path below works.**
 * wrangler treats a `--file` as a batch ingest and answers with a *summary* — `{"Total queries
 * executed": 1, "Rows read": 0, …}` — rather than the rows the SELECT matched. Reading a row back
 * through `--file` therefore always reports "no such user" *and* always looks like it succeeded,
 * which is the shape of bug this repository has paid for twice.
 */
function query(sql) {
  const raw = wrangler(
    ['d1', 'execute', database, '--remote', '--env', env, '--json', '--command', sql],
    { encoding: 'utf8' },
  );

  // wrangler prints an update-available banner and upload progress ahead of the JSON, so the
  // array has to be sought rather than assumed to start the output. Anchored to the start of a
  // line: a bare `indexOf('[')` also matches the `[` in wrangler's own `▲ [WARNING]` prefix, and
  // would then hand `JSON.parse` a line of English.
  const start = raw.search(/^\[/m);

  if (start === -1) throw new Error(`no JSON in wrangler output:\n${raw}`);

  return JSON.parse(raw.slice(start))[0].results;
}

/** Single quotes are the only metacharacter that matters — everything here lands inside '…'. */
const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

const hash = await hashPassword(password);

if (!(await verifyHash(password, hash))) {
  fail('the hash failed to verify against the password it was just derived from.');
}

// Re-runnable on purpose. A half-applied run — user row written, profile row not — is otherwise
// unrecoverable without hand-written SQL, and this script is most likely to be re-run precisely
// when the first attempt went wrong.
const existing = printOnly ? [] : query(`SELECT id, role FROM users WHERE email = ${q(email)}`);
const userId = existing[0]?.id ?? crypto.randomUUID();
const isUpdate = existing.length > 0;

if (isUpdate && existing[0].role !== role) {
  fail(
    `${email} already exists with role '${existing[0].role}', not '${role}'. ` +
      'Refusing to change a live account\'s role from here — do it through the admin UI, ' +
      'which writes the audit row that a role change is required to leave behind.',
  );
}

// strftime, not CURRENT_TIMESTAMP: the app writes ISO-8601 UTC (src/lib/datetime.ts) and the API
// serializes straight through, so a hand-written row has to look exactly like an app-written one.
// SQLite's bare CURRENT_TIMESTAMP renders `2026-08-01 14:11:05`, which JavaScript reads as *local*.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const [firstName, ...restOfName] = name.trim().split(/\s+/);
const lastName = restOfName.join(' ') || firstName;

const userSql = isUpdate
  ? `UPDATE users
   SET name = ${q(name)}, password = ${q(hash)}, status = 'active',
       must_change_password = ${mustChange}, deleted_at = NULL, updated_at = ${NOW}
   WHERE id = ${q(userId)};`
  : `INSERT INTO users (id, name, email, password, role, status, must_change_password, created_at, updated_at)
   VALUES (${q(userId)}, ${q(name)}, ${q(email)}, ${q(hash)}, ${q(role)}, 'active', ${mustChange}, ${NOW}, ${NOW});`;

// Every counselor has a profile row: the login response embeds it and the frontend's User type
// expects it for this role. Deleted-then-inserted rather than upserted because there is no unique
// index on user_id to conflict against.
const profileSql =
  role === 'counselor'
    ? `
DELETE FROM counselor_profiles WHERE user_id = ${q(userId)};

INSERT INTO counselor_profiles (id, user_id, first_name, last_name, created_at, updated_at)
VALUES (${q(crypto.randomUUID())}, ${q(userId)}, ${q(firstName)}, ${q(lastName)}, ${NOW}, ${NOW});`
    : '';

const sql = `-- Generated by scripts/create-staff.mjs. Do not commit this file.
${userSql}
${profileSql}
`;

if (printOnly) {
  console.log(sql);
  process.exit(0);
}

// Outside the repository, so a stray `git add -A` cannot pick it up, and removed in a `finally`
// so a wrangler failure does not leave a live hash on disk.
const dir = mkdtempSync(join(tmpdir(), 'careerlinkai-staff-'));
const file = join(dir, 'staff.sql');

try {
  writeFileSync(file, sql, 'utf8');

  // `--file` here, unlike the read path above: a multi-statement write is exactly what batch
  // ingest is for, and its summary is all this call needs back.
  wrangler(['d1', 'execute', database, '--remote', '--env', env, '-y', `--file=${file}`], {
    stdio: 'inherit',
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The check whose absence let `bootstrap-staff.mjs` write hashes the Worker could not verify:
 * **log in**. Re-deriving a hash with the same code proves only that the code is deterministic.
 */
const verifyUrl = flag('verify-url');

if (verifyUrl) {
  // Takes an origin *or* an API base, because both were passed on 2026-08-01 and only one
  // worked: §17 mounts the API under /api/v1, so a bare origin hits the SPA fallback and
  // answers 405 — which the first version of this check reported as a PBKDF2 mismatch.
  const origin = verifyUrl.replace(/\/+$/, '');
  const base = /\/api\/v\d+$/.test(origin) ? origin : `${origin}/api/v1`;
  const endpoint = `${base}/auth/login`;

  let response;
  let body = {};

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    console.error(`\n✗ VERIFICATION COULD NOT RUN — ${endpoint} was unreachable.`);
    console.error(`  ${error.message}`);
    console.error('  The account was written. Nothing is known about whether it verifies.');
    process.exitCode = 1;
  }

  if (response) {
    if (response.ok && body?.success) {
      console.log(`\n✓ verified against ${base}: this password opens ${email}.`);
    } else if (response.status === 401 || response.status === 422) {
      // The only shape that implicates the hash: the endpoint was reached, it read the
      // credential, and it said no.
      console.error(`\n✗ VERIFICATION FAILED against ${base}`);
      console.error(`  HTTP ${response.status}: ${JSON.stringify(body)}`);
      console.error("  The Worker's PBKDF2 and this script's PBKDF2 disagree.");
      process.exitCode = 1;
    } else {
      console.error(`\n✗ VERIFICATION INCONCLUSIVE — ${endpoint} answered HTTP ${response.status}.`);
      console.error(`  ${JSON.stringify(body)}`);
      console.error('  That is not an authentication failure: the request never reached one.');
      console.error('  Check the URL (the API is mounted under /api/v1) before suspecting the hash.');
      process.exitCode = 1;
    }
  }
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`  ${isUpdate ? 'Reset' : 'Created'} ${role} on ${database} (--env ${env})`);
console.log('');
console.log(`  ${email}`);
console.log(`  id: ${userId}`);
console.log('');
console.log(
  mustChange
    ? '  must_change_password = 1: the first login is forced through /change-password.'
    : '  must_change_password = 0: the supplied password is the working one.',
);
console.log('────────────────────────────────────────────────────────────');
