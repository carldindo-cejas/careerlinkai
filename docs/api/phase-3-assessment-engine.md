# Phase 3 — Assessment Engine (API contract)

Tracks **FULLPLAN v1.2 §20, §21, §22, §23, §24, §25, §37**.
Everything is under `/api/v1`, uses the §19 envelopes, and requires bearer-token auth + `active`.

> **v1.3 note:** this contract was built and verified on the pre-v1.3 Laravel backend. The HTTP
> contract is unchanged by the v1.3 platform move and is exactly what the Phase 3.5 Worker port
> must reproduce. Framework-specific notes below (Sanctum middleware, PHP policy method names)
> describe the retired implementation — read them as the behavior to preserve, not the mechanism
> to keep.

---

## The four invariants this module rests on

Everything below is a consequence of one of these. They are worth reading before the endpoint
list, because the endpoints look arbitrary without them.

| # | Invariant | Where it lives | Why |
|---|---|---|---|
| 1 | **A published version is frozen forever** — it, and every question, option and mapping under it | `AssessmentBuilderService` (§21) | An attempt taken under version *N* must keep meaning what it meant. Fix a mistake by publishing *N+1*. |
| 2 | **Dimensions freeze once any version of their template has published** | `AssessmentBuilderService` (§12, §25, v1.2) | Dimensions hang off the *template*, so invariant 1 does not cover them. Renaming "Investigative", or sliding a band from 67 to 60, would rewrite results already delivered. |
| 3 | **No version publishes while any `question_dimensions.confirmed_at IS NULL`** | `AssessmentBuilderService::publish()` (§25) | The confirmation gate. It guards *what a question measures*, which is the thing AI could change invisibly. |
| 4 | **"Latest result" always resolves to a `SCORED` attempt** | `AttemptStatus`, the partial unique index (§21) | One live attempt per assignment per student; a retake expires the old one and keeps it as history. |

**Scoring is inline, not queued** (§24). It is fast, deterministic, and the student is on the
screen waiting. Only the *downstream* recommendation and AI steps are queued (Part XI).

---

## Student — `/student` (role: `student` only)

An admin cannot reach these. Every route means *mine*, resolved from the token — there is no
student id in any URL. Reading someone else's assessment data (§40) goes through the counselor
endpoints, which authorize against `AssessmentPolicy` and name a student explicitly.

### Profile (§37) — the input to Part VII

| Method | Path | Notes |
|---|---|---|
| `GET` | `/student/profile` | Includes `is_complete_for_recommendations` and `missing_for_recommendations` |
| `PATCH` | `/student/profile` | Partial. Every field `sometimes` |

Assigned to Phase 3 in v1.2 because **Part VII consumes these fields and no phase previously owned
them** (§57). `strand` and `gwa` are the two §27 cannot do without.

`gwa` and the subject grades are bounded **60–100**. This is real validation, not decoration: §27
*scores* a GWA rather than sanity-checking it, so a typo'd `9.2` would be fed to the engine and
would quietly wreck the recommendation. This endpoint is the only place that can catch it.

`strand` is the strict two-value enum (§13.1, v1.2): `Academic` | `Technical-Professional`. "STEM"
is a *track* within Academic and is rejected — §27 is built on exactly two branches, and offering
four options that map down to two would be a lie about what the engine can tell apart.

`first_name` / `last_name` are **not editable**. They belong to the counselor's roster (§16); a
student renaming themselves would break the roster that was confirmed for them.

### The player (§37)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/student/assignments` | Active assignments in my active enrollments, each with **my** attempt |
| `POST` | `/student/assignments/{assignment}/start` | **Idempotent** — returns the existing live attempt if there is one |
| `GET` | `/student/attempts/{attempt}` | Questions in order + my answers so far |
| `POST` | `/student/attempts/{attempt}/answers` | **Upsert.** `{question_id, selected_option_id}` |
| `POST` | `/student/attempts/{attempt}/submit` | Finalizes, **scores inline**, returns the result |
| `GET` | `/student/results` | `SCORED` attempts only — an expired one never appears |
| `GET` | `/student/results/{attempt}` | Full dimension breakdown |

**What the player payload deliberately omits.** A question carries **no dimension**, and an option
carries **no score**. Not an oversight, and not something a future "helpful transparency" change
should add back: a student who can see that item 14 loads onto Investigative and that "Strongly
Agree" is worth 5 stops answering an interest inventory and starts answering the Holland Code they
would like to have. The instrument would then measure what the student wants the software to
conclude, and every recommendation downstream would rest on that. A frontend test asserts this
(`AssessmentPlayerPage.test.tsx`).

The `section_label` ("Investigative") *is* sent, as a progress heading. That is a deliberate,
limited disclosure: it groups sixty items into legible chunks without revealing what any single one
scores.

**`score` is never client-supplied.** It is snapshotted server-side from the chosen option at
answer time (§13.5) and frozen onto the answer row. A student who could POST their own score would
be scoring their own assessment. It is also why a scored attempt is re-derivable years later: the
engine reads the snapshot, never a live join through `question_options`.

