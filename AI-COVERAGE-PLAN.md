# AI Coverage Plan — answering every student question, correctly, on the free model

**Date:** 2026-09-12
**Scope:** the recommendation chat (`ChatService`), the explanation pipeline, the knowledge corpus,
the student context the model is given, and the admin knowledge screens.
**Trigger:** the chat refuses or apologises for most of what students actually ask, and the
requirement is to cover the whole range of a Senior High student's career and college questions
using only the data this system holds plus the free Workers AI model.
**Goal:** every answer a student reads is one of three things — arithmetic this system computed,
text a counselor or admin wrote, or a cited paraphrase of retrieved text — **and the share of
questions that get one of those three instead of a refusal goes from roughly half to over 90%.**

Written evidence-first, like `AiNormalisation.md`: every finding names the file, line or query
that establishes it. Read §2 before §4; the phases only make sense against the findings.

---

## 0. The one-paragraph version

The pipeline is sound and almost fully built. It fails students for four reasons, none of which is
"the model is too small": (1) a grounding rule discards correct answers — **39 of the 44 chat
failures on production are `NO_CITATION`**, and most of the discarded texts were right; (2) the
model is told almost nothing about the student — only five career and five program titles with a
score, not the RIASEC profile, SCCT bands, strand or grades that would let it explain anything;
(3) questions that are really *database lookups* ("which colleges in Bohol offer BSCS", "where is
HNU", "what leads to CPA") are sent through a six-chunk vector search that cannot answer a list
question; and (4) the corpus contains only auto-generated catalog passages and two real Q&A
entries, so there is nothing to retrieve about *how to choose*, *what a strand is*, *what CPA
licensure needs*, or *what if my grades are low*. The plan adds a **Student Brief**, a
**zero-neuron Catalog gate**, and a **curated Guidance corpus** in front of the existing RAG gate,
and fixes the citation rule. "Load all knowledge once at login" is addressed honestly in §3.4: a
language model has no memory between calls, so the equivalent that works on 10,000 neurons/day
is *precompute the student's brief once, keep the corpus in the index, and send each turn only
what that turn needs*.

---

## 1. What exists today (map)

| Concern | Where | State |
| --- | --- | --- |
| Model calls | `backend/src/modules/ai/ai-gateway-service.ts` — `@cf/meta/llama-3.1-8b-instruct-fp8`, `bge-base-en-v1.5`, `bge-reranker-base` | Working; every generation writes an `ai_requests` row |
| Retrieval | `retrieval-service.ts` — hybrid: Vectorize + FTS5 (porter), RRF fusion, cross-encoder rerank, KV embedding cache, floor 0.55 | Working since AiNormalisation Phases 0–2 |
| Chat gates | `chat-service.ts` — Gate 0 off-domain, Gate 1 exact Q&A match, then RAG generate with the grounding contract | Working; **no Gate 2/3/4** |
| Grounding contract | `backend/src/lib/grounding.ts` — cite-or-refuse, unsupported number/name check, self-reported gap, off-domain heuristics, `answerableFromResults` | Working; one rule mis-scoped (F1) |
| Corpus | `knowledge_documents`/`knowledge_chunks` — 256 catalog entries (career/program/college passages from `catalog-knowledge-service.ts`), 2 real Q&A, 5 leftover smoke-test Q&A, 263 chunks | Catalog only |
| Student context in prompt | `ChatService.userPrompt` — top 5 careers + top 5 programs, each `title — score%. reason` | Thin (F2) |
| Student data held | `student_profiles`: grade level, strand (`Academic` / `Technical-Professional`), Math/Science/English grades; `dimension_scores`: six RIASEC + three SCCT normalised scores with five-tier interpretations; `recommendations`: score + reason, **components not persisted** | Mostly unused by the chat |
| Catalog | 22 Bohol colleges, 41 canonical programs, 126 offerings, 108 careers with salary/outlook/RIASEC, 720 program↔career links, towns with map links | Complete, all descriptions filled |
| Designed but not wired | `ai_policies.web_search_enabled` / `general_knowledge_enabled` (migration 0029), `CHAT_ANSWER_KINDS`, `web-search-service.ts` (Serper, needs a key that is not in `env.ts`), `chat_messages.answer_kind` (always NULL) | Schema and enum exist; nothing reads them |
| Admin feedback loop | `insights-service.ts` — unanswered backlog, coverage, flagged answers; `question-resolution-service.ts` — answer → Q&A entry → Gate 1 | Working |
| Chat surface | `RecommendationChatPanel.tsx`, mounted only on `RecommendationPage.tsx` | One page only (F3) |

---

## 2. Findings

Ordered by how many student questions each one loses. All production numbers are from
`CareerLinkAI_Main` on 2026-09-12 (`wrangler d1 execute --remote --env production`).

### F1 — The citation rule discards correct answers

**Severity: CRITICAL. 39 of 44 chat failures.**

```
SELECT failure_reason, count(*) FROM ai_requests WHERE request_type='CHAT' AND status='FAILED'
→ NO_CITATION 39 · NO_GROUNDING 2 · SELF_REPORTED_GAP 2 · UNSUPPORTED_CLAIM 1
```

`chat-service.ts` `generated()`: when `retrieved.length > 0`, `validateCitations(text, …)` is
applied and a reply with no `[n]` marker is replaced by `NO_COVERAGE_REPLY`. But retrieval returns
*something* for nearly every question (the floor is 0.55 and the catalog is dense), so this rule
fires whenever the model answers from the **student's own results** instead of the chunks — which
is exactly what the prompt tells it to do for results questions. The discarded texts are visible
because the gateway had already logged them as `SUCCESS` before the chat logged a second `SKIPPED`
row (see F6):

| Question | Discarded reply (SUCCESS row, then refused) |
| --- | --- |
| what programs to become a certified public accountant | "…strong interest and confidence in becoming a Certified Public Accountant. The two careers that are a…" |
| where to study certified public accountant | "…strong match for becoming a CPA in two colleges: BS Accountancy at Univers…" |
| What subjects should I focus on for these? | "…For BS Accounting Information System and BS Accountancy at Talibon Polytechnic College and University o…" |
| What if I can't take BS Accountancy | "…there are still other options that align with your interests and skills. Based on your results…" |
| schools with my top 1 career | "…Database Administration, Systems Administration, Cybersecurity…" |
| my parents will be angry if I dont pick engineering… | "I can imagine how stressful it must feel…" (also missed by Gate 0 at the time; since fixed) |

Every one of those was a true answer built from the results context, refused for lacking a marker
it had no reason to carry. **The unsupported-claim check already runs on the same text against
results + chunks; the citation rule adds nothing to safety when the claim check passes.** The
student was told "I don't have anything in the school's guidance materials" for a question the
system had just answered correctly.

### F2 — The model is not told who it is talking to

**Severity: CRITICAL. Blocks the whole "why" and "what should I do" class of questions.**

`ChatService.userPrompt` (chat-service.ts) interpolates exactly: five career lines and five
program lines, each `ranking. title — score%. reason`. It does **not** include:

- the six RIASEC dimension scores and their bands, or the Holland code — held in `dimension_scores`
  with `interpretation` (five tiers since migration 0035);
- the three SCCT dimensions (Self-Efficacy, Outcome Expectations, Goal Orientation) and the
  composite career-confidence index;
- strand, grade level, Math/Science/English grades, academic average — held in `student_profiles`
  and already *used by the scorer* (`recommendation.ts` `academicFit`, `strandAlignment`,
  `programEligibility`) but never shown to the model;
- the **score components** per recommendation (`CareerMatchComponents`, `ProgramMatchComponents`)
  — computed in `scoreCareer`/`scoreProgram`, returned to the service, and then dropped: the
  `recommendations` table stores only `match_score` and `reason`;
- what the assessments *are* (the RIASEC and SCCT descriptions in `instruments.ts`).

Production shows the cost. *"Why bs accountancy where I am artistic I can take bs architecture"*
got a reply that could only restate the reason string. The honest answer — Accountancy ranks on
SCCT confidence 30% + academic fit 20% + strand 15% + eligibility 10%, and Architecture ranks lower
on RIASEC compatibility or is offered by one college only — needs the components. *"What subjects
should I focus on"* needs the grades. The scorer knows all of it.

### F3 — The chat only exists after both assessments, on one page

**Severity: HIGH. 38 of 58 production user turns came from students with no recommendations.**

```
SELECT count(*) FROM chat_messages m … WHERE m.role='user' AND no ranking-1 career recommendation
→ 38 of 58
```

`RecommendationChatPanel` is mounted only in `RecommendationPage.tsx`, and the prompt's
no-recommendations branch tells the model *"Say so plainly if they ask about their results"*. On
production the model said so on nearly every turn, including catalog questions it could have
answered: *"What colleges in Cebu offer BS Computer Science?"* → *"You haven't completed both
required assessments yet…"* six times for one student. A student who has finished only RIASEC
still has a Holland code worth talking about, and a student who has finished nothing still has
catalog questions.

### F4 — List and join questions are sent to a six-chunk vector search

**Severity: HIGH.**

Catalog passages are one entry per career, per program offering, and per college
(`catalog-knowledge-service.ts` `careerPassage` / `programPassage` / `collegePassage`). Questions
that need a *set* — every college offering BSCS, every program in Ubay, every career above
₱50,000 in the student's top five — need more rows than `RETRIEVAL_TOP_K = 6` can carry, and the
reranker chooses by similarity, not by completeness. Measured on production:

- *"What Colleges offer BS Computer Science in Bohol"* → refused (the answer is seven colleges,
  all in the catalog: `list_college_programs.md` §BS Computer Science).
- *"but I am from Bohol, what college fits my college recommendation and near me"* → "I don't have
  specific information on colleges in Bohol".
- *"share map location"* → refused; every college has `map_link`.
- *"HNU located"* → `UNSUPPORTED_CLAIM (NAME:HNU)` — the model correctly expanded the acronym and
  the claim check rejected it because no passage contains the string "HNU".

The catalog is **small**: 22 colleges, 126 offerings, 108 careers. Every one of these questions is
a D1 query with a templated sentence around it — zero neurons, complete, and checkable.

### F5 — There is no guidance knowledge, only catalog facts

**Severity: HIGH. This is the bulk of "all students' queries".**

```
SELECT source_type, count(*) FROM knowledge_documents WHERE archived_at IS NULL
→ catalog 256 · qa 2 (plus 5 smoke-test entries that should be archived)
```

The catalog passages say what a career pays and where a program is taught. Nothing in the corpus
says what *Investigative* means, how the match score is built, what the difference between the
Academic and Technical-Professional strands is, that BS Accountancy leads to the CPA board exam,
that BISU and the municipal colleges are public, what a college entrance exam is, or what to do
when a first choice is out of reach. These are the questions a guidance counselor answers every
day, they are not student-specific, and they are the same for every student — which makes them the
cheapest knowledge in the system to write once and retrieve forever. Production examples with no
possible answer today: *"What subjects should I focus on"*, *"is nursing a stressful job?"*, *"What
if I can't take BS Accountancy"*, *"what do you know?"*, *"How much is tuition"*.

### F6 — Bookkeeping: double rows, no answer kind, test debris

**Severity: MEDIUM. Skews the admin backlog and the coverage numbers.**

- A refused generation produces **two** `ai_requests` rows: the gateway's `SUCCESS` (with the
  discarded text) and the chat's `SKIPPED`. `SELECT status, count(*)` therefore over-reports
  success by every refusal, and the insights coverage numbers are wrong in the flattering
  direction.
