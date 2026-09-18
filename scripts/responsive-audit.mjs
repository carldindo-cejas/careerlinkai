#!/usr/bin/env node
/**
 * The responsive audit (prompt §10) — **measured, not eyeballed**.
 *
 * It drives a real browser through the admin, counselor and student interfaces at every viewport
 * width the brief names (320 → 1280) and reports, per page per width, the things that are *facts*
 * about a layout rather than matters of taste:
 *
 *   1. **Horizontal page scroll** — `documentElement.scrollWidth > innerWidth`. This is the one
 *      unambiguous responsive defect: it means content is off-screen to the right and the whole
 *      page slides. A table inside its own `overflow-x-auto` is *not* this, which is why the check
 *      is on the document rather than on every element.
 *   2. **What is causing it.** A bare "the page scrolls" sends someone hunting through a hundred
 *      divs, so every element whose right edge lands past the viewport is reported with its tag,
 *      classes and text — skipping any element that sits inside a deliberate scroll container,
 *      because that one is not a defect and reporting it would bury the ones that are.
 *   3. **Touch targets under 44×44 CSS px** — the WCAG 2.2 AA "Target Size (Minimum)" threshold —
 *      on interactive elements only, and only at phone widths, where a thumb is the pointer. Links
 *      inside a paragraph are exempt (the standard exempts inline targets, and so does anyone who
 *      has tried to lay out a sentence otherwise).
 *   4. **Elements clipped by a fixed/sticky overlay**, which is how a "just make it sticky" fix
 *      ends up covering the button it was meant to sit beside.
 *
 * It asserts nothing about beauty, and it cannot: "cramped" and "bad spacing" are judgements, and
 * a script that scored them would be inventing a number. What it does is make the mechanical
 * failures impossible to miss, so the judgement calls are all that is left to make by looking.
 *
 * ── Running it ───────────────────────────────────────────────────────────────────────────────
 *
 *   1. cd backend && npm run preview          # builds the SPA, serves it and /api/v1 on :8787
 *   2. node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --local --password ChangeMe123
 *   3. node scripts/responsive-audit.mjs [--app http://localhost:8787] [--password ChangeMe123]
 *
 * `--shots <dir>` also writes a PNG per page per width, which is the only way to judge the things
 * this script deliberately does not.
 *
 * **It writes to the database it points at**, exactly as `contrast-check.mjs` does: it signs in,
 * creates a class, provisions a student and starts an attempt, because half the pages under audit
 * do not exist until somebody has done those things. Everything it creates is stamped `RESPONSIVE`
 * so it can be found again. Do not point it at production.
 *
 * Playwright's own Chromium is not used — cdn.playwright.dev is unreachable from this environment
 * and `npx playwright install` exits 0 having downloaded nothing. We drive the system Chrome, which
 * is a browser a real user of this app would actually use. (Same reasoning as `walkthrough.mjs`.)
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);

function flag(name, fallback) {
  const at = args.indexOf(`--${name}`);

  return at === -1 ? fallback : args[at + 1];
}

const APP = (flag('app', 'http://localhost:8787') ?? '').replace(/\/$/, '');
const API = flag('api', `${APP}/api/v1`);
const PASSWORD = flag('password', 'ChangeMe123');
const SHOTS = flag('shots', null);

/** Every width the brief names, plus the two the shell's own breakpoints turn on at. */
const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280];

/** Phone widths — where a thumb is the pointer and the touch-target rule applies. */
const TOUCH_WIDTH_LIMIT = 500;

/** WCAG 2.2 AA, Target Size (Minimum). */
const MIN_TOUCH = 44;

/**
 * Refuse production, the way `walkthrough.mjs` does.
 *
 * This script signs in and writes rows. A guard that can be argued with is not a guard.
 */
if (/careerlinkai\.online/i.test(APP) && !args.includes('--i-know-this-is-production')) {
  console.error('Refusing to run against production: this script signs in and writes rows.');
  process.exit(1);
}

if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

const findings = [];

function record(finding) {
  findings.push(finding);
}

// --- The measurement, run inside the page ------------------------------------------------------

/**
 * Everything measured in one evaluate, because each round trip to the page is a chance for a
 * layout to settle differently between two of them.
 */
