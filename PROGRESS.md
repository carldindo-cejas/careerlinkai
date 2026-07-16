# CareerLinkAI Progress

**Tracks:** FULLPLAN.md v1.5 · **Last full audit of this file:** 2026-07-15 (**Phases 4.5, 5a and
5b are COMPLETE — deployed, exit-demoed and measured on staging.** The full Phase 0–5a walkthrough
passes **66/66** against the live deployment; the 5b exit demo passed **11/11** the same day —
generate → per-mapping confirm → publish, and the §6 RIASEC-as-admin 403 — see "The deploy
session, executed". **Only Phase 6 remains.**)
**Rule:** FULLPLAN.md is the single source of truth. Where this file and the plan disagree, the plan
wins and this file is a bug — unless the entry is explicitly marked as a ratified/proposed deviation
in the "Deviations From Master Plan" section below.

## Live deployments (Phase 3.5 Step 5)

| | URL |
|---|---|
| **Staging API** (Worker `careerlinkai-staging`) | https://careerlinkai-staging.cejascarldindo.workers.dev/api/v1 |
| **Staging frontend** (Pages `careerlinkai-staging`) | https://careerlinkai-staging.pages.dev |
| Staging D1 | `CareerLinkAI_Staging` · `54401a5c-bd05-4d38-973d-26e4b2b38f9f` |

Production (`careerlinkai`, the script the `careerlinkai.online` custom domains are attached to) is
**not deployed from this tree** and its D1 is still empty. Staging has its own D1, KV, R2, Vectorize
index and queue pair — it cannot reach production's data, which is the entire point of it existing.

> ⚠️ **The Cloudflare account is on the Workers _Free_ plan — permanently, as a ratified product
> requirement (FULLPLAN v1.5).** Phase 4.5 is now proven on the edge, not just in code:
> **`AuthGuardDO` derives every password at the full §38 600,000 iterations** (the DO gets a
> 30-second CPU budget on every plan, vs the Worker's 10 ms), the lockout/join-throttle counters
> live in the same object (KV retired from every auth path — D14 and D19, **both fully closed**),
> and the 2026-07-15 staging exit demo ran the error-1102 canary — **four consecutive
> `/auth/change-password` calls, each verifying and hashing at full cost, all 200s (~2 s each)** —
> confirmed the rotated hash is stored as `pbkdf2$600000$`, and watched the lockout trip on the
> fifth failure and refuse even the correct password while locked. The full Free-plan envelope —
> every verified ceiling and the three residual compromises (quota-exhaustion DoS, ~150–200 AI
> explanations/day, 24 h queue retention) — is documented in **FULLPLAN §45**.

> **History note:** a previous PROGRESS.md tracked the Laravel-era build (Phases 0–3, referenced by
> `docs/audit/2026-07-13-architecture-audit.md`). That file left the tree together with the retired
> Laravel backend. This file is the v1.3 tracker, rebuilt from a full verification pass over the
> actual working tree on 2026-07-13.

---

## Overall Progress

**Estimated completion: ~95% of total v1 scope.**

Basis for the estimate: everything through **Phase 5b is built, deployed to staging, exit-demoed
and measured** — the Phase 0–5a walkthrough passes 66/66 and the 5b demo 11/11 against the live
deployment, behind a green gate of **477 backend tests in workerd + 35 frontend tests**. What
remains is Phase 6 alone: notifications (the one missing table), the audit-log viewer, real
dashboard data, counselor management, the small D7/D8 debts, and defense prep.

**Every screen the React app has now has a backend behind it, and every backend feature now has a
screen.**

| Phase (FULLPLAN §57) | Status |
|---|---|
| Phase 0 — Foundation | ✅ **Re-delivered on the Worker** (Step 1) + ✅ frontend |
| Phase 1 — Class & Enrollment | ✅ **Re-delivered on the Worker** (Step 2) + ✅ frontend |
| Phase 2 — Academic Catalog | ✅ **Re-delivered on the Worker** (Step 3) + ✅ frontend |
| Phase 3 — Assessment Engine | ✅ **Re-delivered on the Worker** (Step 4) + ✅ frontend |
| Phase 3.5 — Platform Port | ✅ **COMPLETE.** Steps 1–5. The whole Phase 0–3 surface runs on a live Cloudflare deployment and the §57 walkthrough passes against it, through the unchanged frontend |
| Phase 4 — Recommendation Engine | ✅ **COMPLETE.** Migration 0007, `RecommendationService`, the `AssessmentCompleted` listener, the policy, both endpoints, the student screens, **and D11 fixed**. The full Phase 0–**4** walkthrough passes **61/61 on staging** — a student completes RIASEC *and* SCCT and is handed 10 ranked careers and 10 ranked programs, each with a college and a deterministic reason |
| **Phase 4.5 — Free-Plan Hardening (new in FULLPLAN v1.5)** | ✅ **COMPLETE — exit demo passed on staging 2026-07-15.** `AuthGuardDO` at 600k iterations; lockout + join throttle in the DO, KV retired from auth; CI platform gates live; submit-path subrequest budget ≤25. The live canary: 4 consecutive `/auth/change-password` calls all 200'd (~2 s each, where the pre-4.5 Worker died with error 1102), the new hash is stored `pbkdf2$600000$`, a pre-4.5 100k hash still opens, and the lockout tripped on the 5th failure (D14 + D19 **fully closed**) |
| **Phase 5a — AI Explanation / RAG** | ✅ **COMPLETE — exit demo passed on staging 2026-07-15.** The full §30/§33 stack live: PDF upload → UPLOADED → PROCESSING → COMPLETED (~72 s, queue batching dominates) → vectors queryable ≤10 s later → a **grounded explanation in 5.7 s generation latency (§6 budget: 8 s), 780 tokens**, served from the stored row on every later request. §30's refuse-ungrounded and §29's worst-day posture were both **proven live** — see "The deploy session, executed". Found + fixed live: Cloudflare had deprecated the §29 text model (platform fact #4) |
| **Phase 5b — AI-Assisted Generation** | ✅ **COMPLETE — exit demo passed on staging 2026-07-15, 11/11.** The §32 generation prompt; `AssessmentGenerationService` (§34 validator, unconfirmed-draft persistence); `GenerateAssessmentDraftJob` on the `ai` queue; the §20 generation endpoint group (both §31 modes + the status poll, `authorizeGenerateWithAi` category-first); the builder endpoint group (templates, dimensions, versions, the author's review payload, per-mapping confirm, publish); the `assessment-builder` frontend feature. **Live:** a 12-question Mode B draft landed DRAFTED in ~130 s, publish refused with "12 of 12 … unconfirmed", 12 individual confirms opened the gate, publish succeeded — and RIASEC-as-admin answered **403**. 477 backend + 35 frontend tests green |
| Phase 6 — Polish & Defense Prep | 🚧 Not started |

**Current phase:** **Phase 6** — notifications (the one missing table), the audit-log viewer,
real dashboard data, counselor management, the D7/D8 debts, defense prep.

### ⚠️ The single most important lesson in this document

**Three separate bugs shipped past a green local suite, and all three were invisible for the same
reason: Miniflare is not Cloudflare.** Each was caught only by deploying and driving the real thing.
None of them could have been caught by a test that asserts on a *result*, because locally there was
no wrong result to catch — the code did exactly what it asked, and the platform simply permits more
locally than it does at the edge.

| # | The limit | What it looked like | Found by |
|---|---|---|---|
| 1 | **PBKDF2 is capped at 100,000 iterations per `deriveBits()` call** | Every login by a *known* user 500'd. An unknown email still 401'd correctly, because that path short-circuits *before* PBKDF2 — so only real users were locked out. | Step 5 deploy |
| 2 | **A Free-plan Worker's CPU limit cannot be raised**, and 600k iterations do not fit in it | `/auth/change-password` derives twice and died with error 1102. The browser reported it as a **CORS error**, because a Worker killed mid-request emits no headers at all. | Step 5 deploy |
| 3 | **D1 refuses a query binding more than 100 parameters** | A student submitted their second assessment, got a perfectly scored result, and found an **empty recommendations screen**. The insert bound 200 parameters; the listener threw; `dispatch()` swallowed it exactly as designed. | Phase 4 deploy |

Bug 3 is the sharpest of the three, because the local suite could not have caught it **even if
Miniflare had enforced the limit**: the *test* catalog is a handful of rows, so the insert never grew
past 2–4 rows and stayed under the cap by accident. It took a real D1 **and** a real catalog.

**The only shape of test that catches this class of bug offline is one that asserts on _what the code
asks of the platform_, not on what the local runtime hands back.** `test/unit/crypto.test.ts` spies
on `deriveBits` and asserts the requested iteration count; `test/recommendation/d1-limits.test.ts`
asserts no insert is ever built wider than D1 will accept. **Phase 5a is the next place this bites,
and it is the worst one yet: Workers AI and Vectorize have _no local emulation at all_.**

The three bugs above found three limits the hard way. The **2026-07-14 Free-plan audit (FULLPLAN
§45) catalogued the rest of the class before they ship** — every one invisible to Miniflare, each
with its designated guard:

| Miniflare-blind limit | Would have bitten | Guard (✅ = built in Phase 4.5/5a) |
|---|---|---|
| 50 subrequests/request on Free (every D1/KV/AI/Vectorize/queue op counts) | 5a's per-chunk embedding loop | ✅ Batched embeddings (`gateway.embed`, one call per ≤100 texts, pinned by test) + `test/platform/subrequest-budget.test.ts` counts every D1 call on submit-with-inline-generation and holds it to ≤25 — **it failed at 35 on its first run and forced a real trim** (see Phase 4.5 section) |
| 3 MB gzipped bundle on Free | A server-side PDF parser dependency | ✅ Browser-side extraction (`frontend/src/features/admin/utils/extractText.ts`, dynamic imports) + the CI bundle gate (`npm run gate:bundle`, dry-run build, fails above 2.5 MB; currently **178 KiB**) |
| KV: eventual consistency (~60 s), 1 write/s/key, 1,000 writes/day on Free | The lockout being blindable/exhaustible | ✅ Counters live in `AuthGuardDO` — strongly consistent, no daily quota; KV is bound but nothing security-relevant touches it |
| Queues: 10k ops/day, **24 h retention** on Free | A stuck 5a job silently vanishing | ✅ Jobs re-read durable state (the R2 text sidecar), skip already-done work (`vector_id IS NULL`), and `POST /admin/knowledge-documents/{id}/reprocess` is the admin re-run button (§42) |
| Workers AI: 10,000 neurons/day, hard-stop | The demo's Nth explanation 500ing | ✅ `AiGatewayService` types the failure (`QUOTA_EXHAUSTED`), logs the FAILED `ai_requests` row, never retries, and every caller serves the deterministic §27 reason (§30) |
| Vectorize: upserts indexed **asynchronously** | Ingest-then-query flakes, "failed" writes that succeeded | ✅ `COMPLETED` = accepted, stated at every seam; retrieval tolerates absent matches; the staging smoke poll is on the deploy checklist |
| Daily quotas generally (100k requests, 5M D1 reads, 100k D1 writes — all account-wide, staging included) | A load test or attacker exhausting the day | §45 envelope math + dashboard check before the defense; availability-only risk, accepted |
| **Workers AI models are deprecated server-side, with no deploy on our end** — `@cf/meta/llama-3.1-8b-instruct` was retired 2026-05-30 and every call to it fails with error **5028** | **It did bite — platform fact #4, found live on the 5a exit demo.** Every explanation failed `MODEL_ERROR` while all 477 local tests were green (the suite stubs the gateway, as it must) | ✅ The §29 posture held on a real outage: every student got a 200 + the deterministic reason, and the FAILED `ai_requests` rows named the exact cause in `failure_reason`. Fixed by switching `WORKERS_AI_TEXT_MODEL` to `@cf/meta/llama-3.1-8b-instruct-fp8` (same model, fp8-quantized, current) — a one-var change precisely because §29 made the model name config, not code. If explanations ever degrade to MODEL_ERROR again, check the model's lifecycle page before the code |

> **Toolchain fact found in Phase 5a (good news for once):** the current
> `@cloudflare/vitest-pool-workers` D1 emulation **now enforces the 100-bound-parameter cap**
> (`too many SQL variables`). The first cut of the knowledge-chunk insert miscounted its columns
> (6 vs the real 7) and sized its batches at 16 rows = 112 parameters — the class of bug that
> shipped to staging as D18 was this time caught by the local suite. `chunkForD1`-style guards
> stay (they encode intent, and headroom), but this limit is no longer Miniflare-blind.

---

**Step 5 was not a formality:** the Worker that passed **371/371 tests locally** could not verify a
single staff password once deployed. Two Cloudflare limits, **neither of which Miniflare enforces**,
were invisible to every test on both sides of the stack:

1. **The runtime refuses PBKDF2 above 100,000 iterations per `deriveBits()` call.** §38 asks for
   600,000 in one call. Every login by a *known* user 500'd on the edge, while an unknown email
   still 401'd correctly — because that path short-circuits *before* PBKDF2. `crypto.ts` now chains
   rounds under the ceiling, which preserves the work factor exactly.
2. **A Free-plan Worker's CPU limit cannot be raised**, and 600,000 iterations do not fit in it.
   `/auth/login` derives once and *intermittently* survived; `/auth/change-password` derives twice
   (verify old + hash new) and died with error **1102** — which the browser reported as a **CORS
   error**, because a Worker killed mid-request emits no headers at all. The iteration count is now
   **100,000** (D14). *(This section originally said "the fix for that is a credit card, not a
   commit" — superseded by the v1.5 audit: Durable Objects get 30 s of CPU per invocation on the
   Free plan, so the fix is Phase 4.5's `AuthGuardDO`, and it is a commit after all.)*

Both are now regression-tested by asserting on **what the code asks of the platform** rather than on
what the local runtime hands back — the only shape of test that can catch this class of bug offline.

**Remaining phases:** 6 only — plus the frontend screens it adds (notifications, audit-log
viewer, real dashboards, counselor management).

### ⚠️ Critical context for the port (read before writing code)

1. **The Laravel reference implementation is gone from the working tree**, so the "233 passing
   tests define done" contract (FULLPLAN §57 Phase 3.5) is not recoverable. The plan's Phase 3.5
   exit criterion said Laravel is removed *after* the port passes on staging; it was removed
   *before* the port started. The surviving contract artifacts, in authority order:
   **FULLPLAN.md → `docs/api/phase-1..3.md` → the frontend services/types/tests**. Treat those
   three as the executable specification. *(Note: there is no `docs/api` file for Phase 0 auth —
   the auth contract is FULLPLAN §20/§38 plus `frontend/src/services/authApi.ts` and
   `types/user.ts`, and the Step 1 test suite is now the executable record of it.)*
2. **The frontend is the invariant** (§57): zero React changes are allowed beyond
   `VITE_API_BASE_URL`. Any frontend change the port seems to need is a port bug. *(Held so far —
   the only frontend edit in Step 1 was `.env`/`.env.example`, deviation D6, now resolved.)*
3. **The tree is now a git repository** (`main`, one commit). CI/CD (§47) is still unconfigured —
   no `.github/workflows` exists yet.

### Toolchain facts discovered in Step 3 (read these before Step 4)

- **The test suite runs against `wrangler.test.toml`, not `wrangler.toml`, and this matters.**
  Workers AI and Vectorize have **no local emulation**: Miniflare emulates D1, KV, R2 and Queues
  in-process, but `[ai]` and `[[vectorize]]` always open a real connection to the Cloudflare API. So
  every test worker performed a network handshake before running a single assertion — and when the
  `wrangler login` token expired mid-session, **the entire 141-test suite went from green to "no
  tests"**, reporting a failed `/workers/subdomain/edge-preview` call rather than anything a reader
  would connect to authentication. `wrangler.test.toml` is the same Worker minus those two bindings.
  The suite is now **hermetic — it runs offline, with no Cloudflare account at all**, which is also
  what unblocks CI (D9: a GitHub runner would otherwise have needed a live `CLOUDFLARE_API_TOKEN`
  as a secret purely to run tests that never call Cloudflare). It is a side benefit that
  `wrangler dev --config wrangler.test.toml` now boots in **~3 s instead of 20–30 s**.
  - **When Phase 5a lands**, test the AI/RAG pipelines against a *stubbed* gateway. An assertion on
    a live LLM's output is not a test, it is a weather report. A real-model smoke check, if wanted,
    belongs in its own suite with its own config — not wired into the gate that must be green on
    every push.
- **A bare `schema.parse()` in a route handler throws a raw `ZodError`, which is not an `ApiError`,
  so `app.onError` could not recognise it and the caller got a 500.** `?per_page=5000` — a client
  typo — was answering *"An unexpected error occurred."* The Step 2 `GET /counselor/classes` route
  had the same hole and was fixed with it. Use `parseQuery()` / `parseBody()` from
  `lib/validation.ts`; `app.onError` now also catches a stray `ZodError` as a 422 backstop, so this
  cannot silently regress again.
- **`wrangler login` had expired** (`code: 9109`, "Max auth failures reached"). Re-auth is
  interactive. Nothing in the local loop needs it any more — tests, `db:migrate --local`,
  `db:seed`, and `wrangler dev --config wrangler.test.toml` all run offline — but the **remote**
  paths (`db:migrate:remote`, `deploy`, and Step 5's staging work) do.
- **`testTimeout` raised 30 s → 60 s**, and this is a real signal rather than a nuisance. The §38
  lockout test charges five *failed* logins plus a success, and a failed login deliberately still
  runs the full PBKDF2 derivation — a fast rejection would be a timing oracle telling an attacker
  the email exists. That is ~34 s of honest CPU. It cleared 30 s comfortably when the suite was
  small, and started intermittently tipping over it once the suite hit 270 tests and the workers
  began competing for cores: **it failed in the full run and passed in isolation.** The test was
  never wrong; the budget was. If Step 4 makes the suite flaky again, suspect the budget before the
  test — and never the hash.

### Toolchain facts discovered in the browser pass (read before Step 5)

- **`wrangler.test.toml` is also the best *dev* server, not just the test config.** `wrangler dev
  --config wrangler.test.toml` boots in **~3 s, fully offline**, and serves the whole Phase 0–2
  surface the frontend consumes — no `wrangler login`, no Cloudflare account. The frontend was
  driven against it for the entire pass. Use plain `wrangler.toml` only when you actually need AI or
  Vectorize (Phase 5a).
- **Playwright cannot download its browsers here** — `cdn.playwright.dev` is unreachable from this
  environment, and `npx playwright install` **exits 0 while having downloaded nothing**, so the
  failure surfaces later as "Executable doesn't exist". Drive the **system Chrome** instead:
  `chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })`.
- **The walkthrough is re-runnable but not idempotent by itself**: rotating a password is a one-way
  door, so a second run must reset its fixture counselor first (`INSERT OR REPLACE` the user row with
  a temp-password hash and `must_change_password = 1`). A green-then-red rerun of the auth flow is
  usually this, not a regression.
- **The local D1 now carries the pass's artifacts** — a `Walkthrough Counselor` account, two
  `Grade 12 STEM A — Browser Pass` classes with four students each, and a `Browser Pass University`
  college with a BSCS program and a mapped career. They are deliberately **not** deleted: the audit
  log is append-only (§13.4) and rows referencing these users must not be orphaned. §27's worked
  example is untouched (the additions are under a *new* college, not UP Diliman's BSCS). Reset with a
  fresh `db:migrate` + `db:seed` if a clean demo database is wanted.

### Toolchain facts discovered in Step 1 (save the next step some time)

- **`@cloudflare/vitest-pool-workers` v0.18 changed its config API.** `defineWorkersConfig` and the
  `@cloudflare/vitest-pool-workers/config` subpath are **gone**; you now use a plain
  `defineConfig` from `vitest/config` plus the `cloudflareTest()` Vite plugin, imported from the
  package root. (A codemod ships at `@cloudflare/vitest-pool-workers/codemods/vitest-v3-to-v4`.)
  `vitest.config.ts` was written against the old API and could never run; it is fixed.
- **`isolatedStorage` no longer exists** — storage is *not* rolled back between tests in a file.
  A test must never assert on "the only row in the table"; identify your own rows by a fixture's
  id/email. `test/helpers.ts` generates unique emails and UUIDs so this stays safe.
- **`testTimeout` is raised to 30s** because PBKDF2 at 600k iterations (§38) is expensive on
  purpose and an auth test pays it repeatedly. Do not "fix" a slow auth test by weakening the
  hash — the suite would stop exercising production's parameters. Fixture hashes are memoised in
  `test/helpers.ts` instead.
- **`@cloudflare/workers-types` v5 dropped the dated entrypoints** (`.../2023-07-01`); `tsconfig`
  uses the package root.
- **`wrangler dev` takes ~20–30 s to become ready** because the `AI` and `VECTORIZE` bindings
  always establish a remote connection (they have no local emulation). This is expected noise, not
  a failure — poll `GET /api/v1/health` rather than trusting the first log lines.

---

## Module Status

Status below = state of the v1.3 Worker implementation, which is what ships. Seven of the eight
modules are still unbuilt; **Identity & Access is now built for the staff half.**

### Identity & Access (`users`, `counselor_profiles`, `student_profiles`)
- **Status:** ✅ **Both auth flows complete** (Steps 1–2) · 🚧 `student_profiles` endpoints pending (Step 4)
- **Implemented on the Worker:** migration `0001_identity_and_access.sql` (+ `0002_audit_logs.sql`);
  Drizzle schema/client; PBKDF2-SHA256 derivation (600k iterations, `pbkdf2$iterations$salt$hash`)
  — **inside `AuthGuardDO` since Phase 4.5** (`src/do/auth-guard.ts`; `lib/crypto.ts` keeps only
  tokens/uuid, and the platform gate asserts `deriveBits` is called nowhere outside the DO);
  opaque bearer-token service over `api_tokens` (SHA-256 hashed, expiry, revocation);
  `authenticate` / `ensure-role` / `ensure-password-changed` / `correlation-id` middleware;
  DO-backed staff lockout (5 failures per email → 15 min, **failures only**, counted in the same
  per-email instance that performs the derivation — Phase 4.5 retired the KV limiter, D19);
  `StaffAuthenticationService` with all six endpoints; `must_change_password` semantics;
  seeder (1 admin + 1 counselor, temp password, forced rotation).
  **Step 2 added `StudentAccessService` + `POST /student-access/join`** — its own router, sharing
  no code path with staff auth (§38).
- **Missing:** `student_profiles` endpoints (`GET/PATCH /student/profile`, Step 4).
- **Verified behaviours (staff auth):** generic 401 for wrong password *and* unknown email
  (identical bodies); a student can never authenticate through the staff flow; a correct credential
  against a non-`active` account gets a **403 with a reason**, not a silent 401; a live token is
  rejected once its user is suspended or soft-deleted (§38, v1.2); an expired token's row is deleted
  on rejection so it cannot be replayed; logout revokes exactly one session while a password change
  or reset revokes **all** of them; the lockout is charged on failure only and is cleared by a
  success or a reset.
- **Verified behaviours (student access, §38 — all six failure modes):** unknown code, expired code,
  draft/archived/soft-deleted class, unknown username, removed enrolment and deactivated account all
  return the **byte-identical 401** (`{"success":false,"message":"The class code or username is
  incorrect.","errors":{}}`), while the *real* reason (`INVALID_CODE`, `CODE_EXPIRED`,
  `CLASS_NOT_ACTIVE`, `UNKNOWN_USERNAME`, `ENROLLMENT_REMOVED`, `ACCOUNT_INACTIVE`) goes only to
  `audit_logs.new_values.reason`. The API tells the caller nothing; the audit trail tells the
  operator everything. A join **replaces** the student's prior token (one active session), and the
  student-facing response carries **no `join_code` and no `counselor_id`**.
- **Files:** `backend/src/modules/identity/`, `backend/src/lib/crypto.ts`, `backend/src/lib/tokens.ts`,
  `backend/src/middleware/`, `backend/migrations/`, `backend/seeds/`, `backend/test/auth/`,
  `backend/test/student-access/`.

### Class (`classes`, `class_students`)
- **Status:** ✅ **Complete** (Phase 3.5 Step 2). Frontend complete (ClassList/Detail, RosterBuilder
  with preview→edit→confirm, JoinCodeCard, regenerate-code).
- **Implemented:** migration `0003_classes_and_enrollment.sql`; `ClassService` (CRUD, soft delete,
  archive-vs-delete, join-code generation at creation, regeneration); `ClassEnrollmentService`
  (`previewUsernames()`, `confirmEnrollment()`, roster listing, removal); `policies/class.ts`;
  the failures-only `(class_code, IP)` throttle; class + roster audit logging.
- **Join code (§13.2, §38):** four letters, a hyphen, four digits, from an alphabet that **excludes
  I, O, 0 and 1** — a student hand-types this and a failed join tells them nothing about why, so an
  `O` misread as a `0` would be an undebuggable dead end. Keyspace 24⁴ × 8⁴ ≈ 1.36 billion. Picked
  with rejection sampling, not `byte % 24`, which would skew the first 16 letters. Generated at
  creation, **never accepted as input** (a supplied `join_code` is ignored), and regeneration
  revokes the old code immediately.
- **Roster (§16):** the name-parsing contract (first token = first name, the rest = last name),
  ASCII folding (`José Peña` → `jose.pena`), punctuation stripping (`O'Brien` → `obrien`), `2`/`3`
  suffixing within the batch *and* against the class, class-scoped collision checks only, the
  200-name cap, and **mononyms** (`Madonna` → `last_name: null`, username `madonna`) which preview
  *and confirm* unchanged. One collision rejects the **whole batch** — there is no
  half-provisioned roster. An empty-string `last_name` is normalised to NULL.
- **Removal → token revocation (audit F-H3):** removing a student marks the enrolment `removed`
  (the row is kept — `class_students` *is* the enrolment history) **and revokes their live tokens in
  the same act**. This was the one known gap in the Laravel original and was built in from the
  start rather than ported. A student id not enrolled in *this* class 404s rather than confirming
  the account exists.
- **Files:** `backend/src/modules/classes/`, `backend/src/policies/class.ts`,
  `backend/src/lib/slugify.ts`, `backend/src/middleware/rate-limit.ts`, `backend/test/classes/`.

### Academic Catalog (`colleges`, `programs`, `careers`, `program_careers`)
- **Status:** ✅ **Complete** (Phase 3.5 Step 3). Frontend complete (College CRUD + nested
  programs, Career CRUD, program↔career mapping).
- **Implemented:** migration `0004_academic_catalog.sql`; `AcademicCatalogService` (all 15
  endpoints); the `/admin` route group — its first mount; `lib/holland.ts`; the demo catalog
  seeder (`seeds/0002`).
- **No `CatalogPolicy`, deliberately** (§39 names three policies and no catalog one). A college
  belongs to nobody: this is global reference data and `admin` is the entire rule. A policy here
  would be six methods of `return user.role === 'admin'`, restating what the route already
  guarantees. The consequence is stated in the route file and is why
  `test/catalog/authorization.test.ts` enumerates **all 15 endpoints × 3 caller types** rather
  than spot-checking: **the route group is the only thing standing between a new catalog endpoint
  and a counselor who can edit the catalog.** There is no second net.
- **Uniqueness is a live-row lookup, not a DB index** (college name, program code within its
  college, career title) — and it is case-insensitive. These tables are soft-deleted, so a unique
  index would let one deleted "University of Santo Tomas" permanently block anyone from ever
  adding the real one. Case-insensitive because naming drift *is* the thing promoting `colleges`
  out of a text column in v1.1 was meant to stop, and "University of Santo Tomas" beside
  "university of santo tomas" is that drift, one row apart.
- **Program `code` is uppercased in the schema, before the uniqueness check runs** — not after.
  The check is a string comparison, so a stored `BSCS` and an incoming `bscs` would not match, the
  check would pass, and a second BSCS would land in the same college. `code` is unique *within* a
  college, not globally: BSCS at UP and BSCS at DLSU are different programs.
- **`college_id` is accepted nowhere** (not on create, not on update). The parent comes from the
  route; a body naming a different college is ignored. Moving a program between institutions would
  silently rewrite the college §27 derives for every recommendation already pointing at it.
- **DELETE a college cascades to its programs**, in one `db.batch()`. Without it a program whose
  college is deleted is *unreachable but alive*: the college 404s so nothing can list the program
  again, while `PATCH /programs/{id}` still edits it happily — and it was still being handed to the
  recommendation engine. A college and its programs are one unit. (Tested both ways.)
- **The Holland code** (`careers.typical_riasec_code`, `lib/holland.ts`): letters from `R I A S E C`
  only, **at most 3** (there are only three position weights — a fourth letter would be read at an
  index with no weight and count for nothing), and **no repeated letter** (`IIE` would weight
  Investigative at 0.5 + 0.3 = 0.8, scoring a one-dimensional student as a near-perfect match for a
  career they are not). `iec` is accepted and **stored as `IEC`**; `""` normalises to `NULL`, because
  §27 would otherwise iterate a zero-letter code. Order is data, not formatting.
- **The two Phase 4 read methods exist and are tested now**, while the rules are fresh:
  `rankablePrograms()` — **the single place recommendability is decided**, and Phase 4 is meant to
  ask nothing else — enforces that recommendability is a property of the *chain*: an `active`
  program under an `archived` college is **not** rankable, because `programs.status` says nothing
  about whether the college still offers it. `scorableCareersFor()` drops archived careers from the
  §27 average while the **link survives** (archiving is not unlinking — the admin still sees the
  chip, struck through, so restoring the career brings its vote back).
- **Resolved a genuine FULLPLAN silence:** §27 says *"for every ACTIVE career"* when ranking career
  matches but *"over all careers linked to this program"* for the program score, and never
  reconciles the two. Resolved in favour of §8's archive-don't-delete semantics — archiving means
  "stop recommending this", so a career no longer recommended on its own must not keep voting on the
  score of every program linked to it. A program whose careers are all archived is therefore
  indistinguishable from an unmapped one and takes §27's neutral **50**, rather than an average over
  nothing (which would be `NaN`, and would silently poison the composite).
- **Files:** `backend/src/modules/catalog/`, `backend/src/lib/holland.ts`,
  `backend/migrations/0004_academic_catalog.sql`, `backend/seeds/0002_academic_catalog.sql`,
  `backend/test/catalog/`, `backend/test/unit/holland.test.ts`.

### Assessment (`assessment_templates` … `assessment_assignments`, 7 tables)
- **Status:** ✅ **Complete** (Phase 3.5 Step 4) — **and, since Phase 5b, the builder has its
  endpoints and its UI.** The §20 template/version group is mounted at the API root (shared by
  admin and counselor, ownership per record): create CUSTOM template, add dimensions, create
  version, the author's review payload (`GET /assessment-versions/{id}` — questions **with**
  scores and mappings, the exact disclosure the player payload withholds), manual question add
  (confirmed at insert), question edit (DRAFT only), `POST /question-dimensions/{id}/confirm`
  (the §25 act, one at a time — no bulk form, deviation D24), publish-readiness, publish. The
  `assessment-builder` frontend feature (TemplateListPage + TemplateBuilderPage) serves both
  roles from both shells.
- **Implemented:** migration `0005_assessment.sql`; `AssessmentBuilderService` (templates,
  versions, dimensions, questions, publish, publish-readiness); `policies/assessment.ts`;
  `instruments.ts` (the RIASEC/SCCT content + seeder); the `/student` route group — its first mount.
- **The three invariants, none of them expressible as a DB constraint** — which is exactly why each
  has its own test in `test/assessment/invariants.test.ts`:
  1. **A PUBLISHED version is frozen forever**, it and every question/option/mapping beneath it.
     SQLite cannot say "reject an UPDATE when a parent column has a given value". Fix a mistake by
     publishing *N+1*.
  2. **Dimensions freeze once ANY version of their template publishes** (v1.2). They hang off the
     *template*, so version immutability does not reach them — and renaming "Investigative", or
     sliding a band from 67 to 60, would rewrite results already delivered. This is also what makes
     `confirmed_at` durable: confirming "this item measures Investigative" means nothing if someone
     can then edit what Investigative *is*.
  3. **The publish gate** — no version publishes while any `question_dimensions.confirmed_at IS
     NULL` (§25). A cross-row aggregate; a CHECK sees one row. A 422 **with a count**, because
     "publish failed" with no number is a dead end for whoever has to fix it. Publishing a version
     with *zero* questions is also refused: it would satisfy the gate's letter (nothing is
     unconfirmed) while making nonsense of it.
- **`generateWithAi` checks the category BEFORE ownership**, and that ordering *is* the rule rather
  than a style preference: it is what makes the refusal apply to an **admin who owns the template
  outright**. An ownership-first version would read almost identically and would quietly grant the
  exception to the one role that must not have it. The AI endpoints are Phase 5b; the rule and its
  test land now (§6: "rejected by the backend, not just hidden by the UI").
- **`assessment_dimensions.order_number` added** — §13.4's column list omits it, but
  `docs/api/phase-3` specifies it and says why: §22 breaks Holland Code ties on the canonical
  `R > I > A > S > E > C`, so it is **scoring data, not a display preference**. Without it a student
  with I = A = 71.0 gets whichever row the database returned first, and their Holland Code is a fact
  about row ordering rather than about them. FULLPLAN is *silent* here, not contradictory, so the
  contract doc fills the gap (deviation D12).
- **The seeders publish through the real service** (§57). A `.sql` seed writing
  `status = 'PUBLISHED'` would appear to prove the gate works while demonstrating exactly how to
  bypass it — and the seeder is what a future AI-generation feature would imitate. Reached over HTTP
  (deviation D13) because a D1 binding only exists *inside* the Worker.
- **Files:** `backend/src/modules/assessment/`, `backend/src/policies/assessment.ts`,
  `backend/migrations/0005_assessment.sql`, `backend/test/assessment/`.

### Attempt & Results (`assessment_attempts`, `assessment_answers`, `dimension_scores`, `assessment_results`)
- **Status:** ✅ **Complete** (Phase 3.5 Step 4). Frontend complete (player, results, per-dimension
  breakdown honoring "absent ≠ zero") — and now **driven against this backend in a real browser**.
- **Implemented:** migration `0006_attempt_and_results.sql`; `lib/scoring.ts` (the pure §24 engine)
  + `ScoringService` (the DB shell); `AssessmentAttemptService`; `events/dispatcher.ts` +
  the `AssessmentCompleted` event.
- **`lib/scoring.ts` is pure — no DB, no clock, no I/O — and that is what makes §57's "build the
  scorer first and unit-test it standalone *before* any route exists" actually executable.**
  `test/unit/scoring.test.ts` pins the **Part VI worked examples**: §22's 42/50 → **84.0** and
  Holland Code **"IAS"**, §23's composite → **72.3**. A scoring engine tested only against itself
  proves nothing.
- **Three rules that look like edge cases and are not:**
  - **Prorating** (v1.2): an unanswered question contributes to neither `raw` nor `max`. Only
    reachable for an *optional* question — **and the required-question submission block is what
    makes it safe rather than catastrophic.** Without the block a student could answer one
    Investigative item with a 5, skip the other 59, and walk out with a perfect and entirely
    meaningless `I`.
  - **`max === 0` writes no row at all.** An absent dimension means "not measured", which is a
    different and more honest claim than a zero. A stored `0.00` would be sorted into the Holland
    Code as a real dimension and averaged into a recommendation as a real number.
  - **An assessment with no dimensions is still SCORED** and still fires `AssessmentCompleted` —
    the ungraded, reflection-only CUSTOM path. "The student finished" is true whether or not
    anything was measured.
- **The one-attempt-per-assignment constraint is a PARTIAL unique index** (`WHERE status <>
  'EXPIRED'`), not a plain `UNIQUE(assignment_id, student_id)`. A plain one would make the counselor
  reset **impossible**, because the expired row still occupies the pair. The retake keeps the old
  attempt, with its answers, as history.
- **Closing an assignment is not a status flip:** it expires every attempt still `IN_PROGRESS`
  underneath it, in the same `db.batch()`. Attempts already `SUBMITTED`/`SCORED` are untouched —
  closing ends unfinished work, it does not revoke finished work.
- **`overall_summary` contains no digits, on purpose.** §23 forbids any consumer from parsing a
  number back out of it, and the surest way to enforce that is to leave nothing there to parse.
  Part VII calls `ScoringService.compositeIndexFor()`, which recomputes the index from
  `dimension_scores` + the version's `scoring_config`. A test asserts the prose is digit-free.
- **`AssessmentCompleted` fires with zero listeners registered.** §24 requires it to fire once per
  scored attempt for every category; the listener that decides whether recommendation generation
  runs (`DispatchRecommendationGeneration`, which checks that *both* a RIASEC and an SCCT result
  exist) is **Phase 4**. The seam is what Phase 4 plugs into. A listener that throws cannot fail the
  submit — the scoring is already committed and the student is on the screen.
- **Files:** `backend/src/lib/scoring.ts`, `backend/src/modules/assessment/scoring-service.ts`,
  `backend/src/modules/assessment/assessment-attempt-service.ts`, `backend/src/events/`,
  `backend/migrations/0006_attempt_and_results.sql`, `backend/test/unit/scoring.test.ts`.

### Recommendation (`recommendations`, `recommendation_explanations`)
- **Status:** ✅ **Complete (Phase 4)** — engine, service, listener, policy, endpoints and the
  student screen, verified end to end on staging (61/61). `recommendation_explanations` exists and
  is deliberately **empty**: it is Phase 5a's table, and its separateness is the structural
  deterministic/AI boundary (§13.6).
- **Built in Phase 4:** migration `0007`; `RecommendationService` (reads the latest **SCORED**
  RIASEC and SCCT results, calls the §27 engine, persists the top 10 of each type);
  `events/dispatch-recommendation-generation.ts`; `policies/recommendation.ts`;
  `GET /student/recommendations` + `/latest`; `GET /counselor/students/{id}/recommendations`;
  `RecommendationPage` + `recommendationApi` + `useRecommendations`.
- **The SCCT index is _recomputed_, never parsed out of prose.** `ScoringService.compositeIndexFor()`
  derives §23's composite from `dimension_scores` + the version's `scoring_config`. It is never read
  back out of `assessment_results.overall_summary` — which is why the scorer deliberately writes no
  digits into that column at all, and why a test asserts the prose is digit-free. If this service
  ever needs a number that only exists inside a sentence, the sentence is the bug.
- **`db.batch()` + chunking (D18):** D1 caps a query at **100 bound parameters**; a 20-row insert
  binds 200 and is rejected. See D18 — this shipped, silently, and is the third platform limit no
  local test could see.
- **No N+1:** `scorableCareersForMany()` fetches every program's careers in **one** query.
  The first version looped `scorableCareersFor()` per program — ~17 sequential D1 round trips inside
  the student's submit request.
- **Files:** `backend/src/modules/recommendation/`, `backend/src/policies/recommendation.ts`,
  `backend/src/events/dispatch-recommendation-generation.ts`,
  `backend/migrations/0007_recommendations.sql`, `backend/test/recommendation/`,
  `frontend/src/features/student/pages/RecommendationPage.tsx`.

<details><summary>Historical — the Phase 4 pre-build state</summary>

- **Status was:** 🟡 **The §27 formula core is built and tested** (`lib/recommendation.ts`, 37 unit
  tests). Everything around it is still blocked on Step 4. No frontend (no recommendations
  screens, no service module).
- **Implemented:** `lib/recommendation.ts` — pure arithmetic, no DB, no I/O: `riasecCompatibility`
  (position weights `[0.5, 0.3, 0.2]`, **renormalized** for a code under 3 letters),
  `programRiasecCompatibility`, `academicFit`, `strandAlignment`, `programEligibility`, both
  composites, `rankTop`, `topDimension`, and the deterministic reason string.
  **`test/unit/recommendation.test.ts` pins §28's hand-computed numbers** — Software Engineer
  (`IEC`) = **69.1**, BS Computer Science = **76.1**, and the ordering claim that the program
  outranks the bare career match. §26 promises reproducibility; checking the engine against
  numbers a human computed by hand, rather than against itself, is the only thing that holds
  that claim to account. The seeded catalog already carries those exact rows.
- **Four genuine §27 silences, resolved toward its own stated instinct** (*an absent signal is
  neutral, never a penalty*) and marked `// SILENCE:` at each site:
  1. **A career with no `typical_riasec_code` → neutral 50**, not exclusion. §27's only stated
     no-signal default is the program's "defaults to 50 if the program has no linked careers".
     Consequence, accepted: every codeless career scores identically and they tie — so they are
     ordered by title, not ranked against each other on evidence that does not exist.
  2. **A student with no `strand` → neutral 70, not the 40 mismatch.** 40 means "we know your
     track and it is the wrong one"; an unfilled profile field is not a wrong answer. §27 already
     maps an unknown GWA to a neutral-leaning-positive 70.
  3. **The eligibility clause is omitted when GWA < 75.** §27's template hardcodes the words
     "meets the typical academic profile" — at a GWA of 72 that is false, and the engine must not
     tell a student something untrue to fill a slot in a string.
  4. **Ranking ties break by title/name ascending.** §26 promises a reproducible ranking; two
     careers on an identical score (see #1 — not hypothetical) would otherwise rank in whatever
     order the catalog query happened to return.
- **Rounding:** components are carried **unrounded** and only the composite is rounded, to one
  decimal (§28: `76.06 → 76.1`). §28 carries `67.75` into the composite rather than flattening it
  to `67.8` first — rounding an input and *then* weighting it compounds the error into the number
  a student is actually shown. A test pins this.
- **Missing (all blocked on Step 4):** `RecommendationService` (the shell that reads
  `dimension_scores` + `student_profiles` and persists the top 10 of each type),
  the `recommendations` migration — **`recommendations.assessment_result_id` is an FK to
  `assessment_results`, so the migration cannot even be written until Step 4 creates that
  table** — `GenerateRecommendationJob`, the `DispatchRecommendationGeneration` listener
  (both-results-exist check), student recommendation screens, counselor
  `GET /students/{id}/recommendations`.
- **Files:** `backend/src/lib/recommendation.ts`, `backend/test/unit/recommendation.test.ts`.

</details>

### AI / Knowledge (`knowledge_documents`, `knowledge_chunks`, `ai_requests`, `ai_policies`)
- **Status:** ✅ **Both halves built.** The 5a half (gateway, ingestion, retrieval, explanation,
  policy) is complete **and proven on staging** (see "The deploy session, executed"). The 5b half
  is code-complete: `AssessmentGenerationService` (the §31 pipeline + the §34 output validator,
  `parseGenerationOutput` — pure and unit-tested against hand-written malformed payloads),
  `src/prompts/assessment-generation.v1.ts` (§32 verbatim, `{max_questions}` interpolated but
  enforced by the validator regardless), `GenerateAssessmentDraftJob` on the `ai` queue, and the
  generation endpoint group. Frontend complete for both (Knowledge/AI-policy/Explain-more from 5a;
  the generator panels in the builder from 5b).
- **The 5b async contract:** the generate endpoints answer **202 with a pre-allocated
  `ai_requests` id** and enqueue; the job hands that id to the gateway, so the row it writes is
  the row the client polls (`GET /ai/requests/{id}/status`). The draft's outcome is **derived,
  never stored twice**: no row → `PENDING`; row FAILED → `FAILED` (+ the §30 taxonomy reason);
  row SUCCESS with no questions referencing it → `VALIDATION_FAILED` (§34 rejected the output);
  row SUCCESS with questions → `DRAFTED` (+ count + Mode A's inert `suggested_dimensions`,
  re-parsed from the stored response text). A job lost to the 24 h queue retention polls PENDING
  forever, and the honest remedy is the same button as a validation failure: request a fresh
  generation.
- **What the 5b pipeline must never do** is produce anything a student can be measured by without
  a human in between — enforced not here but by §25's gate, which this service *feeds*: every
  mapping it writes has `confirmed_at = NULL`, every question `source = 'AI_GENERATED'` +
  `source_ai_request_id`. The job also **re-checks the category** (CUSTOM only) even though the
  endpoint's policy already refused RIASEC/SCCT — §32's own rule ("you must never assume that
  check happened correctly"), tested by forging the queue message the endpoint could never send.
- **Implemented:** migration `0008`; `AiGatewayService` (the single adapter — one `ai_requests`
  row per generation call, the §30 v1.5 failure taxonomy with `QUOTA_EXHAUSTED` never retried,
  batched `embed()` pinned to one call per ≤100 texts); `KnowledgeIngestionService` (§33 —
  browser-extracted text + raw file to R2, an `extracted.txt` sidecar as the durable job input,
  chunking via the pure `lib/chunker.ts`, ≤100-param D1 inserts, batched Vectorize upserts,
  vector id = chunk id, archive-removes-vectors, the reprocess re-run path); `RetrievalService`
  (top-K 6, ≥0.75 similarity, no visibility filter by design — archived content is structurally
  absent from the index); `ExplanationService` (the §30 pipeline: refuse-to-generate-ungrounded,
  §32 prompt from the versioned file + `ai_policies` injection, §34 guardrails with one
  regeneration, every failure converging on the deterministic §27 reason);
  `AiPolicyService` + `seeds/0003_ai_policy.sql` (the single GLOBAL row — seeded, never created
  over HTTP); the queue's first real jobs (`src/jobs/ai-jobs.ts`) and the consumer dispatch;
  the `RecommendationGenerated` event, whose listener queues explanation of the two rank-1
  matches only (~2 of the ~150–200 the daily neuron quota funds — the other 18 cards generate
  on demand).
- **Deliberately stub-tested:** Workers AI and Vectorize have no local emulation (the bindings the
  test config deletes). The suite pins what the code *asks* of them — batch sizes, upsert shapes,
  the quota taxonomy, `ai_requests` rows — and the HTTP tests run with the bindings genuinely
  absent, which proves the §29 posture end to end: the student gets a 200 and the deterministic
  reason on the platform's worst day.
- **Missing:** nothing — both halves are deployed and exit-demoed on staging (2026-07-15; the
  measurements are recorded under "The deploy session, executed").
- **Files:** `backend/src/modules/ai/` (now incl. `assessment-generation-service.ts`,
  `generation-routes.ts`), `backend/src/lib/chunker.ts`,
  `backend/src/prompts/recommendation-explanation.v1.ts`,
  `backend/src/prompts/assessment-generation.v1.ts`, `backend/src/jobs/ai-jobs.ts`,
  `backend/migrations/0008_ai_knowledge.sql`, `backend/seeds/0003_ai_policy.sql`,
  `backend/test/ai/`, `backend/test/unit/chunker.test.ts`,
  `backend/test/unit/generation-output.test.ts`, `backend/test/assessment/builder.test.ts`.

### Platform (`notifications`, `audit_logs`)
- **Status:** 🟡 **Partially built.** `audit_logs` + `AuditService` exist (migration `0002`);
  notifications untouched. No frontend notifications feature.
- **Implemented:** `AuditService.write()` — the only mutating method the service will ever have
  (append-only is a code rule; SQLite cannot express it). Wired into all six staff-auth endpoints
  (including failed logins against unknown emails — NULL `user_id`, IP recorded) and, as of Step 2,
  into every class/roster mutation and **every student join attempt**:
  `STUDENT_CLASS_ACCESS_SUCCESS` / `_FAILED` (with the real `reason`) / `_THROTTLED`. Join-attempt
  auditing is Phase 1 scope in the port (§57 — "not deferred to Phase 6") and is live.
- **Missing:** `NotificationService`, notification endpoints, audit-log viewer (admin), event
  listeners.

---

## API Status

### Implemented endpoints (Worker)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/health` | §53 — CI smoke test + Cloudflare health check |
| POST | `/api/v1/auth/login` | Generic 401 on any bad credential; 403 (with reason) on a non-active account; 429 on lockout |
| GET | `/api/v1/auth/me` | Reachable while `must_change_password` is set |
| POST | `/api/v1/auth/logout` | Revokes exactly the presented token |
| POST | `/api/v1/auth/change-password` | Clears `must_change_password`; revokes **all** sessions |
| POST | `/api/v1/auth/forgot-password` | Always the same acknowledgement; returns the token in the body **only** when `APP_ENV=local` (no email channel exists in v1 — §5, deviation D7) |
| POST | `/api/v1/auth/reset-password` | Single-use, 60-min TTL, revokes all sessions, clears the lockout |
| POST | `/api/v1/student-access/join` | **Public.** Byte-identical 401 on every failure; 429 on the `(code, IP)` throttle; replaces the prior token |
| GET/POST | `/api/v1/counselor/classes` | Nested `data.pagination` (§19 v1.4); an admin sees every class |
| GET/PATCH/DELETE | `/api/v1/counselor/classes/{id}` | 404 (not 403) when the class is not yours; DELETE soft-deletes |
| POST | `/api/v1/counselor/classes/{id}/regenerate-code` | The old code stops working immediately |
| GET | `/api/v1/counselor/classes/{id}/students` | Active roster, ordered by username |
| POST | `/api/v1/counselor/classes/{id}/students/preview` | Proposes usernames, **persists nothing** |
| POST | `/api/v1/counselor/classes/{id}/students/confirm` | Creates the accounts; one collision rejects the whole batch |
| DELETE | `/api/v1/counselor/classes/{id}/students/{studentId}` | `{studentId}` is the **user** id; revokes their live tokens |
| GET/POST | `/api/v1/admin/colleges` | Nested `data.pagination`; each item carries `programs_count`, not the programs |
| GET/PATCH/DELETE | `/api/v1/admin/colleges/{id}` | GET nests programs **and each program's careers**; DELETE soft-deletes **and cascades to the programs** |
| GET/POST | `/api/v1/admin/colleges/{id}/programs` | Unpaginated; `college_id` in the body is ignored |
| PATCH/DELETE | `/api/v1/admin/programs/{id}` | Edited flat, by its own id (§20's asymmetry, mirrored) |
| GET/POST | `/api/v1/admin/careers` | Global, not nested; `typical_riasec_code` validated + uppercased |
| PATCH/DELETE | `/api/v1/admin/careers/{id}` | `status` becomes writable on PATCH |
| POST | `/api/v1/admin/programs/{id}/careers` | 201 with the updated program; duplicate → 422; archived/deleted career → 422 |
| DELETE | `/api/v1/admin/programs/{id}/careers/{careerId}` | **200** with the updated program (not 204); a **real** delete |
| GET/PATCH | `/api/v1/student/profile` | The §27 inputs. Grades bounded **60–100**; `first_name`/`last_name` rejected (`.strict()`), not ignored |
| GET | `/api/v1/student/assignments` | Active assignments in my active enrollments, each with **my** attempt (`null` if unstarted) |
| POST | `/api/v1/student/assignments/{id}/start` | **Idempotent** — a double-tap returns the attempt you already have |
| GET | `/api/v1/student/attempts/{id}` | The player payload: **no dimensions, no option scores** |
| POST | `/api/v1/student/attempts/{id}/answers` | Upsert; the score is **snapshotted server-side**, and a client-supplied one is a 422 |
| POST | `/api/v1/student/attempts/{id}/submit` | Blocks with a **count** while any required question is unanswered; scores **inline** and returns the result |
| GET | `/api/v1/student/results` · `/results/{id}` | `SCORED` attempts only — an expired one never appears |
| GET | `/api/v1/counselor/assessment-templates` | GLOBAL + my own; `ai_generatable` is permanently false for RIASEC/SCCT |
| GET/POST | `/api/v1/counselor/classes/{id}/assignments` | Assign a **PUBLISHED version**, never a template — a draft is a **422**, not a 403 |
| PATCH | `/api/v1/counselor/assignments/{id}` | Closing **expires every in-progress attempt underneath it**, in the same batch |
| GET | `/api/v1/counselor/classes/{id}/results` | Scored attempts across the class |
| POST | `/api/v1/counselor/attempts/{id}/reset` | The §21 retake — **the counselor's, never the student's** |
| POST | `/api/v1/admin/assessment-templates/seed-instruments` | Installs RIASEC + SCCT **through the real builder service**. Idempotent. Not in §20 — deviation D13 |
| GET/POST | `/api/v1/admin/knowledge-documents` | POST is multipart `{ file, extracted_text }` (§33 v1.5 — the browser already extracted); §34 caps enforced server-side; raw file + text sidecar land in R2 |
| DELETE | `/api/v1/admin/knowledge-documents/{id}` | **Archives** (§13.7): `archived_at` set, vectors removed from the index, rows kept. 200 with the archived row |
| POST | `/api/v1/admin/knowledge-documents/{id}/reprocess` | The §42 re-run path (24 h queue retention). Not in §20 — deviation D20 |
| GET | `/api/v1/admin/ai-policies` | The single seeded GLOBAL row; no create/delete endpoint, by design (v1.2) |
| PATCH | `/api/v1/admin/ai-policies/{id}` | `instructions`/`restrictions`/`is_active` only; `scope` is refused (`.strict()`); audited with old+new values |
| POST | `/api/v1/student/recommendations/{id}/explain` | §30 inline. **Always 200**: an existing explanation, a fresh one, or `explanation: null` + the deterministic reason with a typed `failure`. 429 past 10 AI req/min (DO-counted); 404 for a recommendation that is not yours |
| POST | `/api/v1/assessment-templates` | **Phase 5b, shared staff surface** (this and everything below: `ensureRole('counselor','admin')` + per-record ownership — admin any, counselor their own, foreign ids 404). `category` is a schema literal `'CUSTOM'` — a second RIASEC is not a request this API can mean |
| GET | `/api/v1/assessment-templates/{id}` | Template + dimensions + all versions (the builder's working view) |
| POST | `/api/v1/assessment-templates/{id}/dimensions` | §31 Mode B's prerequisite; refused once any version has published (invariant 2) |
| POST | `/api/v1/assessment-templates/{id}/versions` | A new DRAFT version; `scoring_algorithm` defaults to `WEIGHTED_COMPOSITE` |
| GET | `/api/v1/assessment-versions/{id}` | **The author's review payload** — questions WITH option scores and dimension mappings (+ per-mapping confirmed state, + readiness). The exact disclosure the player payload exists to withhold, shown to the person §25 asks to confirm it |
| POST | `/api/v1/assessment-versions/{id}/questions` | The manual editor; MANUAL mappings are confirmed at insert (§25 — a human typed them) |
| PATCH | `/api/v1/assessment-questions/{id}` | Edit text/required during review; DRAFT versions only (invariant 1) |
| POST | `/api/v1/question-dimensions/{id}/confirm` | **The §25 act, one mapping at a time** — sets `confirmed_at`/`confirmed_by`, audited, idempotent; answers with the updated readiness. No bulk form exists (D24) |
| GET | `/api/v1/assessment-versions/{id}/publish-readiness` | `{total, confirmed, remaining}` |
| POST | `/api/v1/assessment-versions/{id}/publish` | The §25 gate: 422 **with the outstanding count** while any mapping is unconfirmed or the version has zero questions |
| POST | `/api/v1/assessment-versions/{id}/ai-generate/document` | §31 Mode A — body `{extracted_text}` (the browser extracted, same §33 utility). **202** + a pre-allocated `ai_request_id`; `authorizeGenerateWithAi` first (RIASEC/SCCT → 403 for every principal incl. admin), DRAFT-only 422, 10 AI req/min 429 |
| POST | `/api/v1/assessment-versions/{id}/ai-generate/description` | §31 Mode B — the template's own dimensions are the target set; none defined = an ungraded draft. Same guards |
| GET | `/api/v1/ai/requests/{id}/status` | The poll: `PENDING` → `DRAFTED` (+count, +inert `suggested_dimensions`) / `FAILED` / `VALIDATION_FAILED`. Someone else's id reports `PENDING`, indistinguishable from one that never existed |

All `/student/*` routes sit behind `authenticate` → `ensureRole('student')`. **`ensurePasswordChanged`
is deliberately absent** — students have no password (§38), so the flag it guards can never be set for
them. Every `/student` route means *mine*, resolved from the token: there is no student id in any URL,
so a route that means "mine" cannot be made to mean "someone else's" by changing a parameter.

All `/counselor/*` routes sit behind `authenticate` → `ensureRole('counselor','admin')` →
`ensurePasswordChanged`, with ownership enforced inside the Service by `policies/class.ts`.

All `/admin/*` routes sit behind `authenticate` → `ensureRole('admin')` → `ensurePasswordChanged`.
**No policy runs inside the catalog Services, deliberately** — see the Academic Catalog module
note. A counselor gets a flat **403** on every catalog endpoint, not a 404 and not a filtered list.

### Contract endpoints the frontend already consumes (the port's minimum bar, ~35)

| Group | Endpoints |
|---|---|
| Staff auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| Student access | `POST /student-access/join` |
| Counselor classes | `GET/POST /counselor/classes`, `GET/PATCH/DELETE /counselor/classes/{id}`, `POST /counselor/classes/{id}/regenerate-code` |
| Roster | `GET /counselor/classes/{id}/students`, `POST …/students/preview`, `POST …/students/confirm`, `DELETE …/students/{studentId}` |
| Admin catalog | `GET/POST /admin/colleges`, `GET/PATCH/DELETE /admin/colleges/{id}`, `POST /admin/colleges/{id}/programs`, `PATCH/DELETE /admin/programs/{id}`, `GET/POST /admin/careers`, `PATCH/DELETE /admin/careers/{id}`, `POST /admin/programs/{id}/careers`, `DELETE /admin/programs/{id}/careers/{careerId}` |
| Student assessment | `GET/PATCH /student/profile`, `GET /student/assignments`, `POST /student/assignments/{id}/start`, `GET /student/attempts/{id}`, `POST /student/attempts/{id}/answers`, `POST /student/attempts/{id}/submit`, `GET /student/results`, `GET /student/results/{id}` |
| Counselor assessment | `GET /counselor/assessment-templates`, `GET/POST /counselor/classes/{id}/assignments`, `PATCH /counselor/assignments/{id}`, `GET /counselor/classes/{id}/results` |

Additional Phase 0–3 contract endpoints documented in `docs/api/` but not yet consumed by any UI:
`POST /counselor/attempts/{attempt}/reset` (the §21 retake), `GET /admin/colleges/{id}/programs`.

### Missing endpoints (beyond the port, from the §20 catalog of ~92)
- Admin: counselor management (4), `PATCH /assessment-templates/{id}`,
  `POST /assessment-versions/{id}/archive`, `GET /audit-logs`, `GET /dashboard`
- Counselor: `GET /students/{id}/results`, `GET /dashboard`
- Student: `GET /dashboard`
- ~~AI generation group, `GET /ai/requests/{id}/status`~~ ✅ built in Phase 5b — minus
  `confirm-all-mappings`, deliberately (D24)
- ~~Assessment templates/versions/publish~~ ✅ built in Phase 5b (shared surface at the API root
  rather than duplicated under `/admin` and `/counselor` — D24)
- Notifications (3)
- `GET /programs/public`

### Incorrect endpoints
None — there is nothing to be incorrect yet. See Deviations for the pagination-envelope nuance.

---

## Database Status

- **Existing tables (applied locally):** the 10 from Steps 1–3 (`users`, `counselor_profiles`,
  `student_profiles`, `audit_logs`, `classes`, `class_students`, `colleges`, `programs`, `careers`,
  `program_careers`) **+ the 11 from Step 4** (`assessment_templates`, `assessment_versions`,
  `assessment_dimensions`, `assessment_questions`, `question_options`, `question_dimensions`,
  `assessment_assignments`, `assessment_attempts`, `assessment_answers`, `dimension_scores`,
  `assessment_results`) **+ the 2 from Phase 4** (`recommendations`, `recommendation_explanations`)
  **+ the 4 from Phase 5a** (`knowledge_documents`, `knowledge_chunks`, `ai_requests`,
  `ai_policies`) — **27 of 28 domain tables** + infrastructure `api_tokens`,
  `password_reset_tokens`. Migrations `0001`–`0008`.
- **Staging D1 carries all migrations 0001–0008** and the `seeds/0003` AI-policy row (verified
  2026-07-15 — both had already been applied in a prior session; `db:migrate:staging` reports
  "No migrations to apply"). Production D1 is provisioned and still untouched.
- **Missing tables:** **1** — `notifications` (Phase 6).
- **`assessment_attempts` uses a PARTIAL unique index**
  (`(assignment_id, student_id) WHERE status <> 'EXPIRED'`), not the plain `UNIQUE` §13.5's prose
  suggests. A plain one would make the §21 counselor reset **impossible** — the expired row still
  occupies the pair, and the retake keeps it as history rather than deleting it. `docs/api/phase-3`
  already calls it "the partial unique index", so this is the contract, not an invention.
- **`program_careers` has no timestamps at all** — §13.3 specifies exactly three columns
  (`id`, `program_id`, `career_id`). Unlike `class_students`, which is an enrollment a real student
  lived through, this row records no event: it is set membership, and unlinking hard-deletes it.
  This is the *second* sanctioned exception to the §12 timestamp rule, and like the first it is in
  the plan rather than a lapse.
- **Non-negotiables when writing the remaining migrations:** UUID v4 PKs, TEXT + `CHECK` for enums
  (no native ENUM), every FK indexed, all v1.2 unique constraints (`(assignment_id, student_id)`,
  `(class_id, username)`, `(attempt_id, dimension_id)`, …), `class_students` deliberately has no
  `created_at`/`updated_at`, `student_profiles.last_name` nullable, no soft deletes on the
  attempt→answer→result chain.
- **Timestamp convention:** application code writes **ISO-8601 UTC strings** (`src/lib/datetime.ts`),
  and the API serializes them straight through. SQLite's bare `CURRENT_TIMESTAMP` renders as
  `2026-07-13 14:11:05`, which JS `new Date()` reads as *local* time — so any hand-written SQL that
  inserts a row must use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, as `seeds/0001` does. The
  `DEFAULT (CURRENT_TIMESTAMP)` clauses in the migrations are effectively dead (every insert sets
  its timestamps explicitly) and were left alone rather than editing an applied migration.

### Seeded accounts (`npm run db:seed` — now runs the staff **and** catalog seeders)

| Email | Role | Seeded password | Note |
|---|---|---|---|
| `admin@careerlinkai.online` | admin | `ChangeMe123` | `must_change_password = 1` |
| `counselor@careerlinkai.online` | counselor | `ChangeMe123` | `must_change_password = 1` |

The hashes are committed, so these credentials are public — acceptable **for a local database only**,
and only because the first login forces a rotation.

> **There is no `db:seed:remote` any more, and that is deliberate.** A committed hash is a published
> credential. Seed a **remote** database with
> `node scripts/bootstrap-staff.mjs --database <NAME> --env <staging|production> --verify-url <API>`,
> which derives its hashes at run time from a generated password, prints that password **once**,
> writes nothing to the repository, and then **logs in against the live deployment to prove the
> hash actually opens the account**.

> ⚠️ **These hashes have now been wrong twice, and this table has lied twice.** First they encoded
> the rotated dev passwords rather than `ChangeMe123` (found in the browser pass); then they encoded
> a *single-call* 600,000-iteration derivation, which the fixed `crypto.ts` no longer produces and
> the Cloudflare runtime never accepted (found in Step 5). They are now written at **100,000
> iterations** (D14) and verified. **If you change a hash in that file again: seed an empty database
> and _log in_ to prove it.** Do not trust the comment — that is what the comment said last time.

> **The local database was re-bootstrapped in Step 5** (the old rows' hashes were unverifiable under
> the fixed KDF). Local dev credentials are now **`ChangeMe123` for both accounts, with
> `must_change_password = 1`** — i.e. exactly what a fresh `db:seed` gives you, and exactly what
> `scripts/walkthrough.mjs` expects to start from. The previous `TestAdmin@01` / `TestCounselor@01`
> rotated passwords **no longer exist**. Reset at any time with
> `node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --local --password ChangeMe123`.

### Seeded catalog (`npm run db:seed:catalog`)

5 Philippine institutions, 16 programs, 10 careers, 24 mappings — **real rows, not faker output**,
and idempotent (fixed UUIDs + `INSERT OR IGNORE`, so re-running never duplicates it).

It is real for two reasons. It is what a thesis panel is shown, and a catalog of invented
universities undercuts the demo. And **§27's worked example scores BS Computer Science through
Software Engineer (`IEC`) and Data Analyst (`ICE`)** — those exact rows exist, with those exact
Holland codes and that exact mapping, so Phase 4's engine can be checked against a number computed
by hand. **Do not add a third career to UP Diliman's BSCS without recomputing that example.**

The data deliberately covers all three strand cases, because uniform data would never exercise
§27's strand branch: `Academic` programs, `Technical-Professional` ones (Mapúa's BSIT and BSCPE),
and one with **no requirement at all** (Ateneo's AB Communication), which §27 must score as a full
100 rather than as a missing value. Ateneo's BS Management is deliberately left **unmapped**, so the
neutral-50 fallback has a row too.

---

## Frontend Status

Type-checks clean (`tsc --noEmit`) · 35/35 tests passing (Vitest + RTL) · builds to `dist/`.

### Completed pages
- **Auth:** LoginPage (tested), ChangePasswordPage, ProtectedRoute with `must_change_password`
  gate and role-aware sign-in redirect, RoleHome
- **Student:** StudentAccessPage (tested — no password field, generic errors), StudentDashboardPage,
  StudentProfilePage (strand 2-value selector, GWA/grades), AssessmentListPage,
  AssessmentPlayerPage (tested — asserts no dimension/score leakage), ResultListPage,
  ResultPage (tested — absent dimension ≠ zero)
- **Counselor:** CounselorDashboardPage, ClassListPage, ClassDetailPage, CreateClassForm,
  JoinCodeCard, RosterBuilder (tested — preview/edit/confirm), RosterTable, AssignmentPanel
- **Admin:** AdminDashboardPage, CollegeListPage, CollegeDetailPage (nested programs),
  CareerListPage, CareerForm (tested), CareerMapping (tested), CollegeForm, ProgramForm,
  **KnowledgeListPage, AiPolicyPage** (Phase 5a)
- **Infrastructure:** httpClient (envelope unwrap, 401 auto-signout), 6 service modules,
  authStore (token-only persistence), studentClassStore, 5 layouts + shared StaffLayout

### Missing pages (by phase)
- **Phase 3.5:** none — the frontend is the port's invariant. Only `.env` changes
  (`VITE_API_BASE_URL` → the `wrangler dev` URL, e.g. `http://localhost:8787/api/v1`).
- **Phase 4:** ✅ done — student recommendations screen; counselor individual-student view.
- **Phase 5a:** ✅ done — `KnowledgeListPage` (upload with **browser-side extraction** —
  `features/admin/utils/extractText.ts`, pdf.js + mammoth as dynamic imports so only an admin
  ever downloads them — plus list/archive/reprocess, polling while anything is in flight),
  `AiPolicyPage` (the two-field editor), and `ExplainMore` on every recommendation card
  (the fallback is a stated non-error: the deterministic reason stands when the AI cannot answer).
- **Phase 5b:** ✅ done — the `assessment-builder` feature (TemplateListPage +
  TemplateBuilderPage under `features/assessment-builder/`, mounted in **both** the admin and
  counselor shells with an "Assessments" nav item; ownership is server-side, so the pages are
  shared rather than duplicated). One page carries the whole §31 flow — dimensions → DRAFT
  version → questions (typed, or drafted from a description / an extracted document, reusing the
  §33 `extractText` utility) → the review list (option scores + mapping chips, **one Confirm
  button per mapping, no bulk approve**) → publish-readiness → publish. Generation status polls
  every 4 s while PENDING and invalidates the review on DRAFTED. The builder/generator split of
  §35 is folded into one feature folder — recorded under D4's reasoning (file organization, zero
  behavior).
- **Phase 6:** notifications feature (list, read/unread), audit-log viewer, real dashboard data
  (all three dashboards are currently shells), admin counselor-management screens.
- **Unassigned (small):** forgot/reset-password screens; counselor attempt-reset button (§21 —
  contract endpoint exists, no UI).

### Components needing fixes
None found. Two structural notes tracked under Deviations (feature-folder layout; `hooks/` vs
`api/` folder naming).

---

## Backend Status

Gate as of Phase 5b: **`tsc --noEmit` clean · ESLint clean · platform gates green (config shape ·
DO boundary · bundle 198 KiB/2.5 MB) · 477/477 Vitest tests passing in workerd**
(270 at the end of Step 3 → 307 with the §27 formula core → 371 with Step 4 → 375 with Step 5's
PBKDF2 platform-cap guards → 394 with Phase 4 → 404 with Phase 4.5 → 446 with Phase 5a → **477**
with Phase 5b).
**Enforced by CI on every push** (D9 resolved), and the CI backend job now also runs
`gate:platform` + `gate:bundle` (Phase 4.5 Step 2).

⚠️ **A green gate is necessary and not sufficient, and Step 5 proved it the hard way.** Miniflare is
not Cloudflare: it enforces neither the runtime's PBKDF2 iteration ceiling nor any CPU limit, and
this gate was green over a Worker whose staff login was **completely broken on the edge**. The four
tests added in Step 5 assert on *what the code asks of the platform* (`deriveBits` is spied on and
its `iterations` asserted) rather than on what the local runtime returns — because locally there is
no wrong answer to catch.

- **Completed services:** `StaffAuthenticationService`, `StudentAccessService`, `ClassService`,
  `ClassEnrollmentService`, `AcademicCatalogService`, `AuditService`, `AssessmentBuilderService`,
  `AssessmentAttemptService`, `ScoringService`, `StudentProfileService`, `RecommendationService`,
  **`AiGatewayService`, `RetrievalService`, `KnowledgeIngestionService`, `ExplanationService`,
  `AiPolicyService`, `AssessmentGenerationService`** (Phase 5b) — plus the `AuthGuardDO`
  Durable Object (Phase 4.5).
- **Missing services:** `NotificationService` (Phase 6).
- **Completed middleware:** `correlation-id`, `authenticate` (token-hash lookup, expiry,
  active-status), `ensure-role`, `ensure-password-changed`. **`middleware/rate-limit.ts` is gone**
  (Phase 4.5): the failures-only counters live in `AuthGuardDO`, addressed through the helpers in
  `lib/auth-guard.ts` — still functions a Service calls, never a `use()` middleware, because
  "count a failure" and "read the count" remain separate operations.
- **Completed policies:** `class.ts` (ownership; 404 rather than 403 so "not yours" and "not real"
  are indistinguishable); **`assessment.ts`** — incl. the `generateWithAi` first-check category
  exclusion, its throwing form `authorizeGenerateWithAi` (Phase 5b: category → **403** with the
  permanent-rule message, ownership → 404), `authorizeManageTemplate` (the builder's ordinary
  role-plus-ownership), and the no-admin-branch `answerAttempt` rule; **`recommendation.ts`**
  (Phase 4). **The catalog has none, deliberately** — §39 names three policies and no catalog
  one; see the Academic Catalog module note.
- **Events/jobs:** the dispatcher carries **two of the four §60 events** — `AssessmentCompleted`
  (fires from submit; `DispatchRecommendationGeneration` listens) and, since 5a,
  `RecommendationGenerated` (fired by that listener after a successful generation;
  `enqueueExplanationGeneration` listens and sends the queue's **first real message**). The
  `queue()` consumer dispatches three jobs (`src/jobs/ai-jobs.ts`): `ProcessKnowledgeDocument`,
  `GenerateEmbeddingBatch`, `GenerateStudentExplanations` — ack on success, mark-FAILED + retry on
  error, warn-and-ack for unknown types.
- **Since Phase 5b:** the dispatcher carries a third event, `AssessmentDraftGenerated` (fired by
  the job, zero listeners — the "notify the creator" listener is Phase 6's, and this is its
  seam), and the consumer dispatches a fourth job, `GenerateAssessmentDraft`. **A generation
  failure inside the job is absorbed, never rethrown** — the FAILED `ai_requests` row *is* the
  outcome, and a queue retry into a dead quota cannot succeed (§30 v1.5).
- **Missing events/jobs:** `KnowledgeDocumentProcessed` (exists only to notify — Phase 6).
- **Missing AI features:** none — both §30 and §31 pipelines are built.
- **Project plumbing:** ✅ done — `package.json`, `tsconfig.json`, `vitest.config.ts` (workerd pool),
  `eslint.config.js` + `.prettierrc.json`, `migrations/`, `seeds/`, `test/`, and a `wrangler.toml`
  that matches §48 (deviation D2 resolved). **Still missing: CI (§47) — no `.github/workflows/`
  exists (deviation D9).**

### Implementation notes worth carrying into Step 3

- **D1 has no interactive transactions.** `db.transaction()` is unavailable on the D1 driver;
  atomicity comes from **`db.batch([...])`**, which runs the statements in one implicit transaction.
  `confirmEnrollment()` uses it so a roster can never be half-provisioned. Any future multi-row
  write (a college with its programs, an assessment version with its questions) must do the same.
- **Two serializers for one table is a feature, not duplication.** `serializeClass` (counselor —
  carries the join code) and `serializeClassSummary` (student — does not) are separate allow-lists
  rather than one function that deletes fields on the way out. An allow-list cannot leak a column
  someone adds next year; a deny-list can.

---

## Deviations From Master Plan

| # | Current implementation | Expected (FULLPLAN) | Recommendation |
|---|---|---|---|
| D1 | **Laravel backend removed before the port exists**, so its 233-test suite is unrecoverable | §57 Phase 3.5: Laravel is archived/removed only *after* the full walkthrough passes on staging; its 233-test suite is the port contract | **Ratified:** FULLPLAN + `docs/api/*.md` + the frontend services/types/tests are the port contract. The tree is now a git repo (`main`). For Phase 0 auth, where no `docs/api` file exists, `backend/test/auth/` is now the executable record of the contract. The port's own suite stands at **141 tests** against the original's 233 (which covered all of Phases 0–3, i.e. roughly twice the scope built so far). |
| D2 | `wrangler.toml` bindings: `DOCS` (R2), single `MAIN_QUEUE`, **no KV**, no `[vars]`, no environments | §16/§48: `STORAGE`, `QUEUE_DEFAULT` + `QUEUE_AI`, `KV`, the six `[vars]`, two named environments | ✅ **Fully resolved in Step 5.** `wrangler.toml` matches §48 *and* staging's resources now exist (its own D1, KV, R2, Vectorize index, two queues), with `[env.staging]` carrying the full binding set — Wrangler environments inherit no bindings, so an omitted one is simply `undefined` at runtime rather than a deploy error. **The `KV` id was a placeholder (`0000…ffff`) until Step 5**, and nothing local reads KV through it (Miniflare emulates it), so the first thing that would ever have caught it was the deploy. |
| D3 | Pagination lives inside `data` as `{ items, pagination: {…} }` (frontend `Paginated<T>`, `docs/api` contract) | §19 *(pre-v1.4)*: list responses carry `meta.current_page / total / last_page` | ✅ **Resolved — ratified in FULLPLAN v1.4** (§19 corrected + revision note). The nested `data.pagination` shape is canonical; `GET /counselor/classes` now serves it and a test pins it. |
| D4 | Student-access page and assessment player live under `features/student/`; no `student-access/` or `assessment-player/` feature folders | §35 lists them as separate features | **Accept for now.** Pure file organization, zero behavior. Split the player into its own feature when Phase 5b's builder/generator make `features/student` crowded. |
| D5 | TanStack Query hooks live in `features/*/hooks/` | §35 (v1.2, F-L4): feature `api/` folders own the Query hooks | **Accept (cosmetic).** The actual F-L4 rule — components → hooks → `src/services/` clients, one home per concern — is followed everywhere. Folder name differs; ratify or rename opportunistically. |
| D6 | `frontend/.env`/`.env.example` pointed at the retired Laravel API (`:8000`) | v1.3: the API is the Worker (`wrangler dev`, default `http://localhost:8787`) | ✅ **Resolved in Step 1.** Both files now point at `http://localhost:8787/api/v1`. This was the only frontend change the port permits. |
| D7 | Forgot/reset-password **endpoints exist**; no UI, and **no email channel exists** to deliver a reset link (§5 defers email entirely) | §20 lists the endpoints; §37 implies the screens for staff | 🟡 **Partially resolved.** The endpoints are ported and tested. Because v1 has no mail provider, `/auth/forgot-password` returns the token in the response body **only when `APP_ENV=local`**; in staging/production the reset is completed out of band by an admin. Add the UI — and a real delivery channel, or an explicit admin-driven reset flow — in Phase 6. **This is the honest shape of the feature, not a finished one.** |
| D8 | No counselor attempt-reset UI | §21 retake = counselor-initiated reset; contract endpoint documented | Port the endpoint in Step 4 (it is Phase 3 scope); add the button to ClassDetailPage results in Phase 4/6 polish. |
| D9 | **No CI pipeline.** §47 assumes GitHub Actions running the test suite + `tsc` + ESLint on every push | §47 | ✅ **Resolved in Step 5.** `.github/workflows/ci.yml` runs both gates on every push and PR: backend (`type-check` · `lint` · 375 tests in workerd) and frontend (`type-check` · 35 tests · `build`). It needs **no Cloudflare credentials** — that is what `wrangler.test.toml` bought. **Read the header comment before trusting a green tick:** Miniflare is not Cloudflare, and this gate was green 371 times over a Worker that could not verify a password on the edge (D14, D15). |
| **D14** | ~~Password hashing runs at 100,000 PBKDF2 iterations~~ **Derivation runs at the full 600,000, inside `AuthGuardDO`** (`src/do/auth-guard.ts`) | §38 pins **600,000** | ✅ **Closed in code by Phase 4.5 Step 1** — at zero cost and zero security compromise: the DO gets a 30-second CPU budget per invocation on every plan including Free, vs the Worker's unraisable 10 ms that forced the 100k concession. No stored password broke: the cost is recorded inside every hash, so D14-era 100k hashes keep verifying at their own cost (a test pins this) while every new hash is written at 600k. The platform gate asserts `deriveBits` is called nowhere outside the DO, so the derivation cannot silently migrate back onto the 10 ms budget. **Fully closed 2026-07-15 by the staging exit demo:** four consecutive `/auth/change-password` calls (the double-derivation canary that died with error 1102 pre-4.5) all answered 200 in ~2 s each on the live deploy; the rotated hash reads `pbkdf2$600000$` in staging D1; a pre-4.5 100k hash still opened through the DO. |
| **D19** | ~~The staff lockout and join throttle are KV-backed~~ **All three security counters (lockout, join throttle, the §41 AI request limit) are `AuthGuardDO` instances** | FULLPLAN **v1.5** §38/§41: security counters live in `AuthGuardDO` — KV is caching-only | ✅ **Closed by Phase 4.5 Step 1**, in the same change as D14 — the DO that derives a staff account's hash is the DO that counts its failures, so the count is exact and brute force per account is serialized (`blockConcurrencyWhile`). `middleware/rate-limit.ts` is deleted; KV stays bound for future caching and nothing security-relevant touches it. Semantics unchanged: failures-only charging, same thresholds, same windows, fixed (not sliding) windows. |
| **D15** | **PBKDF2 is derived as a *chain* of ≤100,000-iteration rounds**, each keyed on the previous round's output, rather than one call | §38 implies a single PBKDF2 invocation | **Ratified — forced by the platform, and it costs nothing.** The Workers runtime *refuses* PBKDF2 above 100,000 iterations per `deriveBits()` call (`NotSupportedError: iteration counts above 100000 are not supported`). Miniflare does not enforce this, so a single 600,000-iteration call passed 371 tests and 500'd on the edge. The chain performs the full requested work — a round cannot be parallelised or skipped, because it is keyed on the one before it — so the work factor is preserved exactly; only the syscall count changes. At or below the cap it collapses to a single call, so such a hash is an ordinary PBKDF2 hash and stays verifiable as one. |
| **D16** | **`frontend/public/_redirects`** — a new file in `frontend/` | §57 makes the frontend the port's invariant: no changes beyond `VITE_API_BASE_URL` | **Accept.** Cloudflare Pages answers `/login` with its own 404 without an SPA fallback rule, so the deployed app never boots — the walkthrough cannot even reach the first screen. It is a **deployment artifact**, not a React change: no component, service, hook or type is touched, and the invariant's purpose (the port must satisfy the frontend, not the other way round) is untouched by it. |
| D11 | **The Phase 3 screens render a failed request as an empty one.** `StudentDashboardPage`, `AssessmentListPage`, `ResultListPage`, `StudentProfilePage` and `AssignmentPanel` have no `isError` branch — a student whose assignments 404 is told "Nothing to do yet". Found in the browser pass. | §37 implies a student can tell "nothing assigned" from "we could not load your assignments" — and the Phase 0–2 screens (`ClassListPage`, `CollegeListPage`) already do | ✅ **Resolved in Phase 4.** All five screens have an `isError` branch, and — the part that actually mattered — every empty state is now gated on the data having *arrived* (`assignments && assignments.length === 0`), not on `(assignments ?? []).length === 0`. **An undefined list is not an empty list.** `StudentProfilePage` goes further and refuses to render the form at all on a failed load: an empty form that a student re-fills and submits is not a misleading screen, it is a data-loss bug wearing a UI. The new recommendations screen was built with the same rule from the start, and `GET /student/recommendations` answers **200 with `data: null`** rather than 404 precisely so the three states stay distinguishable. |
| **D17** | **`DispatchRecommendationGeneration` generates inline**, inside the submit request | §11: the listener dispatches a **queued** `GenerateRecommendationJob` | **Ratified, with the reason stated.** §27 is pure arithmetic over a catalog of a few hundred rows, plus ~10 D1 reads and one batched write. A queue would add a round trip, a second Worker invocation, and an *observable window* in which the student's result screen exists and their recommendations do not — in exchange for deferring work that takes milliseconds. The `queue()` handler is wired and idle; the first job that genuinely earns it is Phase 5a's AI explanation, which calls a model and has a real latency budget to escape (§30's 8 s target). Revisit if the catalog grows to where the ranking no longer fits comfortably inside the submit's CPU budget — **and note that budget is a _Free-plan_ budget (D14), which is the thing most likely to force it.** |
| **D18** | **The `recommendations` insert is chunked** into ≤9-row statements (`chunkForD1`) | Nothing in FULLPLAN contemplates it | **Forced by the platform, and not optional.** D1 refuses a query binding more than **100 parameters**. A `recommendations` row binds 10 columns and a full §27 set is 20 rows (top 10 careers + top 10 programs), so the natural single-statement insert binds **200** and D1 rejects it outright. This shipped: the listener threw on every generation, `dispatch()` swallowed it exactly as designed, and students got correctly scored assessments with **empty recommendation screens**. Miniflare's SQLite allows 999 bindings — *and* the test catalog is too small to have built a 20-row insert in the first place — so the local suite was blind to it twice over. `test/recommendation/d1-limits.test.ts` now pins the **question asked of the platform** rather than the answer the local runtime happens to give. |
| D12 | **`assessment_dimensions.order_number` exists**, though §13.4's column list omits it | §13.4 lists 7 columns and no `order_number` | **Ratified.** FULLPLAN is *silent* here, not contradictory: §24's engine tie-breaks on `dimensions.canonical_order` and §22 pins that order as `R > I > A > S > E > C`, but no column carries it. `docs/api/phase-3` specifies the column and states why. It is **scoring data, not a display preference** — without it, a student with I = A = 71.0 gets whichever row the database returned first, and their Holland Code becomes a fact about row ordering rather than about them. |
| D13 | **`POST /admin/assessment-templates/seed-instruments`** — an endpoint not in §20's catalog | §20 catalogs ~92 endpoints; this is not one | **Accept, with the reason stated.** §57 requires the RIASEC/SCCT seeders to publish **through the real `AssessmentBuilderService`**, so they pass the same confirmation gate a counselor does — a `.sql` seed writing `status = 'PUBLISHED'` would appear to prove the gate works while demonstrating exactly how to bypass it. But **a D1 binding only exists inside the Worker**: there is no offline Node script that can call a Worker service against the real database, the way `php artisan db:seed` could. So the seeder is reached the only way a Worker's own code can be — over HTTP. It is **admin-authenticated rather than `APP_ENV`-gated**, which is the safer of the two: an env guard fails *open* if the variable is ever misconfigured in production. It is also a defensible thing for an admin to do (§4 — RIASEC/SCCT are globally-curated content the admin owns), and it is idempotent. |
| D10 | **Staff tokens expire after 7 days** (`STAFF_TOKEN_TTL_HOURS = 24 * 7` in `lib/config.ts`) | `docs/api/phase-1` §"Token lifecycle" states staff tokens expire **"never — until logout"**; FULLPLAN §38 pins an expiry only for *students* | **Accept — the port is stricter than the contract, deliberately.** A never-expiring bearer token on a counselor account that can read every student's results is a worse default than a week-long one, and the frontend already signs itself out cleanly on any 401 (`httpClient` interceptor), so a lapsed token degrades to "log in again" rather than to a broken screen. Flagged here rather than silently: if the 7-day window annoys counselors in practice, raise the constant — do not remove it. |
| **D20** | **`POST /admin/knowledge-documents/{id}/reprocess`** — an endpoint not in §20's catalog | §20 lists three knowledge endpoints (GET/POST/DELETE) | **Accept, same shape as D13.** §42 v1.5 *requires* every job to be "idempotent **and manually re-triggerable**" because Free-plan queues retain messages for only 24 hours — a processing job that was never consumed is simply gone, and an admin cannot act on "wait for the retry". A requirement without an endpoint is a requirement without an implementation; this is that endpoint. Admin-authenticated, audited, refuses archived documents (they must never re-enter the index). |
| **D21** | **The §32 prompt is a `.ts` module** (`src/prompts/recommendation-explanation.v1.ts`), not a `.md` file | §32: prompts are "versioned as files in the repository (`src/prompts/recommendation_explanation.v1.md`…)" | **Accept (mechanical).** The substance of §32 — the prompt text verbatim, versioned in Git, a new version being a new file, `ai_policies` as the sole runtime injection — is all kept. A `.md` *asset* import would need a `[[rules]]` text-module entry in every wrangler config plus matching handling in the Vitest pool; a template-literal module buys the identical artifact with none of that. Rename to `.md` if the rules plumbing is ever added for other reasons. |
| **D22** | **The queued explanation job pre-explains only the two rank-1 matches** (one career, one program) per generation; the message carries the student id and the consumer resolves the current rank-1 rows at run time | §43's `GenerateExplanationJob` is per-recommendation and §30's diagram implies explaining what was generated | **Accept, with the arithmetic stated.** The Free plan's neuron quota funds ~150–200 explanations/day (§45). A full §27 set is 20 cards; pre-explaining all of them caps the system at ~10 students/day and burns quota on cards most students never scroll to. Two proactive + on-demand for the rest ("Explain more", already built) keeps the demo grounded and the quota alive. Resolving rank-1 at *consume* time (not enqueue time) is what makes the job meaningful whenever it runs within the 24 h retention window, and redelivery free — an explained recommendation is skipped by §20's "if not already generated". |
| **D23** | **`WORKERS_AI_TEXT_MODEL` is `@cf/meta/llama-3.1-8b-instruct-fp8`** | §29/§45 name `llama-3.1-8b-instruct` (the base model) | **Forced by the platform, found live on the 5a exit demo (platform fact #4).** Cloudflare deprecated the base model on **2026-05-30**; every call fails server-side with error 5028, with no deploy on our end and nothing a local test could see (the suite stubs the gateway, as §49 requires). The §29 posture held through the outage — every student got a 200 + the deterministic reason, and the FAILED `ai_requests` rows named the cause. The fp8 variant is the same 8B model quantized to fp8, currently in the catalog; the fix was a one-var edit precisely because §29 made the model a config value. Watch the lifecycle page before the defense demo. |
| **D24** | **The Phase 5b endpoint group differs from §20's sketch in three ways:** (1) there is **no `confirm-all-mappings`** endpoint; (2) the builder/generation group mounts **once at the API root** (shared, per-record ownership) rather than appearing under both `/admin` and `/counselor`; (3) it adds endpoints §20 never listed — `GET /assessment-templates/{id}`, `POST …/dimensions`, `GET /assessment-versions/{id}` (the author's review payload), `POST …/questions`, `PATCH /assessment-questions/{id}` — and Mode A's body is `{extracted_text}` JSON rather than a multipart upload | §20 lists `confirm-all-mappings` ("bulk-confirm convenience helper"), sketches the group under `/api/v1/assessment-templates/{id}`, and says "multipart upload — PDF/DOCX" for Mode A | **(1) is a genuine FULLPLAN self-contradiction, resolved toward §31**, which forbids exactly that helper in so many words ("no 'approve all' shortcut … the entire point of the gate is that a human actually looked at each dimension assignment") — the specific rule with its rationale beats the endpoint list's sketch. **(2) follows §20's own flattening style** (`/assessment-versions/{id}/publish` is already flat in §20) and avoids two URLs for one resource; role gate + per-record 404 policy carry the whole rule, and the authorization test hits it from both roles. **(3) is the §31 review step made real** — a review UI cannot review what no endpoint serves; the additions are the minimum surface the flow §31 *does* specify requires. Mode A's JSON body follows §33 v1.5's own logic: extraction already happened in the browser, and unlike knowledge ingestion there is no provenance requirement on the generation source (§31 stores provenance as `source_ai_request_id` on every question instead); the raw file adds R2 writes for a document that is never re-read. |

---

## Completed Port Steps

### Phase 3.5 · Step 1 — Worker scaffold + staff auth ✅

Repo hygiene (git), the `backend/` scaffold, `wrangler.toml` to §48 spec (D2), the app skeleton
(§16/§17) + `GET /health`, migrations `0001`/`0002`, the §38 crypto lib, the token service, the four
middleware, `StaffAuthenticationService` + all six auth endpoints, the KV lockout, the staff seeder,
and the frontend `.env` rewire (D6).

**Exit demo — verified against a live `wrangler dev`:** both seeded staff roles sign in with the temp
password; `GET /auth/me` works while `must_change_password` is set; rotating the password clears the
flag and revokes the pre-rotation session (401); the new password works and the temp one no longer
does; CORS preflight from `http://localhost:5173` is accepted.

### Phase 3.5 · Step 2 — Class & Enrollment + student access ✅

Migration `0003`; `ClassService` (CRUD, join-code lifecycle, regeneration); `ClassEnrollmentService`
(preview → edit → confirm, removal + token revocation); `StudentAccessService` +
`POST /student-access/join`; `policies/class.ts`; `lib/slugify.ts`; the `(code, IP)` join throttle;
class/roster/join audit logging; the first real mount of `ensureRole` and `ensurePasswordChanged`.

**Exit demo — verified against a live `wrangler dev`:** counselor logs in → rotates the temp password
→ creates a class (`MYGY-4458`, expiring in 90 days) → pastes four names including a duplicate, an
accented name and a mononym → preview returns `juan.delacruz`, `juan.delacruz2`, `jose.pena`,
`madonna` → counselor edits one username → confirm creates the accounts → the student joins with just
the code and username → the response leaks **neither `join_code` nor `counselor_id`** → a wrong
username and a wrong class code return **byte-identical 401s** → the counselor removes the student →
**their already-live session dies immediately (401)**, and they cannot re-join. The audit log for the
same run shows `UNKNOWN_USERNAME`, `INVALID_CODE` and `ENROLLMENT_REMOVED` — the reasons the API
refused to give.

> ~~**Still open from Step 1:** the **frontend-in-a-browser** pass.~~ ✅ **Done — see "Browser
> integration pass" below.** It was worth doing: it found a real bug that neither test suite could
> have caught.

### Phase 3.5 · Steps 1–3 — Browser integration pass ✅

The check that had been outstanding since Step 1: the React app and the Worker had never been run
against **each other**, only against their own test suites. Driven in a real Chromium (Playwright,
against the system Chrome — see the toolchain note below), one browser session per role, with every
API call, console error and uncaught exception recorded.

**23/23 checks passed · 0 uncaught errors · 0 5xx responses · 39 API calls across 23 endpoints.**

The harness is committed at **`scripts/browser-walkthrough.mjs`** (+ `scripts/walkthrough-fixture.sql`)
with its run instructions in the file header — **Step 5's exit criterion is a full Phase 0–3
walkthrough**, so it is a script to extend, not a one-off to rewrite.

Verified end to end, through the unchanged frontend:

- **Staff auth:** a temp password lands on `/change-password` and opens nothing else; rotating it
  revokes the session and drops the user back to `/login`; the old password is dead; the new one
  signs in with the gate cleared.
- **Class + roster:** class created, join code rendered (`YTWA-8438` — and it contains no `I`, `O`,
  `0` or `1`); paste of four names including a duplicate, an accented name and a mononym previews as
  `juan.delacruz` / `juan.delacruz2` / `jose.pena` / `madonna`, with the mononym's last name empty;
  preview persists nothing; the counselor edits a username and **confirm creates the edited one**.
- **Student access:** a wrong code returns the generic 401 (`The class code or username is
  incorrect.`); the real code + username signs the student in; **the join response carries no
  `join_code` and no `counselor_id`**, and the code never appears anywhere in the student UI.
- **Admin catalog:** college → program (nested) → career → program↔career mapping, all through the
  UI. `iec` typed into the RIASEC box is **stored as `IEC`**.

**The payload/type contract holds.** Every serialized response satisfied the React types in practice;
no page needed a single frontend change (§57's invariant survives).

#### What the pass found

1. **🐛 `seeds/0001_staff_accounts.sql` did not contain the password it documented.** The two
   committed hashes were the PBKDF2 hashes of **`TestAdmin@01` / `TestCounselor@01`** — the *rotated*
   local dev passwords — while every comment in the file, and this document, said `ChangeMe123`. A
   fresh `db:seed` into an empty database therefore landed accounts nobody had the documented
   password for. **Fixed:** both hashes regenerated for `ChangeMe123` and verified end to end
   *through the Worker's own WebCrypto* (not just re-derived in Node), which is the check whose
   absence let it drift. **Nothing could have caught this**: no test seeds a fresh database and then
   logs in — the suite builds its own fixtures — so the seed file is the one place in the system
   where a credential is *asserted* rather than computed, and it was wrong. This would have surfaced
   as an unopenable admin account at the **Step 5 staging bootstrap**.
2. **The five Phase 3 endpoints 404, as expected** (`GET /student/profile`, `/student/assignments`,
   `/student/results`, `/counselor/assessment-templates`,
   `/counselor/classes/{id}/assignments`). This is exactly Step 4's scope and nothing else 404s.
3. **⚠️ Every Phase 3 screen renders a failed request as an empty one.**
   `StudentDashboardPage` shows **"Nothing to do yet — Your counselor will assign you an
   assessment"** while `GET /student/assignments` is returning **404**. It has no `isError` branch;
   neither do `AssessmentListPage`, `ResultListPage`, `StudentProfilePage` or `AssignmentPanel`.
   The Phase 0–2 screens (`ClassListPage`, `CollegeListPage`) *do* handle it. Harmless today — the
   endpoints genuinely do not exist — but the moment Step 4 lands, **a student whose assignments
   fail to load is told they have none**, which is the one screen where that lie matters. It is a
   frontend change, so it is *not* a port bug and cannot be fixed under §57's invariant: do it in
   Phase 4/6 polish, and do not let Step 4 ship without it being on the list. (Tracked as D11.)

---

### Phase 3.5 · Step 4 — Assessment Engine ✅

Migrations `0005`/`0006` (11 tables); `lib/scoring.ts` (the pure §24 engine) + `ScoringService`;
`AssessmentBuilderService` (version immutability, the dimension freeze rule, the publish gate);
`AssessmentAttemptService`; `StudentProfileService`; `policies/assessment.ts`; the in-process event
dispatcher + `AssessmentCompleted`; the `/student` route group; and the RIASEC (60 q) / SCCT (30 q)
instruments, published **through the real builder service**.

**Gate: `tsc` clean · ESLint clean · 371/371 tests** (270 → 307 with the §27 core → 371).

**Exit demo — verified in a real Chromium against a live `wrangler dev`, 18/18 checks, 0 5xx, 0 API
4xx** (`scripts/step4-player-walkthrough.mjs`): a counselor assigns RIASEC to a class → the student
signs in with **only** a class code and username → the dashboard shows the assignment (and **not**
"Nothing to do yet" — the D11 trap) → the player serves 60 items carrying **no dimension and no
option score**, but *does* carry `section_label` → the student answers all 60 through the UI, each
one POSTed and accepted → submit **scores inline and returns the result in the same response** →
the Holland Code is **`IAR`**, with Investigative at exactly **100.00 / "High Interest"** — the value
computed by hand before the run — and the result screen renders the code and the per-dimension
breakdown.

> **The five endpoints that 404'd through Steps 1–3 now all answer 200.** That was the check that
> mattered: every Phase 3 screen renders a failed request as an *empty state* (D11), so a
> half-working Step 4 would have looked exactly like a working one. The walkthrough asserts on the
> API calls and the rendered text, not on the absence of a red banner.

---

### Phase 3.5 · Step 5 — Staging deploy + the full Phase 0–3 walkthrough ✅

Staging's own resources provisioned (D1 `CareerLinkAI_Staging`, KV, R2 `careerlinkai-docs-staging`,
Vectorize `careerlinkai_staging_knowledge`, two queues); `[env.staging]` given the full binding set;
the **placeholder KV id replaced with a real one** (D2); migrations 0001–0006 applied `--remote`;
the Worker deployed as `careerlinkai-staging`; the frontend built against it and deployed to
Cloudflare Pages; CI wired (D9); and the two walkthrough scripts merged into one
**`scripts/walkthrough.mjs`** that takes `--app` / `--api` and therefore proves *any* environment.

**Exit demo — the §57 Phase 0–3 walkthrough, run against the live staging deployment: 47/47 checks,
0 5xx, 0 uncaught errors, 113 API calls.** One continuous run: an admin activates their account
through the forced-rotation gate, installs RIASEC/SCCT **through the real builder service** (D13),
and builds a college → program → career → mapping; a counselor activates, creates a class
(`ZUSZ-8338`), provisions a roster from four pasted names (a duplicate, an accented name and a
mononym), edits a username before any account exists, and assigns RIASEC; a student signs in with
**only** a class code and a username, sees the assignment (and **not** "Nothing to do yet" — the D11
trap), answers 60 items through the UI, and submits — scored **inline**, Holland Code **`IAR`**,
Investigative at exactly **100.00 / "High Interest"**, the value hand-computed before the run. The
only three 4xx responses in the entire run are the three the script *asks* for: two dead temporary
passwords and one wrong class code.

#### What the pass found — and it is the most important thing the port produced

**A Worker that passed 371/371 tests locally could not verify a single staff password on
Cloudflare.** Two runtime limits, **neither enforced by Miniflare**, were invisible to every test:

1. **🐛 PBKDF2 is capped at 100,000 iterations per `deriveBits()` call.** §38 asks for 600,000 in
   one call, and the edge answered
   `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`. Staff login
   was **completely broken on the deployment** while the suite was green. The symptom was
   beautifully misleading: a login with an *unknown* email 401'd correctly, because that path
   short-circuits before PBKDF2 ever runs, so only *real* users could not log in. **Fixed** —
   `deriveKey` now chains rounds under the ceiling (D15), preserving the work factor exactly.
2. **🐛 A Free-plan Worker's CPU limit cannot be raised, and 600,000 iterations do not fit in it.**
   `/auth/login` derives once and *intermittently* survived; `/auth/change-password` derives
   **twice** and reliably did not, dying with Cloudflare error **1102** ("Worker exceeded CPU time
   limit"). Because a Worker killed mid-request emits no headers at all, the browser reported this
   as **"blocked by CORS policy: No 'Access-Control-Allow-Origin' header"** — a symptom that points
   at the one part of the system that was working perfectly. Attempting `[limits] cpu_ms = 30000`
   returned `CPU limits are not supported for the Free plan [code: 100328]`. **Mitigated, not
   fixed:** the count is now 100,000 (**D14** — a genuine weakening of §38; at the time this was
   written it awaited a paid plan, but the v1.5 audit found the free fix: Phase 4.5's `AuthGuardDO`).
3. **The seed file's hashes had to be regenerated twice more**, and the underlying problem is
   structural: SQL cannot derive a PBKDF2 key, so `seeds/0001` is the one place in the system where
   a credential is **asserted rather than computed** — which is why it has now drifted twice.
   **`scripts/bootstrap-staff.mjs` removes the whole class of bug for remote databases**: it
   *derives* its hashes at run time from a generated password, writes the SQL to a temp file
   **outside the repository**, and its `--verify-url` flag then **logs in against the live
   deployment** to prove the claim. Deriving a hash and re-deriving it proves only determinism; the
   claim that matters — *"this password opens this account on that deployment"* — can only be tested
   against the deployment. It is also why no committed hash is ever used remotely: a committed hash
   is a published credential.

> **The lesson for Phases 4–6.** "371 tests pass" and "it works on Cloudflare" turned out to be
> different claims, and the gap between them was total for the single most security-critical code
> path in the system. Where code touches a *platform* capability rather than business logic, the
> local suite can only assert on **what the code asks of the platform** — `test/unit/crypto.test.ts`
> now spies on `deriveBits` and asserts the request, not the result. **Phase 5a's AI and Vectorize
> work is the next place this bites**, and it has no local emulation at all.

---

### Phase 4 — Recommendation Engine ✅

Migration `0007` (`recommendations` + `recommendation_explanations`, §13.6); `RecommendationService`;
`policies/recommendation.ts`; `events/dispatch-recommendation-generation.ts` — **the listener plugged
into the seam Step 4 built and left empty**; `GET /student/recommendations` (+ `/latest`) and
`GET /counselor/students/{id}/recommendations`; the student recommendations screen; and **D11 fixed**
across all five screens.

**Exit demo — the full Phase 0–4 walkthrough on the live staging deployment: 61/61 checks, 0 5xx, 0
uncaught errors.** The student completes RIASEC, sees **no** recommendations and a screen that says
*"finish both assessments"* rather than an empty list; the counselor then assigns SCCT; the student
completes it and — with no other action, no button, no extra request — is handed **10 ranked careers
and 10 ranked programs**, top match **70.6%**, each program resolving its college through the §13.6
join (*Mapúa University*), each card carrying a deterministic reason that names their top dimension.

- **The both-results-exist rule lives in the LISTENER, not the event** (§11, v1.2), and the
  walkthrough observes it from the outside: `AssessmentCompleted` fires for *every* scored attempt of
  *every* category, because "the student finished something" is a fact about the assessment module.
  "The student now has enough for a recommendation" is a fact about the *recommendation* module —
  putting it in the event would mean the assessment module knowing what §27 requires, and being
  re-taught every time that changed. Neither instrument needs to know it is the second one.
- **Generation runs inline rather than through a queue** (deviation **D17**). §11 describes a queued
  `GenerateRecommendationJob`; §27 is pure arithmetic over a few hundred catalog rows and one batched
  write, so a queue would buy a round trip, a second invocation, and an observable window in which
  the student's result exists and their recommendations do not — in exchange for deferring work that
  takes milliseconds. The `queue()` handler is wired and waiting for Phase 5a's AI explanation, which
  calls a model and genuinely *does* have a latency budget worth escaping (§30's 8-second target).
- **A listener that throws cannot fail the submit**, and Phase 4 proved why that rule is right *and*
  why it is dangerous: the D1 bound-parameter bug made the listener throw on every generation, and
  the student still got their scored result — exactly as intended — while the recommendations screen
  sat empty and nothing anywhere said why. The scoring must not be held hostage to the ranking. But
  **a swallowed exception needs somewhere to be seen**, and Phase 6's audit-log viewer is where.
- **Idempotent by construction** (§26): regenerating replaces a result's rows in one `db.batch()`
  rather than appending, and the unique index on `(assessment_result_id, match_type, ranking)` is
  what would catch it if that ever stopped being true.

---

### Phase 4.5 — Free-Plan Hardening ✅ (code-complete; staging exit demo pending)

**Step 1 — `AuthGuardDO`, delivered.** `src/do/auth-guard.ts` (SQLite-backed, bound as `AUTH_DO`
at the top level, in both `[env.*]` blocks, and in `wrangler.test.toml`, each with the
`new_sqlite_classes` migration — the per-env binding matters because environments inherit
nothing). The chained ≤100k-per-call derivation moved behind the DO boundary with
`PBKDF2_ITERATIONS` restored to **600,000**; `lib/crypto.ts` keeps only tokens and uuid.
`hash`/`verify` run under `blockConcurrencyWhile`, which makes "brute force is serialized per
account" literally true rather than aspirational. One instance per staff email carries that
account's lockout; one per `(class_code, IP)` carries the join throttle; one per user carries the
§41 AI request limit (new in 5a). KV is off every auth path and `middleware/rate-limit.ts` is
deleted. `scripts/bootstrap-staff.mjs` derives at 600k again. Tests: the `deriveBits` spy asserts
every call ≤100k **and the rounds sum to 600k**; a D14-era 100k hash is proven to still verify;
the DO's counters are covered through the real binding (Miniflare hosts SQLite DOs in-process),
and the §38 lockout/throttle behaviour is still pinned over HTTP by the existing auth suites —
all at the full work factor.

**Step 2 — the platform gates, delivered.** `backend/scripts/platform-gates.mjs`
(`npm run gate:platform`, `gate:bundle`), wired into CI: no `[limits]` block anywhere (Free
rejects it, code 100328); every environment carries the full binding set including `AUTH_DO`;
`AuthGuardDO` declared `new_sqlite_classes` in both configs; the test config stays hermetic (no
`[ai]`/`[[vectorize]]`); `deriveBits` called nowhere outside the DO; the gzipped bundle under
2.5 MB (currently **178 KiB**). Plus `test/platform/subrequest-budget.test.ts`, which counts every
executed D1 statement and `batch()` call on submit-with-inline-generation and asserts ≤25 against
the Free cap of 50.

**The budget gate earned its keep on its first run: it failed at 35.** The waste was real and got
trimmed to ~24: `generateFor` no longer hydrates a recommendation set its only caller (the
listener) discards (−4); the two `latestScoredResult` queries collapsed into one (−1);
`compositeIndexFor` joins attempt→version instead of fetching each (−1); the required-question
check is one LEFT JOIN instead of two reads (−1); submit loads the attempt joined to its
assignment and the version joined to its template once, threading both into scoring and the
result view instead of letting each helper refetch them (−3). Every trim is behaviour-preserving
and covered by the existing 400+ tests.

**Step 3 — the 5a pre-work — was delivered as part of 5a itself** (built immediately after):
the browser extraction utility, the server-side §34 caps, the gateway's quota taxonomy, and the
batching contracts, each with its test. **Step 4 (optional hardening: the pepper, the
unknown-email dummy derivation) was not done** — explicitly a non-blocker, still available.

**Exit demo — PENDING THE DEPLOY** (needs an interactive `wrangler login`): on staging, a staff
login must verify against a 600,000-iteration hash and `/auth/change-password` — the
double-derivation canary that produced error 1102 — must succeed repeatedly; six rapid failed
logins must lock on exactly the fifth, counted by the DO.

---

### Phase 5a — AI Explanation / RAG ✅ (code-complete; staging measurements pending)

Everything under "AI / Knowledge" in Module Status, plus the wiring: the §30 pipeline runs inside
`POST /student/recommendations/{id}/explain` (I/O-bound — await time costs no CPU, so it needs no
queue), while the **proactive** path is the queue's first real workload:
`RecommendationGenerated` → `enqueueExplanationGeneration` → the `GenerateStudentExplanations`
consumer explains the two rank-1 matches (D22). The `queue()` handler dispatches for the first
time since it was scaffolded in Phase 3.5.

The lesson at the top of this file was applied as written: every pipeline test runs against a
**stubbed** gateway and vector store, asserting on what the code asks of the platform — one embed
call per ≤100 texts, one upsert per batch, ≤100-bound-parameter inserts, one `ai_requests` row
per generation with the chunk ids it was shown, `QUOTA_EXHAUSTED` never retried — and the HTTP
tests run with the AI/Vectorize bindings genuinely absent, proving the student gets a 200 and the
deterministic reason on the platform's worst day. An assertion on a live LLM's output remains a
weather report; none exist in the gate.

**Exit demo — ✅ PASSED on staging, 2026-07-15.** See "The deploy session, executed" below.

---

## The deploy session, executed (2026-07-15)

The "Next Incremental Phase" checklist was run end to end against staging. Results, in the
checklist's own order:

1. **Migrate + seed:** both were already applied (a prior session had run them) —
   `db:migrate:staging` answered "No migrations to apply", all four §13.7 tables and the GLOBAL
   `ai_policies` row verified present by direct D1 query.
2. **Deploy:** `careerlinkai-staging` uploaded with `AUTH_DO` bound and the `[[migrations]]`
   `new_sqlite_classes` entry (gzip 190 KiB, startup 33 ms). The **frontend was rebuilt and
   redeployed to Pages** in the same session — the deployed build predated 5a, so the Knowledge /
   AI-policy screens and "Explain more" had never been live before.
3. **Phase 4.5 exit demo — PASSED.** The stored pre-4.5 `pbkdf2$100000$` hash opened through the
   DO (the cost is stored in the hash); **four consecutive `/auth/change-password` rounds — the
   error-1102 canary — all 200'd at ~2.0 s each**; the rotated hash reads `pbkdf2$600000$` in
   staging D1; five rapid failed logins locked the account on the fifth and the **correct**
   password was refused with 429 while locked. One anomaly for the record: a single login 500'd
   once mid-demo and never reproduced across 10+ identical cycles afterwards; nothing in
   `ai_requests`/audit correlates, treated as transient, watch for recurrence.
4. **Phase 5a exit demo — PASSED, with a real platform find.** First attempt: every explanation
   failed `MODEL_ERROR` — **Cloudflare had deprecated `@cf/meta/llama-3.1-8b-instruct` on
   2026-05-30 (error 5028), platform fact #4**, invisible to the (correctly) stubbed local suite.
   The §29 posture held through the outage: every request still answered 200 with the
   deterministic reason, and the FAILED `ai_requests` rows named the exact cause. Fixed by
   switching `WORKERS_AI_TEXT_MODEL` to `…-fp8` (D23) and redeploying. Also proven live, before
   the fix: **§30's refuse-to-generate-ungrounded** — a software-engineering guide against an
   "Architect career…" retrieval query stayed under the 0.75 similarity floor and produced
   `NO_GROUNDING` + the deterministic reason, exactly as designed (the demo then uploaded a
   guide that actually covers the student's rank-1 career).
5. **The measurements (checklist step 7):**
   - **Generation latency: 5,685 ms** against the §6 8 s budget (first generation; the model was
     cold). The stored-row path answers in ~1.5–2 s round trip and never touches the model.
   - **Tokens per explanation: 780 total** (`ai_requests.tokens_used`). At §45's neuron rates
     that is consistent with the ~50–60 neurons/explanation estimate (~150–200/day within the
     10k quota).
   - **Ingestion: upload → PROCESSING at +40 s → COMPLETED at +72 s** — queue `max_batch_timeout`
     (30 s per hop, two hops) dominates; the work itself is milliseconds.
   - **Vectorize queryability lag after COMPLETED: ≤ ~10 s observed** (first explain attempt
     NO_GROUNDING, grounded on the next poll).
6. **The walkthrough (checklist step 8):** `scripts/walkthrough.mjs` now carries **leg E** —
   the admin uploads a generated PDF *about the student's actual rank-1 career* through the real
   Knowledge screen (pdf.js extraction in the browser), waits for "Ready", and the student
   presses "Explain more" through the async-indexing window until the grounded paragraph
   renders, then proves a repeat press returns the stored row byte-identically. **The full
   Phase 0–5a walkthrough passes 66/66 against staging** (0 5xx; the only 4xx are its own
   deliberate wrong-credential probes). Re-running still requires `bootstrap-staff.mjs` first —
   legs A/B rotate passwords.

---

## Next Incremental Phase

> **Phases 0–5b are all deployed and proven on staging.** The gate stands at tsc · ESLint ·
> platform gates · bundle 198 KiB · **477/477** backend tests · 35/35 frontend tests, and the
> live deployment passes the Phase 0–5a walkthrough (66/66) plus the 5b exit demo (11/11).
> **Phase 6 is the whole of what remains.**

### The 5b deploy + exit demo — ✅ EXECUTED 2026-07-15, same session as 4.5/5a

Worker + Pages redeployed (no new migration, no new bindings — the 5b surface is code only).
The demo, over the live API as the counselor: CUSTOM template (`COUNSELOR_PRIVATE`) → two
dimensions → DRAFT version → Mode B generation queued (202) → **DRAFTED ~130 s later, 12
questions** (queue batch timing dominates, same as ingestion; the §34 validator dropped
nothing — the model respected the provided dimension codes) → the review payload carried all
12 mappings unconfirmed → **publish refused 422: "12 of 12 dimension mappings are still
unconfirmed"** → 12 individual confirms → **publish 200, version PUBLISHED**. Then the §6
criterion: the same generation against RIASEC **as the admin** → **403** ("RIASEC and SCCT are
curated instruments and can never be AI-generated or AI-edited"). 11/11 checks.

### Phase 6 — Polish & Defense Prep (all that remains)

1. **`NotificationService`** + migration `0009_notifications.sql` (the last missing table) + the
   three §20 endpoints + the frontend notifications feature. The three waiting listeners plug in:
   `KnowledgeDocumentProcessed`, `AssessmentDraftGenerated`, and assignment events.
2. **Audit-log viewer** (`GET /audit-logs` + admin screen) — where the swallowed-exception
   pattern (D18's lesson) finally gets its surface.
3. **Real dashboard data** (`GET /dashboard` × 3 roles) + admin counselor-management screens.
4. **Small debts:** forgot/reset-password UI (D7's honest shape), counselor attempt-reset button
   (D8), `GET /programs/public` if wanted.
5. **Defense prep:** the §45 quota dashboard check, a seeded knowledge corpus covering the demo
   catalog (the 5a lesson: retrieval grounds only what the corpus covers), and a full
   walkthrough run against a fresh database.

### Historical — the Phase 4 plan, now delivered

The §27 formula core is **already built and tested** against §28's worked example
(`lib/recommendation.ts`, 37 unit tests). What remains is everything around it, and it is now
unblocked — `assessment_results` exists, so `recommendations.assessment_result_id` finally has
something to point at:

1. **Migration 0007** — `recommendations` + `recommendation_explanations` (§13.6).
2. **`RecommendationService`** — the shell that reads the student's latest **`SCORED`** RIASEC and
   SCCT results (`dimension_scores` + `ScoringService.compositeIndexFor()`, **never**
   `overall_summary`) plus `student_profiles`, calls the §27 engine, and persists the **top 10 of
   each type**. The catalog's `rankablePrograms()` / `scorableCareersFor()` are the only reads it
   needs — they were built in Step 3 for exactly this.
3. **`DispatchRecommendationGeneration`** — the `AssessmentCompleted` listener. It is the listener,
   not the event, that checks **both a RIASEC and an SCCT result exist** before dispatching
   `GenerateRecommendationJob` (§11, v1.2). The dispatcher and the event already exist and fire with
   no listeners registered; this is the seam.
4. **`policies/recommendation.ts`**, student recommendation screens, counselor
   `GET /students/{id}/recommendations`.
5. **Fix D11 — and this is now the deadline, not a suggestion.** `StudentDashboardPage`,
   `AssessmentListPage`, `ResultListPage`, `StudentProfilePage` and `AssignmentPanel` have no
   `isError` branch, so a student whose assignments fail to load is told **they have none**. It was
   harmless while the endpoints did not exist. **They exist now.** §57's frontend-invariant rule was
   what forbade fixing it during the port; the port's assessment step is done, so that reason is
   spent.

**Remaining after the deploy session:** 5b (AI-assisted generation), 6 (notifications, dashboards,
audit-log viewer, polish, defense prep).
