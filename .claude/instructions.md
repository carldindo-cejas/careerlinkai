# CareerLinkAI — Development Guidelines

## The Decision Rule

**`FULLPLAN.md` is the primary design reference, but it is no longer an unquestionable single source
of truth.** It captures the system as originally planned and remains the default when nothing better
is on the table. But the project has grown past a frozen plan: new requirements arrive through user
prompts, and some of them improve on what FULLPLAN specifies.

When a user prompt and FULLPLAN.md **agree** (or FULLPLAN is silent and the prompt is sound), follow
the prompt and keep the design consistent with FULLPLAN's conventions.

When they **differ or collide**, do not reflexively defer to FULLPLAN. Instead:

1. Analyze whether the user prompt genuinely improves the system — think about the *future* of the
   system, not just the immediate task: maintainability, scalability, data integrity, and consistency
   with the existing architecture.
2. If the prompt is a clear improvement, choose it — even where it overrides FULLPLAN — and note the
   deviation so FULLPLAN can be reconciled later.
3. If you doubt which is better, or the trade-off is genuinely balanced, **ask the user**
   (AskUserQuestion) rather than guessing.

This file still contains: (a) the working agreement, and (b) invariants that must never be violated.
Concrete details — schema, endpoints, formulas — are looked up in FULLPLAN.md as a reference, not
recalled from memory, but FULLPLAN's specifics can be extended or superseded when a prompt improves
the system.

## Project Overview

**CareerLinkAI** — AI-assisted career & college guidance platform for senior high school students.

- **Stack**: TypeScript on Cloudflare Workers (Hono + Zod + Drizzle/D1) · React 19 + TypeScript (Vite) · Cloudflare (D1, R2, Vectorize, Workers AI, Queues, KV)
- **Database**: 28 tables, 8 modules — see FULLPLAN Part III §13, table index at §62
- **Version**: FULLPLAN v1.4
- **Deployment**: the existing `careerlinkai.online` Worker (API) + `careerlinkai.online` Pages project (frontend)

> **v1.3 pivot (13 Jul 2026):** the backend moved off Laravel. Phases 0–3 were built and verified on
> Laravel (233 tests) and are being **ported** to the Worker stack in Phase 3.5 — the old suite's
> assertions and the unchanged React frontend define the port's contract. Anything under `backend/`
> that is Laravel is the retired implementation, kept only until the port passes on staging.

## Working Agreement

### Implementation order

We follow **FULLPLAN Part XVI §57 — Phases 0 through 6** (vertical slices, each ending in a live
demo). We do *not* use a layered "all migrations, then all models, then all controllers" order across
the whole system; the plan deliberately builds a thin vertical slice per phase.

| Phase | Scope |
|---|---|
| 0 | Foundation — `users`, `counselor_profiles`, `student_profiles`, staff auth, React shell |
| 1 | Class & Enrollment — `classes`, `class_students`, roster builder, passwordless join |
| 2 | Academic Catalog — `colleges`, `programs`, `careers`, `program_careers` |
| 3 | Assessment Engine — 7 assessment tables, `ScoringService`, publish gate |
| **3.5** | **Platform Port (v1.3)** — re-implement Phase 0–3 scope on the Worker stack; blocks Phase 4 |
| 4 | Recommendation Engine — `recommendations`, `RecommendationService` |
| 5a / 5b | AI Layer — RAG explanations, then AI-assisted generation |
| 6 | Polish — notifications, audit dashboards, defense prep |

**Within** a single phase, work bottom-up in layers: migrations → schema types → auth →
policies → services → routes/API → frontend. Finish one layer before starting the next.

### Per-task discipline

- Only work on the phase that was explicitly requested. Never skip ahead. Never start the next phase
  automatically — stop and wait.
- Before coding, state: goal · files affected · dependencies · risks · step-by-step plan.
- Do not invent tables, rename fields, change API contracts, or alter the folder structure *on a
  whim*. Extending the schema or the API is allowed when a user prompt calls for it and the change
  improves the system — but keep it consistent with the existing conventions (UUID PKs, `TEXT`+`CHECK`
  enums, the response envelope, module layout) and record the deviation from FULLPLAN.
- Never simplify the architecture just because it is easier. If a change seems wrong, ask first.
- After each task, report: files created · files modified · what remains · suggested next task.

## Non-Negotiable Invariants

These are the rules a bug in which would break the system's core claims. Know them by heart; look up
everything else.

1. **UUID primary keys.** Every table's `id` is a UUID v4. No auto-increment integers, ever. (§12)
2. **Assessment integrity.** AI may only ever generate/edit `CUSTOM` assessments. RIASEC and SCCT are
   human-authored, always — enforced in the `generateWithAi` policy function at the API layer, as the
   first check, before any other. Not a UI-level courtesy. (§39, §31)