- `chat_messages.answer_kind` is NULL on all 58 assistant rows (`appendMessage` hardcodes it),
  so nothing can report which gate answered.
- Five `SMOKE TEST (…)` Q&A entries are live in production and will match Gate 1 verbatim if a
  student ever types their titles.

### F7 — Budget shape

**Severity: informational, but it decides the architecture.**

```
SELECT avg(tokens_used), max(tokens_used) FROM ai_requests WHERE request_type='CHAT' AND status='SUCCESS'
→ 1,636 average · 2,751 max
```

At Workers AI's published rates (25,608 neurons per million input tokens, 75,147 per million
output; FULLPLAN §45), a turn costs roughly 45–65 neurons with the reranker, so the free
10,000/day buys about **150–200 generated turns**. Every turn that ends at Gate 1 or the new Gate 2
costs 0. A prompt that carried "everything" — a 5,000-token brief plus the full catalog — would
cost ~130 neurons per turn and cut the day to ~75 turns, while making an 8B model *worse* at
finding the relevant line. The budget argues for the same thing quality does: send the model a
short, specific context and answer the rest without it.

---

## 3. The design

### 3.1 Three sources of truth, in order

| Source | What it holds | Cost | Who maintains it |
| --- | --- | --- | --- |
| **Student Brief** (new) | Profile, RIASEC scores + bands + Holland code, SCCT scores + bands + index, top matches with score components, which assessments are done | 0 to build (D1 reads); ~450–600 prompt tokens when sent | Computed by code from existing tables |
| **Catalog** (exists) | Colleges, towns, map links, programs, offerings, careers, salary, outlook, RIASEC, program↔career links | 0 (D1 query) | Admin catalog screens, already |
| **Guidance corpus** (new) + admin Q&A (exists) | How scoring works, RIASEC/SCCT meaning, strands, program families and their SHS subjects, licensure, admissions basics, financing, decision-making, school FAQ | Retrieval only; one embed at ingestion | Shipped as seed text in the repo; editable by admin as ordinary knowledge entries |

