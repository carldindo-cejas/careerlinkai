# IMPLEMENTATION BRIEF — CareerLinkAI knowledge grounding layer

> **How to use this file:** drop it in the repo and hand it to Claude Code.
> It is self-contained — it assumes no prior conversation. Work top to bottom.
> Stop and ask before doing anything in **§10 Guardrails**.

---

## 1. Mission

The student-facing assistant refuses questions it already has the data to answer.
Fix that by injecting a structured index of the college/program/career graph into
the chat prompt, with a **career → program → college reverse map** and an alias
table.

This is a grounding/plumbing change. **It does not touch scoring.**

---

## 2. The bug — this is your acceptance test

A student asked, in the "Ask about my results" panel:

> **"where to study certified public accountant"**
> **"what programs to become a certified public accountant"**

Both were refused with *"I don't have anything in the school's guidance materials
that answers that."*

The answer is in D1 right now:

```
Certified Public Accountant → BS Accountancy → Holy Name University
                                             → University of Bohol
```

**Three root causes, all must be fixed:**

| # | Cause | Fix |
|---|---|---|
| 2.1 | The chat prompt never receives the college/program/career graph. It is scoped to explaining assessment results only. | §7 — inject the index |
| 2.2 | Data is stored `program → careers`. The student asked `career → programs`. An LLM will not reliably invert 217 edges buried in prose. | §5 — materialise the reverse map |
| 2.3 | No alias resolution. Students type `CPA`, `accountant`, `pulis`, `maging seaman` — none match a stored name. | §6 — alias table |

**Definition of done:** both questions above return the two colleges, with no
code changes between them, and the same works for `CPA`, `accountant`, and
`unsaon pag-accountant`.

---

## 3. Verified dataset facts

Snapshot of `CareerLinkAI_Main` (Cloudflare D1), 2026-09-12. Use these as
assertions in tests — if your build produces different numbers, investigate
before proceeding.

| Metric | Value |
|---|---:|
| Colleges | 22 |
| Distinct programs | 41 |
| Program offerings (college × program rows) | 126 |
| Distinct careers | 108 |
| **Distinct `program → career` edges** | **217** |
| Offering-level links (126 offerings × their careers) | 720 |

> ⚠️ The figure "720" appears in older extracts as "program ↔ career links". It is
> **offering-level** — it multiplies each program's career list by the number of
> colleges offering it. The real knowledge graph has **217** distinct edges.
> Build the index from the 217, never the 720, or every career's program list
> will contain duplicates.

Most widely offered programs (they will absorb the most questions):
BSIT (12 colleges), BEED (12), BSBA (10), BSED (10), BSHM (10).

---

## 4. Step 0 — verify schema before writing anything

Do not assume the table names below. Inspect first:

