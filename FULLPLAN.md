# CareerLinkAI — Master Project Plan

**Project:** CareerLinkAI — AI-Assisted Career & College Guidance Platform for Senior High School Students
**Document Type:** Master Project Plan (single source of truth)
**Version:** 1.4
**Scope:** v1 — Single Institution, RIASEC + SCCT, Cloudflare-native
**Stack:** TypeScript on Cloudflare Workers (Hono) · React 19 + TypeScript · Cloudflare (D1, R2, Vectorize, Workers AI, Queues, KV)

---

## Revision Notes (v1.0 → v1.1)

This revision folds in a full stakeholder clarification round. Six substantive changes vs. v1.0:

1. **`colleges` promoted to a first-class table** (was denormalized text on `programs`) — admin needs real CRUD with programs nested under a college, not a free-text field.
2. **`ai_policies` added** — admin-configurable instructions/restrictions/scope that get injected into every AI prompt, so AI guardrails are database-editable rather than hardcoded.
3. **Student authentication is passwordless by design decision**: class code + per-class username only. `users.username`/`password` no longer apply to students at all — `username` moved to `class_students` (unique per class, not globally), `password` became nullable on `users`. This is a deliberate simplicity-over-security tradeoff, compensated for with rate limiting, code expiry, and audit logging (Part X).
4. **Counselor bulk student provisioning formalized** ("Tinkercad way"): class + join code created first, roster added afterward via paste-a-name-list → preview generated usernames → edit → confirm. No student self-registration exists anywhere in the system.
5. **Strand simplified to a strict two-value enum**: `Academic` / `Technical-Professional`. Affects `student_profiles.strand`, `programs.recommended_strand`, and the recommendation engine's strand-alignment formula (Part VII) — now a coarser but well-defined signal.
6. **AI-assisted exam generation added, scoped hard to `CUSTOM`-category assessments only.** RIASEC and SCCT can never be AI-generated or AI-edited — enforced at the API layer, not just hidden in the UI. A new invariant governs publishing: *no assessment version may publish while any of its `question_dimensions` mappings are unconfirmed by a human* — this applies uniformly to manually-built and AI-generated content, and is what actually keeps AI out of the scoring-integrity path.

Net schema impact: **26 → 28 tables** (still under the 30 cap, 2 in reserve).

---

## Revision Notes (v1.1 → v1.2)

This revision folds in the 13 July 2026 architecture audit (full findings and rationale: `docs/audit/2026-07-13-architecture-audit.md`). No new features — every change either resolves an internal contradiction, closes a specification gap in a not-yet-built phase, or ratifies an implementation decision Phase 0/1 already proved out. Schema impact: no changes to built tables; three column/constraint-level changes to unbuilt ones (`student_profiles.last_name` nullable, `assessment_attempts` unique `(assignment_id, student_id)`, `knowledge_documents.archived_at`). Table count unchanged: 28.

1. **`AssessmentCompleted` semantics unified (was contradictory between §24 and §43/§60):** the event fires once per scored attempt. The "both RIASEC and SCCT complete" check moves into the listener, which dispatches `GenerateRecommendationJob` only when both results exist. The Platform module subscribes for the per-attempt result notification (§11, §24, §43, §44, §60).
2. **Dimension freeze rule:** `assessment_dimensions` rows become immutable once any version of their template is `PUBLISHED` — closing the gap where template-scoped dimensions escaped the version-immutability rule (§12, §13.4, §25).
3. **Student token lifecycle specified:** student Sanctum tokens expire; removing a student from a class revokes their tokens; non-`active` users are rejected at the middleware layer even with a live token (§38).
4. **Scoring edge cases specified:** unanswered non-required questions are excluded from both `raw` and `max` (prorating); the `EXPIRED` attempt state is defined; one attempt per assignment per student, with retake-as-counselor-reset (§13.5, §21, §24).
5. **SCCT composite is recomputed, never parsed:** `overall_summary` is display-only; every consumer recomputes the Career Confidence Index from `dimension_scores` (§23, §27).
6. **`COUNSELOR_PRIVATE` knowledge documents deferred to v2** (§63) — the enum value existed with no endpoints and no retrieval-scoping rule. v1 knowledge is `GLOBAL` only. Knowledge documents are archived, never hard-deleted (§13.7, §20, §30).
7. **Phase 0/1 implementation decisions ratified** (previously recorded only in PROGRESS.md, where the "plan wins" rule put them at risk of reversion): join throttle counts failures only, keyed by `(class code, IP)`; staff lockout uses the cache-backed rate limiter; `class_students` deliberately has no `created_at`/`updated_at`; roster batches cap at 200 names; classes default to `active`; a student join replaces the prior token (§12, §13.2, §38).
8. **Cross-class student identity scoped for v1:** one student account per provisioning batch; linking the same real person across classes/years is explicitly deferred, with the consequence stated rather than implied away (§13.2, §63).
9. **Platform-feasibility risk registered** (Laravel has no first-party Cloudflare D1/Queues driver) with a mandatory, timeboxed integration spike added to Phase 2 (§57, Part XVII).
10. Corrections and clarifications: `/student/join` → `/student-access/join` (§19); CI test runner is PHPUnit, not Pest (§47); admin `GET /dashboard` added and internal `POST /ai/explain` removed from the public catalog (§20); roster name-parsing contract and mononym handling defined (§13.1, §16); student profile completion assigned to Phase 3 (§57); Data Privacy Act note added (§40); frontend API-layer ownership clarified (§35).

---

## Revision Notes (v1.2 → v1.3)

**One change, applied everywhere: the backend is no longer Laravel.** The API is now a **TypeScript Cloudflare Worker** (Hono router, Zod validation, Drizzle ORM over D1), deployed to the existing `careerlinkai.online` Worker; the React frontend continues to deploy to the existing `careerlinkai.online` Cloudflare Pages project. This is a platform decision, not a redesign — **nothing about the product, schema, or API contract changes.**

