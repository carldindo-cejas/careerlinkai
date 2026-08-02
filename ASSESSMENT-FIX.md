# ASSESSMENT-FIX — Assessment Builder Defect Audit & Remediation Plan

**Date:** 2026-08-01
**Scope:** the assessment authoring surface — template → dimensions → version → questions →
mapping confirmation → publish.
**Trigger:** a reproducible `422` on every "Add question" click, reported from the browser as
`Failed to load resource: the server responded with a status of 422 ()`.
**Status:** **remediated and deployed** (2026-08-02). Phases 1–4 shipped; the open decision was taken
as Option A, as recommended. See *Remediation — what shipped* at the foot of this file for the
change list, the production verification, and the two things deliberately left alone.

The audit body below is left exactly as written. It is the evidence, and it stays re-verifiable
against the commit that preceded the fix.

The audit was a read-only sweep of the builder's write paths on both sides of the wire. Findings
are ordered by severity. Each carries the evidence that establishes it rather than a description of
it, because the point of this file is that someone else can re-verify every entry without redoing
the search.

---

## 1. The reported 422 — root cause

**Severity: CRITICAL. 100% reproducible, blocks the primary authoring flow entirely.**

`handleAdd` inserts a deliberately blank question stub:

`frontend/src/features/assessment-builder/components/QuestionWorkspace.tsx:143`

```ts
question_text: '',
```

The server's write schema refuses it:

`backend/src/modules/assessment/schemas.ts:308`

```ts
question_text: z.string().trim().min(1).max(1000),
```

Both entry points are affected — the navigator's "Add" button and `EmptyWorkspace`'s "Add the first
question" call the same `handleAdd`. There is no path through the manual editor that does not hit
this.

**The real defect is not the empty string, it is the disagreement.** The builder's UX is
insert-a-stub-then-autosave-into-it (`QuestionWorkspace.tsx:139–154`, `useQuestionAutosave.ts`),
which requires a blank draft question to be a legal server state. The schema was written on the
opposite assumption — that a question is only ever created complete. The two halves were built to
different contracts and never exercised against each other.

**Why CI did not catch it.** Neither side tests the real path:

* `frontend/src/features/assessment-builder/components/QuestionWorkspace.test.tsx` mocks the API, so
  the blank payload is never validated by anything.
* `backend/test/assessment/builder.test.ts` sends non-empty `question_text` in every case
  (lines 130, 139, 242, 289, 312, 417).

A contract test spanning the two would have failed on the first run. Phase 4 exists for this.

---

## 2. Clearing a question's text 422s, and then poisons the autosave queue

**Severity: HIGH.**

Same `.min(1)` on the update path — `backend/src/modules/assessment/schemas.ts:349`. An author who
selects the question text and deletes it triggers
`patch({ question_text: '' })` (`QuestionWorkspace.tsx:620–623`), which 422s.

The consequence outlives the request. On failure the patch is merged back into the pending queue:

`frontend/src/features/assessment-builder/hooks/useQuestionAutosave.ts:99`

```ts
pending.current = { ...patch, ...(pending.current ?? {}) };
```

so the doomed `question_text: ''` rides along with every subsequent save and re-fails, until the
author happens to type text into that same field (a newer value merges over it and wins). Until
then every edit to *any other* field on that question also fails.

The banner shown during this is actively misleading —
`QuestionWorkspace.tsx:578–583` tells the author "your change is still here and will be retried on
the next edit — do not retype it", when retyping is in fact the only thing that clears the jam.

---

## 3. Publish admits an assessment that measures nothing

**Severity: HIGH. Silent bad data — no error is raised at any point, including to the student.**

The publish gate checks only that *existing* mappings are confirmed:

`backend/src/modules/assessment/assessment-builder-service.ts:1061`

```ts
if (readiness.remaining > 0) { ... }
```

`publishReadiness` (`:999–1013`) counts rows in `question_dimensions`. A version whose questions
carry no mappings at all yields `total = 0`, `confirmed = 0`, `remaining = 0` — the gate passes.
Combined with the `questions.total >= 1` check at `:1050`, a version of entirely unmapped questions
publishes cleanly.

