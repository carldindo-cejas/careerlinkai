# CareerLinkAI — Quick Reference

Lookup aid only. **`FULLPLAN.md` is authoritative** — when this file and the plan disagree, the plan
is right and this file is a bug. Nothing here is a substitute for reading the relevant Part before
implementing it.

> **v1.3:** the backend is a TypeScript Cloudflare Worker. The Laravel implementation of Phases 0–3
> is retired and being ported (Phase 3.5); do not extend it.

## Project Structure

```
careerlinkai_v1/
├── FULLPLAN.md                  # Master project plan — SOURCE OF TRUTH
├── .claude/                     # Working agreement + this lookup aid
├── backend/                     # Cloudflare Worker (TypeScript, Hono)
│   ├── wrangler.toml            # Bindings: DB, STORAGE, VECTORIZE, AI, QUEUE_*, KV + [vars]
│   ├── migrations/              # Plain-SQL D1 migrations — append-only, never edit a shipped one
│   ├── test/                    # Vitest (@cloudflare/vitest-pool-workers)
│   └── src/
│       ├── index.ts             # fetch → Hono app · queue → job consumers
│       ├── app.ts               # /api/v1 mount, global middleware, error envelope
│       ├── db/schema.ts         # Drizzle table definitions (28 domain + infrastructure)
│       ├── modules/             # identity, classes, catalog, assessment, attempt,
│       │                        #   recommendation, ai, platform
│       │                        #   (each: routes.ts, schemas.ts, service.ts, serializers.ts)
│       ├── middleware/          # authenticate, ensure-role, rate-limit, correlation-id
│       ├── policies/            # class, assessment, recommendation — plain functions
│       ├── events/              # dispatcher + the exactly-4 events (FULLPLAN §11)
│       ├── jobs/                # queue consumer handlers (5)
│       ├── prompts/             # versioned prompt files (§32)
│       └── lib/                 # envelope, crypto (PBKDF2/tokens), slugify, text-extraction
└── frontend/                    # React 19 + TypeScript + Vite
    └── src/
        ├── app/                 # App.tsx, providers, router, query client
        ├── features/            # auth, student-access, admin, counselor, student,
        │                        #   assessment-builder, assessment-generator,
        │                        #   assessment-player, notifications
        ├── components/ui/       # shadcn primitives
        ├── layouts/  services/  stores/  hooks/  routes/  types/
```

Each `features/` folder owns its own `api/`, `components/`, `pages/`, `hooks/`, `types/`.
Full structure: FULLPLAN §16 (backend), §35 (frontend).

## Stack

| Layer | Choice |
|---|---|
| Backend | TypeScript on Cloudflare Workers · Hono · Zod · Drizzle ORM |
| Auth | First-party token service (`api_tokens`, hashed opaque bearer tokens) — **both** staff and students |
| Database | Cloudflare D1 (SQLite dialect) — native binding |
| Frontend | React 19 + TypeScript, Vite |
| Styling | Tailwind CSS + shadcn/ui |
| Server state | TanStack Query · **Client state** Zustand · **Forms** React Hook Form + Zod |
| Storage / Vectors / AI / Queues / Cache | Cloudflare R2 · Vectorize · Workers AI · Queues · KV — all native bindings |
| Testing | Vitest via `@cloudflare/vitest-pool-workers` (backend) · Vitest + Playwright (frontend) |
| Hosting | Existing `careerlinkai.online` Worker (API) + `careerlinkai.online` Pages (frontend) |

## Quick Commands

```bash
# Backend (cd backend)
npm install
npx wrangler d1 migrations apply DB --local    # append-only migrations (drop --local for remote)
npm test                                        # Vitest in the Workers runtime
npx wrangler dev                                # local dev — Miniflare emulates D1/KV/R2/Queues
npx wrangler deploy --env production            # the careerlinkai.online Worker
npx wrangler secret put NAME                    # secrets never go in wrangler.toml

# Frontend (cd frontend)
npm install
npm run dev
npm run build
npm test                       # Vitest
```

## Database Tables (28)

UUID v4 primary keys. **No auto-increment, ever.** No native `ENUM` (D1/SQLite) — use `TEXT` +
`CHECK` constraint in SQL, string-literal union on the Drizzle column. Full schema: FULLPLAN §13.
Index: §62. Infrastructure tables (uncounted): `api_tokens`, `password_reset_tokens`.

| Module | Tables |
|---|---|
| Identity & Access | `users`, `counselor_profiles`, `student_profiles` |
| Class | `classes`, `class_students` *(holds per-class `username`)* |
| Academic Catalog | `colleges`, `programs` *(`college_id` FK)*, `careers`, `program_careers` |
| Assessment | `assessment_templates`, `assessment_versions`, `assessment_dimensions`, `assessment_questions` *(`source`, `source_ai_request_id`)*, `question_options`, `question_dimensions` *(`confirmed_at`, `confirmed_by`)*, `assessment_assignments` |
| Attempt & Results | `assessment_attempts`, `assessment_answers`, `dimension_scores`, `assessment_results` |
| Recommendation | `recommendations`, `recommendation_explanations` |
| AI / Knowledge | `knowledge_documents`, `knowledge_chunks`, `ai_requests`, `ai_policies` |
| Platform | `notifications`, `audit_logs` |

