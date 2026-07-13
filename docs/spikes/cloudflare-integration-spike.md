# Cloudflare integration spike — Phase 2

**Status:** ✅ **CLOSED — superseded by the FULLPLAN v1.3 platform decision (13 Jul 2026), never run**
**Owner:** *(you)*
**Timebox:** 2–3 days (FULLPLAN §57)
**Mandated by:** FULLPLAN §57 (Phase 2), §61 (risk register), v1.2 revision note 9

> **Why this is closed without running.** The spike's decisive question — flagged below as "the
> one that decides it" — was whether **Laravel** could use D1 and Queues at all. FULLPLAN v1.3
> removes Laravel: the backend is now a TypeScript Cloudflare Worker (Hono + Zod + Drizzle), for
> which D1, Queues, Workers AI and Vectorize are **native bindings**, not services reached through
> missing PDO drivers. The question is resolved by construction, not by evidence, so the probes
> were never run. The two residual unknowns the spike would also have measured — Workers AI
> generation latency against the §6 8-second budget, and Vectorize upsert lag — are assigned to
> Phase 5a (FULLPLAN §57, v1.3). The verdict is recorded in the go/no-go section at the bottom.
> The rest of this document is kept as written, as the historical record of the risk and its shape.

---

## Why this exists

§61 registers the risk in plain words:

> *Laravel has no first-party driver for Cloudflare D1, Queues, or KV, and the
> "Cloudflare-fronted server/Worker gateway" hosting model is unproven for this stack.*

The dangerous part is not the risk itself — it is **when you would otherwise find out**.
Phases 0–4 run happily on local SQLite and never touch a single Cloudflare service. The
first thing that genuinely needs D1, Queues, Workers AI and Vectorize is Phase 5, in
roughly week 10. A no-go discovered there is a rewrite of the hosting model with the
thesis deadline in view.

So the spike is deliberately early, deliberately timeboxed, and deliberately **allowed to
fail**. "No-go" is a successful outcome: it means the fallback (a conventional PHP host
behind Cloudflare's edge, keeping R2/Vectorize/Workers AI over their REST APIs) is chosen
in week 4, on purpose, instead of in week 10, in a panic.

**Phase 5 is not permitted to depend on any of this until the go/no-go below is written.**
Local development is unaffected either way — the app runs on SQLite regardless.

---

## Setup

You need a Cloudflare account. The free tier covers every service the spike touches.

**1. A scoped API token** (*not* a global API key) at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens),
with these three permissions:

| Scope | Permission | Access |
|---|---|---|
| Account | D1 | Edit |
| Account | Workers AI | Read |
| Account | Vectorize | Edit |