```bash
npx wrangler d1 execute CareerLinkAI_Main --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Then dump the columns of whatever holds colleges, programs, careers and the join
tables. **Report what you find before continuing.** The rest of this brief uses
these placeholder names — map them to reality:

```
colleges(id, name, town, map_url, …)
programs(id, code, name, …)                     -- `code` already exists: BSA, BSIT…
college_programs(college_id, program_id, listed_as)   -- the 126 offerings
careers(id, name, salary_min, salary_max, outlook, riasec, …)
program_careers(program_id, career_id)          -- the 217 edges
```

---

## 5. Task A — the index generator

**File:** `scripts/build-index.ts`

### 5.1 Identifiers — read this before choosing codes

Do **not** derive codes from name initials. A trial run on this exact dataset
produced 14 collisions, and the colliding pairs are semantically confusable:

```
Civil Engineer ↔ Computer Engineer
Maintenance Engineer ↔ Marine Engineer ↔ Mechanical Engineer
Industrial Designer ↔ Interior Designer
Electrical Technician ↔ Electronics Technician
Data Analyst ↔ Database Administrator
Marine Surveyor ↔ Marketing Specialist
```

If the model resolves `ME` to the wrong engineer, a student gets sent to the
wrong program. Instead:

- **Programs** — use the existing `programs.code` column (`BSA`, `BSIT`, …).
- **Colleges and careers** — add a stored `slug` column. Migration:

```sql
ALTER TABLE colleges ADD COLUMN slug TEXT;
ALTER TABLE careers  ADD COLUMN slug TEXT;
UPDATE colleges SET slug = /* kebab-case of name, campus included */;
UPDATE careers  SET slug = /* kebab-case of name */;
CREATE UNIQUE INDEX idx_colleges_slug ON colleges(slug);
CREATE UNIQUE INDEX idx_careers_slug  ON careers(slug);
```

Slugs like `certified-public-accountant` and `holy-name-university` cost roughly
1.5 K more tokens across the whole index and remove the entire confusion class.
Worth it.

### 5.2 Output format

Pipe-delimited inside fenced blocks. **Not Markdown tables** — tables cost ~3×
the tokens for identical content.

Emit to `kb-source/05-index.md`:

````markdown
# §5 MASTER INDEX

Generated from CareerLinkAI_Main (Cloudflare D1). Do not edit by hand.
Every college, program and career the system knows about is listed here.
If something is not in this section, it is not in the system — check §10
before telling a student it does not exist.

Format is pipe-delimited. CLG = colleges, CAR = careers, PROG = programs.

## 5.1 COLLEGES (22)

`slug|name|town`

```
batuan-college|Batuan College|Batuan
holy-name-university|Holy Name University|Tagbilaran City
university-of-bohol|University of Bohol|Tagbilaran City
…
```

## 5.2 PROGRAMS (41)

`code|name|CLG:where offered|CAR:careers it leads to`

```
BSA|BS Accountancy|CLG:holy-name-university,university-of-bohol|CAR:certified-public-accountant,chief-financial-officer,financial-analyst,internal-auditor,tax-advisory-specialist
…
```

## 5.3 CAREERS — REVERSE MAP (108)

Use this when a student names a JOB rather than a program
("where do I study to be a CPA", "how do I become a seaman").
CLG is pre-resolved: it already lists every college where you can take a
program leading to this career, so you never need to join manually.

`slug|name|monthly PHP|outlook|RIASEC|PROG:programs|CLG:colleges`

```
certified-public-accountant|Certified Public Accountant|32k-150k|High|CEI|PROG:BSA|CLG:holy-name-university,university-of-bohol
software-developer|Software Developer|30k-140k|High|IEC|PROG:BSCPE,BSCS,BSIS,BSIT|CLG:…
…
```
````

**The pre-resolved `CLG:` on career rows is the single most important field in
this file.** It collapses the career → program → college join into a lookup, and
that join is where the assistant currently gives up.

Outlook abbreviations: `High Demand`→`High`, `Moderate Demand`→`Mod`,
`Emerging Field`→`Emerging`. Salary as `32k-150k`.

### 5.3 Size budget

The derived-code version of this file measured **15.7 KB ≈ 3.9 K tokens**. With
slugs, expect **~5.5 K tokens**. Fail the build above **8 K**.

### 5.4 Also emit `kb-source/10-gaps.md`

Programs students ask about that **no college in the dataset offers**. Verified
absent as of the snapshot:

> Medicine, Dentistry, Veterinary Medicine, Medical Technology / Medical
> Laboratory Science, Radiologic Technology, Aviation, Culinary Arts, Social
> Work, Customs Administration, Communication / Mass Communication.

For each, write an honest redirect instead of a refusal:

```
BS Medical Technology — not offered by any college in our Bohol database.
Closest local starts: BS Nursing (holy-name-university, mater-dei-college),
BS Pharmacy (university-of-bohol). Students set on MedTech usually go to Cebu.
Suggest talking to the guidance counselor about transferring.
```

Regenerate this section on every build so it can never claim something is absent
that a counselor just added.

---

## 6. Task B — the alias table

**File:** `kb-source/aliases.yml`, loaded into §5.4 of the index.

Students in Bohol do not type stored English names. Seed it:

```yaml
certified-public-accountant: [cpa, accountant, accounting, accountancy, maging accountant, unsaon pag-accountant]
police-officer:              [pulis, police, pnp, kapulisan, maging pulis]
registered-nurse:            [nurse, nars, nursing, maging nurse]
lawyer:                      [abogado, abugado, attorney, law, maging abogado]
deck-officer:                [seaman, marino, seafarer, barko, maging seaman, ship officer]
software-developer:          [programmer, coder, software engineer, web developer, app developer, dev]
elementary-school-teacher:   [teacher, guro, maestra, maestro, titser, magtutudlo, elementary teacher]
civil-engineer:              [civil engineering, ce, engineer sa building]
architect:                   [arkitekto, architecture]
midwife:                     [komadrona, mananabang, midwifery]
entrepreneur:                [negosyante, business owner, tig-negosyo, magnegosyo]
```

### 6.1 Hard rule — alias uniqueness

**Every alias must resolve to exactly one entity. Ambiguous aliases fail the
build.** If `accountant` maps to both Certified Public Accountant and Internal
Auditor, the model picks arbitrarily and answers stop being reproducible — which
is a thesis problem, not just a UX one.

Where a term genuinely spans several careers, do not alias it. Add a
disambiguation line instead:

```
engineer → ambiguous. Ask which field: civil, electrical, mechanical,
computer, marine, or agricultural-and-biosystems.
```

### 6.2 Counselor extensibility

The UI already has a *"Requested — your school has been asked to answer this"*
queue. Wire it to this table: an unanswered question should let a counselor add
an alias or a KB entry, so the same question is answered next time. Close that
loop — it turns a dead end into a content pipeline.

---

## 7. Task C — the Worker loader and prompt assembly

**File:** `src/lib/kb.ts`

### 7.1 Cache layers

```
module scope (warm isolate, ~0ms)
   └─ miss → Workers KV / Cache API (~5-10ms, survives cold start)
        └─ miss → R2: careerlink-kb/v{N}/pack.md (~20-40ms, rare)
