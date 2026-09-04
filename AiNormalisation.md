# AiNormalisation — Grounding the AI on admin-authored knowledge

**Date:** 2026-09-04
**Scope:** the whole AI surface — `backend/src/modules/ai/*`, the §30 explanation pipeline, the
recommendation chat assistant, the §33 knowledge-ingestion pipeline, and the admin knowledge screen.
**Trigger:** two reported symptoms — the recommendation chat gives vague, occasionally invented
answers, and **Explain more** on the recommendations page produces nothing usable.
**Goal:** every answer a student reads is either arithmetic this system computed, text an admin
wrote, or a cited paraphrase of retrieved text. Nothing else ships.
**Status:** **Phases 0–4 deployed 2026-09-04. Migration 0027 (porter stemming) applied the same
day, closing the last measured retrieval defect.** Phase checkboxes below are the tracker.

The diagnosis body is written evidence-first, in the style of `ASSESSMENT-FIX.md`: each finding
carries the file and line that establishes it, so anyone can re-verify without redoing the search.

---

## 0. The finding that reframes the work

**There is nothing to integrate.** Cloudflare's free AI stack is already fully wired into this
project and has been since Phase 5a:

| Capability | Binding / service | Where |
| --- | --- | --- |
| Text generation | `AI` → `@cf/meta/llama-3.1-8b-instruct-fp8` | `wrangler.toml [ai]`, `ai-gateway-service.ts` |
| Embeddings | `AI` → `@cf/baai/bge-base-en-v1.5` | `ai-gateway-service.ts:337` (`embed`) |
| Vector search | `VECTORIZE` → `careerlinkai_main_knowledge` | `vector-store.ts`, `retrieval-service.ts` |
| Corpus storage | `STORAGE` (R2) + `knowledge_documents` / `knowledge_chunks` (D1) | `knowledge-ingestion-service.ts` |
| Async ingestion | `QUEUE_AI` + DLQ | `src/jobs/ai-jobs.ts` |
| Call audit | `ai_requests` lifecycle rows | `ai-gateway-service.ts` |
| Admin surface | knowledge upload + AI policy | `ai/routes.ts`, `KnowledgeListPage.tsx` |

The RAG pipeline is roughly 90% built and its posture is correct — `ExplanationService` already
refuses to generate ungrounded, `ChatService` already falls back to deterministic match data, every
call already writes a provenance row naming the chunk ids it saw.

**The pipeline produces nothing because retrieval returns nothing.** That is the whole problem, and
it is caused by defects that nothing currently logs.

---

## 1. Defects

Ordered by severity. D1 and D2 are silent and each is independently sufficient to make retrieval
return zero results.

### D1 — Chunks are 56% larger than the embedding model can read

**Severity: CRITICAL. Silent. Affects every chunk in the corpus.**

`backend/src/lib/chunker.ts:19`

```ts
export const MAX_CHUNK_TOKENS = 800;
```

`@cf/baai/bge-base-en-v1.5` accepts a **512-token maximum input** (Cloudflare model docs,
verified 2026-09-04). Everything past roughly 2,048 characters of each chunk is truncated by the
model before embedding.

The consequence is subtle and worth stating precisely: the chunk *text* stored in
`knowledge_chunks.content` is complete, so a student would see the whole passage if it were ever
retrieved — but the vector standing in for that chunk in Vectorize only encodes its first two
thirds. A fact in the tail of a chunk is unreachable by search. There is no error and no log line;
`embed()` at `ai-gateway-service.ts:337` receives a well-formed response and returns it.

### D2 — The similarity floor sits above where this model scores

**Severity: CRITICAL.**

`backend/src/modules/ai/retrieval-service.ts:26`

```ts
export const RETRIEVAL_SIMILARITY_THRESHOLD = 0.75;
```

BGE-base cosine similarity for a genuinely relevant short-query / long-passage pair typically lands
in **0.55–0.72**. A 0.75 floor rejects correct matches as a matter of routine — and D1 depresses
every score further, because the vectors being compared represent only part of their chunks.

**This is why `NO_GROUNDING` is the normal outcome.** `explanation-service.ts:124–135` refuses to
generate when `retrieved.length === 0`, which is correct behaviour on an empty result set; the
defect is upstream, in why the result set is empty.

### D3 — Queries are embedded as if they were passages

**Severity: HIGH.**

`backend/src/modules/ai/retrieval-service.ts:41`

```ts
const [embedding] = await this.gateway.embed([query]);
```

This is the same `embed()` used for document chunks. BGE v1.5 is an asymmetric retriever: short
queries are meant to carry the instruction prefix `Represent this sentence for searching relevant
passages: ` while passages stay bare. Without it, query and passage vectors sit in slightly
different regions of the space and every score is a few points lower than it should be — on top of
D2's floor.

### D4 — The explanation query is a sentence nothing in the corpus resembles

**Severity: HIGH.**

`backend/src/modules/ai/explanation-service.ts:86–91` builds the retrieval query as:

```
"Nursing at Saint Louis College college program for a student whose strongest interests are Social, Investigative"
```

No guidance document contains that phrasing. The target's own `careers.description` /
`programs.description` — already in the database — would match the corpus far better, because it is
written in the same register as the material being searched.

### D5 — Admins can only add knowledge by uploading a file

**Severity: HIGH. This is the bottleneck the entire problem sits behind.**

`backend/src/modules/ai/routes.ts:71–74`

```ts
const extension = file.name.toLowerCase().split('.').pop();
if (extension !== 'pdf' && extension !== 'docx') { … }
```

`backend/src/db/schema.ts:1136`

```ts
fileType: text('file_type').$type<'pdf' | 'docx'>().notNull(),
```

