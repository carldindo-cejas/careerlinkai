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
>    with it gives every student the entire career catalog, reordered. See audit finding C1.
>    *(Superseded 2026-09-05: the fix was seed 0004, and the live catalog is now
>    `seeds/0005_region7_catalog_reset.sql`. Superseded again 2026-09-09: that catalog is now
>    **Bohol only**, generated from `colleges.md`, and seeds 0002 and 0004 have been **deleted** —
>    either one would have put Manila and Cebu institutions back alongside it. See §3a.)*
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

The catalog seed is **0005**, and as of 2026-09-09 it is the **only** catalog seed —
**`seeds/0005_region7_catalog_reset.sql`**, the 22 Bohol campuses of `colleges.md`: 41 canonical
programmes, 126 offerings, 86 careers, 549 mappings. It is generated; edit
`backend/scripts/build-region7-seed.mjs` and re-run `npm run seed:region7`, never the `.sql`.

`0002` (the 10-career Manila demo fixture behind audit C1) and `0004` (the nationwide catalog that
fixed C1, 20 institutions from Diliman to Iligan) were **deleted**, not demoted. Being local-only
was enough while the catalog was national; it stopped being enough once the catalog became one
province. Neither file collides with 0005 by name, so `INSERT OR IGNORE` collides on nothing and
running either one *after* 0005 adds a second catalog rather than replacing the first — a student
in Tagbilaran gets offered a programme in Manila. `test/platform/seed-chain.test.ts` fails if
either file reappears or if any seed runner points somewhere other than 0005. Git history has them
if the catalog is ever widened again.

0005 is idempotent, so re-running it is safe. It is also a **reset**: it deletes every college,
programme, career and mapping before inserting, which cascades to every student's stored
recommendations. On a first cutover there are none. On a re-seed of a live database, see
[the re-seed note](#re-seeding-a-live-catalog) below.

```bash
node scripts/bootstrap-staff.mjs --database CareerLinkAI_Main --env production
npm run db:seed:catalog:region7:production  # seeds/0005 — 22 Bohol campuses, 41 programmes, 86 careers
npm run db:seed:ai-policy:production        # seeds/0003
```

**Then sync the AI knowledge base.** The assistant does not read the catalog tables; it reads a
corpus derived from them, and SQL cannot update that. Press **Sync catalog** on
`/admin/knowledge` (or `POST /api/v1/admin/knowledge-catalog-sync`) after seeding. One press is
now enough — the run does a batch inline and queues the rest, which finishes on its own.

Skipping it fails quietly and looks like an AI problem. Measured on production on 2026-09-05,
after the seed and before any sync: **Explain more** cited *"BS Chemical Engineering at De La
Salle University"* and *"at Mapúa University"*, both already deleted, and the chat assistant said
*"I don't have that information"* when asked where to study Chemical Engineering in Cebu — while
USC, USJ-R and CIT-U all offer it.

<a id="re-seeding-a-live-catalog"></a>
**Re-seeding a live catalog.** Because 0005 replaces the catalog rather than adding to it, every
`recommendations` row is deleted — each one targets a career or programme that is about to stop
existing, and the foreign keys are `ON DELETE CASCADE`. Nothing a student authored is affected:
assessment attempts, results, answers and chat conversations are untouched, and §27 recomputes a
ranking from the stored result on demand. A student who opens the recommendations page after a
re-seed sees the empty state with its **Regenerate** action (audit C4), not an error. Tell students
before re-seeding a live term, or regenerate on their behalf from the counselor screen.

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

### 5. ~~Production Worker is running April code~~ — RESOLVED 2026-07-30 (P3-1)
`careerlinkai.online` now serves `careerlinkai-production`, deployed from the current commit.
The legacy `careerlinkai` script (last deployed 2026-04-25, Phases A–H absent) is still in the
account but **no domain routes to it**; it is kept as a rollback target.

### 6. ~~Custom domain wiring~~ — RESOLVED 2026-07-30 (P3-1). This was the cutover's real defect.
`careerlinkai.online` and `www` are attached to **`careerlinkai-production`** and the attachment is
now **declared in `wrangler.toml`** (`[[env.production.routes]]`, `custom_domain = true`) instead of
being dashboard-only.

The claim this section used to make — that the domain was attached to the `careerlinkai` Worker and
that `--env production` published to it — was **false, and false in a way no test could see**.
Wrangler derives the script name as `<name>-<env>`, so `npm run deploy:production` publishes
`careerlinkai-production`. The runbook's step 8 health check is what caught it: the first
`--env production` deploy in the project's history created a *third* Worker that no domain pointed
at, while the live domain went on serving the April build. Full account in
[`DEPLOYMENT.md`](DEPLOYMENT.md) §4 "Attaching the domain".

The Pages projects named in earlier revisions of this section (`careerlinkai-frontend`) are gone from
the architecture — there is no frontend artifact separate from the Worker. See blocker 4.

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
5. npm run db:seed:catalog:region7:production      # seeds/0005 — the only catalog seed there is
6. npm run db:seed:ai-policy:production
7. npm run deploy:production                       # publishes SPA + API in one versioned deploy
8. curl https://careerlinkai.online/api/v1/health  # expect {"environment":"production"}
9. Sign in as admin → forced password rotation → /admin/assessment-templates →
   "Install RIASEC & SCCT"                         # without this there are no assessments at all
10. /admin/knowledge → "Sync catalog"              # the AI reads a corpus derived from the
                                                   # catalog, not the catalog. Skip it and the
                                                   # assistant describes the catalog you replaced.
11. End-to-end smoke: create a class, join as a student, complete RIASEC + SCCT,
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

* ✅ **Done in the 2026-07-30 cutover.** `npm run db:backup:production` was run immediately after
  step 6, before the first deploy — the first backup of a system is the one it is easiest to
  postpone, and steps 4–6 are exactly the state that is expensive to recreate by hand.
* ✅ **Done 2026-07-31** (plan P3-8). `.github/workflows/backup.yml` runs the verified backup nightly
  at 17:37 UTC and keeps the dump as a GitHub artifact for 90 days. It needs one repository secret,
  `CLOUDFLARE_API_TOKEN` (**D1:Edit + Account Settings:Read**), and fails loudly on its first run
  until that exists — a scheduled backup that skips itself when unconfigured is the failure it
  exists to prevent. Until this landed the RPO was "everything since the last time someone
  remembered".
  Also needs `CLOUDFLARE_ACCOUNT_ID`, set to the id from `wrangler whoami` — **a wrong value is
  worse than an absent one**, since an unset secret lets a single-account token resolve its own.
  This said D1:Read until 2026-07-31, as did `BACKUP-AND-RECOVERY.md` §4 and the workflow header.
  The first four runs failed on **two stacked faults** — a wrong account id (`code: 7003`, a
  routing failure that never reached a permission check) masking a rejected token (`code: 10000`).
  See [`BACKUP-AND-RECOVERY.md`](BACKUP-AND-RECOVERY.md) §4; the order in which they surfaced is
  the part worth reading.

Time Travel covers the first 30 days in place with nothing to configure, which is most of what
actually goes wrong; the exports cover the database being deleted and the account being lost, which
it cannot.