```

```ts
let PACK: string | null = null;

export async function loadPack(env: Env): Promise<string> {
  if (PACK) return PACK;
  const cached = await env.KB_KV.get('kb:current');
  if (cached) return (PACK = cached);
  const obj = await env.KB_BUCKET.get('careerlink-kb/current/pack.md');
  if (!obj) throw new Error('KB pack missing from R2');
  const text = await obj.text();
  await env.KB_KV.put('kb:current', text, { expirationTtl: 86400 });
  return (PACK = text);
}
```

### 7.2 Prompt shape — order matters

The pack must sit in a **stable prefix** so the provider's prompt cache can hit.
Anything that varies per student goes *after* it.

```
[system] §0 operating instructions   ← static
[system] §5 index (+ aliases)        ← static, mark CACHEABLE
[system] §10 gap register            ← static
─────────────────────────────────── cache boundary
[system] this student's results      ← varies
[user]   the question                ← varies
```

Putting the student's scores before the pack silently destroys the cache hit
rate. Assert the ordering in a test.

### 7.3 Do NOT cache the pack in localStorage

A previous plan called for holding the pack in the browser and posting it back
per message. Reject that:

1. The prompt is assembled server-side — the browser never builds it.
2. `localStorage` is student-editable. A student with DevTools could rewrite the
   grounding data that drives their own recommendations. For a system advising
   minors on education, that is not acceptable.

A small (~30 KB) JSON index in the client for autocomplete and the program
browser is fine — it must never round-trip into a prompt.

---

## 8. Task D — §0 operating instructions

**File:** `kb-source/00-instructions.md`. This is content, not code — use it as
written, adjusting only to match house voice.

```markdown
# §0 OPERATING INSTRUCTIONS

## Scope
You explain a student's assessment results AND answer questions about the
programs, careers, and colleges in §5. You never change, recompute, or override
a score. If a student disputes a score, explain how it was derived and refer
them to their guidance counselor.

## Grounding
Recommend only programs, careers, and colleges present in §5. Never invent a
college, program, salary figure, or board-exam requirement.

## Query direction — IMPORTANT
Students name jobs as often as they name programs. Before concluding you do not
know something:
  1. Check §5.3 (careers) — they may have named a job.
  2. Check §5.4 (aliases) — they may have used a nickname or a local term.
  3. Check §5.2 (programs) — they may have named a degree.
  4. Check §10 (gaps) — it may be a real program nobody local offers, which has
     a useful answer that is not "I don't know".
