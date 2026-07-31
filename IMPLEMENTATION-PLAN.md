# CareerLinkAI — Incremental Implementation Plan

**Created:** 2026-07-28 · **Source:** [`AUDIT-2026-07-28.md`](AUDIT-2026-07-28.md) · **Branch:** `main`

A traceable checklist from the current state to production. Every item carries a stable **ID**, the
audit finding it closes, the files it touches, and **how you know it worked** — so progress can be
verified rather than asserted.

**Status legend:** `[x]` done & verified · `[~]` partially done (see note) · `[ ]` not started · `[!]` blocked on someone else

**Rule for this document:** an item moves to `[x]` only when its *Verify* line has actually been
run and passed. "The code exists" is not done — that confusion is what produced audit findings F1,
F2 and P1 in the first place (an endpoint with no caller, a hook with no page, optimized assets
nothing imported).

---

## Phase 0 — Completed 2026-07-28

Recorded so the trail is complete. Full detail in the audit's remediation log.

| ID | Finding | What | Verify | Status |
|---|---|---|---|---|
| P0-1 | C1 | Catalog: 20 HEIs, 68 careers, 48 canonical programs, 309 offerings, 933 mappings | Top-10 overlap between contrasting profiles = 0/10 in 5 of 6 pairs | `[x]` |
| P0-2 | C2 | `POST /admin/counselors/:id/reset-password` + confirmed UI action | 9 tests, incl. issued password actually signs in | `[x]` |
| P0-3 | C4 | Student + counselor regeneration routes, DO throttle, student UI | 12 tests, incl. recovery from wiped rows | `[x]` |
| P0-4 | F1 | "Install RIASEC & SCCT" button, role-gated | type-check + build clean | `[x]` |
| P0-5 | F6 | `ErrorBoundary` inside providers | build clean | `[x]` |
| P0-6 | P1 | Login-screen images 4.3 MB → 80 kB; dead assets removed | Build output: logo 14.35 kB, art 65.72 kB WebP | `[x]` |
| P0-7 | S1 | CSP, HSTS, X-Frame-Options, Permissions-Policy | Verified in Chrome across 15 screens — **two defects found and fixed, see P1-2** | `[x]` |
| P0-8 | C3 | Runbook corrected (13→19 migrations, seed 0004, install step), prod seed scripts, rollback | Doc review | `[x]` |

**Baseline at end of Phase 0:** 807 backend tests, 104 frontend, type-check · lint · platform gates · build all green.

---

## Phase 1 — Follow-ups from Phase 0 *(do these first)*

Phase 0 closed seven findings and, in doing so, created four loose ends. Three are gaps rather than
breakages; one was a real defect and is already fixed. Listed honestly because an untracked
follow-up is how the original F1/F2 defects happened.

### `[x]` **P1-0 — Seed chaining produced duplicate catalog rows** — *fixed 2026-07-28*

* **Cause:** Phase 0 chained `db:seed` → `0001 → 0002 → 0004 → 0003`. Seeds 0002 and 0004 both
  contain "UP Diliman", "Software Engineer", "Teacher" and 12 other overlapping names under
  **different ids**, and neither `colleges.name` nor `careers.title` has a unique index — so
  `INSERT OR IGNORE` had nothing to collide on and both rows survived.
* **Impact:** 25 colleges / 78 careers with 15 duplicates. Not cosmetic — §27 ranks every active
  career, so two identically-coded "Software Engineer" rows both land in the same student's top
  ten and the duplicate card is **visible on the recommendations screen**. This would have shown up
  in a demo.
* **Fix:** `db:seed` now chains `0001 → 0004 → 0003`. `db:seed:catalog` (0002) is retained but
  unchained, with the reason recorded in `package.json` and the 0004 header.
* **Files:** `backend/package.json`, `backend/seeds/0004_academic_catalog_expansion.sql`
* **Verify:** ✅ migrations + 0004 against SQLite → 20 colleges, 68 careers, **0 duplicates**, 0 programs with NULL canonical.

### `[x]` **P1-1 — Counselor regeneration endpoint has no UI** — *closed by P2-1, 2026-07-28*

* **Why:** P0-3 shipped `POST /counselor/students/:id/recommendations/regenerate` and the
  `useRegenerateStudentRecommendations` hook, but **no page calls either**. That is the same defect
  class as F1 (endpoint reachable only by `curl`) and F2 (hook with no consumer) — Phase 0 fixed one
  instance and created another. There are now **two** unused recommendation hooks.
* **Closed by:** P2-1's `ClassRecommendationsPanel`, which consumes both previously-orphaned hooks
  (`useStudentRecommendations` for the read, `useRegenerateStudentRecommendations` for the Rebuild
  button). Zero unused recommendation hooks remain.

### `[x]` **P1-2 — Verify CSP in a real browser** — *done 2026-07-28. Found two defects.*

* **Why:** the policy in `_headers` was *reasoned*, not *run*. This was the right instinct: the
  first browser run found **two live violations on every screen**, neither visible from reading the
  file, and neither reproducible under `npm run dev` (Vite serves no `_headers`).
* **Automated, not manual.** `scripts/csp-check.mjs` drives **real Chrome** via Playwright (already
  a root dependency; `channel: 'chrome'` uses the installed browser, so nothing is downloaded)
  against the local single-origin preview, collecting `securitypolicyviolation` events *and*
  console text across 15 screens. Re-runnable, so this does not decay the way a manual pass does.
* **Finding 1 — the webfonts were blocked everywhere. (Fixed.)** `src/index.css:1` is
  `@import url('https://fonts.googleapis.com/css2?family=Barlow…')`, and `style-src 'self'
  'unsafe-inline'` did not cover it — so Barlow and Barlow Condensed never loaded and the whole app
  silently fell back to the system sans-serif. The entire Industry design system is set in those two
  faces. This would have been visible from the back of the room. Fixed by allowing the two exact
  hosts (`https://fonts.googleapis.com` in `style-src`, `https://fonts.gstatic.com` in `font-src` —
  the stylesheet and the `.woff2` files are different origins), with the reasoning recorded in
  `_headers` per this item's own instruction not to widen silently.
  **Better follow-up:** self-host the fonts and drop both allowances. The repo already carries
  `@fontsource-variable/inter` from the pre-Industry design, so the pattern is established; it would
  also stop every student's browser announcing itself to Google and remove two DNS+TLS handshakes
  from first paint. Not done here because it changes what ships. → **P4-11**.
* **Finding 2 — Zod probes for `eval`, is refused, and copes. (Accepted, not fixed.)** Every page
  reports one `script-src blocked eval` from Zod 4's JIT feature detection
  (`try { return Function(''), true } catch { return false }`), which exists precisely so a CSP
  without `'unsafe-eval'` pushes it onto the interpreted validator path. Nothing is broken.
  **`'unsafe-eval'` was deliberately not added** — it is the most dangerous relaxation in CSP and
  this app holds its bearer token in `localStorage`. The check script carries it as a documented
  accepted entry so it neither fails the run nor goes unexamined.
* **Both judgement calls resolved:** `style-src 'unsafe-inline'` confirmed (an inline `style`
  attribute applies); `worker-src 'self' blob:` confirmed — probed with the **real hashed
  pdf.worker asset**, discovered by walking the chunk graph rather than guessing a filename, since a
  guessed URL satisfies CSP (which evaluates the URL, not the response) and would report a false pass.
* **`_headers` does apply to the SPA document** — confirmed, not assumed: CSP/HSTS/XFO/Permissions
  present on `/`, `/login` and SPA-fallback routes; absent on `/api/v1/*` (the Worker's own
  responses), exactly as the file documents. The documented `Cache-Control` accumulation bug is also
  confirmed **absent** — one value per response, `immutable` on `/assets/*`, `max-age=0` on the document.
* **Verify:** `cd backend && npm run preview`, then `node scripts/csp-check.mjs` → **PASS, 15
  screens**, zero unexpected violations. Fonts re-checked end to end: 200s from both origins,
  `Barlow loaded`, zero refusals.

### `[x]` **P1-3 — Regression guards for what Phase 0 fixed** — *done 2026-07-29. 811 → 815.*

Both guards were built **and then made to fail on purpose**, because a gate that has never been
seen red is not known to be a gate — it is known to be a passing command. Every threshold below
was fired before it was accepted.

**The asset gate — `platform-gates.mjs --assets`.** P1 (the 3.26 MB logo) shipped because the only
size CI measured was `gate:bundle`, which weighs the **Worker script**; Cloudflare stores static
assets separately, against no bundle limit, so the one number reported was the one number the
defect could not move. Three budgets, because the failure has three shapes:

* **No media file over 600 KiB** — the literal P1 shape. Heaviest today: 400 KiB (`art.png`).
* **Total media ≤ 1.5 MiB** — ten 300 KiB images pass a per-file cap individually and are the
  same problem. Today: **492 KiB across 4 files**.
* **No script chunk over 1000 KiB**, pdf.worker exempt. See the ratchet note below.

**It walks all of `dist/`, not just `dist/assets/`** — as the item was written. Files in
`frontend/public/` are copied to the root of `dist` unhashed (`logo.png` is there right now), so a
master dropped in `public/` ships identical bytes to identical browsers while evading a gate that
looks only at `assets/`. Two ways in, one gate.

**The chunk budget is 1000 KiB, not the 600 KiB the item specifies, and that is a recorded
compromise.** `index-*.js` is 921 KiB today — one chunk holding every admin, counselor and student
page, which *is* audit finding P2 and is scheduled as **P3-3**. A 600 KiB budget would have landed
a gate that fails on `main` from its first commit, unfixable without doing an unrelated item first;
that is how gates get commented out. So it is a ratchet with ~8% headroom: the build passes,
nothing meaningful can be added without a deliberate decision, and **P3-3 lowers it**.

**The seed-chain test resolves the chain rather than grepping it.**
`!scripts['db:seed'].includes('0002')` passes trivially — `db:seed` names no seed file, only other
scripts — and a substring check for `db:seed:catalog` also matches `db:seed:catalog:full`, the one
script that must be there. The test follows the `npm run` edges to the actual `--file=` targets, so
it asserts what is really run and survives a rename. 4 tests.

**One live hazard found and closed.** `db:seed:catalog:staging` ran seed **0002 against remote
staging** — P1-0's defect, aimed at a deployed database, one typo away from the `:full:` script
beside it. That is not hypothetical: **P2-2 archived duplicate "Data Scientist" and
"TEACHER"/"Teacher" rows off staging by hand.** Deleted (nothing referenced it), and a third test
now asserts *no* `--remote` seed runner points at 0002. Reproducing pre-audit behaviour is a local
activity; `db:seed:catalog` (`--local`) is untouched and a test guards that it still exists, since
the fix for P1-0 was to unchain 0002, not to delete it.

**Also fixed, out of scope and worth naming:** `backend/.prettierrc.json` was malformed — a
duplicated fragment after the closing brace, committed in `a5002b1` — so `npm run format` and
`format:check` both failed to load *any* config and 79 files have drifted since. The config is
repaired and the new test is formatted; **the other 78 files are left alone** (a tree-wide reformat
is its own change, and `format:check` is not in CI). → **P4-14**.

* **Files:** `backend/scripts/platform-gates.mjs`, `backend/test/platform/seed-chain.test.ts` (new),
  `backend/package.json`, `frontend/package.json`, `backend/.prettierrc.json`,
  `.github/workflows/ci.yml`
* **Verify:** ✅ **every gate fired before it was trusted.**
  * `Logo.tsx` re-pointed at the real `frontend/assets/careerlinkai_logo.png` (3,263,552 B) → built →
    **2 gates fail** (`3187 KiB` file, `3665 KiB` total), exit **1**. Reverted → rebuilt → **all pass**, exit **0**.
  * A 1126 KiB `.js` dropped into `dist/assets` → chunk gate fails, and media total stays 492 KiB —
    proving the code/media split. The 1226 KiB `pdf.worker.min-*.mjs` passes throughout, proving the
    exemption is real rather than blanket.
  * `dist/index.html` removed → gate refuses to measure at all, rather than passing on the empty
    `dist/` that `build-frontend.mjs --ensure-only` creates for `gate:bundle`.
  * P1-0 re-injected into `package.json` (0002 back in the chain, `:staging` runner restored) →
    **2 of 4 tests fail**; reverted → 4 pass.
  * Full run: backend **815 passing** (63 files, was 811), frontend **150**, type-check · lint ·
    `gate:platform` · `gate:bundle` (260 KiB) · build all clean.
* **Effort:** 2–3 h (as estimated).

### `[x]` **P1-4 — Tests for the Phase 0 UI** — *done 2026-07-29. 127 → 150.*

All four controls covered, in **23 tests** rather than the estimated ~12 — the four outcomes each
control has (armed / confirmed / cancelled / failed, or set / `null` / error) are the point of them,
so one test per control would have asserted only that it renders.

* **Reset password — 6 tests** (`CounselorManagementPage.test.tsx`). The confirmation is inert on the
  first click; Cancel abandons it; **the issued password reaches the banner** against the right
  counselor; a failure raises a toast and shows *no* banner. The last one matters more than it
  reads: the password is returned once and is not stored, not logged and not retrievable, so a
  reset whose password never reaches the screen has destroyed the account it was pressed to
  recover. Also asserts the confirmation is **per row** — shared confirm state would put "Confirm
  reset" under a counselor the admin never touched.
