# CareerLinkAI

Career-guidance platform for students. It administers validated career-interest assessments
(**RIASEC** and **SCCT**), scores them deterministically, and produces explainable program/career
recommendations grounded in a school's own academic catalog — with AI used only to *draft* and
*explain*, never to score.

- **Backend** — a TypeScript [Cloudflare Worker](https://developers.cloudflare.com/workers/) (Hono · Zod · Drizzle ORM) on D1, R2, Vectorize, Workers AI, Queues, KV, and a Durable Object.
- **Frontend** — React 19 + TypeScript + Vite, deployed to Cloudflare Pages.

> **Source of truth is [`FULLPLAN.md`](FULLPLAN.md).** When any doc (including this one) disagrees
> with the plan, the plan wins. [`.claude/QUICKREF.md`](.claude/QUICKREF.md) is the fast lookup aid.

---

## Stack

| Layer | Choice |
|---|---|
| Backend | TypeScript on Cloudflare Workers · Hono · Zod · Drizzle ORM |
| Database | Cloudflare D1 (SQLite dialect) — native binding |
| Storage / Vectors / AI / Queues / Cache | R2 · Vectorize · Workers AI · Queues · KV — all native bindings |
| Auth | First-party opaque bearer tokens (hashed), PBKDF2-SHA256 in a Durable Object |
| Frontend | React 19 + TypeScript · Vite · Tailwind CSS + shadcn/ui |
| State | TanStack Query (server) · Zustand (client) · React Hook Form + Zod (forms) |
| Testing | Vitest via `@cloudflare/vitest-pool-workers` (backend) · Vitest + Testing Library (frontend) |
| Hosting | `careerlinkai.online` Worker (API) + Cloudflare Pages (frontend) |

## Repository layout

```
careerlinkai_v1/
├── FULLPLAN.md              # Master project plan — SOURCE OF TRUTH
├── PROGRESS.md              # Phase-by-phase build log
├── .claude/QUICKREF.md      # Lookup aid (structure, endpoints, roles, conventions)
├── backend/                 # Cloudflare Worker (TypeScript, Hono)
│   ├── src/                 # index.ts · app.ts · modules/ · middleware/ · db/ · jobs/ · lib/
│   ├── migrations/          # Plain-SQL D1 migrations — append-only, never edit a shipped one
│   ├── seeds/               # Staff, academic catalog, AI policy
│   ├── test/                # Vitest (@cloudflare/vitest-pool-workers)
│   ├── wrangler.toml        # Deploy config — staging + production environments
│   ├── wrangler.test.toml   # Hermetic offline config (no AI/Vectorize) — tests + `npm run dev`
│   └── wrangler.dev.toml    # Mixed-mode dev — local storage + REAL AI/Vectorize (staging index)
├── frontend/                # React 19 + Vite
├── scripts/                 # walkthrough.mjs (end-to-end browser run), bootstrap-staff.mjs
└── docs/                    # api · architecture · audit · spikes
```

## Prerequisites

- **Node.js 22** (matches CI)
- A **Cloudflare account** with Wrangler auth (`npx wrangler login`) — only needed for the
  AI-enabled dev loop and for deploys. The default test/dev loops run fully offline.

---

## Getting started

### Backend

```bash
cd backend
npm install
npm run db:migrate        # apply migrations to the LOCAL D1
npm run db:seed           # staff accounts + academic catalog + AI policy (local)
npm run dev               # offline dev server (Miniflare emulates D1/KV/R2/Queues/DO)
```

### Frontend

```bash
cd frontend
npm install
npm run dev               # Vite on http://localhost:5173 (the API's CORS allow-list origin)
```

The frontend expects the API at `http://localhost:8787/api/v1` when running the local backend.

---

## Dev, test & staging workflow

Three profiles, matched to the job. **The automated suite runs offline by design** — do not route it
through the network (per-file isolated storage and zero-credential CI depend on it).

| Profile | Command | Storage | AI / Vectorize | Login? | Use for |
|---|---|---|---|---|---|
| Hermetic suite | `npm test` | local (isolated per file) | stubbed / absent | no | the gate on every push · CI |
| Offline dev | `npm run dev` | local | absent | no | default loop — auth, classes, assessments, recs |
| Mixed-mode dev | `npm run dev:remote` | local (disposable) | **real** (`remote = true`) | yes | Phase 5 RAG/generation — real model + real index |
| Staging | `npm run deploy:staging` | real staging | real | yes | **pre-prod fidelity gate** |

**Staging is the required check before production, not optional.** Miniflare enforces neither the
PBKDF2 100k-iteration ceiling nor the 10 ms Worker CPU limit, and has no AI/Vectorize emulation — so a
green suite proves the *contract*, but staging proves the *platform*. `scripts/walkthrough.mjs` drives
the real browser flow against either local or staging. See
[`.claude/QUICKREF.md`](.claude/QUICKREF.md#test--dev-environments) for the full rationale.

`dev:remote` points Vectorize at the **staging** index, never production — dev must not write
production data. `remote` is a dev-only flag; `wrangler deploy` ignores it.

## Testing

```bash
# Backend (cd backend)
npm test                  # Vitest in the real Workers runtime (offline, hermetic)
npm run type-check        # tsc --noEmit
npm run lint              # eslint
npm run gate:platform     # asserts the Miniflare-blind config invariants (no [limits], AUTH_DO, …)

# Frontend (cd frontend)
npm test
npm run type-check
npm run build
```

CI (`.github/workflows/ci.yml`) runs type-check · lint · platform gates · tests for both apps on
every push and PR, with **no Cloudflare credentials** — the backend suite is fully offline.

## Deployment

```bash
# Backend (cd backend)
npm run db:migrate:staging      # apply migrations to remote staging D1
npm run deploy:staging          # publish the careerlinkai-staging Worker
npm run db:migrate:production
npm run deploy:production        # publish the careerlinkai.online Worker

# Frontend (cd frontend)
npm run deploy:staging          # build + wrangler pages deploy
```

Staging and production are two Wrangler environments of the same Worker with **separate** D1, KV, R2,
Vectorize, and queues — staging can never write to production data. Secrets go through
`wrangler secret put NAME`, never into committed config.

## API

Base path `/api/v1/`. Bearer-token auth. Roles: **Student** (passwordless join), **Counselor** (owns
their classes and CUSTOM assessments), **Admin** (full access). Full endpoint catalog (~92 endpoints)
in [`FULLPLAN.md`](FULLPLAN.md) §20; summary in [`.claude/QUICKREF.md`](.claude/QUICKREF.md#api).

## Further reading

| Topic | Location |
|---|---|
| Full project plan (authoritative) | [`FULLPLAN.md`](FULLPLAN.md) |
| Quick reference (structure, endpoints, conventions) | [`.claude/QUICKREF.md`](.claude/QUICKREF.md) |
| Build progress log | [`PROGRESS.md`](PROGRESS.md) |
| Backend audit | [`BACKENDAUDIT.md`](BACKENDAUDIT.md) |
| API / architecture / audit / spikes | [`docs/`](docs/) |