There is no way to paste a paragraph, no way to answer one specific question, and no way to edit
anything after upload — the only correction available is archive-and-re-upload. Every other fix in
this document multiplies a corpus that currently does not grow.

### D6 — Retrieval cannot be scoped to what it is retrieving for

**Severity: MEDIUM.**

`backend/src/modules/ai/knowledge-ingestion-service.ts:262`

```ts
metadata: { document_id: documentId },
```

That is the only metadata on a vector. When explaining one specific program, retrieval cannot prefer
chunks *about that program*; it competes against the whole corpus on raw similarity alone.
`retrieval-service.ts:47` passes no `filter` because there is nothing to filter on.

### D7 — Chat generates with an empty context block

**Severity: MEDIUM. This is where hallucination actually enters.**

`backend/src/modules/ai/chat-service.ts:195–203` deliberately tolerates zero retrieval, on the
reasoning (documented in the same block) that the student's own recommendation data is grounding in
its own right. That reasoning is sound for *"which of my top three pays best?"*.

It is exactly wrong for *"how much is tuition at that college?"*. In that case the only thing
standing between the student and an invented figure is the prompt's first rule, and an 8B model
obeys a negative instruction like that perhaps four times in five.

### D8 — English-only embeddings, Filipino students

**Severity: MEDIUM. Structural.**

`@cf/baai/bge-base-en-v1.5` has no Filipino or Taglish training. A student asking *"magkano ang
tuition sa nursing?"* produces a query vector that matches nothing, however good the corpus is.

`@cf/baai/bge-m3` is multilingual and on the same free tier, but is **1024-dimensional**, and
Vectorize index dimensions are immutable — this is a new index plus a full backfill, not a config
change. See *Open decisions*.

---

## 2. Target architecture — four gates

Cheapest first. A question exits at the earliest gate that can answer it, so the model is the last
resort rather than the default. This is also how the system stays inside 10,000 neurons/day.

| Gate | Cost | What answers | Output |
| --- | --- | --- | --- |
| **1 — Canonical answer** | 0 neurons | An admin-authored Q&A pair matching at ≥0.90, or exactly after normalisation | The admin's answer, verbatim |
| **2 — Computed facts** | 0 neurons | Match scores, rankings, §27 reasons, catalog fields (salary band, strand, location) | Template + real values |
| **3 — Cited paraphrase** | ~1–3 neurons | Hybrid retrieval → rerank → generate with citation markers | Answer + visible `[1] [2]` sources |
| **4 — Honest refusal** | 0 neurons | Nothing retrieved, or the answer failed validation | Refusal + deterministic data + **gap logged** |

### The honest framing

You cannot make an 8B model stop hallucinating. No prompt, no policy, and no amount of admin
knowledge gets a generative model to 0% invented facts.

What you *can* guarantee is that **no ungrounded claim ever reaches a student as fact**. That is an
architecture, not a prompt, and the table above is it.

### Why Gate 4 is the most valuable output

Every Gate 4 exit already writes an `ai_requests` row carrying `input_context.retrieval_query` and
`failure_reason` (`ai-gateway-service.ts:372` `logSkipped`, and the `failure()` path). That is
already a complete, queryable log of **every question a student asked that the knowledge base could
not answer** — with no new pipeline to build. Surfacing it to the admin turns refusals into the
backlog that closes them.

---

## 3. Phases

### Phase 0 — Make retrieval retrieve  ·  ~1 day

No new tables, no new screens. Do this before anything else: every later phase is measured against
it.

- [x] Cut `MAX_CHUNK_TOKENS` to **420** in `backend/src/lib/chunker.ts`, safely inside the
      embedder's 512-token limit. Update `backend/test/unit/chunker.test.ts` bounds.
- [x] Add an assertion in `AiGatewayService.embed()` that logs when any text exceeds the embedding
      model's input limit — so D1's class of defect cannot recur silently.
      (`ai_gateway.embedding_input_truncated`; logs rather than throws — a degraded vector still
      beats a failed ingestion.)
- [x] Reprocess every existing document (`POST /admin/knowledge-documents/:id/reprocess`).
      **Nothing to reprocess: the production corpus is empty.** Checked 2026-09-04 against the
      remote D1 — `knowledge_documents` holds **0 rows** (archived included) and
      `knowledge_chunks` **0 rows**. No document has ever been ingested. Re-run this step after
      the first documents land, since anything ingested before this deploy would still be
      chunked at 800.
- [x] Add `AiGatewayService.embedQuery()` applying the BGE retrieval prefix. Passage embedding stays
      untouched — existing vectors remain valid. Point `RetrievalService.retrieve` at it.
- [x] Drop `RETRIEVAL_SIMILARITY_THRESHOLD` to **0.55**, and promote it to a wrangler var so it is
      tunable without a code deploy. (Declared in all four wrangler configs and gated in
      `scripts/platform-gates.mjs`; unlike the other numeric vars it falls back to the constant
      rather than throwing, since a tuning knob should not 500 an environment that omits it.)
- [x] Raise `RETRIEVAL_TOP_K` to **20**; keep 6 after reranking. (Split into
      `RETRIEVAL_CANDIDATE_K` = 20 and `RETRIEVAL_TOP_K` = 6, so the two numbers are named for
      what they each control.)
- [x] Add a rerank step using `@cf/baai/bge-reranker-base` (scores query/passage pairs directly).
      This is what makes a lower floor safe. (`WORKERS_AI_RERANK_MODEL`; soft-fails to plain
      similarity order — an unavailable reranker degrades an ordering, it does not fail a
      retrieval that already has its candidates.)
- [x] Rewrite the explanation retrieval query (`explanation-service.ts:86–91`) to use the target's
      own `title` + `description` instead of the synthetic interest sentence.