* **Install RIASEC & SCCT — 6 tests** (`AssessmentManagementPage.test.tsx`). Admin sees it, counselor
  never does, and — the one worth the file — **an admin browsing the counselor shell still sees it**.
  The page is shared by both shells, so `base` is sitting right there and reads like the obvious
  condition; it is a fact about the URL, not about the caller. Gating on it would look correct in
  every screenshot and be wrong for the only person who can use the button. `created: false` is
  asserted *not* to report as work done.
* **Student Rebuild — 4 tests** (added to `RecommendationPage.test.tsx`). The three C4 outcomes, plus
  the recovery P2-2 found live on staging: empty state → Rebuild → cards. `null` raises an **info**
  toast, not an error; a throttled rebuild leaves the standing set on screen.
* **`ErrorBoundary` — 7 tests** (`ErrorBoundary.test.tsx`). The component least likely to be covered
  by anything else, since it only runs when everything else has already failed. "Try again" is
  asserted to genuinely re-render the subtree (recovering when the cause was transient, and
  catching its own retry when it was not) — a fallback that cleared its state but left the child
  unmounted would look identical the moment it appeared.
* **One defect found, in the tests rather than the product.** `RecommendationPage.test.tsx`'s
  `beforeEach` set its mock's return value but never reset the mock, so call *counts* accumulated
  across the file: the new "rebuilt without a refetch" assertion failed at `expected 1, got 14`.
  Any "fetched exactly once" claim in that file was silently measuring every test that had run
  before it — which is the shape of assertion P2-1 relies on for its own lazy-fetch guarantee.
  Fixed at the source (`mockReset()` in the shared setup) rather than worked around locally.
* **No product defects.** Unlike P1-2 and P2-2, all four controls behaved as written. Recorded
  plainly because a follow-up item that finds nothing is still worth the finding.
* **Files:** `ErrorBoundary.test.tsx`, `CounselorManagementPage.test.tsx`,
  `AssessmentManagementPage.test.tsx` (all new), `RecommendationPage.test.tsx`
* **Verify:** ✅ `cd frontend && npm test` → **150 passing, 18 files** (was 127/15). Type-check and
  build clean; backend re-run at **811** and lint clean, both untouched.
  *(The original verify line read "104 + ~12" — that baseline predated P2-1 and P2-3.)*

---

## Phase 2 — Before the defense

Everything here is user-visible. None of it is deep.

### `[x]` **P2-1 — Counselor student-recommendations panel** — *done 2026-07-28. Closes F2 + P1-1.*

* **Why:** a counselor could not see their own students' recommendations. The backend route, the
  API client, and **two** hooks all existed; no page rendered them. Admins could see student
  recommendations via `CounselorDetailPage` — the counselor who actually advises the student could not.
* **Done:** `ClassRecommendationsPanel` on `ClassDetailPage` — one row per enrolled student with
  their Holland code, expanding to their top five careers and programs plus a **Rebuild** button.
  Both previously-orphaned hooks now have a consumer.
* **Presentation is shared, not mirrored.** The item said "mirror `CounselorDetailPage` so the two
  do not drift"; two copies drift by definition, so the lists were extracted to
  `components/recommendations/StudentRecommendationLists.tsx` and *both* screens now render the same
  component. The admin page lost ~50 lines in the process.
* **One student open at a time, fetched on open.** There is no bulk endpoint here — the admin's
  roster arrives hydrated server-side, this one does not — so a panel that mounted the hook per
  student would fire one request per enrolled student on page load. `useStudentRecommendations`
  gained an `enabled` parameter for this, matching the existing `useCareerPrograms` pattern. Holland
  codes come from the class results already cached by `ClassResultsPanel`, so the panel adds **zero**
  requests until a row is opened.
* **Files:** `ClassRecommendationsPanel.tsx` (new), `StudentRecommendationLists.tsx` (new),
  `ClassDetailPage.tsx`, `CounselorDetailPage.tsx`, `useRecommendations.ts`
* **Verify:** ✅ 8 new component tests (`ClassRecommendationsPanel.test.tsx`), incl. the three
  load-bearing claims — nothing fetched until a row opens; `null` rebuild raises an *info* toast, not
  an error (the C4 distinction); a rebuilt set swaps the cards with no refetch. Frontend suite
  **104 → 112 passing**; type-check and build clean. The 404-not-403 rule is backend-side and already
  covered by `authorizeStudentRecommendations`' own tests.

### `[x]` **P2-2 — Rehearse the full demo path on staging** — *done 2026-07-28. Found a defect that disabled the product.*

It was the highest-value item in Phase 2 and it earned that billing twice over.

**The headline: recommendations were generated for nobody, and the cause was audit fix P0-1.**

`generateFor` 500s on the deployed Worker. `scorableCareersForMany` passes **every rankable
programme** to one `inArray`, which binds one parameter per id against D1's ceiling of 100. The
catalog held 16 programmes before P0-1 and 309 after — so the change made *specifically* to let the
ranking discriminate between students is the change that pushed the query past the limit. It threw
`too many SQL variables`, the `AssessmentCompleted` listener swallowed it exactly as designed (a
recommendation failure must never fail a submitted assessment), and every student who completed both
instruments received a correctly scored assessment and **zero recommendations**, with no error
anywhere a human would look. Miniflare enforces no parameter limit, so all 807 tests passed.

This is the **fourth** time this project has shipped past D1's 100-parameter ceiling, and the first
on the *read* side — `lib/d1-batching.ts` existed but was framed entirely around INSERT *width*, and
`WHERE id IN (…)` is not wide, it is long. Fixed with a `chunkIds` helper in that module and applied
to the three catalog-scale `inArray`s (`scorableCareersForMany`, `offeringCountsFor`, `careersFor`);
4 regression tests added beside the existing insert-side ones. **811 backend tests pass.**

* **Steps 1–5 all ran green** against `careerlinkai-staging`. Migrations were already current;
  RIASEC/SCCT were already installed and PUBLISHED (60 + 30 items), so step 3 was a no-op.
* **`walkthrough.mjs` was three releases stale** and could not run at all. Fixed: the career form's
  free-text salary/outlook became numeric min/max plus a lookup `<select>` (migration 0013); the
  class form's `#grade_level` text box became two `<select>`s (migration 0017); the player's
  "Submit assessment" became "Finish assessment" and stopped naming the total in "All questions
  answered". Worst of the four: **the player no longer auto-advances** (removed because two taps in
  one 150 ms window queued two advances), so the script clicked the same first question sixty times,
  POSTed sixty answers to one item, and reported "60 answered" while never leaving question one.
  Its 30 s timeouts were also too tight for a deployed Worker and are now a `--timeout` flag
  defaulting to 90 s — raised rather than retried, so a step that genuinely becomes slow still fails.
* **Two duplicate careers found on staging and archived** — "Data Scientist" and "TEACHER"/"Teacher".
  Both are P1-0's defect class surviving in data: hand-created rows colliding with seed 0004 under
  different ids. The second is *case-insensitive*, which an exact-title check misses. Seed 0004 also
  refused to apply at first for the same reason from the other end: migration 0018's backfill had
  already claimed the `BSCS` and `BEED` canonical entries, so `INSERT OR IGNORE` skipped 0004's rows
  and every programme referencing them failed the FK. → **P4-12**.
* **Step 6, the one that matters** — now automated as `scripts/contrast-check.mjs` rather than done
  by hand, so it can be re-run before the defense. Two students, deliberately opposite RIASEC answers
  (R/I/C against A/S/E), **identical SCCT answers** so interest profile is the only variable. The
  answer key is fetched as the admin through the builder's own endpoint, because the student payload
  carries no dimension and no option score (§25) — a student's client genuinely cannot know which
  item measures what.

  Holland codes came out **RIC** and **ASE** as designed, and the lists are coherent, not merely
  different:

  | | juan.delacruz2 (RIC) | jose.pena.edited (ASE) |
  |---|---|---|
  | 1 | Chemical Engineer · 97.0 | Journalist · 97.0 |
  | 2 | Chemist · 97.0 | Marketing Manager · 97.0 |
  | 3 | Civil Engineer · 97.0 | Teacher · 97.0 |
  | top programme | BS Chemical Engineering | AB Communication |

* **Verify:** ✅ **career overlap 0/10, programme overlap 0/10.** C1 is closed on a deployed system,
  which is the claim it was always making and had never demonstrated.

### `[x]` **P2-3 — Accessibility pass on the demo path** — *done 2026-07-29.*

Scoped exactly as written: login → join → player → results → recommendations. Not a full audit —
the admin and counselor screens were left alone.

**The player was the item.** Its options were five `<button aria-pressed>` elements, which is a
toolbar of independent toggles. Choosing one of five mutually exclusive answers is a **radio
group**, and on a sixty-item instrument the difference is not pedantry:

* Five tab stops per question is **300** presses of Tab to reach the end of RIASEC. One tab stop
  with a roving `tabIndex` is 60, and the arrow keys move between options the way they do in every
  other radio group a student has used.
* `aria-pressed` is announced as "pressed" / "not pressed" — an option that is *on*, rather than the
  one that is *the answer*, and never one of a set. `aria-checked` inside a labelled `radiogroup`
  is announced as "selected, 3 of 5".
* **The question changed silently.** Next swapped the DOM under a focused button and announced
  nothing. Focus now moves to the question heading, and a `role="status"` carries the position —
  deliberately *only* the position, since the answered count changes on every tap and a region that
  speaks sixty times per instrument is one a student learns to ignore.

**Four more defects, each on a different screen:**

* **Neither sign-in screen had an `h1` on a phone.** The only `h1` was the marketing line on the
  artwork panel, which is `hidden lg:flex` — so the heading outline changed with the viewport, and
  on mobile the page had no title at all. `CardTitle` gained an `as` prop (a heading level is a fact
  about the page, not about the component); the form card is now the `h1` and the panel line is a `<p>`.
* **Validation messages were not attached to their fields.** Every form set `aria-invalid` and
  printed the reason in a neighbouring `<p>` the input had no relationship to. `aria-invalid`
  announces "invalid" and stops. New `FieldError` + `describedBy` helpers wire `aria-describedby`
  and `role="alert"`. This also fixed a real bug on both forms: `aria-invalid` was computed from the
  *client* error alone, so a server-rejected field was announced as valid with a red message under it.
* **No skip link.** Nine sidebar links render before the content on every signed-in route.
* **The recommendations outline was flat** — `h1`, two section `h2`s, then every card also an `h2`,
  so eight headings read as eight siblings. Cards are `h3` under named sections now. "88.5%" and
  "#2" also gained the sr-only words saying what they measure; "Explain more" no longer drops focus
  to `<body>` when the button is replaced by its own answer.

**Verified in real Chrome, not by reading the source.** The audit lives inside `walkthrough.mjs`
rather than in a script of its own, for one reason: reaching the player needs a class, a roster, an
assignment and a live attempt, which the walkthrough has already built by the time it gets there. A
standalone a11y script could audit every screen except the one worth auditing.

* **Files:** `AssessmentPlayerPage.tsx`, `RecommendationPage.tsx`, `ResultPage.tsx`,
  `AssessmentListPage.tsx`, `StudentAccessPage.tsx`, `CredentialsLoginForm.tsx`,
  `RecommendationChatPanel.tsx`, `AppShell.tsx`, `StaffAuthLayout.tsx`, `StudentAccessLayout.tsx`,
  `ui/card.tsx`, `ui/field-error.tsx` (new), `scripts/walkthrough.mjs`
