# Production Readiness Requirements

**Audited:** 2026-07-25 · **Revised:** 2026-07-28 (full-stack audit — see [`AUDIT-2026-07-28.md`](AUDIT-2026-07-28.md)) · **Current live prod code:** `careerlinkai` Worker last deployed 2026-04-25 (Initial Commit era — Phases A–H absent).

> **2026-07-28 corrections.** Three things in the 07-25 version of this file were wrong or missing
> and would have produced a broken production database if followed literally:
>
> 1. **The migration count was stale** — it said "all 13 migrations (0001–0013)". There are **19**
>    (`0001`–`0019`). `wrangler d1 migrations apply` applies whatever is pending, so the command was
>    always right; the prose would have led someone to stop verifying six migrations early.
> 2. **The catalog seed named here was the demo fixture.** `seeds/0002_academic_catalog.sql` holds
>    5 colleges, 10 careers and 16 programs, and §27 keeps a top **ten** — so seeding production
>    with it gives every student the entire career catalog, reordered. Production must be seeded
>    with **`seeds/0004_academic_catalog_expansion.sql`** (20 HEIs, 68 careers, 48 canonical
>    programs, 309 offerings, 933 mappings). See audit finding C1.
> 3. **Installing RIASEC and SCCT was not listed at all.** A freshly migrated database has **no
>    assessments**. The instruments arrive only via
>    `POST /api/v1/admin/assessment-templates/seed-instruments`, which now has an
>    "Install RIASEC & SCCT" button on the admin Assessments page (audit finding F1). Without this
>    step the deployment is live, signed-in-able, and unable to assess anybody.
>
> The `db:seed:*:production` scripts that this file listed as a to-do now exist in
> `backend/package.json`.

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
All **19** migrations (0001–0019) are pending on `CareerLinkAI_Main`. The database has no tables.

```bash
npm run db:migrate:production   # wrangler d1 migrations apply CareerLinkAI_Main --remote --env production
```

Verify afterwards that 19 applied — not 13, which is what the previous revision of this file said:

```bash
npx wrangler d1 migrations list CareerLinkAI_Main --remote --env production   # expect: no pending
```

### 3. Production database is not seeded
After migrating: staff accounts, academic catalog, AI policy.

Staff **must** go through the bootstrap script (it derives PBKDF2 hashes at run time — never the
committed `seeds/0001_staff_accounts.sql`, which publishes the password it encodes).

The catalog seed is **0004, not 0002**. `0002` is the 10-career demo fixture; because §27 keeps a
top ten, seeding production with it hands every student the whole catalog in a different order and
the recommendation engine appears to do nothing (audit C1). `0004` is the real catalog and is
idempotent, so re-running it is safe.

```bash
node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --env production
npm run db:seed:catalog:full:production    # seeds/0004 — 20 HEIs, 68 careers, 48 programs
npm run db:seed:ai-policy:production       # seeds/0003
```

Bootstrap prints the temp password **once**; accounts land with `must_change_password = 1` so first
login forces rotation.

### 3b. RIASEC and SCCT are not installed by any seed
The two curated instruments are created through the real `AssessmentBuilderService` (§57 requires
them to pass the same confirmation gate a counselor does), so no `.sql` file can install them — a
D1 binding exists only inside the Worker. **A migrated, seeded production still has zero
assessments until this runs**, and every student's assessment list is empty.

Sign in as the administrator after deploying and press **Install RIASEC & SCCT** on
`/admin/assessment-templates`. It is idempotent. (Equivalent to
`POST /api/v1/admin/assessment-templates/seed-instruments` with an admin bearer token.)

### 4. ~~Frontend has no production build target~~ — RESOLVED by the single-Worker consolidation
The blocker was real and is now structurally gone rather than filled in: there is no
per-environment frontend build to be missing, because there is no per-environment frontend
*artifact*. The React app is served by the same Worker that serves the API, calls the relative
path `/api/v1`, and is therefore same-origin everywhere — so one `vite build` output is correct
for local, staging and production alike.

`backend/wrangler.toml`'s `[build]` hook runs that build, which makes `npm run deploy:production`
(i.e. `wrangler deploy --env production`) publish **both** halves in one versioned deployment.
`frontend/.env`, `.env.staging` and the `build:staging` / `deploy:staging` Pages scripts were
deleted; nothing replaced them.

Follow-up, not a blocker: delete the now-unused `careerlinkai-staging` **Pages** project once
production is verified. See [`DEPLOYMENT.md`](DEPLOYMENT.md) §6.

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

Corrected 2026-07-28. Steps 4 and 7 are new; step 6 previously named the wrong seed, and the old
steps 4/6 ("add frontend .env.production", "deploy frontend to prod Pages") are gone — the
single-Worker consolidation removed the separate frontend artifact entirely.

```
1. npx wrangler queues create careerlinkai-default-dlq
   npx wrangler queues create careerlinkai-ai-dlq
2. npm run db:migrate:production                   # 19 migrations, not 13
3. npx wrangler d1 migrations list CareerLinkAI_Main --remote --env production   # expect none pending
4. node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --env production
                                                   # prints the temp password ONCE — capture it
5. npm run db:seed:catalog:full:production         # seeds/0004 (NOT 0002 — see blocker 3)
6. npm run db:seed:ai-policy:production
7. npm run deploy:production                       # publishes SPA + API in one versioned deploy
8. curl https://careerlinkai.online/api/v1/health  # expect {"environment":"production"}
9. Sign in as admin → forced password rotation → /admin/assessment-templates →
   "Install RIASEC & SCCT"                         # without this there are no assessments at all
10. End-to-end smoke: create a class, join as a student, complete RIASEC + SCCT,
    confirm recommendations appear and differ from another student's profile
```

Steps 1–3 are safe prep that touch nothing live and can be done ahead of time, leaving a clean
cutover for when you decide. Step 10 is the one that actually proves the deployment: steps 8 and 9
can both pass on a system that still recommends the same ten careers to everybody.

**Rollback.** Workers keeps every deployment as a version.
`npx wrangler deployments list --env production` then
`npx wrangler rollback [version-id] --env production` reverts the script. Note this reverts *code
only* — an applied D1 migration is not undone by a rollback, so a deploy that ships a destructive
migration is not recoverable this way. None of 0001–0019 drop data.

**Backups.** The database side of that gap is closed by
[`BACKUP-AND-RECOVERY.md`](BACKUP-AND-RECOVERY.md) (plan P3-5). Two things to fold into the cutover
above rather than leave for later:

* Run `npm run db:backup:production` **immediately after step 6**, before the first deploy — the
  first backup of a system is the one it is easiest to postpone, and steps 4–6 are exactly the state
  that is expensive to recreate by hand.
* Put the daily job on a schedule the same day. Until it exists the RPO is "everything since the
  last time someone remembered".

Time Travel covers the first 30 days in place with nothing to configure, which is most of what
actually goes wrong; the exports cover the database being deleted and the account being lost, which
it cannot.
