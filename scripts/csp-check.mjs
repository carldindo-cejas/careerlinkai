/**
 * P1-2 — verify the CSP in a real browser.
 *
 * The policy in frontend/public/_headers is *reasoned*, not *run*. Two directives are judgement
 * calls, and both fail narrowly and silently in production only:
 *
 *   style-src 'unsafe-inline'  — Tailwind v4 + Framer Motion write inline `style` attributes.
 *   worker-src 'self' blob:    — pdf.js is loaded via `?url`, so same-origin; blob: is the fallback.
 *
 * This drives system Chrome (no download; Playwright's `channel: 'chrome'`) against the local
 * single-origin preview Worker — the same shape that deploys, `_headers` and all — and collects
 * every `securitypolicyviolation` event plus every console error, per page.
 */
import { randomUUID } from 'node:crypto';

import { chromium } from 'playwright';

import { isProductionUrl } from '../backend/scripts/lib/d1.mjs';

const APP = process.argv.includes('--app')
  ? process.argv[process.argv.indexOf('--app') + 1]
  : 'http://127.0.0.1:8787';

/**
 * The password this run signs in with. It may be a bootstrap temporary password (in which case the
 * §13.1 rotation gate is still armed and Leg 2 walks through it) or the current password of an
 * account already past that gate — Leg 2 handles both, which is P4-19.
 *
 * `NEW_PASSWORD` is generated per run rather than committed, for the reason `walkthrough.mjs`
 * records at length: it is rotated *onto* a real staff account, and a string literal in a public
 * repository is a disclosed credential rather than a test fixture. It is now **printed** when a
 * rotation actually happens, because a rotation nobody records is what made this script single-use.
 */
const SIGN_IN_PASSWORD = process.argv.includes('--password')
  ? process.argv[process.argv.indexOf('--password') + 1]
  : 'CspProbe123!';
const NEW_PASSWORD = `Csp!${randomUUID().replaceAll('-', '').slice(0, 16)}A9`;

/**
 * **Production is allowed behind an explicit flag, and can never be written to. Revised 2026-08-02.**
 *
 * The original guard (2026-08-01) refused production outright, and its stated reason was that the
 * CSP is a property of `_headers`, served identically everywhere, so there is nothing the check
 * needs production for. That reasoning was sound about the *policy* and wrong about the *system*:
 * P3-1 is this plan's own record of seven deploy steps reporting success while the live domain
 * served a build from April, and step 8 — a request against the real domain — is the only
 * instrument that saw it. A header can also be stripped or rewritten by anything between the
 * Worker and the browser, which is exactly the class of defect a local preview cannot show.
 *
 * What the old guard was really protecting was the **write**: the leg used to *require* the §13.1
 * rotation, so pointing it at production meant rotating a live staff password. That is no longer
 * how the leg works (P4-19) — it now signs in and only rotates if the gate is still armed, and
 * production cleared `must_change_password` in P3-1 step 9.
 *
 * So the guard is inverted rather than removed, which keeps the property it existed for:
 *
 *   • `--allow-production` must be passed deliberately, so a mistyped `--app` still refuses.
 *   • Against production the rotation is **hard-refused** at the point of use, not merely
 *     unreachable. Everything this script does there is a read: navigate, observe headers,
 *     collect violations. It signs in, which writes an audit row and moves a rate-limit counter,
 *     and it changes nothing else.
 *
 * The refusal lives at the branch as well as here because two checks are not redundant when the
 * expensive one is "we assumed the gate was already cleared".
 */
const ALLOW_PRODUCTION = process.argv.includes('--allow-production');
const TARGET_IS_PRODUCTION = isProductionUrl(APP);

if (TARGET_IS_PRODUCTION && !ALLOW_PRODUCTION) {
  console.error(`\n  ✗ ${APP} is the production deployment (backend/wrangler.toml).`);
  console.error('\n  csp-check.mjs signs in as a real staff account. Against production it will');
  console.error('  never rotate a password — but it will create a session and an audit row, so');
  console.error('  pointing at the live domain has to be deliberate rather than a typo.');
  console.error('\n  Re-run with --allow-production if that is what you meant, or against the');
  console.error('  local preview (npm run preview), which serves the same _headers file.\n');
  process.exit(1);
}

if (TARGET_IS_PRODUCTION) {
  console.log(`\n  ⚠  Running against PRODUCTION (${APP}). Reads only — rotation is refused.\n`);
}

const findings = [];
let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Install the collector before any app script runs, so a violation raised during module
 * evaluation is caught rather than missed by a listener attached after load.
 */
