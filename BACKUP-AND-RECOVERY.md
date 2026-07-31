# Backup and Disaster Recovery — CareerLinkAI

**Written:** 2026-07-29 · Closes [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) **P3-5** · Related:
[`DEPLOYMENT.md`](DEPLOYMENT.md) §5 (rollback), [`PRODUCTION_REQUIREMENTS.md`](PRODUCTION_REQUIREMENTS.md)

Before this file there was **no documented backup procedure anywhere in the repository**. Every
other outstanding item on the plan degrades the product; this is the one whose failure mode is
permanent and total. `wrangler rollback` reverts the Worker script and does nothing whatsoever to
the database — `DEPLOYMENT.md` §5 already says so, and until now the sentence it ended on
("restore from a D1 point-in-time backup") pointed at a procedure that did not exist.

Everything below has been **run**, not reasoned. The measured numbers are from `CareerLinkAI_Staging`
on 2026-07-29: 45 tables, 3,314 rows, a 998 KB dump.

---

## 1. What is at risk

Five stores hold state. Only one of them is irreplaceable.

| Store | Holds | If it is lost | Protected by |
|---|---|---|---|
| **D1** `CareerLinkAI_Main` | Everything: users, PBKDF2 hashes, classes, rosters, the instruments, every attempt, every answer, every score, every recommendation, the audit log | **Unrecoverable by any other means.** A student's completed 60-item RIASEC cannot be reconstructed from anything else in the system | Time Travel (30 d) **+** verified exports (§3) |
| **R2** `careerlinkai-docs` | The uploaded source documents behind the knowledge base (`knowledge_documents.storage_path` points here) | The originals. D1 keeps the extracted text in `knowledge_chunks.content`, so the *product* still works — you lose the ability to re-extract from source | Nothing automated. Re-uploadable by an admin |
| **Vectorize** `careerlinkai_main_knowledge` | Embeddings of those chunks | Nothing permanent — rebuildable from `knowledge_chunks.content`, which is in D1 and therefore in every backup | D1, transitively |
| **KV** | Caching only, by design (`wrangler.toml`: nothing security-relevant reads or writes it since v1.5) | Nothing | Not needed |
| **Durable Objects** (`AuthGuardDO`) | Failed-login counters and join-code throttles, failures-only, windowed | Lockouts and throttle windows reset. That is the *designed* behaviour of an expired window | Not needed — and **note that no D1 mechanism covers DO storage**, so do not assume otherwise |

**So: back up D1. Everything else is either replaceable or already inside D1.**

---

## 2. Two recovery mechanisms, and which one to reach for

They are not alternatives. They cover disjoint disasters, which is why both exist.

### Time Travel — the first thing to try

D1 keeps a continuous restore log for **30 days**, on every plan including Free, with nothing to
configure. It restores **the same database in place**, so there is no window in which the data is
absent and no binding to repoint.

```bash
cd backend
npx wrangler d1 time-travel info CareerLinkAI_Main --env production            # current bookmark
npx wrangler d1 time-travel info CareerLinkAI_Main --env production --timestamp 2026-07-29T03:00:00Z
npx wrangler d1 time-travel restore CareerLinkAI_Main --env production --timestamp 2026-07-29T03:00:00Z
```

Reach for this for: a migration that went wrong, a `DELETE` that forgot its `WHERE`, an admin action
that removed more than intended, a bad seed. That is most of what actually happens.

**A restore is itself a point in time**, so an over-shot restore can be walked forward again —
capture the bookmark *before* you restore and you have not burned a bridge:

```bash
npx wrangler d1 time-travel info CareerLinkAI_Main --env production --json   # keep this bookmark
```

Every backup manifest this repo writes records the bookmark the export was taken at (§3), for
exactly this reason: a bookmark is unguessable after the fact and is the coordinate that lets you
ask D1 for a known-good state without a dump at all.

**What Time Travel does not cover** — and this is the whole reason §3 exists:

* the database being **deleted** (the log goes with it),
* the **account** being lost, suspended, or its billing lapsing,
* **day 31**,
* anything you want to read, diff, or load somewhere else.

### Exports — the copy that survives Cloudflare

A dump on disk, and then somewhere that is not Cloudflare. Slower, coarser, and the only thing that
covers the four cases above.

---

## 3. Taking a backup

