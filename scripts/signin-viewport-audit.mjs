/**
 * **Can a student finish signing in without scrolling?** — at every width the product supports,
 * and at the *height* that ships with it.
 *
 * ## Why this exists beside `responsive-audit.mjs`
 *
 * That script is the broad one: it drives admin, counselor and student screens at nine widths and
 * scores horizontal scroll, sub-44px touch targets and controls hidden under fixed overlays. Two
 * things put this failure outside its reach, and both are structural rather than oversights:
 *
 *   1. **It runs every width at `height: 900`.** No phone is 900px tall — a 320px-wide device is
 *      568px, and a real browser spends another 60-110px of that on its URL bar. A control that
 *      falls below the fold on every phone in the building is comfortably on screen at 900px.
 *   2. **It signs in through the API and injects the token**, so it never renders a sign-in screen
 *      at all. The one page every student meets first, on their own phone, was not audited.
 *
 * On 2026-09-18 the student sign-in gained a confirmation step ("Is this you?"), and at 320x568 it
 * rendered its heading, the name and the warning — and put both of its buttons 18px below the
 * fold. The page scrolled; nothing on screen said so. To a student that is a question with no
 * answer, and the step reads as broken. It passed every unit test, because jsdom has no layout,
 * and it passed the responsive audit, because of the two reasons above.
 *
 * ## What it asserts
 *
 * For each size, on each state a sign-in screen can be in: the control that advances the step is
 * **wholly inside the viewport**, and the page does not scroll sideways. Sign-in cards are the one
 * page type where that is the right rule — a dashboard is a list and is supposed to scroll, which
 * is why this check is scoped here rather than added to the broad audit.
 *
 * ## Running it
 *
 *   npm run preview                      # in another terminal, serves the built app on :8787
 *   npm run audit:signin -- --code ABCD-1234 --username juan.delacruz
 *
 * The class code and username must exist in the **local** database; `--username-live` is a second
 * student who already holds a session, which is what renders the "already signed in on another
 * device" warning — the tallest state the confirmation step has. Omit it and that state is
 * skipped rather than silently passing.
 */

import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:8787';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);

  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const CODE = arg('code');
const USERNAME = arg('username');
const LIVE_USERNAME = arg('username-live');

if (!CODE || !USERNAME) {
  console.error(
    'Usage: node scripts/signin-viewport-audit.mjs --code ABCD-1234 --username juan.delacruz ' +
      '[--username-live maria.santos]\n\n' +
      'Both must exist in the local database. Get them with:\n' +
      '  cd backend && npx wrangler d1 execute CareerLinkAI_Main --local --json \\\n' +
      "    --command \"SELECT c.join_code, cs.username FROM classes c JOIN class_students cs ON cs.class_id=c.id LIMIT 5\"",
  );
  process.exit(2);
}

/**
 * The audited widths, each paired with the shortest height that ships at it.
 *
 * These are device viewports minus the browser chrome a phone actually spends, because the
 * viewport a student gets is never the one on the spec sheet. The desktop entries are included so
 * a fix for the phone cannot regress the mouse.
 */
const SIZES = [
  { w: 320, h: 568, name: '320x568  iPhone SE' },
  { w: 360, h: 600, name: '360x600  Android' },
  { w: 375, h: 667, name: '375x667  iPhone 8' },
  { w: 390, h: 734, name: '390x734  iPhone 14' },
  { w: 414, h: 780, name: '414x780  iPhone Plus' },
  { w: 430, h: 830, name: '430x830  iPhone Max' },
  { w: 768, h: 1024, name: '768x1024 tablet' },
  { w: 1024, h: 768, name: '1024x768 laptop' },
  { w: 1280, h: 800, name: '1280x800 desktop' },
];

const TOUCH_WIDTH_LIMIT = 768;

/** Minimum touch target on a touch-capable width (the same rule the broad audit scores). */
const MIN_TOUCH = 44;

