# CareerLinkAI Progress

**Tracks:** FULLPLAN.md v1.4 · **Last full audit of this file:** 2026-07-13 (fresh codebase analysis)
**Rule:** FULLPLAN.md is the single source of truth. Where this file and the plan disagree, the plan
wins and this file is a bug — unless the entry is explicitly marked as a ratified/proposed deviation
in the "Deviations From Master Plan" section below.

> **History note:** a previous PROGRESS.md tracked the Laravel-era build (Phases 0–3, referenced by
> `docs/audit/2026-07-13-architecture-audit.md`). That file left the tree together with the retired
> Laravel backend. This file is the v1.3 tracker, rebuilt from a full verification pass over the
> actual working tree on 2026-07-13.

---

## Overall Progress

**Estimated completion: ~20% of total v1 scope.**

Basis for the estimate: the React frontend for Phases 0–3 is built, type-checks clean, and passes
its full test suite (7 files, 35 tests). The backend on the v1.3 Worker stack is a **placeholder**
(one `fetch` handler returning static text) — 0% of the Phase 3.5 port exists. Phases 4–6 have no
code on either side. Roughly: frontend ≈ 55% of its total screens done × ~35% of project effort,
backend ≈ 0% × ~65% of project effort, spec/docs mature.

| Phase (FULLPLAN §57) | Status |
|---|---|
| Phase 0 — Foundation | ✅ Delivered on retired Laravel stack + ✅ frontend — **backend must be re-delivered by Phase 3.5** |
| Phase 1 — Class & Enrollment | ✅ Same as above |
| Phase 2 — Academic Catalog | ✅ Same as above (integration spike closed as superseded — `docs/spikes/`) |
| Phase 3 — Assessment Engine | ✅ Same as above |
| **Phase 3.5 — Platform Port (CURRENT)** | 🚧 **Not started.** `backend/` contains only a placeholder `src/index.ts` + `wrangler.toml` |
| Phase 4 — Recommendation Engine | 🚧 Not started (blocked on 3.5) |
| Phase 5a — AI Explanation / RAG | 🚧 Not started |
| Phase 5b — AI-Assisted Generation | 🚧 Not started |
| Phase 6 — Polish & Defense Prep | 🚧 Not started |

**Completed phases:** 0–3, but only in the sense FULLPLAN v1.3 defines: they were built and verified
on the retired Laravel stack and now exist as (a) the working React frontend, (b) the HTTP contract
docs in `docs/api/`, and (c) the FULLPLAN spec itself. **No runnable backend exists in the tree.**

**Current phase:** **Phase 3.5 — Platform Port.** Re-implement the Phase 0–3 backend scope as a
TypeScript Cloudflare Worker (Hono + Zod + Drizzle/D1). Blocks Phase 4.

**Remaining phases:** 3.5, 4, 5a, 5b, 6 — plus the frontend screens those phases add.

### ⚠️ Critical context for the port (read before writing code)

1. **The Laravel reference implementation is gone from the working tree** and this directory is
   **not a git repository** — the "233 passing tests define done" contract (FULLPLAN §57 Phase 3.5)
   is not locally recoverable. The plan's Phase 3.5 exit criterion said Laravel is removed *after*
   the port passes on staging; it was removed *before* the port started. The surviving contract
   artifacts, in authority order: **FULLPLAN.md → `docs/api/phase-1..3.md` → the frontend
   services/types/tests**. If a Laravel archive exists outside this tree, recover it; otherwise
   treat the three artifacts above as the executable specification.
2. **The frontend is the invariant** (§57): zero React changes are allowed beyond
   `VITE_API_BASE_URL`. Any frontend change the port seems to need is a port bug.
3. **No git repo also means no CI/CD** (§47 assumes GitHub Actions). `git init` + remote should
   happen at the start of Phase 3.5, before code accumulates.

---

## Module Status

All 8 backend modules follow the same pattern: **specified in FULLPLAN, previously proven on the
retired stack (Phases 0–3 scope only), zero Worker code exists.** Status below = state of the
v1.3 Worker implementation, which is what ships.

