/**
 * The Phase 0–5a walkthrough (FULLPLAN §57 — the Phase 3.5 Step 5 exit criterion, since
 * extended with Phase 4's recommendations leg and Phase 5a's knowledge → explanation leg).
 *
 * One continuous run, in a real browser, through the unchanged React frontend: an admin activates
 * their account and builds the catalog, a counselor provisions a roster and assigns an assessment,
 * and a student — who has no password and never sees a class code again after typing it — completes
 * 60 items and gets a scored Holland Code back. Every Phase 0–3 demo in §57, in the order a real
 * deployment would actually be used.
 *
 * This is the merge of the two earlier scripts (`browser-walkthrough.mjs`, Steps 1–3, and
 * `step4-player-walkthrough.mjs`, Step 4), which §57 always intended to become one run rather than
 * two. It is **environment-agnostic**: the same script proves the local Worker and the staging
 * deployment, because a walkthrough that only runs against localhost cannot close a step whose
 * entire point is that the thing works somewhere other than localhost.
 *
 * ── Running it ──────────────────────────────────────────────────────────────────────────────
 *
 *  Against STAGING:
 *     1. node scripts/bootstrap-staff.mjs --database CareerLinkAI_Staging --env staging \
 *          --verify-url https://<worker>/api/v1
 *        → prints a fresh temporary password. Both staff accounts are back to
 *          `must_change_password = 1`, which is what leg A and leg B start from.
 *     2. node scripts/walkthrough.mjs \
 *          --app https://careerlinkai-staging.pages.dev \
 *          --api https://<worker>/api/v1 \
 *          --password '<the temp password>'
 *
 *  Against LOCAL:
 *     1. cd backend && npx wrangler dev --config wrangler.test.toml --port 8787
 *        (the *test* config: ~3s boot, fully offline — it drops the [ai] and [[vectorize]]
 *         bindings, which have no local emulation and always dial out to Cloudflare.)
 *     2. cd frontend && npx vite --port 5173   (5173 is the Worker's CORS allow-list, FRONTEND_URL.)
 *     3. node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --local --password ChangeMe123
 *     4. node scripts/walkthrough.mjs --app http://localhost:5173 \
 *          --api http://localhost:8787/api/v1 --password ChangeMe123
 *
 * **Re-running requires re-running the bootstrap.** Rotating a password is a one-way door, and legs
 * A and B both rotate. A rerun that fails at the very first check is almost always a missing
 * bootstrap, not a regression. `bootstrap-staff.mjs` uses INSERT OR REPLACE precisely so that it is
 * the reset.
 *
 * Playwright's own Chromium is not used: cdn.playwright.dev is unreachable from this environment
 * and `npx playwright install` exits 0 having downloaded nothing, so the failure surfaces much
 * later as "Executable doesn't exist". We drive the system Chrome — which is a browser a real user
 * of this app would actually use.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const APP = (flag('app', 'http://localhost:5173') ?? '').replace(/\/$/, '');
const API = (flag('api', 'http://localhost:8787/api/v1') ?? '').replace(/\/$/, '');
const TEMP_PASSWORD = flag('password', 'ChangeMe123');
const CHROME = flag('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const HEADED = args.includes('--headed');

// The passwords the two staff accounts are rotated *to*. They only have to survive this run.
const ADMIN_PASSWORD = 'Walkthrough@Admin1';
const COUNSELOR_PASSWORD = 'Walkthrough@Counselor1';

// Everything this run creates is stamped, so a second run against the same database does not
// collide with the first on a uniqueness rule (college name, career title — both case-insensitive
// live-row checks, §Academic Catalog).
const STAMP = Date.now().toString().slice(-6);

const SHOTS = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const apiCalls = [];
const consoleErrors = [];
const pageErrors = [];
let shotN = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

function writeReport() {
  writeFileSync(
    new URL('./report.json', import.meta.url),
    JSON.stringify(
      { app: APP, api: API, results, consoleErrors, pageErrors, apiCalls },
      null,
      2,
    ),
  );
}

// A crash in a late leg must not throw away the evidence the earlier ones produced.
process.on('uncaughtException', (error) => {
  console.error(`\nCRASHED: ${error.message}`);
  writeReport();
  process.exit(1);
});

async function shot(page, label) {
  shotN += 1;
  await page.screenshot({
    path: `${SHOTS}${String(shotN).padStart(2, '0')}-${label}.png`,
    fullPage: true,
  });
}

/** Wire a context so every API call, console error and uncaught error is recorded. */
function instrument(page, who) {
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push({ who, text: m.text() }));
  page.on('pageerror', (e) => pageErrors.push({ who, text: String(e) }));
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith(API)) return;

    let body = null;
    try {
      body = await res.json();
    } catch {
      /* preflight, or a non-JSON body */
    }

    apiCalls.push({
      who,
      method: res.request().method(),
      path: url.slice(API.length),
      status: res.status(),
      body,
    });
  });
}

const lastCall = (fragment, method) =>
  [...apiCalls]
    .reverse()
    .find((c) => c.path.includes(fragment) && c.body && (method ? c.method === method : true));