Downstream, the scoring engine handles this without complaint: with no dimension accumulating a
non-zero `max`, every dimension is skipped (`backend/src/lib/scoring.ts:126–129`) and the result is
`{ dimensionScores: [], resultCode: null, overallSummary: null }` (`scoring.ts:95–97`). That is
correct behaviour for a genuinely reflection-only instrument, and exactly wrong as the outcome of an
author who simply forgot to map their items — the two are indistinguishable from the outside.

**This is the default path, not an edge case.** New questions are created with no mapping by
deliberate design (`QuestionWorkspace.tsx:146–148`: "an item that measures nothing is a legitimate
state while it is being written"). That reasoning is right for a draft; nothing downstream ever
revisits it before publish.

---

## 4. `order_number` is computed two different ways, and neither is concurrency-safe

**Severity: MEDIUM.**

The bulk-add route positions questions with `COUNT + 1`:

`backend/src/modules/assessment/builder-routes.ts:571`

```ts
orderNumber: existingCount + index + 1,
```

`duplicateQuestion` uses `MAX + 1` via `nextOrderNumber`
(`assessment-builder-service.ts:1343`, `:1453–1460`) — whose own doc comment states why `COUNT` is
the wrong choice:

> `MAX + 1` rather than `COUNT + 1`, which are the same number only while the numbering is gapless.
> […] a count would produce a *collision* the day anything did leave a hole.

`deleteQuestion` currently keeps the numbering gapless (`:1371–1386`), so the two agree today. That
is a coincidence the route is relying on without saying so.

Independently, two concurrent adds to the same version both read the same `existingCount` and write
the same `order_number`. There is no unique constraint on `(assessment_version_id, order_number)` to
catch it — `backend/migrations/0005_assessment.sql:134–138` declares only plain indexes. The
symptom is an arbitrary render order, not an error.

---

## 5. "Add" gives no visible feedback

**Severity: MEDIUM (UX). Compounds §1 — the two together are what the bug report describes.**

`handleAdd` (`QuestionWorkspace.tsx:139–154`) never selects the question it just created. The
selection effect at `:125–135` only intervenes when the current selection is *absent or invalid*, so
with question 1 already open, adding question 2 leaves the editor on question 1. The new item
appears at the bottom of the navigator, possibly below the fold, and the author's cursor is nowhere
near it.

---

## 6. Duplicate option values are permitted at every layer

**Severity: MEDIUM.**

`question_options` has no unique index on `(question_id, value)` —
`backend/migrations/0005_assessment.sql:140–152` — and neither write schema checks for duplicates
(`schemas.ts:312–322`, `:353–365`).

The client actively produces collisions: `addOption` derives the new value from the array length,

`QuestionWorkspace.tsx:503`

```ts
{ label: `Option ${options.length + 1}`, value: String(options.length + 1), score: 0 }
```

so removing option 2 of 3 and then adding one yields two options with `value = "3"`. Stored answers
reference `selected_option_id`, so scoring itself is unaffected — but `value` is the author-facing
and export-facing identity of an option, and duplicates there are silently ambiguous.

---

## 7. `deleteQuestion` writes no audit row

**Severity: LOW (compliance/traceability).**

`assessment-builder-service.ts:1371` — the method takes no `user` and calls no `this.audit.write`.
Every sibling mutator (create, update, publish, confirm) audits. Deleting a question from a draft is
a real authoring act by an identifiable person and currently leaves no trace.

---

## 8. Option-count ceiling is inconsistent between the two write paths

**Severity: LOW.**

`updateQuestionSchema.options` caps the array at 20 (`schemas.ts:364`); `addQuestionsSchema.options`
declares only `.min(2)` with no ceiling (`schemas.ts:322`). Bulk-add therefore accepts an unbounded
option list that the editor could never subsequently save.

---

## Open decision — blocks Phase 1

**May a DRAFT question have empty text?** §1 and §2 are the same disagreement seen from two
directions, and they have to be resolved together.

**Option A — allow blank in drafts, enforce at publish.** Relax `.min(1)` to `.max(1000)` on both
schemas; add "every question must have text" to the publish gate.
*For:* fixes §1 and §2 with one change; matches the builder's actual stub-then-autosave UX; matches
how comparable form builders behave. *Against:* moves a validation from write-time to publish-time,
so the failure surfaces later.

**Option B — seed placeholder text.** Send `'Untitled question'` instead of `''`; leave validation
strict.
*For:* a one-line change. *Against:* the author must clear the placeholder on every new question,
and §2 survives untouched — clearing the text still 422s.

**Recommendation: A.** B fixes the symptom in §1 and leaves the underlying contract disagreement in
place, which is what §2 is.

---

## Remediation plan

### Phase 1 — unblock authoring (§1, §2, §5)

1. Relax `question_text` to `.max(1000)` (no `.min`) in `addQuestionsSchema` and
   `updateQuestionSchema`, per the Option A decision above.
2. Add a publish-time check that every question has non-empty text, returning a `422` that names the
   offending `order_number`s.
3. Select the newly created question in `handleAdd`, so adding one moves the editor to it.

**Exit criteria:** adding a question from both entry points succeeds against the real API; clearing
and retyping question text never 422s; publishing a version with a blank question is refused with a
message naming it.

### Phase 2 — data integrity (§3, §4, §6)

4. Extend the publish gate to refuse questions with zero dimension mappings, listing them. See the
   migration note below.
5. Switch the bulk-add route to `nextOrderNumber` (`MAX + 1`) so there is one positioning rule, and
   add a unique index on `(assessment_version_id, order_number)`.
6. Add a unique index on `question_options (question_id, value)`, reject duplicates in both write
   schemas, and derive new option values from the highest existing value rather than array length.

**Exit criteria:** an unmapped-question version cannot publish; concurrent adds cannot collide;
duplicate option values are refused by the database, not only by the client.

### Phase 3 — hardening (§7, §8)

7. Pass `user` into `deleteQuestion` and write an audit row.
8. Add `.max(20)` to `addQuestionsSchema.options`.

### Phase 4 — close the test gap that hid §1

9. Backend integration test: POST a blank question to
   `/assessment-versions/{id}/questions` and assert the agreed behaviour.
10. Replace the mocked API in `QuestionWorkspace.test.tsx` for the add path with the real request
    schema, so a client payload the server would reject fails CI.

This phase is the one that matters beyond the individual bugs. Every defect in §1–§3 is a
disagreement between two layers that are each individually well-tested; nothing in the suite
currently asserts that they agree.

---

## Migration note — existing published versions

The Phase 2.4 gate refuses assessments that publish cleanly today. Already-published versions are
frozen by invariant 1 and are unaffected by the change; they will simply continue to score nothing.

**Undecided:** whether to ship an audit query reporting which published versions have unmapped
questions, so those instruments can be identified and re-authored as new versions. Nothing here
changes existing rows either way — this is a question of whether we go looking.

---

## Verification method

Every finding above was established by reading the code paths, not by inference:

* Client write payloads — `QuestionWorkspace.tsx`, `useQuestionAutosave.ts`, `useBuilder.ts`,
  `builderApi.ts`
* Server contracts — `schemas.ts`, `builder-routes.ts`
* Invariant enforcement — `assessment-builder-service.ts`
* Downstream consequence — `backend/src/lib/scoring.ts`
* Storage constraints — `backend/migrations/0005_assessment.sql`
* Coverage claims — `backend/test/assessment/builder.test.ts`,
  `frontend/src/features/assessment-builder/components/QuestionWorkspace.test.tsx`

---

## Remediation — what shipped (2026-08-02)

**The open decision was taken as Option A.** `question_text` accepts the empty string on both write
paths; publish refuses it instead, naming the offending `order_number`s.

### Phase 1 — authoring unblocked (§1, §2, §5)

* `schemas.ts` — `question_text` is `.trim().max(1000)` on `addQuestionsSchema` and
  `updateQuestionSchema`. The option array is now **one shared declaration** read by both, which is
  also §8: the add path had no ceiling while the update path capped at 20.
* `assessment-builder-service.ts` — `assertEveryQuestionIsFinished`, called from `publish`.
* `QuestionWorkspace.tsx` / `useBuilder.ts` — `handleAdd` selects the question it just created. The
  add and duplicate mutations now **return** their invalidation promise, so `mutateAsync` resolves
  with the new row already in the cache; selecting an id the cache does not hold yet trips the
  keep-a-valid-selection effect and snaps the editor back, which is the §5 symptom with extra steps.

### Phase 2 — data integrity (§3, §4, §6)

* The publish gate refuses questions with no dimension mapping — **unless the template has no
  dimensions at all**, which is an ungraded survey and a legitimate thing to publish. That exception
  is what the old gate could not express, and it is why an unmapped item and a reflection instrument
  used to be indistinguishable.
* **Positioning moved into `addQuestions`** rather than being switched from `COUNT + 1` to
  `MAX + 1` in the route. There was a *third* rule the audit did not catch: the §31 generation job
  numbered from 1 regardless of what the version already held, so drafting with AI into a
  hand-started version produced two questions claiming position 1, every time. `CreateQuestionInput`
  no longer carries `orderNumber`, so no caller can hold it wrong.
* Migration `0021` — unique on `(assessment_version_id, order_number)` and on
  `question_options (question_id, value)`. **Both renumbering paths had to be rewritten first**:
  SQLite enforces a unique index per row as it is written, so `reorderQuestions` and
  `deleteQuestion` now park the affected rows on negative numbers and flip them back inside the same
  batch. Shipping the index against the old code would have broken every drag and every delete.
* `addOption` derives the new value from the highest value in use; a label edit that would duplicate
  another option's key leaves that option's key alone.

### Phase 3 — hardening (§7, §8)

* `deleteQuestion` takes a `user` and writes `ASSESSMENT_QUESTION_DELETED`, carrying the text that
  was removed. §8 was absorbed into the shared option schema above.

### Phase 4 — the test gap

`contracts/assessment-builder.ts` at the repository root holds the add-question payload **once**.
The frontend suite asserts the workspace sends exactly it; the backend suite POSTs exactly it
through the real HTTP surface. Neither assertion is worth much alone — together, a client payload
the server would reject cannot pass CI, whichever side changes first.

### Verified

Backend 936 tests / 72 files, frontend 197 / 23, lint, both type-checks, `gate:platform`,
`gate:bundle` — all green. Then, against **live production** (`careerlinkai.online`, a temporary
counselor and a private CUSTOM template, both deleted afterwards): 19/19 checks, including the
reported 422 now answering **201**, clearing question text answering 200, both publish refusals
naming "Question 1", and drag-reorder and delete still working under the new unique index.

**Deploy order was code first, then migration** — the reverse of the runbook's default, deliberately:
this migration is a constraint the *previously deployed* Worker violates, so applying it first would
have left a window in which a drag or a delete on production could fail. A verified backup was taken
first (`.backups/CareerLinkAI_Main-production-2026-08-02T02-33-20Z.sql`, Time Travel bookmark
`0000003e-00000000-000050bb-4502ad49a44a5bf4409b1a7456ccf785`).

### Answered: the migration note's undecided question

Run against production after the deploy — **zero published versions hold an unmapped question on a
template that has dimensions.** Nothing needs re-authoring; the query is recorded here rather than
shipped as a tool, since it is a one-liner and the gate now prevents new cases:

```sql
SELECT v.id, t.title, COUNT(*) AS unmapped
  FROM assessment_questions q
  JOIN assessment_versions v ON v.id = q.assessment_version_id
  JOIN assessment_templates t ON t.id = v.assessment_template_id
 WHERE v.status = 'PUBLISHED'
   AND NOT EXISTS (SELECT 1 FROM question_dimensions qd WHERE qd.question_id = q.id)
   AND EXISTS (SELECT 1 FROM assessment_dimensions d WHERE d.assessment_template_id = t.id)
 GROUP BY v.id, t.title;
```

### Deliberately not done

* **The auto-save banner's wording (§2) is unchanged.** It is accurate again now that the failure it
  described cannot happen: a rejected patch is re-queued for a *transient* failure, which is what
  "will be retried on the next edit" means. Making the queue drop a patch the server rejected as
  invalid is a change to retry semantics with its own failure modes, and no remediation item asked
  for it.
* **`question_options.order_number` still comes from each caller.** It is the same shape of
  duplication as `order_number` on questions, but nothing depends on it being unique and no finding
  reported it; it was left out to keep this diff on the defects that were actually established.
