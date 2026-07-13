# Architecture & Implementation Audit — 13 July 2026

**Auditor role:** Lead Software Architect / Technical Reviewer (external pass over all project documents + source)
**Documents reviewed:** FULLPLAN.md v1.1 (complete), PROGRESS.md, `.claude/instructions.md`, `.claude/QUICKREF.md`
**Code reviewed:** backend `app/`, `database/migrations/`, `routes/`, `tests/`; frontend `src/`
**Disposition:** every accepted finding was folded into **FULLPLAN v1.2** the same day; this file is the
permanent record of what was found, why, and how each item was resolved. Where FULLPLAN v1.2 and this
file disagree, FULLPLAN wins (as always).

---

## 1. Verification of PROGRESS.md claims

PROGRESS.md was verified, not taken on faith:

| Claim | Result |
|---|---|
| "Backend suite: 121 passing (645 assertions)" | **Confirmed by a live run** — `php artisan test`: 121 passed, 645 assertions |
| UUID v4 everywhere via `HasVersion4Uuids` (not `HasUuids`/v7) | Confirmed in `User` model |
| Append-only `audit_logs` (throws on UPDATE/DELETE) | Confirmed (model + `SecurityRegressionTest`) |
| Identical generic 401 for all six join failure modes | Confirmed in `StudentAccessService` (single `GENERIC_ERROR` constant; byte-identical response test exists) |
| Failures-only throttle per `(class code, IP)` | Confirmed in `StudentAccessService::reject()` / `assertNotFrozen()` |
| Phase 0 frontend structure (§35 feature-based) | Confirmed in `frontend/src/` |
| Staff lockout | Confirmed — implemented via cache-backed `RateLimiter` (better than the v1.1 spec's "tracked via audit_logs"; ratified in v1.2) |

**Conclusion:** the tracker is accurate. Implementation fidelity of completed work ≈ 95/100 — the only
conformance gap found is F-H3 below (student token revocation), now tracked as an open item.

---

## 2. Findings and resolutions

Severity scale: Critical / High / Medium / Low. "Resolution" states what FULLPLAN v1.2 (or PROGRESS)
now says.

### Critical

**F-C1 · `AssessmentCompleted` had two contradictory definitions.**
§21/§24 fired it per scored attempt (including ungraded CUSTOM); §43/§60 said it "only fires once both
RIASEC and SCCT are SCORED" with a two-result payload; §44 used it for a per-attempt notification while
§60 listed no Platform subscriber. Phase 3 and Phase 4, built by the letter of their respective
sections, would not have interoperated — and the §24 reading would have triggered recommendation
generation off a reflection survey.
**Resolution (v1.2):** the event fires once per scored attempt, any category. The both-results-exist
check lives in the `DispatchRecommendationGeneration` listener, which alone decides whether to dispatch
`GenerateRecommendationJob`. Platform module added as a subscriber for the per-attempt notification.
Updated: §11, §24, §43, §60.

### High

**F-H1 · Cross-class student identity had no resolution mechanism.**
§13.2 promised "a student's full class history is every row where `student_id` matches," but the only
account-creation path is per-class roster provisioning with no dedup or "attach existing student" step
— the same real person re-provisioned next year silently becomes a second, unrelated account with
fragmented assessment history.
**Resolution (v1.2):** scoped honestly — v1 identity is per provisioning batch, stated as an accepted
limitation in §13.2; the "attach existing student" flow is deferred with an explicit trigger in §63.

**F-H2 · `assessment_dimensions` escaped the immutability rule.**
Dimensions are template-scoped children, so "a published version and its child rows are immutable" did
not cover them — yet `question_dimensions`, `dimension_scores`, and the Holland-code derivation all
hang off them. A post-publish edit to `interpretation_ranges` or `name` could silently change what
historical results mean and how future attempts on a published version score.
**Resolution (v1.2):** the **dimension freeze rule** — dimension rows become immutable (no edits, no
deletes) from the moment any version of their template is PUBLISHED, enforced in the Service layer like
version immutability. No schema change needed. Updated: §12, §13.4, §25; QUICKREF Never-list.

**F-H3 · Student token lifecycle unspecified; revocation-on-removal missing in spec *and* code.**
No Sanctum TTL anywhere in Part X; code expiry/rotation only gates *new* joins; verified that
`ClassEnrollmentService::removeStudent()` revokes nothing — a removed student's live token survived
their removal, in a model where "the class code is the entire secret."
**Resolution (v1.2):** §38 control table now requires: token expiry (hours, not days), token
replacement on join (was already built, now ratified), **revocation on removal from class**, and a
middleware-layer active-status check. Code fix tracked as an open item in PROGRESS (the one place
built code lags the plan) — to be done alongside Phase 1 frontend.

**F-H4 · The stack's biggest feasibility risk was not in the Risk Register.**
Laravel has no first-party driver for Cloudflare D1/Queues/KV, and §8's "Cloudflare-fronted
server/Worker gateway" was undefined. Phases 0–4 run on local SQLite, so the risk would have stayed
invisible until weeks 8–11.
**Resolution (v1.2):** new top-line Risk Register entry (High/High) + a mandatory, timeboxed
**Cloudflare integration spike** in Phase 2 (§57) with a written go/no-go in PROGRESS; fallback
(conventional PHP host behind Cloudflare edge, cloud services via REST) decided in week 4, not week 10.

**F-H5 · Scoring undefined for unanswered optional questions and the `EXPIRED` state.**
§24's pseudocode dereferenced a possibly-null answer and inflated `max` with unanswered optional
questions, deflating normalized scores; `EXPIRED` existed as a status with no trigger defined; nothing
prevented parallel attempts.
**Resolution (v1.2):** prorating — an unanswered optional question contributes to neither `raw` nor
`max`; an all-skipped dimension produces no `DimensionScore` row; required questions block submission.
`EXPIRED` defined (attempt still `IN_PROGRESS` at assignment close, or counselor reset). One attempt
per assignment per student (unique constraint); retake = counselor reset. Updated: §13.5, §15, §21,
§24, §27.

**F-H6 · The PROGRESS→FULLPLAN governance loop invited reversion of correct decisions.**
PROGRESS's "plan wins, this file is stale" rule coexisted with a "Decisions taken" list containing
choices *better* than the plan (failures-only throttle; cache-based lockout). A dutiful future
contributor would have been instructed to revert good code.
**Resolution (v1.2):** all Phase 0/1 decisions ratified into the plan (revision note 7 + §12, §13.2,
§19, §20, §38, §41); PROGRESS's list re-headed as history.

### Medium

| # | Finding | Resolution (v1.2) |
|---|---|---|
| F-M1 | SCCT Career Confidence Index round-tripped through a formatted string (`overall_summary`) into the recommendation engine | `overall_summary` is display-only; every consumer recomputes from `dimension_scores` + `scoring_config` (§23, §27) |
| F-M2 | `COUNSELOR_PRIVATE` knowledge visibility had no endpoints and no retrieval-scoping rule — a leak waiting to happen | Deferred to §63; v1 knowledge is `GLOBAL` only (§13.7, §30) |
| F-M3 | `DELETE /knowledge-documents` contradicted "archive, don't delete"; no Vectorize cleanup spec; `ai_requests` provenance referenced deletable chunks | Archive semantics: `archived_at` column; vectors removed from Vectorize at archive time (structurally unretrievable); D1 rows retained for provenance (§13.7, §20, §30) |
| F-M4 | Join-throttle spec self-contradictory across §19/§38/§41 (per-code vs per-code+IP; the promised code-level freeze + counselor notify could never fire as specified) | Canonical: failures-only per `(code, IP)`; counselor alert redefined as an audit-derived cross-IP signal (§19, §38, §41) |
| F-M5 | Student profile completion (GWA/strand — Phase 4's required input) was no phase's deliverable | Assigned to Phase 3 (§57) |
| F-M6 | Retake/attempt policy unspecified; "latest result" ambiguous | One attempt per assignment (unique constraint); "latest" defined (§13.5, §21, §27) |
| F-M7 | Catalog gaps: no admin `GET /dashboard` despite §37; `POST /ai/explain` was an "internal" endpoint in a public catalog; `ai_policies` creation unexplained | Dashboard added; `/ai/explain` removed (internal = queued job); ai_policies row is seeded, no create endpoint by design (§20) |
| F-M8 | Roster name-parsing contract unspecified; `last_name NOT NULL` made mononyms a 422 (the tracked "Madonna" bug) | Parsing contract defined in §16 (first token = first name, rest = last name, single token legal); `last_name` nullable (§13.1). Follow-up migration + UI rendering tracked in PROGRESS |
| F-M9 | Doc drift: §19 `/student/join` vs §20 `/student-access/join`; §47 said Pest (reality: PHPUnit 11); QUICKREF said ~94 endpoints vs plan's ~92 | All corrected (§19, §47; QUICKREF); instructions.md Open Question closed |

### Low

| # | Finding | Resolution |
|---|---|---|
| F-L1 | `class_students` broke §12's "every table has `created_at`" | Exception stated in §12 (ratified — `joined_at`/`removed_at` are the lifecycle) |
| F-L2 | `dimension_scores (attempt_id, dimension_id)` was a plain index | Now unique (§15) |
| F-L3 | `$table->enum()` is TEXT+CHECK on SQLite but native ENUM on MySQL — portability trap | Convention note added to instructions.md |
| F-L4 | Frontend had two competing homes for API calls (`src/services/` vs `features/*/api/`) | Division of labor defined: services = HTTP clients, feature api/ = TanStack Query hooks (§35) |
| F-L5 | Unauthenticated `/health` exposes component status | Stated as deliberate + terse-by-design (§53) |
| F-L6 | No mention of RA 10173 despite psychological data on minors | Regulatory-context paragraph added (§40) |
| F-L7 | Counselor activation flow (`status = pending` default) unspecified | Clarified: admin-created counselors are `active` + `must_change_password`; `pending` reserved (§13.1) |

---

## 3. Scores (as of this audit)

- **Architecture Health: 84 / 100** (pre-v1.2). Strong right-sizing, explicit tradeoffs,
  worked-example test oracles, and a well-designed confirmation gate; deductions for F-C1 (−5),
  F-H2 (−4), F-H1 (−3), F-H4 (−2), accumulated Medium gaps (−2). With v1.2 applied, the known
  residual is implementation risk, not spec risk.
- **Implementation Progress: 21 / 100** — share of planned v1 scope delivered (Phase 0 + Phase 1
  backend done; Phase 1 frontend and Phases 2–6 not started; Phases 3–5 are the bulk of the work).
- **Implementation Fidelity: ~95 / 100** — verified against plan and a live test run; sole gap is
  F-H3's missing token revocation.

## 4. Prioritized actions (state after v1.2)

1. ~~Resolve F-C1 event semantics~~ — **done in v1.2**
2. ~~Specify the dimension freeze (F-H2)~~ — **done in v1.2** (enforcement lands with Phase 3 code)
3. **F-H3 code fix** — revoke tokens in `removeStudent()`, set student token TTL, middleware
   active-check → open item in PROGRESS, do with Phase 1 frontend
4. ~~Ratify PROGRESS decisions (F-H6) + fix drift (F-M4/M9/L1)~~ — **done in v1.2**
5. ~~Scope cross-class identity (F-H1)~~ — **done in v1.2** (deferred with trigger)
6. **Cloudflare integration spike (F-H4)** — scheduled in Phase 2; go/no-go must be written down
7. ~~Part VI edge cases (F-H5, F-M1, F-M6)~~ — **done in v1.2** (Phase 3 entry gate satisfied)
8. F-M8 follow-through: `last_name` nullable migration + roster UI per-row error rendering

## 5. Roadmap adjustments

- **Phase 1 frontend before Phase 2** (recommendation): the §57 demo is a user walkthrough; the
  roster-builder UX is untested; the mononym bug closes in the UI.
- Phase 2 now carries the **Cloudflare integration spike** (go/no-go gate for Phase 5's approach).
- Phase 3 gained an **entry gate** (satisfied by v1.2) and **student profile completion**.
- Phases 4–6 sequencing unchanged — the dependency ordering was sound.