1. **The Phase 2 Cloudflare integration spike is resolved by decision, not by running it.** The spike existed to answer one question: can Laravel talk to D1/Queues at all (v1.2 note 9, Part XVII)? Instead of proving a framework can reach Cloudflare's services over REST through community drivers, the backend moves *into* the runtime those services are native bindings for. The single largest risk in the v1.2 register disappears structurally; the risk register is rewritten (§59).
2. **What stays exactly the same:** all 28 tables and every column/constraint in Part III; the complete endpoint catalog, envelopes, and status codes in Part V (the already-built React frontend keeps working unchanged); every scoring/recommendation formula (Parts VI–VII); both AI pipelines and the confirmation gate (Part VIII, §25); the two-flow auth model and every §38 compensating control; the four domain events and five background jobs.
3. **What Laravel provided is now first-party, small, and specified:** Sanctum → an `api_tokens` infrastructure table with hashed opaque bearer tokens (same expiry/revocation semantics as v1.2's §38); Eloquent → Drizzle ORM; Form Requests → Zod schemas; Policies → plain policy functions (§39, same rules verbatim); Laravel events → an in-process dispatcher (§11, same four events); Laravel queued jobs → Cloudflare Queues messages consumed by the same Worker (§42); bcrypt → PBKDF2 via WebCrypto (§38).
4. **Tooling:** PHPUnit → Vitest running in the Workers runtime (`@cloudflare/vitest-pool-workers`, real D1/KV/R2/Queues bindings via Miniflare); PHPStan/Pint → `tsc --noEmit` + ESLint/Prettier; `php artisan serve` → `wrangler dev`; migrations → `wrangler d1 migrations` (§45–§48, §50).
5. **Phases 0–3 are ported, not discarded.** They were built and verified on Laravel (233 backend tests passing). Because the API contract and schema are unchanged, the port is a re-implementation against an existing, executable specification — the old suite's assertions define done. A dedicated port step is added to the roadmap before Phase 4 (§57).
6. Earlier revision notes are historical records and are left as written — where they say "Sanctum," "Eloquent," or "Laravel," read them as the mechanisms this revision replaces them with.

---

## Revision Notes (v1.3 → v1.4)

One correction, found during the 13 July 2026 pre-port codebase verification (recorded in PROGRESS.md, deviation D3). No feature, schema, or endpoint changes.

1. **§19 pagination envelope corrected to match the built, frozen contract.** Earlier revisions specified pagination as a `meta.current_page` / `meta.total` / `meta.last_page` block, but the contract as actually built, tested, and documented (`docs/api/`, the frontend's `Paginated<T>` type and its passing test suite) nests it inside `data` as `{ items, pagination: { current_page, per_page, total, last_page } }`. Because v1.3 makes the unchanged React frontend the Phase 3.5 port's invariant (§57), the built shape is canonical and §19's wording was the bug. The Worker port implements the nested shape.

---

## How to Read This Document

This is a single, complete project plan. It is organized into 18 parts. Parts I–II establish *why* and *what*. Parts III–XI define *how* — the actual schema, backend, API, and core algorithms. Parts XII–XVII cover everything needed to run this as a real, gradeable, deployable project: security, DevOps, testing, monitoring, standards, timeline, and risk. Part XVIII is reference material (glossary, event catalog, table index).

Read top to bottom once. After that, use it as a reference — every section stands on its own.

---

## Table of Contents

**Part I — Vision & Foundations**
1. Executive Summary
2. Problem Statement
3. Product Vision & Core Principles
4. User Roles
5. Scope Definition
6. Success Criteria

**Part II — System Architecture**
7. Architecture Style & Rationale
8. Technology Stack
9. High-Level Architecture
10. Domain Module Map
11. Inter-Module Communication

**Part III — Database Design**
12. Database Standards
13. Complete Schema (28 Tables)
14. Entity Relationship Overview
15. Indexing & Constraints

**Part IV — Backend Architecture**
16. Folder Structure
17. Request Lifecycle & Pattern
18. Coding Standards

**Part V — API Specification**
19. API Standards
20. Complete Endpoint Catalog

**Part VI — Assessment Engine**
21. Assessment Lifecycle
22. RIASEC Scoring Algorithm
23. SCCT Scoring Algorithm
24. Generic Scoring Engine Design
25. The Dimension-Mapping Confirmation Gate

**Part VII — Recommendation Engine**
26. Recommendation Philosophy
27. Matching & Scoring Algorithm
28. Worked Example

**Part VIII — AI Architecture**
29. AI Principles
30. RAG Pipeline (Recommendation Explanation)
31. AI-Assisted Assessment Generation Pipeline
32. Prompt Design
33. Knowledge Ingestion Pipeline
34. AI Guardrails & Validation

**Part IX — Frontend Architecture**
35. Stack & Folder Structure
36. State Management
37. Key Screens by Role

**Part X — Security Architecture**
38. Authentication (Two Models)
39. Authorization
40. Data Protection
41. API Security

**Part XI — Background Jobs & Notifications**
42. Queue Architecture
43. Job Catalog
44. Notification System

**Part XII — Deployment & DevOps**
45. Environment Strategy
46. Infrastructure Diagram
47. CI/CD Pipeline
48. Environment Variables

**Part XIII — Testing & QA Strategy**
49. Testing Pyramid
50. Test Types by Layer
51. Thesis Evaluation Methodology

**Part XIV — Monitoring & Observability**
52. Logging Standards
53. Health Checks
54. Metrics

**Part XV — Naming & Terminology Standards**
55. Official Terminology
56. Naming Conventions

**Part XVI — Project Roadmap**
57. Phase Plan (0–6)
58. Milestone Checklist

**Part XVII — Risk Register**
59. Identified Risks & Mitigations

**Part XVIII — Appendices**
60. Domain Events Catalog
61. Glossary
62. Table Quick-Reference Index
63. Deferred / Future Scope (v2+)


# Part I — Vision & Foundations

## 1. Executive Summary

CareerLinkAI is a web platform that helps Senior High School students discover suitable college programs and career paths using validated psychological assessments (RIASEC, SCCT), academic profile data, and a deterministic recommendation engine — explained in plain language by AI, but never decided by AI.

A counselor creates a class (a join code is generated immediately), then builds the roster by pasting a name list — the system proposes usernames, the counselor reviews and edits them, and confirms. Students access the platform with nothing more than the class code and their assigned username — no password exists for students at all, by deliberate design (Part X covers the compensating security controls this requires). Students complete a profile, take RIASEC and SCCT, and receive a ranked set of career, program, and college recommendations with a confidence score and a human-readable AI explanation.

Administrators manage a catalog of real colleges/universities and the programs offered under each, manage global RIASEC/SCCT content, and configure the instructions/restrictions that govern what the AI is allowed to reference and say. Both admins and counselors can create additional custom assessments — either built by hand or AI-assisted from an uploaded document or a plain-language description — but RIASEC and SCCT are permanently excluded from AI generation, and no AI-proposed assessment can publish until a human has explicitly confirmed every question's scoring-dimension mapping.

## 2. Problem Statement

Senior High School students in the Philippines choose a track and strand, later a college program and career path, often with limited, generic, or purely intuition-based guidance. Counselors are typically responsible for large numbers of students and lack tooling to systematically assess interests (RIASEC), self-efficacy (SCCT), and academic fit, then translate that into a ranked, explainable set of options.

Existing tools tend to fall into one of two failure modes:
- **Pure static quizzes** that produce a label ("You are Investigative type") with no connection to actual programs, colleges, or explanation.
- **Pure AI chatbots** that generate plausible-sounding but unverified and irreproducible career advice with no grounding in real assessment data or institutional knowledge.

CareerLinkAI's premise is that neither extreme is trustworthy for something this consequential. Assessment scoring and recommendation ranking must be deterministic, versioned, and reproducible. AI's role is strictly to retrieve relevant knowledge and explain results in natural language, and — for lower-stakes custom assessments only — to help draft content that a human must still fully review before anyone can take it.

## 3. Product Vision & Core Principles

**Vision statement:** Give every Senior High School student access to the kind of structured, evidence-based, explainable career guidance that would otherwise require a specialist counselor and hours of one-on-one time — without replacing the counselor, and without ever pretending the AI "decided" anything.

**Core principles, in priority order:**

1. **Deterministic core, AI periphery.** Every number a student sees (a dimension score, a Holland Code, a match percentage) is computed by ordinary application code with a known formula. AI never touches that computation. AI only explains it afterward, using retrieved, approved knowledge — and, for custom assessments only, helps draft raw content that a human must still approve piece by piece before it can affect any score.
2. **Versioned, immutable history.** Once a student completes an assessment, that attempt, its answers, and its results are permanent historical fact. Editing the question bank later must never retroactively change what a past student's report says. This is achieved by versioning assessment templates and always pointing attempts at a specific immutable version.
3. **Explainability by default.** No recommendation is shown without a reason. "Because your Investigative and Conventional scores were high, and your Math grade is strong" is the minimum bar — never "the AI recommends this."
4. **Archive, don't delete.** Nothing that a student or counselor has ever seen disappears. Colleges, programs, careers, and assessments move to an `archived` status; they are never hard-deleted while historical records reference them.
5. **No AI output enters a scoring path unreviewed.** This is the specific, non-negotiable rule that makes principle #1 actually enforceable once AI-assisted exam creation exists: a `question_dimensions` mapping — the thing that determines what a question actually measures and how heavily — cannot be used until a human has explicitly confirmed it, whether it came from a human typing it directly (auto-confirmed) or from AI proposing it (confirmation required, gate enforced at publish time).
6. **Right-sized architecture.** Every pattern, table, and abstraction earns its place by solving a problem that exists today — not a problem that might exist if the platform becomes a 10-school SaaS product. That future is not foreclosed (see Part XVIII §63), but it is not built prematurely.

## 4. User Roles

| Role | Who | Core capabilities |
|---|---|---|
| **Administrator** | School registrar / guidance head / platform owner | Manages the catalog of colleges and their programs, manages global RIASEC/SCCT assessment templates, manages AI policy configuration (instructions/restrictions), uploads knowledge documents, creates counselor accounts, may create custom assessments (manually or AI-assisted), views institution-wide dashboards, reviews audit logs |
| **Counselor** | Guidance counselor | Creates classes (join code generated immediately), builds rosters via bulk name-list entry with a preview-and-edit step before accounts are created, assigns assessments to a class, views results and recommendations for their own students only, creates private (counselor-scoped) custom assessments — manually or AI-assisted, RIASEC/SCCT never AI-assisted |
| **Student** | Senior High School student | Accesses a class using the class code + their assigned username — no password. Completes a profile, takes assigned assessments, views their own results, recommendations, and AI explanations, receives notifications |

Authorization is enforced at two levels: **role** (what type of action is allowed at all) and **ownership** (a counselor may only see students inside their own classes; a student may only see their own data). This is implemented through policy functions in the authorization layer, not a database permission matrix — see Part X.

## 5. Scope Definition

### In scope for v1

- Three roles with role + ownership-based authorization
- Single institution (no multi-tenancy in v1 — see §63); the **catalog** of colleges/universities and their programs is many-institution by nature and is admin-managed from day one — this is not the same thing as multi-tenancy, and was not deferred
- Class creation with immediate join-code generation, bulk roster provisioning via a preview-then-confirm workflow, passwordless student access
- Academic catalog: `colleges` (real external institutions), `programs` nested under a college, `careers`, program↔career mapping — all admin-managed
- Admin-configurable AI policy (instructions/restrictions/scope injected into every AI prompt)
- Two globally-curated assessment types: **RIASEC** and **SCCT**, built on one generic, config-driven assessment engine, manually authored and edited only — never AI-generated or AI-edited
- Custom assessments (admin or counselor-scoped), buildable manually **or** AI-assisted (upload PDF/DOCX, or describe in plain language) — with a mandatory human confirmation gate on every scoring-dimension mapping before publish
- Full assessment lifecycle: template → version → publish → assign → attempt → answer → auto-score → result
- Deterministic recommendation engine producing ranked career, program, and (derived) college matches with a numeric confidence score and a stated reason
- AI explanation layer (Cloudflare Workers AI + RAG) that turns the deterministic result into a natural-language explanation, grounded in an admin-curated knowledge base and governed by admin-configured AI policy
- Knowledge document upload (PDF/DOCX) → text extraction → chunking → embedding → retrieval
- In-app notifications
- Audit logging of critical actions, including every student class-access attempt (success and failure)
- Basic dashboards for each role, computed live from operational data

### Explicitly out of scope for v1

- Multi-school / multi-tenant support (one high school runs the platform; this is unrelated to the many-college catalog, which is in scope)
- Departments as a normalized table (still denormalized text on `programs`, same reasoning as v1.0)
- Fine-grained, admin-configurable permission system (roles are fixed at 3)
- Optional student passwords (the class-code model is the only student access method in v1 — see §63 for the upgrade path if this proves insufficient)
- Email/SMS/push notification channels (in-app only)
- Assessment resume/autosave history beyond current-state persistence
- Scholarship, internship, or resume-builder modules
- Machine-learning-based (as opposed to rule-based) recommendation ranking
- A dedicated analytics/event-sourcing warehouse (dashboards are live-queried)
- AI-assisted generation or editing of RIASEC/SCCT content, under any circumstance, ever, in v1 or any deferred future scope — this is a permanent architectural rule, not a temporary limitation
- Support for AI providers other than Cloudflare Workers AI, or vector stores other than Cloudflare Vectorize

Every deferred item above has a stated "bring it back when..." trigger in Part XVIII §63 — nothing is dropped silently.

## 6. Success Criteria

The v1 build is considered complete and successful when:

1. A seeded counselor account can create a class (receiving a join code immediately), paste a list of student names, preview and edit the generated usernames, and confirm — producing real, working student accounts.
2. A seeded student can access that class using only the join code and their assigned username (no password), complete a profile, and take both a RIASEC and an SCCT assessment end to end.
3. On submission, the system computes dimension scores and an overall result with zero manual intervention, in under 2 seconds for a 60-question assessment.
4. The recommendation engine produces a ranked list of at least 3 career matches and 3 program matches (with their real college attached via `college_id`), each with a confidence score and a stated deterministic reason, without calling AI.
5. Requesting an explanation for a recommendation returns an AI-generated paragraph that references specific retrieved knowledge chunks and respects the admin-configured AI policy, within an acceptable latency (target: under 8 seconds).
6. An administrator can upload a PDF, and within a reasonable processing window it becomes retrievable by the AI explanation pipeline.
7. A counselor can create a custom assessment via AI-assisted generation (document upload or description), and the system correctly refuses to publish it until every proposed question-dimension mapping has been explicitly confirmed by the counselor.
8. Attempting the same AI-assisted generation flow against a RIASEC or SCCT template is rejected by the backend, not just hidden by the UI.
9. All of the above is demonstrable in a single continuous walkthrough, with an audit log showing the trail of actions taken, including student access attempts.

---

# Part II — System Architecture

## 7. Architecture Style & Rationale

CareerLinkAI is built as a **modular monolith**: one Cloudflare Worker, one deployable unit, internally organized into domain modules with enforced boundaries (a module may not directly query another module's tables — it goes through that module's service class or listens to an event). The same Worker serves the HTTP API and consumes the background-job queues — one codebase, one deploy.

This is chosen over a "traditional" flat API codebase (all routes/handlers in one pile, which becomes unmaintainable past a certain size) and over microservices / one-Worker-per-module (which would add operational overhead — separate deployments, service bindings, distributed transactions — that a single-team, single-institution v1 does not need and cannot justify).

The modular boundary is a **discipline enforced by code review and folder structure**, not by physical service separation. This gets nearly all the maintainability benefit of microservices with none of the deployment complexity, and it leaves a real, documented path to extraction later if a specific module (most likely AI, or Analytics) ever needs to scale independently.

## 8. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Backend runtime | Cloudflare Workers (TypeScript) | One Worker: HTTP API + queue consumers |
| Backend framework | Hono | Router + middleware; Workers-native, tiny |
| Validation | Zod | One schema per write endpoint (replaces Form Requests) |
| Data access | Drizzle ORM (D1 driver) | Typed queries; migrations via `wrangler d1 migrations` |
| Frontend framework | React 19 + TypeScript | Vite build |
| Styling | Tailwind CSS + shadcn/ui | |
| Server state | TanStack Query | |
| Client state | Zustand | Auth, theme, UI-only state |
| Forms | React Hook Form + Zod | |
| Relational database | Cloudflare D1 (SQLite dialect) | Native binding |
| Object storage | Cloudflare R2 | PDFs, DOCX, generated reports — native binding |
| Vector search | Cloudflare Vectorize | Knowledge embeddings only — never stored in D1 |
| AI inference | Cloudflare Workers AI | Sole provider for v1 — native binding |
| Background jobs | Cloudflare Queues | Producer + consumer in the same Worker |
| Cache / rate limiting | Cloudflare KV | Rate-limit counters, lockouts; Miniflare emulates locally |
| Auth | First-party token service | Hashed opaque bearer tokens in an `api_tokens` table, for both staff and (passwordless-issued) student sessions — see Part X §38 |
| CI/CD | GitHub Actions + Wrangler | |
| Hosting (frontend) | Cloudflare Pages — existing `careerlinkai.online` project | |
| Hosting (backend) | Cloudflare Workers — existing `careerlinkai.online` Worker | |

## 9. High-Level Architecture

```
                              Users (Admin / Counselor / Student)
                                          │
                                          ▼
                              React Frontend (Cloudflare Pages)
                                          │
                                        HTTPS
                                          │
                                          ▼
                              Cloudflare Edge (DNS, CDN, WAF)
                                          │
                                          ▼
                              API Worker  (/api/v1)
     ┌───────────────┬───────────────┬───────────────┬───────────────┬───────────────┐
     ▼               ▼               ▼               ▼               ▼               ▼
Identity &      Academic         Class &         Assessment      Recommendation      AI
Access          Catalog          Enrollment       Engine           Engine          Module
Modules         (Colleges/       Module
                Programs/
                Careers)
     └───────────────┴───────┬───────┴───────────────┴───────────────┴───────────────┘
                              ▼
                     Cloudflare D1 (business data)
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
     Cloudflare R2      Cloudflare Vectorize   Cloudflare Queues
     (documents)        (embeddings)           (background jobs)
                                                       │
                                                       ▼
                                             Cloudflare Workers AI
```

## 10. Domain Module Map

CareerLinkAI is organized into 8 backend modules. Each owns its own tables, its own Service class(es), and its own routes file.

| Module | Owns tables | Responsibility |
|---|---|---|
| **Identity & Access** | `users`, `counselor_profiles`, `student_profiles` | Staff auth (email+password), student passwordless access, profile data |
| **Class** | `classes`, `class_students` | Class creation, join-code lifecycle, bulk roster provisioning, per-class usernames |
| **Academic Catalog** | `colleges`, `programs`, `careers`, `program_careers` | Real-institution catalog: colleges, their programs, careers, and the mapping between them |
| **Assessment** | `assessment_templates`, `assessment_versions`, `assessment_dimensions`, `assessment_questions`, `question_options`, `question_dimensions`, `assessment_assignments` | Assessment design, versioning, publishing, assignment, dimension-mapping confirmation |
| **Attempt & Results** | `assessment_attempts`, `assessment_answers`, `dimension_scores`, `assessment_results` | Student attempt lifecycle and deterministic scoring |
| **Recommendation** | `recommendations`, `recommendation_explanations` | Deterministic matching + AI explanation storage |
| **AI / Knowledge** | `knowledge_documents`, `knowledge_chunks`, `ai_requests`, `ai_policies` | RAG pipeline, document ingestion, AI gateway, AI-assisted exam generation, admin-configurable AI governance |
| **Platform** | `notifications`, `audit_logs` | Cross-cutting: notifications, audit trail |

This gives **28 domain tables** total (plus infrastructure tables — `api_tokens`, `password_reset_tokens` — which are not counted as part of the domain schema, see §13.1). The full column-level definition of every table is in Part III §13.

## 11. Inter-Module Communication

Two communication patterns are used, deliberately kept to just two:

1. **Direct service call** — the default. E.g., `RecommendationService` calls `AssessmentResultService::getLatestResult($studentId)` directly. Synchronous, used when the caller needs the answer immediately.
2. **Domain event** — an in-process dispatcher (a small typed pub/sub module, not an external broker), used only for the handful of cross-cutting reactions that should not block the triggering request. A listener that needs real async work enqueues a Cloudflare Queues message (§42). There are exactly four events in v1:
   - `AssessmentCompleted` → fired once per scored attempt (any category). Its listeners send the result notification and — only once both a RIASEC and an SCCT result exist for the student — dispatch recommendation generation (queued). The both-complete check lives in the listener, not the event (v1.2)
   - `RecommendationGenerated` → triggers a notification + audit log entry
   - `KnowledgeDocumentProcessed` → triggers a notification to the uploading admin
   - `AssessmentDraftGenerated` → triggers a notification to the admin/counselor that an AI-assisted exam draft is ready for review

No module queries another module's tables directly. This rule is enforced in code review, not by physical database separation (all 28 tables live in one D1 database).


# Part III — Database Design

## 12. Database Standards

These rules apply to every table without exception:

- **Primary keys:** UUID (v4), column name `id`. No auto-increment integers, ever — this keeps IDs safe to expose in URLs and keeps the door open for future distributed/offline scenarios.
- **Foreign keys:** named `<singular_entity>_id` (e.g., `student_id`, `class_id`). Always indexed.
- **Table names:** lowercase, plural, `snake_case` (e.g., `assessment_attempts`).
- **Column names:** lowercase, `snake_case`.
- **Timestamps:** every table has `created_at`; mutable tables also have `updated_at`. Both `CURRENT_TIMESTAMP` default. (One deliberate exception, ratified v1.2: `class_students`, whose lifecycle is fully captured by `joined_at`/`removed_at` — §13.2.)
- **Soft deletes:** used on business entities a user can "remove" (`users`, `classes`, `colleges`, `programs`, `careers`, `assessment_templates`). **Never used** on the attempt → answer → result chain — that data is permanent historical evidence by design, and is archived at the application-status level (`status = ARCHIVED`), not deleted.
- **Booleans:** prefixed `is_`, `has_`, or `can_` where used; otherwise lifecycle state is modeled as an explicit `ENUM`/status column rather than a boolean, whenever more than two states are possible over the entity's life.
- **JSON columns:** allowed only for configuration/formula data that is not itself a queryable business entity (e.g., `scoring_config`, `interpretation_ranges`). Never used for core business fields like names, scores, or relationships — those stay relational.
- **Status enums:** implemented as SQLite `TEXT` + a TypeScript string-literal union type (with the Drizzle column typed to that union) + `CHECK` constraint (D1/SQLite has no native `ENUM` type — this is stated explicitly here so no migration is written assuming otherwise).
- **Versioned entities:** `assessment_templates` → `assessment_versions`. A **published** version is immutable (enforced in the Service layer: any write attempt against a version with `status = PUBLISHED` is rejected). All downstream references (`assessment_assignments`, `assessment_attempts`) always point at a specific `assessment_version_id`, never at the template — so editing a template after students have taken it can never alter their historical results.
- **The dimension freeze rule (new in v1.2):** `assessment_dimensions` rows are *template*-scoped, so version immutability alone does not cover them — yet `question_dimensions`, `dimension_scores`, and the Holland-code derivation all hang off them. Therefore: from the moment any version of a template is `PUBLISHED`, that template's dimension rows are frozen (no edits to `code`, `name`, `description`, `interpretation_ranges`; no deletes), enforced in the Service layer exactly like version immutability. Without this, a post-publish dimension edit could silently change what historical results mean and how future attempts on an already-published version score.
- **The dimension-mapping confirmation invariant (new in v1.1):** a version cannot move to `status = PUBLISHED` while any `question_dimensions` row belonging to it has `confirmed_at IS NULL`. This is the single rule that keeps AI-assisted content out of the scoring-integrity path — see Part VI §25 for full mechanics.

## 13. Complete Schema (28 Tables)

Grouped by owning module, in migration order.

### 13.1 Identity & Access Module

**`users`**

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | UUID | No | — | PK |
| name | VARCHAR(150) | No | — | Full display name |
| email | VARCHAR(255) | Yes | NULL | Unique when present (multiple NULLs allowed — students routinely have none) |
| password | VARCHAR(255) | Yes | NULL | Hashed (PBKDF2-SHA256 via WebCrypto — see Part X §38). **Only ever set for admin/counselor.** Always NULL for students — passwordless by design, see Part X §38 |
| role | TEXT (enum) | No | — | `admin` \| `counselor` \| `student` |
| status | TEXT (enum) | No | `pending` | `pending` \| `active` \| `inactive` \| `suspended` |
| must_change_password | BOOLEAN | No | `false` | Staff-only: forces a password change on first login after admin-issued temp password. Not applicable to students |
| email_verified_at | TIMESTAMP | Yes | NULL | Staff only |
| last_login_at | TIMESTAMP | Yes | NULL | |
| created_at | TIMESTAMP | No | now | |
| updated_at | TIMESTAMP | No | now | |
| deleted_at | TIMESTAMP | Yes | NULL | Soft delete |

Indexes: `email` (unique, nullable), `role`, `status`.

> **Counselor activation (clarified v1.2):** an admin creates a counselor with `status = active` and `must_change_password = true` — the forced password change *is* the activation step. `pending` is reserved for future flows (e.g., email-verified self-registration) and no v1 code path produces it.

> **Change from v1.0:** `username` removed from this table entirely. It is no longer a global identity attribute — see `class_students` below for why.

**`counselor_profiles`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| user_id | UUID | No | FK → users.id, unique |
| first_name | VARCHAR(100) | No | |
| last_name | VARCHAR(100) | No | |
| phone | VARCHAR(30) | Yes | |
| employee_number | VARCHAR(50) | Yes | |
| specialization | VARCHAR(150) | Yes | |
| bio | TEXT | Yes | |
| created_at / updated_at | TIMESTAMP | No | |

**`student_profiles`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| user_id | UUID | No | FK → users.id, unique |
| first_name | VARCHAR(100) | No | |
| last_name | VARCHAR(100) | Yes | Nullable (v1.2): a mononym ("Madonna") is a legitimate name, not a validation error — see the §16 name-parsing contract |
| birthdate | DATE | Yes | |
| gender | VARCHAR(30) | Yes | |
| grade_level | VARCHAR(20) | Yes | e.g. "Grade 11", "Grade 12" |
| strand | TEXT (enum) | Yes | `Academic` \| `Technical-Professional` — strict 2-value model, confirmed |
| gwa | DECIMAL(5,2) | Yes | General weighted average |
| math_grade | DECIMAL(5,2) | Yes | |
| science_grade | DECIMAL(5,2) | Yes | |
| english_grade | DECIMAL(5,2) | Yes | |
| guardian_name | VARCHAR(150) | Yes | |
| guardian_contact | VARCHAR(30) | Yes | |
| created_at / updated_at | TIMESTAMP | No | |

*(Not counted against the 28 — infrastructure tables, new shape in v1.3: **`api_tokens`** `(id UUID PK, user_id FK → users.id, token_hash VARCHAR(64) unique — SHA-256 of the opaque bearer token, the plaintext is shown once and never stored, expires_at TIMESTAMP, last_used_at TIMESTAMP NULL, created_at)`, used for both staff and student token issuance — the first-party replacement for Sanctum's `personal_access_tokens`, with identical semantics required by Part X §38. **`password_reset_tokens`** `(email, token_hash, created_at)` — staff-only in practice, since students have no password to reset.)*

### 13.2 Class Module

**`classes`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| counselor_id | UUID | No | FK → users.id |
| name | VARCHAR(150) | No | e.g. "Grade 12 STEM A" |
| academic_year | VARCHAR(20) | No | e.g. "2026-2027" |
| grade_level | VARCHAR(20) | Yes | |
| join_code | VARCHAR(20) | No | Unique, e.g. `ABCD-7284`. **Generated immediately at class creation** — before any roster exists |
| join_code_expires_at | TIMESTAMP | Yes | Defaults to a set window (e.g. +90 days) rather than never-expiring, since the code is now the entire security boundary for student access — see Part X §38. Counselor can regenerate at any time |
| status | TEXT (enum) | No | `draft` \| `active` \| `archived` — new classes default to `active` (ratified v1.2); `DELETE` soft-deletes, `PATCH {status: archived}` archives; a non-`active` class refuses student joins |
| created_at / updated_at | TIMESTAMP | No | |
| deleted_at | TIMESTAMP | Yes | Soft delete |

Indexes: `join_code` (unique), `counselor_id`, `status`.

**`class_students`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| class_id | UUID | No | FK → classes.id |
| student_id | UUID | No | FK → users.id |
| username | VARCHAR(50) | No | **The per-class login handle.** Generated by the roster-builder algorithm (Part IV §16), editable by the counselor before confirmation. Unique per `(class_id, username)`, **not globally unique** — the class code already disambiguates identity, so different classes may reuse the same username with no conflict |
| status | TEXT (enum) | No | `active` \| `removed` |
| joined_at | TIMESTAMP | No | |
| removed_at | TIMESTAMP | Yes | NULL while active |

Unique constraints: `(class_id, student_id)`, `(class_id, username)`. This single table doubles as enrollment history and holds the student's class-scoped login identity — a student's full class history is every row where `student_id` matches, regardless of status. No `created_at`/`updated_at` — `joined_at`/`removed_at` are the lifecycle timestamps, by design (ratified v1.2, the one §12 timestamp exception).

> **v1 identity scope (new in v1.2):** student accounts are created *only* through roster provisioning, and v1 has no mechanism to link a newly pasted name to an existing student account. In practice, the same real person re-provisioned in a later class or school year gets a **fresh `users` row**, and their assessment history does not carry across. This is an accepted, stated v1 limitation — not a bug — and it means "a student's full class history" above is per *account*, not per *person*. The "attach existing student" flow that would change this is deferred with an explicit trigger in §63.

> **Change from v1.0:** `username` moved here from `users`. This is a deliberate architectural decision, not a workaround: the counselor's entire provisioning workflow (paste names → preview usernames → edit → confirm) happens *in the context of one class*, so the username genuinely is a property of "this student, in this class," not a property of the person's platform-wide identity.

### 13.3 Academic Catalog Module

**`colleges`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| name | VARCHAR(200) | No | e.g. "University of Santo Tomas" — a real external institution |
| description | TEXT | Yes | |
| status | TEXT (enum) | No | `active` \| `archived` |
| created_at / updated_at | TIMESTAMP | No | |
| deleted_at | TIMESTAMP | Yes | Soft delete |

> **New in v1.1.** Was deferred in v1.0 as denormalized text on `programs`; promoted to a real table because admin needs genuine CRUD with programs nested underneath, not a free-text field that silently drifts (misspellings, inconsistent naming) across many program rows.

**`programs`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| college_id | UUID | No | FK → colleges.id — **replaces the v1.0 `college_name` text field** |
| code | VARCHAR(30) | No | e.g. "BSCS" |
| name | VARCHAR(200) | No | e.g. "BS Computer Science" |
| department_name | VARCHAR(200) | Yes | Still denormalized text — departments remain deferred (§63), unaffected by the colleges change |
| description | TEXT | Yes | |
| recommended_strand | TEXT (enum) | Yes | `Academic` \| `Technical-Professional` — NULL = no strand requirement. Used by the Recommendation Engine, Part VII |
| status | TEXT (enum) | No | `draft` \| `active` \| `archived` |
| created_at / updated_at | TIMESTAMP | No | |
| deleted_at | TIMESTAMP | Yes | Soft delete |

**`careers`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| title | VARCHAR(150) | No | e.g. "Software Engineer" |
| description | TEXT | Yes | |
| salary_range | VARCHAR(100) | Yes | Free text, e.g. "PHP 30,000 - 80,000/mo" |
| employment_outlook | VARCHAR(100) | Yes | e.g. "High demand" |
| typical_riasec_code | VARCHAR(6) | Yes | e.g. "IEC" — used directly by the recommendation engine, see Part VII |
| status | TEXT (enum) | No | `active` \| `archived` |
| created_at / updated_at | TIMESTAMP | No | |
| deleted_at | TIMESTAMP | Yes | Soft delete |

**`program_careers`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| program_id | UUID | No | FK → programs.id |
| career_id | UUID | No | FK → careers.id |

Unique constraint: `(program_id, career_id)`.

### 13.4 Assessment Module

**`assessment_templates`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| creator_id | UUID | No | FK → users.id |
| category | TEXT (enum) | No | `RIASEC` \| `SCCT` \| `CUSTOM` — **RIASEC/SCCT are permanently excluded from AI-assisted creation/editing at every layer, not just by convention** |
| title | VARCHAR(200) | No | |
| description | TEXT | Yes | |
| ownership | TEXT (enum) | No | `GLOBAL` \| `COUNSELOR_PRIVATE` |
| status | TEXT (enum) | No | `DRAFT` \| `ACTIVE` \| `ARCHIVED` |
| created_at / updated_at | TIMESTAMP | No | |
| deleted_at | TIMESTAMP | Yes | Soft delete |

**`assessment_versions`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| assessment_template_id | UUID | No | FK |
| version_number | INTEGER | No | Starts at 1, increments per template |
| instructions | TEXT | Yes | |
| duration_minutes | INTEGER | Yes | Suggested time limit, informational |
| scoring_config | JSON | No | Formula/weights for this version — see Part VI §24 |
| status | TEXT (enum) | No | `DRAFT` \| `PUBLISHED` \| `ARCHIVED` |
| created_by | UUID | No | FK → users.id |
| created_at | TIMESTAMP | No | |

Unique constraint: `(assessment_template_id, version_number)`. **Immutability rule:** once `status = PUBLISHED`, no column on this row or any child row may be edited — only a new version may be created. **Publish is additionally blocked** while any child `question_dimensions` row is unconfirmed (§12, mechanics in Part VI §25).

**`assessment_dimensions`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| assessment_template_id | UUID | No | FK |
| code | VARCHAR(10) | No | e.g. "R", "I", "A", "S", "E", "C" for RIASEC |
| name | VARCHAR(100) | No | e.g. "Investigative" |
| description | TEXT | Yes | |
| interpretation_ranges | JSON | Yes | e.g. `[{"min":0,"max":33,"label":"Low"}, ...]` |
| created_at | TIMESTAMP | No | |

> **Frozen after first publish (v1.2):** these rows become immutable the moment any version of their template is `PUBLISHED` — see the dimension freeze rule in §12.

**`assessment_questions`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| assessment_version_id | UUID | No | FK |
| question_text | TEXT | No | |
| question_type | TEXT (enum) | No | `LIKERT` \| `MULTIPLE_CHOICE` \| `BOOLEAN` |
| section_label | VARCHAR(100) | Yes | Optional grouping label — replaces a full sections table for v1 |
| order_number | INTEGER | No | |
| required | BOOLEAN | No | Default true |
| source | TEXT (enum) | No | `MANUAL` \| `AI_GENERATED` — new in v1.1, provenance tracking |
| source_ai_request_id | UUID | Yes | FK → ai_requests.id. Set only when `source = AI_GENERATED`; NULL otherwise |
| created_at | TIMESTAMP | No | |

**`question_options`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| question_id | UUID | No | FK |
| label | VARCHAR(150) | No | e.g. "Strongly Agree" |
| value | VARCHAR(50) | No | Machine value, e.g. "5" |
| score | DECIMAL(5,2) | No | Numeric score this option contributes |
| order_number | INTEGER | No | |

**`question_dimensions`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| question_id | UUID | No | FK |
| dimension_id | UUID | No | FK → assessment_dimensions.id |
| weight | DECIMAL(4,2) | No | Default 1.00; supports a question loading onto more than one dimension |
| confirmed_at | TIMESTAMP | Yes | **New in v1.1 — the confirmation gate.** NULL means unconfirmed (only possible for AI-proposed mappings). Manual creation flows set this immediately on insert. A version cannot publish while any of its mappings have `confirmed_at IS NULL` |
| confirmed_by | UUID | Yes | FK → users.id — who confirmed it (always populated once `confirmed_at` is set) |

**`assessment_assignments`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| assessment_version_id | UUID | No | FK — must be a PUBLISHED version |
| class_id | UUID | No | FK |
| assigned_by | UUID | No | FK → users.id |
| deadline | TIMESTAMP | Yes | |
| status | TEXT (enum) | No | `ACTIVE` \| `CLOSED` |
| created_at | TIMESTAMP | No | |

### 13.5 Attempt & Results Module

*No soft deletes anywhere in this module — see §12.*

**`assessment_attempts`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| assignment_id | UUID | No | FK |
| assessment_version_id | UUID | No | FK — denormalized copy for fast lookups even if assignment is later closed |
| student_id | UUID | No | FK → users.id |
| status | TEXT (enum) | No | `IN_PROGRESS` \| `SUBMITTED` \| `SCORED` \| `EXPIRED` |
| started_at | TIMESTAMP | No | |
| submitted_at | TIMESTAMP | Yes | |
| created_at / updated_at | TIMESTAMP | No | |

Unique constraint (v1.2): `(assignment_id, student_id)` — **one attempt per assignment per student.** A retake is a counselor-initiated reset: the existing attempt is marked `EXPIRED` (never deleted) and a fresh attempt may then be started. `EXPIRED` is defined precisely (v1.2): an attempt still `IN_PROGRESS` when its assignment moves to `CLOSED`, or one voided by a counselor reset. Expired attempts are never scored, never feed recommendations, and keep their answers as history.

**`assessment_answers`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| attempt_id | UUID | No | FK |
| question_id | UUID | No | FK |
| selected_option_id | UUID | Yes | FK → question_options.id |
| answer_text | TEXT | Yes | For non-option answer types (not used by RIASEC/SCCT, reserved for CUSTOM) |
| score | DECIMAL(5,2) | No | Copied from the selected option at answer time (immutable snapshot) |
| answered_at | TIMESTAMP | No | |

Unique constraint: `(attempt_id, question_id)` — one answer per question per attempt. Answers are write-once after `attempt.status = SUBMITTED`.

**`dimension_scores`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| attempt_id | UUID | No | FK |
| dimension_id | UUID | No | FK |
| raw_score | DECIMAL(6,2) | No | Sum of weighted answer scores for this dimension |
| normalized_score | DECIMAL(5,2) | No | 0-100 scale, see Part VI |
| interpretation | VARCHAR(50) | Yes | e.g. "High", from the dimension's `interpretation_ranges` |

**`assessment_results`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| attempt_id | UUID | No | FK, unique |
| overall_summary | TEXT | Yes | Short deterministic summary (not AI-generated) |
| result_code | VARCHAR(20) | Yes | e.g. Holland Code "IAS" for RIASEC; generic enough to also hold an SCCT summary code |
| generated_at | TIMESTAMP | No | |

### 13.6 Recommendation Module

**`recommendations`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| assessment_result_id | UUID | No | FK |
| student_id | UUID | No | FK → users.id |
| match_type | TEXT (enum) | No | `CAREER` \| `PROGRAM` |
| target_career_id | UUID | Yes | FK → careers.id (set when match_type = CAREER) |
| target_program_id | UUID | Yes | FK → programs.id (set when match_type = PROGRAM) |
| match_score | DECIMAL(5,2) | No | 0-100 confidence, see Part VII |
| ranking | INTEGER | No | 1 = best match within that type, for that result |
| reason | TEXT | No | Deterministic, rule-based explanation string |
| created_at | TIMESTAMP | No | |

A "recommended college" is now a **real, clean join**: `target_program_id → programs.college_id → colleges`. No separate `college_matches` table or text-matching is needed, and this got more reliable now that `colleges` is a real table rather than free text.

**`recommendation_explanations`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| recommendation_id | UUID | No | FK, unique |
| explanation_text | TEXT | No | AI-generated natural language explanation |
| ai_model | VARCHAR(100) | No | Model identifier used |
| created_at | TIMESTAMP | No | |

Kept as a **separate table from `recommendations`** on purpose — this is the one place in the schema where the deterministic/AI boundary is enforced structurally, not just by convention.

### 13.7 AI / Knowledge Module

**`knowledge_documents`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| uploaded_by | UUID | No | FK → users.id |
| file_name | VARCHAR(255) | No | |
| file_type | VARCHAR(20) | No | `pdf` \| `docx` |
| storage_path | VARCHAR(500) | No | R2 object key |
| processing_status | TEXT (enum) | No | `UPLOADED` \| `PROCESSING` \| `COMPLETED` \| `FAILED` |
| visibility | TEXT (enum) | No | `GLOBAL` — the only value used in v1 (v1.2). `COUNSELOR_PRIVATE` is deferred to §63: it shipped in v1.1 with no counselor upload endpoints and no retrieval-scoping rule, which made it a cross-tenant leak waiting to happen. The column keeps its enum shape so restoring the value later is not a migration |
| archived_at | TIMESTAMP | Yes | New in v1.2 — knowledge documents are **archived, never hard-deleted** (Part I principle #4). On archive: the chunks' vectors are removed from Vectorize (so archived content is structurally unretrievable), while the document row and `knowledge_chunks` content stay in D1 because `ai_requests.input_context` references chunk IDs for provenance |
| created_at / updated_at | TIMESTAMP | No | |

**`knowledge_chunks`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| document_id | UUID | No | FK |
| chunk_number | INTEGER | No | |
| content | TEXT | No | Chunk text (300-800 tokens, per Part VIII) |
| vector_id | VARCHAR(100) | Yes | Pointer into Cloudflare Vectorize — the embedding itself never lives in D1 |
| token_count | INTEGER | Yes | |
| created_at | TIMESTAMP | No | |

**`ai_requests`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| user_id | UUID | Yes | FK → users.id (nullable for system-triggered requests) |
| request_type | TEXT (enum) | No | `RECOMMENDATION_EXPLANATION` \| `ASSESSMENT_GENERATION` \| `CHAT` |
| input_context | JSON | Yes | Retrieved chunk IDs + prompt variables, for auditability |
| response_text | TEXT | Yes | |
| model | VARCHAR(100) | Yes | |
| tokens_used | INTEGER | Yes | |
| latency_ms | INTEGER | Yes | |
| status | TEXT (enum) | No | `SUCCESS` \| `FAILED` |
| created_at | TIMESTAMP | No | |

`request_type = ASSESSMENT_GENERATION` is now actively used (Part VIII §31) rather than reserved. `assessment_questions.source_ai_request_id` points back into this table for full provenance on any AI-generated question.

**`ai_policies`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| scope | TEXT (enum) | No | `GLOBAL` — only value used in v1; the column is designed to extend to finer scopes later (§63) without a schema change |
| instructions | TEXT | Yes | Admin-authored guidance appended to every AI system prompt, e.g. "Always mention that recommendations are not final decisions." |
| restrictions | TEXT | Yes | Admin-authored constraints, e.g. "Never reference documents tagged 'internal-only'." |
| is_active | BOOLEAN | No | Default true. Only active policy rows are injected |
| updated_by | UUID | No | FK → users.id |
| updated_at | TIMESTAMP | No | |

> **New in v1.1.** A deliberately minimal governance table — admin edits plain text, it gets appended to every prompt (Part VIII §32). Not a full prompt-versioning system; that remains deferred (§63).

### 13.8 Platform Module

**`notifications`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| user_id | UUID | No | FK → users.id (recipient) |
| title | VARCHAR(200) | No | |
| message | TEXT | No | |
| category | TEXT (enum) | No | `ASSESSMENT` \| `RECOMMENDATION` \| `CLASS` \| `ACCOUNT` |
| read_at | TIMESTAMP | Yes | NULL = unread |
| created_at | TIMESTAMP | No | |

**`audit_logs`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | No | PK |
| user_id | UUID | Yes | FK → users.id, nullable for system actions or failed/unresolved student join attempts |
| action | VARCHAR(100) | No | e.g. "ASSESSMENT_PUBLISHED", "STUDENT_CLASS_ACCESS_SUCCESS", "STUDENT_CLASS_ACCESS_FAILED" |
| module | VARCHAR(50) | No | e.g. "Assessment" |
| target_type | VARCHAR(100) | Yes | e.g. "assessment_version" |
| target_id | UUID | Yes | |
| old_values | JSON | Yes | |
| new_values | JSON | Yes | |
| ip_address | VARCHAR(45) | Yes | |
| created_at | TIMESTAMP | No | |

Immutable — no application code path ever issues an UPDATE or DELETE against this table. **Now the primary security-monitoring surface for the passwordless student model** — see Part X §38.

## 14. Entity Relationship Overview

```
users --+-- counselor_profiles
        +-- student_profiles

users(counselor) --< classes --< class_students >-- users(student)
                                       │
                              (class_students.username is the
                               per-class login handle)

colleges --< programs --< program_careers >-- careers

users(admin/counselor) --< assessment_templates --< assessment_versions
                                                          |
                                    +---------------------+---------------------+
                                    v                      v                     v
                          assessment_dimensions   assessment_questions   assessment_assignments >-- classes
                                    |                      |
                                    |                      v
                                    |              question_options
                                    |                      |
                                    +------< question_dimensions >------+
                                              (confirmed_at gate)

assessment_assignments --< assessment_attempts >-- users(student)
                                    |
                    +---------------+---------------+
                    v               v               v
          assessment_answers  dimension_scores  assessment_results
                                                        |
                                                        v
                                                 recommendations >-- careers / programs --> colleges
                                                        |
                                                        v
                                          recommendation_explanations

knowledge_documents --< knowledge_chunks   (vector_id -> Cloudflare Vectorize, external)

ai_policies   (standalone config, injected into every AI prompt)

users --< notifications
users --< audit_logs
```

## 15. Indexing & Constraints

**Every foreign key is indexed** — this is a hard rule, not case-by-case.

Additional composite indexes:

| Table | Composite index | Purpose |
|---|---|---|
| `class_students` | `(class_id, student_id)` unique | Enforce single active enrollment record per pair |
| `class_students` | `(class_id, username)` unique | Enforce class-scoped username uniqueness — the login lookup key |
| `assessment_answers` | `(attempt_id, question_id)` unique | Enforce one answer per question |
| `program_careers` | `(program_id, career_id)` unique | Prevent duplicate mappings |
| `assessment_versions` | `(assessment_template_id, version_number)` unique | Enforce version sequencing |
| `assessment_attempts` | `(assignment_id, student_id)` unique | One attempt per assignment per student (v1.2) |
| `dimension_scores` | `(attempt_id, dimension_id)` unique | One score row per dimension per attempt (unique as of v1.2); fast lookup of a student's full dimension breakdown |
| `recommendations` | `(assessment_result_id, match_type, ranking)` | Fast retrieval of "top N career matches for this result" |
| `ai_requests` | `(user_id, created_at)` | Dashboard queries, rate-limit checks |
| `programs` | `(college_id)` | Fast "all programs under this college" lookup for the admin nested-CRUD view |

Check constraints (enforced at the application layer, since D1/SQLite check-constraint support is limited): `match_score` and `normalized_score` must be between 0 and 100; `ranking` must be >= 1; `question_dimensions.confirmed_at`, when set, must have a non-null `confirmed_by`.


# Part IV — Backend Architecture

## 16. Folder Structure

A flatter structure than a full DDD layered split — appropriate for a single-team, 28-table codebase. The backend is one Worker project. Each domain module gets its own folder under `src/modules/`, owning its routes, Zod schemas, service(s), and serializers; internally there is no separate Application/Domain/Infrastructure/Presentation split — that overhead is not earned at this size.

```
backend/
├── wrangler.toml            (bindings: DB (D1) · STORAGE (R2) · VECTORIZE · AI (Workers AI) ·
│                             QUEUE_DEFAULT + QUEUE_AI (Queues producers) · KV (rate limiting) · vars)
├── migrations/              (plain-SQL D1 migrations, applied via `wrangler d1 migrations apply`)
├── test/                    (Vitest — @cloudflare/vitest-pool-workers, see Part XIII)
└── src/
    ├── index.ts             (Worker entry: `fetch` → Hono app; `queue` → job consumer dispatch, §42)
    ├── app.ts               (Hono app assembly: /api/v1 mount, global middleware, error envelope)
    ├── db/
    │   ├── schema.ts        (Drizzle table definitions — all 28 domain tables + api_tokens,
    │   │                     password_reset_tokens; column unions typed from src/…/enums)
    │   └── client.ts        (drizzle(env.DB) factory)
    ├── modules/             (one folder per Part II §10 module — routes.ts, schemas.ts (Zod),
    │   │                     service.ts, serializers.ts inside each)
    │   ├── identity/        (StaffAuthenticationService, StudentAccessService — the two auth flows,
    │   │                     deliberately separate routes and services; profiles)
    │   ├── classes/         (ClassService — CRUD + join-code lifecycle;
    │   │                     ClassEnrollmentService — previewUsernames(), confirmEnrollment())
    │   ├── catalog/         (AcademicCatalogService — colleges, programs, careers)
    │   ├── assessment/      (AssessmentBuilderService — templates, versions, publish gate)
    │   ├── attempt/         (AssessmentAttemptService, ScoringService — Part VI)
    │   ├── recommendation/  (RecommendationService — deterministic matching, Part VII)
    │   ├── ai/              (AiGatewayService — the single entry point to Workers AI;
    │   │                     RetrievalService, KnowledgeIngestionService,
    │   │                     AssessmentGenerationService (CUSTOM only), AiPolicyService)
    │   └── platform/        (NotificationService, AuditService)
    ├── middleware/
    │   ├── authenticate.ts  (bearer token → api_tokens lookup: hash, expiry, user-status checks — §38)
    │   ├── ensure-role.ts
    │   ├── rate-limit.ts    (KV-backed counters — §38, §41)
    │   └── correlation-id.ts
    ├── policies/            (class.ts, assessment.ts, recommendation.ts — plain functions, §39;
    │                         assessment.ts also guards "is this category eligible for AI generation?")
    ├── events/              (dispatcher.ts — in-process typed pub/sub; the four §11 events and
    │                         their listeners, e.g. dispatchRecommendationGeneration)
    ├── jobs/                (one consumer handler per §43 job: processKnowledgeDocument,
    │                         generateEmbedding, generateRecommendation, generateExplanation,
    │                         generateAssessmentDraft)
    ├── prompts/             (recommendation_explanation.v1.md, assessment_generation.v1.md — §32)
    └── lib/                 (envelope.ts, crypto.ts — PBKDF2 + token hashing, slugify.ts,
                              text-extraction.ts — shared by §31 and §33)
```

There are no per-model classes — `src/db/schema.ts` is the single, typed definition of every table, and Drizzle's inferred row types (`typeof users.$inferSelect`) replace what Eloquent models used to be. Everything a "module" needs (its routes, its schemas, its Service, its Policy) is discoverable by searching the domain name — the module boundary is a *naming and code-review discipline*, not a folder wall, which is the right tradeoff for this scale.

**The bulk-roster username generation algorithm** (inside `ClassEnrollmentService::previewUsernames()`):

```
function previewUsernames(classId, nameList):
    existingUsernames = ClassStudent.where(class_id = classId).pluck('username')  # scoped to THIS class only
    proposals = []
    for each name in nameList:
        base = slugify(firstName) + "." + slugify(lastName)     # e.g. "juan.delacruz"
        candidate = base
        suffix = 2
        while candidate in existingUsernames or candidate in proposals:
            candidate = base + suffix
            suffix += 1
        proposals.append({ name: name, username: candidate })
        existingUsernames.append(candidate)    # reserve within this preview batch too
    return proposals    # NOT persisted yet — counselor reviews/edits this list before confirmSubmit()
```

Collision-checking is scoped to `class_id` only, matching the class-scoped uniqueness decision in Part III §13.2 — this is what keeps the generator simple even at platform scale (no need to check millions of other students' usernames across every other class).

**Name-parsing contract (new in v1.2):** each pasted line is split on whitespace — the first token is the first name, everything after it is the last name (`"Juan Dela Cruz"` → first `"Juan"`, last `"Dela Cruz"`). A single-token line (`"Madonna"`) is **legal**: `last_name` is stored NULL (§13.1) and the proposed username is simply `slugify(firstName)`. The preview step exists precisely so the counselor can correct any mis-split (compound first names, swapped order) before anything persists — the parser is a best-effort proposal, the counselor's edit is the authority.

## 17. Request Lifecycle & Pattern

```
HTTP Request
    │
    ▼
Hono route (src/modules/{module}/routes.ts)
    │
    ▼
Middleware (authenticate → ensureRole → rateLimit)
    │
    ▼
Route handler (thin — parses the body against the endpoint's Zod schema,
               calls one Service method, returns a serialized envelope)
    │
    ▼
Zod schema (validation rules only — src/modules/{module}/schemas.ts)
    │
    ▼
Service (business logic — this is where the real work happens)
    │
    ▼
Drizzle query (acts as the repository — no separate Repository class in v1)
    │
    ▼
Cloudflare D1 (env.DB binding)
    │
    ▼
(optionally) Event dispatched → Listener → message enqueued to Cloudflare Queues
    │
    ▼
Serializer (formats response — src/modules/{module}/serializers.ts)
    │
    ▼
JSON Response (standard envelope, see Part V)
```

**Explicit pattern decisions and why:**

- **No Repository layer.** Drizzle queries, written inside Services, are the repository. A Repository class earns its keep when you need to swap a data source or mock persistence heavily in tests — neither is true here (tests run against a real D1 instance via the Workers Vitest pool, Part XIII).
- **No Action classes.** "Single operation" logic lives as a method on the relevant Service rather than a one-class-per-operation file.
- **No DTOs for internal calls.** The Zod-parsed (and therefore typed) payload is passed directly to Service methods — `z.infer<typeof schema>` *is* the type. DTOs are introduced only at real serialization boundaries: the payload sent to `AiGatewayService`.
- **Events kept to exactly four** (§11) — not one for every possible state change.
- **Policies are real and mandatory** on every route handler that touches another user's data or a scoping rule (including the new "is AI generation even allowed for this template?" check).

## 18. Coding Standards

| Element | Convention | Example |
|---|---|---|
| Classes / types / interfaces | PascalCase | `AssessmentAttemptService`, `DimensionScore` |
| Functions / methods | camelCase | `submitAnswer()` |
| Variables | camelCase | `dimensionScore` |
| Constants | UPPER_SNAKE_CASE | `MAX_ATTEMPT_DURATION_MINUTES` |
| Files | kebab-case | `scoring-service.ts`, `ensure-role.ts` |
| Database tables/columns | snake_case | `assessment_attempts`, `student_id` |
| Routes | kebab-case, plural nouns | `/api/v1/assessment-assignments` |
| Services suffix | `...Service` | |
| Queue job handlers | camelCase verb phrase | `generateRecommendation` (§43) |
| Events | past tense | `AssessmentCompleted` |
| Zod schemas suffix | `...Schema` | `submitAnswerSchema` |
| Serializers suffix | `serialize...` | `serializeRecommendation()` |

---

# Part V — API Specification

## 19. API Standards

- **Base path:** `/api/v1/`
- **Auth:** Bearer token via the first-party token service (`api_tokens`, Part X §38) for both flows. `Authorization: Bearer {token}`. Staff tokens come from `/auth/login`; student tokens come from `/student-access/join` (passwordless). *(Corrected v1.2 — earlier revisions said `/student/join` here while the catalog below said `/student-access/join`; the catalog was always right.)*
- **Standard success envelope:**
```json
{
  "success": true,
  "message": "Operation completed successfully.",
  "data": {},
  "meta": { "timestamp": "2026-07-12T08:00:00Z" }
}
```
- **Standard error envelope:**
```json
{
  "success": false,
  "message": "Validation failed.",
  "errors": { "email": ["Email already exists."] }
}
```
- **HTTP status codes used:** 200 (OK), 201 (Created), 204 (Deleted/No content), 400 (Bad request), 401 (Unauthenticated), 403 (Forbidden — role, ownership, **or category exclusion**, e.g. attempting AI-generation against a RIASEC template), 404 (Not found), 422 (Validation failed), 429 (Rate limited), 500 (Server error).
- **Pagination** (for list endpoints): `?page=1&per_page=20`. The list payload is returned inside `data` as `{ "items": [...], "pagination": { "current_page", "per_page", "total", "last_page" } }` — pagination metadata travels with the list it describes, while the envelope's `meta` block stays reserved for request-level metadata (`timestamp`). *(Corrected v1.4 — see the revision note.)*
- **Rate limiting:** standard endpoints 100 req/min per user; `/ai/*` endpoints 10 req/min per user; `/student-access/join` **failed** attempts rate-limited per `(class code, IP)` (not per user — no user exists yet at that point; and failures only, so an entire class joining from one lab IP is never locked out by its own success) — see Part X §38.

## 20. Complete Endpoint Catalog

### Staff Auth (`/api/v1/auth`) — 6 endpoints

```
POST   /login                    (email + password — admin/counselor only)
POST   /logout
GET    /me
POST   /forgot-password
POST   /reset-password
POST   /change-password
```

### Student Access (`/api/v1/student-access`) — 1 endpoint, deliberately separate from staff auth

```
POST   /join                     (class_code + username, no password → issues a bearer token)
```

### Admin (`/api/v1/admin`) — ~34 endpoints

```
# Counselor management
GET    /counselors
POST   /counselors
PATCH  /counselors/{id}
DELETE /counselors/{id}

# Academic catalog — Colleges (new)
GET    /colleges
POST   /colleges
GET    /colleges/{id}                    (includes nested programs list)
PATCH  /colleges/{id}
DELETE /colleges/{id}

# Academic catalog — Programs (now college-scoped)
GET    /colleges/{collegeId}/programs
POST   /colleges/{collegeId}/programs
PATCH  /programs/{id}
DELETE /programs/{id}

# Academic catalog — Careers
GET    /careers
POST   /careers
PATCH  /careers/{id}
DELETE /careers/{id}
POST   /programs/{id}/careers            (attach a career to a program)
DELETE /programs/{id}/careers/{careerId}

# Assessment templates (global) — RIASEC/SCCT manual-only, CUSTOM manual or AI-assisted
GET    /assessment-templates
POST   /assessment-templates
PATCH  /assessment-templates/{id}
POST   /assessment-templates/{id}/versions
POST   /assessment-versions/{id}/publish     (enforces the confirmation-gate check)
POST   /assessment-versions/{id}/archive

# Knowledge base
GET    /knowledge-documents
POST   /knowledge-documents               (multipart upload)
DELETE /knowledge-documents/{id}          (archives: sets archived_at + removes vectors from Vectorize — never a hard delete, §13.7)

# AI policy — the single GLOBAL row is created by the seeder; deliberately no create/delete endpoint (v1.2 note)
GET    /ai-policies
PATCH  /ai-policies/{id}

# Audit
GET    /audit-logs

# Dashboard (added v1.2 — §37 always specified an admin dashboard screen; the endpoint was missing)
GET    /dashboard
```

### Counselor (`/api/v1/counselor`) — ~24 endpoints

```
# Classes — join code generated at creation
GET    /classes
POST   /classes                          (join_code returned immediately in the response)
GET    /classes/{id}
PATCH  /classes/{id}
DELETE /classes/{id}
POST   /classes/{id}/regenerate-code

# Roster — bulk provisioning, Tinkercad-style preview/confirm (both capped at 200 names/request, ratified v1.2)
GET    /classes/{id}/students
POST   /classes/{id}/students/preview      (new — pastes a name list, returns proposed usernames, NOT persisted)
POST   /classes/{id}/students/confirm      (new — persists the reviewed/edited list as real accounts)
DELETE /classes/{id}/students/{studentId}

# Assessment templates (private) — manual or AI-assisted, CUSTOM only
GET    /assessment-templates
POST   /assessment-templates
POST   /assessment-templates/{id}/versions
POST   /assessment-versions/{id}/publish

# Assignments
GET    /classes/{id}/assignments
POST   /classes/{id}/assignments
PATCH  /assignments/{id}

# Results visibility
GET    /classes/{id}/results
GET    /students/{id}/results
GET    /students/{id}/recommendations

# Dashboard
GET    /dashboard
```

### Student (`/api/v1/student`) — ~16 endpoints

```
GET    /profile
PATCH  /profile

GET    /assignments                       (assessments assigned to me, pending/active)
POST   /assignments/{id}/start             (creates an attempt)
GET    /attempts/{id}
POST   /attempts/{id}/answers               (submit/update one answer)
POST   /attempts/{id}/submit                 (finalize -> triggers scoring)

GET    /results
GET    /results/{id}

GET    /recommendations
GET    /recommendations/latest
POST   /recommendations/{id}/explain          (request AI explanation, if not already generated)

GET    /dashboard
```

### AI-Assisted Assessment Generation (`/api/v1/assessment-templates/{id}`) — shared, policy-gated — 6 endpoints, new

```
POST   /versions/{versionId}/ai-generate/document      (multipart upload — PDF/DOCX)
POST   /versions/{versionId}/ai-generate/description    (natural-language description)
GET    /ai-generate/{aiRequestId}/status                 (poll async generation job)
POST   /question-dimensions/{id}/confirm                  (human confirms one AI-proposed mapping)
POST   /versions/{versionId}/confirm-all-mappings           (bulk-confirm convenience helper)
GET    /versions/{versionId}/publish-readiness               (returns whether the gate is satisfied yet)
```

Every one of these is guarded by `AssessmentPolicy` at two levels: **ownership** (same as always) and **category exclusion** — a request against a template with `category IN (RIASEC, SCCT)` is rejected with 403 before it ever reaches `AssessmentGenerationService`, regardless of role.

### AI (`/api/v1/ai`) — 1 endpoint

```
GET    /requests/{id}/status    (poll status of an async AI job)
```

> **Removed in v1.2:** the former `POST /explain`, which was labeled "used internally" — an internal operation is a queued job (`GenerateExplanationJob`, triggered by `RecommendationGenerated` or by the student-facing `POST /student/recommendations/{id}/explain`), not a public HTTP endpoint. An "internal endpoint" in a public catalog is a contradiction and an attack surface.

### Notifications (`/api/v1/notifications`) — 3 endpoints

```
GET    /
PATCH  /{id}/read
PATCH  /read-all
```

### Public / Health — 2 endpoints

```
GET    /health
GET    /programs/public          (unauthenticated catalog browse, optional)
```

**Total v1 endpoint count: ~92** (net unchanged in v1.2: admin dashboard added, internal `/ai/explain` removed). Grew from the v1.0 estimate (~75) primarily due to the Colleges CRUD, the bulk-roster preview/confirm split, and the new AI-generation endpoint group — all genuine new capability, not scope drift.


# Part VI — Assessment Engine

This is the core deterministic intelligence of the platform and the piece that must be specified precisely — everything downstream (results, recommendations, AI explanations) depends on getting this right and reproducible.

## 21. Assessment Lifecycle

```
DRAFT  ──▶  (template + version authored, questions/options/dimension mappings added —
             manually, or via AI-assisted generation for CUSTOM templates only)
  │
  ▼
[Publish blocked while any question_dimensions.confirmed_at IS NULL — §25]
  │
  ▼
PUBLISHED  ──▶  (version frozen/immutable; can now be assigned)
  │
  ▼
ASSIGNED  ──▶  (assessment_assignments row created for a class)
  │
  ▼
IN_PROGRESS  ──▶  (student has an assessment_attempts row, status=IN_PROGRESS, answering questions)
  │
  ▼
SUBMITTED  ──▶  (student finalizes; no further answer edits permitted)
  │
  ▼
SCORED  ──▶  (ScoringService has run: dimension_scores + assessment_results rows exist)
  │
  ▼
(triggers AssessmentCompleted event → recommendation generation queued)
```

A published version is never edited. If a mistake is found, a new version (`version_number + 1`) is created, and only *new* assignments point at it — attempts already in progress or completed under the old version remain valid against that old version forever.

**Attempt rules (new in v1.2):** one attempt per assignment per student, enforced by a unique constraint (§13.5). A retake is a counselor-initiated reset — the old attempt is marked `EXPIRED` and retained, then a fresh attempt may start. An attempt still `IN_PROGRESS` when its assignment is `CLOSED` also becomes `EXPIRED`. Expired attempts are never scored and never feed recommendations; "latest result" everywhere in this document therefore always resolves unambiguously to a `SCORED` attempt.

## 22. RIASEC Scoring Algorithm

**RIASEC** (Holland Codes) measures six vocational interest dimensions: **R**ealistic, **I**nvestigative, **A**rtistic, **S**ocial, **E**nterprising, **C**onventional.

### Setup

- `assessment_dimensions` has exactly 6 rows for the RIASEC template, codes `R`, `I`, `A`, `S`, `E`, `C`.
- Each `assessment_question` is mapped to exactly one dimension via `question_dimensions` with `weight = 1.00`. Because RIASEC is manually authored only (never AI-generated — see §25), every one of these mappings has `confirmed_at` set at creation time by the authoring admin.
- Each question uses a 5-point Likert scale: Strongly Disagree (1) → Strongly Agree (5), stored as 5 `question_options` rows with `score` = 1 through 5.
- Recommended item bank: 10 questions per dimension × 6 dimensions = 60 questions total (configurable; the algorithm below works for any N ≥ 1 questions per dimension).

### Formula

For each dimension `d`, over the set of questions `Q_d` assigned to that dimension:

```
raw_score(d)        = Σ  answer_score(q)              for each q in Q_d
max_possible(d)      = Σ  max_option_score              for each q in Q_d
normalized_score(d)  = ( raw_score(d) / max_possible(d) ) × 100
```

With a 5-point scale and 10 questions per dimension: `max_possible(d) = 10 × 5 = 50`.

### Interpretation banding

Applied per dimension using `assessment_dimensions.interpretation_ranges`:

```json
[
  { "min": 0,  "max": 33.99, "label": "Low Interest" },
  { "min": 34, "max": 66.99, "label": "Moderate Interest" },
  { "min": 67, "max": 100,   "label": "High Interest" }
]
```

### Holland Code derivation

```
1. Compute normalized_score(d) for all 6 dimensions.
2. Sort dimensions descending by normalized_score.
3. Tie-break (if scores are exactly equal) using canonical order R > I > A > S > E > C,
   so the result is always deterministic and reproducible from the same answers.
4. Take the top 3 dimension codes in sorted order.
5. Concatenate → e.g. "IAS" (Investigative, Artistic, Social).
```

This 3-letter code is written to `assessment_results.result_code`.

### Worked example

Student answers 10 Investigative questions with scores: `5,4,5,3,4,5,4,3,5,4`

```
raw_score(I)       = 5+4+5+3+4+5+4+3+5+4 = 42
max_possible(I)     = 10 × 5 = 50
normalized_score(I)  = (42 / 50) × 100 = 84.0  →  "High Interest"
```

If the six dimension normalized scores computed this way are:

```
I = 84.0    A = 71.0    S = 62.0    C = 55.0    E = 48.0    R = 30.0
```

Sorted descending: `I(84.0), A(71.0), S(62.0), C(55.0), E(48.0), R(30.0)`
→ **Holland Code = "IAS"**

## 23. SCCT Scoring Algorithm

**SCCT** (Social Cognitive Career Theory) measures three constructs in v1: **Self-Efficacy** (belief in one's ability to succeed in a domain), **Outcome Expectations** (belief that effort in a domain leads to good outcomes), and **Goal Orientation** (intent to pursue a domain).

### Setup

- `assessment_dimensions` has 3 rows for the SCCT template: codes `SE` (Self-Efficacy), `OE` (Outcome Expectations), `GO` (Goal Orientation).
- Same 5-point Likert mechanism as RIASEC, same one-question-one-dimension mapping. Also manually authored only, same as RIASEC — never AI-generated.
- Recommended item bank: 10 questions per construct × 3 = 30 questions.

### Formula — per-dimension score

Identical mechanism to RIASEC §22:

```
raw_score(d)        = Σ answer_score(q)         for each q in Q_d
max_possible(d)       = Σ max_option_score        for each q in Q_d
normalized_score(d)     = (raw_score(d) / max_possible(d)) × 100
```

### Formula — composite SCCT confidence index

Unlike RIASEC (which has no single composite — it produces a 3-letter code), SCCT produces one additional overall number: a **Career Confidence Index**, used directly as an input to the recommendation engine (Part VII).

```
composite_weights (from assessment_versions.scoring_config, default if unset):
  SE : 0.40
  OE : 0.30
  GO : 0.30

career_confidence_index = (normalized_score(SE) × 0.40)
                         + (normalized_score(OE) × 0.30)
                         + (normalized_score(GO) × 0.30)
```

This composite is written to `assessment_results.overall_summary` **for display only**. Anything that *consumes* the index — above all the Recommendation Engine (Part VII) — always recomputes it from the three `dimension_scores` rows plus the version's `scoring_config` weights; nothing ever parses the formatted string back into a number (v1.2 — a numeric value round-tripping through prose was a bug waiting to happen). The `dimension_scores` rows remain the single source of truth.

### Worked example

```
normalized_score(SE) = 78.0
normalized_score(OE) = 65.0
normalized_score(GO) = 72.0

career_confidence_index = (78.0 × 0.40) + (65.0 × 0.30) + (72.0 × 0.30)
                         = 31.2 + 19.5 + 21.6
                         = 72.3
```

Interpretation banding (same 3-tier pattern as RIASEC, applied to the composite): 72.3 → **"Moderately High Career Confidence."**

## 24. Generic Scoring Engine Design

Both algorithms above are really **one algorithm with two configurations** — this is intentional, so a third assessment type (a future personality inventory, a leadership scale, etc.) can be added later by writing data (dimensions, questions, `scoring_config`), never by writing new scoring code. It is also what lets `CUSTOM` assessments (manually built or AI-assisted) use the exact same scoring machinery as RIASEC/SCCT once their mappings are confirmed — no separate code path for "custom" scoring exists.

**`ScoringService::score(AssessmentAttempt $attempt)`** pseudocode:

```
function score(attempt):
    version   = attempt.assessmentVersion
    config    = version.scoring_config      # JSON: algorithm, scale, weights
    dimensions = version.template.dimensions

    if dimensions.isEmpty():
        # A CUSTOM assessment can be ungraded/reflection-only — see §25.
        # No dimension_scores or result_code are computed; answers are still stored.
        attempt.status = SCORED
        save AssessmentResult(attempt, result_code = null, overall_summary = null)
        fire AssessmentCompleted(attempt)
        return

    for each dimension in dimensions:
        questions = dimension.questions()          # via question_dimensions (all guaranteed confirmed — §25)
        raw = 0
        max = 0
        for each question in questions:
            answer = attempt.answers.where(question_id = question.id).first()
            if answer is null:
                # Only reachable when question.required = false — submission is blocked
                # while any REQUIRED question is unanswered. Prorate (v1.2): an
                # unanswered optional question contributes to neither raw nor max,
                # so skipping it cannot deflate the normalized score.
                continue
            weight = question_dimensions.weight(question, dimension)
            raw += answer.score * weight
            max += question.options.max(score) * weight

        if max == 0:
            # Every question on this dimension was optional and skipped (v1.2):
            # no DimensionScore row is written; the dimension is simply absent
            # from this attempt's result and from any result_code derivation.
            continue

        normalized = (raw / max) * 100
        interpretation = lookup(dimension.interpretation_ranges, normalized)

        save DimensionScore(attempt, dimension, raw, normalized, interpretation)

    # Category-specific post-processing, driven by config.algorithm:
    if config.algorithm == "HOLLAND_CODE_TOP3":
        result_code = top3DimensionCodes(dimension_scores, tie_break = dimensions.canonical_order)
        summary = null

    else if config.algorithm == "WEIGHTED_COMPOSITE":
        composite = Σ ( dimension_scores[d].normalized × config.composite_weights[d] )
        result_code = null
        summary = formatCompositeSummary(composite)

    save AssessmentResult(attempt, result_code, summary)

    attempt.status = SCORED
    fire AssessmentCompleted(attempt)
```

This function runs synchronously on submission (target: under 2 seconds for a 60-question RIASEC attempt) — it is *not* queued, because it is fast, deterministic, and the student is actively waiting for their result on screen. Only the *downstream* recommendation + AI explanation steps are queued (Part XI).

**Event semantics (clarified v1.2):** `AssessmentCompleted` fires here, once per scored attempt, for every category — including ungraded CUSTOM assessments. Whether recommendation generation actually runs is the *listener's* decision (`DispatchRecommendationGeneration` checks that both a RIASEC and an SCCT result exist for the student before dispatching the job — §43, §60). This function never makes that decision.

## 25. The Dimension-Mapping Confirmation Gate

This section formalizes the rule referenced throughout Parts III and VI: **no `assessment_version` may move to `PUBLISHED` while any of its `question_dimensions` rows have `confirmed_at IS NULL`.**

### Why this exact rule, and not something else

The risk isn't AI writing question *text* — a slightly awkward AI-drafted sentence is a UX problem, not an integrity problem. The risk is AI silently deciding *what a question measures and how strongly* (`dimension_id` + `weight`), because that decision is invisible in the final product: a student sees a normal-looking Likert question and a normal-looking result, with no indication that the thing connecting them was never reviewed by a human. The gate targets exactly that specific, invisible failure mode — not the whole AI pipeline broadly.

### How mappings get confirmed

| Origin | `confirmed_at` behavior |
|---|---|
| Admin/counselor manually creates a question + assigns it to a dimension via the assessment builder UI | Set immediately, at insert time, by the Service layer — a human typed this, there is nothing to review later |
| AI proposes a question + a suggested dimension mapping (document upload or description-based generation) | Left `NULL` at creation. Appears in a review queue. Publish is blocked until a human explicitly calls `POST /question-dimensions/{id}/confirm` (or the bulk-confirm endpoint) for every row |

### What "confirm" actually requires the human to see

The confirmation UI is not a single "approve all" checkbox — each row shown for confirmation displays: the question text, the proposed dimension name + description, and the proposed weight, side by side, with the ability to edit the dimension assignment or weight before confirming (not just accept-or-reject). `GET /versions/{versionId}/publish-readiness` gives a simple count of `{total, confirmed, remaining}` so the UI can show clear progress and block the publish button with an honest reason, not a silent failure.

### Scope of the rule

Applies uniformly to every assessment category — but because RIASEC and SCCT are permanently excluded from AI-assisted creation (Part I §5, enforced at the API layer per Part V §20), their mappings are, in practice, always confirmed at creation time. The rule doesn't need a category-based exception; it produces the right behavior automatically because of what's upstream of it.

**Related invariant (v1.2):** the dimension rows these mappings point at are themselves frozen once any version of the template is published (§12). A confirmation is only meaningful if the thing confirmed cannot be redefined afterward — the freeze rule is what makes `confirmed_at` a durable fact rather than a snapshot of a moving target.


# Part VII — Recommendation Engine

## 26. Recommendation Philosophy

The Recommendation Engine is pure application code: given a student's latest `assessment_results` (RIASEC dimension scores + SCCT career confidence index) and academic profile, it computes a ranked, numeric, reproducible match score against every active career and program in the catalog. **No AI model is involved in this computation.** AI's only role, downstream, is to turn the top results into a natural-language paragraph (Part VIII).

Two related but distinct outputs are produced:

- **Career recommendations** — how well the student's interest/confidence profile matches a career's typical profile.
- **Program recommendations** — how well the student matches a specific college program, which additionally factors in academic eligibility and strand alignment. Because `programs.college_id` is now a real foreign key (Part III §13.3), the recommended college is a direct, reliable join off the recommended program — no separate college-matching computation is needed.

## 27. Matching & Scoring Algorithm

### Inputs available at recommendation time

| Input | Source |
|---|---|
| RIASEC dimension normalized scores (R, I, A, S, E, C) | `dimension_scores` for the student's latest RIASEC `assessment_results` |
| SCCT career confidence index | Recomputed live from the SCCT result's `dimension_scores` + its version's `scoring_config` weights — never parsed out of `overall_summary`, which is display-only (§23, v1.2) |
| Student GWA | `student_profiles.gwa` |
| Student strand | `student_profiles.strand` — one of exactly two values: `Academic` \| `Technical-Professional` |
| Career's typical RIASEC code | `careers.typical_riasec_code` |
| Program's recommended strand | `programs.recommended_strand` — same two-value domain |
| Program's college | `programs.college_id → colleges` |
| Program's linked careers | `program_careers` |

If a student has not yet completed both a RIASEC and an SCCT assessment, recommendation generation is deferred (not run with partial/default data) — the UI communicates "Complete both assessments to see recommendations" rather than silently substituting placeholder numbers.

"Latest" is unambiguous (v1.2): one attempt per assignment per student (§13.5), expired attempts never scored (§21) — so the latest result per category is simply the most recent `SCORED` result for that student account, newest `generated_at` wins across re-assignments.

**A note on the strand signal, now that it's a two-value field:** with only `Academic` / `Technical-Professional` to work with, strand alignment is necessarily a coarse filter — it can tell you a Technical-Professional-track student is a poor fit for a program built for the Academic track, but it cannot distinguish a STEM-leaning Academic student from a HUMSS-leaning one the way a finer strand taxonomy could. That finer distinction is not lost, though — it is exactly what the RIASEC compatibility component (weighted far more heavily, see below) is already designed to capture. The two-value strand field is a coarse eligibility gate; RIASEC does the fine-grained interest matching.

### Component formulas (all outputs normalized to a 0–100 scale)

**RIASEC Compatibility** — how well the student's profile matches a target 3-letter RIASEC code, with the first letter weighted most heavily (this mirrors how Holland Code interpretation itself works — the first letter is the dominant type):

```
position_weights = [0.5, 0.3, 0.2]   # for a 3-letter code; renormalized if the code has <3 letters

riasec_compatibility(student, target_code) =
    Σ  student.normalized_score(target_code[i]) × position_weights[i]     for i in 0..len(target_code)-1
```

**SCCT Career Confidence** — used as-is from Part VI §23 (`career_confidence_index`). Not career-specific in v1 (a stated, deliberate simplification — see Part XVIII §63 for the future refinement path where confidence could vary per career cluster).

**Academic Fit** (used for program matching only):

```
academic_fit(student) = clamp( ((student.gwa - 75) / (95 - 75)) × 100 , 0, 100 )
```
(75 = minimum passing GWA in the PH SHS system; 95 = a practical high-end anchor. If `gwa` is null, defaults to a neutral 60.)

**Strand Alignment** (program matching only):

```
if program.recommended_strand is NULL:                       strand_alignment = 100   # no requirement
else if student.strand == program.recommended_strand:         strand_alignment = 100
else:                                                            strand_alignment = 40   # reduced, never zero
```

Reduced rather than excluded, deliberately: a Technical-Professional-track student with a strong Investigative RIASEC profile and excellent Math grades should still *see* BS Computer Science as an option, just ranked lower — the platform advises, it does not gatekeep.

**Program Eligibility** (a simple deterministic tier in v1; intentionally not a complex rules engine yet):

```
if student.gwa is NULL:        program_eligibility = 70   # unknown, neutral-leaning-positive
else if student.gwa >= 80:      program_eligibility = 100
else if student.gwa >= 75:       program_eligibility = 70
else:                              program_eligibility = 40
```

**Student Preference** — **v1 limitation, stated explicitly:** there is no preference-capture mechanism in v1 (no "preferred program/location" input UI or table). This component is therefore fixed at a neutral constant of **70** for every match in v1. It remains in the formula (rather than being silently dropped) so the weight redistribution is trivial once a real preference input ships — see §63.

### Composite formulas

**Career match score:**

```
career_match_score = (riasec_compatibility × 0.60)
                    + (career_confidence_index × 0.30)
                    + (student_preference × 0.10)
```

**Program match score:**

```
program_riasec_compat = average( riasec_compatibility(student, career.typical_riasec_code) )
                         over all careers linked to this program via program_careers
                         (defaults to 50 if the program has no linked careers yet)

program_match_score = (program_riasec_compat × 0.35)
                     + (career_confidence_index × 0.15)
                     + (academic_fit × 0.20)
                     + (strand_alignment × 0.15)
                     + (program_eligibility × 0.10)
                     + (student_preference × 0.05)
```

Both weight sets sum to 1.00, so both composite scores land naturally in 0–100.

### Ranking and persistence

```
1. For every ACTIVE career in the catalog, compute career_match_score.
2. For every ACTIVE program in the catalog, compute program_match_score.
3. Sort each list descending.
4. Persist only the top 10 of each as `recommendations` rows (match_type = CAREER / PROGRAM),
   with `ranking` = position in the sorted list (1 = best).
5. Generate a deterministic `reason` string for each (template below).
6. Fire RecommendationGenerated event once both lists are persisted.
```

Only the top 10 per type are stored — the full catalog scan is recomputed fresh each time recommendations are (re)generated rather than persisting every career/program's score, keeping the `recommendations` table small and query-fast.

### Deterministic reason string template

```
"Your {top_dimension_name} interest score ({top_dimension_pct}%) and SCCT career confidence
({confidence_pct}%) align with {target}'s typical profile ({target_code}).
{strand_clause} {eligibility_clause}"

where:
  strand_clause      = "Matches your {strand} track." | "" (if not applicable/aligned)
  eligibility_clause  = "Your GWA of {gwa} meets the typical academic profile for this path."
                         | "" (if gwa unavailable or not a program match)
```

This is string formatting over already-computed numbers — not a model call. It is fast, free, and always reproducible from the same inputs.

## 28. Worked Example

**Student inputs** (continuing the Part VI worked examples): RIASEC normalized scores `I=84.0, A=71.0, S=62.0, C=55.0, E=48.0, R=30.0`; SCCT `career_confidence_index = 72.3`; `gwa = 88`; `strand = "Academic"`.

### Career match: "Software Engineer" (`typical_riasec_code = "IEC"`)

```
riasec_compatibility = (84.0×0.5) + (48.0×0.3) + (55.0×0.2)
                      = 42.0 + 14.4 + 11.0 = 67.4

career_match_score   = (67.4×0.60) + (72.3×0.30) + (70×0.10)
                      = 40.44 + 21.69 + 7.00 = 69.13  →  69.1
```

### Program match: "BS Computer Science" (`recommended_strand = "Academic"`, `college_id → "University A"`, linked careers: Software Engineer `IEC` compat 67.4, Data Analyst `ICE` compat = (84×0.5)+(55×0.3)+(48×0.2) = 68.1)

```
program_riasec_compat = (67.4 + 68.1) / 2 = 67.75

academic_fit          = clamp(((88-75)/(95-75))×100, 0, 100) = clamp(65.0, 0, 100) = 65.0
strand_alignment       = 100   (student.strand "Academic" == program.recommended_strand "Academic")
program_eligibility     = 100   (gwa 88 >= 80)

program_match_score = (67.75×0.35) + (72.3×0.15) + (65.0×0.20) + (100×0.15) + (100×0.10) + (70×0.05)
                     = 23.71 + 10.85 + 13.00 + 15.00 + 10.00 + 3.50
                     = 76.06  →  76.1
```

**Result:** BS Computer Science (76.1, at "University A", derived directly via `programs.college_id`) ranks above the bare Software Engineer career match (69.1) for this student, because the program score also rewards the strong strand and academic alignment — exactly the kind of nuance a flat "interest quiz" cannot produce, and exactly why the platform separates career-level and program-level matching rather than collapsing them into one number.


# Part VIII — AI Architecture

## 29. AI Principles

1. **AI never computes a score.** Every number shown to a student comes from Part VI/VII. AI only narrates.
2. **AI never writes to the database directly.** Every AI output lands in a dedicated column or a review-gated row (`recommendation_explanations.explanation_text`, `ai_requests.response_text`, unconfirmed `question_dimensions` rows) and is treated as opaque or provisional until a human step touches it — never silently authoritative.
3. **AI is always grounded (RAG) for explanation tasks.** No bare "ask the model" call exists anywhere in the explanation pipeline — every explanation request retrieves relevant knowledge chunks first.
4. **AI-assisted content creation is permanently walled off from RIASEC/SCCT**, and every proposed scoring-dimension mapping it produces requires explicit human confirmation before it can be used (Part VI §25) — this is what makes principle #1 hold even once AI is allowed to draft assessment content.
5. **One provider, one adapter.** Cloudflare Workers AI, via a single `AiGatewayService` class. The adapter *interface* is designed so a second provider could be added later, but a second implementation is not built until there is a real reason to.
6. **Every request is logged.** Every call to `AiGatewayService` — whether for explanation or generation — produces exactly one `ai_requests` row, success or failure, with token count and latency, no exceptions.
7. **Admin-configured policy governs every prompt.** The active `ai_policies` row's `instructions` and `restrictions` are appended to every system prompt in both pipelines below, without exception.

CareerLinkAI's AI layer now does two genuinely different jobs, and it's important they stay architecturally distinct rather than sharing one blurry "AI does stuff" pipeline:

| Pipeline | Job | Grounded in | Output review |
|---|---|---|---|
| **Recommendation Explanation** (§30) | Explain an already-computed deterministic result | Retrieved knowledge chunks (RAG) | Displayed directly; validated but not human-approved per-instance |
| **Assessment Generation** (§31) | Draft raw question/option content, and *propose* (never finalize) dimension mappings | The uploaded document, or the creator's description — no knowledge-base retrieval needed | **Mandatory** human review and per-mapping confirmation before anything it produces can be published |

## 30. RAG Pipeline (Recommendation Explanation)

```
Recommendation generated (deterministic, Part VII)
        │
        ▼
GenerateExplanationJob queued (async — see Part XI)
        │
        ▼
RetrievalService: embed a query built from
  { student's top RIASEC dimensions, target career/program, target dimension names }
        │
        ▼
Cloudflare Vectorize: similarity search, top-K=6, similarity threshold ≥ 0.75
        │
        ▼
Retrieved knowledge_chunks (via vector_id → chunk content)
        │
        ▼
PromptBuilder: assemble system prompt + active ai_policies text + retrieved context +
                student profile + the deterministic match_score/reason
                (AI is given the answer, not asked to invent one)
        │
        ▼
Cloudflare Workers AI (text generation)
        │
        ▼
Output Validator: check non-empty, check length bounds, check no unsupported claims
                   pattern (e.g. reject "guaranteed", "you will definitely")
        │
        ▼
Save to recommendation_explanations + log ai_requests row
        │
        ▼
Notify student (RecommendationGenerated event chain)
```

Archived documents can never be retrieved — their vectors are removed from Vectorize at archive time (§13.7), which makes the exclusion structural rather than a query-time filter that could be forgotten. And since v1 knowledge is `GLOBAL`-only (v1.2), no visibility filtering exists in this pipeline at all — one less scoping rule to get wrong.

If retrieval returns zero chunks above the similarity threshold, the system does **not** fall back to an ungrounded generic AI answer — it falls back to a deterministic template sentence built from the `reason` field already computed in Part VII, and logs the `ai_requests` row as `status = FAILED` with a note. A grounded number is always better than an ungrounded paragraph.

## 31. AI-Assisted Assessment Generation Pipeline

**New in v1.1.** Available to admin and counselor, exclusively for templates with `category = CUSTOM`. The backend rejects any request against a `RIASEC` or `SCCT` template at the Policy layer — this is enforced identically for admin and counselor, with no role-based exception.

### Two entry modes

**Mode A — Document upload:**

```
Admin/Counselor uploads PDF/DOCX to a DRAFT assessment_version
        │
        ▼
GenerateAssessmentDraftJob queued
        │
        ▼
Extract text (same parser as knowledge ingestion, §33 — reused, not duplicated)
        │
        ▼
Cloudflare Workers AI: structuring prompt (§32) — parse the document into
  { questions[], options[] per question, suggested_dimensions[] (name + description only) }
        │
        ▼
Output Validator: enforce a hard cap (max 50 questions per generation run, prevents
  runaway output), require every question to have ≥2 options, reject malformed JSON
        │
        ▼
Persist as assessment_questions (source = AI_GENERATED, source_ai_request_id set)
  + question_options
  + question_dimensions rows IF the creator specified this should be a scored assessment
    (confirmed_at = NULL — unconfirmed, pending review)
        │
        ▼
AssessmentDraftGenerated event → notify the creator: "Your draft is ready for review."
```

**Mode B — Natural-language description:**

Same pipeline from the "Cloudflare Workers AI" step onward, except the input is a free-text description the creator types (e.g., *"Create a 20-question Likert scale assessment about study habits, scored across 3 dimensions: Time Management, Focus, and Organization"*) rather than extracted document text. **The creator specifies the target dimension names up front** in this mode — AI does not invent new dimension names unprompted when generating from a description; it maps questions onto the dimensions the human already named. (Mode A, working from an existing document, may still *suggest* dimension names since the source material implies its own structure — but those suggestions are inert text until a human explicitly turns one into a real `assessment_dimensions` row during review, exactly like everything else in this pipeline.)

### The mandatory review step (this is not optional, and not skippable)

```
Creator opens the generated draft in the assessment builder UI
        │
        ▼
For each question: review/edit text and options (same editor used for manual creation —
  an AI-generated question and a manually-typed one look and behave identically once drafted)
        │
        ▼
For each proposed dimension: confirm it as a real assessment_dimensions row, merge it into
  an existing one, or discard it
        │
        ▼
For each question_dimensions mapping: explicitly confirm (or edit, then confirm) —
  this sets confirmed_at + confirmed_by (Part VI §25)
        │
        ▼
GET /versions/{id}/publish-readiness shows {total, confirmed, remaining}
        │
        ▼
Once remaining = 0 (or the template is ungraded, i.e. zero dimensions entirely):
  POST /versions/{id}/publish becomes possible
```

There is no "approve all" shortcut that bypasses per-mapping confirmation — this is a deliberate UX decision, not an oversight, because the entire point of the gate (Part VI §25) is that a human actually looked at each dimension assignment, not that they clicked one button trusting the batch.

### Ungraded custom assessments

Not every `CUSTOM` assessment needs to produce a score. A counselor may want a plain reflection survey with no Holland-code-style result. If the creator specifies "ungraded" up front (or simply never adds any dimensions to the draft), the generation pipeline produces only questions and options — no `question_dimensions` rows exist at all, so §25's gate is trivially satisfied (there is nothing to confirm) and the version can publish once the question/option content itself has been reviewed for quality.

## 32. Prompt Design

**System prompt (Recommendation Explanation):**

```
You are CareerLinkAI's guidance assistant. You explain career and college program
recommendations that have ALREADY been calculated by a deterministic scoring system.

You do not calculate scores. You do not invent recommendations. You explain, in
plain, encouraging, age-appropriate language for a Senior High School student, why
the given match score and reason were produced — using ONLY the provided knowledge
context and the provided student data.

{active_ai_policy.instructions}
{active_ai_policy.restrictions}

Rules:
- Never state or imply a guaranteed outcome ("you will become...", "you are destined for...").
- If the knowledge context does not cover something, say so rather than inventing it.
- Keep the response to 2-4 sentences.
- Reference at least one specific piece of retrieved context if one is relevant.
```

**System prompt (Assessment Generation — new):**

```
You are CareerLinkAI's assessment-drafting assistant. You help an administrator or
counselor draft a CUSTOM survey/assessment. This is always a DRAFT — a human will
review and explicitly confirm every question and every scoring-dimension mapping
before anything you produce is used.

{active_ai_policy.instructions}
{active_ai_policy.restrictions}

Rules:
- Never generate content for a RIASEC or SCCT assessment — if asked, refuse; this
  should never occur since the backend already blocks this request category before
  it reaches you, but you must never assume that check happened correctly.
- Generate no more than {max_questions} questions.
- Every question needs at least 2 answer options.
- If dimensions were provided by the creator, map every question onto one of THOSE
  dimensions only — do not invent additional dimensions.
- If no dimensions were provided (document-upload mode only), you may suggest
  dimension names based on the source material's own structure, clearly labeled
  as suggestions.
- Output strict JSON matching the provided schema. No prose outside the JSON.
```

Both prompts are versioned as files in the repository (`src/prompts/recommendation_explanation.v1.md`, `src/prompts/assessment_generation.v1.md`), not database rows — Git history is the version history for v1. `ai_policies` content is the one piece of prompt-adjacent text that *is* database-editable, injected at generation time into either prompt — this is the intentional minimal middle ground between "everything hardcoded" and "full prompt CMS" (§63).

## 33. Knowledge Ingestion Pipeline

```
Admin uploads PDF/DOCX (multipart, ≤10MB)
        │
        ▼
Store raw file in Cloudflare R2 → knowledge_documents row (processing_status = UPLOADED)
        │
        ▼
ProcessKnowledgeDocumentJob queued
        │
        ▼
Extract text (PDF/DOCX parser — the same extraction step reused by §31 Mode A)
        │
        ▼
Clean text (strip headers/footers/page numbers, normalize whitespace)
        │
        ▼
Chunk: 300-800 tokens per chunk, 50-100 token overlap between adjacent chunks
        │
        ▼
For each chunk: knowledge_chunks row created (content stored in D1)
        │
        ▼
GenerateEmbeddingJob per chunk: Workers AI embedding model → vector
        │
        ▼
Store vector in Cloudflare Vectorize → vector_id written back onto the knowledge_chunks row
        │
        ▼
knowledge_documents.processing_status = COMPLETED
        │
        ▼
KnowledgeDocumentProcessed event → notify uploading admin
```

Recommended v1 seed content: RIASEC theory overview, SCCT theory overview, 5–10 program/career/college description documents relevant to the seeded catalog. This is enough for the RAG pipeline to produce genuinely grounded (not generic) explanations in the thesis demo.

**Note on shared infrastructure:** the text-extraction step is genuinely shared code between this pipeline and §31 Mode A — both start from "here is a PDF/DOCX, get clean text out of it." What diverges after that point is real: knowledge ingestion chunks-and-embeds for later retrieval; assessment generation structures-and-drafts for immediate human review. They are separate Jobs and separate `ai_requests.request_type` values, sharing one small parsing utility, not one blended pipeline.

## 34. AI Guardrails & Validation

| Check | Applies to | Rule |
|---|---|---|
| Non-empty response | Both pipelines | Reject and retry once if the model returns blank/whitespace |
| Length bounds | Explanation | Reject if response < 20 characters or > 1500 characters |
| Question count cap | Generation | Reject/truncate if the model proposes more than 50 questions in one run |
| Absolute-claim filter | Explanation | Reject/regenerate if response contains phrases like "guaranteed", "you will definitely", "100% certain" |
| Category exclusion | Generation | Enforced in `AssessmentPolicy` before the request reaches `AiGatewayService` at all — RIASEC/SCCT templates never reach the model |
| Dimension-mapping confirmation | Generation | Enforced at publish time via the §25 gate — independent of and in addition to any AI-side guardrail, since AI-side checks can never be fully trusted |
| Grounding check | Explanation | Logged (not hard-block in v1) whether the response references any retrieved chunk content, for later prompt-quality review |
| PII leakage | Both pipelines | The prompt sender never includes password, token, or other-student data — enforced by only passing the specific fields listed in §32, never a raw model/row dump |
| Rate limit | Both pipelines | 10 AI requests/minute per user, enforced at the API layer before the job is even queued |


# Part IX — Frontend Architecture

## 35. Stack & Folder Structure

React 19 + TypeScript, Vite, Tailwind + shadcn/ui, feature-based organization mirroring the backend's 8 modules:

```
src/
├── app/                    (App.tsx, providers, router, query client)
├── features/
│   ├── auth/                (staff login)
│   ├── student-access/      (new — class code + username entry, no password field at all)
│   ├── admin/                (colleges, programs, careers, knowledge, assessment-templates, ai-policy)
│   ├── counselor/             (classes, roster-builder, assignments, results)
│   ├── student/                (profile, assessments, results, recommendations)
│   ├── assessment-builder/     (shared manual builder, used by both admin and counselor)
│   ├── assessment-generator/    (new — AI-assisted drafting UI + confirmation-gate review screen, CUSTOM only)
│   ├── assessment-player/        (shared question renderer used by student flow)
│   └── notifications/
├── components/ui/          (shared shadcn-based primitives)
├── layouts/                (AdminLayout, CounselorLayout, StudentLayout, StaffAuthLayout, StudentAccessLayout)
├── services/                (one api client module per backend module, wraps fetch/axios)
├── stores/                  (Zustand: auth store, ui store)
├── hooks/
├── routes/
└── types/                    (mirrors backend API Resource shapes)
```

Each `feature/` folder owns its own `api/`, `components/`, `pages/`, `hooks/`, `types/` — same "module owns its slice" discipline as the backend, without a deep DDD layer split.

**Division of labor between `src/services/` and a feature's `api/` folder (clarified v1.2):** `src/services/` owns the raw HTTP client modules (the only place axios is called); a feature's `api/` folder owns the TanStack Query hooks that wrap those clients. Components call hooks, hooks call services — never a component calling a client directly, and never two competing places to put the same request.

## 36. State Management Strategy

| State category | Tool | Examples |
|---|---|---|
| Server state | TanStack Query | assessment list, recommendations, class roster, generation-draft review state |
| Global client state | Zustand | current user, auth token, active role context |
| Local component state | `useState` | form inputs, modal open/close, filters |

No Axios call is ever made directly inside a component — always `Component → hook (useX) → services/xApi.ts → backend`, keeping the API surface swappable and testable.

## 37. Key Screens by Role

**Admin:** Dashboard · **Colleges (CRUD, with nested Programs list per college)** · Careers (CRUD) · Program–Career mapping · **AI Policy configuration (instructions/restrictions editor)** · Assessment templates (manually create/publish RIASEC & SCCT versions — no AI-assist option ever shown for these) · **AI Exam Generator (CUSTOM only: upload doc or describe → review draft → confirm every dimension mapping → publish)** · Knowledge documents (upload/list) · Audit log viewer

**Counselor:** Dashboard · Classes (create — join code shown immediately) · **Roster Builder (paste name list → preview generated usernames → edit any → confirm → accounts created)** · Assign assessment to class · Custom assessment builder (manual or **AI-assisted, same confirmation-gate flow as admin**) · Class results overview · Individual student result + recommendation view

**Student:** **Class access screen (class code + username — no password field exists anywhere in this flow)** · Dashboard · Profile completion (grade, GWA, subject grades, strand — 2-option selector) · Assigned assessments list (RIASEC, SCCT, and any counselor-assigned custom assessments together) · Assessment player (question-by-question, progress bar, submit) · My results (dimension breakdown, Holland Code / SCCT confidence) · My recommendations (ranked cards: career, program, and derived college, match %, AI explanation, "Explain more" button) · Notifications

---

# Part X — Security Architecture

## 38. Authentication (Two Models)

CareerLinkAI runs **two intentionally separate authentication flows** — this split is architectural, not incidental, and neither flow should be made to resemble the other.

### Staff authentication (admin, counselor)

- **First-party token service** (v1.3): `/auth/login` verifies email + password, generates a 40+ character random opaque token (`crypto.getRandomValues`), stores only its SHA-256 hash in `api_tokens` with an `expires_at`, and returns the plaintext once. The `authenticate` middleware hashes the presented bearer token, looks it up, and rejects expired tokens and non-`active` users. Logout and revocation delete rows — server-side invalidation is always immediate.
- Passwords: minimum 10 characters, at least 1 uppercase, 1 lowercase, 1 number. Hashed with **PBKDF2-SHA256 via WebCrypto** (≥ 600,000 iterations, per-user random salt, stored as `pbkdf2$iterations$salt$hash` so iterations can be raised later without invalidating old hashes). Chosen because Workers has no native bcrypt/argon2 and WebCrypto's PBKDF2 runs at full native speed — a pure-JS argon2 would be both slower and weaker in practice under Workers CPU limits.
- Temporary passwords (admin-issued to a new counselor) must be changed on first login — enforced via `users.must_change_password`, which routes the frontend straight to a forced password-change screen before anything else loads.
- Account lockout: 5 failed attempts on a given email → 15-minute lock, enforced via the KV-backed rate limiter (ratified v1.2 — the append-only audit table is evidence, not a hot-path auth dependency). Every failure is still written to `audit_logs`.

### Student access — passwordless, by deliberate decision

- No password exists for student accounts, at any point (`users.password IS NULL` for every `role = student` row, permanently).
- Access requires exactly two pieces of information: the class's `join_code`, and the `username` assigned to that student within that specific class (`class_students.username`).
- `POST /student-access/join { class_code, username }` resolves the class, resolves the matching active `class_students` row, and issues a bearer token (same `api_tokens` mechanism as staff) scoped to that student's `user_id` — functionally equivalent to a login, without a password ever existing.

**This is a deliberate simplicity-over-security tradeoff, and it changes where the real security boundary sits: the class code is now the entire secret.** That single fact drives every compensating control below — none of these are optional hardening, they are what makes the passwordless decision defensible for a system holding sensitive psychological assessment data:

| Control | Mechanism |
|---|---|
| Join codes are not permanent | `classes.join_code_expires_at` defaults to a set window (e.g. +90 days) rather than never-expiring. Counselor can regenerate at any time, immediately invalidating the old code |
| Rate limiting is per `(class code, IP)`, failures only | Since there's no "account" to rate-limit before a successful join, `/student-access/join` throttles **failed** attempts by `(class_code, IP)` — 10 failures within 15 minutes freezes that pair. Ratified v1.2: successes are never charged (a whole class in one computer lab shares a single public IP — charging successful joins would lock the 11th student out of their own class), and the IP in the key stops an outside attacker from freezing a class out of its own code. The counselor alert is a separate, audit-derived signal — N failures against one code across *all* IPs within a window → notify — not the throttle itself |
| Tokens expire and follow enrollment | New in v1.2. Student tokens carry an expiry (hours, not days — `api_tokens.expires_at`, set from the `STUDENT_TOKEN_TTL_HOURS` var); a new join replaces any previous token (one active session, ratified); **removing a student from a class revokes their tokens immediately**; and a non-`active` user is rejected at the middleware layer even holding a live token. Without these, code expiry and rotation would only gate *new* joins while an already-issued token outlived the enrollment it was granted for |
| Errors never confirm which part was wrong | A wrong username against a valid code, and a wrong code entirely, return the **identical** generic error — this is what actually prevents the endpoint from being used to enumerate a class roster's usernames |
| Every attempt is audited | `audit_logs` records every join attempt, success and failure, with IP address and timestamp — this table is now the primary place impersonation attempts would surface, and it should be treated as such operationally, not just archivally |
| Usernames are class-scoped, not predictable across the platform | Because usernames are unique per class rather than globally (Part III §13.2), knowing one student's username elsewhere on the platform gives no information about any other class |
| Everything after access is identity-scoped as normal | Passwordless changes *how a student claims an identity*, not what that identity can see once claimed — every Policy check downstream (§39) is completely unaffected |

**Operational guidance that belongs alongside this control set, not instead of it:** counselors should be advised (in-product copy, not just this document) to treat a class join code the way they would a classroom door key — shareable with the specific students it's meant for, not posted somewhere public or long-lived beyond the enrollment period. See Part XVII for the residual risk this doesn't fully close, and Part XVIII §63 for the opt-in upgrade path if this proves insufficient in real deployment.

## 39. Authorization

Role check (coarse) + ownership check (fine), both via plain policy functions in `src/policies/` — never via database permission tables (see Part I §5 scope decision). A policy function takes the authenticated user and the target record, returns allow/deny, and is the only place an ownership rule is written down.

```
AssessmentPolicy:
  view(user, attempt)    → user.role == student && attempt.student_id == user.id
                            OR user.role == counselor && attempt belongs to one of user's classes
                            OR user.role == admin

  generateWithAi(user, template)  → template.category == CUSTOM
                                     AND (user.role == admin
                                          OR (user.role == counselor && template.creator_id == user.id))
                                     # RIASEC/SCCT: always denied, unconditionally, before any other check runs

ClassPolicy:
  manage(user, class)     → user.role == counselor && class.counselor_id == user.id
                             OR user.role == admin

RecommendationPolicy:
  view(user, recommendation) → same ownership pattern as AssessmentPolicy
```

Every route handler touching a specific record calls `authorize(...)` against one of these three policies — no exceptions, checked in code review. `generateWithAi` is checked as the very first line of every endpoint in the AI-Assisted Assessment Generation group (Part V §20) — the category exclusion is structural, not a UI-layer courtesy.

## 40. Data Protection

- Student psychological assessment data (`assessment_answers`, `dimension_scores`, `assessment_results`) is the most sensitive data in the system — visible only to the student themselves, their assigned counselor, and admins with an audit trail of access.
- Files (knowledge documents, and any documents uploaded for AI-assisted assessment generation) live in a **private** R2 bucket; access only via short-lived signed URLs, never a public path.
- No sensitive field (passwords, tokens) is ever sent to the AI Gateway — enforced by the fixed prompt templates in Part VIII §32, which only interpolate named, whitelisted fields.
- **Regulatory context (added v1.2):** the platform processes psychological assessment data of minors, which is *sensitive personal information* under the Philippine Data Privacy Act of 2012 (RA 10173). v1's posture: data minimization (only the §13 fields exist), role + ownership access control with a full audit trail, archive-over-delete for evidentiary records, and no processors beyond Cloudflare. Before any real pilot (as opposed to a seeded demo): a short privacy notice and guardian-consent step belong in the counselor onboarding material, and a retention statement ("records kept for the school year + N years, then anonymized") should be agreed with the institution. This is a paragraph of policy work, not a feature — but a thesis panel will ask.

## 41. API Security

- Every non-public route requires the `authenticate` middleware (bearer token → `api_tokens` lookup) — tokens are issued by either staff login or student-access join, both produce an identical token type downstream.
- Every write requires a Zod schema validating input before it reaches a Service.
- Rate limiting: 100 req/min general, 10 req/min on `/ai/*` and the AI-generation endpoint group, 5 attempts/min per email on `/auth/login`, 10 **failed** attempts/15min per `(class code, IP)` on `/student-access/join` (§38).
- CORS restricted to the known frontend origin(s) per environment.
- Standard security headers (CSP, X-Content-Type-Options, X-Frame-Options) set at the Cloudflare edge.

---

# Part XI — Background Jobs & Notifications

## 42. Queue Architecture

```
Trigger (event listener or direct dispatch)
        │
        ▼
Message sent to a Cloudflare Queue (producer binding: QUEUE_DEFAULT or QUEUE_AI)
        │
        ▼
The same Worker's queue() handler consumes the batch → dispatches to the matching
job handler in src/jobs/ → success (ack) or failure (retry)
        │
        ▼
Retry policy: max_retries = 3 with delayed redelivery (30s → 2min → 10min via
explicit retry delays) → Dead Letter Queue
```

A "job" in this document is a message type plus its consumer handler — Cloudflare Queues carries the message; the handler in `src/jobs/` does the work. Both the producer and consumer are this one Worker (Part II §7) — no separate consumer deployment exists.

Two logical queues in v1: `default` (notifications, light work) and `ai` (document processing, embedding generation, recommendation + explanation generation, and now assessment-draft generation — anything that calls Workers AI or does heavy text processing). Separating these two queues means a burst of AI processing never starves a simple notification from being delivered promptly. Queue consumers also get a substantially larger CPU budget than request handlers, which is exactly where document parsing and chunking belong.

## 43. Job Catalog

| Job | Queue | Triggered by | Does |
|---|---|---|---|
| `ProcessKnowledgeDocumentJob` | ai | Document upload | Extract text, clean, chunk |
| `GenerateEmbeddingJob` | ai | Each chunk created | Embed chunk, store vector, write `vector_id` |
| `GenerateRecommendationJob` | default | `DispatchRecommendationGeneration` listener — the event itself fires once per scored attempt; the **listener** dispatches this job only when both a RIASEC and an SCCT result exist for the student (v1.2 — see §24, §60) | Runs Part VII matching, persists `recommendations` |
| `GenerateExplanationJob` | ai | `RecommendationGenerated` event, or student clicks "Explain more" | Runs Part VIII §30 RAG pipeline, persists `recommendation_explanations` |
| `GenerateAssessmentDraftJob` | ai | Admin/counselor requests AI-assisted generation (document or description) | Runs Part VIII §31 pipeline, persists unconfirmed `assessment_questions` / `question_options` / `question_dimensions` |

All five jobs are idempotent: re-running `GenerateRecommendationJob` for the same result simply overwrites the prior top-10 rows rather than duplicating them; `GenerateEmbeddingJob` checks for an existing `vector_id` before re-embedding; `GenerateAssessmentDraftJob` is a one-shot per explicit user request and does not silently retrigger.

## 44. Notification System

In-app only for v1 (email/SMS/push explicitly deferred, §63).

| Event | Notification |
|---|---|
| `AssessmentCompleted` (a specific attempt scored) | "Your {assessment title} results are ready." |
| `RecommendationGenerated` | "Your career recommendations are ready to view." |
| Assignment created for a class | "New assessment assigned: {title}, due {deadline}." |
| `KnowledgeDocumentProcessed` | (to the uploading admin) "{file_name} is now available to the AI assistant." |
| `AssessmentDraftGenerated` | (to the requesting admin/counselor, new) "Your AI-generated draft for '{template title}' is ready — {N} questions need review before you can publish." |

Delivered via a direct `NotificationService::send()` call at the end of the relevant listener — no separate delivery-status state machine in v1 (a notification is either created, or it isn't; "read/unread" via `read_at` is the only status tracked).


# Part XII — Deployment & DevOps

## 45. Environment Strategy

```
Local Development  →  Staging  →  Production
```

| Environment | Purpose | Database | AI |
|---|---|---|---|
| Local | Development, `wrangler dev` + Vite dev server — Miniflare emulates D1/R2/KV/Queues locally | Local D1 (Miniflare SQLite, same dialect as production) | `wrangler dev` proxies Workers AI to the real service (`remote` binding), or a stubbed adapter returning fixed text for offline dev |
| Staging | Pre-thesis-defense rehearsal, instructor demo | Cloudflare D1 (staging DB) | Real Workers AI, staging Vectorize index |
| Production | Live thesis defense / real pilot use — the existing `careerlinkai.online` Worker + Pages project | Cloudflare D1 (production DB) | Real Workers AI, production Vectorize index |

Staging and production are two Wrangler environments (`[env.staging]` / `[env.production]` in `wrangler.toml`) of the same Worker, each with its own Cloudflare resource IDs (D1 database ID, R2 bucket, Vectorize index name, queue names). The **production environment deploys to the existing `careerlinkai.online` Worker**, replacing the beta deployment; the frontend deploys to the existing `careerlinkai.online` Pages project. Secrets go in via `wrangler secret put` (never committed); non-secret config lives as `[vars]` in `wrangler.toml`, which *is* committed.

## 46. Infrastructure Diagram

```
                         Internet
                            │
                            ▼
                    Cloudflare DNS + CDN
                            │
                            ▼
                     Cloudflare WAF
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     Cloudflare Pages              API Worker (careerlinkai.online, TypeScript/Hono)
     (React frontend)                     │
                            ┌──────────────┼───────────────┬────────────────┐
                            ▼              ▼               ▼                ▼
                     Cloudflare D1   Cloudflare R2   Cloudflare Vectorize  Cloudflare Queues
                     (28 tables)     (documents)      (embeddings)               │
                                                                                    ▼
                                                                          Cloudflare Workers AI
```

## 47. CI/CD Pipeline

GitHub Actions, triggered on push:

```
Push to branch
      │
      ▼
Install dependencies (npm install — backend and frontend workspaces)
      │
      ▼
Type check (tsc --noEmit, both workspaces) + Lint (ESLint, Prettier check)
      │
      ▼
Backend tests (Vitest via @cloudflare/vitest-pool-workers — runs in the real
Workers runtime with local D1/KV/R2/Queues bindings) + Frontend tests (Vitest)
      │
      ▼
Frontend build (vite build) + backend dry-run build (wrangler deploy --dry-run)
      │
      ▼
On main branch only: deploy
      │
      ├── Migrations → wrangler d1 migrations apply (target env DB, with pre-migration
      │                 backup via `wrangler d1 export`) — BEFORE the Worker ships
      ├── Backend → wrangler deploy --env production   (the careerlinkai.online Worker)
      └── Frontend → wrangler pages deploy              (the careerlinkai.online Pages project)
      │
      ▼
Smoke test: GET /api/v1/health returns 200
```

Branch strategy: `main` (always deployable), `develop` (integration), `feature/*` (one branch per feature/phase from the roadmap in Part XVI).

## 48. Environment Variables

Configuration lives in `wrangler.toml`, in two categories. **Bindings** (per environment — these replace connection strings entirely; there are no database/storage/AI credentials in the application at all):

```
DB              (D1 database)
STORAGE         (R2 bucket — private)
VECTORIZE       (Vectorize index)
AI              (Workers AI)
QUEUE_DEFAULT, QUEUE_AI   (Queues producers; consumers declared in [[queues.consumers]])
KV              (rate-limit counters, lockouts)
```

**Vars** (`[vars]`, committed, per environment) and **secrets** (`wrangler secret put`, never committed):

```
APP_ENV                              (local | staging | production)
FRONTEND_URL                         (CORS allow-origin)
WORKERS_AI_TEXT_MODEL, WORKERS_AI_EMBEDDING_MODEL
STUDENT_JOIN_CODE_TTL_DAYS           (default expiry window for classes.join_code_expires_at)
STUDENT_TOKEN_TTL_HOURS              (student api_tokens expiry — §38)
ASSESSMENT_GENERATION_MAX_QUESTIONS  (hard cap referenced in Part VIII §34)
```

No secrets exist in v1's steady state — every Cloudflare service is reached through a binding, not a credential. The only secret-class values are transient CI deploy credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), which live in GitHub Actions secrets, not in the Worker.

---

# Part XIII — Testing & QA Strategy

## 49. Testing Pyramid

```
                    ▲
                   / \        E2E (few) — full student journey walkthrough
                  /   \
                 /-----\      Feature tests (moderate) — one per API endpoint group
                /       \
               /---------\    Unit tests (many) — ScoringService, RecommendationService formulas,
              /-----------\    the confirmation-gate invariant, username generation algorithm
```

Most test investment goes into **unit-testing the deterministic engines** (Part VI scoring, Part VII recommendation) and **the confirmation-gate invariant** (Part VI §25) — since a bug there is the one place AI could silently corrupt scoring integrity, it deserves the same rigor as the scoring formulas themselves.

**Backend test runner (v1.3):** Vitest with `@cloudflare/vitest-pool-workers` — tests execute inside the actual Workers runtime (workerd) against real local D1, KV, R2, and Queues bindings, so a "feature test" exercises the same code path as production: real router, real middleware, real SQL against the real SQLite dialect. Nothing is mocked except Workers AI (a stub adapter behind `AiGatewayService` — §29 principle 5 is what makes that a one-line swap).

## 50. Test Types by Layer

| Layer | Test type | Example |
|---|---|---|
| `ScoringService` | Unit | Given a fixed set of answers, assert `normalized_score` and `Holland Code` match a hand-computed expected value (the Part VI worked example, encoded as a test case) |
| `RecommendationService` | Unit | Given fixed dimension scores + a fixed career/program catalog, assert `match_score` matches the Part VII worked example exactly |
| Publish gate | Unit + Feature | Assert `POST /versions/{id}/publish` returns 422/403 while any `question_dimensions.confirmed_at IS NULL`; assert it succeeds immediately after the last one is confirmed |
| `ClassEnrollmentService::previewUsernames()` | Unit | Given a name list with duplicate names, assert deterministic `2`, `3`... suffixing; assert collisions are checked only within the target class, not globally |
| Student access | Feature | Wrong username + valid code and valid username + wrong code return identical error responses; rate limit trips after the configured threshold |
| Controllers / API | Feature | "Student cannot view another student's attempt" (403); "Counselor can only see their own class roster" (403); "AI-generation request against a RIASEC template" (403, regardless of role) |
| AI Gateway | Integration (mocked provider in CI, real provider in a manual pre-release check) | Prompt builder assembles the expected context string including active `ai_policies` text; output validator rejects a too-short/absolute-claim response; generation output validator rejects a >50-question batch |
| Frontend | Unit (Vitest) + a small number of E2E (Playwright) | Assessment player renders questions in order and blocks submit until all required questions are answered; full class-code-join → take-assessment → view-recommendation walkthrough; roster-builder preview/edit/confirm flow |

## 51. Thesis Evaluation Methodology

Beyond automated tests, the following forms the defensible evaluation story for a thesis committee:

1. **Functional completeness demo** — the full journey (Part I §6 success criteria) run live, end to end, unscripted, including the AI-assisted custom exam creation with its confirmation gate.
2. **Determinism proof** — run the same RIASEC answer set twice, show identical dimension scores and Holland Code both times.
3. **Integrity proof (new)** — attempt to publish an AI-generated custom assessment with an unconfirmed mapping still pending, live, and show the system correctly refuses; then confirm the last mapping and show it now succeeds. This directly demonstrates the core safety claim of Part I principle #5, not just the scoring determinism claim.
4. **Explainability review** — for a sample of 5–10 generated recommendations, manually check that the AI explanation text does not contradict the deterministic `reason` field and does reference retrieved knowledge content.
5. **User acceptance feedback** — a small pilot group (a real class, if feasible) completes assessments and gives structured feedback.

---

# Part XIV — Monitoring & Observability

## 52. Logging Standards

Structured (JSON) logs for: staff authentication events, student class-access attempts (success and failure — this is now a security-relevant log category, see Part X §38), assessment submission, recommendation generation, every AI request (both pipelines), every queue job outcome, all errors. Log levels: DEBUG (dev only), INFO (normal business events), WARNING (recoverable), ERROR (failed operation), CRITICAL (system-wide failure). Every incoming request gets a correlation ID that flows through to any queued job it triggers.

## 53. Health Checks

```
GET /api/v1/health
```
```json
{ "status": "healthy", "database": true, "queue": true, "storage": true, "workers_ai": true, "vectorize": true }
```

Deliberately unauthenticated (it is the CI smoke-test target, §47) and deliberately terse: component booleans only — no versions, hostnames, or counts (v1.2 note).

## 54. Metrics (minimum viable set for v1)

| Category | Metric |
|---|---|
| API | Requests/min, average response time, error rate |
| Student access | Join attempts/min, success vs. failure rate per class code (new — the primary passwordless-model health signal) |
| Assessment | Attempts started vs. completed (completion rate), average scoring time |
| Assessment generation | Drafts generated, average time-to-confirm-all-mappings (new — surfaces whether the review UX is actually usable in practice) |
| AI | Requests/day, average latency, token usage, failure rate, broken down by `request_type` |
| Queue | Pending jobs, failed jobs, average processing time |

No dedicated analytics warehouse is built to house these (per the Part I §5 scope decision) — they are pulled from `ai_requests`, `audit_logs`, and basic queue-driver introspection directly.

---

# Part XV — Naming & Terminology Standards

## 55. Official Terminology

| Use this term | Not this |
|---|---|
| Assessment | Exam, Test |
| Recommendation | AI Recommendation, AI Suggestion |
| College | University, School (when referring to the catalog entity specifically) |
| College Program | Course |
| Student Profile | User Profile |
| Counselor | Adviser, Guidance Teacher |
| Administrator | Admin User |
| Class Code | Class Link, Join Link, Invite Code (pick one term and use it everywhere — "Class Code" is canonical) |
| Knowledge Document | AI Document |
| Recommendation Engine | AI Decision Engine (the engine is deterministic — the name must not imply otherwise) |
| Dimension | Trait, Factor (RIASEC/SCCT constructs are always called "dimensions" in code and UI) |
| Confirmed Mapping | Approved Question, Verified Answer (be precise — it's specifically the dimension *mapping* that gets confirmed, not the question text) |

## 56. Naming Conventions (consolidated reference)

| Element | Convention | Example |
|---|---|---|
| Tables | snake_case, plural | `assessment_attempts` |
| Columns | snake_case | `student_id`, `created_at` |
| Primary keys | `id` (UUID) | |
| Foreign keys | `<entity>_id` | `class_id` |
| Classes / types (TypeScript) | PascalCase | `RecommendationService` |
| Functions / methods | camelCase | `submitAnswer()` |
| Variables | camelCase | `dimensionScore` |
| Constants | UPPER_SNAKE_CASE | `MAX_ATTEMPT_DURATION_MINUTES` |
| Backend files | kebab-case | `scoring-service.ts` |
| API routes | kebab-case, plural nouns | `/assessment-assignments` |
| React components | PascalCase | `RecommendationCard.tsx` |
| React hooks | camelCase, `use` prefix | `useAssessment()` |
| Events | Past tense | `AssessmentCompleted` |
| Queue job handlers | camelCase verb phrase | `generateRecommendation` |


# Part XVI — Project Roadmap

## 57. Phase Plan (0–6)

Each phase ends with something demoable, not just migrations that exist. Estimated for a small team (1–3 developers). Reworked from v1.0 to reflect the corrected provisioning order, the new catalog entities, and the AI-generation feature.

> **v1.3 status note:** Phases 0–3 were completed on the pre-v1.3 Laravel stack (see PROGRESS.md). The phase descriptions below are written for the v1.3 Worker stack — for Phases 0–3 they describe what the **Platform Port** (Phase 3.5, below) must reproduce; for Phases 4–6 they describe work that starts directly on the new stack. The Phase 2 Cloudflare integration spike is superseded by the v1.3 platform decision and is retained below only as a strikethrough-style historical note.

### Phase 0 — Foundation (Week 1)

- Worker scaffold: Hono app, Drizzle + first migrations, `wrangler.toml` bindings (D1, KV), the `api_tokens` token service — folder structure from Part IV §16
- `users` (with nullable password/username removed), `counselor_profiles`, `student_profiles` migrations + seeders (1 admin, 1 counselor)
- **Two separate auth endpoints from day one**: `/auth/login` (staff) is fully built; `/student-access/join` exists as a stub until Phase 1, so the split is architectural from the start, not bolted on later
- React scaffold, staff auth screens, protected route wrapper
- **Demo:** admin and counselor log in and land on their respective dashboard shells.

### Phase 1 — Class & Enrollment (Week 2–3)

- `classes`, `class_students` migrations (with `username` on `class_students`, not `users`)
- Counselor: create class → join code generated immediately in the response
- Counselor: roster builder — paste name list → `POST .../students/preview` (username generation algorithm, Part IV §16) → edit in UI → `POST .../students/confirm` (persists accounts)
- Student: `POST /student-access/join` with class code + username → token issued, no password anywhere in this flow
- Rate limiting + audit logging on the join endpoint wired in immediately, not deferred to Phase 6 — this is core to the security model, not polish
- **Demo:** counselor creates "Grade 12 STEM A", gets the code instantly, pastes 5 names, reviews/edits the generated usernames, confirms; a seeded student accesses the class using only the code + their username.

### Phase 2 — Academic Catalog (Week 3–4, parallel with Phase 1)

- `colleges`, `programs` (with `college_id` FK), `careers`, `program_careers` migrations
- Admin CRUD: Colleges first, Programs nested under a college, then Careers and the mapping
- ~~**Cloudflare integration spike (v1.2, timeboxed 2–3 days):** prove Laravel against the real Cloudflare services before Phase 5 depends on them.~~ **Superseded in v1.3:** the spike existed to answer whether Laravel could use D1/Queues at all; moving the backend into the Workers runtime resolves it by construction — D1, Queues, Workers AI and Vectorize are native bindings. The two residual unknowns the spike would also have measured (Workers AI generation latency against the §6 8-second budget, Vectorize upsert lag) move to Phase 5a, where they are measured on first integration rather than speculatively.
- **Demo:** admin adds 3–5 real colleges, several programs under each (with `recommended_strand` set), 10 careers (with `typical_riasec_code`), maps them.

### Phase 3 — Assessment Engine (Week 4–7, the core phase)

- **Entry gate (v1.2):** the Part VI spec resolutions from the 13 Jul 2026 audit (unified event semantics, dimension freeze, prorating, attempt rules) are merged into this document before the first assessment migration is written — *satisfied by v1.2 itself*
- All 7 assessment-module tables, including `question_dimensions.confirmed_at`/`confirmed_by`, the `(assignment_id, student_id)` unique constraint, and the dimension freeze enforcement
- Student profile completion — the §37 profile screen + `GET/PATCH /student/profile` (GWA, subject grades, strand). Assigned to this phase in v1.2 because Phase 4's engine consumes these fields and no phase previously owned them
- **Content entry:** seed real RIASEC (6 dimensions × 10 questions = 60 questions) and SCCT (3 dimensions × 10 questions = 30 questions) — manually authored, `confirmed_at` set at creation. Budget real time here — this remains the single largest content task in the project.
- Build `ScoringService` **first**, unit-test it standalone against the Part VI worked examples *before* wiring up any UI.
- Build the publish-gate check (`question_dimensions` confirmation invariant) as part of this phase, even though AI-generation doesn't exist yet — manual creation flows should already be setting `confirmed_at` correctly, so the gate is trivially satisfied and testable from day one of this phase.
- Counselor: create assignment for a class. Student: take assessment (question-by-question player), submit, see result.
- **Demo:** a seeded student completes RIASEC end to end and sees a Holland Code + dimension breakdown that matches a hand-computed expected value.

### Phase 3.5 — Platform Port (new in v1.3 — Week 7–9, must complete before Phase 4 starts)

Re-implement everything Phases 0–3 delivered, on the Worker stack, deployed to the existing `careerlinkai.online` Worker. This is a port against an executable specification, not a redesign:

- **The contract is already written.** The API catalog (Part V), the schema (Part III), and — most importantly — the 233-test Laravel suite define exactly what "done" means. Port the test expectations to Vitest (`@cloudflare/vitest-pool-workers`) module by module; a ported module is finished when its ported tests pass and the untouched React frontend works against it.
- **Port order mirrors the original build order:** scaffold + token service + staff auth (Phase 0 scope) → classes, roster provisioning, student access with rate limiting and audit logging (Phase 1) → academic catalog (Phase 2) → assessment engine, scoring, publish gate (Phase 3). Each step re-runs that phase's §57 demo on `wrangler dev`, then on staging.
- **The frontend is the invariant.** Zero changes to the React app are expected beyond the API base URL; any frontend change the port seems to require means the port has drifted from the contract — stop and fix the backend.
- **Migrations are rewritten once, as plain SQL** (`backend/migrations/`, applied with `wrangler d1 migrations apply`), reproducing the Part III schema exactly — including the UUID v4 PKs, CHECK-constraint enums, and every unique constraint ratified in v1.2.
- **Exit:** the Laravel `backend/` is archived/removed from the working tree once the full Phase 0–3 walkthrough passes on staging. No period of dual-running two backends.
- **Demo:** the Phase 1 and Phase 3 §57 demos, run end to end against the Worker on staging, with the existing frontend.

### Phase 4 — Recommendation Engine (Week 9–10)

- `recommendations` table + `RecommendationService` implementing Part VII exactly (two-value strand, real `college_id` join), unit-tested against the worked example
- `GenerateRecommendationJob`, wired to `AssessmentCompleted`
- Student: recommendations screen (ranked career + program cards, derived college, match %, reason)
- **Demo:** after both RIASEC and SCCT are complete, student sees a ranked recommendation list with the correct college attached via the real FK, and zero AI involvement.

### Phase 5 — AI Layer (Week 10–13, split into two sub-phases sharing the same underlying `AiGatewayService`/`ai_requests` infrastructure)

**5a — Recommendation Explanation (Week 10–11):**
- `knowledge_documents`, `knowledge_chunks`, `ai_requests`, `recommendation_explanations`, `ai_policies`
- `AiGatewayService`, `RetrievalService`, ingestion pipeline (Part VIII §33)
- Admin uploads 3–5 real knowledge documents; admin sets an initial `ai_policies` row
- `GenerateExplanationJob` wired to `RecommendationGenerated`
- **Measure the two residual unknowns inherited from the retired spike (v1.3):** bare Workers AI generation latency against the §6 under-8-seconds budget, and Vectorize upsert lag (upserts are asynchronous — an immediate query legitimately returning zero matches is not a failed write). Record both in PROGRESS.md
- **Demo:** a recommendation from Phase 4 now shows a grounded AI paragraph referencing uploaded knowledge content and respecting the configured AI policy.

**5b — AI-Assisted Assessment Generation (Week 11–13):**
- `source`/`source_ai_request_id` on `assessment_questions`
- `AssessmentGenerationService`, `GenerateAssessmentDraftJob`, both generation entry modes (document upload, description)
- The confirmation-gate review UI (per-question, per-mapping — not a bulk-approve shortcut)
- Category-exclusion enforcement in `AssessmentPolicy`, tested explicitly against RIASEC/SCCT templates
- **Demo:** counselor uploads a short document, gets a draft custom assessment back, the publish button stays disabled with a clear "3 of 12 mappings confirmed" message until every mapping is reviewed, then publishes successfully — and a parallel attempt to run the same flow against the RIASEC template is rejected by the backend.

### Phase 6 — Polish & Defense Prep (Week 13–14)

- `notifications`, `audit_logs` dashboards
- Role dashboards (live-query, Part XIV metrics, including the new student-access success/failure metric)
- Bug bash against the full success-criteria list (Part I §6)
- Thesis evaluation methodology dry run (Part XIII §51), including the new integrity-proof demo

## 58. Milestone Checklist

- [ ] Phase 0: staff roles can log in and reach their dashboard shell; student-access endpoint exists as a stub
- [ ] Phase 1: join code generated at class creation; bulk roster preview/edit/confirm works; passwordless student access works with rate limiting and audit logging live
- [ ] Phase 2: colleges/programs/careers catalog is populated and admin-editable, with programs correctly nested under colleges ~~; Cloudflare integration spike has a written go/no-go (v1.2)~~ *(spike superseded by the v1.3 platform decision)*
- [ ] Phase 3: `ScoringService` unit tests pass against hand-computed values; publish-gate unit tests pass; a real student can complete both assessments
- [ ] Phase 3.5 (v1.3): the full Phase 0–3 scope runs on the `careerlinkai.online` Worker on staging — ported Vitest suite green, unchanged frontend works end to end, Laravel backend retired
- [ ] Phase 4: `RecommendationService` unit tests pass against the worked example; ranked recommendations appear with the correct derived college and zero AI calls
- [ ] Phase 5a: at least one AI explanation demonstrably references uploaded knowledge content and reflects the configured AI policy
- [ ] Phase 5b: an AI-generated custom assessment cannot publish with an unconfirmed mapping, and the same generation flow is confirmed rejected against RIASEC/SCCT
- [ ] Phase 6: full unscripted walkthrough of Part I §6 succeeds live, including the integrity-proof demo

---

# Part XVII — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **The Phase 3.5 port silently drifts from what Phases 0–3 already proved** — a behavior verified by the Laravel suite (identical join errors, failure-only throttling, the publish gate) is re-implemented subtly differently (new in v1.3; replaces the retired "Laravel has no D1 driver" risk, which the platform decision resolved structurally) | Medium | High | The port is contract-driven (§57 Phase 3.5): the old suite's assertions are ported to Vitest module by module and define "done"; the unchanged frontend is the second, independent check — any frontend edit the port "needs" is treated as a port bug |
| **Workers runtime limits bite heavy work** — CPU-milliseconds per invocation, request body limits, and no native binaries: PDF/DOCX text extraction must use pure-JS/WASM parsers (e.g. unpdf, mammoth) and is the most CPU-hungry thing in the system (new in v1.3) | Medium | Medium | All parsing/chunking/embedding runs in queue consumers, never request handlers — consumers get a much larger CPU budget and retries are free (§42); uploads capped at 10MB (§33); scoring itself is trivially cheap (integer arithmetic over ≤60 answers) and stays synchronous per §24 |
| Cloudflare D1's join/transaction limits slow down deep queries (e.g., recommendation catalog scan) | Medium | Medium | Recommendation computation runs as a queued job, not inline on the request; catalog scan is over a modest seed catalog for v1 — revisit only if it grows to hundreds of rows |
| RIASEC/SCCT question-bank content entry takes longer than estimated (Phase 3) | High | High | Flagged explicitly as the largest content task in the roadmap (§57); start content drafting in parallel with Phase 0-2 engineering |
| **Class join code leaks or is shared beyond its intended class** (new, passwordless-specific) | Medium | High | Code expiry (default window, regenerable), rate limiting per code, identical generic errors on any failure mode, full audit trail — see Part X §38. Residual risk: none of these prevent a leaked *valid, unexpired* code from being usable by someone outside the class; this is the accepted tradeoff of the passwordless decision, not a solved problem — if it proves insufficient in real deployment, §63 has the opt-in password upgrade path |
| **AI-generated assessment content is low-quality even when dimension mappings are correctly confirmed** (new) | Medium | Medium | The confirmation gate (Part VI §25) guarantees a human reviewed *what a question measures* — it does not guarantee the question is *well-written*. This is a real, distinct residual risk: mapping correctness is not content quality. Mitigated by the same UI review step showing full question text (not just mapping metadata) before confirmation, but ultimately depends on the human reviewer actually reading, not just clicking through |
| Workers AI latency or availability issues during a live thesis defense | Medium | High | Deterministic scoring and recommendation screens work with zero AI dependency for both explanation and generation — a failed generation job leaves a template safely in DRAFT with nothing published, never a corrupted or partially-live state |
| Score formula bug discovered late (after content is seeded) | Low (if unit-tested early per Phase 3) | Very High | `ScoringService`, `RecommendationService`, and the confirmation-gate invariant are all unit-tested against hand-computed worked examples *before* UI work begins |
| Scope creep back toward the original 39-document enterprise design, or toward unscoped AI features beyond what was explicitly agreed | Medium | High | This document is the single source of truth for v1; any table/pattern/AI capability not listed in Parts III-VIII requires an explicit, written decision to add |
| Single-developer bus factor (thesis projects are often solo) | Medium | High | Every deterministic formula and every security-relevant invariant (the confirmation gate, the passwordless compensating controls) is written down in this document precisely enough to be re-implemented from the spec alone |

---

# Part XVIII — Appendices

## 60. Domain Events Catalog

The complete list — exactly four, per Part II §11:

| Event | Published by | Payload | Subscribers |
|---|---|---|---|
| `AssessmentCompleted` | Attempt & Results module — once per attempt, when `ScoringService` finishes (any category, including ungraded CUSTOM; v1.2 unified semantics, §24) | `student_id`, `assessment_result_id` | Platform module (per-attempt result notification, §44); Recommendation module (`DispatchRecommendationGeneration` — dispatches `GenerateRecommendationJob` only once both a RIASEC and an SCCT result exist for the student) |
| `RecommendationGenerated` | Recommendation module, after top-10 career + program rows persisted | `student_id`, `recommendation_ids[]` | Platform module (notification), AI module (`GenerateExplanationJob`) |
| `KnowledgeDocumentProcessed` | AI/Knowledge module, after all chunks embedded | `document_id`, `uploaded_by` | Platform module (notification) |
| `AssessmentDraftGenerated` | AI module, after `GenerateAssessmentDraftJob` completes | `assessment_version_id`, `requested_by`, `questions_generated_count` | Platform module (notification) |

## 61. Glossary

- **RIASEC** — Holland's vocational interest typology: Realistic, Investigative, Artistic, Social, Enterprising, Conventional.
- **Holland Code** — the top 3 RIASEC dimensions for a person, e.g. "IAS", used as a compact interest signature.
- **SCCT** — Social Cognitive Career Theory; in v1, measured via Self-Efficacy, Outcome Expectations, and Goal Orientation.
- **Career Confidence Index** — the composite 0-100 score derived from the three SCCT dimensions (Part VI §23).
- **Dimension** — a single measured construct within an assessment (an RIASEC letter, or an SCCT construct, or a creator-defined construct in a CUSTOM assessment).
- **Assessment Template / Version** — a template is the logical assessment ("RIASEC"); a version is one immutable, publishable snapshot of its questions and scoring config.
- **Match Score** — the 0-100 deterministic output of the Recommendation Engine for a specific career or program (Part VII).
- **RAG** — Retrieval-Augmented Generation; the pattern of retrieving relevant text before asking an AI model to generate a response, used for the explanation pipeline.
- **Class Code** — the sole credential pairing with a per-class username that grants a student access; there is no student password in v1 (Part X §38).
- **Confirmed Mapping** — a `question_dimensions` row a human has explicitly reviewed and approved (`confirmed_at` set); the mechanism that keeps AI-assisted content out of the scoring-integrity path (Part VI §25).
- **AI Policy** — an admin-configured `ai_policies` row containing instructions/restrictions injected into every AI prompt (Part VIII §32).
- **Modular Monolith** — one deployable application, internally organized into modules with enforced (code-discipline, not physical) boundaries.

## 62. Table Quick-Reference Index

| # | Table | Module |
|---|---|---|
| 1 | users | Identity & Access |
| 2 | counselor_profiles | Identity & Access |
| 3 | student_profiles | Identity & Access |
| 4 | classes | Class |
| 5 | class_students | Class *(holds per-class `username`)* |
| 6 | colleges | Academic Catalog *(new in v1.1)* |
| 7 | programs | Academic Catalog *(now `college_id` FK)* |
| 8 | careers | Academic Catalog |
| 9 | program_careers | Academic Catalog |
| 10 | assessment_templates | Assessment |
| 11 | assessment_versions | Assessment |
| 12 | assessment_dimensions | Assessment |
| 13 | assessment_questions | Assessment *(now carries `source`, `source_ai_request_id`)* |
| 14 | question_options | Assessment |
| 15 | question_dimensions | Assessment *(now carries `confirmed_at`, `confirmed_by`)* |
| 16 | assessment_assignments | Assessment |
| 17 | assessment_attempts | Attempt & Results |
| 18 | assessment_answers | Attempt & Results |
| 19 | dimension_scores | Attempt & Results |
| 20 | assessment_results | Attempt & Results |
| 21 | recommendations | Recommendation |
| 22 | recommendation_explanations | Recommendation |
| 23 | knowledge_documents | AI / Knowledge |
| 24 | knowledge_chunks | AI / Knowledge |
| 25 | ai_requests | AI / Knowledge |
| 26 | ai_policies | AI / Knowledge *(new in v1.1)* |
| 27 | notifications | Platform |
| 28 | audit_logs | Platform |

## 63. Deferred / Future Scope (v2+)

Every item below was deliberately left out of v1. Each has a stated trigger — the condition under which it should be picked back up.

| Deferred item | Bring it back when... |
|---|---|
| Multi-school / `organizations` table, `organization_id` on every table | A second real institution needs to run its own instance of the platform (unrelated to the many-college catalog, which is already in scope) |
| Full RBAC permission-matrix tables (`roles`, `permissions`, `role_permissions`) | Fixed 3-role authorization is no longer sufficient |
| `departments` as a normalized table (still denormalized text on `programs`) | Department names need independent editing or history — colleges already made this jump in v1.1; departments can follow the same pattern later |
| Optional student passwords (opt-in upgrade to the passwordless model) | Real deployment shows the class-code-only model is insufficient — e.g., older students specifically request a personal password, or an incident makes the residual risk in Part XVII unacceptable in practice. Designed to be additive: a nullable `password` already exists on `users`, so this is a pure feature-flip, not a schema migration |
| Cross-class student identity linking — an "attach existing student" step during roster confirm (v1.2) | The same real person needs continuous assessment history across classes or school years. v1 deliberately accepts one account per provisioning batch with fragmented history (§13.2) — bring this back when longitudinal tracking becomes a real requirement, e.g. a Grade 11 → Grade 12 cohort carries over |
| `COUNSELOR_PRIVATE` knowledge documents — counselor upload endpoints + a retrieval-visibility rule (v1.2) | A counselor genuinely needs private RAG source material. Deferred because v1.1 specified the enum value with no endpoints and no retrieval scoping, which was a leak waiting to happen; v1 knowledge is `GLOBAL` only |
| `login_history` / `user_sessions` tables for staff | A security review or a "log out of all devices" feature request becomes real |
| Assessment resume/autosave history (`assessment_progress`, `assessment_answer_history`) | Users report losing progress on refresh in real usage |
| Student preference capture (feeds into the currently-flat `student_preference = 70` constant in Part VII) | A preference-input UI is designed |
| SCCT confidence made career-cluster-specific (currently one flat number applied to every career) | Evidence suggests self-efficacy meaningfully varies by career cluster for the target population |
| Finer strand taxonomy underneath the two broad tracks | The coarse `Academic` / `Technical-Professional` signal proves insufficiently discriminating in practice — confirmed as sufficient for v1 in this revision |
| `ai_policies.scope` extended beyond `GLOBAL` (per-category, per-visibility-tier) | A real conflict arises requiring different AI restrictions for different knowledge tiers or assessment categories — the column is already designed to extend without a migration |
| Prompt templates moved from files to database rows with a UI editor | A non-engineer needs to tune the underlying prompt structure itself, beyond what the `ai_policies` text injection already allows |
| Dedicated analytics/event-sourcing warehouse | Live-query dashboards measurably become too slow |
| Email/SMS/push notification channels | In-app-only notifications are confirmed insufficient by real user feedback |
| A second AI provider adapter or a second vector store adapter | Cloudflare Workers AI or Vectorize has a real, specific limitation the project hits in practice |
| AI-assisted generation extended to RIASEC/SCCT | **Never.** This is a permanent architectural rule (Part I §5), not a deferred feature — restated here explicitly so it is never mistaken for a toggle |
| CQRS / read-write separation | A specific module's read/write contention becomes a measured problem |
| Parent portal, scholarship matching, resume builder, AI interview coach | Core v1 is validated with real users first |

**End of document.**