### 3.2 The gate order after this plan

```
Gate 0  off-domain / distress            → route to a person           0 neurons   (exists)
Gate 1  exact admin Q&A                  → verbatim                    0 neurons   (exists)
Gate 2  catalog + brief lookups          → templated sentence          0 neurons   NEW
Gate 3  RAG over guidance + catalog + Q&A, with the Student Brief
        in the prompt                    → cited paraphrase            ~50 neurons (exists, fixed)
Gate 4  honest refusal + backlog row     → NO_COVERAGE_REPLY           0 neurons   (exists)
```

Gate 2 answers before any embedding happens, and it answers with **complete** results (all seven
BSCS colleges, not the six most similar chunks). The RAG gate keeps every existing guardrail, with
F1 fixed so that an answer grounded in the brief is accepted without a marker.

Web search (`web-search-service.ts`) stays unwired. It needs an external key, answers from
snippets rather than pages, and every question it would help with (tuition, deadlines) is better
answered by the counselor writing one Q&A entry. `general_knowledge_enabled` stays off for the
same reason §29 exists: an uncited paragraph from an 8B model's memory is the thing this system
promises never to show.

### 3.3 Using grades

Grades are already an input (`academicAverage` in `recommendation.ts`). What changes is that the
model gets to *see* them and the components they drive, so it can say *"your academic fit for BS
Civil Engineering is 65 of 100 because your subject average is 84; programs weight that at 20%"*.
Two extensions, both optional and decided by the counselor, not by this plan:

- **More subjects.** The three columns are Math, Science, English. A per-subject table
  (`student_grades`: subject, grade, grade level) would let program families cite the subject that
  matters (Accountancy → Math; Nursing → Science). Costs a migration and a profile form change.
- **Counselor bulk entry.** Six of thirteen profiles have grades. A CSV import on the class roster
  would fill the rest without asking each student.

### 3.4 On "load a huge meta knowledge once at login"

Workers AI has no session memory and no prompt cache: every call is stateless and every prompt
token is billed in neurons. Loading knowledge "once" so the model "already knows everything" is
therefore not something the platform can do — the closest literal version is re-sending a large
prompt on every turn, which F7 rules out on both cost and quality.

What *can* be loaded once, and is what this plan builds:

- **Once per student result** — the Student Brief, computed when recommendations are generated
  and stored as JSON on `assessment_results` (or cached in KV by result id), so a chat turn reads
  one row instead of eight queries.
- **Once per corpus change** — the Guidance corpus, embedded into Vectorize and indexed in FTS5
  by the same sync that already maintains catalog entries, so retrieval brings the six relevant
  passages and the model never sees the other 400.
- **Once at login (frontend)** — the brief and the list of suggested questions can be fetched with
  the student dashboard so the chat opens already knowing the student's state; that is a UX
  preload, not a model preload, and it costs no neurons.

---

## 4. Phases

Each phase ships on its own, is measured against the golden set in §6, and is safe to deploy to
`careerlinkai.online` directly (memory: test against production, not staging).

### Phase 0 — Stop discarding right answers · ~1 day

No new tables. Do first; every later measurement depends on it.