- [x] Verify the index before tuning against it: `wrangler vectorize get
      careerlinkai_main_knowledge`. **Answer (2026-09-04): 768 dimensions, metric `cosine`,
      created 2026-07-13T09:19:05Z, no description.** That is exactly what
      `@cf/baai/bge-base-en-v1.5` produces, so the 0.55 floor is measured against the right
      scale — and it confirms the D8 constraint is real: moving to `bge-m3` (1024-d) is a new
      index, not a config change.

**Acceptance:** a fixed set of 20 real student questions retrieves ≥3 chunks each against the
current corpus, and **Explain more** produces a paragraph for the top recommendation of a seeded
test student on staging. **Met on 2026-09-04 — 17/20 on the keyword half alone, which is a floor.
See "Phase 0 acceptance, measured" below.** The *Explain more* half still needs a student session
to exercise.

**What landed (2026-09-04).** `lib/chunker.ts`, `modules/ai/ai-gateway-service.ts`,
`modules/ai/retrieval-service.ts`, `modules/ai/explanation-service.ts`, `modules/ai/factory.ts`,
`lib/config.ts`, `env.ts`, the four wrangler configs and `scripts/platform-gates.mjs`. Covered by
`test/ai/retrieval.test.ts` (new), plus additions to `test/ai/gateway.test.ts`,
`test/ai/explanation.test.ts` and `test/unit/chunker.test.ts`.

---

### The corpus is empty — found 2026-09-04, and it reorders this document

`SELECT COUNT(*) FROM knowledge_documents` on production returns **0**. Not "0 unarchived", not
"0 completed" — zero rows, archived included, and zero `knowledge_chunks`. Nothing has ever been
ingested.

So D1–D4 were all real and all worth fixing, but on today's data **none of them was the reason
`Explain more` produces nothing.** A perfect retriever over an empty index returns nothing, and
`NO_GROUNDING` is then not a defect at all — it is the pipeline behaving exactly as §30 designed
it to, refusing to generate ungrounded because there is genuinely nothing to ground on.

This is D5's severity note read literally: *"every other fix in this document multiplies a corpus
that currently does not grow."* It has never grown. The upload-only path — PDF or DOCX, parsed in
the browser, no paste, no edit, no Q&A — is not one bottleneck among several. On this evidence it
is **the** defect, and Phase 1 is not the second phase, it is the one that makes Phase 0
measurable.

Phase 0's acceptance therefore moves: it is measured after the first real documents exist, using
Phase 1's own entry paths, and the catalog auto-sync in Phase 1 is what will put the first chunks
in the index without anyone having to find a PDF first.

---

### Phase 1 — Give the admin real ways to teach it  ·  ~3 days

The central ask. Four new knowledge sources, all reusing the existing chunk → embed → Vectorize
pipeline unchanged.

- [x] **Migration 0022:** rename `knowledge_documents.file_type` → `source_type`
      (`pdf | docx | text | qa | catalog`), add `title`, make `storage_path` nullable. Updated
      `serializers.ts`, `types/ai.ts`, and the enums. **Also adds `entity_type` / `entity_id`**
      with a partial unique index — not in the original bullet, but the catalog sync's
      find-or-create key: without it "re-sync on edit" would add a second entry every run rather
      than correct the first. Both tables are rebuilt in a deliberate order, because
      `knowledge_chunks` carries `ON DELETE CASCADE` and a bare `DROP TABLE` on the parent would
      have taken every chunk with it.
- [x] **Pasted text entries.** Title + body on `KnowledgeListPage`, written straight to the R2
      sidecar the pipeline already reads — `process()` needed no change at all, as predicted.
- [x] **Q&A pairs — the highest-value input.** Stored as one `Q: …\nA: …` passage. The 300/1200
      character caps are load-bearing rather than cosmetic: they are what guarantee the pair lands
      as **one** chunk, since half an answer retrievable without its other half is the failure the
      §33 overlap exists to prevent, reintroduced at the source.
- [x] **Catalog auto-sync** (`modules/ai/catalog-knowledge-service.ts`). One entry per active
      career and program, composed as prose sentences rather than a field dump — a bi-encoder and
      an 8B model both do better with "earns between PHP 25,000 and PHP 40,000 a month" than with
      `salary_min=25000`. Runs on the existing 03:00 UTC cron **and** on demand from an admin
      button. Re-embeds only what changed, so a night with no catalog edits costs zero neurons.
- [x] **Edit in place.** Text and Q&A entries are editable; saving re-chunks through the existing
      reprocess path, so a corrected fact *replaces* the wrong one in the index rather than
      joining it there. Uploads and catalog entries are refused, each for its own reason.
- [x] **Accept `.txt` and `.md` uploads** — no parser on either side, so no bundle cost.

**Acceptance:** an admin can answer a question that has never been answered before, in under a
minute, without leaving the browser — and the next student to ask it gets that exact answer.
*Code complete and covered by tests; the second half ("gets that exact answer" verbatim) is
Gate 1, which is Phase 3 — today the answer is retrieved and paraphrased with the Q&A passage as
its grounding.*

**One deviation from the bullet above, stated plainly.** Catalog re-sync on a catalog edit is a
**button plus the nightly cron**, not an event listener. `AcademicCatalogService` takes only a
`Database` and is constructed in one place; threading a queue binding through it to save an admin
from pressing a button — on a screen where they can already see whether the entry is current —
buys less than it costs. The cron closes the loop unattended; the button closes it immediately.

**What landed (2026-09-04).** `migrations/0022_knowledge_sources.sql`,
`modules/ai/catalog-knowledge-service.ts` (new), plus `knowledge-ingestion-service.ts`,
`ai/routes.ts`, `ai/schemas.ts`, `ai/serializers.ts`, `db/schema.ts`, `db/enums.ts`,
`platform/audit-service.ts`, `jobs/cleanup.ts`, `index.ts`; frontend `types/ai.ts`,
`services/aiApi.ts`, `hooks/useAiKnowledge.ts`, `utils/extractText.ts`, `KnowledgeListPage.tsx`.
Covered by `test/ai/knowledge-entries.test.ts` (new, 12 cases) and additions to
`test/ai/ingestion.test.ts`.