/**
 * `lastCall`, but waits for the call to actually be recorded.
 *
 * `apiCalls` is filled by an async listener (it awaits `res.json()`), so a call the browser has
 * already made may not be in the array yet when an assertion reads it. Against a *local* Worker the
 * gap is invisible; against staging it is not, and it produced assertions that failed with
 * `status undefined` on requests the server had answered perfectly well. Sleeping longer is a guess;
 * waiting for the evidence is not.
 */
async function waitForCall(page, fragment, method, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = lastCall(fragment, method);
    if (found) return found;
    await page.waitForTimeout(200);
  }

  return undefined;
}

const answerCount = () => apiCalls.filter((c) => c.path.includes('/answers')).length;

/**
 * Answer every item of an attempt through the UI, one click per question.
 *
 * **Each click waits for its own answer POST to land before the next one is made.** The player
 * auto-advances 150ms after a choice, and the original loop simply slept a little longer than that
 * — which held against a local Worker and did not against staging, where the round trip is slower
 * than the animation. The clicks then ran ahead of the re-render: the same question was answered
 * twice and the one behind it never at all, so the run POSTed the right *number* of answers and the
 * server still refused the submit with "1 required question(s) are still unanswered". The server was
 * right. Waiting on the POST, rather than on a stopwatch, removes the race instead of hiding it.
 */
async function answerEveryItem(page, questions, labelFor) {
  let answered = 0;

  for (const question of questions) {
    const before = answerCount();

    try {
      await page
        .getByRole('button', { name: labelFor(question), exact: true })
        .first()
        .click({ timeout: 10_000 });
    } catch {
      break;
    }

    const deadline = Date.now() + 15_000;
    while (answerCount() === before && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }

    if (answerCount() === before) break; // The click produced no answer — stop rather than skew.

    answered += 1;
    await page.waitForTimeout(150); // Let the next question paint before clicking into it.
  }

  return answered;
}

/**
 * A minimal but real single-page PDF, one line of text per Tj operator — exactly enough for
 * pdf.js (the browser-side extractor, §33) to read the full text back out. The Worker never
 * parses it; the file exists because the Knowledge screen requires a real file and keeps it
 * in R2 for provenance. Lines must be WinAnsi-safe ASCII.
 */