const COLLECTOR = `
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push({
      directive: e.effectiveDirective || e.violatedDirective,
      blocked: e.blockedURI,
      source: e.sourceFile + ':' + e.lineNumber,
    });
  });
`;

async function newPage(context, label) {
  const page = await context.newPage();
  const consoleErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));

  page.__label = label;
  page.__consoleErrors = consoleErrors;

  return page;
}

/**
 * Violations that are **known, understood and accepted** — reported, but not failures.
 *
 * This list must stay short and every entry must carry its reason, because the moment it grows
 * into a general mute the check stops being a check. The rule for adding one: the violation is
 * raised by a dependency that *catches it and degrades*, and the directive that would silence it
 * is one we are not willing to relax. Anything else is a defect and belongs in `_headers`.
 */
const ACCEPTED = [
  {
    match: (v) => v.directive === 'script-src' && v.blocked === 'eval',
    why: "Zod 4's JIT feature detection (`try { Function('') } catch`) — refused, caught, falls back to its interpreted validator. Adding 'unsafe-eval' to silence it would be a far worse trade.",
  },
];

function classify(violations) {
  const unexpected = [];
  const accepted = [];

  for (const v of violations) {
    const known = ACCEPTED.find((a) => a.match(v));
    (known ? accepted : unexpected).push(known ? { ...v, why: known.why } : v);
  }

  return { unexpected, accepted };
}