### Identity & Access (`users`, `counselor_profiles`, `student_profiles`)
- **Status:** 🚧 Not Started (port pending)
- **Implemented:** nothing on the Worker. Frontend login/change-password/me flows exist and pass tests.
- **Missing:** migrations; Drizzle schema; `StaffAuthenticationService`; `StudentAccessService`;
  PBKDF2 crypto lib; `api_tokens` token service; KV-backed staff lockout (5 fails → 15 min);
  `must_change_password` enforcement; forgot/reset-password endpoints; seeders (1 admin, 1 counselor).
- **Port-contract notes (must reproduce):** identical generic 401 for *all* student-join failure
  modes; student tokens expire (`STUDENT_TOKEN_TTL_HOURS`), are replaced on re-join, revoked on
  class removal (audit F-H3 — was the one known gap in the Laravel code; the port must build it in
  from the start); middleware rejects non-`active` users even with a live token (§38).
- **Files involved (target):** `backend/src/modules/identity/`, `backend/src/lib/crypto.ts`,
  `backend/src/middleware/authenticate.ts`, `backend/migrations/0001_*.sql`.

### Class (`classes`, `class_students`)
- **Status:** 🚧 Not Started (port pending). Frontend complete (ClassList/Detail, RosterBuilder with
  preview→edit→confirm, JoinCodeCard, regenerate-code).
- **Missing:** everything server-side — `ClassService`, `ClassEnrollmentService`
  (`previewUsernames()` per §16 incl. mononym handling and class-scoped collision checks,
  `confirmEnrollment()` with whole-batch rejection on collision, 200-name cap), join-code lifecycle
  (`STUDENT_JOIN_CODE_TTL_DAYS` expiry, regeneration), failures-only `(class_code, IP)` throttle
  (10 fails/15 min), join audit logging.
- **Files involved (target):** `backend/src/modules/classes/`, `backend/src/middleware/rate-limit.ts`.

### Academic Catalog (`colleges`, `programs`, `careers`, `program_careers`)
- **Status:** 🚧 Not Started (port pending). Frontend complete (College CRUD + nested programs,
  Career CRUD, program↔career mapping).
- **Missing:** `AcademicCatalogService`, all `/admin` catalog endpoints, soft-delete semantics,
  `recommended_strand` / `typical_riasec_code` validation.
- **Files involved (target):** `backend/src/modules/catalog/`.

### Assessment (`assessment_templates` … `assessment_assignments`, 7 tables)
- **Status:** 🚧 Not Started (port pending). Frontend complete for the Phase 3 slice
  (counselor AssignmentPanel, template list). **No manual assessment-builder UI exists yet**
  (§35 `assessment-builder` feature — RIASEC/SCCT are seeded, so the builder UI is genuinely
  post-Phase-3 scope, needed by Phase 5b at the latest).
- **Missing:** `AssessmentBuilderService` with version immutability, the **dimension freeze rule**
  (v1.2), and the **publish confirmation gate** (`confirmed_at IS NULL` blocks publish);
  `generateWithAi` policy with the RIASEC/SCCT category exclusion as the *first* check (rule and
  test exist from day one even though the AI endpoints are Phase 5b); assignment endpoints
  (assign a PUBLISHED *version*, never a template — draft assignment = 422); RIASEC (60 q) + SCCT
  (30 q) seeders that publish **through the real service** so they pass the gate.
- **Files involved (target):** `backend/src/modules/assessment/`, `backend/src/policies/assessment.ts`.

### Attempt & Results (`assessment_attempts`, `assessment_answers`, `dimension_scores`, `assessment_results`)
- **Status:** 🚧 Not Started (port pending). Frontend complete (player, results, per-dimension
  breakdown honoring "absent ≠ zero").
- **Missing:** `AssessmentAttemptService` (idempotent start, answer upsert with server-side score
  snapshot, required-question submission block, one-attempt-per-assignment unique constraint,
  counselor reset → `EXPIRED`, close-assignment expires in-progress attempts in the same
  transaction); `ScoringService` (§24 generic engine: prorating, `HOLLAND_CODE_TOP3` with canonical
  R>I>A>S>E>C tie-break, `WEIGHTED_COMPOSITE`, ungraded-CUSTOM path) — **unit-tested against the
  Part VI worked examples before any route work**; `AssessmentCompleted` event.
- **Port-contract notes:** no soft deletes anywhere in this module; scoring runs inline on submit
  (<2 s), never queued; the player payload never includes dimensions or option scores
  (a frontend test pins this).