3. **The confirmation gate.** An assessment version cannot reach `status = PUBLISHED` while any of its
   `question_dimensions` rows has `confirmed_at IS NULL`. This is the one rule keeping AI out of the
   scoring-integrity path. (§12, §25)
4. **Published versions are immutable — and so are their dimensions.** Any write to a version with
   `status = PUBLISHED` is rejected in the Service layer. Assignments and attempts always reference an
   `assessment_version_id`, never a template — so editing a template can never retroactively alter a
   student's historical result. `assessment_dimensions` rows are template-scoped, so they get their own
   freeze (v1.2): immutable from the moment any version of their template is published. (§12)
5. **AI policies are database-driven.** Read the active `ai_policies` rows and inject them into every
   prompt. Never hardcode a guardrail. (§29, §32)
6. **Passwordless students, by design.** `users.password IS NULL` for every `role = student` row,
   permanently. Access = class code + per-class username → bearer token (`api_tokens`, §38). The class
   code is therefore the entire secret, which is what makes the compensating controls in §38 mandatory
   rather than optional: per-class-code rate limiting, code expiry, audited attempts, and — critically —
   **identical generic errors** for a wrong code and a wrong username, so the endpoint cannot be used
   to enumerate a roster. (§38)
7. **No cross-class data leakage.** Every route handler touching a specific record calls
   `authorize(...)` against a policy function. Students see only their own data; counselors only their
   own classes. (§39)
8. **The recommendation engine is deterministic.** No AI involvement in scoring or ranking — AI only
   writes the *explanation* of an already-computed result. Never name it in a way that implies
   otherwise. (§26, §55)

## Conventions

Full reference: FULLPLAN §12 (database), §16 (backend structure), §18/§56 (naming), §19 (API),
§35 (frontend). Common trip-ups:

- **No `ENUM` column type** — D1/SQLite has none. Status enums are `TEXT` + a `CHECK` constraint in
  the migration SQL, typed in code as a string-literal union on the Drizzle column. Do not write a
  migration assuming otherwise. (§12)
- **Soft deletes** apply to business entities a user can "remove" (`users`, `classes`, `colleges`,
  `programs`, `careers`, `assessment_templates`) and are **never** used on the attempt → answer →
  result chain — that data is permanent historical evidence, archived via `status`, not deleted. (§12)
- **There are no model classes** — `src/db/schema.ts` is the single typed definition of every table;
  row types are Drizzle's `$inferSelect`. (§16)
- **Routes** live in `src/modules/{module}/routes.ts`, mounted under `/api/v1/`, kebab-case plural
  nouns. (§16, §17, §19)
- **Envelope**: every response uses the standard `success`/`message`/`data`/`meta` shape. (§19)
- **Terminology is enforced** (§55): Assessment (not Exam/Test) · College Program (not Course) ·
  Dimension (not Trait/Factor) · Class Code (not Invite Code) · Confirmed Mapping (it is the *mapping*
  that gets confirmed, not the question).

## Architectural Patterns

Decided in FULLPLAN §17 — do not introduce alternatives:

- **Route handlers are thin**: validate via the endpoint's Zod schema → call *one* Service method →
  return the serialized envelope.
- **Business logic lives in Services.**
- **No Repository layer** — Drizzle queries inside Services *are* the repository. **No Action
  classes.** **No DTOs** for internal calls (the Zod-parsed, typed payload is passed straight to the
  Service); DTOs appear only at the `AiGatewayService` boundary.
- **Exactly four events** (§11) — in-process dispatcher, not one event per state change.
- **Background jobs** are Cloudflare Queues messages consumed by the same Worker's `queue()` handler
  (§42) — never `waitUntil` fire-and-forget for anything that must not be lost.
- **Policies are mandatory** on every handler touching another user's data or a scoping rule.

## Testing

- **Backend**: Vitest via `@cloudflare/vitest-pool-workers` — tests run inside workerd against real
  local D1/KV/R2/Queues bindings; only Workers AI is stubbed (behind `AiGatewayService`). Heaviest
  investment goes into unit-testing the deterministic engines — `ScoringService` and
  `RecommendationService` against the hand-computed worked examples in Part VI/VII, plus the
  confirmation-gate invariant and the username-generation algorithm. Run: `npm test` (in `backend/`)
- **Frontend**: **Vitest** + React Testing Library; a small number of Playwright E2E flows.
- Per-layer expectations: FULLPLAN §50.

## Resolved Questions

- ~~§19 said `/student/join` while §20 and the roadmap said `/student-access/join`~~ — **resolved in
  FULLPLAN v1.2**: §19 now says `/student-access/join`.
- ~~Can Laravel use D1/Queues at all (the Phase 2 spike)?~~ — **resolved by FULLPLAN v1.3**: the
  backend is a Worker; the services are native bindings. Spike closed as superseded.
- No open questions at present; when a new ambiguity in FULLPLAN is found, record it here until the
  plan itself is corrected.

---

**Last Updated**: 2026-07-13 · **Tracks**: FULLPLAN.md v1.4