* **Verify:** ✅ **31 new `[a11y]` checks green in real Chrome** across the five demo screens
  (one `h1`, no skipped levels, every control named, every image `alt`-ed — plus the skip link
  proved by pressing Tab, and the player's radio group, single tab stop and arrow-key selection
  read off Chrome's own accessibility tree). Full local run: **94 passing**; the only 3 failures are
  the Phase 5a RAG legs, which `wrangler.local.toml` cannot serve (no `[ai]`/`[[vectorize]]`
  bindings — `RETRIEVAL_UNAVAILABLE`) and which failed identically *before* this change.
  Frontend suite **112 → 127**; type-check and build clean.

---

## Phase 3 — Before production launch

### `[x]` **P3-1 — Production cutover** — *steps 1–8 done 2026-07-30, steps 9–10 done 2026-07-31. Found the defect step 8 exists to find. C1 proven on production: **0/10**.*

**All ten steps are done and every one of them was verified rather than asserted.**

**Step 9 (done by the operator, verified from the database rather than taken on trust).** Both staff
accounts are past the rotation gate (`must_change_password = 0`) and the instruments are installed:
2 templates, 3 versions, **90 questions** (RIASEC 60 + SCCT 30), 450 options, 9 dimensions, with one
PUBLISHED version each and one DRAFT left behind by the seed. Checked in D1, because "the button was
pressed" and "the instruments are installed and assignable" are different claims.

**Step 10 — the one that actually proves the deployment, and it passed.** Run through the repo's own
`contrast-check.mjs` against `https://careerlinkai.online`: two students in one class, deliberately
opposite RIASEC answers (RIC against ASE) and **identical SCCT answers**, so interest profile is the
only variable.

| | carla.limsmoke… (RIC) | dino.tansmoke… (ASE) |
|---|---|---|
| 1 | Chemical Engineer · 97.0 | Journalist · 97.0 |
| 2 | Chemist · 97.0 | Marketing Manager · 97.0 |
| 3 | Civil Engineer · 97.0 | Teacher · 97.0 |
| top programme | BS Chemical Engineering | AB Communication |

**Career overlap 0/10, programme overlap 0/10.** C1 was closed on staging by P2-2; this is the same
claim demonstrated on the system students will actually use.

**Three things the run itself found:**

* **`contrast-check.mjs` had no retry and could not survive its own length.** One run is ~190
  requests, and production reset the TLS connection twice — once before the second student started,
  once mid-instrument. That is not a cost of one request: `start` returns **422 on an assignment the
  student has already submitted** (§21), so a blip half way through burns the whole run *and both
  students*, who can never be reused. Network failures are now retried four times; a 4xx/5xx is
  never retried, because this script exists to detect a broken deployment and a retry loop around a
  real error is how a check reports green on a system that is failing.
* **The list envelope is not uniform.** `/counselor/assessment-templates` returns `data` as an
  array; `/counselor/classes` returns an object. Neither is wrong, but a caller cannot treat them
  alike, and this cost a failed run before it was noticed. Worth a look when P4-8 tidies API
  consistency.
* **The assignable version id is `assignable_version.id`**, not any of the three names guessed for
  it. Read off the API rather than assumed — the mistake cost one round trip and is recorded because
  guessing a field name is exactly how a script goes stale (P2-2, P3-3).

**What it left in the live database, stated plainly rather than quietly:** one class
`SMOKE 20260731 — P3-1 step 10` (`WKAM-9775`), **4 students**, 7 attempts (6 complete, 1 abandoned
by the first ECONNRESET), 6 results and **60 recommendations**. Everything is stamped `SMOKE` so it
is identifiable and removable; it is deliberately not deleted yet, because it is the evidence that
this step passed.

**What is live and verified:** `https://careerlinkai.online/api/v1/health` →
`{"status":"ok","environment":"production","version":"v1"}` on both apex and `www`; the served
`index.html` is the current build (entry `index-DCwsQ7y5.js` and `index-C6tHFjIC.css`, hashes
matching the local `dist/` exactly, P3-3's modulepreload split present, and none of the April build's
Fraunces preconnects); all five route chunks 200 with `immutable` caching; CSP, HSTS, X-Frame-Options
and Permissions-Policy all present on the document with one `Cache-Control` value, not the
accumulation P1-2 checked for. D1: **19 migrations applied, 20 colleges / 68 careers / 48 canonical /
309 offerings / 933 mappings, 0 case-insensitive duplicates, 0 programmes with a NULL canonical
link** — P1-0's and P2-2's defect classes both checked on the real database rather than assumed.

**The cutover's own step 8 caught a defect that had been wrong in three documents at once.** Wrangler
derives an environment's script name as `<name>-<env>`, so `npm run deploy:production` publishes
**`careerlinkai-production`** — and `careerlinkai.online` was attached to the bare **`careerlinkai`**
script, from the era when production was a plain `wrangler deploy` and no environments existed.
`DEPLOYMENT.md` (§ the routing diagram *and* the environments table), `PRODUCTION_REQUIREMENTS.md` §6
and `wrangler.toml`'s own comment all stated the two were one script. **Nothing caught it because
`--env production` had never once been run** — staging is `careerlinkai-staging` and proves the
derivation, which is exactly the evidence that would have predicted this. So the first cutover
published a *third* Worker, healthy and correct and reachable by nobody, while the live domain went on
serving the April build. `curl` on the domain is the only instrument that could see it, and it is
step 8.

**The obvious fix was tried first and refused by Cloudflare, which is the more useful finding.**
Pinning `name = "careerlinkai"` in `[env.production]` to overwrite the legacy script in place
resolves correctly (proven: `deployments list --env production` returned the April history) — and the
deploy is then **rejected**: *"New version of script does not export class `NotificationDO` which is
depended on by existing Durable Objects."* The legacy script holds live DO instances of a class that
appears **in no committed config and nowhere in the current codebase** — the Initial Commit's
`wrangler.toml` has no `[[migrations]]` and no `durable_objects` block at all. Its migration-tag state
is therefore not derivable from this repository, and the only way through is a `deleted_classes`
migration that destroys DO data nobody can inspect first. Deleting production Durable Objects to work
around a *naming* mismatch is the wrong trade, so the domains were moved to the environment Wrangler
already names.

* **The attachment is now in `wrangler.toml`**, not the dashboard —
  `[[env.production.routes]]` with `custom_domain = true`, for apex and `www`. Which script answers
  the live domain was previously a fact stored only in a UI, which is how it drifted from three
  documents without any of them going red; it is now re-asserted by every `wrangler deploy` and
  reviewable in a diff.
* **The legacy `careerlinkai` script is deliberately left deployed and domain-less** as a rollback
  target. This also defuses rather than creates a footgun: a `wrangler deploy` with no `--env` targets
  that script using the top-level `[vars]` block, which declares `APP_ENV = "local"` and
  `FRONTEND_URL = localhost:5173` **against production's D1, R2, KV and queues**. Under the rejected
  in-place approach that mistake would have put a Worker believing itself local onto the live domain;
  now it publishes something unreachable.
* **A queue accepts exactly one consumer**, so the first deploy's registrations had to be detached
  from the abandoned sibling before the real one could take them (`Cannot delete this Worker as it is
  a consumer for a Queue [code: 10064]`). Worth knowing before any future re-point: the failure
  arrives at *delete* time, not at deploy time.
* **Login was verified against the deployed Worker, not just asserted.** `bootstrap-staff.mjs` carries
  `--verify-url` precisely because the script's PBKDF2 must agree with the Worker's — and it could not
  be used here, since the accounts are seeded before the deploy exists. Checked afterwards by hand:
  `POST /api/v1/auth/login` → **200, `role: admin`, `must_change_password: true`, token issued, 3.0 s**.
  That latency is the finding: 600,000 iterations running inside `AuthGuardDO`'s 30-second budget
  (deviation D14) on a Free-plan Worker whose own limit is 10 ms. It also proves the DO migration
  applied on the fresh script.
* **First backup taken before the first deploy**, per this plan's own note that steps 4–6 are the
  state most expensive to recreate: **PASS — 432.4 KB, 45 tables, 1,516 rows**, verified table by
  table against the live database, with the Time Travel bookmark recorded.
* **Migrations were not all pending.** The runbook expected 19; production already had 0001–0016 from
  an earlier partial run, so only 0017–0019 applied. `migrations list` then confirmed none pending,
  which is the assertion that actually matters and the reason the runbook asks for it separately.
* **Still open:** steps 9–10, and Vectorize `careerlinkai_main_knowledge` remains empty (§7 of
  `PRODUCTION_REQUIREMENTS.md`) — RAG-grounded explanations need an ingestion pass; the deterministic
  §27 reasons work without it, which is the §29 posture.

Original runbook, for the record. Needs live Cloudflare credentials and is irreversible; deliberately
not automated. `PRODUCTION_REQUIREMENTS.md` is correct on migrations, seed 0004, the install step and
rollback.

```
1. npx wrangler queues create careerlinkai-default-dlq
   npx wrangler queues create careerlinkai-ai-dlq
2. npm run db:migrate:production
3. npx wrangler d1 migrations list CareerLinkAI_Main --remote --env production   # expect none pending
4. node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --env production   # capture temp password
5. npm run db:seed:catalog:full:production          # 0004 — NOT 0002 (see P1-0)
6. npm run db:seed:ai-policy:production
7. npm run deploy:production
8. curl https://careerlinkai.online/api/v1/health   # expect {"environment":"production"}
9. Sign in as admin → rotate password → Install RIASEC & SCCT
10. End-to-end: class → student → both assessments → recommendations differ between two profiles
```

**Do P1-2 and P2-2 first.** Steps 8 and 9 can both pass on a system that still has a broken CSP or a
duplicated catalog; step 10 is the only one that catches either.

### `[x]` **P3-2 — Catalog search** — *done 2026-07-29. 838 → 863 BE, 150 → 165 FE. Two more latent list defects found.*

Scoped as written — `search`/`sort` on the schema and service, search inputs on the four pages, and
the picker converted to a server-backed typeahead. Two things were found on the way that the item
did not name.

**The Colleges page was already over its own edge.** It had **no pager and no search**, and
`catalogApi.listColleges()` sent no `per_page` — so it took the API's default of **20**. Seed 0004
installs exactly **20 colleges**. The page was rendering 20 of 20 and looking complete, one added
institution away from hiding one with nothing on screen to say so. That is F3's shape on a second
surface, and it was already at the boundary rather than approaching it.

**Sorting by `created_at` was not safe to add until paging was made total.** Seed 0004 inserts its
68 careers in **one statement**, and SQLite evaluates `'now'` once per statement — so every seeded
career carries a byte-identical `created_at`. `ORDER BY created_at LIMIT/OFFSET` over a column where
the whole table ties leaves the row order unspecified, and unspecified *per execution*: page one and
page two are two queries, so a row may appear on both while another appears on neither. Every list
now ends its `ORDER BY` with the id (`AcademicCatalogService.orderFor`), making the order strict.
Recorded honestly: the guard proves the **order** claim — pulled out, the tied rows came back in
insertion order and the test went red. Miniflare happened to be self-consistent across the two
paged queries, so the duplicate-row scenario is what the unspecified order *permits*, not something
that was observed.

**`%` and `_` in a search term are now escaped** (`lib/search.ts`, `ESCAPE '\'`). Without it a search
is a pattern language the user did not know they were writing: `100%` matched "100 Metre Sprinter"
as well as "100% Remote Analyst" — proved by removing the escaping and watching the test fail. Not a
security hole (the term is still a bound parameter) but a wrong answer, and `_` is the one a user
hits by accident while typing a code.

**The picker fetches on open, not on mount.** A college page renders one `CareerMapping` per
program, so a hook that fetched on mount would fire one request per program before the admin touched
anything — `Combobox` gained `onOpenChange` for this, the same guarantee P2-1's panel makes. It also
**says when it is truncating**: "Showing 20 of 150 — keep typing to narrow it down." Silence about
the remaining 130 is precisely what made F3 invisible.

**Shared rather than mirrored, as P2-1 established.** `useDebouncedValue` existed as **three
identical private copies** and this item needed three more; it is one hook now (`SEARCH_DEBOUNCE_MS`
with it) and the three originals import it. `SearchInput` and `Pagination` were extracted from
`AddressTable`, which owned the only copies, and `AddressTable` now consumes them — losing its
`page` prop in the process, because the pager reads `pagination.current_page` from the response and
the caller's `page` is what it *asked* for, which is the same thing only once the request lands. The
"changing a filter returns to page one" rule lives once, in `useListFilters`, because getting it
right on three pages out of four is exactly the kind of thing that survives review.

* **Also done:** status filters on all four lists, `sort=code` for canonical programmes, and
  `search`/`status` on Knowledge (F4) — the status one earns its place: a document stuck in
  `PROCESSING` or returned `FAILED` contributes nothing to retrieval and is indistinguishable from a
  healthy one in a list ordered by upload date.
* **Files:** `backend/src/lib/search.ts` (new), `modules/catalog/{schemas,routes,academic-catalog-service}.ts`,
  `modules/ai/{schemas,routes,knowledge-ingestion-service}.ts`,
  `backend/test/catalog/search.test.ts` (new), `test/ai/ingestion.test.ts`,
  `frontend/src/hooks/{useDebouncedValue,useListFilters}.ts` (new),
  `components/ui/{search-input,pagination}.tsx` (new), `components/ui/combobox.tsx`,
  `services/{catalogApi,aiApi}.ts`, `features/admin/hooks/{useCatalog,useAiKnowledge}.ts`,
  `features/admin/components/{CareerMapping,AddressTable}.tsx`,
  `features/admin/pages/{CareerListPage,CollegeListPage,CanonicalProgramPage,KnowledgeListPage,AddressPage,AuditLogPage}.tsx`,
  `features/assessment-builder/pages/AssessmentManagementPage.tsx`,
  `CareerMapping.test.tsx`, `CareerListPage.test.tsx` (new)
* **Verify:** ✅ **the item's own line, both halves.** 150 careers seeded, the 150th (`Zythologist`)
  sorted last by title: `?per_page=100` returns 100 items, `total: 150`, and **does not contain it** —
  the defect as it shipped — while `?search=zytho&status=active&per_page=20` returns exactly it.
  Both assertions in one test, because either alone says nothing.
  ✅ **Every new guard fired before it was trusted** (P1-3's rule): escaping removed → the `%`/`_`
  test red; the id tie-break removed → both paging tests red; the search term withheld from the
  server → the frontend's "finds a career that is not on the first page" test red. All restored and
  green. Full run: backend **863 passing** (65 files, was 838/65), frontend **165** (19 files, was
  150/18), type-check · lint · `gate:platform` · `gate:bundle` (262 KiB) · `gate:assets` · build all
  clean.
* **One D1 lesson, met by the test rather than by production this time.** The 150-row fixture insert
  binds 11 columns × 150 = **1,650 parameters** and died on D1's 100-parameter ceiling — the P2-2
  wall, hit by the very test written to prove the catalog can exceed 100 rows. Fixed with the
  existing `chunkForInsert`, which reads the width off the schema.
* **Effort:** 4–6 h (as estimated).

### `[x]` **P3-2a — The two defects P3-2 exposed, fixed rather than filed** — *done 2026-07-29. 863 → 867 BE, 165 → 171 FE.*

Both were written up as P4 follow-ups first. That was the wrong call and they were pulled forward:
one of them is F1/F2 — the exact defect class this plan opens by naming — and the other sits under
the only control on that screen that changes what students are shown.

**`GET /admin/canonical-programs/options` had no caller at all.** Not the program form its own
comment claimed it served (`ProgramForm` never mentions canonical programmes), not any other page —
`useCanonicalProgramOptions` and `catalogApi.canonicalProgramOptions()` were both orphans, reachable
only by `curl` and one backend test. That is **F1 and F2 together**: an endpoint with no caller and
a hook with no page. Phase 0 fixed one instance of this, P1-1 recorded a second, and this is a
third that had been sitting in the catalog module the whole time.

It was also **unbounded** — `allCanonicalPrograms()`, returning every active entry with no limit,
under a comment reading *"Two dozen rows at thesis scale."* Seed 0004 installs 48, and migration
0018's backfill mints a new entry for **every unseen programme code an admin types**, so the row
count is driven by data entry and had no ceiling anywhere between the database and the browser.
That is F3's assumption made from the other end: not a silent truncation, a response with no bound.

**The merge target picker was reading the page, not the catalog.** `MergePanel` was handed
`entries.filter(…)` — the ≤50 rows currently on screen. Past one page, an entry could not be merged
into a target that happened to sit on another one, and nothing said so: the option was simply
absent. **P3-2 made this worse before it made it better** — search let an admin find the target,
scroll to its row and press Merge, only to still not find it among the candidates.

**One fix, because they are one problem.** The orphaned endpoint is exactly what the merge picker
needed: `?search=`, capped at 20 (matching the careers typeahead), with the offerings count carried
alongside — not decoration in front of a merge, since "7 offerings" against a candidate is the
difference between absorbing a stub and absorbing a live entry, and it is the number that says
which direction the merge should run. The endpoint now has one real caller and a bound; the picker
now reaches the whole catalog.

**One a11y defect found while testing it.** The row actions were three buttons named "View
colleges", "Edit" and "Merge" with nothing distinguishing the rows — nine entries present nine
identically-named buttons to a screen reader, with no way to tell which entry is about to be
retired. Each now carries an `aria-label` naming its code; the visible text is unchanged, since the
row is obvious on screen. Same rule as P2-3, applied where P2-3 did not reach (it scoped itself to
the demo path and left the admin screens alone, deliberately and on the record).

* **Files:** `modules/catalog/{academic-catalog-service,routes}.ts`, `backend/test/catalog/search.test.ts`,
  `services/catalogApi.ts`, `features/admin/hooks/useCatalog.ts`,
  `features/admin/pages/CanonicalProgramPage.tsx`, `CanonicalProgramPage.test.tsx` (new)
* **Verify:** ✅ 4 backend tests — 35 entries in, 20 out; an entry past the cap **unreachable by
  paging and reachable by searching** (the same paired assertion P3-2's F3 test makes, since a cap
  without a search is just a quieter truncation); the offerings count survives the filter; archived
  entries are not offered. ✅ 6 frontend tests — nothing fetched until a merge panel opens, a target
  **not on the current page** found by typing, the source never offered as its own target, the
  confirmation step still required. Full run: backend **867** (65 files), frontend **171** (20
  files, was 165/19); type-check · lint · `gate:platform` · `gate:bundle` (262 KiB) ·
  `gate:assets` (929 KiB chunk) · build all clean.

### `[~]` **P3-3 — Code splitting** — *done 2026-07-29. 972 → 507 KiB on the student path. **The < 350 kB target is not reachable by splitting**, and the measurement is why.*

Partial, and marked `[~]` for one reason: the item's own verify line asks for **< 350 kB** and the
answer is **507 KiB**. Everything else it asks for is done and the split is real, but the number is
the number.

**The 350 kB was set against an assumption the build does not support.** The 936 kB chunk was read
as "every admin, counselor and student page", and it was not — **41% of it was framework**. Measured
after the split, the entry closure is **399 KiB** (124 KiB gzipped): React, React DOM, React Router,
TanStack Query, axios, Zustand and the one stylesheet, reached by `main.tsx`, `providers.tsx` and
`ProtectedRoute`, all of which must run *before* the app knows which shell to fetch. No route split
can move any of it, because every route needs all of it. 350 KiB is **below the floor** — it is not
a harder version of this item, it is a different item (a dependency change), and the two candidates
are measured and filed as P4-15 and P4-16 rather than guessed at.

What the split actually bought, from the gate's own table:

| | raw | gzip |
|---|---|---|
| **before** — one chunk, every screen | **972 KiB** | **279 KiB** |
| after — student screen cold load | **507 KiB** | **159 KiB** |
| after — entry alone (the floor) | 399 KiB | 124 KiB |

**−47.8% raw, −43.0% gzipped**, against the estimated 60–70%. Route chunks: admin 112 KiB, builder
76 KiB, student 49 KiB, counselor 38 KiB, public 23 KiB, auth 13 KiB, access 4 KiB. A student no
longer downloads the other **262 KiB** of route code.

**One correction to the finding's own wording.** "The pdf.js integration they will never open" was
already false: pdf.js (415 KiB) and mammoth (486 KiB) have always been behind the `import()` in
`extractText.ts` and were never in that chunk. What a student really downloaded was every admin,
counselor and builder *page* — which is the part the split removes.

**Seven groups, not the five the item names**, for two reasons that only appear against the routes
as they are. The assessment builder is routed by **both** staff shells under different paths (§31),
so it belongs to neither and is its own group — folding it into `admin` and `counselor` would ship
it twice. And `/join` is not a staff door: it takes no password (§38) and is where `ProtectedRoute`
*sends* an unauthenticated student, so it is the first screen on the student path and does not
belong in a chunk with two login forms a student can never submit.

**`ProtectedRoute` and `RoleHome` stay eager, deliberately.** The decision that an anonymous visitor
may not have the admin shell has to be made before the admin shell is fetched; downloading 112 KiB
of admin pages in order to be redirected away from them would be a working redirect and a defeated
split. There is a test for exactly that.

**One chunk per group, not one per page.** `lazy(() => import(page))` eleven times for the admin
shell is the obvious spelling and gives eleven chunks and eleven round trips as an admin walks their
own sidebar. `routeGroup()` takes the group's barrel loader once and hands back a `pick`, so every
route of a group shares one in-flight promise.

**The gate is the point, more than the split is.** A code split does not fail loudly: one
`import { AdminLayout } from '@/routes/groups/admin'` in a file the entry already reaches folds the
whole group back into the first bytes every visitor downloads, and the build, the type-check and all
182 frontend tests stay green. `platform-gates.mjs --assets` now reads **Vite's own manifest** —
where static `imports` and `dynamicImports` are kept apart by the bundler that made the decision —
and weighs each route's transitive closure. Answering it by scraping minified output would make the
budget depend on how the minifier spelled an import that week.

**Fired red before it was trusted (P1-3's rule), on the real build.** A static import of the admin
barrel added to `ProtectedRoute.tsx` → `admin-*.js` **ceases to exist**, the entry chunk goes
**209 → 468 kB**, and **4 gates fail, exit 1** — including "student screen cold load 710 KiB", the
audit P2 defect reproduced on demand. Reverted → all green, exit 0. The pure analyzer is driven red
separately in **10 backend tests** against synthetic manifests: a group folded in, a group still a
dynamic entry *and* eagerly reached (the shape where the chunk survives and the split does not, which
is why those are two predicates and not one), a declared group missing, no single entry, a dangling
import.

**The chunk ratchet P1-3 parked at 1000 KiB is now 550 KiB.** `index-*.js` is 204 KiB; the two
heaviest files in `dist/` are the lazy document parsers, mammoth (486 KiB) and pdf.js (415 KiB). 550
sits just above mammoth, so the largest *route* chunk has four times its own size in headroom while a
vendor dependency growing past the parsers still trips it.

**Two defects found, neither in the split:**

* **`walkthrough.mjs` had gone stale against P3-2** — it drove `select[id^="link-career-"]`, and
  P3-2 replaced that `<select>` with the server-backed `Combobox` typeahead. It reported "career-link
  select never rendered" and had been doing so since P3-2 landed. Same class as the four stale
  selectors P2-2 found, and the same lesson: this script is the thing that is supposed to notice a
  screen changing. Rewritten to drive the typeahead the way an admin does — open the picker, type,
  choose the option — which also exercises P3-2's fetch-on-open guarantee. The old code wrapped the
  passing branch in `if (await select.count())` with a failing `else`; that is how a walkthrough
  quietly stops walking, so the check is unconditional now.
* **`React.lazy` caches its own rejection, so "Try again" cannot recover a failed chunk load.**
  `routeGroup` drops its shared promise when the import rejects — so the *next* route of that group
  refetches — but the lazy component itself is permanently Rejected and re-throws without calling the
  initialiser again. `ErrorBoundary`'s "Try again" therefore does nothing for the one failure this
  item introduces (a tab left open across a deploy, holding a hashed filename that no longer exists).
  **"Go home" does recover**, and not by accident: it is `window.location.assign('/')`, a full
  document navigation, so the browser fetches a fresh `index.html`. That was written for a router
  that had itself thrown and happens to be exactly right here. Both halves are asserted, because the
  behaviour is invisible from either file alone — `routeGroup` looks like it retries and
  `ErrorBoundary` looks like its button works. → **P4-17**.

* **Files:** `frontend/src/routes/groups/{public,auth,access,admin,counselor,builder,student}.ts`
  (new), `routes/{routeGroup.ts,RouteFallback.tsx}` (new), `routes/router.tsx`,
  `routes/ProtectedRoute.tsx`, `routes/{router,routeGroup}.test.tsx` (new), `frontend/vite.config.ts`,
  `backend/scripts/lib/route-weight.mjs` (new), `backend/scripts/platform-gates.mjs`,
  `backend/scripts/build-frontend.mjs`, `backend/test/platform/route-weight.test.ts` (new),
  `scripts/walkthrough.mjs`, `.github/workflows/ci.yml`
* **Verify:** ✅ **the whole demo path re-walked in real Chrome — `walkthrough.mjs` 95/98**, the only
  failures being the same three Phase 5a RAG legs `wrangler.local.toml` cannot serve
  (`RETRIEVAL_UNAVAILABLE`, no `[ai]`/`[[vectorize]]`), which failed identically before this change.
  Zero uncaught errors, zero 5xx, all 31 `[a11y]` checks green. That is the assertion that matters:
  every screen in the app now arrives over a second request, and a student answered 60 items and was
  served ranked recommendations through it.
  ✅ **`csp-check.mjs` PASS, 15 screens** — dynamically fetched chunks are a new `script-src` surface
  and none of them is refused. Zod's accepted `eval` probe now fires on **12 of 15 screens instead of
  15**, which is the split visible from the other side: three screens no longer load Zod at all.
  ✅ Backend **877 passing** (66 files, was 867/65), frontend **182** (22 files, was 171/20);
  type-check · lint · `gate:platform` · `gate:bundle` (262 KiB) · `gate:assets` · build all clean.
  ⚠️ **Recorded rather than smoothed over:** the first full frontend run after the browser legs timed
  out 4 tests, **3 of them in files this change does not touch**. Two later runs — one with
  `node_modules/.vite` deleted — were 182/182. It is transform contention, not a regression, and
  `testTimeout` is raised to 15 s so a two-core CI runner does not hit it.
* **Effort:** 3–4 h (as estimated).

### `[x]` **P3-4 — General API rate limiting** — *done 2026-07-30. 877 → 892 BE. Found `/admin/dashboard` authenticating **six times per request**.*

Scoped as written — a coarse per-user limiter at ~300 req/min reusing `AuthGuardDO.charge()`. The
item's own alternative ("**or** Cloudflare WAF rules at the edge — likely the better call") is
answered rather than ignored: see below.

**It is charged inside `authenticate()`, not as a global middleware, and the item's wording made
that look easier than it is.** Hono's `app.use('*', …)` runs *before* the sub-router that owns
`authenticate()`, so a global middleware cannot see the user — it would have to charge after
`next()`, i.e. after the request it was meant to refuse had already run its queries. Mounting a
`rateLimit()` on each of the twelve routers instead puts one guarantee in twelve places, which is
the F1/F2 defect class this plan opens by naming: the thirteenth router forgets and nothing fails.
`authenticate()` is the single point where a token becomes a `User`, and a route that does not pass
through it has no user to charge.

**The defect that fell out of it, on the first test run.** §10 gives every module its own routes
file and several mount on the same prefix — six routers share `/admin`, four share `/counselor`.
Hono merges each sub-app's `use('*')` into the parent as `/{prefix}/*`, so a path whose handler
lives in the last-registered router runs the entire middleware chain of every router in front of it.
Measured through the new counter — which charges exactly once per execution of that middleware —
`/counselor/dashboard` ran `authenticate()` **4** times, `/admin/counselors` **5**, and
**`/admin/dashboard` 6**, at two D1 reads each. **Twelve reads to answer "who is this"** on the
admin's landing screen, before the handler ran one query of its own, against a free Worker's
50-subrequest ceiling (§45). Every response was correct throughout, which is why 877 green tests and
three phases of staging runs had nothing to say about it. A token cannot change mid-request, so an
early return when `c.get('user')` is already set is the whole fix, and it keeps the §10 router
layout. The counter is the only instrument in the system that could see this, so the guard lives in
its test file and is stated as a budget claim: **one request costs one unit**, or the number in
wrangler.toml means six different things depending on which screen was opened.

**The limit is a var, and it is the only one of the six limiters that is.** `AI_REQUEST_LIMIT` and
friends encode a security or cost rule that should not move without review; this is a capacity
number whose right value depends on the plan and the size of the school. It also has to be movable
by the suite: a test file compresses a day of one user's requests into three seconds
(`player.test.ts` alone drives ~200), so `wrangler.test.toml` runs at a ceiling no fixture can reach
— **the one var deliberately out of lockstep with wrangler.toml**, with the reason written where it
is set. The limiter still executes on every request the whole suite makes; only the number moves.
`platform-gates.mjs` now asserts every numeric var `lib/config.ts` requires is declared in all three
scopes, because `requireNumber` throws and this one is read inside `authenticate()`: an environment
that omitted it would answer **500 to every authenticated request**, and environments inherit no vars.

**`Retry-After` is now set for every 429 in the system**, from `app.onError` — the one place an
`ApiError` becomes HTTP — rather than at each throw site, and exposed through CORS beside
`X-Correlation-Id` (a cross-origin caller cannot read a header it is not allowed to see). The five
pre-existing limiters gained it for free. A 429 without it is a 429 the client guesses at, and
clients guess by retrying immediately into the counter that just refused them.

**The WAF half is documented, not claimed.** A per-user counter cannot express an anonymous flood —
there is no user to charge — and unauthenticated traffic still costs an invocation even when
refused. That belongs at the edge, and the edge is dashboard configuration: not in this repository,
not testable, not reviewable in a pull request. So it is written up as an operational step in
**DEPLOYMENT.md §8.1** (600/min per IP, not 300 — a computer lab shares one public IP and forty
students answering together must clear it) rather than asserted here as if it had been done. The two
are complementary; only one of them can have tests.

* **Cost, stated plainly:** one DO round trip per authenticated request, charged even on the refused
  one. That is the structural disadvantage of limiting inside the Worker rather than in front of it.
  Net effect is still strongly negative on subrequests, because the `authenticate()` fix removed up
  to **10 D1 reads** from the admin screens in the same change.
* **Files:** `src/middleware/rate-limit.ts` (new), `middleware/authenticate.ts`,
  `lib/{auth-guard,config,envelope}.ts`, `src/app.ts`, `src/env.ts`,
  `test/platform/rate-limit.test.ts` (new), `scripts/platform-gates.mjs`,
  `wrangler.{toml,test.toml,local.toml,dev.toml}`, `DEPLOYMENT.md`
* **Verify:** ✅ **15 tests, and every guard fired red before it was trusted** (P1-3's rule).
  Removing the idempotence fix → the "one unit per request" and "every router" tests go red;
  removing the `Retry-After` line → its test goes red; the charge itself unwired → the limit tests go
  red. All restored and green. The four claims pinned are the ones that would be silently false if
  the limiter were mounted the obvious way: it applies to **every** authenticated router (proven by
  spending the budget on three prefixes and being refused on a fourth), it is keyed per user, an
  unauthenticated request never charges it (ten 401s leave the budget whole) and a rate-limited user
  can still sign in.
  ✅ **No 429 anywhere in a real browser run** — `walkthrough.mjs` **95/98** against the local
  single-origin Worker at the production number (300), the only 3 failures being the same known
  Phase 5a RAG legs `wrangler.local.toml` cannot serve (`RETRIEVAL_UNAVAILABLE`, no
  `[ai]`/`[[vectorize]]`), identical to P3-3's run. One student POSTed **61 answers, 0 failed**, as
  fast as Playwright can click, alongside a full admin catalog build and a counselor roster — and
  the log contains **zero** 429s and zero unexpected console errors. That is the thing no unit test
  can tell you: whether the number chosen is above the heaviest workflow the product actually has.
  All 31 `[a11y]` checks green. `csp-check.mjs` **PASS, 15 screens** (Zod's accepted `eval` probe on
  12 of them, as P3-3 recorded).
* **Effort:** 3–4 h (as estimated).

### `[x]` **P3-5 — Backup and disaster recovery** — *done 2026-07-29. 815 → 834. Four D1 defects found.*

Full procedure in **[`BACKUP-AND-RECOVERY.md`](BACKUP-AND-RECOVERY.md)**. The item asked for
`wrangler d1 export` in a cron entry; that command is **not a backup**, and finding out why took the
whole of this item.

**`wrangler d1 export` exits 0 on an empty database.** Point it at a name that still resolves but is
no longer the database the Worker binds — a copy-pasted `--env`, a `database_id` swapped in
wrangler.toml — and it writes a well-formed dump of nothing, exits 0, and does so again every night.
You find out during the restore. So `d1-backup.mjs` reads the **live** database's table list and
`COUNT(*)` per table and asserts the dump agrees, table by table and row by row; a dump that fails is
renamed `.REJECTED` with **no manifest**, so the restore script cannot reach it and the last good
backup stays the last good backup. Counts are checked as a *range* bracketing the export, because a
production database takes writes while it is being backed up and a check that fails correct backups
is a check that gets deleted rather than fixed.

**Four D1 facts, none visible from 834 green tests, all found by running it.** Same class as P2-2's
100-parameter ceiling:

1. **A stock export dump cannot be restored by `wrangler d1 execute --file` at all** — not locally,
   not remotely. **Two** independent ordering defects, and the second was found only because the
   remote leg was run:
   * *Tables created after they are referenced.* `student_profiles` is created at line 133 with an
     inline `REFERENCES shs_strands (id)` and populated from line 152; `CREATE TABLE shs_strands` is
     at line **3841**. The leading `PRAGMA defer_foreign_keys=TRUE` would make that legal for a
     reader running the whole file in one transaction — **neither importer does**. →
     `no such table: main.shs_strands`.
   * *Rows inserted before the rows they reference.* Even with the schema loaded first, every
     `programs` row carries a `program_catalog_id` and `program_catalog` is written thirty tables
     later. → `FOREIGN KEY constraint failed`, **on the remote importer only**. The local one is
     more forgiving, so this one survives any amount of local rehearsal and appears for the first
     time on the path an actual recovery takes.

   **Fixed** by exporting in two halves (`--no-data`, `--no-schema`) and writing schema first with
   the rows regrouped parent-before-child — insert order is `dropOrder` reversed, so the wipe and
   the load read one graph in two directions and cannot disagree. Both halves are still verbatim
   from Cloudflare's exporter. A backup you cannot restore is not a disaster recovery plan; a backup
   you can only restore locally is worse, because it passes the rehearsal.
2. **D1 caps compound `SELECT`s at five terms.** The 45-table `UNION ALL` row-count sweep failed with
   `too many terms in compound SELECT [code: 7500]`; six is already too many. Stock SQLite's default
   is 500, so it worked on every local database and failed on the first real one. Scalar subqueries
   have no such ceiling.
3. **`sqlite_master` on deployed D1 lists an internal `_cf_KV`** that the export omits and that every
   query against fails with `not authorized: SQLITE_AUTH`. Miniflare creates no such table — so the
   obvious verification would have reported a missing table on **every** real run and passed locally.
4. **`wrangler d1 export --local --persist-to` crashes** (libuv assertion, exit `0xC0000409`) while
   `d1 execute --local --persist-to` accepts it. Documented; `db:backup:local` reads the default
   state directory.

**The restore is guarded, and every guard was fired before it was trusted** (P1-3's rule): a tampered
dump → SHA-256 mismatch, exit 1. Production as a target → refused, and identified from wrangler.toml
rather than by matching the word "production", since this project's production database is called
`CareerLinkAI_Main` — *which is also the local database's name*. A non-empty target without `--wipe`
→ refused, because the dump's `CREATE TABLE`s would fail partway and leave it neither state. `--wipe`
itself exposed a fifth defect: dropping alphabetically fails, since `DROP TABLE` runs an implicit
`DELETE FROM` and deleting from a *child* makes SQLite consult its **parent** — so dropping
`assessment_dimensions` first kills `question_dimensions`'s drop with `no such table:
main.assessment_dimensions`, an error naming a table you deliberately removed, raised by a
`DROP TABLE IF EXISTS` on a different one. Drops are dependency-ordered now.

**`restore-drill.mjs` makes the rehearsal re-runnable** rather than a paragraph asserting it happened
once — the `csp-check.mjs` lesson. It restores into a *throwaway* local database (not the dev one: a
drill that costs a developer their working data is a drill they run once), picks a student who had
recommendations **from the restored data rather than a constant**, boots the real Worker against it,
joins over HTTP through `/student-access/join`, and asserts the API returns the backup's careers in
the same order at the same scores. That last part is the claim: recommendations hang off
`assessment_results`, `careers`, `programs`, `program_catalog` and `colleges`, and a restore that lost
one link gives a perfect `recommendations` count and an empty screen.

**The remote leg was run, and it is the reason defect 1's second half exists.** The same dump was
pushed at a real D1 (`CareerLinkAI_Drill`, created for it and deleted after) — the path §5b takes and
the only one a genuine recovery uses. It **failed**, on an ordering defect the local restore had
passed cleanly minutes earlier. After the fix: 45 tables, 3,314 rows, verified on a live remote
database. A backup rehearsed only against Miniflare would have been filed as restorable.

**Not exercised:** `d1 time-travel restore`, which mutates a live database in place. Recorded in the
doc as unrun rather than implied to be covered.

* **Files:** `BACKUP-AND-RECOVERY.md`, `backend/scripts/d1-backup.mjs`, `d1-restore.mjs`,
  `restore-drill.mjs`, `scripts/lib/d1.mjs`, `scripts/lib/d1-dump.mjs` (all new),
  `backend/test/platform/backup-verification.test.ts` (new), `backend/package.json`, `.gitignore`,
  `DEPLOYMENT.md`, `PRODUCTION_REQUIREMENTS.md`
* **Verify:** ✅ **`npm run db:restore:drill` → PASS, 15 checks, 83 s end to end** against real
  staging data: `jose.pena.edited` served Journalist 97.0 / Marketing Manager 97.0 / Teacher 97.0,
  identical to the backup and in the same order, with AB Communication @ UP Diliman topping the
  programmes. ✅ **Remote restore into a live D1 → 45 tables, 3,314 rows verified**, scratch database
  deleted after. Backup 21 s; restore of a 998 KB dump 49 s. **23 new platform tests** drive the
  predicates red — the schema-perfect dump of an empty database, a dump one row short, a migration
  from the future, the drop order, the insert order — since proving those live would mean corrupting
  a real database. Full run: backend **838 passing** (64 files, was 815/63), frontend **150**,
  type-check · lint · `gate:platform` · `gate:bundle` (260 KiB) · `gate:assets` · build all clean.
* **Effort:** 2–3 h (as estimated).

### `[x]` **P3-6 — Class reassignment / guard counselor deletion** — *done 2026-07-30. 892 → 907 BE, 182 → 195 FE.*

**Both halves, not the item's "or".** The item offered a choice — block deletion, *or* add the
reassignment endpoint — and either alone is worse than useless. A guard with no remedy is a dead end
with better wording; a reassignment endpoint nobody is ever pointed at is F1's defect class again
(and P3-2a had just found a *third* live instance of that in the catalog module). The guard is what
makes the state unreachable, and the endpoint is what makes the guard escapable, so they shipped
together and the refusal message names the remedy.

**`PATCH /admin/classes/:id { counselor_id }` is on its own admin router, and that is the load-bearing
decision.** `PATCH /counselor/classes/:id` already exists and admins can call it, so adding
`counselor_id` there would have been two lines — but that route is mounted behind
`ensureRole('counselor', 'admin')`, so the field would be writable by **every counselor in the
school**, each of whom could hand a colleague's class to themselves and inherit a roster's results
with it. A separate router behind `ensureRole('admin')` makes that impossible by construction rather
than by remembering to check inside a handler. There is a test for it, and the test goes red the
moment `counselor_id` joins `updateClassSchema`.

**What "reassigned" has to mean, and what it would have been easy to ship instead.** The response
body is not the claim — `counselor_id` in a serializer is cosmetic. What is asserted is that the
*other* endpoints answer differently: the class enters the new counselor's list and leaves the old
one's, `GET /counselor/classes/:id` **404s for the previous owner** (not 403 — §19's "not yours" and
"not real" are the same answer, and a transfer must not turn that rule into an existence oracle), the
roster travels with it, and the admin's `/admin/counselors/:id/students` view — which resolves
students *through* classes — moves with it too.

**Three refusals, each closing the same defect from a different side.** A suspended counselor, a
soft-deleted one, and an **admin** are all rejected as targets. The last one is the least obvious and
the most important: an admin can already *see* every class, so it reads like a harmless choice — but
`counselor_id` is what the counselor list, the students view and every ownership check read, and an
admin sitting in that column is a class that belongs to nobody in the only sense the word is used
here. Handing a class to an account that cannot manage it is the exact defect this item exists to
fix, re-created by the fix.

**Same owner writes nothing.** Reassigning a class to the counselor who already owns it returns 200
and produces no audit row and no notification — the rule `update()` already follows for its status
transition. An audit row claiming a transfer that did not happen is worse than no row, because this
trail is the record of *who moved a class and when*.

**The guard blocks on the number already on screen.** `classes_count` on the admin list counts every
class with `deleted_at IS NULL`, and that is exactly what refuses the delete. An archived class
blocking removal is mildly annoying; a guard whose count disagrees with the number rendered beside
the counselor's name is a bug report. Cascading was considered and rejected — a class carries a
roster, attempts, results and recommendations, and removing an *account* is not a reason to shred the
records it produced (§12) — as was auto-archiving, which would end a term for forty students because
an administrator pressed a button about somebody's login.

* **Also:** `CLASS_REASSIGNED` is its own audit action recording **both** counselor ids, because
  "which counselor lost this class" is unanswerable from the new value alone; the new owner is
  notified (§44's direct-call form, as the assignment fan-out is) since a class appearing in a
  counselor's list with no explanation is how a transfer becomes a support ticket; the *previous*
  owner deliberately is not, because the usual reason for doing this is that they have left.
  `?counselor_id=` on the class list is **ignored for a counselor** rather than honoured — their
  scope is themselves, and the parameter exists for the one caller already entitled to the whole
  table.
* **The UI is the panel, and it fetches on open.** `CounselorClassesPanel` on the admin's counselor
  detail page: the target is picked **once** at the top and each class carries its own Reassign
  button, so one departing counselor and one replacement is one choice and nine presses rather than
  nine choices. A "reassign all" button is deliberately absent — it would be N requests behind one
  control, and a failure halfway through leaves a state nobody asked for with nothing on screen
  saying which half moved. Each press is one call and one audit row. The candidate picker is the
  P3-2 server-backed typeahead, fetched on open (a detail page should not spend a request on a
  picker nobody touched) and **saying when it truncates**. Every row's button carries an
  `aria-label` naming its class — two rows otherwise present two identically-named "Reassign"
  buttons, the same a11y defect P3-2a found on the canonical-programme rows.
* **Files:** `modules/classes/{routes,schemas,class-service}.ts`,
  `modules/identity/counselor-management-service.ts`, `modules/platform/audit-service.ts`,
  `src/app.ts`, `test/classes/reassignment.test.ts` (new),
  `frontend/src/features/admin/components/CounselorClassesPanel.tsx` (new) + its test,
  `features/admin/pages/{CounselorDetailPage,CounselorManagementPage}.tsx`,
  `features/admin/hooks/usePlatformAdmin.ts`, `services/classApi.ts`,
  `CounselorManagementPage.test.tsx`
* **Verify:** ✅ **15 backend + 13 frontend tests, guards fired red first.** Disabling the
  live-class guard → 2 tests red; making `counselor_id` writable on the counselor route → the
  refusal test red; removing the fetch-on-open, the self-exclusion and the row `aria-label` → 8
  frontend tests red. All restored and green. Full run: backend **907 passing** (69 files, was
  877/66), frontend **195** (23 files, was 182/22); type-check · lint · `gate:platform` ·
  `gate:bundle` (266 KiB) · `gate:assets` · build all clean, and the demo path re-walked in real
  Chrome (see P3-4's verify line — the same run covers all three items).
  ⚠️ **One thing the red run corrected, recorded rather than smoothed over:** widening
  `adminClassRoutes`' own `ensureRole` to admit counselors leaves the 403 test **green**, because
  every router mounted on `/admin` declares the same gate and Hono runs all of their chains, so the
  first one refuses. That is defence in depth, not redundancy to delete — but it means the 403 is a
  claim about the *prefix*, and the test now says so. The assertion that pins this item's own
  decision is the second half of it.
* **Effort:** 4–6 h (as estimated).

### `[x]` **P3-7 — DLQ alerting** — *done 2026-07-30. 892 BE includes its 7.*

**The queue consumer, not the `scheduled` sweep the item also offered.** The consumer wins on every
axis: it fires the moment the message dies rather than up to 24 hours later, it already holds the
batch (so the count and the job types are in hand with no state to persist and re-read), and it costs
nothing at all on the overwhelming majority of days when nothing dead-letters. A cron sweep would
have had to invent somewhere to *record* DLQ activity in order to notice it later — a table whose
only reader is the thing that writes it.

**The alert has to arrive where an administrator already looks.** H1 made a dead-lettered job
recorded — logged, marked FAILED where it can be, acked rather than dropped. It did not make it
*noticed*: `console.error` reaches Workers Logs, which is somewhere you look once you already suspect
something, and the defining property of a failing background queue is that it produces no symptom to
suspect. So it is a §44 notification to every active administrator, which is in the shell of every
signed-in page. Counselors and students are not told; a dead queue is an operator's problem.

**One alert per queue per 15 minutes, and the alert says so.** A broken pipeline does not
dead-letter one message, it dead-letters every message, ten at a time — so the un-throttled version
of this feature is a hundred identical rows in the bell, which is an alert nobody reads and therefore
worse than none, because it also hides the ones that matter. The throttle is `AuthGuardDO.charge()`
again, keyed on the **queue** rather than on a recipient (two administrators must not each receive a
full storm just because there are two of them, and the AI queue going quiet is a different fact from
the default queue going quiet). And the suppression is stated in the message body — *"further alerts
for this queue are muted for 15 minutes, so this may not be all of them"* — because "3 jobs failed"
when 300 did is a worse lie than silence.

**Both channels, deliberately different.** The notification is throttled and per batch; the log line
gained a stable `alert: "dead_letter_queue"` field and is written for **every** message, unthrottled,
so a Workers Logs alert can filter on it and reach someone who is not signed in. Documented as an
operational step in **DEPLOYMENT.md §8.2**, along with the note that neither channel can say *why* a
job failed — that is the `Queue job failed.` line from the source consumer, three attempts earlier,
which carries the error and the correlation id.

* **Files:** `src/jobs/dlq-alert.ts` (new), `src/index.ts`, `lib/auth-guard.ts`,
  `test/platform/dlq-alert.test.ts` (new), `DEPLOYMENT.md`
* **Verify:** ✅ **7 tests driving the real `queue()` entry point with real DLQ batches**, the same
  way `test/ai/queue-consumer.test.ts` drives the source-queue path. Unwiring the alert call → **6 of
  7 red**; disabling the throttle → the two throttle tests red. Both restored and green.
  ✅ **Alerting cannot cost the batch** — proven by breaking it for real rather than by reading the
  `try`/`catch`: `queue()` takes its `env` as a parameter, so the binding the alert reaches for first
  is replaced with one that throws while `DB` stays real. Every message is still acked, no alert is
  half-sent, and the *next* batch on that queue still reaches an administrator. A message already in
  a dead-letter queue has nowhere further to fall; "this job died and the consumer recording it died
  too" is the one outcome this must never produce.
* **Effort:** 2 h (as estimated).

### `[x]` **P3-8 — Catalog name uniqueness (P4-12), the nightly backup, and a live hazard in `walkthrough.mjs`** — *done 2026-07-31. 907 → 915 BE.*

Three items pulled together because production went live on 2026-07-30 and each of them is
**cheaper now than later** — the first two on the plan's own reasoning, the third because it was
found while doing them.

**P4-12 — the duplicate class is now unreachable, not merely unlikely.** `careers.title` and
`colleges.name` carried plain indexes, so nothing in the database prevented two rows spelling the
same thing. This defect has shipped three times (P1-0's seed chain, and twice in P2-2) and was
remediated by hand every time. Migration 0020 adds case-insensitive UNIQUE indexes.

**The obvious predicate does not apply, and the real databases are what say so.** The natural
choice is `WHERE deleted_at IS NULL`, because that is exactly what the two `assert…Free` pre-checks
scope to. Checked before the file was written: staging still holds both pairs P2-2 archived —

| title | status | deleted_at |
|---|---|---|
| Data Scientist | active | NULL |
| Data Scientist | archived | NULL |
| Teacher | active | NULL |
| TEACHER | archived | NULL |

P2-2 **archived** those rows; it did not soft-delete them, so a `deleted_at`-only index collides on
two pairs the moment it is created. The predicate is `status = 'active' AND deleted_at IS NULL`,
which is also the correct boundary rather than merely the one that applies:
`scorableCareersForMany` — the query feeding the ranking — filters on exactly that, so it is
precisely the set in which a duplicate reaches a student. It also keeps archiving usable as the
remedy, which is what P2-2 actually did.

**The one reachable path to the index, found by reading rather than guessing.** `updateCareer` runs
its pre-check only `if (input.title !== undefined)`, so `PATCH { status: 'active' }` on the archived
half of a seed-created pair **skips the pre-check entirely** and goes straight to the constraint.
That is not a hypothetical race — it is pressing "Restore" in the UI. Before 0020 it silently
restored the duplicate; without the H4 translation beside it, it would now be a raw 500. All four
catalog write paths carry `translateUniqueViolation`.

**Both guards fired red before they were trusted** (P1-3's rule), and they are two guards, so they
were fired separately: migration removed → the 3 database-level assertions and the reactivation test
go red (4 of 8); migration restored and the `.catch()` removed → the reactivation test alone goes
red with `expected 500 to be 422`. The `TRIM` in the index is recorded honestly as belt-and-braces:
`z.string().trim()` means the API can never submit a whitespace variant, so it guards the paths that
skip the schema — seeds, migrations and direct SQL, which is where all three historical duplicates
actually came from.

**The nightly backup exists now.** P3-5 shipped `d1-backup.mjs` and both it and
PRODUCTION_REQUIREMENTS said to put the daily job on a schedule "the same day" production went live.
Until this, the only backup in existence was the one taken by hand during the cutover and the RPO
was "everything since the last time someone remembered". `.github/workflows/backup.yml` runs it at
17:37 UTC (01:37 Manila, offset from the Worker's own 03:00 cron), and stores the dump as a
**GitHub** artifact for 90 days — deliberately not R2, because a backup of a Cloudflare database
held in a Cloudflare bucket shares a blast radius with the thing it insures, and 90 days is
deliberately longer than Time Travel's 30, since inside that window Time Travel is the better tool.

**It retries three times, and that is evidence-based rather than defensive.** While building it the
identical export command failed once, hung once, then succeeded twice against an unchanged database
— `wrangler d1 export` is an asynchronous create-poll-download job and a transient failure says
nothing about the data. A nightly job that pages on that is one whose red ticks get ignored. A
genuine verification failure still fails all three attempts and still goes red.

**`walkthrough.mjs` could have published the production admin password.** Found while checking
whether it could drive step 10: it rotates *both* staff accounts to `Walkthrough@Admin1` and
`Walkthrough@Counselor1` — constants committed in this repository — and it takes the target as a
`--app` URL with no guard whatsoever. Pointed at production it would have set the live
administrator's credential to a published string and reported 95 green checks doing it. Same class
as the `db:seed:catalog:staging` hazard P1-3 found, and `d1-restore.mjs` has guarded against its own
version of this since P3-5. It now refuses, identifying production from `[[env.production.routes]]`
and `FRONTEND_URL` in wrangler.toml rather than by matching the word "production" — this project's
production Worker answers `careerlinkai.online` and its database is called `CareerLinkAI_Main`, so a
substring check catches neither. **There is deliberately no override flag**: restoring production is
a real if last-resort operation, so `d1-restore.mjs` offers one; rotating production credentials to
a committed constant is never the intended action.

* **Files:** `backend/migrations/0020_catalog_name_uniqueness.sql` (new),
  `modules/catalog/academic-catalog-service.ts`, `backend/test/catalog/name-uniqueness.test.ts`
  (new), `backend/scripts/lib/d1.mjs`, `scripts/walkthrough.mjs`,
  `.github/workflows/backup.yml` (new)
* **Verify:** ✅ 8 new backend tests, **fired red in two separate passes** as above. Migration
  applied to local and to **staging — the database with the archived duplicates**, which is the
  assertion that matters, since it is the one a `deleted_at`-only predicate cannot survive.
  ✅ The guard proved on 7 URLs: apex, `www`, an upper-case host and an explicit-port form all
  refuse; staging, `localhost:8787` and `localhost:5173` all pass through (verified on the refusal
  *message*, not the exit code — staging exits 1 anyway for the documented reason that it needs a
  fresh bootstrap, which is exactly the false pass a lazier check would have recorded).
  ✅ Backup run end to end against production: **595.6 KB, 45 tables, 2,180 rows**, verified table by
  table, PASS.
  ⚠️ **Migration 0020 is applied to local and staging but NOT yet to production** — the production
  apply is a live-database write and is left to be run deliberately. Until it runs, production is
  protected by the pre-checks only, exactly as it was before this item.

### `[x]` **P3-9 — CI had never once passed** — *done 2026-07-31. Green on the 12th run, after eleven red.*

**Eleven CI runs since the first on 2026-07-15. Eleven failures.** The backend job was green in all
of them; the frontend `Test` step was red in all of them. This document records "195 frontend,
type-check · lint · gates · build clean" at nearly every phase from P1-3 to P3-8, and **every one of
those numbers came from a local run.** The suite genuinely is green locally. It had simply never been
green in the place that was supposed to prove it, across sixteen days and six phases.

That is this plan's own opening rule turned on the plan: *the code existing is not the thing
working*, and a gate nobody has seen pass is not known to be a gate. P1-3 fired all six of its
thresholds red before trusting them. Nobody applied that to the workflow that runs them.

**What was failing: the two PDF cases in `extractText.test.ts` hung** — and the timeout had already
been raised once without helping. They timed out at Vitest's default 5,000 ms on 2026-07-29; P3-3
raised `testTimeout` to 15,000 ms for unrelated reasons; they then timed out at 15,000 ms. Tripling
the budget changed nothing, which is what separates a hang from a slow machine, and also rules out
the two-core starvation `vite.config.ts` documents for other tests — that costs the *first* test,
not both identically.

**The cause was structural, and it meant the test had never tested the right thing anyway.**
`pdfjs-dist` disables the real `Worker` whenever `isNodeJS` is true (a static block in
`build/pdf.mjs`), and under Vitest it always is. So the jsdom run never exercised pdf.js's worker
path at all — it took the *fake worker* fallback, which does a raw `@vite-ignore` `import()` of a
`file://` URL at the 1.25 MB `pdf.worker.min.mjs`, outside Vitest's module pipeline. pdf.js printed
the diagnosis into every red log for sixteen days: *"Please use the `legacy` build in Node.js
environments."*

**The exact failure inside CI's Linux/Node 22 was never reproduced, and is not claimed here.** It
does not reproduce locally. The fix deletes the code path rather than theorising about it:
`extractText.test.ts` now runs in **real Chrome** as its own Vitest project, where `Worker` exists
and pdf.js runs what the app ships. The other 22 files stay in jsdom.

**Four patches existed only to fake a browser for a browser library, and all four are gone** — the
`vi.mock` re-pointing the worker `?url` at a filesystem path, a hand-written `DOMMatrix`, the
`Uint8Array.toHex`/`fromHex` polyfills, and the `mammoth` browser-build alias. Nothing else in `src/`
referenced any of them. `setupTests.ts` had already written the exit in its own comment: *"If a test
ever needs real geometry, that test needs a real browser."*

* **Files:** `frontend/vite.config.ts`, `frontend/src/setupTests.ts`,
  `frontend/src/features/admin/utils/extractText.test.ts`, `frontend/package.json`,
  `.github/workflows/ci.yml`, `.gitignore`
* **Verify:** ✅ **CI green — run `30641319855`, the first success in the repository's history.**
  Frontend **23 files / 195 tests**, matching local exactly (the count is the assertion: a
  misconfigured project that silently runs 188 also reports success). `browser (chromium)
  extractText.test.ts (7 tests) 5002ms` in the CI log proves the browser project really ran rather
  than being skipped. Backend 70 files.
  ✅ **Proven to still bite** (P1-3's rule): `extractPdf` stubbed to return a constant → exactly the
  two PDF tests fail, in **196 ms and 130 ms with real assertion messages** rather than by timing
  out. Reverted, green again.
* **The gate is now enforced — and the way it was enabled created a live credential exposure.**
  Branch protection and rulesets are both refused on private repositories on GitHub Free (`PUT
  /branches/main/protection` and `GET /rulesets` each returned *"Upgrade to GitHub Pro or make this
  repository public"*, HTTP 403). **The repository was made public on 2026-07-31 to unblock it**,
  and protection is now applied: both CI jobs required, `strict: false`, `enforce_admins: false`
  (the sole admin can still push deliberately), force-pushes and deletions blocked.

  **Public means the whole history, not just `HEAD`, and one thing in it is a working credential.**
  Scanned: no token, key or `.dev.vars` was ever committed, and `frontend/.env.staging` (deleted
  from `HEAD`, still in history) holds only a public URL. But two things are genuinely exposed:

  * **`scripts/walkthrough.mjs:85-86` publishes staging's staff passwords.** They are not test
    fixtures — the script *rotates the real staff accounts onto them* for whatever `--app` names,
    and it has been run against staging by P2-2, P2-3 and P3-3. So `admin@careerlinkai.online` on
    `https://careerlinkai-staging.cejascarldindo.workers.dev` (**confirmed live, HTTP 200**) very
    likely has a password anyone on the internet can now read. **Rotate them.** The file's own
    comment already said these were "published in the source tree" — that sentence meant something
    survivable while the repository was private and means something else now.
  * **`backend/seeds/0001_staff_accounts.sql` ships real PBKDF2 hashes**, which its header already
    calls public and accepts *"because the first login forces a rotation"*. That reasoning no longer
    holds where `walkthrough.mjs` has run, because rotating to a known constant clears
    `must_change_password`.

  **Production appears unaffected and this is reasoning, not a test** — a login attempt against it
  would risk the P3-4 lockout. P3-1 step 4 bootstrapped production's staff via
  `bootstrap-staff.mjs` with a temp password captured at the console, never from the seed, and P3-8
  added the guard that stops `walkthrough.mjs` pointing at production at all. Worth confirming
  deliberately rather than assuming.
* **Left open:** the earliest run (2026-07-15) failed differently — seven test files failing to load
  — so more may surface now that the job can go green. That is what a gate is for.

---

## Phase 4 — After launch

| ID | Item | Finding | Effort |
|---|---|---|---|
| `[ ]` P4-1 | Admin **Student Management** page — global list, search, suspend, transfer | Missing (High) | 1–2 d |
| `[ ]` P4-2 | **Email delivery** — unblocks self-service password reset (retires the P0-2 workaround) and notification reach | D7 (Medium) | 2–3 d |
| `[ ]` P4-3 | Automate `walkthrough.mjs` in CI against a preview deploy | Testing gap (High) | 1 d |
| `[ ]` P4-4 | Scheduled recommendation refresh as the catalog grows (cron over the P0-3 service) | C4 follow-on | 4–6 h |
| `[ ]` P4-5 | Split `assessment-builder-service.ts` (1,644 L) and `assessment-attempt-service.ts` (1,446 L) | Code quality | 1–2 d |
| `[ ]` P4-6 | Results / recommendations **export** — likely wanted for thesis data collection | Missing (Medium) | 4–6 h |
| `[ ]` P4-7 | Admin **Settings** page | Missing (Medium) | 1 d |
| `[ ]` P4-8 | Rename `seed-instruments`' camelCase response to snake_case (API consistency) | Code quality | 1 h |
| `[ ]` P4-9 | Move `ForgotPasswordPage`/`ResetPasswordPage` off direct `httpClient` into `authApi` (§36) | Code quality | 1 h |
| `[ ]` P4-10 | Admin **Recommendations** overview for QA/reporting | Missing (Medium) | 1 d |
| `[ ]` P4-11 | **Self-host Barlow** (fontsource) and drop the two Google Font hosts from the CSP | P1-2 follow-up | 2 h |
| `[x]` P4-12 | **Case-insensitive unique indexes** on `careers.title` / `colleges.name`, so P1-0's duplicate class cannot recur in data | P1-0 / P2-2 follow-up | ✅ done 2026-07-31 — see P3-8 |
| `[ ]` P4-13 | Audit the remaining ~59 `inArray` call sites for unbounded lists (the ones fixed were the catalog-scale three; most others are bounded by construction) | P2-2 follow-up | 3–4 h |
| `[ ]` P4-14 | Reformat the 78 backend files that drifted while `.prettierrc.json` was unparseable, then put `format:check` in CI so it cannot drift again | P1-3 follow-up | 1 h |
| `[ ]` P4-15 | **Drop Framer Motion from `FadeIn`** (CSS keyframes). It is `proxy-*.js` = **118 KiB** for a fade, and it sits on `/join` — the student's *first* screen — via `StudentAccessLayout`. Three consumers total. Takes `/join` 612 → 494 KiB and the student journey 717 → 599 KiB | P3-3 follow-up | 2–3 h |
| `[ ]` P4-16 | **Zod off the join screen** — `schemas-*.js` = **86.6 KiB** to validate a two-field form (`class_code`, `username`). Zod stays everywhere it earns its place; `/join` is the one screen where the ratio is absurd | P3-3 follow-up | 2 h |
| `[ ]` P4-17 | **Make "Try again" recover a failed chunk load.** `React.lazy` caches its rejection, so the button cannot re-import; `ErrorBoundary` would have to re-key the route group. "Go home" works today, so this is a wrong-looking button rather than a dead end | P3-3 follow-up | 2–3 h |
| `[ ]` P4-18 | Re-run `walkthrough.mjs` as part of finishing *any* UI item, not only when something looks wrong — it went stale against P3-2 and said so only when P3-3 happened to run it. P4-3 (CI against a preview deploy) is the real fix | P3-3 finding | — |

---

## Recommended order

```
        P1-2  verify CSP in a browser              ✅ done — found + fixed the blocked webfonts
        P2-1  counselor recommendations panel      ✅ done — closes F2 + P1-1
        P2-2  rehearse full demo on staging        ✅ done — found + fixed D1 param limit; C1 proven 0/10
        P2-3  accessibility on the demo path       ✅ done — player is a real radio group; 31 a11y checks in Chrome
        ────────────────────────────────────────────────── defense-ready
        P1-4  tests for Phase 0 UI                 ✅ done — 23 tests, 127 → 150; no product defects
        P1-3  regression guards                    ✅ done — asset budgets + seed chain; both proven red first
        P3-5  backup & restore                     ✅ done — a stock D1 dump is restorable only by D1; fixed
        P3-2  catalog search                       ✅ done — the Colleges page was already showing 20 of 20
        P3-3  code splitting                       ✅ done — 972 → 507 KiB; the 350 kB target is below the framework floor
        P3-4  rate limiting                        ✅ done — found /admin/dashboard authenticating 6× per request
        P3-6  class reassignment                   ✅ done — a class could never be handed to a replacement
        P3-7  DLQ alerting                         ✅ done — one alert per queue per 15 min, and it says so
        ────────────────────────────────────────────────── hardened
        P3-1  production cutover, steps 1–8       ✅ done — the domain pointed at a different script
        P3-1  production cutover, steps 9–10      ✅ done — C1 proven on production, 0/10
        ────────────────────────────────────────────────── launched 2026-07-30
        P3-8  uniqueness + nightly backup + guard ✅ done — the obvious index predicate does not apply
        P3-9  CI had never once passed          ✅ done — 11 of 11 red since 2026-07-15; green on the 12th
NOW ──► verify the nightly backup actually runs   (~10 m)   ← needs a token Cloudflare accepts for D1
        Phase 4  (+ two dashboard-side steps: DEPLOYMENT.md §8.1 WAF rule, §8.2 Workers Logs alert)
```

**The one open thread is that the backup schedule has never been observed to run.** The workflow is on
`main`, the script is proven against production by hand, and the credentials were the only unverified
link — which is exactly the shape of gap this document keeps finding, and both halves of it turned
out to be broken. A wrong `CLOUDFLARE_ACCOUNT_ID` failed at Cloudflare's router (`code: 7003`, never
reaching a permission check) and masked a rejected token behind it (`code: 10000`). The account id is
fixed; the token is not, and until it is the schedule has still never produced a backup.

**And this document was wrong about something larger.** Every phase above records "all green" — 907
backend, 195 frontend, type-check · lint · gates · build clean — and **every one of those was a local
run.** CI itself had never passed: eleven runs from 2026-07-15 to 2026-07-31, eleven failures, the
backend job green throughout and the frontend job red throughout. Nobody opened it. P1-3 established
that a threshold which has never been seen red is not a gate, and fired all six before trusting them;
the same reasoning applied to the workflow *running* those gates would have caught this on day one.
Closed as **P3-9** below. The lesson is not "check CI" — it is that this plan's rule about verifying
gates was applied to everything except the thing doing the verifying.

**The three items that used to sit *after* P3-1 were brought forward on purpose**, and two of them
turned out to be about states a live deployment cannot get back out of. P3-6's was permanent by
construction — `counselor_id` was writable by nothing, so the first counselor to leave took their
classes' ownership with them for good. P3-7's was permanent by silence. Doing either after launch
means doing it to real data. P4-12 was pulled forward from Phase 4 for the same reason and the
reasoning held: production was measurably clean when the constraint went on, and staging — which was
not — is what proved the predicate.

**And P3-1 itself paid the plan's opening lesson back a fourth time.** Steps 1–7 all reported success
while the live domain served code from April, because `--env production` publishes
`careerlinkai-production` and `careerlinkai.online` was attached to `careerlinkai`. Three documents
asserted otherwise and every one of them was wrong; no test, gate, type-check or green suite could
have said so, because the claim was about a name in a dashboard. **Step 8 is a `curl` against the real
domain, and it is the entire reason this was found before a student was ever pointed at the URL.**

**Minimum before the defense: all three done.** They earned their place at the top of this list. P1-2
found a CSP that stripped the app's typeface on every screen, in production and nowhere else. P2-2
found that recommendations — the product's central feature — were being generated for **nobody** on
the deployed Worker, and that the audit's own catalog fix (P0-1) was the cause. Neither was visible
from reading the code, from the 807 green tests, or from any local run.

The lesson both share is the one the plan opened with: *the code existing is not the thing working.*
Three of the four defects found across P1-2 and P2-2 were invisible everywhere except a deployed
system — and the fourth, the stale walkthrough, was the tool that was supposed to notice.

---

## Progress log

| Date | Items closed | Tests | Notes |
|---|---|---|---|
| 2026-07-28 | P0-1 … P0-8 | 807 BE / 104 FE | Audit + remediation. P0-7 partial pending P1-2. |
| 2026-07-28 | P1-0 | — | Seed duplication found and fixed during plan review; verified 0 duplicates. |
| 2026-07-28 | P2-1, P1-1 | 807 BE / **112** FE | Counselor recommendations panel. Both orphaned hooks now have a consumer; staff list presentation shared with the admin page rather than copied. |
| 2026-07-28 | P1-2, P0-7 | — | CSP run in real Chrome across 15 screens (`scripts/csp-check.mjs`). **Webfonts were blocked on every page in production** — found, fixed, re-verified. Zod's `eval` probe accepted with reasons rather than papered over with `'unsafe-eval'`. |
| 2026-07-29 | P2-3 | 811 BE / **127** FE | Accessibility on the demo path. **The player's options were five toggle buttons, not a radio group** — 300 tab stops across RIASEC instead of 60, "pressed" instead of "selected, 3 of 5", and a question that changed in silence. Neither sign-in screen had an `h1` on a phone; no validation message was attached to its field; there was no skip link. Audited in real Chrome from inside `walkthrough.mjs` — **31 `[a11y]` checks, all green.** |
| 2026-07-29 | P1-4 | 811 BE / **150** FE | Tests for the four Phase 0 controls — 23 of them, against an estimated ~12. No product defect found: all four behaved as written. **One defect found in the test suite itself** — `RecommendationPage.test.tsx` reset its mock's return value but not its call counts, so a "fetched exactly once" assertion measured the whole file (`expected 1, got 14`) rather than its own test. That is the assertion shape P2-1's lazy-fetch guarantee rests on. Fixed in the shared setup. |
| 2026-07-29 | P1-3 | **815** BE / 150 FE | Regression guards. `--assets` weighs what the *browser* downloads — the number `gate:bundle` structurally cannot see, and the reason a 3.26 MB logo sat on the critical path of every screen unremarked. Every threshold was **fired before it was trusted**: the real master re-imported (2 gates red), a fat chunk planted, `index.html` removed, P1-0 re-injected. **A live hazard found**: `db:seed:catalog:staging` pointed seed 0002 at a deployed database — the exact defect P2-2 had to clean off staging by hand. Deleted and guarded. The chunk budget is a ratchet, not the specified 600 KiB, because P3-3 owns the 921 KiB chunk. |
| 2026-07-29 | P3-5 | **838** BE / 150 FE | Backup and disaster recovery — the one item on the list whose failure mode is permanent. The specified command turned out not to be a backup: **`wrangler d1 export` exits 0 on an empty database**, so a mistargeted `--env` writes a perfect dump of nothing every night until the restore. Backups are now verified against the live database's own `COUNT(*)`, table by table. **Four D1 platform facts found by running it**, all invisible to 838 green tests — headline: **a stock export dump cannot be restored by `wrangler d1 execute --file` at all**, on two independent ordering defects, and **the second one fails only on the remote importer** — it passed the local restore cleanly and was caught only because the remote leg was actually run. A fifth defect surfaced in the wipe path: dropping tables alphabetically fails, because deleting from a child makes SQLite consult its parent. **`restore-drill.mjs` proves the claim end to end** — staging's real data restored, the real Worker booted against it, a student joined over HTTP and served the backup's ten careers in the same order. 15 checks, 83 s, plus a verified restore into a live remote D1. |
| 2026-07-29 | P3-2a | **867** BE / **171** FE | The two defects P3-2 exposed, fixed rather than filed as P4 items. **`/admin/canonical-programs/options` had no caller at all** — not the program form its own comment named, not anything else; the endpoint and its hook were both orphans reachable only by `curl`. That is **F1 and F2 together**, the defect class this plan opens by naming, sitting unnoticed in the catalog module. It was also unbounded, under a comment reading "Two dozen rows at thesis scale", while migration 0018 mints a new entry for every unseen programme code an admin types. Separately, **the merge target picker was reading the current page rather than the catalog** — so past one page an entry could not be merged into a target on another, and P3-2's own search made that worse before better: find the target, press Merge, and it is still not among the candidates. One fix for both, since the orphaned endpoint is precisely what the picker needed. An a11y defect fell out of testing it: nine rows presented nine identically-named "Merge" buttons to a screen reader, with nothing to say which entry was about to be retired. |
| 2026-07-29 | P3-2 | **863** BE / **165** FE | Catalog search, filter, sort and paging (F3 + F4). The item was written about the careers picker; **the Colleges page turned out to be the one already over the edge** — no pager, no search, and a request that sent no `per_page`, so it took the API's default of 20 against a catalog of exactly 20 seeded colleges. It was showing 20 of 20 and looking complete. Adding `sort=created_at` also required making paging *total* first: seed 0004 inserts its 68 careers in one statement and SQLite evaluates `'now'` once per statement, so **every seeded career shares one `created_at` to the millisecond** — an `ORDER BY` over an all-ties column is unspecified per execution, which permits a row on two pages and another on none. Every list now ends its order on the id. Search terms are escaped, so `100%` stops meaning "starts with 100". The picker fetches on open rather than on mount and **says when it is truncating** — the silence was what made F3 invisible. Three private copies of `useDebouncedValue` became one; `SearchInput` and `Pagination` were extracted from `AddressTable` and it now consumes them. Every guard fired red before it was trusted. |
| 2026-07-29 | P3-3 | **877** BE / **182** FE | Code splitting (audit P2). The item asked for < 350 kB on the student path and the honest answer is **507 KiB**, because **41% of the 936 kB chunk was framework, not pages** — React, React DOM, React Router, TanStack Query and axios are reached by `main.tsx` and `ProtectedRoute` before the app can know which shell to fetch, and that closure is **399 KiB** on its own. 350 kB is below the floor; the two dependency-level ways under it are measured and filed as P4-15/P4-16 rather than guessed at. What the split did buy: **972 → 507 KiB raw, 279 → 159 KiB gzipped**, and a student no longer downloads 262 KiB of admin, counselor and builder pages. Seven groups rather than five — the builder is routed by *both* staff shells and `/join` is not a staff door. **The gate matters more than the split**: one static import of a group barrel folds it back into the entry with a green build, a green type-check and 182 green tests, so `--assets` now reads Vite's manifest and weighs each route's closure. Proven by breaking it — `admin-*.js` ceased to exist, the entry went 209 → 468 kB, **4 gates red, exit 1**. **Two defects found:** `walkthrough.mjs` had been stale since P3-2 (still driving the `<select>` the catalog-search item replaced with a typeahead) and said so only because P3-3 ran it; and **`React.lazy` caches its own rejection**, so `ErrorBoundary`'s "Try again" cannot recover a failed chunk — "Go home" can, because it is a full document navigation. Re-walked in real Chrome: **95/98**, the 3 failures being the same known RAG legs; **csp-check PASS on 15 screens**, with Zod's accepted `eval` probe now firing on 12 of them instead of 15. |
| 2026-07-30 | P3-1 steps 1–8 | — | **Production cutover — and step 8 found that `careerlinkai.online` was serving a different Worker than the one being deployed.** Wrangler derives an environment’s script name as `<name>-<env>`, so `npm run deploy:production` publishes `careerlinkai-production`; the domains were attached to the bare `careerlinkai` script from the era before environments existed. `DEPLOYMENT.md` (twice), `PRODUCTION_REQUIREMENTS.md` §6 and `wrangler.toml`’s own comment all recorded the two as one script, and **nothing caught it because `--env production` had never been run** — staging is `careerlinkai-staging`, which was the evidence sitting in plain sight. The first cutover therefore published a third Worker that was healthy, correct and reachable by nobody, while the live domain went on serving April’s build. **The obvious fix was refused by Cloudflare**, which is the better finding: pinning `name = "careerlinkai"` resolves fine but the deploy is rejected because the legacy script holds live `NotificationDO` Durable Objects — a class in no committed config and absent from the codebase, so its migration-tag state is not derivable from this repo and the only route through destroys DO data nobody can inspect first. The domains were moved instead, and are now **declared in `wrangler.toml`** rather than living only in a dashboard, which is how the original fact drifted from three documents without going red. Also learned: a queue takes exactly one consumer, and the conflict surfaces at *delete* time (`code: 10064`), not at deploy. Verified live: health `environment=production` on apex and `www`, the served `index.html` matching the local build hash for hash, five route chunks `immutable`, all four security headers, **19 migrations, 20/68/48/309/933 catalog rows, 0 duplicates, 0 NULL canonicals**, and `POST /auth/login` returning **200 with `must_change_password: true` in 3.0 s** — 600,000 PBKDF2 iterations inside AuthGuardDO’s 30 s budget on a Free-plan Worker, which is deviation D14 proven in production. First backup taken before the first deploy: 432.4 KB, 45 tables, 1,516 rows, verified table by table. Steps 9–10 (rotation, Install RIASEC & SCCT, two-profile smoke) still need a browser, so the item stays `[~]`. |
| 2026-07-30 | P3-4, P3-6, P3-7 | **907** BE / **195** FE | The last three Phase 3 items, and **the first of them found a defect none of the other 877 tests could see**. P3-4's per-user counter charges once per execution of `authenticate()`, which made it the only instrument in the system that can count them — and it counted **six** on `/admin/dashboard`, five on `/admin/counselors`, four on `/counselor/dashboard`. §10 gives every module its own routes file and six of them mount on `/admin`; Hono merges each sub-app's `use('*')` into the parent, so a path whose handler sits in the last-registered router runs the full middleware chain of every router in front of it. **Twelve D1 reads to answer "who is this"** on the admin's landing screen, against a 50-subrequest ceiling, with every response correct throughout. One early return fixed it. The limiter itself is charged inside `authenticate()` rather than as a global middleware (Hono's global `use` runs before the sub-router, so it cannot see the user) and its limit is a var — the only one of six that is, because a test file compresses a day of one user's requests into three seconds. `Retry-After` now lands on every 429 in the system from `app.onError`, so the five pre-existing limiters gained it for free; the WAF half S2 also wants is written up in DEPLOYMENT.md §8.1 rather than claimed here, because dashboard configuration cannot have tests. **P3-6 did both halves of its "or", since either alone is worse than useless**: `counselor_id` was writable by nothing, so a departing counselor's classes were stuck pointing at a removed account *permanently* — an admin could see them and no replacement could ever be given them. The endpoint lives on its own `/admin` router rather than as a field on the counselor's PATCH, because that route admits counselors and the field would have let any of them hand a colleague's class to themselves. Deletion is now refused on exactly the `classes_count` already rendered beside the name, and the refusal links to the screen that fixes it. **P3-7 alerts once per queue per 15 minutes and says that it is doing so** — a broken pipeline dead-letters every message, ten at a time, and "3 jobs failed" when 300 did is a worse lie than silence. Proven un-breakable-by-alerting the honest way: `queue()` takes its env as a parameter, so the binding the alert reaches for first was replaced with one that throws, and every message was still acked. |
| 2026-07-28 | P2-2 | **811** BE / 112 FE | Staging rehearsal. **`generateFor` 500'd on D1's 100-parameter limit — every student got zero recommendations, caused by P0-1's own catalog expansion.** Fixed via `chunkIds`; 4 regression tests. `walkthrough.mjs` un-rotted (4 stale selectors + a removed auto-advance). Two duplicate careers archived. C1 proven live: **0/10 overlap** between opposite profiles. |
| 2026-07-31 | P3-9 | **915** BE / **195** FE | **CI had never once passed — eleven runs, eleven failures, from the first on 2026-07-15 to this one.** The backend job was green throughout and the frontend job red throughout, and this document's "all green" line at nearly every phase from P1-3 to P3-8 was a *local* run every time. The suite really is green locally; it had simply never been green in the place that was supposed to prove it, for sixteen days across six phases. **The two PDF cases in `extractText.test.ts` hung, and raising the timeout had already failed to fix it once** — 5,000 ms on 2026-07-29, then 15,000 ms after P3-3 raised it, timing out identically at both, which is what separates a hang from a slow runner. The cause also meant the test had never tested the shipped path: **`pdfjs-dist` disables the real `Worker` whenever `isNodeJS` is true**, so under Vitest it always took the *fake worker* fallback — a raw `@vite-ignore` `import()` of a `file://` URL at the 1.25 MB worker, outside Vitest's module pipeline. pdf.js printed the diagnosis into every red log for sixteen days: "Please use the `legacy` build in Node.js environments." The exact Linux/Node 22 failure was never reproduced and is not claimed; the fix **deletes the path** instead — that one file now runs in **real Chrome**, where `Worker` exists. Four patches that existed only to fake a browser for a browser library went with it: the worker `vi.mock`, a hand-written `DOMMatrix`, the `Uint8Array.toHex`/`fromHex` polyfills, and the `mammoth` alias. `setupTests.ts` had already named the exit in its own comment. Proven red first (P1-3's rule): `extractPdf` stubbed to a constant → exactly those two tests fail, in 196 ms and 130 ms with real assertion messages rather than by timing out. **Green on run `30641319855` — 23 files, 195 tests, matching local exactly.** |