```bash
cd backend
npm run db:backup:production      # or db:backup:staging, db:backup:local
```

Measured: **21 seconds** for staging.

### It does not trust the exit code, and that is the point

`wrangler d1 export` **exits 0 on an empty database.** Point it at a name that still resolves but is
no longer the database the Worker binds — a copy-pasted `--env`, a `database_id` swapped in
wrangler.toml, an environment renamed — and it writes a perfectly well-formed dump of nothing, exits
0, and does so again every night. You find out during the restore, which is the moment you have the
least of everything.

So `scripts/d1-backup.mjs` reads the **live** database's table list and `COUNT(*)` per table, then
parses the dump it just wrote and asserts they agree:

```
  ok   the dump is not empty — 998.0 KB
  ok   every source table has a CREATE TABLE in the dump — 45 tables
  ok   every table holds the number of rows the database held when the snapshot was taken — 3,314 rows
  ok   the load-bearing tables are populated (this is not a backup of an empty database) — users, careers, colleges, programs
  ok   every migration in the dump exists in this checkout — 19 applied
```

A dump that fails any of these is renamed `.sql.REJECTED` and **no manifest is written**, so
`d1-restore.mjs` cannot reach it. The previous good backup stays the previous good backup.

Row counts are checked as a **range**, bracketed by a read before and a read after the export: a
production database takes writes while it is being backed up, the snapshot legitimately falls
between the two observations, and a strict equality check would fail correct backups — which is how
a check gets deleted rather than fixed. Outside the bracket still fails.

The predicates are a pure function in `scripts/lib/d1-dump.mjs` and are **driven red on every push**
by `test/platform/backup-verification.test.ts` (19 tests) — including the schema-perfect dump of an
empty database, a dump one row short, and a dump carrying a migration this checkout has never seen.

### What you get

```
backend/.backups/CareerLinkAI_Main-production-2026-07-29T03-00-11Z.sql
backend/.backups/CareerLinkAI_Main-production-2026-07-29T03-00-11Z.manifest.json
```

The manifest carries the SHA-256, per-table row counts, the applied migration list, the wrangler
version, and the Time Travel bookmark at export time. `d1-restore.mjs` checks the dump against it
before touching anything.

### The dump is reordered, and it has to be — twice

**A stock `wrangler d1 export` dump cannot be restored by `wrangler d1 execute --file`. Not
locally, not remotely, not at all.** That is the single most important sentence in this document,
it is not what you would guess while holding a 1 MB file that opens with `CREATE TABLE`, and it was
established by pushing one at a real D1 database and reading the error. Two separate ordering
defects, each of which stops the load dead:

**1. Tables are created after they are referenced.** The exporter emits each table's `CREATE`
followed immediately by its rows. In this schema `student_profiles` is created at line 133 with an
inline `REFERENCES shs_strands (id)` and populated from line 152, while `CREATE TABLE shs_strands`
does not appear until line **3841**. The leading `PRAGMA defer_foreign_keys=TRUE` would make that
legal for a reader that ran the whole file in one transaction; neither importer does.
→ `no such table: main.shs_strands`.

**2. Rows are inserted before the rows they reference.** Even with the schema loaded first, the
data is written in table-creation order, which is also not dependency order: every `programs` row
carries a `program_catalog_id`, and `program_catalog` is written thirty tables later.
→ `FOREIGN KEY constraint failed`, on the **remote** importer only. The local one is more forgiving
here, so this defect is invisible to any amount of local rehearsal — it appears for the first time
on the path a real recovery actually takes.

`d1-backup.mjs` therefore takes the export in two halves (`--no-data`, then `--no-schema`), and
writes schema first with the rows regrouped so every parent precedes its children. The insert order
is `dropOrder` reversed — one dependency graph, read in both directions, so the wipe in §5c and the
load here can never disagree about the schema. Both halves are still produced verbatim by
Cloudflare's exporter; only the order of the blocks is this repo's doing, and `verifyBackup` counts
the rows afterwards precisely because the file was rewritten.

The result loads into a remote D1 (proven, §6), into a local database, and into anything else you
need it in on a bad day.

---

## 4. Retention, schedule, and where dumps live