- **Files involved (target):** `backend/src/modules/attempt/`, `backend/src/events/`.

### Recommendation (`recommendations`, `recommendation_explanations`)
- **Status:** 🚧 Not Started (Phase 4). No frontend either (no recommendations screens, no
  service module).
- **Missing:** everything — `RecommendationService` (Part VII formulas, worked-example unit test),
  `GenerateRecommendationJob`, `DispatchRecommendationGeneration` listener (both-results-exist
  check), student recommendation screens, counselor `GET /students/{id}/recommendations`.

### AI / Knowledge (`knowledge_documents`, `knowledge_chunks`, `ai_requests`, `ai_policies`)
- **Status:** 🚧 Not Started (Phase 5). No frontend (no knowledge upload, AI-policy editor,
  generator UI).
- **Missing:** everything — `AiGatewayService`, `RetrievalService`, `KnowledgeIngestionService`,
  `AssessmentGenerationService`, `AiPolicyService`, prompt files, guardrails/validators (§34),
  ingestion + generation queue jobs, Vectorize integration, archive-not-delete semantics
  (`archived_at` + vector removal). Residual measurements from the retired spike (Workers AI
  latency vs the 8 s budget; Vectorize upsert lag) land in Phase 5a and get recorded here.

### Platform (`notifications`, `audit_logs`)
- **Status:** 🚧 Not Started. No frontend notifications feature.
- **Missing:** `NotificationService`, `AuditService` (append-only enforcement), notification
  endpoints, audit-log viewer (admin), event listeners. **Note:** join-attempt audit logging is
  Phase 1 scope in the port (§57 — "not deferred to Phase 6"), so `audit_logs` and a minimal
  `AuditService` are needed early, not at Phase 6.

---

## API Status

### Implemented endpoints (Worker)
**None.** `backend/src/index.ts` returns a static placeholder for every request.

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
- Staff auth: `POST /auth/forgot-password`, `POST /auth/reset-password`
- Admin: counselor management (4), assessment templates/versions/publish/archive (6),
  knowledge documents (3), AI policies (2), `GET /audit-logs`, `GET /dashboard`
- Counselor: private assessment templates/versions/publish (4), `GET /students/{id}/results`,
  `GET /students/{id}/recommendations`, `GET /dashboard`
- Student: `GET /recommendations`, `GET /recommendations/latest`,
  `POST /recommendations/{id}/explain`, `GET /dashboard`
- AI generation group (6), `GET /ai/requests/{id}/status`
- Notifications (3)
- `GET /health`, `GET /programs/public`

### Incorrect endpoints
None — there is nothing to be incorrect yet. See Deviations for the pagination-envelope nuance.

---

## Database Status

- **Existing tables:** none locally. `backend/migrations/` does not exist. A production D1 database
  is provisioned (`CareerLinkAI_Main`, id in `wrangler.toml`) — its remote contents are unverified
  from this tree; assume empty/stale until checked with `wrangler d1`.
- **Missing tables:** all 28 domain tables (§13, index §62) + infrastructure `api_tokens`,
  `password_reset_tokens`. Phase 3.5 rewrites Phase 0–3 scope as plain-SQL migrations (17 domain
  tables + 2 infra); Phases 4–6 add the remaining 11.
- **Schema mismatches:** none possible yet. Non-negotiables when writing migrations: UUID v4 PKs,
  TEXT + `CHECK` for enums (no native ENUM), every FK indexed, all v1.2 unique constraints
  (`(assignment_id, student_id)`, `(class_id, username)`, `(attempt_id, dimension_id)` unique, …),
  `class_students` deliberately has no `created_at`/`updated_at`, `student_profiles.last_name`
  nullable, no soft deletes on the attempt→answer→result chain.

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
  CareerListPage, CareerForm (tested), CareerMapping (tested), CollegeForm, ProgramForm
- **Infrastructure:** httpClient (envelope unwrap, 401 auto-signout), 6 service modules,
  authStore (token-only persistence), studentClassStore, 5 layouts + shared StaffLayout

### Missing pages (by phase)
- **Phase 3.5:** none — the frontend is the port's invariant. Only `.env` changes
  (`VITE_API_BASE_URL` → the `wrangler dev` URL, e.g. `http://localhost:8787/api/v1`).