Only after all four may you say you do not have it.

## Audience
Filipino senior-high students, roughly 16-18, in Bohol. Plain language. Define
jargon on first use. Never condescend.

## Language
Answer in the language of the question — English, Tagalog, or Cebuano/Boholano.
Match register, not just vocabulary.

## Honesty
Salary ranges are indicative, not promises. Outlook labels are this project's
estimates, not government forecasts. Say so when it bears on a decision.

## Autonomy
Present options and trade-offs. Never tell a student what they should become.
Never describe a program as beneath them or as a bad choice.

## Money and family
Students raise cost and parental pressure constantly. Treat both as real
constraints. Give information, not verdicts.

## Refusing
Only when §5 and §10 genuinely do not cover it. Then name what specifically is
missing, offer the nearest thing you do have, and escalate. Never a bare
"I don't know".

## Always escalate to a human
Mental health, family conflict, financial distress, or anything where the
student needs a person rather than a chatbot.
```

---

## 9. Acceptance criteria

Write these as tests. All must pass.

**Build-time**

- [ ] Index reports exactly 22 colleges, 41 programs, 108 careers, 217 edges
- [ ] Every code/slug in the file is globally unique across all three entity types
- [ ] Every `PROG:` value exists in §5.2; every `CLG:` exists in §5.1
- [ ] Every career's `CLG:` equals the union of its programs' colleges
- [ ] Every alias resolves to exactly one entity — ambiguity fails the build
- [ ] Index token count under 8 K
- [ ] No college named anywhere in the pack that is absent from §5.1

**Behavioural** — run against the real endpoint

- [ ] "where to study certified public accountant" → Holy Name University, University of Bohol
- [ ] "what programs to become a certified public accountant" → BS Accountancy
- [ ] "how do I become a CPA" → same answer
- [ ] "unsaon pag-accountant" → same answer, Cebuano reply
- [ ] "how do I become a software developer" → all four routes (BSCS, BSIT, BSCPE, BSIS)
- [ ] "I want to be a doctor" → gap-register redirect, not a bare refusal
- [ ] "how do I become an engineer" → disambiguation question, not an arbitrary pick
- [ ] A genuinely unknown question still triggers the "Requested" escalation

**Caching**

- [ ] Second message in a session reports a prompt-cache hit
- [ ] Student-specific content appears strictly after the pack in the assembled prompt

---

## 10. Guardrails — stop and ask before any of these

- **Do not modify scoring, assessment, or recommendation-ranking code.** This
  change is read-only with respect to the scoring pipeline. The project's core
  invariant — no assessment version publishes while a question-dimension mapping
  has an unconfirmed `confirmed_at` — must be untouched.
- **Do not hand-edit `05-index.md` or `10-gaps.md`.** They are generated. Fix the
  generator.
- **Do not overwrite an R2 pack version.** Write `v{N+1}` and repoint `current`,
  so rollback is a config change.
- **Do not invent data to fill a gap.** If a program's board exam or tuition is
  unknown, leave it out. A missing field is recoverable; a fabricated one that
  reaches a student choosing a degree is not.
- **Do not widen chat scope beyond programs/careers/colleges** without asking.

---

## 11. Build order

| Step | Work | Fixes | Est. |
|---|---|---|---|
| 1 | §4 schema inspection + slug migration | — | 0.5 d |
| 2 | §5 `build-index.ts` → `05-index.md` | the reverse map | 1 d |
| 3 | §6 `aliases.yml` + uniqueness gate | nickname queries | 0.5 d |
| 4 | §8 `00-instructions.md` | refusal behaviour | 0.5 d |
| 5 | §7 loader + prompt assembly + wire into chat | **the screenshot** | 1 d |
| 6 | §5.4 `10-gaps.md` | not-offered programs | 0.5 d |
| 7 | §9 test suite | regression safety | 1 d |

Roughly one week. The deep-dive content (per-program and per-career narrative,
~35 K tokens) is a separate, later effort — it is not needed to fix the bug.