| | |
|---|---|
| **Cadence** | Daily for production, before and after every migration, and before any bulk data operation |
| **Kept locally** | 30 days, floor of 7 (`--keep-days` / `--keep-min`) — the age rule can never remove the last week's copies |
| **Local path** | `backend/.backups/`, **gitignored** |
| **Offsite** | Required — see below |
| **Never** | In git. A dump is every user row and every PBKDF2 hash; a git history is cloned onto every machine that ever touches this project |

### The offsite copy is the part a human still has to own

`.backups/` on the machine that runs the backup covers a bad migration. It does not cover the
laptop. Copy each verified pair — the `.sql` **and** its `.manifest.json`, which is what makes the
dump checkable — to storage under a different failure domain and a different account than the one
holding the database.

### Scheduling it — done, 2026-07-31 (plan P3-8)

**This gap is closed.** Until production went live on 2026-07-30 the taking and verifying were
automated and the *running* was not, so the only backup in existence was whichever one somebody
last remembered to take. `.github/workflows/backup.yml` now runs it nightly.

The Worker's own `[triggers] crons = ["0 3 * * *"]` cannot do this — a Worker has no filesystem and
cannot run `wrangler` — so the job lives in GitHub Actions, where the repo already is.

| | |
|---|---|
| **When** | `37 17 * * *` UTC — 01:37 Manila. Off-peak, and offset from the Worker's 03:00 UTC housekeeping so the two never contend. The odd minute avoids GitHub's top-of-hour scheduling queue. |
| **Where the dump goes** | A GitHub artifact, retained **90 days**. |
| **Also** | `workflow_dispatch`, so a backup can be taken before a migration or a cutover without waiting for the schedule. |

**The offsite copy is now genuinely offsite, and the provider is the point.** A backup of a
Cloudflare database stored in R2 shares a blast radius with the thing it insures — and R2 would be
reachable by the very API token the job already holds. GitHub is a different vendor with different
credentials, which is what makes it cover "the account was lost". 90 days is deliberately longer
than Time Travel's 30: inside that window Time Travel is the better tool (in place, with no interval
during which the data is absent), so these files exist for after it closes.

The token is **D1:Read and Account:Read only**. The job never writes to D1, and an unattended
nightly holding a write-capable production credential is a standing risk for no benefit.

**Failures are loud, and retried three times first.** `wrangler d1 export` is an asynchronous
create-poll-download job against the Cloudflare API: while this workflow was being written, the
identical command failed once, hung once, then succeeded twice against an unchanged database. A
transient export error says nothing about the data, and a nightly job that pages on one is a job
whose red ticks stop being read. Three spaced attempts absorb that; a genuine verification failure —
a dump missing a table or missing rows, which is the whole reason `d1-backup.mjs` does not trust an
exit code — fails all three and goes red having taken about two minutes to say so. The `.REJECTED`
dump is uploaded too, because it is the most diagnostic thing the run can produce.

A missing `CLOUDFLARE_API_TOKEN` fails the job on its **first** run, by design: a scheduled backup
that quietly skips itself when unconfigured is precisely the failure this file exists to prevent.

---

## 5. Restoring

### 5a. Something went wrong inside 30 days → Time Travel

§2. In place, no dump, no downtime window. **Try this first, always.**

### 5b. The database is gone, or the dump is older than 30 days

D1 cannot import into a database that already has the tables, so the procedure is: restore into a
**new** database, verify it, then repoint the binding.

```bash
cd backend

# 1. Restore into a fresh database. --create makes it; the script refuses a non-empty target
#    without --wipe, because this dump's CREATE TABLEs would fail partway and leave the target
#    neither the old state nor the new one.
node scripts/d1-restore.mjs \
  --from .backups/CareerLinkAI_Main-production-2026-07-29T03-00-11Z.sql \
  --into CareerLinkAI_Recovered --env production --create

# 2. Point production at it: replace database_id in [[env.production.d1_databases]].
npx wrangler d1 info CareerLinkAI_Recovered          # copy the uuid into wrangler.toml

# 3. Ship it. The migration ledger came across in the dump, so nothing re-applies.
npm run deploy:production
curl -s https://careerlinkai.online/api/v1/health    # expect {"environment":"production"}

# 4. Prove it serves, do not assume it: sign in as a student who had recommendations
#    and confirm the list is theirs. This is step 10 of the cutover runbook, and it is the
#    only step that distinguishes a restored database from a running one.
```