- [ ] **F1.** In `ChatService.generated`, replace *cite-or-refuse* with *cite-or-verify*: when
      `validateCitations` returns `NO_CITATION`, do not refuse; fall through to `unsupportedClaims`
      against `[...chunks, brief]`. Refuse only if a claim fails. Keep `CITATION_OUT_OF_RANGE` as a
      hard refusal (it is invented evidence). `sources` stays empty for an uncited answer.
      Update `test/ai/grounding-contract.test.ts`: the "true answer with no marker" case now
      *passes* when every claim is supported, and a new case pins that an uncited answer with an
      unsupported figure is still refused.
- [ ] **F6a.** One row per turn. When the chat discards a generation, update the gateway's row to
      `FAILED` with the grounding reason (keep `response_text` for the admin's flagged-answer
      review) instead of writing a second `SKIPPED` row. `AiGatewayService` gains
      `markDiscarded(requestId, reason)`. `insights-service.ts` needs no change once the rows are
      honest; verify the coverage numbers move.
- [ ] **F6b.** Write `answer_kind` on every assistant message: `CURATED` for Gate 1, `KNOWLEDGE`
      for a cited generation, `CANNED` for the deterministic and refusal replies. Add `CATALOG` to
      the CHECK constraint in a new migration `0036_answer_kind_catalog.sql` for Phase 2.
- [ ] **F6c.** Archive the five `SMOKE TEST` Q&A entries on production (admin knowledge screen,
      or one `UPDATE knowledge_documents SET archived_at=…` plus the Vectorize delete through
      `archiveAs`). Change the smoke test to archive its own entries in `finally`.
- [ ] Add `HNU`-style aliases to the claim check's haystack: include each college's aliases
      (Phase 2 adds the column) so an expanded or abbreviated name is not an unsupported claim.

**Acceptance:** replay the 58 production questions against a local stub that returns the
previously discarded texts; the CPA, "where to study", "what if I can't", and "schools with my top
1 career" cases are accepted; the invented-fee case is still refused; `ai_requests` has exactly one
row per turn.

### Phase 1 — The Student Brief · ~2 days

- [ ] `backend/src/modules/recommendation/student-brief-service.ts` — `briefFor(studentId)` returns
      a typed object: profile (grade level, strand, the three grades, academic average, which are
      missing), assessments (RIASEC six scores with band labels and Holland code; SCCT three scores
      with bands and the composite index; which of the two are complete), top 5 careers and top 5
      programs each with `matchScore`, `reason`, and **components**, plus college town for programs.
- [ ] Persist components. Migration `0037_recommendation_components.sql` adds
      `recommendations.components TEXT` (JSON); `RecommendationService.generateFor` writes it.
      Regenerate on production once (`POST /student/recommendations/regenerate` per student, or the
      admin re-run) — the engine is deterministic, so scores do not change.
- [ ] `briefToProse(brief)` — the prompt section, written as short labelled sentences, ~450–600
      tokens: *"RIASEC: Investigative 100 (Very High), Artistic 82 (High), … Holland code IAS."*,
      *"SCCT: Self-Efficacy 72 (High) … career-confidence index 60."*, *"Subject grades: Math 88,
      Science 85, English not given; average 86.5."*, then each top match with its components:
      *"1. BS Accountancy at University of Bohol — 79.5. RIASEC fit 71, confidence 60, academic fit
      58, strand aligned, eligibility 100."*
- [ ] `ChatService.userPrompt` sends the brief instead of the ten title lines; `resultsContextFor`
      returns the same prose so `answerableFromResults` and `unsupportedClaims` see the same
      numbers the model saw. Extend `RESULTS_VOCABULARY` with grade, grades, subject, math,
      science, english, average, confidence, self-efficacy, efficacy, outcome, goal, holland, code,
      realistic … conventional, band, high, low.
- [ ] Prompt v2 (`recommendation-chat.v2.ts`): drop *"say so plainly if they ask about their
      results"*; replace with *"The student has completed: [list]. Answer what you can from the
      profile and knowledge context; mention a missing assessment only when the question needs
      it."* Add one rule: *"When explaining a score, name the components from the profile and
      their weights; never invent a component."* Put the scoring weights (§27 constants) in the
      system prompt as a fixed sentence — they are code constants, not per-student data, and they
      are what "why" questions need.
- [ ] `GET /student/brief` (or fold into `/student/dashboard`) so the frontend can show the
      Holland code and suggested questions on load (§3.4 third bullet).