---

### Phase 2 — Retrieval that knows what it is looking for  ·  ~3 days

Precision, so that a bigger corpus makes answers better rather than noisier.

- [x] Add `source_type`, `entity_type`, `entity_id` to vector metadata at upsert and to
      `knowledge_chunks` (migration 0023). Denormalized onto the chunk row **and** into the vector's
      metadata deliberately: Vectorize filters inside the index before any row is read, so a vector
      carries its own metadata or cannot be filtered at all — and keeping the same three values on
      the row means the keyword half filters on one definition of "about this program", not two.
- [x] Create the metadata indexes **first**. Done on 2026-09-04, against an empty index, so the
      ordering hazard is satisfied by construction rather than by care:
      `wrangler vectorize list-metadata-index careerlinkai_main_knowledge` → `source_type`,
      `entity_type`, `entity_id`, all String.
- [x] Two-pass explanation retrieval: three slots filtered to this exact career/program first,
      general theory chunks for the rest, deduplicated by chunk id. Three of six, because an
      explanation built only from catalog facts reads like a brochure — the theory chunks are what
      connect those facts to the student's RIASEC profile.
- [x] **Hybrid search.** FTS5 external-content virtual table over `knowledge_chunks.content`, kept
      in step by insert/update/delete triggers, fused with the vector hits by reciprocal rank
      (k=60). Zero neurons. RRF rather than score normalisation because cosine similarity and BM25
      are not on one scale and never will be.
- [x] Embedding cache in KV keyed by SHA-256 of the query. **KV's first reader in this codebase** —
      it has been bound "for caching" since §48 and read by nothing. Every failure mode falls
      through to embedding the query, because an optimisation that can break what it optimises is
      a bug.

**Acceptance:** explaining a program retrieves that program's own catalog entry as match #1, and a
query naming a college by exact name returns it whether or not the embedding agrees. *The second
half is covered by a test that passes with the vector half returning **nothing at all**; the first
is asserted at the filter reaching Vectorize, and is measurable end-to-end only after deploy.*

### What Phase 2 changed about refusal — worth knowing before Phase 3

Hybrid search made `NO_GROUNDING` **rarer**, and not only in the good way. The keyword half joins
terms with `OR`, so before stopwords were removed a chunk sharing nothing with the question but the
word *"the"* entered the candidate set — and a pipeline that should say *"nothing here covers
that"* would instead generate a paragraph grounded on a coincidence.

This surfaced as two existing tests failing, which is the useful kind of failure: they were
asserting the honest-refusal posture, and they caught the regression the moment it existed.
`toFtsQuery` now drops stopwords in English **and** Filipino — matching on "the" is not weak
evidence, it is no evidence. Filipino is in that list because Taglish questions are the norm here
and the English embedder cannot represent them at all (D8), which makes the keyword half not a
supplement but the only half that works for those questions.

Phase 3's cite-or-refuse and claim-overlap checks are what make this properly safe. Until they
land, retrieval is more generous than it was, and the §34 guardrails are the only thing between a
marginal chunk and a student.

**What landed (2026-09-04).** `migrations/0023_chunk_metadata_and_fts.sql`, a rewritten
`modules/ai/retrieval-service.ts`, plus `vector-store.ts`, `knowledge-ingestion-service.ts`,
`explanation-service.ts`, `factory.ts`, `db/schema.ts`. Covered by
`test/ai/hybrid-retrieval.test.ts` (new, 13 cases) and additions to `test/ai/ingestion.test.ts`
and `test/ai/explanation.test.ts`.

**One defect this phase created and caught before deploy.** `CHUNK_ROWS_PER_INSERT` was 12 against
7 bound columns; migration 0023 made it 10 columns, so 12 rows bound 120 and breached D1's
100-parameter ceiling (D18) — *every* ingestion failed with "too many SQL variables". Miniflare
enforces the cap locally, so the ingestion suite caught it immediately; without that it would have
been a clean deploy that could not ingest anything. The constant is now 9, and its comment names
every column rather than just the count, because it has now been wrong twice in both directions.

---

### Phase 3 — The grounding contract  ·  ~4 days

Four layers, ordered by cost. This is where "no hallucination" stops being a hope and becomes
something the code enforces.

- [x] **Gate 1 short-circuit.** An exact normalised question match against a Q&A entry returns the
      admin's answer with **no model call at all** — no embedding, no vector query, no generation.
      One FTS5 lookup narrows the candidates, then normalised string comparison decides. Exact
      after normalisation rather than fuzzy, deliberately: Gate 1 hands back an admin's words with
      no model in the loop to notice the question was actually a different one. *The ≥0.90
      similarity variant is **not** built — see the deviation below.*
- [x] **Cite or refuse.** `[n]` markers are required whenever passages were supplied; a missing
      marker is `NO_CITATION`, one out of range is `CITATION_OUT_OF_RANGE`. Both extend the
      existing §34 block in each service rather than adding a second taxonomy, and both land on
      the same deterministic fallback every other failure lands on.
- [x] **Claim overlap check** (`lib/grounding.ts`, pure and standalone). Every figure and every
      proper noun in a generated sentence must appear in the material the answer was given. It
      runs *after* the citation check and ignores the markers, because citing correctly while
      inventing inside the cited sentence is a thing models do.
- [x] **Optional verifier pass**, behind `AI_VERIFIER_ENABLED` (default `false`). Runs only on
      answers that survive the free checks **and still assert a figure**. A verifier that errors,
      times out, or answers unclearly returns "supported" — it exists to catch what the mechanical
      checks missed, not to become a second way for a working answer to vanish.