**2. A D1 database and a Vectorize index.** With
[wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
installed:

```bash
wrangler d1 create careerlinkai-spike
# → prints a database_id

# The dimension count MUST match the embedding model, or every upsert is rejected.
# @cf/baai/bge-base-en-v1.5 emits 768.
wrangler vectorize create careerlinkai-knowledge --dimensions=768 --metric=cosine
```

**3. Fill in `backend/.env`** — the block at the bottom of `.env.example`:

```dotenv
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…
CLOUDFLARE_D1_DATABASE_ID=…
CLOUDFLARE_VECTORIZE_INDEX=careerlinkai-knowledge
CLOUDFLARE_VECTORIZE_DIMENSIONS=768
```

**4. Run it:**

```bash
cd backend
php artisan spike:cloudflare

# Or one probe at a time:
php artisan spike:cloudflare --probe=workers-ai
```

---

## The four probes

The command gathers evidence. It decides nothing — you do, below.

### 1. D1 — `--probe=d1`

Creates a table, inserts a row with a bound parameter, reads it back, drops the table. The
table it creates uses the two schema idioms §12 puts on **every** table in this project: a
UUID primary key and a `TEXT` column with a `CHECK` constraint standing in for an enum. If
D1's SQLite dialect rejects either, the whole schema is in question.

> **The trap this probe is designed to expose.** A green tick here means *PHP can reach D1
> over REST*. It does **not** mean Laravel can use D1. Eloquent, the schema builder and the
> query builder all sit on PDO, and there is no first-party PDO driver for D1 — it speaks
> HTTP, not the SQLite wire protocol. A "reachable" D1 therefore still leaves you choosing
> between a community driver, one you write yourself, and the §61 fallback. **This is the
> single most important question the spike answers.** Do not let a passing probe answer it
> for you.

### 2. Queues — `--probe=queue`

Nothing to call. It reports which queue drivers actually exist and what the app is
configured to use. §57 frames the choice as *community driver vs. database-queue fallback*
— and the database driver is the one Laravel ships with, needs no Cloudflare anything, and
is already configured.

Worth weighing honestly: Phases 4 and 5 dispatch **one job kind each**
(`GenerateRecommendationJob`, `GenerateExplanationJob`). That is a thin justification for
taking on an unmaintained community package.

### 3. Workers AI — `--probe=workers-ai`

One text-generation call, timed. §5 budgets **under 8 seconds** for a full AI explanation.
This one call is not that whole path — retrieval, prompt assembly and persistence sit
around it — but if a bare generation is already close to 8s, the budget itself is a
finding, and it belongs in the notes below.

### 4. Vectorize — `--probe=vectorize`

Embeds a sentence with Workers AI, upserts the vector, queries it back. That is the shape
of the entire Phase 5a retrieval path (§33) minus the chunking.

Two things that commonly go wrong, both of which the probe reports explicitly rather than
failing opaquely:

- **Dimension mismatch.** The index is created with a fixed dimension count. If the
  embedding model emits a different number, *every* upsert is rejected. 768 for
  `@cf/baai/bge-base-en-v1.5`.
- **Upsert lag.** Vectorize upserts are asynchronous. A query issued immediately can
  legitimately return zero matches. That is not a failed write.

---

## The go/no-go

**Fill this in and copy the verdict into `PROGRESS.md`. Phase 5 is blocked until you do.**

### Findings

| Probe | Result | What actually happened |
|---|---|---|
| D1 — reachable over REST | | |
| **D1 — usable from Eloquent** | | ← *the one that decides it* |
| Queues | | |
| Workers AI | | |
| Vectorize | | |

### Verdict

> **SUPERSEDED** — neither GO nor NO-GO. The premise (Laravel on Cloudflare) was retired by
> FULLPLAN v1.3 before the probes ran: the backend moves to a TypeScript Cloudflare Worker, where
> every service this spike existed to de-risk is a native binding. Copied to `PROGRESS.md` §2E.
>
> *Date:* 13 Jul 2026
> *Decided by:* project owner (v1.3 platform decision)

### If GO

The stack stands as specified in §11: D1 as the relational database, Cloudflare Queues for
background jobs, Workers AI and Vectorize for Phase 5.

Record here **how** Laravel talks to D1, because the answer is load-bearing for every phase
after this one:

- Driver used (community package + version, or hand-written):
- What it does not support (transactions? `SAVEPOINT`? migrations?):
- What the migrations already written in Phases 0–2 needed changing to, if anything:

### If NO-GO

The §61 fallback: **a conventional PHP host behind Cloudflare's edge**, keeping R2,
Vectorize and Workers AI over their REST APIs (all three are HTTP services and none of them
needs a Laravel driver — only D1 and Queues do).

Record here:

- Relational database instead of D1 (Postgres? MySQL? SQLite on a persistent volume?):
- Queue driver instead of Cloudflare Queues (the `database` driver is the obvious answer):
- Host:
- What changes in the code as a result — *the honest answer should be "almost nothing",
  and if it is not, say why:*

Note what this costs, plainly, for the thesis defence: v1 would no longer be
"Cloudflare-native" in the sense §11 claims. It would be **Cloudflare-fronted**, using
Cloudflare's AI and storage services over their APIs while the application itself runs on a
conventional host. That is a smaller claim, and a true one, and a panel will respect it
more than a stack diagram that was never actually run.

### Notes