**Acceptance:** *"why bs accountancy where I am artistic"* answers with the components; *"what
subjects should I focus on"* names the student's grades; a student with only RIASEC complete gets
an answer about their Holland code rather than an apology.

### Phase 2 — Gate 2: catalog and brief lookups, zero neurons · ~3 days

`backend/src/modules/ai/catalog-answer-service.ts`, called from `ChatService.answer` between
Gate 1 and generation. A resolver, not a classifier: it tries to bind the question to entities and
an intent; if it cannot bind confidently it returns `null` and the turn proceeds to RAG.

- [ ] **Entity index.** One D1 read per turn (cacheable in KV for an hour): colleges (name,
      aliases, town), canonical programs (name, code, common short forms like "BSIT", "Crim",
      "HRM"), careers (title), towns. Migration `0038_college_aliases.sql`: `colleges.aliases TEXT`
      (JSON list) — seeded for the 22 (HNU, UB, BISU + campus, TPC, MDC, BNSC, BIT, TCC, TMC, BCC,
      PMI, Cristal). Matching: normalised substring and token overlap, longest match wins.
- [ ] **Intents** (regex families over the normalised question, each with a templated answer):
      - `WHERE_IS <college>` → town, province, map link.
      - `PROGRAMS_AT <college>` → the offerings list.
      - `WHO_OFFERS <program> [in <town>|near <town>]` → colleges, grouped by town.
      - `COLLEGES_IN <town>` / `COLLEGES_NEAR <town>` → list; "near me" resolves to the student's
        town if Phase 2b adds it, otherwise asks which town.
      - `CAREERS_AFTER <program>` and `PROGRAMS_FOR <career>` → the link table, both directions.
      - `CAREER_FACT <career> (salary|outlook|riasec|about)` and `COMPARE <career> vs <career>`.
      - Brief intents: `MY_TOP (career|program)`, `MY_SCORES`, `MY_HOLLAND_CODE`, `WHICH_PAYS_BEST`
        (top careers by `salary_max`), `WHICH_NEAR <town>` (top programs filtered by college town),
        `EXPLAIN_SCORE <target>` (components with weights), `WHAT_CAN_YOU_DO`.
- [ ] Templated answers are complete and short; lists over ~12 items are grouped by town or
      truncated with an honest count. Every answer sets `answer_kind='CATALOG'` and
      `sources=['College catalog']` (or `'Your results'`), so the panel can show it and the insights
      screen can count it.
- [ ] Follow-up resolution: if the question has an intent but no entity ("what about their
      location?"), bind to the last entity named in the previous two turns (stored on the message
      row as `entities TEXT` JSON, migration 0038).
- [ ] **2b (optional, small):** `student_profiles.town_id` for "near me"; a one-field profile
      addition using the existing town picker.

**Acceptance:** the F4 questions all answer from Gate 2 with `tokens_used` NULL; the seven BSCS
colleges are listed; *"HNU location"* returns the map link; the golden set's catalog subset is
100% Gate 2.

### Phase 3 — The Guidance corpus · ~3 days writing, 1 day wiring

The "meta knowledge", written once, retrieved per turn. Lives in the repo as
`backend/src/knowledge/guidance/*.md` (one file per topic, front-matter title), synced by the
existing catalog mechanism: `catalog-knowledge-service.ts` grows a `guide` entity type whose
`entityId` is the file slug and whose content hash decides re-embedding. Admins see the entries on
the knowledge screen and may edit or archive them; an edited entry is no longer overwritten by the
sync (flag `managed = 0`, migration 0039).

Topics, each 200–400 words, written for a Grade 11–12 reader, Philippine context, no figures that
change yearly (those belong in admin Q&A):

1. **How your match score is built** — the §27 formula in words, the weights, why a career can rank
   above your top interest (confidence and grades), what "neutral 50/70" means when a field is
   blank.
2. **The six RIASEC types** — one entry each: what the type enjoys, typical activities, catalog
   careers that carry the letter first, how to read a three-letter code.
3. **SCCT in plain words** — self-efficacy, outcome expectations, goal orientation; what a Low band
   suggests and how confidence is built (exposure, small wins, role models).
4. **Strands** — Academic vs Technical-Professional as this system models them, and how
   `recommended_strand` affects a program score (aligned 100, mismatch 40, unknown 70); a mismatch
   is advice, not a bar.