The restore verifies itself — every table present, every row count matching the manifest, the
migration ledger intact — and exits non-zero if any of that fails. `wrangler d1 execute` reports the
statements it ran, not the rows that survived them.

### 5c. Restoring over a database that still exists

```bash
node scripts/d1-restore.mjs --from <dump>.sql --into CareerLinkAI_Staging --env staging --wipe
```

`--wipe` drops the target's tables first, **children before the tables they reference**. Not
alphabetically: `DROP TABLE` runs an implicit `DELETE FROM`, and deleting from a child makes SQLite
consult its parent for the foreign key check — so dropping `assessment_dimensions` before
`question_dimensions` fails the second drop with `no such table: main.assessment_dimensions`, an
error naming a table you deliberately removed a moment ago.

There is a window here in which the target holds nothing. Prefer 5a or 5b.

### The guards, and why each exists

Every one of these has been fired deliberately and observed to exit 1.

| Guard | Fires when | Why |
|---|---|---|
| SHA-256 vs. manifest | The dump is not the file its manifest describes | A truncated download restored over a live database turns a recoverable incident into an unrecoverable one |
| `--into` required | Always — the target is never inferred | A restore target guessed from an environment flag is how the right dump lands in the wrong database |
| `--i-know-this-is-production` | The target is `[env.production]`'s database | Read from wrangler.toml, **not** matched on the word "production": this project's production database is `CareerLinkAI_Main`, which is also the local database's name |
| `--wipe` required | The target has any tables | The dump's `CREATE TABLE`s are unconditional and would fail partway |
| Typed confirmation | Anything destructive, unless `--yes` | The string it asks for is the one thing someone restoring the wrong database would get wrong |
| Post-restore verification | Row counts or tables do not match the manifest | An import that loaded two thirds of the rows and exited 0 is exactly what a restore must not call success |

---

## 6. The drill

> A restore procedure that has never been executed is a guess. The guesses in this repository have
> not held up: P1-2's CSP was reasoned and blocked the app's typeface on every screen in production;
> P2-2's recommendation engine passed 807 tests and generated nothing for anybody on real D1.

```bash
cd backend
npm run db:restore:drill          # backs up staging, then drills that backup
```

It restores the dump into a **throwaway** local database in a temp directory — not the local dev
database, because a drill that costs a developer their working data is a drill they run once — picks
a student who had recommendations *in the backup* (from the data, not hardcoded), boots the **real
Worker** against the restored database, joins the class over HTTP through `/student-access/join`, and
asserts `GET /student/recommendations` returns the careers the backup holds, in the same order, with
the same scores, plus programmes with their colleges attached.

That last part is the point, and it is a stronger claim than "the rows came back". Recommendation
rows hang off `assessment_results`, `careers`, `programs`, `program_catalog` and `colleges`. A
restore that lost one link produces a database whose `recommendations` count is perfect and whose API
returns an empty list. Only reading it back through the application tells those apart.

**Run it:** after any change to the schema, the backup scripts, or the wrangler version — and
quarterly regardless. A restore path decays silently, the way `walkthrough.mjs` did (three releases
stale and unable to run at all, found by P2-2).

**Result, 2026-07-29:** PASS, 15 checks, **83 seconds end to end** including taking the backup.
Staging backed up and restored; `jose.pena.edited` served their ten careers — Journalist 97.0,
Marketing Manager 97.0, Teacher 97.0 — identical to the backup, in the same order, with
AB Communication @ UP Diliman at the top of the programmes.

### The remote leg, run separately — and it earned its keep

The drill above restores into a *local* database. On 2026-07-29 the same dump was also pushed at a
**real, remote D1** — `CareerLinkAI_Drill`, created for the purpose and deleted afterwards — which
is the path §5b takes and the only one a genuine recovery uses.

**It failed the first time**, on ordering defect 2 in §3, which the local restore had passed
cleanly. That defect is the reason this paragraph exists: a backup rehearsed only against Miniflare
would have been declared restorable, filed, and found wanting on the day it mattered. It is the same
lesson as plan item P2-2, where 807 green tests and a D1 parameter limit produced a recommendation
engine that generated nothing for anybody.

After the fix: **45 tables, 3,314 rows, verified against the manifest on a live remote database.**
The scratch database was then deleted; the account is back to its two.