function makeGuidancePdf(lines) {
  const escape = (line) => line.replace(/[\\()]/g, (m) => `\\${m}`);
  const stream = lines
    .map((line, i) => `BT /F1 10 Tf 40 ${740 - i * 14} Td (${escape(line)}) Tj ET`)
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Sign a staff member in on a temporary password and walk them through the forced rotation.
 *
 * This *is* the §13.1 activation model, not a preamble to it: there is no self-registration
 * anywhere in this system, so the only way an account becomes usable is that someone who was
 * handed a temporary password changes it. Both staff accounts start here.
 */
async function activateStaff(page, email, newPassword, who) {
  await page.goto(`${APP}/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(TEMP_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The temp password must NOT open the app — it must land on the rotation gate and nothing else.
  await page.waitForURL('**/change-password', { timeout: 30_000 });
  check(`[${who}] the temporary password opens only /change-password`, true);
  await shot(page, `${who}-forced-rotation`);

  await page.locator('#current_password').fill(TEMP_PASSWORD);
  await page.locator('#password').fill(newPassword);
  await page.locator('#password_confirmation').fill(newPassword);
  await page.getByRole('button', { name: 'Update password' }).click();

  // Changing a password revokes every session (§38), so the client must be signed out.
  await page.waitForURL('**/login', { timeout: 30_000 });
  check(`[${who}] rotating the password revokes the session and returns to /login`, true);

  // The temp password must now be dead.
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(TEMP_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(3000);
  check(
    `[${who}] the old temporary password no longer works`,
    page.url().includes('/login'),
    page.url().replace(APP, ''),
  );

  await page.locator('#email').fill(email);
  await page.locator('#password').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  check(
    `[${who}] the rotated password signs in and clears the gate`,
    !page.url().includes('change-password'),
    page.url().replace(APP, ''),
  );
}

/** The bearer token the app is holding — only the token is persisted (authStore, §35). */
async function tokenOf(page) {
  const raw = await page.evaluate(() => localStorage.getItem('careerlinkai.auth'));
  return JSON.parse(raw ?? '{}')?.state?.token ?? null;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED });

console.log(`\napp: ${APP}\napi: ${API}\n`);

// ══════════════════════════════════════════════════════════════════════════════════════
// A. ADMIN — activation, the RIASEC/SCCT instruments, and the academic catalog (Phase 0, 2)
// ══════════════════════════════════════════════════════════════════════════════════════
const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const admin = await adminCtx.newPage();
instrument(admin, 'admin');

await activateStaff(admin, 'admin@careerlinkai.online', ADMIN_PASSWORD, 'admin');

// The instruments (D13). Reached over HTTP rather than through a .sql seed on purpose: §57 requires
// RIASEC and SCCT to be published **through the real AssessmentBuilderService**, so they pass the
// same §25 confirmation gate a counselor would — a seed writing `status = 'PUBLISHED'` straight
// into the table would appear to prove the gate works while demonstrating exactly how to bypass it.
// There is no UI for this (it is not in §20's catalog), so the script calls it as the admin.
const adminToken = await tokenOf(admin);
check('[admin] the app is holding a bearer token', Boolean(adminToken));

const seeded = await fetch(`${API}/admin/assessment-templates/seed-instruments`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
});
check(
  '[admin] RIASEC + SCCT install through the real builder service (D13, idempotent)',
  seeded.ok,
  `HTTP ${seeded.status}`,
);

// ── The catalog: college → program → career → mapping ──────────────────────────────────
await admin.goto(`${APP}/admin/colleges`);
await admin.getByRole('button', { name: 'Add college' }).click();
await admin.locator('#college-name').fill(`Walkthrough University ${STAMP}`);
await admin.locator('#college-description').fill('Created by the Phase 0-3 walkthrough.');
await admin.locator('form').getByRole('button', { name: 'Add college' }).click();
await admin.waitForURL(/\/admin\/colleges\/[0-9a-f-]{36}/, { timeout: 30_000 });
await admin.waitForTimeout(1500);
const collegeUrl = admin.url();
check(
  '[admin] creates a college',
  lastCall('/admin/colleges', 'POST')?.status === 201,
  `status ${lastCall('/admin/colleges', 'POST')?.status}`,
);
await shot(admin, 'admin-college');

await admin.getByRole('button', { name: 'Add program' }).click();
await admin.locator('#program-code').fill('BSCS');
await admin.locator('#program-name').fill('BS Computer Science');
await admin.locator('#program-department').fill('College of Computer Studies');
await admin.locator('#program-strand').selectOption('Academic');
await admin.locator('#program-status').selectOption('active');
await admin.locator('form').getByRole('button', { name: /Add program|Save/ }).click();
await admin.waitForTimeout(3500);
check(
  '[admin] adds a program under the college',
  lastCall('/programs', 'POST')?.status === 201,
  `status ${lastCall('/programs', 'POST')?.status}`,
);
check(
  '[admin] the new program is listed on the college',
  (await admin.locator('body').innerText()).includes('BSCS'),
);

await admin.goto(`${APP}/admin/careers`);
await admin.getByRole('button', { name: 'Add career' }).click();
await admin.locator('#career-title').fill(`Software Engineer ${STAMP}`);
await admin.locator('#career-riasec').fill('iec'); // lowercase in — uppercase stored
await admin.locator('#career-salary').fill('PHP 40,000 - 120,000/mo');
await admin.locator('#career-outlook').fill('High demand');
await admin.locator('form').getByRole('button', { name: 'Add career' }).click();
await admin.waitForTimeout(3500);

const careerCall = lastCall('/admin/careers', 'POST');
check('[admin] creates a career', careerCall?.status === 201, `status ${careerCall?.status}`);
check(
  '[admin] a lowercase RIASEC code is normalised to uppercase (iec → IEC)',
  careerCall?.body?.data?.typical_riasec_code === 'IEC',
  `stored "${careerCall?.body?.data?.typical_riasec_code}"`,
);

// The mapping is scored data, not decoration: it is what §27 averages a program's RIASEC over.
await admin.goto(collegeUrl);
await admin.waitForTimeout(3000);
const mapSelect = admin.locator('select[id^="link-career-"]').first();

if (await mapSelect.count()) {
  await mapSelect.selectOption({ label: `Software Engineer ${STAMP} (IEC)` });
  await admin.getByRole('button', { name: 'Link' }).first().click();
  await admin.waitForTimeout(3000);
  const mapCall = lastCall('/careers', 'POST');
  check(
    '[admin] maps the career to the program',
    mapCall?.status === 201 || mapCall?.status === 200,
    `status ${mapCall?.status}`,
  );
  check(
    '[admin] the mapped career appears on the program',
    (await admin.locator('body').innerText()).includes(`Software Engineer ${STAMP}`),
  );
} else {
  check('[admin] maps the career to the program', false, 'career-link select never rendered');
}
await shot(admin, 'admin-catalog-mapped');

// ══════════════════════════════════════════════════════════════════════════════════════
// B. COUNSELOR — activation, a class, a roster, an assignment (Phase 0, 1, 3)
// ══════════════════════════════════════════════════════════════════════════════════════
const counselorCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const counselor = await counselorCtx.newPage();
instrument(counselor, 'counselor');

await activateStaff(counselor, 'counselor@careerlinkai.online', COUNSELOR_PASSWORD, 'counselor');

await counselor.goto(`${APP}/counselor/classes`);
await counselor.getByRole('button', { name: 'New class' }).click();
await counselor.locator('#name').fill(`Grade 12 STEM A — Walkthrough ${STAMP}`);
await counselor.locator('#academic_year').fill('2026-2027');
await counselor.locator('#grade_level').fill('Grade 12');
await counselor.getByRole('button', { name: 'Create class' }).click();
await counselor.waitForURL(/\/counselor\/classes\/[0-9a-f-]{36}/, { timeout: 30_000 });
await counselor.waitForTimeout(2000);

const classId = counselor.url().split('/').pop();
const classBody = await counselor.locator('body').innerText();
const joinCode = (classBody.match(/\b[A-HJ-NP-Z]{4}-[2-9]{4}\b/) ?? [])[0];
check('[counselor] class created; the join code is rendered', Boolean(joinCode), joinCode ?? 'none');
// A student hand-types this: an O misread as a 0 would be an undebuggable dead end, because a
// failed join deliberately tells them nothing about why (§38).
check(
  '[counselor] the join code excludes the ambiguous alphabet (I, O, 0, 1)',
  Boolean(joinCode) && !/[IO01]/.test(joinCode),
  joinCode ?? '',
);
await shot(counselor, 'counselor-class');

// ── Roster: preview → edit → confirm ──────────────────────────────────────────────────
await counselor.locator('#names').fill('Juan Dela Cruz\nJuan Dela Cruz\nJosé Peña\nMadonna');
await counselor.getByRole('button', { name: 'Generate usernames' }).click();
await counselor.waitForSelector('#username-0', { timeout: 30_000 });

const proposed = [];
for (let i = 0; i < 4; i += 1) {
  proposed.push(await counselor.locator(`#username-${i}`).inputValue());
}
check(
  '[counselor] preview: duplicate suffixed, accents folded, mononym kept',
  JSON.stringify(proposed) ===
    JSON.stringify(['juan.delacruz', 'juan.delacruz2', 'jose.pena', 'madonna']),
  proposed.join(', '),
);
check(
  '[counselor] preview: the mononym has no last name (NULL, not "")',
  (await counselor.locator('#last-name-3').inputValue()) === '',
);
check(
  '[counselor] preview persists nothing — it is the counselor who decides',
  lastCall('/students/preview')?.status === 200,
);
await shot(counselor, 'counselor-roster-preview');

// The counselor edits a username before any account exists. That is the entire point of the
// two-step: a proposed username is a proposal.
await counselor.locator('#username-2').fill('jose.pena.edited');
await counselor.getByRole('button', { name: /^Confirm 4 students$/ }).click();
await counselor.waitForTimeout(4000);

const confirmCall = lastCall('/students/confirm');
check(
  '[counselor] confirm creates the accounts in one batch',
  confirmCall?.status === 201 || confirmCall?.status === 200,
  `status ${confirmCall?.status}`,
);
check(
  '[counselor] the roster shows the edited username, not the proposed one',
  (await counselor.locator('body').innerText()).includes('jose.pena.edited'),
);
await shot(counselor, 'counselor-roster-confirmed');

// ── Assign RIASEC. What is assigned is a *published version*, never a template (§13.4). ──
// The <option> value is the *version* id, not the template id: a template with no published
// version is not offered at all, so picking by option text is picking a version by construction.
const riasecOption = counselor.locator('#assessment option', { hasText: 'RIASEC' }).first();
// `attached`, not the default `visible`: an <option> is never "visible" to Playwright, so waiting
// on visibility here waits forever on an element that is already there.
await riasecOption.waitFor({ state: 'attached', timeout: 30_000 });
const riasecVersionId = await riasecOption.getAttribute('value');
check(
  '[counselor] the picker offers RIASEC because it has a PUBLISHED version',
  Boolean(riasecVersionId),
  (await riasecOption.textContent())?.trim(),
);

await counselor.locator('#assessment').selectOption(riasecVersionId);
await counselor.getByRole('button', { name: 'Assign' }).click();
await counselor.waitForTimeout(4000);

const assignCall = lastCall('/assignments', 'POST');
check(
  '[counselor] assigns RIASEC to the class',
  assignCall?.status === 201 || assignCall?.status === 200,
  `status ${assignCall?.status}`,
);

await shot(counselor, 'counselor-assigned');

// SCCT is assigned later, in leg D, deliberately — see the note there. Phase 4 needs *both*
// instruments (§27), but assigning both up front would leave two startable assignments on the
// student's screen at once, and "click the first Start button" is then a coin toss rather than a
// test. Assigning it after RIASEC is finished is also simply what a counselor does.

// ══════════════════════════════════════════════════════════════════════════════════════
// C. STUDENT — passwordless join, the player, the score (Phase 1, 3)
// ══════════════════════════════════════════════════════════════════════════════════════
const studentCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const student = await studentCtx.newPage();
instrument(student, 'student');

// A wrong code must say nothing useful. Every failure mode — unknown code, expired code, unknown
// username, removed enrolment — answers with the *same bytes* (§38); the real reason goes only to
// the audit log.
await student.goto(`${APP}/join`);
await student.locator('#class_code').fill('ZZZZ-9999');
await student.locator('#username').fill('juan.delacruz');
await student.getByRole('button', { name: 'Sign in' }).click();
await student.waitForTimeout(3000);

const badJoin = lastCall('/student-access/join');
check(
  '[student] a wrong class code returns the generic 401',
  badJoin?.status === 401 && badJoin?.body?.message === 'The class code or username is incorrect.',
  `${badJoin?.status} "${badJoin?.body?.message}"`,
);
await shot(student, 'student-wrong-code');

await student.locator('#class_code').fill(joinCode);
await student.locator('#username').fill('juan.delacruz');
await student.getByRole('button', { name: 'Sign in' }).click();
await student.waitForURL('**/student**', { timeout: 30_000 });
await student.waitForTimeout(2500);
check('[student] joins with only a class code and a username', true, student.url().replace(APP, ''));

const goodJoin = lastCall('/student-access/join');
const joinBody = JSON.stringify(goodJoin?.body ?? {});
check(
  '[student] the join response leaks neither join_code nor counselor_id',
  !joinBody.includes('join_code') && !joinBody.includes('counselor_id'),
);
check(
  '[student] the student UI never renders the class join code',
  !(await student.locator('body').innerText()).includes(joinCode),
);

// ── The D11 trap ──────────────────────────────────────────────────────────────────────
// Every Phase 3 screen renders a failed request as an *empty* one: StudentDashboardPage has no
// isError branch, so "Nothing to do yet" is what a student sees whether they have no assignments
// or the endpoint is 404ing. A half-working backend would look exactly like a working one here, so
// this asserts on the API call AND on the absence of the empty state.
const assignmentsCall = lastCall('/student/assignments');
check(
  '[student] GET /student/assignments answers 200',
  assignmentsCall?.status === 200,
  `status ${assignmentsCall?.status}`,
);
check(
  '[student] the dashboard does NOT show "Nothing to do yet" (D11 — a 404 looks identical)',
  !/nothing to do yet/i.test(await student.locator('body').innerText()),
  `${assignmentsCall?.body?.data?.length ?? 0} assignment(s)`,
);
await shot(student, 'student-dashboard');

await student.goto(`${APP}/student/profile`);
await student.waitForTimeout(2500);
check(
  '[student] GET /student/profile answers 200 and reports what §27 still needs',
  lastCall('/student/profile')?.status === 200,
  `missing=${JSON.stringify(lastCall('/student/profile')?.body?.data?.missing_for_recommendations)}`,
);

// ── The player ────────────────────────────────────────────────────────────────────────
await student.goto(`${APP}/student/assessments`);
await student.waitForTimeout(2500);
await student
  .getByRole('button', { name: /start|continue|resume/i })
  .first()
  .click();
await student.waitForTimeout(4000);

const startCall = lastCall('/start');
check('[student] POST .../start answers 200', startCall?.status === 200);

// THE assertion of the whole player. A student who can see that item 14 loads onto Investigative,
// and that "Strongly Agree" is worth 5, answers the Holland Code they *want* rather than the one
// they have — and the instrument stops measuring anything.
const rawStart = JSON.stringify(startCall?.body ?? {});
check('[student] the player payload carries NO option score', !/"score"/.test(rawStart));
check('[student] the player payload carries NO dimension', !/dimension/i.test(rawStart));
check(
  '[student] the player payload has 60 questions',
  startCall?.body?.data?.questions?.length === 60,
  `${startCall?.body?.data?.questions?.length}`,
);
check(
  '[student] section_label IS sent (the deliberate, limited disclosure)',
  startCall?.body?.data?.questions?.[0]?.section_label === 'Realistic',
);
await shot(student, 'student-player');

// Answers shaped so the result is hand-computable: Strongly Agree on every Investigative item,
// Agree on every Artistic one, Strongly Disagree everywhere else → Holland Code "IAR", with
// Investigative at exactly 100.00. A scoring engine checked only against itself proves nothing.
const questions = startCall.body.data.questions;

const answered = await answerEveryItem(student, questions, (q) =>
  q.section_label === 'Investigative'
    ? 'Strongly Agree'
    : q.section_label === 'Artistic'
      ? 'Agree'
      : 'Strongly Disagree',
);

check('[student] answered all 60 items through the UI', answered === 60, `${answered} answered`);

const answerCalls = apiCalls.filter((c) => c.path.includes('/answers'));
check(
  '[student] every answer was POSTed and accepted',
  answerCalls.length >= 60 && answerCalls.every((c) => c.status === 200),
  `${answerCalls.length} calls, ${answerCalls.filter((c) => c.status !== 200).length} failed`,
);
check(
  '[student] the UI reports all 60 answered and enables submit',
  /All 60 questions answered/i.test(await student.locator('body').innerText()),
);

await student.getByRole('button', { name: 'Submit assessment' }).click();

const submitCall = await waitForCall(student, '/submit', 'POST');
check(
  '[student] POST .../submit scores INLINE — the result is in the same response',
  submitCall?.status === 200 && Boolean(submitCall?.body?.data?.result),
  `status ${submitCall?.status}`,
);

const scored = submitCall?.body?.data;
check(
  '[student] the Holland Code is "IAR", as hand-computed before the run',
  scored?.result?.result_code === 'IAR',
  `got ${scored?.result?.result_code}`,
);

const investigative = scored?.dimensions?.find((d) => d.code === 'I');
check(
  '[student] Investigative = 100.00 / "High Interest"',
  investigative?.normalized_score === '100.00' && investigative?.interpretation === 'High Interest',
  `${investigative?.normalized_score} ${investigative?.interpretation}`,
);
check(
  '[student] all 6 dimensions scored (every one was answered)',
  scored?.dimensions?.length === 6,
  `${scored?.dimensions?.length}`,
);

await student.waitForTimeout(2500);
const resultText = await student.locator('body').innerText();
check('[student] the result screen renders the Holland Code', /IAR/.test(resultText));
check('[student] the result screen renders the per-dimension breakdown', /Investigative/i.test(resultText));
await shot(student, 'student-result');

// ══════════════════════════════════════════════════════════════════════════════════════
// D. PHASE 4 — SCCT, then the deterministic recommendations (§11 v1.2, §26, §27)
// ══════════════════════════════════════════════════════════════════════════════════════

// With RIASEC done and SCCT not, the student must have NO recommendations — and the screen has to
// say so honestly rather than showing an empty list. This is the both-results-exist rule (§11,
// v1.2) observed from the outside, and it is the check that would catch a listener that generated
// on the first result it saw.
await student.goto(`${APP}/student/recommendations`);
await student.waitForTimeout(3000);

const beforeScct = lastCall('/student/recommendations');
check(
  '[student] GET /student/recommendations answers 200 with data:null after RIASEC alone',
  beforeScct?.status === 200 && beforeScct?.body?.data === null,
  `status ${beforeScct?.status}, data ${JSON.stringify(beforeScct?.body?.data)}`,
);
check(
  '[student] the screen says "finish both assessments" — not an empty list (§11 v1.2)',
  /finish both assessments/i.test(await student.locator('body').innerText()),
);
await shot(student, 'student-recommendations-not-yet');

// --- The counselor assigns SCCT, now that RIASEC is done -----------------------------------
// Assigned here rather than alongside RIASEC so that exactly one assignment is ever startable at a
// time: with both on screen, "click the first Start button" would be picking at random. It is also
// the realistic sequence — a counselor runs the interest inventory, then the confidence scale.
const scctOption = counselor.locator('#assessment option', { hasText: 'SCCT' }).first();
await counselor.goto(`${APP}/counselor/classes/${classId}`);
await counselor.waitForTimeout(3000);
await scctOption.waitFor({ state: 'attached', timeout: 30_000 });
const scctVersionId = await scctOption.getAttribute('value');

await counselor.locator('#assessment').selectOption(scctVersionId);
await counselor.getByRole('button', { name: 'Assign' }).click();
await counselor.waitForTimeout(4000);

check(
  '[counselor] assigns SCCT after RIASEC is complete — §27 needs both instruments',
  (lastCall('/assignments', 'POST')?.status ?? 0) < 400,
  `status ${lastCall('/assignments', 'POST')?.status}`,
);

// --- SCCT ---------------------------------------------------------------------------------
// RIASEC's card now offers "See my result", so the only Start button on this page is SCCT's.
await student.goto(`${APP}/student/assessments`);
await student.waitForTimeout(3000);
const startsBefore = apiCalls.filter((c) => c.path.includes('/start')).length;
await student.getByRole('button', { name: /^Start$/i }).first().click();

// Wait for *this* start, not the RIASEC one still sitting in the array.
const deadline = Date.now() + 20_000;
while (apiCalls.filter((c) => c.path.includes('/start')).length === startsBefore && Date.now() < deadline) {
  await student.waitForTimeout(200);
}

const scctStart = lastCall('/start');
const scctQuestions = scctStart?.body?.data?.questions ?? [];
check(
  '[student] starts SCCT (30 items)',
  scctStart?.status === 200 && scctQuestions.length === 30,
  `${scctQuestions.length} questions`,
);

const scctAnswered = await answerEveryItem(student, scctQuestions, () => 'Agree');
check('[student] answered all 30 SCCT items', scctAnswered === 30, `${scctAnswered} answered`);

const submitsBefore = apiCalls.filter((c) => c.path.includes('/submit')).length;
await student.getByRole('button', { name: 'Submit assessment' }).click();

const submitDeadline = Date.now() + 25_000;
while (
  apiCalls.filter((c) => c.path.includes('/submit')).length === submitsBefore &&
  Date.now() < submitDeadline
) {
  await student.waitForTimeout(200);
}

const scctSubmit = lastCall('/submit');
check(
  '[student] SCCT submits and scores',
  scctSubmit?.status === 200 && Boolean(scctSubmit?.body?.data?.result),
  `status ${scctSubmit?.status}`,
);

// --- The recommendations ------------------------------------------------------------------
// Submitting the SECOND instrument is what fires `DispatchRecommendationGeneration` with both
// results present. Nothing else happened between the previous check and this one — no button, no
// extra request — so if cards appear now, they were generated by the AssessmentCompleted listener
// as a consequence of the submit. That is the seam Step 4 built and left empty, tested end to end.
await student.goto(`${APP}/student/recommendations`);
await student.waitForTimeout(4000);

const recsCall = lastCall('/student/recommendations');
const recs = recsCall?.body?.data;

check(
  '[student] recommendations EXIST the moment the second instrument lands',
  recsCall?.status === 200 && recs !== null && recs !== undefined,
  `status ${recsCall?.status}`,
);
check(
  '[student] ranked careers and programs are both present (§27 ranks two things, separately)',
  (recs?.careers?.length ?? 0) > 0 && (recs?.programs?.length ?? 0) > 0,
  `${recs?.careers?.length ?? 0} careers, ${recs?.programs?.length ?? 0} programs`,
);
check(
  '[student] each type is ranked from 1, and at most 10 are kept (§27)',
  recs?.careers?.[0]?.ranking === 1 &&
    recs?.programs?.[0]?.ranking === 1 &&
    recs?.careers?.length <= 10 &&
    recs?.programs?.length <= 10,
);
check(
  '[student] scores descend — "ranking" means what it says',
  JSON.stringify(recs?.careers?.map((r) => r.match_score)) ===
    JSON.stringify([...(recs?.careers ?? [])].map((r) => r.match_score).sort((a, b) => b - a)),
  (recs?.careers ?? []).map((r) => r.match_score).join(', '),
);
// §3: no recommendation is shown without a reason, and the reason is deterministic — computed by
// string formatting over numbers §27 already produced, not by a model. This student answered every
// Investigative item at the ceiling, so the sentence must name Investigative.
check(
  '[student] every card carries a deterministic reason naming their top dimension',
  (recs?.careers ?? []).every((r) => typeof r.reason === 'string' && r.reason.includes('Investigative')),
);
check(
  '[student] a program recommendation resolves its college (§13.6 — a join, not a stored match)',
  Boolean(recs?.programs?.[0]?.college?.name),
  recs?.programs?.[0]?.college?.name ?? 'none',
);

const recsText = await student.locator('body').innerText();
check('[student] the recommendations screen renders a match percentage', /%/.test(recsText));
check(
  '[student] the screen states that no AI decided any of it (§3)',
  /no AI decided/i.test(recsText),
);
await shot(student, 'student-recommendations');

// ══════════════════════════════════════════════════════════════════════════════════════
// E. PHASE 5a — knowledge upload through the browser, then a grounded AI explanation
//    (§30, §33, §34). The document is written *about the student's actual rank-1 career*,
//    because §30's retrieval query is "<career> career for a student whose strongest
//    interests are <top dimensions>" and the similarity floor is 0.75: a corpus that does
//    not cover the career correctly yields NO_GROUNDING and the deterministic reason (the
//    refusal path, proved separately in the exit demo). This leg proves the grounded path.
// ══════════════════════════════════════════════════════════════════════════════════════

const rank1CareerTitle = recs?.careers?.[0]?.career?.title ?? 'Software Engineer';

// This student answered every Investigative item at the ceiling and every Artistic one at
// "Agree" (leg C), so those are the dimensions the §30 query will name.
const guidanceLines = [
  `A Career as a ${rank1CareerTitle}: Guidance for Senior High School Students`,
  '',
  `The ${rank1CareerTitle} career suits students whose strongest interests on the Holland`,
  'RIASEC model are Investigative and Artistic, with a practical Realistic streak. The',
  `day-to-day work of a ${rank1CareerTitle} rewards systematic problem-solving: examining a`,
  'problem from several angles, imagining possible answers, and testing each one against',
  'reality. Students who enjoy working out why things are the way they are, and who also',
  'like making new things, tend to find this work deeply satisfying.',
  '',
  `In the Philippines, the road to becoming a ${rank1CareerTitle} runs through a relevant`,
  'college degree, board or licensure requirements where applicable, and early hands-on',
  'practice. Students from the STEM strand arrive well prepared for the quantitative parts',
  'of the coursework. A general weighted average of 85 or above signals readiness for a',
  'rigorous program, though motivated students below that line succeed regularly.',
  '',
  `Employment prospects for a ${rank1CareerTitle} remain strong, with entry-level salaries`,
  'that grow quickly with specialization and experience. Students considering this path',
  'should take every related elective available, seek out a club or competition in the',
  'field, and finish one small real project before graduation - the habit of finishing',
  'is the single strongest predictor of success in college and beyond.',
];

const pdfPath = `${SHOTS}guidance-${STAMP}.pdf`;
writeFileSync(pdfPath, makeGuidancePdf(guidanceLines));

await admin.goto(`${APP}/admin/knowledge`);
await admin.locator('input[type="file"]').setInputFiles(pdfPath);

// Extraction runs in the admin's browser (pdf.js, a dynamic import fetched right now),
// then the multipart upload. Give the whole chain one generous wait.
const uploadCall = await waitForCall(admin, '/admin/knowledge-documents', 'POST', 90_000);
check(
  '[admin] the browser extracts the PDF text and uploads both (§33)',
  uploadCall?.status === 201,
  `status ${uploadCall?.status}`,
);

// UPLOADED → PROCESSING → COMPLETED, rendered as the "Ready" badge. The list polls itself
// every 5 s while anything is in flight; the queue consumer's max_batch_timeout is 30 s,
// so a minute or two of patience is expected, not a hang.
let knowledgeReady = false;
const readyDeadline = Date.now() + 240_000;

while (Date.now() < readyDeadline) {
  const bodyText = await admin.locator('body').innerText();

  if (bodyText.includes(`guidance-${STAMP}.pdf`) && /Ready/.test(bodyText)) {
    knowledgeReady = true;
    break;
  }
  if (/Failed/.test(bodyText)) break;

  await admin.waitForTimeout(5000);
}
check('[admin] the document reaches COMPLETED ("Ready")', knowledgeReady);
await shot(admin, 'admin-knowledge-ready');

// The student presses "Explain more" on the rank-1 card. COMPLETED means Vectorize
// *accepted* the vectors; it indexes asynchronously, so the first press can honestly come
// back "isn't available right now" (NO_GROUNDING). That state renders without the button,
// so each retry reloads the page — which also re-proves that a stored explanation, once
// generated, comes back without regeneration.
let explained = false;

for (let attempt = 1; attempt <= 8 && !explained; attempt += 1) {
  await student.goto(`${APP}/student/recommendations`);
  await student.waitForTimeout(2500);

  await student.getByRole('button', { name: /Explain more/i }).first().click();
  await waitForCall(student, '/explain', 'POST', 30_000);
  await student.waitForTimeout(1500);

  explained = /AI-generated from the school/i.test(await student.locator('body').innerText());

  if (!explained) await student.waitForTimeout(8000);
}

const explainCall = lastCall('/explain', 'POST');
check(
  '[student] "Explain more" renders an AI paragraph grounded in the uploaded guide (§30)',
  explained,
  explained ? undefined : `last failure: ${explainCall?.body?.data?.failure ?? 'unknown'}`,
);
check(
  '[student] the deterministic §27 reason stays on the card — the AI elaborates, never replaces (§29)',
  /Investigative/.test(await student.locator('body').innerText()),
);
await shot(student, 'student-explain-more');

// Press the button again after a reload: the endpoint must hand back the STORED row —
// "if not already generated" (§20) — so a student mashing the button costs zero model
// calls. The paragraph must be byte-identical to the one generated above.
const paragraphBefore = explained
  ? (await student.locator('body').innerText()).match(/([^\n]+)\n+AI-generated from the school/i)?.[1]
  : null;

await student.goto(`${APP}/student/recommendations`);
await student.waitForTimeout(2500);

const explainCallsBefore = apiCalls.filter((c) => c.path.includes('/explain')).length;
await student.getByRole('button', { name: /Explain more/i }).first().click();

// Wait for the NEW call (waitForCall would return the one already in the array), then for
// its paragraph to actually paint.
const repeatDeadline = Date.now() + 30_000;
while (
  apiCalls.filter((c) => c.path.includes('/explain')).length === explainCallsBefore &&
  Date.now() < repeatDeadline
) {
  await student.waitForTimeout(200);
}

let paragraphAfter;
const paintDeadline = Date.now() + 15_000;
while (paragraphAfter === undefined && Date.now() < paintDeadline) {
  paragraphAfter = (await student.locator('body').innerText()).match(
    /([^\n]+)\n+AI-generated from the school/i,
  )?.[1];
  if (paragraphAfter === undefined) await student.waitForTimeout(500);
}

const repeatCall = lastCall('/explain', 'POST');
check(
  '[student] a second "Explain more" returns the stored explanation, not a regeneration (§20)',
  explained && Boolean(paragraphAfter) && paragraphAfter === paragraphBefore,
  repeatCall ? `${repeatCall.status} — identical paragraph: ${paragraphAfter === paragraphBefore}` : 'no repeat call recorded',
);

// ══════════════════════════════════════════════════════════════════════════════════════
await browser.close();
writeReport();

const failures = results.filter((r) => !r.passed);
const fivexx = apiCalls.filter((c) => c.status >= 500);
const fourxx = apiCalls.filter((c) => c.status >= 400 && c.status < 500);

console.log(`\n${'─'.repeat(70)}`);
console.log(`checks         : ${results.length - failures.length}/${results.length} passed`);
console.log(`api calls      : ${apiCalls.length}`);
console.log(`5xx responses  : ${fivexx.length}`);
console.log(`console errors : ${consoleErrors.length}`);
console.log(`uncaught errors: ${pageErrors.length}`);

// The deliberate 401 (the wrong class code) is the only 4xx this run should produce.
if (fourxx.length) {
  console.log('\n4xx responses:');
  for (const c of fourxx) console.log(`   ${c.status} ${c.method} ${c.path}`);
}
if (consoleErrors.length) {
  console.log('\nconsole errors:');
  for (const e of consoleErrors.slice(0, 15)) console.log(`   [${e.who}] ${e.text}`);
}
if (pageErrors.length) {
  console.log('\nuncaught:');
  for (const e of pageErrors.slice(0, 15)) console.log(`   [${e.who}] ${e.text}`);
}
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`   ✗ ${f.name} — ${f.detail}`);
}

process.exit(failures.length || fivexx.length || pageErrors.length ? 1 : 0);