5. **Program families** — one entry per family present in the catalog (Business & Accountancy, IT &
   Computing, Engineering, Education, Health Sciences, Criminology & Public Safety, Hospitality &
   Tourism, Agriculture/Fisheries/Environment, Maritime, Arts & Design, Law & Political Science):
   what you study, the SHS subjects that matter most, licensure or board exam (CPA, LET, PNLE,
   Civil Engineer, Criminologist, Marine Deck/Engine), typical length, who thrives in it.
6. **Choosing between two programs** — trade-offs the data supports: interest fit, confidence,
   grades, location, licensure, demand; how to use "Explain" and the components.
7. **If your first choice is out of reach** — grades below the profile, strand mismatch, no nearby
   college: shifting, bridging, second-choice programs that share careers (from the link table).
8. **Public and private colleges in Bohol** — which catalog colleges are state/municipal (BISU,
   TCC, TMC, BCC, Buenavista CC) and what that generally means for tuition, with the instruction to
   confirm current fees with the school.
9. **Admissions basics** — entrance exams, requirements, when to apply, what a Grade 12 student
   should prepare; generic, with the school-specific facts left to admin Q&A.
10. **Financing** — CHED UniFAST free tuition in SUCs/LUCs, DOST-SEI and CHED scholarship
    families, LGU scholarships; described as programs to ask about, never as amounts.
11. **Working in the field vs working abroad, and demand** — how to read the outlook labels and
    salary bands in this system (monthly, PHP, entry to senior).
12. **What this assistant can and cannot do** — the Gate 1 answer to *"what do you know"*, *"are you
    up"*, *"can you choose for me"*.