There are no model classes — `src/db/schema.ts` defines every table once; row types via
`$inferSelect`.

## Services — where business logic lives

| Concern | Service |
|---|---|
| Staff login (email + password) | `StaffAuthenticationService` |
| Passwordless student access | `StudentAccessService` |
| Class CRUD, join-code lifecycle | `ClassService` |
| Bulk roster (`previewUsernames()`, `confirmEnrollment()`) | `ClassEnrollmentService` |
| Colleges, programs, careers | `AcademicCatalogService` |
| Assessment authoring / attempts | `AssessmentBuilderService`, `AssessmentAttemptService` |
| **RIASEC + SCCT scoring** (Part VI) | `ScoringService` |
| **Deterministic matching** (Part VII) | `RecommendationService` |
| Sole entry point to Workers AI | `AiGatewayService` |
| AI-assisted drafting (CUSTOM only) | `AssessmentGenerationService` |
| Knowledge ingest / vector search | `KnowledgeIngestionService`, `RetrievalService` |
| Active `ai_policies` → prompt context | `AiPolicyService` |
| Notifications / audit | `NotificationService`, `AuditService` |

## API

Base path `/api/v1/`. Bearer token (`api_tokens`). Routes are kebab-case plural nouns.
**Complete catalog: FULLPLAN §20** (~92 endpoints). Groups:

| Group | Count |
|---|---|
| `/auth` (staff) | 6 |
| `/student-access` (passwordless — deliberately separate) | 1 |
| `/admin` | ~34 |
| `/counselor` | ~24 |
| `/student` | ~16 |
| `/assessment-templates/{id}` (AI generation, policy-gated) | 6 |
| `/ai` · `/notifications` · public/health | 1 · 3 · 2 |

Success envelope: `{ success, message, data, meta }` · Error: `{ success: false, message, errors }`.
Status codes incl. **403 for category exclusion** (AI generation attempted against RIASEC/SCCT).
Rate limits (KV-backed): 100/min general · 10/min on `/ai/*` · 5/min per email on `/auth/login` ·
10 **failed** per 15min per `(class code, IP)` on `/student-access/join`.

## Roles

| Role | Can | Cannot |
|---|---|---|
| **Student** | Take assigned assessments, view own results + recommendations | See any other student's data; see other classes |
| **Counselor** | Manage **own** classes, roster, assignments; create/edit CUSTOM assessments (manual or AI-assisted) | Touch RIASEC/SCCT; access another counselor's classes |
| **Admin** | Full system access | — |

## Authentication

```
Staff (admin/counselor)          Student (passwordless — no password exists, ever)
─────────────────────────        ──────────────────────────────────────────────────
POST /auth/login                 POST /student-access/join
  email + password                 class_code + username (unique within that class)
  → bearer token (api_tokens)      → bearer token (api_tokens), scoped to that student
  PBKDF2-SHA256, min 10 chars      users.password IS NULL for all students
  5 fails → 15-min lock            Wrong code and wrong username return the SAME
  must_change_password gate        generic error (anti-roster-enumeration)
```

Both flows produce an **identical token type downstream** — passwordless changes how a student *claims*
an identity, not what that identity can see. Details + the full compensating-control set: FULLPLAN §38.

## ⛔ Never

- Auto-increment PKs · native `ENUM` columns · soft-deletes on attempts/answers/results
- Hardcode AI policies (they live in `ai_policies`) or credentials (bindings + `wrangler secret`, never in code or committed config)
- AI-generate or AI-edit RIASEC/SCCT — **CUSTOM only**, enforced in the `generateWithAi` policy first
- Publish a version with any unconfirmed `question_dimensions` mapping
- Write to a `PUBLISHED` version · point an assignment at a template instead of a version
- Edit an `assessment_dimension` once any version of its template is published (frozen — v1.2, §12)
- Parse the SCCT confidence index out of `overall_summary` — always recompute from `dimension_scores` (§23)
- Do heavy work (parsing, chunking, embedding) in a request handler — it belongs in a queue consumer (§42)
- Leak data across classes · call the API directly from a React component (always: component → hook → service)

## ✅ Always

- Look it up in FULLPLAN before implementing — never from memory
- `authorize(...)` on every handler touching a specific record
- Validate server-side via the endpoint's Zod schema before anything reaches a Service
- Inject active `ai_policies` into every prompt
- Unit-test the deterministic engines against the Part VI/VII worked examples

## Where Things Are Specified

| Need | Location |
|---|---|
| Schema (all 28 tables) | Part III §13 · index §62 |
| Backend structure / patterns | Part IV §16–17 |
| Endpoint catalog | Part V §20 |
| RIASEC / SCCT scoring + worked examples | Part VI §22–23 |
| Confirmation gate mechanics | Part VI §25 |
| Recommendation formulas + worked example | Part VII §27–28 |
| RAG + generation pipelines, prompts | Part VIII §30–34 |
| Frontend structure / state | Part IX §35–36 |
| Security (auth, authz, rate limits) | Part X §38–41 |
| Deployment / environments / CI | Part XII §45–48 |
| Phase plan (incl. the 3.5 port) | Part XVI §57 |
| Terminology (enforced) | Part XV §55 |

---

**Last Updated**: 2026-07-13 · **Tracks**: FULLPLAN.md v1.4