- [x] **Scope guard.** Homework is declined; a personal or distressing message is classified
      *separately* and answered warmly with a route to a person. That split is the one part of this
      phase where getting it wrong costs more than every other check combined.
- [x] **Show the sources.** *"Based on: 2026 Admissions Handbook"* under the answer, in both
      `RecommendationChatPanel.tsx` and the Explain-more block. Only what the answer **cited** is
      named — listing a passage the model never used would be a worse lie than listing none, since
      the student would check it and find nothing. Persisted (migration 0025) rather than computed
      on read, because provenance is a fact about the moment of generation and the corpus moves.
- [x] **Narrow D7.** The zero-retrieval path survives only for questions the student's own results
      can actually answer (`answerableFromResults`). Everything else refuses before reaching the
      model, and the refusal writes the `ai_requests` row that becomes Phase 4's backlog item.

**Acceptance:** a red-team set of 30 questions with no corpus coverage produces 30 refusals and zero
confident fabrications. *Eight of those cases are pinned as tests
(`test/ai/grounding-contract.test.ts`), driving a stubbed model that says exactly the wrong things
on purpose — an invented fee correctly cited, a true answer with no marker, a question nothing
covers. The full 30 is a deploy-time exercise against the real model.*

### One deviation, and why

**Gate 1's ≥0.90-similarity variant is not built; only the exact-match half is.** The plan offered
two routes into a verbatim answer, and they are not the same trade. Exact-after-normalisation costs
nothing and cannot be wrong about *which* question it is answering. A 0.90 cosine match can be —
and the consequence is not a slightly-off paragraph but **an admin's answer to a different question,
returned verbatim, with no model in the loop to notice**. Vectorize's own scores are also not
comparable across corpora, so 0.90 would need calibrating against real content that does not exist
yet. The near-miss case still gets a good answer: it falls through to Gate 3, where the Q&A passage
is retrieved, cited and checked like any other. Worth revisiting once there is a corpus to calibrate
against.

**What landed (2026-09-04).** `lib/grounding.ts` (new), `modules/ai/sources.ts` (new),
`migrations/0025_answer_sources.sql`, plus `chat-service.ts`, `explanation-service.ts`,
`ai-gateway-service.ts`, `retrieval-service.ts`, both prompt files, `serializers.ts`, `db/schema.ts`,
`env.ts`, `lib/config.ts`, `recommendation/routes.ts`, `recommendation-service.ts` and the four
wrangler configs; frontend `types/ai.ts`, `types/recommendation.ts`, `RecommendationChatPanel.tsx`,
`RecommendationPage.tsx`, `useRecommendations.ts`. Covered by `test/unit/grounding.test.ts` (19
cases) and `test/ai/grounding-contract.test.ts` (8 cases).

### What the existing tests had to change, and why that is the finding

Nine tests across `chat.test.ts` and `explanation.test.ts` failed the moment the contract landed.
Every one of them was a fixture whose stubbed model output would now be **rejected**: an answer with
no citation marker, or one naming a RIASEC dimension that appears nowhere in the material the answer
was given.

That is the contract working on its first contact with real text, and it is worth stating plainly
because it is also the honest cost estimate: **a model that has not been told to cite will produce
answers this pipeline discards.** The prompts now demand markers, and the fallback is a true answer
rather than an error — but the rejection rate against the live model is a number nobody has yet, and
it is the first thing to measure after deploy. If it is high, the fix is prompt work, not a weaker
check.

---

### Phase 4 — The flywheel  ·  ~3 days

Coverage is not a launch state, it is a habit. Make the gaps visible and closing them one click away.

- [x] **Unanswered questions report.** `AiInsightsService.unansweredQuestions` — a single D1 query
      grouping on `json_extract(input_context, '$.retrieval_query')`, ranked by how many students
      asked. **Answer this** carries the question into the Q&A form as `?answer=…`, so the admin
      types an answer and nothing else. Coverage failures only: a `MODEL_ERROR` row is an
      operational problem no amount of admin writing fixes, and mixing those in would bury the
      actionable rows on exactly the days the platform was struggling.
- [x] **Catalog coverage grid**, with one addition the plan did not ask for and the data demanded:
      a gap is reported as **stalled** when an entry exists but its chunks never embedded. Those
      are one Reprocess away from fixed; a truly missing entry needs a sync. Same symptom, opposite
      remedy, and neither announces itself anywhere else.
- [x] **Answer feedback** (migration 0026). Thumbs-down only — a rating on an answer nobody
      questioned tells an admin nothing to act on, while a thumbs-down leads straight to the
      passage that caused it through the chunk ids already on the `ai_requests` row. No un-flag: an
      item that can vanish before anyone reads it is worse than a stale one.
- [x] **Neuron budget guard.** An account-wide daily counter in `AuthGuardDO`, charged inside
      `AiGatewayService.generate` — the one place every generation passes through — and *before*
      the call, so a burst cannot all pass a check none of them had paid for. Refusal is an
      ordinary typed failure (`BUDGET_EXHAUSTED`), so every caller's existing fallback handles it
      with no new branch. The window expires at 00:00 UTC with the allocation it tracks.
- [x] **Cloudflare AI Gateway in front of the `AI` binding** — `AI_GATEWAY_ID`, passed as
      `{ gateway: { id } }` on every model call. Empty by default and deliberately so: the gateway
      must be created in the dashboard first, and a var naming one that does not exist would fail
      every model call. (The name collision stands: `AiGatewayService` is our internal adapter and
      predates any use of the Cloudflare product.)

**Acceptance:** the admin's weekly routine is — open the report, answer the five most-asked
unanswered questions, done. *The screen exists and is covered by tests; the routine is only real
once students have used the assistant enough to fill it.*