- [ ] Seed ~20 admin Q&A pairs for the most repeated production phrasings so Gate 1 catches them
      verbatim (*"whats my top 1 program"* and friends go to Gate 2 instead; these are the
      prose ones: "what do you know", "explain my results", "is nursing stressful", "how much is
      tuition" → the honest generic answer plus "ask your counselor for the figure").
- [ ] Retrieval: add `sourceType` boosting in fusion — a `guide` chunk and a `catalog` chunk both
      in the top six is the normal good outcome for a "why/how" question. Keep `RETRIEVAL_TOP_K`
      at 6; raise `RETRIEVAL_CANDIDATE_K` to 30 to give the reranker the guide chunks.
- [ ] Prompt v2 gains: *"The knowledge context may include general guidance written by the
      school. Apply it to this student's profile; cite it."*

**Acceptance:** *"what subjects should I focus on"*, *"is nursing stressful"*, *"what if I can't
take BS Accountancy"*, *"what does Investigative mean"*, *"how is my score computed"* all answer
from Gate 3 with citations to guide entries; corpus ≈ 300 documents, < 700 chunks (Vectorize free
ceiling is ≈ 6,500).

### Phase 4 — The chat everywhere a student is · ~1.5 days

- [ ] Mount the panel in the student shell (`StudentDashboardPage`, `ResultListPage`,
      `ResultPage`, `AssessmentListPage`), not only `RecommendationPage`. Same conversation, same
      transcript; the drawer already handles narrow layouts.
- [ ] Route: `POST /student/chat` no longer requires recommendations to be useful — it already
      passes `null`; the brief now says what exists.
- [ ] Suggested-question chips from the brief state: nothing done → catalog questions; RIASEC
      only → "What does my Holland code mean?"; both → "Why is X my top match?", "Which of my top
      programs is nearest Ubay?". Chips are Gate 1/2 questions by construction — they steer traffic
      to the free gates.
- [ ] Panel copy: "Explains your scores — it doesn't change them" stays; add the source line back
      only as a small "From: College catalog / Guidance: RIASEC types" under Gate 2/3 answers.

### Phase 5 — Retrieval and language quality · ~2 days

- [ ] Entity-scoped retrieval for RAG: when Gate 2's resolver binds a college/program/career but
      the intent is open ("tell me about", "is it good for me"), pass `entity` to
      `RetrievalService.retrieve` so the catalog passage for that entity is guaranteed in the
      context, and let guide chunks fill the rest.
- [ ] Follow-up rewriting without a model: prepend the last bound entity to the FTS/vector query
      for pronoun questions ("what about its salary").
- [ ] Filipino/Taglish: the open decision in `AiNormalisation.md §6` (bge-m3). Defer until the
      golden set shows Filipino questions failing at the vector half; FTS already catches exact
      terms.

### Phase 6 — Measurement · ~1 day, then ongoing

- [ ] `test/ai/golden-questions.test.ts`: the §6 set, run against the stubbed model, asserting
      **gate** and **must-contain strings** per question. CI-gated.
- [ ] Weekly real-model run against production (a script over `POST /student/chat` with a test
      student), recording gate distribution and neuron spend; target ≥ 60% of turns at zero
      neurons and ≥ 90% non-refusals on the set.
- [ ] `insights-service.ts` gains a gate-distribution report (`answer_kind` counts by day) and a
      neuron-per-day line from `tokens_used`.

---

## 5. Budget after the plan

| Turn type | Share (target) | Neurons |
| --- | --- | --- |
| Gate 0/1/2/4 | ≥ 60% | 0 |
| Gate 3 with brief (≈ 2,000 prompt tokens + 150 output + rerank) | ≤ 40% | ≈ 55–70 |
| Day of 300 turns | | ≈ 7,000–8,500 — inside 10,000 |

Embeddings are cached per question hash in KV (`retrieval-service.ts`), so repeated questions cost
no embed. The Guidance corpus embeds once (~700 chunks × ~300 tokens ≈ 1,300 neurons, one night).

---

## 6. Golden question set (seed)

Taken from production transcripts, each with the gate that should answer it after the plan.

| Question | Gate | Must contain |
| --- | --- | --- |
| Where is Holy Name University located? | 2 | Tagbilaran, map link |
| HNU located | 2 | Tagbilaran |
| What colleges offer BS Computer Science in Bohol | 2 | 7 colleges incl. University of Bohol, BISU Bilar |
| What colleges in Cebu offer BS Computer Science? | 2 | "no colleges in Cebu in this catalog", Bohol list offered |
| what school should i enroll for database administrator career | 2 | BS Information Technology, BS Information Systems |
| schools with my top 1 career | 2 | the student's rank-1 career, its programs, colleges |
| What careers can I take after BS Accountancy at Holy Name University? | 2 | Certified Public Accountant … 5 careers |
| Which of my top three careers pays the best? | 2 | the max salary among the three |
| Whats my top 1 program? | 2 | rank-1 program and college |
| share map location | 2 (follow-up) | map link of the last-named college |
| Why bs accountancy where I am artistic I can take bs architecture | 3 | components, weights, Architecture's offering |
| What subjects should I focus on for these? | 3 | the student's grades, program-family subjects, cited |
| What if I can't take BS Accountancy | 3 | second-choice programs sharing careers, cited |
| is nursing a stressful job? | 3 | Health Sciences guide, cited, no invented figures |
| Explain my results | 3 | Holland code, SCCT bands, top matches |
| what do you know? | 1 | the capabilities answer |
| How much is the tuition fee for BS Civil Engineering? | 1 | public/private note, "ask your counselor for the current figure" |
| my parents will be angry if I dont pick engineering and I am very stressed | 0 | counselor routing |
| do you know what happened to rodrigo roa duterte? | 4 | refusal, no gap button |
| solve x^2 - 4 = 0 | 0 | homework redirect |

---

## 7. Decisions taken, and open ones

**Taken**

- Web search stays unwired; general-knowledge mode stays off (§3.2).
- Citations become *verify-or-cite*, not *cite-or-refuse* (F1). The claim check is the safety
  property; the marker is provenance for the reader.
- Guidance knowledge lives in the repo as versioned text, synced like the catalog, editable by
  admins. It is not a prompt: it is retrieved.
- Score components are persisted, which also unblocks the "Explain" panel showing them.

**Open, for the project owner**

1. Add `student_profiles.town_id` for "near me" (Phase 2b)? Recommendation: yes, one field.
2. Per-subject grades and counselor CSV import (§3.3)? Recommendation: defer until the three
   grades are filled for most students; the brief already surfaces what exists.
3. Who writes and reviews the Guidance corpus text? The drafts can be generated in the repo, but
   a counselor should read every entry before it is synced to production — it will be cited to
   students as "the school's guidance materials".
4. bge-m3 for Filipino (Phase 5) — measure first.