/** Every pixel of this control inside the viewport, without scrolling? */
async function reach(page, name) {
  const control = page.getByRole('button', { name });

  if ((await control.count()) === 0) return { found: false };

  return control.first().evaluate((node) => {
    const rect = node.getBoundingClientRect();

    return {
      found: true,
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
      overhang: Math.round(rect.bottom - window.innerHeight),
    };
  });
}

const scrollsSideways = (page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );

/** Walk the form to the confirmation step. Returns false when the credentials did not resolve. */
async function reachConfirmation(page, username) {
  await page.goto(`${APP}/join`, { waitUntil: 'networkidle' });
  await page.locator('#class_code').fill(CODE);
  await page.locator('#username').fill(username);
  await page.getByRole('button', { name: 'Continue' }).click();

  try {
    await page.getByRole('button', { name: "Yes, it's me" }).waitFor({ timeout: 10_000 });

    return true;
  } catch {
    return false;
  }
}

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];

try {
  for (const { w, h, name } of SIZES) {
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      deviceScaleFactor: 1,
      hasTouch: w < TOUCH_WIDTH_LIMIT,
      isMobile: w < TOUCH_WIDTH_LIMIT,
    });
    const page = await context.newPage();
    const checks = [];

    // --- Step one, as a student first meets it -----------------------------------------
    await page.goto(`${APP}/join`, { waitUntil: 'networkidle' });
    checks.push(['join form', 'Continue', await reach(page, 'Continue'), await scrollsSideways(page)]);

    // --- Step one, carrying the generic rejection ---------------------------------------
    await page.locator('#class_code').fill('ZZZZ-9999');
    await page.locator('#username').fill('nobody.here');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(1200);
    checks.push([
      'join form + 401',
      'Continue',
      await reach(page, 'Continue'),
      await scrollsSideways(page),
    ]);

    // --- Step two ------------------------------------------------------------------------
    if (await reachConfirmation(page, USERNAME)) {
      const sideways = await scrollsSideways(page);

      checks.push(['confirm', "Yes, it's me", await reach(page, "Yes, it's me"), sideways]);
      checks.push(['confirm', 'Not me', await reach(page, 'Not me'), sideways]);
    } else {
      failures.push(`${name} :: confirmation step unreachable for ${USERNAME}`);
    }

    // --- Step two, with the takeover warning: the tallest state that ships ----------------
    if (LIVE_USERNAME && (await reachConfirmation(page, LIVE_USERNAME))) {
      const warned = await page.getByText(/another device/i).count();

      if (!warned) {
        console.warn(
          `  note: ${LIVE_USERNAME} holds no live session, so the warning state was not measured`,
        );
      }

      checks.push([
        `confirm + warning${warned ? '' : ' (ABSENT)'}`,
        "Yes, it's me",
        await reach(page, "Yes, it's me"),
        await scrollsSideways(page),
      ]);
    }

    console.log(`\n=== ${name} ===`);

    for (const [state, label, box, sideways] of checks) {
      const small = box.found && w < TOUCH_WIDTH_LIMIT && box.height < MIN_TOUCH;
      const ok = box.found && box.inViewport && !sideways && !small;
      const where = `${state} → "${label}"`;

      if (!ok) failures.push(`${name} :: ${where}`);

      console.log(
        `  ${ok ? 'OK  ' : 'FAIL'} ${where.padEnd(38)} ` +
          (box.found
            ? `top=${String(box.top).padStart(4)} bottom=${String(box.bottom).padStart(4)} h=${box.height}` +
              (box.inViewport ? '' : `  BELOW THE FOLD by ${box.overhang}px`) +
              (small ? `  TOUCH TARGET ${box.height}px < ${MIN_TOUCH}px` : '')
            : 'CONTROL NOT FOUND') +
          (sideways ? '  HORIZONTAL SCROLL' : ''),
      );
    }

    await context.close();
  }
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(72));

if (failures.length > 0) {
  console.log(`${failures.length} failure(s) — a student cannot finish signing in here:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Every sign-in step completes without scrolling, at every audited size.');
}
