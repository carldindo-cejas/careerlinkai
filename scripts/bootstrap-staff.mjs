/**
 * Bootstrap the two staff accounts into a *remote* D1 database (FULLPLAN §57 Phase 3.5 Step 5).
 *
 * ── Why this exists rather than `wrangler d1 execute --file=seeds/0001_staff_accounts.sql` ──
 *
 * `seeds/0001` carries two PBKDF2 hashes typed into a .sql file by hand, because SQL cannot
 * derive a key. That makes it the one place in the system where a credential is *asserted*
 * rather than computed — and it drifted: the committed hashes were found (browser pass,
 * Phase 3.5) to encode the rotated local dev passwords while every comment said `ChangeMe123`.
 * Nothing caught it, because no test seeds a fresh database and then logs in.
 *
 * Committing a hash also *publishes* the password it encodes. That is tolerable for a local
 * database — and only because the first login forces a rotation (§13.1) — but a remote
 * database seeded from a public hash has a window, however short, in which anyone reading this
 * repository can open its admin account.
 *
 * So the remote path does not read a hash from a file. It **derives** one, here, at run time,
 * from a password that is either supplied or generated and printed once, using the identical
 * parameters `src/do/auth-guard.ts` uses (PBKDF2-SHA256, 600,000 iterations, 16-byte salt,
 * 256-bit key, `pbkdf2$iterations$salt$hash`). The SQL is written to a temp file *outside the
 * repository*, applied, and deleted. Nothing derived here can be committed by accident.
 *
 * The accounts still land with `must_change_password = 1`: the forced rotation is the
 * activation step (§13.1), and it stays the activation step even when the temp password was
 * never public in the first place. Belt and braces, deliberately.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────────────
 *   node scripts/bootstrap-staff.mjs --database CareerLinkAI_Staging --env staging
 *   node scripts/bootstrap-staff.mjs --database CareerLinkAI_Staging --env staging --password '…'
 *   node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --env production   # be sure
 *
 *   --local   applies to the Miniflare database instead (uses wrangler.test.toml)
 *   --print   emit the SQL to stdout and apply nothing (for review)
 *
 * The generated password is printed **once**, to stdout, and stored nowhere. If you lose it,
 * re-run this script: it uses INSERT OR REPLACE, so re-running resets the two accounts back to
 * a fresh temp password rather than failing.
 */
import { execFileSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirrors src/do/auth-guard.ts, and must keep mirroring it: this script derives a hash that the
// *Worker* has to verify, so any divergence produces an account nobody can log into. Node has no
// PBKDF2 iteration cap, so a single 600,000-iteration call succeeds here and yields a hash the
// deployed Worker — which chains under Cloudflare's 100,000-per-call ceiling — cannot verify.
// That is not hypothetical: it is what this script did on its first run. `--verify-url` below is
// the check that catches it, and it is why that flag exists.
//
// 600_000 again — §38 restored (Phase 4.5). During the D14 window this was 100_000, because the
// free Worker's 10 ms CPU budget could not hold the full derivation; verification now runs inside
// AuthGuardDO, whose 30-second budget holds on every plan, so the full work factor is back. The
// 100k hashes this script wrote in the meantime keep verifying — the cost is stored in each hash.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_MAX_ITERATIONS_PER_CALL = 100_000;
const PBKDF2_KEY_BITS = 256;
const SALT_BYTES = 16;

// The same fixed UUIDs seeds/0001 uses, so a database bootstrapped by either route has the same
// two rows and audit_logs written against one is meaningful against the other.
const ADMIN_ID = 'fa3a4f50-3b48-485d-b43a-59a302f4a67c';
const COUNSELOR_ID = 'c10cbecf-ad28-41dc-8323-7198f00e218f';
const COUNSELOR_PROFILE_ID = '055b0679-04c3-44dd-a5d0-21e6f6786114';

const ADMIN_EMAIL = 'admin@careerlinkai.online';
const COUNSELOR_EMAIL = 'counselor@careerlinkai.online';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const database = flag('database');
const env = flag('env');
const local = has('local');
const printOnly = has('print');

if (!database) {
  console.error('error: --database <NAME> is required (e.g. CareerLinkAI_Staging).');
  process.exit(1);
}
if (!local && !env) {
  console.error('error: --env <staging|production> is required unless --local is given.');
  process.exit(1);
}

/**
 * A generated password, not a memorable one. It exists to be typed once and immediately
 * rotated; making it pronounceable would only make it guessable. The alphabet excludes nothing
 * — unlike a join code (§13.2) this is copy-pasted, never read aloud off a whiteboard.
 */
function generatePassword() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  // Rejection-free here on purpose: 72 does not divide 256 evenly, so `% 72` skews the first 40
  // characters slightly. For a 24-character random password that bias is worth nothing to an
  // attacker, and unlike the join code this string is never enumerated against a keyspace.
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** The chain from src/do/auth-guard.ts — see the constants above for why it is a chain. */
async function deriveKey(password, salt, iterations) {
  let input = new TextEncoder().encode(password);
  let derived = new Uint8Array();
  let remaining = iterations;

  while (remaining > 0) {
    const rounds = Math.min(remaining, PBKDF2_MAX_ITERATIONS_PER_CALL);
    const keyMaterial = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, [
      'deriveBits',
    ]);
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

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const b64 = (u8) => Buffer.from(u8).toString('base64');

  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(derived)}`;
}

/**
 * Verify the derivation before anything is written. This catches a hash that does not encode the
 * password it claims to — but only within *this* script's own arithmetic. It cannot catch the
 * Worker deriving differently, which is the failure that actually happened. `--verify-url` can.
 */
async function verify(password, stored) {
  const [, iterations, saltRaw, hashRaw] = stored.split('$');
  const derived = await deriveKey(
    password,
    Uint8Array.from(Buffer.from(saltRaw, 'base64')),
    Number(iterations),
  );

  return Buffer.from(derived).toString('base64') === hashRaw;
}

const password = flag('password') ?? generatePassword();
const supplied = Boolean(flag('password'));

const adminHash = await hashPassword(password);
const counselorHash = await hashPassword(password);

if (!(await verify(password, adminHash)) || !(await verify(password, counselorHash))) {
  console.error('error: a hash failed to verify against the password it was just derived from.');
  process.exit(1);
}

// `strftime` rather than CURRENT_TIMESTAMP: the app writes ISO-8601 UTC (src/lib/datetime.ts) and
// the API serializes timestamps straight through, so a bootstrapped row has to look exactly like
// an app-written one — SQLite's bare CURRENT_TIMESTAMP renders `2026-07-13 14:11:05`, which
// JavaScript reads as *local* time.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const sql = `-- Generated by scripts/bootstrap-staff.mjs. Do not commit this file.
INSERT OR REPLACE INTO users (
    id, name, email, password, role, status, must_change_password, created_at, updated_at
) VALUES (
    '${ADMIN_ID}', 'CareerLinkAI Administrator', '${ADMIN_EMAIL}',
    '${adminHash}', 'admin', 'active', 1, ${NOW}, ${NOW}
);

INSERT OR REPLACE INTO users (
    id, name, email, password, role, status, must_change_password, created_at, updated_at
) VALUES (
    '${COUNSELOR_ID}', 'Maria Santos', '${COUNSELOR_EMAIL}',
    '${counselorHash}', 'counselor', 'active', 1, ${NOW}, ${NOW}
);

-- Every counselor has a profile row; the login response embeds it and the frontend's User type
-- expects it for this role.
INSERT OR REPLACE INTO counselor_profiles (
    id, user_id, first_name, last_name, phone, employee_number, specialization, created_at, updated_at
) VALUES (
    '${COUNSELOR_PROFILE_ID}', '${COUNSELOR_ID}', 'Maria', 'Santos',
    '+63 917 000 0000', 'EMP-0001', 'Career Guidance', ${NOW}, ${NOW}
);
`;

if (printOnly) {
  console.log(sql);
  process.exit(0);
}

// Outside the repository, so a stray `git add -A` cannot pick it up, and removed in a `finally`
// so a wrangler failure does not leave two live hashes on disk.
const dir = mkdtempSync(join(tmpdir(), 'careerlinkai-bootstrap-'));
const file = join(dir, 'staff.sql');

try {
  writeFileSync(file, sql, 'utf8');

  const wranglerArgs = [
    'wrangler',
    'd1',
    'execute',
    database,
    local ? '--local' : '--remote',
    ...(local ? ['--config', 'wrangler.test.toml'] : ['--env', env]),
    '-y',
    `--file=${file}`,
  ];

  execFileSync('npx', wranglerArgs, {
    cwd: new URL('../backend/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CI: 'true' },
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The check whose absence let the seed file's hashes drift, and whose absence let this script's
 * first run write hashes the Worker could not verify: **log in**.
 *
 * Deriving a hash and re-deriving it with the same code proves only that the code is
 * deterministic. The claim that matters — "this password opens this account on that deployment" —
 * can only be tested against the deployment. A 401 here means the Worker's PBKDF2 and this
 * script's PBKDF2 disagree; the accounts are already written, so this reports rather than throws,
 * but a red line is a red line.
 */
const verifyUrl = flag('verify-url');

if (verifyUrl) {
  const base = verifyUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password }),
  });
  const body = await response.json().catch(() => ({}));

  if (response.ok && body?.success && body?.data?.user?.must_change_password === true) {
    console.log(`\n✓ verified against ${base}: the admin account opens with this password,`);
    console.log('  and lands on the forced-rotation gate.');
  } else {
    console.error(`\n✗ VERIFICATION FAILED against ${base}`);
    console.error(`  HTTP ${response.status}: ${JSON.stringify(body)}`);
    console.error('  The accounts were written, but the deployed Worker cannot verify this');
    console.error("  password. The Worker's PBKDF2 and this script's PBKDF2 disagree.");
    process.exitCode = 1;
  }
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`  Bootstrapped ${database}${env ? ` (--env ${env})` : ' (--local)'}`);
console.log('');
console.log(`  ${ADMIN_EMAIL}`);
console.log(`  ${COUNSELOR_EMAIL}`);
console.log('');
console.log(`  temporary password: ${password}`);
console.log('');
if (!supplied) {
  console.log('  Generated, printed once, and stored nowhere. Copy it now.');
}
console.log('  Both accounts have must_change_password = 1: the first login is forced');
console.log('  through /change-password and this password dies there (§13.1).');
console.log('────────────────────────────────────────────────────────────');
