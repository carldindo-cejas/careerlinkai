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

### `[!]` **P3-1 — Production cutover** *(audit C3 — blocked on you)*

Needs live Cloudflare credentials and is irreversible; deliberately not automated. Runbook is in
`PRODUCTION_REQUIREMENTS.md` and is now correct (19 migrations, seed 0004, install step, rollback).

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

### `[ ]` **P3-2 — Catalog search** *(audit F3 + F4)*

* **Why:** `listCatalogQuerySchema` has only `page`/`per_page` (max 100) — no search, filter or sort.
  Colleges, Careers, Canonical Programs and Knowledge pages have no search box. **F3 is now live
  rather than latent:** the career picker requests `per_page: 100` to get "the whole catalog", and
  P0-1 raised the catalog to **68 careers** — one more expansion crosses the cap and mappings begin
  failing silently. Missing mappings degrade `programRiasecCompatibility` invisibly.
* **Do:** add `search` (and `sort`) to `listCatalogQuerySchema` + service, mirroring the working
  implementation at `counselor-management-service.ts:131`; add search inputs; convert the career
  mapping picker to a server-backed typeahead.
* **Verify:** seed 150+ careers → picker finds #150 by typing.
* **Effort:** 4–6 h. **Raise to High priority the moment the catalog is edited in anger.**

### `[ ]` **P3-3 — Code splitting** *(audit P2)*

* **Why:** one 936 kB chunk (274 kB gzipped) holds every admin, counselor and student page. A
  student downloads the assessment builder and the pdf.js integration they will never open.
* **Do:** `React.lazy` per route group (public / auth / admin / counselor / student) with `Suspense`
  using the existing spinner. Expect 60–70% off the student path.
* **Verify:** build output shows per-group chunks; student path chunk < 350 kB.
* **Effort:** 3–4 h. Real regression risk — do it with P1-4's tests in place.

### `[ ]` **P3-4 — General API rate limiting** *(audit S2)*

* **Why:** auth and AI paths are well throttled; **everything else is not**. One authenticated
  student looping `/student/assignments` can exhaust the Free plan's 100k requests/day for everyone.
* **Do:** coarse per-user limiter (~300 req/min) as global middleware reusing `AuthGuardDO.charge()`,
  **or** Cloudflare WAF rate-limiting rules at the edge (costs no Worker CPU — likely the better call).
* **Effort:** 3–4 h.

### `[ ]` **P3-5 — Backup and disaster recovery**

* **Why:** **no D1 backup procedure is documented anywhere.** This is the one gap on the list that
  can lose data permanently.
* **Do:** document (and schedule) `wrangler d1 export CareerLinkAI_Main --remote --output …`; state
  retention and where dumps live; write the restore procedure and **test a restore into staging**.
* **Verify:** a restored staging DB serves a student's recommendations.
* **Effort:** 2–3 h. **Highest-value item in Phase 3 after the cutover itself.**

### `[ ]` **P3-6 — Class reassignment / guard counselor deletion** *(audit F5)*

* **Why:** deleting a counselor soft-deletes the user and leaves their classes pointing at a deleted
  owner. Admins can still reach them (`canViewClass` passes admins), so nothing is lost — but
  `counselor_id` is set at creation and never writable, so **a class can never be handed to a
  replacement counselor**.
* **Do:** block deletion when live classes exist, **or** add `PATCH /admin/classes/:id { counselor_id }`
  with a reassignment step. The UI already shows `classes_count` per counselor.
* **Effort:** 4–6 h.

### `[ ]` **P3-7 — DLQ alerting**

* **Why:** dead-lettered jobs are logged and acked — nothing notifies a human. A silently failing AI
  generation queue looks identical to an idle one.
* **Do:** Workers Logs alert, or a `scheduled` check that writes an admin notification on DLQ activity.
* **Effort:** 2 h.

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
| `[ ]` P4-12 | **Case-insensitive unique indexes** on `careers.title` / `colleges.name`, so P1-0's duplicate class cannot recur in data | P1-0 / P2-2 follow-up | 3–4 h |
| `[ ]` P4-13 | Audit the remaining ~59 `inArray` call sites for unbounded lists (the ones fixed were the catalog-scale three; most others are bounded by construction) | P2-2 follow-up | 3–4 h |
| `[ ]` P4-14 | Reformat the 78 backend files that drifted while `.prettierrc.json` was unparseable, then put `format:check` in CI so it cannot drift again | P1-3 follow-up | 1 h |

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
NOW ──► P3-5  backup & restore                     (2–3 h)   ← only item that can lose data
        P3-1  production cutover                   (3–5 h)   ← needs your credentials
        ────────────────────────────────────────────────── launched
        P3-2  catalog search        P3-4  rate limiting
        P3-3  code splitting        P3-6  class reassignment      P3-7  DLQ alerting
        ────────────────────────────────────────────────── hardened
        Phase 4
```

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
| 2026-07-28 | P2-2 | **811** BE / 112 FE | Staging rehearsal. **`generateFor` 500'd on D1's 100-parameter limit — every student got zero recommendations, caused by P0-1's own catalog expansion.** Fixed via `chunkIds`; 4 regression tests. `walkthrough.mjs` un-rotted (4 stale selectors + a removed auto-advance). Two duplicate careers archived. C1 proven live: **0/10 overlap** between opposite profiles. |