**Deployed, and verified as deployed rather than assumed.** Migration 0026 is applied to production
and the live asset bundle contains the insights code. Both halves needed checking, because the
route probe that looks like the obvious test is worthless here: `adminAiRoutes` mounts
`authenticate()` on `*`, so `/api/v1/admin/ai-insights` and a route that does not exist at all
**both** answer 401. What settles it is the deployed bundle — `assets/admin-*.js` served from
careerlinkai.online contains `ai-insights`, `unanswered` and `stalled`, and its hash matches the
local build.

### Two honest notes on the budget guard

**It counts generations, not neurons.** Workers AI exposes no neuron meter a Worker can read, so
`DAILY_GENERATION_BUDGET = 500` is a proxy chosen from the two generation shapes this system has (a
500-token chat turn and a 400-token explanation). It is arithmetic, not measurement, and the right
way to correct it is to watch the real quota over a term and move the constant.

**Degrading at 85% is the point, not the ceiling.** Hitting the platform's own limit kills every AI
feature at once, at whatever hour that day's classes happened to exhaust it — most likely
mid-afternoon, with the next class getting nothing. Stopping early keeps a reserve for the gates
that cost nothing and fails *predictably* instead.

**What landed (2026-09-04).** `modules/ai/insights-service.ts` (new),
`migrations/0026_answer_feedback.sql`, plus `ai-gateway-service.ts`, `chat-service.ts`,
`factory.ts`, `ai/routes.ts`, `recommendation/routes.ts`, `serializers.ts`, `db/schema.ts`,
`lib/auth-guard.ts`, `env.ts` and the four wrangler configs; frontend `AiInsightsPage.tsx` (new),
`KnowledgeListPage.tsx`, `RecommendationChatPanel.tsx`, `useAiKnowledge.ts`,
`useRecommendations.ts`, `aiApi.ts`, `recommendationApi.ts`, `types/ai.ts`,
`types/recommendation.ts`, and the router/paths/nav. Covered by `test/ai/insights.test.ts` (8
cases).

---

## 4b. First contact with production (2026-09-04, after the Phase 0–3 deploy)

Migrations 0022–0025 applied and the catalog sync run. Measured immediately afterwards:

| | |
| --- | --- |
| Catalog entries | **373** (was 0, ever) |
| Chunks | 372, **354 embedded** |
| Entry states | 345 COMPLETED · 13 PROCESSING · 1 UPLOADED · **14 FAILED** |
| Largest chunk | 80 tokens — comfortably inside the embedder's 512 |

The corpus exists. That single fact closes the finding this document opens with, and it is why
Phase 0's acceptance can finally be measured at all.

**The 14 failures are the first real work item, and Phase 4's own screen is where they surface.**
Their chunks exist and are unembedded, which is precisely the `stalled` state the coverage grid was
built to name: the text is there, the vectors are not, and every other list in the app shows those
entries as healthy. The remedy is the Reprocess button. What is *not* yet known is why they failed —
a transient Vectorize or Workers AI error during a 373-entry sync is the likeliest explanation, and
if it recurs on reprocess it is a defect rather than a hiccup.

**Resolved, same day.** Re-measured after the reprocess: **372 COMPLETED, 0 unembedded chunks** out
of 372. The 14 failures did not recur, which settles the open question above in favour of the
transient explanation — the reprocess was the whole remedy, and the coverage grid named the state
correctly on its first real use.

One entry did *not* resolve and is worth recording because its shape is different:

| | |
| --- | --- |
| `89591adf` | *Program: BS Information Technology at Adamson University* |
| State | `UPLOADED`, **0 chunks**, `content_hash` NULL, `updated_at` = `created_at` |

Not stalled — never started. The sync created the row at 08:32 and the content write never
followed, so this is the coverage grid's *other* diagnosis: an entry that needs a sync, not a
reprocess. It also fixes itself without anyone touching it, and by design: a NULL `content_hash`
compares unequal to every real hash (migration 0024), so the entry is rewritten by the next 03:00
cron or by one press of **Sync catalog knowledge**. One entry in 373, self-healing, and the
mechanism that heals it is the same one that makes an unchanged entry free.

Worth noting for later: each catalog entry is one chunk, so "one embedding call per document" gives
no batching at all — 373 entries meant 373 embed calls. That is within budget and not a defect, but
it is the obvious optimisation if the corpus ever grows by an order of magnitude.

### Phase 0 acceptance, measured (2026-09-04, after the sync and the reprocess)

**17 of 20 real student questions retrieve ≥3 chunks — on the keyword half alone.** The acceptance
bar is met, and the figure is a *floor*: the vector half is not included, and it can only add.

Two things about the number that matter more than the number:

**Why only the keyword half.** Embedding a query requires the deployed Worker, which requires a
student session. The lexical half runs against D1 directly, so it is the half that can be measured
from outside the app. Anything the embeddings add sits on top.

**A match count is not a candidate count.** Several questions match 300+ chunks — "programs" appears
in every program passage — but `KEYWORD_CANDIDATE_K` caps the keyword half at its top 10 by BM25
before fusion. Those large numbers are recall, not noise reaching the prompt.

#### The three misses are all one defect: FTS5 does no stemming

| Question | Chunks |
| --- | --- |
| Tell me about becoming a Registered **Nurse** | 1 |
| How much do **architects** earn? | 0 |
| What careers involve working with **computers**? | 0 |

`unicode61` matches whole tokens. *"nursing"* finds 10 chunks and *"nurse"* finds 1; the corpus says
*Architect* and *computer* while a student types *architects* and *computers*. Not one of these is a
coverage gap — the passages exist and say the right thing.