- **Phase 4:** student recommendations screens (ranked cards, match %, reason);
  counselor individual-student recommendation view.
- **Phase 5a:** admin knowledge-document upload/list; AI-policy editor; "Explain more" on
  recommendation cards.
- **Phase 5b:** `assessment-builder` feature (shared manual builder), `assessment-generator`
  feature (AI drafting + per-mapping confirmation review UI, publish-readiness display).
- **Phase 6:** notifications feature (list, read/unread), audit-log viewer, real dashboard data
  (all three dashboards are currently shells), admin counselor-management screens.
- **Unassigned (small):** forgot/reset-password screens; counselor attempt-reset button (§21 —
  contract endpoint exists, no UI).

### Components needing fixes
None found. Two structural notes tracked under Deviations (feature-folder layout; `hooks/` vs
`api/` folder naming).

---

## Backend Status

- **Completed services:** none.
- **Missing services (all of them):** `StaffAuthenticationService`, `StudentAccessService`,
  `ClassService`, `ClassEnrollmentService`, `AcademicCatalogService`, `AssessmentBuilderService`,
  `AssessmentAttemptService`, `ScoringService`, `RecommendationService`, `AiGatewayService`,
  `RetrievalService`, `KnowledgeIngestionService`, `AssessmentGenerationService`, `AiPolicyService`,
  `NotificationService`, `AuditService`.
- **Missing middleware:** `authenticate` (token hash lookup, expiry, active-status),
  `ensure-role`, `rate-limit` (KV), `correlation-id`.
- **Missing policies:** `class.ts`, `assessment.ts` (incl. `generateWithAi` first-check category
  exclusion and the no-admin-branch `answerAttempt` rule), `recommendation.ts`.
- **Missing events/jobs:** the in-process dispatcher; 4 events; 5 queue jobs
  (`processKnowledgeDocument`, `generateEmbedding`, `generateRecommendation`,
  `generateExplanation`, `generateAssessmentDraft`); the Worker `queue()` handler.
- **Missing AI features:** both pipelines (§30 RAG explanation, §31 generation), prompt files,
  guardrails (§34), `ai_policies` injection.
- **Missing project plumbing:** `backend/package.json`, `tsconfig.json`, Vitest config with
  `@cloudflare/vitest-pool-workers`, ESLint/Prettier, `migrations/`, `test/`, seeders, the entire
  §16 folder structure. Root `package.json` has only `wrangler`.

---

## Deviations From Master Plan

| # | Current implementation | Expected (FULLPLAN) | Recommendation |
|---|---|---|---|
| D1 | **Laravel backend removed before the port exists**; not a git repo, so it is unrecoverable locally | §57 Phase 3.5: Laravel is archived/removed only *after* the full walkthrough passes on staging; its 233-test suite is the port contract | Recover the archive if one exists elsewhere. Otherwise **ratify** `docs/api/*.md` + the frontend services/types/tests as the port contract (they are consistent with FULLPLAN and were written from the verified implementation). `git init` immediately. |
| D2 | `wrangler.toml` bindings: `DOCS` (R2), single `MAIN_QUEUE`, **no KV binding**, no `[vars]`, no `[env.staging]`/`[env.production]` | §16/§48: `STORAGE`, `QUEUE_DEFAULT` + `QUEUE_AI`, `KV`, the six `[vars]`, two named environments | **Plan wins.** Rewrite `wrangler.toml` during the Phase 3.5 scaffold, before any code binds to the wrong names. The placeholder `Env` in `src/index.ts` goes with it. |
| D3 | Pagination lives inside `data` as `{ items, pagination: {…} }` (frontend `Paginated<T>`, `docs/api` contract) | §19 *(pre-v1.4)*: list responses carry `meta.current_page / total / last_page` | ✅ **Resolved — ratified in FULLPLAN v1.4** (§19 corrected + revision note). The nested `data.pagination` shape is now canonical; the Worker port implements it. |
| D4 | Student-access page and assessment player live under `features/student/`; no `student-access/` or `assessment-player/` feature folders | §35 lists them as separate features | **Accept for now.** Pure file organization, zero behavior. Split the player into its own feature when Phase 5b's builder/generator make `features/student` crowded. |
| D5 | TanStack Query hooks live in `features/*/hooks/` | §35 (v1.2, F-L4): feature `api/` folders own the Query hooks | **Accept (cosmetic).** The actual F-L4 rule — components → hooks → `src/services/` clients, one home per concern — is followed everywhere. Folder name differs; ratify or rename opportunistically. |
| D6 | `frontend/.env`/`.env.example` point at the retired Laravel API (`http://localhost:8000/api/v1`) | v1.3: the API is the Worker (`wrangler dev`, default `http://localhost:8787`) | Update both files in the first Phase 3.5 step; this is the *only* frontend change the port permits. |
| D7 | No `forgot-password`/`reset-password` UI | §20 lists the endpoints; §37 implies the screens for staff | Implement the endpoints in the Phase 3.5 auth port (contract completeness); add the small UI in Phase 6 polish. |
| D8 | No counselor attempt-reset UI | §21 retake = counselor-initiated reset; contract endpoint documented | Port the endpoint in Phase 3.5 (it is Phase 3 scope); add the button to ClassDetailPage results in Phase 4/6 polish. |

