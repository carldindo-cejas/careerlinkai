# CareerLinkAI Backend — Pre-Production Audit

> **Audit date:** 2026-07-17
> **Scope:** entire backend (`backend/` — ~15,300 lines across 70+ source files, 9 migrations, 3 seeds, platform gates, test config), plus frontend service-layer contracts.
> **Verification performed during audit:** `tsc --noEmit` clean · `node scripts/platform-gates.mjs` all gates pass · **514/514 tests pass** (vitest, ~3 min).

**TL;DR:** This is an unusually disciplined codebase for a thesis project — clean layering, allow-list serializers, DO-backed security counters, pure tested engines, and static platform gates. The two things that genuinely threaten production are both members of the failure class the project itself has been bitten by three times (limits Miniflare can't see): **(C1) the results-listing endpoints fan out ~5 D1 queries per scored attempt and will exceed the Free plan's 50-subrequest ceiling on any realistically-sized class**, and **(C2) the submit path's status flip and scoring write are not atomic, so a mid-flight failure permanently strands an attempt in `SUBMITTED`**. Everything else is medium-or-below and fixable incrementally.

---

## Phase 1 — Backend Audit

### 1.1 Architecture overview

One Cloudflare Worker (`backend/src/index.ts`) with two entry points — `fetch` (Hono app) and `queue` (consumer for two queues: `default`, `ai`) — plus one exported Durable Object class (`AuthGuardDO`). Stack: **Hono 4 + Zod 4 + Drizzle (query-builder only) on D1**, R2 for raw files, Vectorize for embeddings, Workers AI for generation, SQLite-backed DO for PBKDF2 derivation and all security counters. KV is bound but deliberately unused (correctly retired from the auth path — eventual consistency and the 1,000 writes/day cap disqualify it as a security counter).

Layering is consistent everywhere:

```
Route (parse Zod schema → call one Service → serialize envelope)
  → Middleware: correlationId → CORS → authenticate → ensureRole → ensurePasswordChanged
  → Service (business rules, Drizzle queries, AuditService writes)
  → Policy (pure functions; ownership checks; 404-for-not-yours discipline)
  → Pure engines (lib/scoring, lib/recommendation, lib/chunker — no I/O, unit-tested vs worked examples)
  → Events: in-process dispatch() with swallow-and-log listeners; real async goes to Queues
```

### 1.2 End-to-end flow (written diagram)

1. **Staff auth:** `POST /auth/login` → per-email `AuthGuardDO` checks the lockout (5 fails/15 min), verifies PBKDF2 (600k iterations, chained ≤100k per `deriveBits` call, serialized via `blockConcurrencyWhile`) → opaque 32-byte bearer token, SHA-256 hash stored in `api_tokens` (7-day TTL). `must_change_password` gates everything except `/auth/me|logout|change-password`.
2. **Student access:** `POST /student-access/join` (the only unauthenticated write) → `(class_code, IP)` DO throttle, failures-only (10/15 min) → every failure funnels through one `reject()` that returns an identical 401 and writes the true reason to `audit_logs` → success revokes all prior tokens (single-session) and issues a 12-h token.
3. **Roster:** counselor pastes names → `preview` (pure, persists nothing) → `confirm` creates user + student_profile + class_students rows in one `db.batch()`; single collision rejects the whole batch.
4. **Assessment:** counselor assigns a **PUBLISHED version** to a class (draft → 422) → student `start` (idempotent, authorized against *live enrollment*, not the token) → `saveAnswer` upserts with a **server-side score snapshot** → `submit` blocks on unanswered required questions, scores **inline** (`lib/scoring` → one batch: delete-then-insert `dimension_scores` + `assessment_results`, flip to `SCORED`) → fires `AssessmentCompleted`.
5. **Recommendation:** the listener (inline, deviation D17) requires both a scored RIASEC and SCCT; recomputes the SCCT composite from `dimension_scores` (never parses prose); ranks the full catalog with the pure §27 engine; delete-then-insert top-10 careers + top-10 programs, chunked ≤9 rows/insert for D1's 100-bound-parameter cap; fires `RecommendationGenerated` → enqueues `GenerateStudentExplanations` + sends a notification.
6. **AI explanation (RAG):** embed query → Vectorize top-6, threshold 0.75 → hydrate chunks from D1 → prompt with allow-listed fields only → 1 regeneration on the absolute-claim filter → persist via `RecommendationService.saveExplanation` (replace-not-accumulate). Every failure mode (no grounding, quota, model down, validation) converges on the deterministic §27 reason with a `FAILED` `ai_requests` row.
7. **Assessment generation:** endpoint validates + authorizes (**category before ownership** — RIASEC/SCCT refused even to admins), pre-allocates the `ai_requests` id, answers 202, queues; job re-checks everything, parses/validates model JSON, persists questions as unconfirmed drafts; publish gate blocks any version with `confirmed_at IS NULL` mappings.
8. **Ingestion:** browser extracts text (Free plan has no CPU home for a parser) → raw file + `extracted.txt` sidecar to R2 → chunk (queue) → embed in ≤100-text batches → vector id = chunk id → archive removes vectors structurally.
9. **Platform:** append-only `AuditService` (sole writer, typed action union), notifications (insert-only, `read_at`), three dashboards computed live from indexed aggregates.

### 1.3 What is genuinely good (keep, don't "improve")

- The two-layer authorization model, the 404-vs-403 discipline, and the two deliberate no-admin-branch rules in `backend/src/policies/assessment.ts`.
- Allow-list serializers with the student/author split (`backend/src/modules/assessment/serializers.ts`) — option scores and dimensions never reach the player.
- Pure engines with worked-example tests; scoring config as data; the "absent ≠ zero" rule carried consistently end to end.
- `AuthGuardDO` — correct fix for the Free-plan CPU cap, correct consistency model for lockouts, serialized derivation.
- The platform-gates script and the subrequest-budget test — asserting on *what the code asks of the platform* is exactly right for this stack.
- 514 passing hermetic tests; AI/Vectorize stubbed via seams; test config with the bindings removed.

### 1.4 Findings

#### Bugs (existing or production-certain)

| # | Finding | Where |
|---|---|---|
| **C1** | **Subrequest-ceiling blowup on results listings.** `resultFor()` costs 4 D1 queries per attempt (findAttempt + versionWithTemplate + result + scoredDimensionsFor) and the routes re-fetch dimensions per row — ~5 queries per scored attempt, unpaginated, after auth has already spent 3. `GET /counselor/classes/{id}/results` dies at roughly **9+ scored attempts** in a class (a 40-student class with RIASEC+SCCT ≈ 400 subrequests vs a 50 cap). `GET /student/results` fails at ~9 results. Passes every local test — Miniflare enforces no limit; this is D14/D18/rankPrograms all over again. The budget test only covers `submit`. | `assessment-attempt-service.ts` (`listResultsForClass`, `listResultsForStudent`, `resultFor`), `assessment/routes.ts` (per-view dimension refetch) |
| **C2** | **Non-atomic submit.** The attempt is flipped to `SUBMITTED` in one statement, then scoring runs in a *separate* batch. Any failure between (D1 blip, unexpected throw in `loadScoringInput`) strands the attempt: retry gets 422 "already submitted", nothing ever re-scores a `SUBMITTED` attempt, and the only recovery is a counselor reset + full retake. | `assessment-attempt-service.ts` `submit()` + `scoring-service.ts` `score()` |
| H4 | **Check-then-insert races that surface as raw 500s.** Only `attachCareer` translates `UNIQUE constraint failed` into a 422. Not covered: concurrent `saveAnswer` for the same question (select-then-insert), double-tap `start` (truly concurrent), counselor create with a duplicate email (hash derived *before* the race window), roster confirm racing itself, program-code create. The unique indexes hold the invariants; the error shape is wrong. | `assessment-attempt-service.ts`, `counselor-management-service.ts`, `class-service.ts`, `academic-catalog-service.ts` |
| M4 | **Stale recommendation edge case.** `generateFor` skips the delete-then-insert batch entirely when `rows.length === 0`, so if the catalog is emptied/archived, a student's previous recommendations survive a regeneration that should have cleared them. Old result-sets from retakes also accumulate forever (only `latestFor` hides them). | `recommendation-service.ts` `generateFor()` |
| M5 | **`embedBatch` completion race.** Two embedding-batch messages for one document can interleave, both observe `remaining === 0`, and double-fire `COMPLETED` + the notification. Harmless data-wise, duplicate notification. | `knowledge-ingestion-service.ts` `embedBatch()` |
| L5 | `addDimensions` does not pre-check duplicate codes (within the payload or against existing rows) — the unique index answers with a raw 500 instead of a 422; concurrent adds can also produce duplicate `order_number`s, which is scoring data (tie-break). | `assessment-builder-service.ts`, `builder-routes.ts` |

#### Performance bottlenecks

- **H2 — hot auth path:** every authenticated request costs 3 D1 round trips including an unconditional **write** (`touchToken`) to a column (`last_used_at`) that *nothing in the system reads* (verified by grep). That's added latency on every request, one daily-quota write per request (D1 free: 100k writes/day — a class of 40 doing an assessment burns thousands), and 3 of the 50 subrequests before the handler starts. (`middleware/authenticate.ts`, `lib/tokens.ts`)
- **H5 — smaller per-row fans:** `decorateAssignments` (2 queries/assignment), counselor template list (3 queries/template), `listResultsForStudent` route re-fetching dimensions per view. Same class as C1, lower blast radius.
- Explanation double-generation race on concurrent "Explain" clicks — wasted neurons against a 10k/day quota (the pre-check and save aren't atomic). Low.

#### Security findings

- **H3 — login timing oracle.** `guard.verify()` only runs when the email resolves to a staff account; unknown emails return in milliseconds while real ones pay the 600k-iteration derivation. That's account enumeration by stopwatch, on the one endpoint where the code elsewhere (`staff-authentication-service.ts`, reset-token path) shows the team cares about exactly this. Fix: verify against a static dummy hash when the user is missing/not staff.
- **M2 — `forgot-password` is un-throttled.** Each request for a known staff email overwrites the pending reset token (denial of the legitimate reset) and writes an audit row + token row — unauthenticated D1 write amplification. It's the only credential endpoint not behind a DO counter.
- **M3 — throttled join spam still writes.** Once locked, *every* further attempt writes a `STUDENT_CLASS_ACCESS_THROTTLED` audit row — an attacker can burn the D1 daily write quota from one loop. Log the first throttle per window, or sample.
- **M1 — AI rate limiter TOCTOU + semantics.** `check()` then `recordFailure()` are two DO round trips, so concurrent requests overshoot the 10/min cap slightly; also "recordFailure" charging *usage* is a readability trap. A single `charge(limit, window)` DO method fixes both. (`generation-routes.ts`, `recommendation/routes.ts`)
- M9 — reset-token comparison is `!==` on hex strings (not constant-time). Practically negligible (attacker can't choose the stored hash), worth one line.
- M10 — committed seed credentials are well-documented and mitigated by `must_change_password` + the bootstrap script for remote; keep the discipline that `seeds/0001` never touches production.
- Positive: CORS pinned to `FRONTEND_URL`, no wildcard; tokens hashed at rest; prompts interpolate allow-listed fields only; enumeration-resistant 401/404 discipline is consistently applied.

#### Scalability findings

- C1/H5 above are the scalability story: **the pattern "N queries per row on an unpaginated list" is the single systemic weakness.** At thesis scale (one school, tens of classes) everything else holds comfortably: D1 5M reads/day, 10k neurons/day (~150–200 explanations), Worker 100k requests/day.
- `recommendations` and `audit_logs` grow without bound (no cleanup, no retention). Fine for a thesis; note it in the defense.
- Unbounded DO instances from attacker-chosen `(code, IP)` / email names — each is a near-empty SQLite DO; acceptable, but worth a sentence in the thesis threat model.

#### Database findings

- Schema quality is high: UUID PKs, TEXT+CHECK enums mirrored in `db/enums.ts`, every FK indexed, ISO-8601 UTC strings with lexical-comparison semantics, the **partial unique index** on live attempts, JSON confined to config columns, soft-delete boundaries reasoned per table.
- Gaps: `audit_logs.module` is filtered by the viewer but unindexed; `assessment_questions.source_ai_request_id` has no FK (documented migration-ordering artifact — a later migration could add it); `users.email` unique across soft-deleted rows is deliberate and correctly compensated in the create check.
- Expired `api_tokens` are only deleted when presented; `password_reset_tokens` rows linger. No scheduled cleanup exists (Cron Triggers are free — an easy win).

#### API design & integration findings

- Envelope, pagination-inside-`data`, and decimal-as-string contracts are consistent and mirrored by the frontend `services/*` layer. Good.
- **L1 — dead/conflicting code:** `identity/serializers.ts` exports an unused `serializeStudentProfile` that returns `gwa` as a **number**, while the used one (assessment module) returns `"88.00"` strings. A future caller grabbing the wrong import silently breaks the frontend contract. Delete it. Also unused: the `'CHAT'` member of `AI_REQUEST_TYPES`.
- M7 — audit-log `from`/`to` require full ISO datetimes; a date-only value 422s (frontend must send `T00:00:00Z`).
- Unpaginated heavy endpoints (student results, class results, class assignments) — ties into C1.
- Staff token TTL is a hardcoded constant while student TTL is a var — minor inconsistency.

#### Deployment / Free-plan findings

- `wrangler.toml` is exemplary: per-env explicit bindings, no `[limits]`, SQLite DO migrations, and the gates enforce all of it.
- **H1 — no dead-letter queues.** `max_retries = 3` and then the message is *dropped*. Ingestion failures stay visible via `markAiJobFailed`, but a dropped `GenerateAssessmentDraft` leaves the poll PENDING forever, and a dropped `GenerateStudentExplanations` vanishes silently. DLQs are free — one line per consumer.
- No `[observability]` block: structured JSON logs are written but nothing persists them; Workers Logs is available on Free with limits. Without it, the correlation-id design has nowhere to pay off in production.
- No Cron Trigger for housekeeping (also free).

#### Test coverage

514 tests, hermetic, covering authorization matrices, D1 limits, DO behavior, AI failure taxonomy, and invariants. Gaps: no budget test for the results endpoints (the C1 hole), no test for the submit-crash recovery path (C2), no concurrency/race tests (understandably), and the queue consumer's retry/ack loop is only unit-covered.

---

## Phase 2 — Severity Assessment

### Critical

| Issue | Why | Impact | Risk if unresolved |
|---|---|---|---|
| **C1** results-listing subrequest blowup | Exceeds a hard, unraisable Free-plan platform limit; invisible to all 514 tests | Counselor results screen and student results screen return 500s the moment a real class finishes two instruments — i.e., **during the thesis demo** | Guaranteed production failure at exactly the demo's scale; browser shows it as a CORS error (no headers), making it maximally confusing live |
| **C2** non-atomic submit | Two-step state transition with no recovery path | A transient failure permanently voids a student's completed 60-question attempt; dashboards count phantom `SUBMITTED` rows | Data-integrity incident with a human cost (student re-takes an entire instrument); indefensible in a defense Q&A about reliability |

### High Priority

- **H1** No DLQs → silent message loss after 3 retries (drafts stuck PENDING forever; explanations lost).
- **H2** Hot-path `touchToken` write feeding a column nothing reads → latency + quota burn on literally every request.
- **H3** Login timing oracle → staff account enumeration; undermines the enumeration-resistance the rest of the codebase pays real costs for.
- **H4** Unique-constraint races answered as 500 → user-visible failures under normal concurrent use (two tabs, double-clicks, 40 students in a lab).
- **H5** Remaining per-row query fans (assignments, template list) → same C1 class, hits at larger N.

### Medium Priority

- **M1** AI limiter TOCTOU/semantics.
- **M2** Un-throttled forgot-password (reset-flow DoS + write drain).
- **M3** Unbounded throttled-join audit writes (quota drain).
- **M4** Stale/orphaned recommendations.
- **M5** embedBatch completion race.
- **M6** Missing pagination on heavy lists.
- **M7** Audit date-filter strictness.
- **M8** Counselor-create race (hash derived before the uniqueness window; raw 500 on loss).
- **M9** Non-constant-time reset-token compare.
- **M11** No scheduled cleanup / unbounded audit growth.

### Low Priority

- **L1** Dead `serializeStudentProfile` (contract trap) + unused `'CHAT'` enum member.
- **L2** `audit_logs.module` index missing.
- **L3** `/health` env disclosure (trivial).
- **L4** Hardcoded staff TTL vs configurable student TTL.
- **L5** Dimension add 500s on duplicate codes; concurrent order-number collisions.
- Explanation double-generate race (wasted neurons); notification fan-out inserts not batched.

### Enhancement Suggestions

- Enable `[observability]` (Workers Logs, free tier) so correlation ids are usable in production.
- Cron Trigger (free): purge expired `api_tokens`, stale reset tokens, superseded recommendation sets.
- Cloudflare dashboard rate-limiting rule (1 rule free) in front of `/api/v1/auth/forgot-password` and `/student-access/join` as belt-and-braces.
- A read-only "sessions" admin view *if* `last_used_at` is kept; otherwise drop the column write (preferred).
- Add the missing FK `assessment_questions.source_ai_request_id → ai_requests.id` in a follow-up migration.

---

## Phase 3 — Normalization Plan (incremental, regression-minimizing)

Ordering principle: **make production match the tests before making anything faster or prettier.** Every phase leaves the suite green and the API contract byte-compatible unless stated.

### Phase A — Critical Bug Fixes

**Objectives:** eliminate C1 and C2.

- **A1 (C1):** Rewrite `resultFor`-based listings as set queries: one query for all attempts+results+templates (join), one for all `dimension_scores` of the listed attempts (`inArray`), one for dimensions — **~5 queries total regardless of N**, instead of ~5N. Pass the already-loaded dimensions into `serializeResult` instead of re-querying per view. Add `per_page` (default 25, max 50) to `/counselor/classes/{id}/results` and `/student/results` — additive; the frontend's `Paginated<T>` type already exists.
- **A2 (C2):** Fold the `SUBMITTED` flip into the scoring batch (score computes from `IN_PROGRESS` state; the batch writes `dimension_scores` + `assessment_results` + a single status update `IN_PROGRESS → SCORED`), or keep `SUBMITTED` but make `submit` re-runnable when status is `SUBMITTED` with no result row (re-score instead of 422).
- **A3:** Extend the subrequest-budget test to cover the two listing endpoints (assert ≤ ~15 at N=40).

**Files/modules:** `assessment-attempt-service.ts`, `scoring-service.ts`, `assessment/routes.ts`, `test/platform/subrequest-budget.test.ts`.
**Dependencies:** none.
**Risks:** result-shape drift — pin with existing serializer tests; scoring semantics untouched (pure engine unchanged).
**Complexity:** medium (A1), small (A2).
**Expected improvement:** the two demo-critical screens survive a real class; no strandable attempts.

### Phase B — Architecture Cleanup

**Objectives:** remove traps and dead code; unify duplicated patterns.

- Delete `identity/serializers.serializeStudentProfile` + interface (L1); drop `'CHAT'` from `AI_REQUEST_TYPES` or comment it as reserved.
- Extract one `translateUniqueViolation(error, field, message)` helper (generalizing `isUniqueViolation` from the catalog service) and apply it at the H4 sites: `saveAnswer` (better: switch to `onConflictDoUpdate`), `start`, counselor create, roster confirm, program code, dimension add (L5, with an in-payload duplicate pre-check).
- Replace the DO `check()+recordFailure()` pair at AI endpoints with a single `charge()` method on `AuthGuardDO` (M1) — additive DO method, old methods stay.

**Files/modules:** `identity/serializers.ts`, `db/enums.ts`, a new `lib/db-errors.ts`, `do/auth-guard.ts`, the H4 service sites.
**Dependencies:** none.
**Risks:** low — behavior-preserving except 500→422 conversions (strictly better).
**Complexity:** small–medium.
**Expected improvement:** concurrent normal use stops producing 500s; the contract trap is gone.

### Phase C — Database Normalization

**Objectives:** schema hygiene, no data rewrites.

- Migration 0010: `CREATE INDEX audit_logs_module_index`; add FK `assessment_questions.source_ai_request_id REFERENCES ai_requests(id)` (nullable, no cascade). If Phase D removes the `touchToken` write, simply stop writing `last_used_at` and document (D1 column drops aren't worth a table rebuild).
- Fix M4: in `generateFor`, always run the delete for the *student's* previous rows (`WHERE student_id = ?`) even when the new set is empty — this also clears superseded sets from older results in the same statement.

**Files/modules:** `migrations/0010_*.sql`, `db/schema.ts`, `recommendation-service.ts`.
**Dependencies:** B (soft).
**Risks:** migration ordering across local/staging/prod — use the existing `db:migrate:*` scripts; the delete-scope change needs a test that a retake replaces rather than accumulates.
**Complexity:** small.
**Expected improvement:** honest data, indexed viewer, provenance FK.

### Phase D — Performance Optimizations

**Objectives:** cheapen the paths every request pays.

- Remove `touchToken` (H2) — or throttle it to once/hour per token if a "last seen" feature is actually wanted. Saves 1 write + 1 subrequest per request.
- Batch the remaining per-row fans (H5): `decorateAssignments` (one grouped question-count query, one grouped attempt query), counselor template list (grouped `assignableVersion`/counts).
- `embedBatch`: single `UPDATE ... WHERE id IN (...)` instead of one statement per chunk; guard the COMPLETED flip with a conditional update (`WHERE processing_status <> 'COMPLETED'`) to close M5.

**Files/modules:** `middleware/authenticate.ts`, `lib/tokens.ts`, `assessment-attempt-service.ts`, `assessment/routes.ts`, `knowledge-ingestion-service.ts`.
**Dependencies:** A (shares files with A1).
**Risks:** low; assert with the extended budget test.
**Complexity:** small–medium.
**Expected improvement:** every authenticated request gets faster and cheaper; write-quota headroom roughly doubles under classroom load.

### Phase E — Security Improvements

**Objectives:** close the oracles and the write-amplification vectors.

- H3: on unknown-email/non-staff login, verify against a constant dummy hash on the same DO path so timing is uniform.
- M2: put `forgot-password` behind a per-email DO counter (reuse `AuthGuardDO`, e.g. 3/hour), and don't overwrite a pending token more than once per window.
- M3: write the `THROTTLED` audit row only on the *first* throttled attempt per window (the DO already knows).
- M9: constant-time compare for the reset token (reuse `timingSafeEqual` — export it from the DO module or duplicate the 10 lines in `crypto.ts`).

**Files/modules:** `staff-authentication-service.ts`, `student-access-service.ts`, `lib/auth-guard.ts`, `do/auth-guard.ts`, `lib/crypto.ts`.
**Dependencies:** B (the `charge()` method helps M2).
**Risks:** login latency for unknown emails rises to match known ones (that's the point).
**Complexity:** small.
**Expected improvement:** enumeration resistance becomes uniform across the auth surface; quota-drain attacks neutered.

### Phase F — API and Flow Optimizations

**Objectives:** contract polish, additive only.

- Pagination params on the remaining heavy lists (M6) with generous defaults so the current frontend keeps working unchanged.
- Accept date-only `from`/`to` on the audit viewer (normalize to start/end of day) (M7).
- Move `STAFF_TOKEN_TTL_HOURS` to a `[vars]` entry beside the student TTL (L4).
- `/health`: drop `environment` or keep it — decide once and note it (L3).

**Files/modules:** the listing routes, `platform/routes.ts`, `lib/config.ts`, `wrangler.toml`.
**Dependencies:** A.
**Risks:** minimal; every change additive.
**Complexity:** small.
**Expected improvement:** contract consistency; no frontend changes required.

### Phase G — Testing Improvements

**Objectives:** make the suite guard the failure class that keeps recurring.

- Budget tests for: results listings (from A3), student assignments list, counselor template list, admin dashboard.
- A test that a submit whose scoring batch throws leaves a recoverable state (drives A2).
- Race-shaped tests where feasible in Miniflare: double `saveAnswer` upsert, duplicate counselor email → 422, duplicate dimension code → 422.
- A queue-consumer test asserting the ack/retry decision per failure type (including the "unknown type is acked" branch).

**Dependencies:** A, B.
**Risks:** none (test-only).
**Complexity:** medium.
**Expected improvement:** the "passed 514 tests, died on staging" pattern loses its remaining habitats.

### Phase H — Final Optimization and Cleanup

**Objectives:** operational readiness for defense.

- Enable `[observability] enabled = true` (all three scopes) — free-tier Workers Logs; the correlation-id design finally pays off.
- Add `dead_letter_queue` to both consumers (+ a tiny DLQ consumer that logs and, for ingestion types, calls `markFailed`) (H1).
- Cron Trigger: nightly purge of expired `api_tokens`, reset tokens older than 1 h, and recommendation sets superseded by a newer `assessment_result` (M11).
- Sweep PROGRESS.md deviations into a single "known deviations" appendix for the thesis document.

**Files/modules:** `wrangler.toml` (+ mirror in `scripts/platform-gates.mjs` — add gate checks for DLQ and observability), `index.ts` (scheduled handler), docs.
**Dependencies:** everything before it.
**Risks:** DLQ/cron are new config surfaces — cover them with two new platform gates.
**Complexity:** small–medium.
**Expected improvement:** silent-loss modes eliminated; logs actually retrievable; data hygiene automated.

---

## Phase 4 — Optimization Roadmap (priority order)

| Order | Item | Serves | Effort | Gate |
|---|---|---|---|---|
| 1 | A1 + A3 — fix results-listing fan-out, extend budget test | Stability, demo-readiness | M | budget test ≤15 @ N=40 |
| 2 | A2 — atomic submit/scoring | Correctness | S | crash-recovery test |
| 3 | H1 — DLQs on both consumers | Stability | S | platform gate asserts config |
| 4 | E (H3, M2, M3, M9) — auth-surface hardening | Security | S | timing + throttle tests |
| 5 | B — 500→422 race translation, `charge()`, dead-code removal | Correctness, maintainability | S–M | race tests (G) |
| 6 | D — drop `touchToken`, batch remaining fans, embedBatch tidy | Performance, quota headroom | S–M | budget tests |
| 7 | C — migration 0010 + M4 delete-scope fix | DB integrity | S | retake-replaces test |
| 8 | F — pagination, date filters, TTL var | API polish, frontend compat | S | contract tests unchanged |
| 9 | G — remaining test hardening | Reliability | M | — |
| 10 | H — observability, cron cleanup, docs sweep | Thesis-readiness | S–M | gates green, bundle gate green |

Everything above stays on the Free plan (DLQs, Cron Triggers, Workers Logs free tier, and one dashboard rate-limit rule are all included), requires no external services, and no step rewrites an engine, a schema table, or a route contract — the largest single change is A1, which is a query-shape refactor inside one service with its outputs pinned by existing serializer tests.

**Bottom line for the defense:** fix items 1–4 before any live demo with a real class roster — C1 in particular *will* fire during a demo and will masquerade as a CORS error. The rest is genuine but incremental polish on a backend whose architecture is already defensible.