The vector half covers exactly this class of miss, which is the argument for hybrid retrieval
working as designed rather than for panic. But the cheap fix is one word: FTS5 ships a `porter`
tokenizer wrapper, so `tokenize="porter unicode61 remove_diacritics 2"` stems both sides of the
comparison. It needs a migration that drops and rebuilds the virtual table (the tokenizer is fixed
at creation), and it should be measured again afterwards — English stemming on Taglish text is not
free of side effects, and *"magkano"* must not stem into something else.

- [x] Decided: **porter stemming.** Migration 0027, applied to production 2026-09-04.

#### What it cost and what it bought, both measured before the migration was written

The side effect the plan named was checked first, against the tokenizer rather than against
intuition — an `fts5vocab` table over a probe index says exactly what each word becomes:

* **`magkano` stems to `magkano`.** So do *trabaho, kurso, paaralan, mahal, kailangan, maganda,
  pagkain, bayad, gusto* and *saan*. Porter's rules key off English suffixes and Filipino roots
  mostly do not carry them.
* Three Tagalog words *are* mangled, all by the `-ing` rule: `aking` → `ak`, `ating` → `at`,
  `kaming` → `kame`. Survivable for the one reason that matters — the rule runs on the query too,
  so *aking* still finds *aking*. The residual risk is an English word colliding on `ak` or `at`,
  and both are then terms of very high document frequency, which is what BM25 scores at near zero.

Re-measured on production immediately after the migration. Singular and plural now return
**identical** counts, which is the proof that both sides stem to one term:

| Term | Chunks before | Chunks after |
| --- | --- | --- |
| **nurse** | 1 | **11** (= `nursing`) |
| **architects** | 0 | **2** (= `architect`) |
| **computers** | 0 | **44** (= `computer`) |

All 372 rows re-indexed, `indexed_rows` = `table_rows`. Phase 0's acceptance is now 20 of 20 on the
keyword half alone. Three regression tests in `test/ai/hybrid-retrieval.test.ts` pin it, and they
were confirmed to **fail** with 0027 removed — a test that passes either way would have proved
nothing.

#### The gap this measurement exposed instead

`tuition`, `scholarship` and `magkano` return **0 chunks on production** — and this time it is not
the tokenizer. A generated catalog passage reads in full:

> Program: BS Chemistry (BSCHEM) at Mindanao State University – Iligan Institute of Technology.
> About this program: Analytical, organic and physical chemistry.
> The recommended senior high school strand is Academic.

Name, description, strand. **No cost, no scholarships, no admission requirements** — so the three
things students ask about most are the three things this corpus cannot answer, in any language, by
either half of retrieval. No amount of retrieval tuning reaches it: the text does not exist. This
is a Phase 1 input problem with a Phase 4 remedy — it is precisely what the unanswered-questions
report is built to surface, and the fix is admin-authored Q&A entries, which is why §3 called those
the highest-value input.

### The measurement harness, twice wrong before it was right

Worth recording because both failures produced *confident, plausible, wrong* numbers:

1. `wrangler d1 execute --file` with several statements returns a **summary row and no result
   sets**. The first run therefore read 0 for all 20 questions and looked exactly like an empty
   corpus — the same symptom this whole document opens with. One direct query disproved it: the FTS
   index holds 372 rows and `MATCH 'nursing'` returns 10.
2. A compound `SELECT` over 20 subqueries is refused by D1 (*"too many terms in compound SELECT"*).

The working shape is one `--command` per question. A measurement that agrees with your prior is the
one to check hardest.

---

## 3b. Defects found by review, after the phases were "done" (2026-09-04)

All three were found by re-reading the diff with the suites green. None of them had a failing
test — which is the point worth keeping: the tests asserted what the code was built to do, and
these are three things it was not built to do and should have been.

### B1 — Archiving stopped putting content beyond the AI's reach

**Severity: HIGH. Introduced by Phase 2. Fixed.**

§30 excludes archived documents *structurally*: archiving deletes their vectors from Vectorize, so
they cannot match — and §30 explicitly prefers that to a query-time filter, because "an exclusion
that exists as a query-time WHERE clause is an exclusion someone can forget."

Phase 2's keyword half reads `knowledge_chunks` **directly**, and those rows deliberately survive
archiving (`ai_requests.input_context` references chunk ids for provenance, §13.7). So hybrid
search silently reopened every archived document: a withdrawn policy or a corrected fee could be
retrieved and quoted back to a student.

`keywordCandidates` now joins `knowledge_documents` and requires `archived_at IS NULL` — precisely
the clause §30 warned about, which is why it carries a long comment and its own test. The guarantee
stopped being free the moment a second retrieval path existed, so it has to be paid for explicitly.

### B2 — The catalog sync only ever added

**Severity: MEDIUM. Introduced by Phase 1. Fixed.**

Archiving a career in the catalog stops it being recommended, but its generated knowledge entry
stayed live — so the assistant could still describe, price and advise on a career the school had
deliberately withdrawn, citing an entry this system wrote. The sync now archives entries whose
career or program is no longer active, per entry inside a try/catch so one unreachable Vectorize
delete cannot abandon the pass or break a cron that promises never to throw.

### B3 — The sync could not fit in a free Worker invocation

**Severity: HIGH. Introduced by Phase 1. Fixed (migration 0024).**

It decided "has this entry changed?" by **reading the text back from R2**. Every binding call is a
subrequest and a free invocation gets 50 (§45) — the same ceiling the §33 embedding batcher exists
to respect. Seed 0004 alone puts 68 careers in the catalog, so:

* the first press of **Sync catalog knowledge** would have breached the ceiling before writing
  anything, and
* the nightly cron would have breached it **every night, even when nothing had changed** — the case
  that is supposed to cost nothing at all.

This is the one that would have looked like "the feature just doesn't work" on the first deploy,
with the *empty* corpus that motivated the whole document as the visible symptom. Three changes fix
it, and they are all about paying subrequests only for real work:

* `knowledge_documents.content_hash` (migration 0024) moves the comparison into the single D1 query
  that lists the entries. An unchanged entry now costs **zero** subrequests, asserted by a test that
  counts R2 access rather than trusting the shape of the code.
* One batched `Queue.sendBatch` for the whole run instead of one send per entry.
* A budget of 20 rewrites per invocation, with the surplus reported as `remaining` — so a first
  seed says "this much done, run it again" rather than silently doing part of the job or exceeding
  the limit trying not to.

### What this says about the tests

Every one of these passed a full green suite. B1 and B3 in particular are the kind of defect a test
suite structurally cannot catch unless someone thinks to write the test: B1 is an invariant stated
in prose in §30 and nowhere in code, and B3 is a platform limit that no local runtime enforces.
Both now have tests. The lesson is the one this document already applies to retrieval — a guarantee
that is not measured is a guarantee that is not held.

---

## 4. How reliability compounds

1. **Student asks.** The question hits the four gates. If nothing covers it, the system refuses
   honestly rather than inventing.
2. **The gap is recorded.** The refusal writes an `ai_requests` row with the exact query text.
   *Already implemented — no work needed.*
3. **The admin sees it ranked** by frequency, so the most-asked gap is first on screen.
4. **The admin writes the answer.** One Q&A entry, chunked and embedded within a minute by the
   existing queue.
5. **The next student gets it exactly.** Gate 1 returns the admin's words verbatim — no model, no
   drift, no neuron cost.

The corpus stops being something someone remembered to upload and becomes a record of what students
actually needed. After a term of use the common questions are all Gate 1, which means the
most-asked questions are answered by a human, deterministically, for free.

---

## 5. Free-plan budget

Workers AI free allocation is **10,000 neurons/day**, resetting at 00:00 UTC — 08:00 Manila, which
is roughly when a school day starts. The budget refills just before the load arrives.

| Operation | Model calls | Frequency | Mitigation |
| --- | --- | --- | --- |
| Chat turn, Gate 3 | embed + rerank + generate | per message | Embedding cache, per-student rate limit, Gates 1–2 first |
| Chat turn, Gate 1/2 | 1 embed, or 0 | per message | Cached queries cost nothing |
| Explanation | embed + rerank + generate | once per recommendation, ever | Already cached in `recommendation_explanations` |
| Ingestion | 1 embed per ≤100 chunks | per document | Already batched; catalog sync on the nightly cron |

The binding constraint is chat. Gates 1 and 2 are what keep it inside the envelope, because the
questions students repeat most are exactly the ones that never reach the model.

---

## 6. Open decisions

### Switch embeddings to `bge-m3` for Filipino/Taglish?

**Recommendation: yes, but at the end of Phase 2, not now.** It is a new 1024-dimension Vectorize
index plus a full re-embed — index dimensions cannot be changed — so do it once, after chunk sizes
and metadata are settled. Until then D8 stands: students must ask in English to be understood.

- [ ] Decided: …

### Move to Cloudflare AI Search (formerly AutoRAG) instead of this pipeline?

**Recommendation: no.** It is free in open beta with 20,000 queries/month on the Workers Free plan
and would replace real work, but it costs the per-chunk provenance in `ai_requests`, the
archive-not-delete guarantee (§13.7), and the audit trail — all ratified requirements here. This
pipeline is 90% built; finish it.

- [ ] Decided: …

### A larger text model for explanations?

**Recommendation: worth testing.** Explanations are generated once per recommendation and cached
forever, so their neuron cost is negligible; a larger instruct model there would improve the
paragraph students actually read at almost no budget cost. Keep the 8B model for chat, where the
volume lives.

- [ ] Decided: …

---

## 7. Risks

**Reprocessing is not free.** Phases 0 and 2 both require re-embedding the whole corpus. Batch it
against the daily neuron budget and run it overnight. At ~1 embedding call per 100 chunks this is
small, but it is not zero.

**Metadata indexes must exist before the vectors.** Create them, *then* reprocess. Getting this
order wrong produces a silent no-op where filtering appears configured and matches nothing.

**The 512-token truncation is invisible.** Nothing in Workers AI reports it — which is why the
`embed()` assertion in Phase 0 is a checklist item and not an optional nicety.

**Gate 1 is only as good as the admin's answers.** Verbatim return means a wrong answer is served
with full confidence. Q&A entries need an author, a timestamp and a review date; this is the one
place where the human, not the model, is the failure mode.

---

## Appendix — verification notes

Cloudflare facts used above, checked 2026-09-04 against the current documentation:

* Workers AI free allocation: 10,000 neurons/day on both Free and Paid plans; resets 00:00 UTC.
* `@cf/baai/bge-base-en-v1.5`: 512 max input tokens, 768 output dimensions.
* `@cf/baai/bge-reranker-base` exists on Workers AI and scores query/document pairs directly.
* `@cf/baai/bge-m3`: multilingual, 1024 dimensions.
* Vectorize: max 10 metadata indexes per index; vectors upserted before a metadata index was created
  are not contained in it; string metadata indexed on the first 64 bytes. **Three are created on
  `careerlinkai_main_knowledge` as of 2026-09-04** — `source_type`, `entity_type`, `entity_id` —
  made while the index held no vectors, so nothing predates them.
* AI Search (AutoRAG): free in open beta, 20,000 queries/month on Workers Free; Workers AI and AI
  Gateway usage billed separately.

Not yet verified — **do this in Phase 0**:

* [x] The distance metric and dimension count of `careerlinkai_main_knowledge` — **768,
      cosine**, checked 2026-09-04 with `wrangler vectorize get`. Nothing in this repository
      recorded how the index was created; now this line does.