---

## Next Incremental Phase

### Phase 3.5 · Step 1 — Worker scaffold + Phase 0 scope (staff auth vertical slice)

Smallest independently completable increment that leaves everything working: the frontend keeps
passing its suite untouched, and at the end the Phase 0 §57 demo (staff login → dashboard shell)
runs against `wrangler dev`.

1. **Repo hygiene:** `git init`, `.gitignore` (node_modules, .wrangler, dist, .env).
2. **Scaffold:** `backend/package.json` (hono, zod, drizzle-orm, `@cloudflare/vitest-pool-workers`,
   vitest, typescript, eslint/prettier), `tsconfig.json`, `vitest.config.ts`.
3. **Fix `wrangler.toml` to spec (D2):** `STORAGE`, `QUEUE_DEFAULT`/`QUEUE_AI`, `KV`, `[vars]`
   (`APP_ENV`, `FRONTEND_URL`, model names, `STUDENT_JOIN_CODE_TTL_DAYS`,
   `STUDENT_TOKEN_TTL_HOURS`, `ASSESSMENT_GENERATION_MAX_QUESTIONS`), `[env.staging]`/`[env.production]`.
4. **App skeleton (§16/§17):** `src/index.ts` (fetch → Hono, queue → stub dispatch), `src/app.ts`
   (/api/v1 mount, CORS from `FRONTEND_URL`, error envelope), `src/lib/envelope.ts`,
   `src/middleware/correlation-id.ts`, `GET /health`.
5. **Migration 0001:** `users`, `counselor_profiles`, `student_profiles`, `api_tokens`,
   `password_reset_tokens` — UUID PKs, TEXT+CHECK enums, indexes per §13.1/§15. Drizzle
   `src/db/schema.ts` + `client.ts` for the same tables.
6. **Crypto lib (§38):** PBKDF2-SHA256 (≥600k iterations, `pbkdf2$iterations$salt$hash`), opaque
   token generation + SHA-256 hashing.
7. **Auth slice:** `authenticate` + `ensure-role` middleware; `StaffAuthenticationService`;
   `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/change-password`, `/auth/forgot-password`,
   `/auth/reset-password`; KV lockout (5 fails/15 min per email); `must_change_password` semantics.
8. **Seeder:** 1 admin + 1 counselor (temp password, `must_change_password = true`).
9. **Tests:** Vitest-in-workerd feature tests for every auth endpoint + envelope + lockout,
   assertions transcribed from `docs/api/` and §38.
10. **Wire the frontend:** update `frontend/.env*` to `http://localhost:8787/api/v1` (D6); manually
    run the Phase 0 demo — admin and counselor log in, forced password change works, dashboards load.

**Exit demo:** `wrangler dev` + `npm run dev`; both staff roles log in end-to-end with the
unchanged frontend. Then update this file and proceed to Step 2 (Class & Enrollment port).

Subsequent Phase 3.5 steps (each one demoable, in order): **Step 2** classes + roster + student
access (join throttle, audit logging, token lifecycle incl. revoke-on-removal) · **Step 3**
academic catalog · **Step 4** assessment engine (ScoringService first, unit-tested against the
Part VI worked examples, then attempts/publish gate/assignments + RIASEC/SCCT seeders) ·
**Step 5** staging deploy + full Phase 0–3 walkthrough → Phase 3.5 exit.
