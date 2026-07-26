# Production Readiness Requirements

**Audited:** 2026-07-25 · **Current live prod code:** `careerlinkai` Worker last deployed 2026-04-25 (Initial Commit era — Phases A–H absent).

This file records what stands between the current repo state and a working production
deploy at `careerlinkai.online`. Staging (`careerlinkai-staging`) is fully deployed and
healthy; production is **not ready** — a `deploy:production` today would fail at the queue
step, and even if it passed the database would be empty.

Two Wrangler environments of one Worker share `backend/wrangler.toml`. Production bindings
(`[env.production]`) are fully written and mirror staging with production resources — the
gaps below are **live-state** gaps (missing resources, unapplied migrations, unseeded data,
missing frontend build target), not config gaps.

---

## 🔴 Blockers — deploy fails or app is broken without these

### 1. Production DLQs do not exist
`wrangler.toml` (`[env.production]`) declares consumers for `careerlinkai-default-dlq` and
`careerlinkai-ai-dlq`, but neither queue exists in the account (only the staging DLQs were
created, 2026-07-21). `wrangler deploy --env production` hard-fails until they exist.

```bash
npx wrangler queues create careerlinkai-default-dlq
npx wrangler queues create careerlinkai-ai-dlq
```

### 2. Production D1 has zero migrations applied
All 13 migrations (0001–0013) are pending on `CareerLinkAI_Main`. The database has no tables.

```bash
npm run db:migrate:production   # wrangler d1 migrations apply CareerLinkAI_Main --remote --env production
```

### 3. Production database is not seeded
After migrating: staff accounts, academic catalog, AI policy. Staff **must** go through the
bootstrap script (it derives PBKDF2 hashes at run time — never the committed
`seeds/0001_staff_accounts.sql`, which publishes the password it encodes). No `:production`
seed npm scripts exist yet, so catalog/ai-policy run directly.

```bash
node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --env production
npx wrangler d1 execute CareerLinkAI_Main --remote --env production --file=./seeds/0002_academic_catalog.sql
npx wrangler d1 execute CareerLinkAI_Main --remote --env production --file=./seeds/0003_ai_policy.sql
```

Bootstrap prints the temp password **once**; accounts land with `must_change_password = 1`
so first login forces rotation. To-do: add `db:seed:*:production` scripts to
`backend/package.json` mirroring the `:staging` ones.

### 4. Frontend has no production build target
`frontend/package.json` has only `deploy:staging`; there is **no `.env.production`** and
**no `build:production` / `deploy:production` script**. The prod frontend cannot be built or
deployed as-is. Needed:
- `frontend/.env.production` with `VITE_API_BASE_URL` pointing at the prod API origin
  (must match `[env.production].FRONTEND_URL = https://careerlinkai.online` — the only origin
  CORS admits, §41; no wildcard).
- `build:production` + `deploy:production` scripts (mirror the staging pair, target the prod
  Pages project).

---

## 🟡 Verify before promoting

### 5. Production Worker is running April code
Last deploy to `careerlinkai` was 2026-04-25 — all of Phases A–H are absent. Fixed by
`npm run deploy:production`, but only **after** blockers 1–2 (queues + migrations) are done.

### 6. Custom domain wiring
`careerlinkai.online` is attached to the `careerlinkai` Worker via the dashboard (not
declared in wrangler.toml). Confirm the prod frontend Pages project (`careerlinkai-frontend`,
last modified 3 months ago) serves the domain and matches `FRONTEND_URL`.

### 7. Vectorize `careerlinkai_main_knowledge` is empty
The index exists but has no vectors. RAG/AI-explanation grounding needs a separate knowledge
ingestion step if grounded explanations are required in prod.

---

## ✅ Already in place
- `[env.production]` bindings fully defined in `wrangler.toml`.
- Production D1 `CareerLinkAI_Main` (`a3d20b3b-…`) exists.
- Production R2 bucket `careerlinkai-docs` exists.
- Production Vectorize index `careerlinkai_main_knowledge` exists (empty — see #7).
- Production KV namespace (`2c31fc74…`) bound.
- Primary queues `careerlinkai-default-queue` + `careerlinkai-ai-queue` exist (DLQs do not — see #1).
- `AuthGuardDO` migration (`[[migrations]] tag = "v1"`, `new_sqlite_classes`) ships with the Worker.
- **No secrets required** — v1 reaches every Cloudflare service through a binding, not a credential.
- No `[limits]` block (Free plan requirement; PBKDF2 runs in AuthGuardDO's 30 s CPU budget, not the Worker's 10 ms — deviation D14).

---

## Recommended production cutover order
```
1. npx wrangler queues create careerlinkai-default-dlq
   npx wrangler queues create careerlinkai-ai-dlq
2. npm run db:migrate:production
3. node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --env production
   seed catalog (0002) + ai-policy (0003) on prod
4. add frontend .env.production + build/deploy:production scripts
5. npm run deploy:production            # backend Worker
6. build + deploy frontend to prod Pages
7. smoke-test https://careerlinkai.online/api/v1/health, then login + forced rotation
```

Steps 1 and 4 (create DLQs, add missing scripts) are safe prep that touch nothing live and
can be done ahead of time, leaving a clean one-command-per-tier cutover for when you decide.