const MEASURE = ({ minTouch, checkTouch }) => {
  const doc = document.documentElement;
  const viewport = window.innerWidth;

  const describe = (el) => {
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const cls = typeof el.className === 'string' ? el.className.slice(0, 120) : '';

    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? ` class="${cls}"` : ''}>${text ? ` — “${text}”` : ''}`;
  };

  /**
   * Is this element **visually hidden until focused** — a skip link, an `sr-only` helper?
   *
   * Tested by what the technique actually does (a collapsed clip, or a 1px box) rather than by
   * looking for a class name: `sr-only` is Tailwind's spelling of it, and a hand-rolled one in a
   * stylesheet somewhere would be just as invisible and just as exempt. Measuring one of these at
   * rest measures the wrong thing — it is full size the moment it is focused, which is the only
   * moment it is a target at all.
   */
  const visuallyHiddenUntilFocused = (style, rect) =>
    style.clipPath === 'inset(50%)' ||
    style.clip === 'rect(0px, 0px, 0px, 0px)' ||
    (rect.width <= 1 && rect.height <= 1);

  /**
   * The box a pointer actually has to hit.
   *
   * Usually the element's own, but not for a **stretched link** — `after:absolute after:inset-0`,
   * the pattern that makes a whole card clickable through the title inside it. There the text may
   * be 185×22 while the target is the entire card, and measuring the text reports a defect that
   * does not exist. The audit follows the same rule the browser does: the `::after` covers the
   * nearest positioned ancestor, so that ancestor is the target.
   */
  const targetBox = (el, rect) => {
    const after = getComputedStyle(el, '::after');

    if (after.position !== 'absolute' || after.content === 'none') {
      return rect;
    }

    const insets = [after.top, after.right, after.bottom, after.left];

    if (!insets.every((value) => value === '0px')) {
      return rect;
    }

    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      if (getComputedStyle(node).position !== 'static') {
        return node.getBoundingClientRect();
      }
    }

    return rect;
  };

  /** Is this element inside something that is *supposed* to scroll sideways? */
  const insideScroller = (el) => {
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;

      if (overflowX === 'auto' || overflowX === 'scroll') {
        return true;
      }
    }

    return false;
  };

  const overflowingElements = [];
  const smallTargets = [];
  const covered = [];

  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);

    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const rect = el.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0) continue;

    // 1 px of tolerance: sub-pixel layout rounding is not a defect.
    if (rect.right > viewport + 1 && !insideScroller(el)) {
      overflowingElements.push({ description: describe(el), right: Math.round(rect.right) });
    }

    if (checkTouch) {
      const interactive =
        el.matches('button, [role="button"], [role="radio"], a[href], select, input, textarea, summary') &&
        !el.closest('p, li p') &&
        // An input inside a label row is sized by the row; the row is the target.
        !(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) &&
        /**
         * Exemptions, each for a reason the standard itself gives:
         *
         *   * **Visually hidden until focused** — a skip link. See `visuallyHiddenUntilFocused`.
         *   * **`aria-hidden`** and anything inside it — not a target for anybody.
         *   * **A control inside a `<label>`** — the label is the target, and it is the one the
         *     browser routes the tap to.
         */
        !el.closest('[aria-hidden="true"]') &&
        !el.closest('label') &&
        !visuallyHiddenUntilFocused(style, rect);

      const hit = interactive ? targetBox(el, rect) : rect;

      if (interactive && (hit.height < minTouch || hit.width < minTouch)) {
        smallTargets.push({
          description: describe(el),
          size: `${Math.round(hit.width)}×${Math.round(hit.height)}`,
        });
      }
    }
  }

  // 4. Anything a fixed/sticky overlay is sitting on top of, at the point it overlaps.
  for (const overlay of document.querySelectorAll('body *')) {
    const style = getComputedStyle(overlay);

    if (style.position !== 'fixed') continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    /**
     * `pointer-events: none` is the whole point of a toast stack: it floats over the page and the
     * page stays clickable *through* it. Reporting it as "covering" a link was the audit's own
     * false positive, and a check that cries wolf is one nobody reads.
     */
    if (style.pointerEvents === 'none') continue;

    const box = overlay.getBoundingClientRect();

    if (box.width === 0 || box.height === 0) continue;
    // A full-screen modal backdrop covers everything on purpose.
    if (box.width >= viewport * 0.9 && box.height >= window.innerHeight * 0.9) continue;

    const centre = document.elementFromPoint(
      Math.min(viewport - 2, Math.max(2, box.left + box.width / 2)),
      Math.min(window.innerHeight - 2, Math.max(2, box.top + box.height / 2)),
    );

    if (centre !== null && !overlay.contains(centre) && centre.closest('button, a[href], select, input')) {
      covered.push({
        overlay: describe(overlay),
        covering: describe(centre.closest('button, a[href], select, input')),
      });
    }
  }

  return {
    pageScrollWidth: doc.scrollWidth,
    viewport,
    horizontalScroll: doc.scrollWidth > viewport + 1,
    // Dedupe: a deeply nested overflow reports every ancestor, and the innermost one is the news.
    overflowingElements: overflowingElements.slice(0, 8),
    smallTargets: dedupe(smallTargets).slice(0, 8),
    covered: covered.slice(0, 4),
  };

  function dedupe(list) {
    const seen = new Set();

    return list.filter((item) => {
      if (seen.has(item.description)) return false;

      seen.add(item.description);

      return true;
    });
  }
};

// --- The run -----------------------------------------------------------------------------------

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const json = await response.json().catch(() => ({}));

  return { status: response.status, body: json };
}

/**
 * The password the audit's own accounts end up on.
 *
 * `bootstrap-staff.mjs` leaves both staff rows with `must_change_password = 1` — the forced
 * rotation *is* the activation step (§13.1) — so every other endpoint answers 403 until it has
 * happened. The audit performs it rather than working around it, because the rotation is a real
 * part of the product and a fixture that skipped it would be auditing a state no account is ever in.
 */
const ROTATED_PASSWORD = 'ResponsiveAudit1';

/**
 * Sign in over the API and hand the token to the browser.
 *
 * Driving the login *form* nine times per role — once per viewport — would make the audit a test
 * of the login form. The token goes straight into the store's persisted key, which is what the app
 * reads on boot.
 *
 * Rotation is handled here too, and **idempotently**: a re-run finds the account already on the
 * rotated password, because rotating is a one-way door and `bootstrap-staff.mjs` is the only reset.
 */
async function signIn(email) {
  let login = await api('/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });

  if (login.status !== 200) {
    // Already rotated by an earlier run of this script.
    login = await api('/auth/login', {
      method: 'POST',
      body: { email, password: ROTATED_PASSWORD },
    });
  }

  if (login.status !== 200) {
    throw new Error(
      `Could not sign in as ${email}: ${JSON.stringify(login.body)}
` +
        'Re-run scripts/bootstrap-staff.mjs to reset both staff accounts.',
    );
  }

  const session = login.body.data;

  if (session.user?.must_change_password) {
    const rotated = await api('/auth/change-password', {
      token: session.token,
      method: 'POST',
      body: {
        current_password: PASSWORD,
        password: ROTATED_PASSWORD,
        password_confirmation: ROTATED_PASSWORD,
      },
    });

    if (rotated.status !== 200) {
      throw new Error(`Could not rotate ${email}: ${JSON.stringify(rotated.body)}`);
    }

    // Rotation revokes the token that performed it (§38), so sign in again on the new one.
    return signIn(email);
  }

  return session;
}

/** The fixtures the counselor and student pages need in order to have anything on them. */
async function seedFixtures(adminToken, counselorToken) {
  await api('/admin/assessment-templates/seed-instruments', {
    token: adminToken,
    method: 'POST',
  });

  const stamp = `RESPONSIVE ${randomUUID().slice(0, 8)}`;

  const created = await api('/counselor/classes', {
    token: counselorToken,
    method: 'POST',
    body: {
      name: `${stamp} Grade 12 Section Magsaysay-Villanueva`,
      academic_year: '2026-2027',
      grade_level: 'Grade 12',
      strand: 'Academic',
    },
  });

  if (created.status !== 201) {
    throw new Error(`Could not create a class: ${JSON.stringify(created.body)}`);
  }

  const classRoom = created.body.data;

  /**
   * A deliberately long name — "long usernames/names breaking layouts" is on the brief's own list,
   * and three given names with a double-barrelled surname is an ordinary Filipino roster entry
   * rather than a stress test.
   */
  const preview = await api(`/counselor/classes/${classRoom.id}/students/preview`, {
    token: counselorToken,
    method: 'POST',
    body: { names: ['Maria Cristina Esperanza Dela Cruz-Villanueva', 'Juan Santos'] },
  });

  if (preview.status === 200) {
    await api(`/counselor/classes/${classRoom.id}/students/confirm`, {
      token: counselorToken,
      method: 'POST',
      body: { students: preview.body.data.students },
    });
  }

  const assessments = await api('/assessments?per_page=100', { token: counselorToken });
  const riasec = (assessments.body.data?.items ?? []).find((row) => row.category === 'RIASEC');

  if (riasec?.published_version) {
    await api(`/counselor/classes/${classRoom.id}/assignments`, {
      token: counselorToken,
      method: 'POST',
      body: { assessment_version_id: riasec.published_version.id },
    });
  }

  const roster = await api(`/counselor/classes/${classRoom.id}/students`, {
    token: counselorToken,
  });
  const first = (roster.body.data ?? [])[0];

  let studentToken = null;

  if (first) {
    const joined = await api('/student-access/join', {
      method: 'POST',
      body: { class_code: classRoom.join_code, username: first.username },
    });

    if (joined.status === 200) {
      studentToken = joined.body.data;

      const assignments = await api('/student/assignments', { token: studentToken.token });
      const assignment = (assignments.body.data ?? [])[0];

      if (assignment) {
        await api(`/student/assignments/${assignment.id}/start`, {
          token: studentToken.token,
          method: 'POST',
        });
      }
    }
  }

  return { classRoom, studentToken };
}

async function run() {
  const admin = await signIn('admin@careerlinkai.online');
  const counselor = await signIn('counselor@careerlinkai.online');

  console.log('Signed in. Seeding fixtures…');

  const { classRoom, studentToken } = await seedFixtures(admin.token, counselor.token);

  const assessments = await api('/assessments?per_page=100', { token: admin.token });
  const riasec = (assessments.body.data?.items ?? []).find((row) => row.category === 'RIASEC');

  const student = studentToken
    ? await api('/student/assignments', { token: studentToken.token })
    : null;
  const attemptId = null;

  /** Every page under audit, with the session it needs. */
  const pages = [
    { role: 'admin', session: admin, name: 'admin-dashboard', path: '/admin' },
    { role: 'admin', session: admin, name: 'admin-assessments', path: '/admin/assessment-templates' },
    riasec && {
      role: 'admin',
      session: admin,
      name: 'admin-assessment-builder',
      path: `/admin/assessment-templates/${riasec.id}`,
    },
    { role: 'admin', session: admin, name: 'admin-counselors', path: '/admin/counselors' },
    { role: 'admin', session: admin, name: 'admin-colleges', path: '/admin/colleges' },
    { role: 'admin', session: admin, name: 'admin-audit-log', path: '/admin/audit-log' },

    { role: 'counselor', session: counselor, name: 'counselor-dashboard', path: '/counselor' },
    { role: 'counselor', session: counselor, name: 'counselor-classes', path: '/counselor/classes' },
    {
      role: 'counselor',
      session: counselor,
      name: 'counselor-class-detail',
      path: `/counselor/classes/${classRoom.id}`,
    },
    {
      role: 'counselor',
      session: counselor,
      name: 'counselor-assessments',
      path: '/counselor/assessment-templates',
    },
    riasec && {
      role: 'counselor',
      session: counselor,
      name: 'counselor-assessment-builder',
      path: `/counselor/assessment-templates/${riasec.id}`,
    },

    studentToken && { role: 'student', session: studentToken, name: 'student-dashboard', path: '/student' },
    studentToken && {
      role: 'student',
      session: studentToken,
      name: 'student-assessments',
      path: '/student/assessments',
    },
    studentToken && {
      role: 'student',
      session: studentToken,
      name: 'student-results',
      path: '/student/results',
    },
    studentToken && {
      role: 'student',
      session: studentToken,
      name: 'student-recommendations',
      path: '/student/recommendations',
    },
    studentToken && {
      role: 'student',
      session: studentToken,
      name: 'student-profile',
      path: '/student/profile',
    },
  ].filter(Boolean);

  void student;
  void attemptId;

  const browser = await chromium.launch({ channel: 'chrome' });

  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
        // Phone widths get a touch-capable context, so any hover-only affordance shows up as one.
        hasTouch: width < TOUCH_WIDTH_LIMIT,
        isMobile: width < TOUCH_WIDTH_LIMIT,
      });

      for (const page of pages) {
        const tab = await context.newPage();

        try {
          // Seed the auth store before the app boots, on the app's own origin.
          await tab.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
          await tab.evaluate((session) => {
            // `partialize` persists the token alone; `/auth/me` is the source of truth for who it
            // belongs to, and the app calls it on boot.
            localStorage.setItem(
              'careerlinkai.auth',
              JSON.stringify({ state: { token: session.token }, version: 0 }),
            );

            if (session.class) {
              localStorage.setItem(
                'careerlinkai.student-class',
                JSON.stringify({
                  state: { classRoom: session.class, username: session.username ?? null },
                  version: 0,
                }),
              );
            }
          }, page.session);

          await tab.goto(`${APP}${page.path}`, { waitUntil: 'networkidle' });
          // Let the query cache settle and the layout with it.
          await tab.waitForTimeout(900);

          const result = await tab.evaluate(MEASURE, {
            minTouch: MIN_TOUCH,
            checkTouch: width < TOUCH_WIDTH_LIMIT,
          });

          if (SHOTS) {
            await tab.screenshot({
              path: `${SHOTS}/${width}-${page.name}.png`,
              fullPage: true,
            });
          }

          if (
            result.horizontalScroll ||
            result.smallTargets.length > 0 ||
            result.covered.length > 0
          ) {
            record({ width, page: page.name, path: page.path, ...result });
          }
        } catch (error) {
          record({
            width,
            page: page.name,
            path: page.path,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          await tab.close();
        }
      }

      console.log(`  ${width}px — done`);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  report();
}

function report() {
  console.log('\n' + '─'.repeat(78));
  console.log('  RESPONSIVE AUDIT');
  console.log('─'.repeat(78) + '\n');

  const overflow = findings.filter((f) => f.horizontalScroll);
  const touch = findings.filter((f) => (f.smallTargets ?? []).length > 0);
  const coveredUp = findings.filter((f) => (f.covered ?? []).length > 0);
  const errored = findings.filter((f) => f.error);

  if (findings.length === 0) {
    console.log('  No horizontal scroll, no undersized touch targets, nothing covered.\n');
  }

  for (const finding of overflow) {
    console.log(`  ✗ HORIZONTAL SCROLL  ${finding.page} @ ${finding.width}px`);
    console.log(`      page is ${finding.pageScrollWidth}px wide in a ${finding.viewport}px viewport`);

    for (const el of finding.overflowingElements) {
      console.log(`      → right edge ${el.right}px: ${el.description}`);
    }

    console.log('');
  }

  for (const finding of touch) {
    console.log(`  ! SMALL TOUCH TARGETS  ${finding.page} @ ${finding.width}px`);

    for (const target of finding.smallTargets) {
      console.log(`      → ${target.size}: ${target.description}`);
    }

    console.log('');
  }

  for (const finding of coveredUp) {
    console.log(`  ! COVERED BY A FIXED ELEMENT  ${finding.page} @ ${finding.width}px`);

    for (const pair of finding.covered) {
      console.log(`      → ${pair.overlay}`);
      console.log(`        covers ${pair.covering}`);
    }

    console.log('');
  }

  for (const finding of errored) {
    console.log(`  ? COULD NOT MEASURE  ${finding.page} @ ${finding.width}px — ${finding.error}\n`);
  }

  console.log('─'.repeat(78));
  console.log(
    `  ${overflow.length} horizontal-scroll, ${touch.length} touch-target, ${coveredUp.length} overlap, ${errored.length} unmeasured`,
  );
  console.log('─'.repeat(78) + '\n');

  if (SHOTS) {
    writeFileSync(`${SHOTS}/findings.json`, JSON.stringify(findings, null, 2));
    console.log(`  Screenshots and findings.json in ${SHOTS}\n`);
  }

  // Horizontal scroll is the only unambiguous failure, so it is the only one that fails the run.
  process.exit(overflow.length > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