**Submission is blocked while any REQUIRED question is unanswered**, with a count. This is what
makes §24's *prorating* rule safe — prorating (an unanswered question contributes to neither `raw`
nor `max`) is right for an *optional* question and catastrophic for a required one: without the
block, a student could answer one Investigative item with a 5, skip the other 59, and walk out with
a perfect and entirely meaningless `I`.

---

## Counselor — `/counselor` (role: `counselor`, `admin`)

Admins are admitted because `ClassPolicy` and `AssessmentPolicy` explicitly pass them (§39). The
route group is the coarse gate; ownership is still checked per record.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/counselor/assessment-templates` | GLOBAL instruments + my own private ones. Scoped in the **service**, not the policy |
| `GET` | `/counselor/classes/{class}/assignments` | With a completion count |
| `POST` | `/counselor/classes/{class}/assignments` | `{assessment_version_id, deadline?}` |
| `PATCH` | `/counselor/assignments/{assignment}` | In practice: **closing** it |
| `GET` | `/counselor/classes/{class}/results` | Scored attempts across the class |
| `POST` | `/counselor/attempts/{attempt}/reset` | The retake (§21) |

**You assign a *version*, never a template** (§13.4), and it must be `PUBLISHED` — a `DRAFT` is
still being edited, and students answering questions that move underneath them is the exact failure
invariant 1 exists to prevent. A draft assignment is a **422**, not a 403.

**Closing an assignment is not a status flip.** §21: an attempt still `IN_PROGRESS` when its
assignment closes becomes `EXPIRED` — so closing *ends the unfinished work underneath it*, in the
same transaction. Attempts already `SUBMITTED`/`SCORED` are untouched: closing ends unfinished
work, it does not revoke finished work. The UI confirms this in words before sending it.

**The reset is the counselor's, never the student's.** If a student could reset their own attempt,
a "retake" would be an undo button on a result they disliked, and the instrument would end up
measuring persistence rather than interest.

---

## Authorization (§39)

`AssessmentPolicy` governs three models, and PHP has no method overloading, so the methods are
named for the noun they guard (`viewAttempt`, not `view`). The rules are §39's; only the spelling
differs.

| | student (own) | student (other) | counselor (owns class) | counselor (other) | admin |
|---|---|---|---|---|---|
| view attempt / result | ✅ | ❌ | ✅ | ❌ | ✅ |
| **answer / submit** | ✅ | ❌ | ❌ | ❌ | **❌** |
| start attempt | ✅ (if enrolled + open) | ❌ | ❌ | ❌ | ❌ |
| reset attempt | ❌ | ❌ | ✅ | ❌ | ✅ |
| assign / close | ❌ | ❌ | ✅ | ❌ | ✅ |
| AI-generate RIASEC/SCCT | ❌ | ❌ | ❌ | ❌ | **❌ always** |

**The two bolded cells are the point of the table.**

`answerAttempt` is the one method in the entire authorization model with **no admin branch**. A
counselor may read their student's attempt (that is their job) and may never answer on their
behalf; nor may an admin. An assessment result that somebody else could have filled in is not an
assessment result. `Phase3/AuthorizationMatrixTest` pins this down at both layers — the route group
*and* the policy — so that a future "admins can do anything" refactor cannot quietly remove it.

The AI exclusion (§5) is checked **before** ownership, which is why even an admin is refused. Phase
5b builds the endpoints; the rule exists today, and is tested today.

Starting an attempt is authorized against **live enrollment**, not the token. A student removed
from a class (§13.2 — the row survives with status `removed`) cannot keep working through its
assessments. Their token is revoked on removal (Phase 1F), but a token is a *session* and
enrollment is a *fact*, and the fact is what is authorized against.

---

## The seeded instruments

`AssessmentSeeder` publishes both, **through the real `AssessmentBuilderService`** — so the seeder
passes through the same publish gate a counselor would, and cannot ship an instrument with an
unreviewed mapping. If it ever tried, seeding would fail loudly.

| | RIASEC | SCCT |
|---|---|---|
| Dimensions | 6 (R, I, A, S, E, C) | 3 (SE, OE, GO) |
| Items | 60 (6 × 10) | 30 (3 × 10) |
| Algorithm | `HOLLAND_CODE_TOP3` | `WEIGHTED_COMPOSITE` |
| Output | `result_code` — "IAS" | `overall_summary` — a sentence |
| Weights | — | SE 0.40, OE 0.30, GO 0.30 |

**The SCCT composite in `overall_summary` is display-only** (§23, v1.2). Every consumer — above all
the Part VII engine — recomputes the Career Confidence Index from the `dimension_scores` rows via
`ScoringService::compositeIndex()`. Nothing parses a number back out of the prose; the plan names
that as "a bug waiting to happen".

**An absent `dimension_scores` row means "not measured", not zero** (§24). A stored `0.00` would be
a different and false claim, and it would then be sorted into a Holland Code as a real dimension
and averaged into a recommendation as a real number. The results UI honours this — it renders no
bar rather than an empty one.

`assessment_dimensions.order_number` (R=1 … C=6) is **scoring data, not a display preference**: §22
breaks Holland Code ties on the canonical order R > I > A > S > E > C. Without it, a student with
I = A = 71.0 would get whichever dimension the database happened to return first, and their Holland
Code would be a fact about row ordering rather than about them.