async function violationsOn(page, label) {
  // Let late work (animations, lazy fetches) settle before reading.
  await page.waitForTimeout(1200);

  const raw = await page.evaluate(() => window.__csp ?? []);
  const { unexpected, accepted } = classify(raw);

  // Console text is a second, independent witness — a violation Chrome reports but does not raise
  // an event for would otherwise pass unseen. Filtered against the same accepted list.
  const errors = page.__consoleErrors.filter(
    (e) => /refused to|content security policy/i.test(e) && !/\beval\b/i.test(e),
  );

  findings.push({ label, csp: unexpected, accepted, errors, allConsole: [...page.__consoleErrors] });
  page.__consoleErrors.length = 0;
  await page.evaluate(() => {
    window.__csp = [];
  });

  const ok = unexpected.length === 0 && errors.length === 0;

  check(
    `no unexpected CSP violation on ${label}`,
    ok,
    unexpected.length > 0
      ? unexpected.map((v) => `${v.directive} blocked ${v.blocked}`).join('; ')
      : errors.join('; '),
  );

  return ok;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
await context.addInitScript(COLLECTOR);

console.log(`\nCSP check against ${APP}\n${'─'.repeat(64)}`);

// ── Leg 1: the unauthenticated screens ───────────────────────────────────────────────────────
const page = await newPage(context, 'public');

for (const [path, label] of [
  ['/', 'landing'],
  ['/login', 'counselor login'],
  ['/admin-login', 'admin login'],
  ['/colleges', 'public colleges'],
  ['/careers', 'public careers'],
  ['/join', 'student access'],
]) {
  await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' });
  await violationsOn(page, label);
}

// ── The two judgement calls, probed directly ─────────────────────────────────────────────────
//
// These resolve the directives rather than the app: whatever the app happens to do today, this is
// what the policy permits.

// style-src 'unsafe-inline': an inline style attribute must actually apply. If the directive were
// wrong, the declaration would be dropped and the computed value would fall back.
const inlineStyleApplied = await page.evaluate(() => {
  const el = document.createElement('div');
  el.setAttribute('style', 'width: 137px');
  document.body.appendChild(el);
  const applied = getComputedStyle(el).width === '137px';
  el.remove();
  return applied;
});
check("style-src 'unsafe-inline' — inline style attributes apply", inlineStyleApplied);

// worker-src: probed with the *real* hashed pdf.worker asset this build emitted, discovered by
// reading the app chunk the same way the browser does — not a guessed filename.
// The worker is referenced from a lazy chunk, not the entry, so this walks the chunk graph the
// same way the browser would rather than guessing a filename — a guessed URL would still satisfy
// CSP (which evaluates the URL, not the response) and would report a cheerful false pass.
const pdfWorkerUrl = await page.evaluate(async () => {
  const html = await (await fetch('/')).text();
  const seen = new Set();
  const queue = [...html.matchAll(/\/assets\/([\w.-]+\.m?js)/g)].map((m) => m[1]);

  while (queue.length > 0) {
    const name = queue.shift();

    if (seen.has(name)) continue;
    seen.add(name);

    if (/^pdf\.worker/.test(name)) return `/assets/${name}`;

    const res = await fetch(`/assets/${name}`);

    if (!res.ok) continue;

    const js = await res.text();

    for (const m of js.matchAll(/["'`.]{1,2}\/?assets\/([\w.-]+\.m?js)/g)) queue.push(m[1]);
    for (const m of js.matchAll(/["'`]\.\/([\w.-]+\.m?js)/g)) queue.push(m[1]);
  }

  return null;
});

const workerExists =
  pdfWorkerUrl !== null &&
  (await page.evaluate(async (u) => (await fetch(u, { method: 'HEAD' })).ok, pdfWorkerUrl));

check(
  'the real pdf.js worker asset was located and is served',
  workerExists,
  String(pdfWorkerUrl),
);

const workerProbe = await page.evaluate(async (pdfWorker) => {
  const out = {};

  // 'self' — a same-origin /assets/ URL, exactly what `?url` produces.
  try {
    const w = new Worker(pdfWorker, { type: 'module' });
    w.terminate();
    out.self = 'allowed';
  } catch (e) {
    out.self = `BLOCKED: ${e.message}`;
  }

  // blob: — pdf.js's fallback when it cannot use the configured URL directly.
  try {
    const url = URL.createObjectURL(new Blob(['self.close()'], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.terminate();
    URL.revokeObjectURL(url);
    out.blob = 'allowed';
  } catch (e) {
    out.blob = `BLOCKED: ${e.message}`;
  }

  return out;
}, pdfWorkerUrl);

check("worker-src 'self' — same-origin pdf.js worker", workerProbe.self === 'allowed', workerProbe.self);
check('worker-src blob: — pdf.js blob fallback', workerProbe.blob === 'allowed', workerProbe.blob);

// script-src 'self' must still *refuse* an inline script — a CSP that permits everything is not a
// CSP, and this is the assertion that proves the header is being enforced at all rather than
// silently absent.
const inlineScriptBlocked = await page.evaluate(() => {
  window.__pwned = false;
  const s = document.createElement('script');
  s.textContent = 'window.__pwned = true';
  document.body.appendChild(s);
  const ran = window.__pwned;
  s.remove();
  return !ran;
});
check("script-src 'self' — an injected inline script is refused (policy is enforced)", inlineScriptBlocked);
await page.evaluate(() => {
  window.__csp = [];
});
page.__consoleErrors.length = 0;

// ── Leg 2: the authenticated admin screens, incl. the pdf.js pages ───────────────────────────
await page.goto(`${APP}/admin-login`, { waitUntil: 'networkidle' });
await page.locator('#email').fill('admin@careerlinkai.online');
await page.locator('#password').fill(SIGN_IN_PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();

/**
 * **The rotation gate is optional, and that is P4-19.**
 *
 * This leg used to *require* the §13.1 forced rotation: it waited for `/change-password`, and
 * treated anything else as a failed sign-in. That made the script **single-use per database**. It
 * completes the rotation, which clears the `must_change_password = 1` it was waiting for, and
 * rotates onto a random password it then discarded — so the second run against the same database
 * could not sign in at all, timed out after 15 s, and skipped the **nine authenticated screens**
 * behind this check. Nine of the fifteen screens this script exists to cover were unreachable on
 * every run after the first, and the report said "6 screens checked" rather than saying why.
 *
 * That is the same family as the gates P1-3 insisted on firing red — except inverted. A gate that
 * can only ever pass once is not a gate either, and this one degraded silently the moment it
 * succeeded. P4-18 asks for this script to be re-run whenever a UI item lands, which is precisely
 * the usage the old shape could not support.
 *
 * So: sign in, then branch on what the app actually did. An armed account is walked through the
 * rotation exactly as before — the flow is still covered, because `/change-password` is a real
 * screen with a real CSP — and an account already past the gate proceeds straight through. The two
 * are distinguished by observing the URL rather than by assuming either.
 */
let signedIn = false;
let rotated = false;

try {
  await page.waitForURL(
    (u) => u.pathname.includes('/change-password') || !u.pathname.includes('login'),
    { timeout: 15_000 },
  );

  if (page.url().includes('/change-password') && TARGET_IS_PRODUCTION) {
    // The one write this script can perform, refused where it would land on a live staff account.
    // Reaching here means production's rotation gate is armed again — which is a real finding
    // about the deployment, not a reason to clear it from a CSP script.
    console.error('\n  ✗ production sent this account to /change-password — its §13.1 gate is armed.');
    console.error('    Refusing to rotate a live staff password. Sign in through the UI and');
    console.error('    complete the activation there, then re-run with the new password.\n');
    await browser.close();
    process.exit(1);
  }

  if (page.url().includes('/change-password')) {
    await page.locator('#current_password').fill(SIGN_IN_PASSWORD);
    await page.locator('#password').fill(NEW_PASSWORD);
    await page.locator('#password_confirmation').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Update password' }).click();
    await page.waitForURL((u) => !u.pathname.includes('change-password'), { timeout: 15_000 });
    rotated = true;
  }

  signedIn = true;
} catch {
  signedIn = false;
}

check(
  rotated
    ? 'admin signs in and completes the §13.1 rotation gate'
    : 'admin signs in (rotation gate already cleared)',
  signedIn,
  signedIn ? page.url() : `${page.url()} — wrong password, or the account is not active`,
);

/**
 * **Printed, not discarded** — the other half of P4-19.
 *
 * The password is still generated per run and still never committed (see the note on
 * SIGN_IN_PASSWORD). But a rotation whose result nobody records is what locked the account out of
 * this script in the first place: the credential was changed on a real staff row and the only copy
 * of it went out of scope. Emitting it is what makes the *next* run possible.
 */
if (rotated) {
  console.log(`\n  ⚠  The admin password was rotated to complete the activation gate.`);
  console.log(`     Re-run this script with:  --password '${NEW_PASSWORD}'`);
  console.log(`     (generated per run and never committed — this is the only copy)\n`);
}

if (signedIn) {
  await violationsOn(page, 'admin dashboard');

  for (const [path, label] of [
    ['/admin/colleges', 'admin colleges'],
    ['/admin/careers', 'admin careers'],
    ['/admin/canonical-programs', 'admin canonical programs'],
    ['/admin/counselors', 'admin counselors'],
    ['/admin/ai-policy', 'admin AI policy'],
    ['/admin/audit-log', 'admin audit log'],
    ['/admin/assessment-templates', 'assessment builder list'],
    ['/admin/knowledge', 'admin knowledge (pdf.js)'],
  ]) {
    await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' });
    await violationsOn(page, label);
  }
}

/**
 * **Coverage is itself an assertion (P4-19).**
 *
 * Every screen behind the sign-in is skipped by an `if`, so a failed Leg 2 does not merely fail —
 * it *narrows the run*, and the old report announced that as "6 screens checked" in the same tone
 * it would have used for fifteen. A reader looking at a passing tail could not tell a full sweep
 * from a third of one. Nine screens quietly not being examined is the more expensive half of the
 * defect, because it is the half that survives a green line.
 */
const EXPECTED_SCREENS = 15;

check(
  `all ${EXPECTED_SCREENS} screens were reachable and examined`,
  findings.length === EXPECTED_SCREENS,
  `${findings.length} of ${EXPECTED_SCREENS}${signedIn ? '' : ' — the 9 authenticated screens were skipped, because Leg 2 could not sign in'}`,
);

await browser.close();

// ── Report ───────────────────────────────────────────────────────────────────────────────────
console.log(`${'─'.repeat(64)}`);

const withViolations = findings.filter((f) => f.csp.length > 0 || f.errors.length > 0);

if (withViolations.length > 0) {
  console.log('\nUnexpected CSP violations:');
  for (const f of withViolations) {
    console.log(`  ${f.label}:`);
    for (const v of f.csp) console.log(`    ${v.directive} blocked ${v.blocked} (${v.source})`);
    for (const e of f.errors) console.log(`    ${e.slice(0, 300)}`);
  }
}

// Stated every run, deliberately. An accepted violation that stops being announced is an accepted
// violation nobody re-examines when the dependency that caused it changes.
const acceptedSeen = new Map();
for (const f of findings) {
  for (const v of f.accepted) {
    const key = `${v.directive} / ${v.blocked}`;
    acceptedSeen.set(key, { why: v.why, count: (acceptedSeen.get(key)?.count ?? 0) + 1 });
  }
}

if (acceptedSeen.size > 0) {
  console.log('\nAccepted (known, degrades gracefully — not failures):');
  for (const [key, { why, count }] of acceptedSeen) {
    console.log(`  ${key}  ×${count} screens`);
    console.log(`    ${why}`);
  }
}

const otherConsole = findings.flatMap((f) =>
  f.allConsole.filter((e) => !/refused to|content security policy/i.test(e)).map((e) => [f.label, e]),
);

if (otherConsole.length > 0) {
  console.log('\nOther console errors (not CSP — reported for context):');
  for (const [label, e] of otherConsole.slice(0, 25)) console.log(`  [${label}] ${e.slice(0, 200)}`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — ${findings.length} screens checked\n`);
process.exit(failures === 0 ? 0 : 1);
