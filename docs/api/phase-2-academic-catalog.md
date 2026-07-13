# API — Phase 2: Academic Catalog

Endpoint contracts for the Academic Catalog module (FULLPLAN §20, §13.3), as built in Phase 2.
This documents what the code does; **FULLPLAN.md remains the source of truth** — where this file
and the plan disagree, the plan wins and this file is wrong.

> **v1.3 note:** these contracts were built and verified on the pre-v1.3 Laravel backend. The
> HTTP contract (endpoints, payloads, envelopes, status codes) is unchanged by the v1.3 platform
> move and is exactly what the Phase 3.5 Worker port must reproduce. Any framework-specific
> implementation notes below (Form Requests, Eloquent pivots, artisan seeders) describe the
> retired implementation — read them as the behavior to preserve, not the mechanism to keep.

Base path: `/api/v1`

---

## Conventions (§19)

Identical envelopes, status codes and bearer-token auth to
[Phase 1](phase-1-class-and-enrollment.md#conventions-19). Two things are different, and both
matter:

**Authorization is one layer here, not two.** Every endpoint below sits behind
`auth:sanctum` + `active` + `role:admin`. In Phase 1, `role` was the coarse gate in front of
`ClassPolicy`'s fine-grained ownership check — a counselor may only touch *their own* classes.
The catalog has no such dimension: a college belongs to nobody. It is global reference data, and
"admin" is the entire rule.

That means **no Policy guards these endpoints, deliberately.** §39 names three policies —
`AssessmentPolicy`, `ClassPolicy`, `RecommendationPolicy` — and no catalog policy. That is not an
omission in the plan; it is the absence of anything to scope. A `CatalogPolicy` here would be six
methods of `return $user->isAdmin()`, restating what the route already guarantees.

The consequence, and the reason `tests/Feature/Phase2/AuthorizationMatrixTest.php` is
load-bearing rather than belt-and-braces: **the route group is the only thing standing between a
new catalog endpoint and a counselor who can edit the catalog.** There is no second net.

**A counselor gets 403 on every endpoint below.** Not 404, not a filtered list — the catalog is
admin-managed (§5), and a counselor editing the college list would be editing what every other
counselor's students get recommended.

**`per_page` is clamped to 100** on the paginated lists. The careers picker legitimately wants the
whole catalog in one request; nothing wants fifty thousand rows.

---

## Why this module exists in the shape it does

Three schema decisions drive the whole API, and each one is a v1.1/v1.2 correction worth knowing
before reading the endpoints:

1. **`colleges` is a real table** (§13.3, new in v1.1). It was denormalized text on `programs` in
   v1.0. It was promoted because that text drifted — misspellings and inconsistent naming across
   many program rows — and because admin needs genuine CRUD with programs nested underneath.
   This is why `programs.college_id` is an FK and why §27 can derive a recommended college as a
   plain join rather than by matching strings.

2. **`recommended_strand` is a strict two-value enum** (§13.1, v1.1): `Academic` |
   `Technical-Professional`. `NULL` is a third, *distinct* state meaning "no strand requirement",
   which §27 scores as a full 100 — not as a missing value.

3. **`program_careers` is an input to the recommendation engine**, not a display list. §27
   averages `riasec_compatibility` over every career linked to a program to produce that
   program's RIASEC component. A program with no links falls back to a neutral 50.

---

## Colleges

### `GET /admin/colleges`

Paginated. Each item carries `programs_count`, not the programs themselves.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "9f8b…",
        "name": "University of Santo Tomas",
        "description": "The oldest existing university in Asia.",
        "status": "active",
        "programs_count": 3,
        "created_at": "2026-07-13T09:12:44+00:00",
        "updated_at": "2026-07-13T09:12:44+00:00"
      }
    ],
    "pagination": { "current_page": 1, "per_page": 20, "total": 5, "last_page": 1 }
  }
}
```

### `POST /admin/colleges`

| Field | Rules |
|---|---|
| `name` | required, string, max 200, **unique among non-deleted colleges** |
| `description` | nullable, string |

`status` is **not accepted**. A new college is always `active`; archiving one is an explicit
`PATCH`.

> **On that uniqueness rule.** It is enforced in the Form Request, not by a database unique
> index — and that is on purpose. Colleges are soft-deleted (§12), so a deleted row keeps its
> name forever. A DB-level index would let one deleted "University of Santo Tomas" permanently
> block anyone from ever adding the real one. The check scopes itself to live rows instead.
> The same reasoning applies to `programs.code` and `careers.title`.

**201** with the created college.
**422** `name` — *"A college with this name is already in the catalog."*

### `GET /admin/colleges/{id}`

Includes the nested programs list (§20), **and each program's linked careers**. This is the
admin's view of one institution and everything it offers — and the mapping is what makes a
program scoreable at all, so a view that stopped at the program name would hide the only field
that decides whether the program can be recommended.

```json
{
  "data": {
    "id": "9f8b…",
    "name": "University of the Philippines Diliman",
    "status": "active",
    "programs": [
      {
        "id": "3c1a…",
        "college_id": "9f8b…",
        "code": "BSCS",
        "name": "BS Computer Science",
        "department_name": "College of Engineering",
        "recommended_strand": "Academic",
        "status": "active",
        "careers": [
          { "id": "aa1…", "title": "Software Engineer", "typical_riasec_code": "IEC", "status": "active" },
          { "id": "bb2…", "title": "Data Analyst",      "typical_riasec_code": "ICE", "status": "active" }
        ]
      }
    ]
  }
}
```

### `PATCH /admin/colleges/{id}`

| Field | Rules |
|---|---|
| `name` | sometimes, required, max 200, unique among non-deleted colleges (ignoring this one) |
| `description` | nullable, string |
| `status` | sometimes, one of `active`, `archived` |

`draft` is **not** a valid college status — that is a *program* status. The two enums are
deliberately different: a college has no meaningful "entered but not yet offered" state.

### `DELETE /admin/colleges/{id}` → **204**

Soft delete (§12), **cascading to the college's programs** in the same transaction. To retire a
college while keeping it visible — which is what §8's archive-don't-delete rule says an admin
almost always wants — `PATCH {"status": "archived"}` instead.

> **Why the cascade.** Without it a program whose college is deleted is *unreachable but alive*:
> `GET /colleges/{id}` 404s, so nothing can ever list it again, while `PATCH /programs/{id}` still
> edits it happily — and it was still being handed to the recommendation engine. Worse,
> `$program->college` resolves to `NULL` through the SoftDeletes scope, which is exactly the join
> §27 uses to name the recommended college. A college and its programs are one unit.

### Archiving vs. deleting, and what §27 sees

This is the rule Phase 4 depends on, so it is stated here rather than left to be inferred:

| Action on the college | Its programs | Rankable by §27? |
|---|---|---|
| `PATCH {"status": "archived"}` | untouched — still `active`, still editable, still visible | **No** |
| `DELETE` | soft-deleted with it | **No** |
| `PATCH {"status": "active"}` (restore) | untouched | **Yes**, again |

**Recommendability is a property of the chain, not of the program row.** An `active` program under
an archived college would otherwise be recommended *at an institution the admin has retired* —
`programs.status` says nothing about whether the college still offers it. `rankablePrograms()` is
the single place this is decided, and Phase 4 is meant to ask nothing else.

---

## Programs

Programs are **created and listed under their college**, and **edited by their own id**. That
asymmetry is §20's, and it is right: a program cannot exist without a college, but once it does,
it has an identity of its own.

### `GET /admin/colleges/{collegeId}/programs`

Unpaginated — one institution's program list is tens of rows, not thousands. Each program
includes its linked careers.

### `POST /admin/colleges/{collegeId}/programs`

| Field | Rules |
|---|---|
| `code` | required, max 30, **unique within this college** |
| `name` | required, max 200 |
| `department_name` | nullable, max 200 |
| `description` | nullable |
| `recommended_strand` | nullable, one of `Academic`, `Technical-Professional` |
| `status` | optional, one of `draft`, `active`, `archived` (default `active`) |

**`college_id` is not accepted, in this endpoint or in `PATCH`.** The parent comes from the
route. A body that names a different college is ignored — `college_id` is not fillable on the
model, precisely so that neither a create nor an edit can move a program to another institution.
Doing so would silently rewrite the college that §27 derives for every recommendation already
pointing at that program.

**On `code` uniqueness:** scoped to the college, not global. "BSCS" at UP Diliman and "BSCS" at
DLSU are different programs that legitimately share a code.

The code is **uppercased in `prepareForValidation()`** — before the uniqueness rule runs, not
after. It has to be: the rule is a plain string comparison, so `"bscs"` checked against a stored
`"BSCS"` finds nothing, passes, and lands a second BSCS in the same college. Normalising in the
service would be too late. That is the same free-text naming drift that got `colleges` promoted
out of a text column in v1.1, reappearing one column over.

**On `status` being settable here** — unlike colleges and careers, which are always created
`active`: a program has a real third state. `draft` is a program the admin has entered but is not
offering, and §27 ranks only `active` programs, so choosing it at creation is a meaningful act.

**On `recommended_strand: null`** — this is a *claim*, not a blank. §27 reads it as "this program
has no strand requirement" and scores a full 100 for every student. It is not "unknown".

**422** `code` — *"This college already offers a program with that code."*

### `PATCH /admin/programs/{id}` · `DELETE /admin/programs/{id}` → **204**

Same fields as `POST`, all optional. Soft delete.

---

## Careers

Careers are **global**, not nested under a college — the same "Software Engineer" is the
destination of programs at many institutions, which is exactly what `program_careers` exists to
express.

### `GET /admin/careers` — paginated. `POST /admin/careers`

| Field | Rules |
|---|---|
| `title` | required, max 150, unique among non-deleted careers |
| `description` | nullable |
| `salary_range` | nullable, max 100 — free text, e.g. `"PHP 30,000 - 80,000/mo"` |
| `employment_outlook` | nullable, max 100 |
| `typical_riasec_code` | nullable, **a valid Holland code** — see below |

### The Holland code

`typical_riasec_code` is the field that makes a career scoreable. §27 reads it *positionally*
against the student's normalized RIASEC profile, weighting the letters `[0.5, 0.3, 0.2]` — the
first letter is the dominant type. Order is data, not formatting.

`App\Rules\HollandCode` enforces three constraints, and every one of them exists because the
engine would otherwise **misread** the value rather than reject it — §27 has no way to tell a bad
code from a good one:

| Rule | Why |
|---|---|
| Letters from `R I A S E C` only | §27 looks each letter up against a dimension score. `X` has none. |
| **At most 3 letters** | The column is `VARCHAR(6)` per §13.3, but §27 defines `position_weights = [0.5, 0.3, 0.2]` — three positions, no more. A fourth letter is read at an index with no weight and silently counts for nothing. The column keeps its width; the input does not. |
| No repeated letter | `"IIE"` would weight Investigative at 0.5 + 0.3 = 0.8, scoring a one-dimensional student as a near-perfect match for a career they are not. |

Case is not enforced on input — `"iec"` is accepted and **stored as `"IEC"`**. §27 compares each
letter against a dimension key, so the case is settled once on write rather than at every read
site.

`null` is valid: a career with no Holland code is a legitimate catalog entry that simply cannot
be RIASEC-matched. An empty string normalises to `null` — `""` would reach §27 as a zero-letter
code to iterate.

### `PATCH /admin/careers/{id}` · `DELETE /admin/careers/{id}` → **204**

`status` (`active` | `archived`) becomes writable on `PATCH`.

---

## The program ↔ career mapping

> This is the part Phase 4 actually reads. §27 averages `riasec_compatibility` over every career
> linked to a program to produce that program's RIASEC component; an unmapped program falls back
> to a neutral **50**. The invariants below are therefore *scoring* invariants, not bookkeeping
> ones — a duplicate link is a bent score.

### `POST /admin/programs/{id}/careers`

| Field | Rules |
|---|---|
| `career_id` | required, uuid, must exist, **not be soft-deleted, and be `active`** |

**201** with the updated program, `careers` included — so the caller never has to refetch to
redraw the mapping.

**422** `career_id`:

- *"… is already linked to this program."* — The mapping is a **set**, not a bag. Attaching the
  same career twice would give it two votes in §27's average and quietly bend the program's
  score.

  The **unique index on `(program_id, career_id)` is the guarantee** — not the service's
  pre-check, which only exists to produce a sentence an admin can read. A check-then-insert is a
  race: two concurrent requests can both find nothing and both insert, and the loser would surface
  as a **500** rather than the 422 this is meant to be. So the insert is wrapped and the
  constraint violation is translated into the same error.
- *"That career is not in the catalog, or has been archived."* — A soft-deleted **or archived**
  career cannot be newly linked. See below.

### What archiving a career does to the mapping

An archived career **stops influencing anything** — it is dropped from §27's program RIASEC
average, and it cannot be newly linked to a program (the mapping row would be inert on the day it
was made).

> FULLPLAN is genuinely silent on this: §27 says *"for every ACTIVE career"* when ranking career
> matches, but *"over all careers linked to this program"* for the program score — the two are
> never reconciled. Resolved in favour of §8's archive-don't-delete semantics: **archiving means
> "stop recommending this"**, so a career that is no longer recommended on its own must not keep
> voting on the score of every program linked to it.

Two consequences worth knowing before Phase 4:

- **The existing link survives.** Archiving is not unlinking. The admin still sees the chip on the
  program — struck through, labelled *"archived — not counted"* — so restoring the career brings
  its vote back rather than asking them to re-link it by hand.
- **A program whose careers are all archived is indistinguishable from an unmapped one**, and
  takes §27's neutral **50** — rather than an average over nothing.

Which also means: **archiving a career shifts the score of every program linked to it.** That is
intended, not a side effect.

### `DELETE /admin/programs/{id}/careers/{careerId}` → **200** with the updated program

A **real** delete, not a soft one. The join row records no event that anyone lived through — it
is not `class_students`, which is an enrollment a real student experienced (§13.2) — and both
sides of it survive untouched.

The mapping row still carries a **UUID primary key** (§12: UUIDs everywhere, v4). Laravel's
default `attach()` writes a join row with a raw insert that knows nothing about the model and
would leave `id` NULL; the `ProgramCareer` pivot model exists to route it through Eloquent so the
UUID gets minted.

---

## Endpoint summary

| Method | Path | Success |
|---|---|---|
| GET | `/admin/colleges` | 200 |
| POST | `/admin/colleges` | 201 |
| GET | `/admin/colleges/{id}` | 200 (nested programs + their careers) |
| PATCH | `/admin/colleges/{id}` | 200 |
| DELETE | `/admin/colleges/{id}` | 204 |
| GET | `/admin/colleges/{collegeId}/programs` | 200 |
| POST | `/admin/colleges/{collegeId}/programs` | 201 |
| PATCH | `/admin/programs/{id}` | 200 |
| DELETE | `/admin/programs/{id}` | 204 |
| GET | `/admin/careers` | 200 |
| POST | `/admin/careers` | 201 |
| PATCH | `/admin/careers/{id}` | 200 |
| DELETE | `/admin/careers/{id}` | 204 |
| POST | `/admin/programs/{id}/careers` | 201 |
| DELETE | `/admin/programs/{id}/careers/{careerId}` | 200 |

15 endpoints, matching §20's catalog listing exactly.

---

## Seeding the demo catalog

```bash
php artisan db:seed --class=CatalogSeeder
```

Real data, not faker output: 5 Philippine institutions, 16 programs, 10 careers, 24 mappings.
Idempotent — every row is keyed and upserted, so re-running never duplicates the catalog.

It is real for two reasons. It is what a thesis panel is shown, and a catalog of invented
universities undercuts the demo. And **§27's worked example scores BS Computer Science through
Software Engineer (`IEC`) and Data Analyst (`ICE`)** — those exact rows exist in the seeder, so
Phase 4's engine can be checked against a number computed by hand.

The seed data also deliberately covers all three strand cases, because uniform data would never
exercise §27's strand branch: `Academic` programs, `Technical-Professional` programs (Mapúa's
BSIT and BSCPE — the TVL-ICT track feeds them directly), and one program with **no** requirement
(Ateneo's AB Communication).