**Still not exercised:** `wrangler d1 time-travel restore` (§5a). It mutates a live database in
place, so it is left for a deliberate decision rather than run in passing. Recorded here as unrun,
not implied to be covered.

---

## 7. RPO and RTO

Measured, not estimated.

| | Time Travel | Verified export |
|---|---|---|
| **RPO** (data you can lose) | Effectively zero, up to 30 days back | Up to one backup interval — **24 h** on the daily schedule above |
| **RTO** (time to serving again) | Minutes: one command, in place, no redeploy | **~5 minutes** of mechanical work: 49 s to load a 998 KB dump into an empty database, plus a `deploy:production` to repoint the binding |
| **Covers** | Bad migration, bad delete, bad seed | Database deleted, account lost, day 31, or you need the data somewhere else |
| **Does not cover** | Database or account gone | Anything written since the last backup |

**Tighten the RPO by running a backup before every migration and every bulk operation.** Those are
the moments the 24-hour window is worth the least.

---

## 8. What this deliberately does not cover

Stated rather than implied, because an unstated gap reads as a covered one.

* **R2** (`careerlinkai-docs`) has no automated backup. The uploaded PDFs are the only copy of the
  source documents; the extracted text is in D1 and travels with every backup, so the knowledge base
  survives — the originals do not. An admin can re-upload.
* **Vectorize** is not backed up and does not need to be: it is derivable from `knowledge_chunks`.
  After a full rebuild it must be re-ingested, or grounded explanations degrade to the deterministic
  §27 reason (the §29 posture — correct behaviour, visibly less good).
* **Durable Object storage** is not covered by Time Travel, by exports, or by anything here. It holds
  failure counters and throttle windows that are designed to expire.
* **The offsite copy** is a human step today (§4).
* **Backup encryption at rest** is whatever the offsite store provides. The dump contains PBKDF2
  hashes, not plaintext passwords — but it also contains every student's name and every answer they
  gave, so treat it as the personal data it is.

---

## 9. What building this found

Four D1 facts, none of them visible from the local test suite, all found by running the thing. They
belong to the same class as the D1 100-bound-parameter ceiling that plan item P2-2 found generating
recommendations for nobody, and they are recorded here for the same reason.

1. **A stock `wrangler d1 export` dump cannot be restored by `wrangler d1 execute --file` at all**
   (§3) — two independent ordering defects, tables created after they are referenced and rows
   inserted before the rows they reference. The second one fails **only on the remote importer**,
   so it survives any amount of local rehearsal.
2. **D1 caps compound `SELECT`s at five terms.** A 45-table `SELECT … UNION ALL SELECT …` row-count
   sweep fails with `too many terms in compound SELECT [code: 7500]`; six terms is already too many.
   Stock SQLite's default is 500, so the `UNION ALL` version of that query worked on every local
   database and failed on the first real one. Scalar subqueries have no such ceiling.
3. **`sqlite_master` on a deployed D1 lists an internal `_cf_KV` table** that the export deliberately
   omits and that **every** query against fails with `not authorized: SQLITE_AUTH`. Miniflare creates
   no such table — so a verification comparing `sqlite_master` to the dump would have reported a
   missing table on every real run and passed every local one.
4. **`wrangler d1 export --local --persist-to` crashes** with a libuv assertion
   (`!(handle->flags & UV_HANDLE_CLOSING)`, exit `0xC0000409`) before writing anything, while
   `wrangler d1 execute --local --persist-to` accepts the same flag. `db:backup:local` therefore
   always reads the default `.wrangler/state` database.

---

## 10. Files

| Path | What |
|---|---|
| `backend/scripts/d1-backup.mjs` | Export, verify against the live database, write the manifest, prune |
| `backend/scripts/d1-restore.mjs` | Restore with the §5 guards, then verify what landed |
| `backend/scripts/restore-drill.mjs` | The §6 rehearsal, end to end through the real Worker |
| `backend/scripts/lib/d1-dump.mjs` | The pure predicates — no I/O, so the platform suite can fail them on purpose |
| `backend/scripts/lib/d1.mjs` | Wrangler invocation, config parsing, live queries |
| `backend/test/platform/backup-verification.test.ts` | 19 tests firing those predicates red |
