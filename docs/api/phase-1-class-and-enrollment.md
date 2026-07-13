# API — Phase 1: Class & Enrollment

Endpoint contracts for the Class module (FULLPLAN §20) and passwordless student access (§38),
as built in Phases 1A–1C. This documents what the code does; **FULLPLAN.md remains the source
of truth** — where this file and the plan disagree, the plan wins and this file is wrong.

> **v1.3 note:** these contracts were built and verified on the pre-v1.3 Laravel backend. The
> HTTP contract (endpoints, payloads, envelopes, status codes) is unchanged by the v1.3 platform
> move and is exactly what the Phase 3.5 Worker port must reproduce. Any framework-specific
> implementation notes below (Sanctum, Form Requests, Eloquent) describe the retired
> implementation — read them as the behavior to preserve, not the mechanism to keep.

Base path: `/api/v1`

---

## Conventions (§19)

Every response uses one of two envelopes.

**Success**

```json
{
  "success": true,
  "message": "Class created successfully.",
  "data": {},
  "meta": { "timestamp": "2026-07-13T09:12:44+00:00" }
}
```

**Error**

```json
{
  "success": false,
  "message": "Validation failed.",
  "errors": { "name": ["The name field is required."] }
}
```

| Status | When |
|---|---|
| 200 / 201 / 204 | Success |
| 401 | No token, an invalid token, or a failed student join |
| 403 | Authenticated, but the role or the ownership check refused it |
| 404 | The record does not exist, **or exists but is not yours to see** |
| 422 | Validation failed |
| 429 | Rate limited |

**Authentication.** Every endpoint below except `POST /student-access/join` requires
`Authorization: Bearer <token>`. Staff tokens come from `POST /auth/login`; student tokens come
from `POST /student-access/join`. Downstream they are the same kind of token — the difference is
only in how the identity was claimed (§38).

**Authorization** is two layers (§39): the `role` middleware is the coarse gate, and `ClassPolicy`
is the fine one. A counselor may only touch classes they own; an admin may touch any.

---

## Classes — `/counselor/classes`

Requires role `counselor` or `admin`.

### `GET /counselor/classes`

Lists the caller's classes. An admin sees every class.

| Query | Default | |
|---|---|---|
| `per_page` | 20 | Page size |

```json
{
  "success": true,
  "message": "Classes retrieved successfully.",
  "data": {
    "items": [ { "id": "…", "name": "Grade 12 STEM A", "join_code": "HVJE-5977", "…": "…" } ],
    "pagination": { "current_page": 1, "per_page": 20, "total": 3, "last_page": 1 }
  }
}
```

### `POST /counselor/classes` → `201`

| Field | Rules |
|---|---|
| `name` | required, string, max 150 |
| `academic_year` | required, string, max 20 |
| `grade_level` | optional, string, max 20 |

**The join code is generated at creation and returned in this response** — before any roster
exists (§13.2, §57). It is **not** an accepted input: a `join_code` in the payload is ignored,
because a client must never be able to choose its own code.

```json
{
  "success": true,
  "message": "Class created successfully.",
  "data": {
    "id": "3f2b…",
    "counselor_id": "9c11…",
    "name": "Grade 12 STEM A",
    "academic_year": "2026-2027",
    "grade_level": "Grade 12",
    "join_code": "HVJE-5977",
    "join_code_expires_at": "2026-10-11T09:12:44+00:00",
    "status": "active",
    "created_at": "2026-07-13T09:12:44+00:00",
    "updated_at": "2026-07-13T09:12:44+00:00"
  }
}
```

**Join code format:** four letters, a hyphen, four digits. The alphabet excludes **I, O, 0 and 1** —
students type this by hand, and a failed join deliberately tells them nothing about *why* it
failed, so an `O` misread as a `0` would be an undebuggable dead end. Keyspace: 24⁴ × 8⁴ ≈ 1.36
billion. Default lifetime: `STUDENT_JOIN_CODE_TTL_DAYS` (90 days).

### `GET /counselor/classes/{id}`
### `PATCH /counselor/classes/{id}`

Accepts `name`, `academic_year`, `grade_level`, `status` (`draft` \| `active` \| `archived`).
`join_code` is not modifiable here — use `regenerate-code`.

Setting `status` to anything but `active` **closes the class to student joins**.

### `DELETE /counselor/classes/{id}` → `204`

Soft delete (§12). To end a class while keeping it visible, `PATCH` its status to `archived`
instead.

### `POST /counselor/classes/{id}/regenerate-code` → `200`

Issues a fresh code and a fresh expiry. **The previous code stops working immediately** (§38) —
this is the counselor's revocation mechanism when a code leaks.

---

## Roster — `/counselor/classes/{id}/students`

Bulk provisioning is deliberately two requests: **preview**, which proposes and persists nothing,
then **confirm**, which creates the accounts. There is no student self-registration anywhere in
the system.

### `POST …/students/preview` → `200`

| Field | Rules |
|---|---|
| `names` | required, array, 1–200 items |
| `names.*` | required, string, max 150 |

```json
{
  "data": {
    "students": [
      { "name": "Juan Dela Cruz", "first_name": "Juan", "last_name": "Dela Cruz", "username": "juan.delacruz" },
      { "name": "Juan Dela Cruz", "first_name": "Juan", "last_name": "Dela Cruz", "username": "juan.delacruz2" },
      { "name": "Madonna", "first_name": "Madonna", "last_name": null, "username": "madonna" }
    ]
  }
}
```

Username generation (§16): `slugify(first) + "." + slugify(last)`, ASCII-folded (`José Peña` →
`jose.pena`), punctuation stripped, duplicates suffixed `2`, `3`, … Collisions are checked
**within the target class only** — usernames are unique per class, not globally (§13.2).

Nothing is written. The counselor is expected to edit this list and send it back.

### `POST …/students/confirm` → `201`

| Field | Rules |
|---|---|
| `students` | required, array, 1–200 items |
| `students.*.first_name` | required, string, max 100 |
| `students.*.last_name` | **nullable**, string, max 100 |
| `students.*.username` | required, max 50, `^[a-z0-9][a-z0-9._-]*$`, distinct within the payload |

`last_name` is nullable because **a mononym is a name, not an error** (§13.1, v1.2). A one-word
line (`"Madonna"`) previews with `last_name: null` and confirms exactly as previewed — the
counselor is never asked to invent a surname the student does not have. NULL and `""` are not the
same claim, so an empty string is normalised to NULL rather than stored.

> Until 13 Jul 2026 `student_profiles.last_name` was `NOT NULL` and this endpoint returned `422`
> on such a row, which made the mononym previewable but unconfirmable. That is fixed; the column
> is nullable.

Creates, per student and in one transaction: a `users` row (**`password` NULL, `email` NULL,
`role` = student** — permanently, §38), a `student_profiles` row, and a `class_students` row.

Because the counselor may have edited the previewed usernames, collisions are re-checked against
the database here. A single conflict rejects the **whole batch** with `422` — there is no
half-provisioned roster.

### `GET …/students` → `200`

The current roster, ordered by username. Removed students are excluded.

```json
{
  "data": [
    {
      "id": "…", "class_id": "…", "student_id": "…",
      "username": "juan.delacruz", "status": "active",
      "joined_at": "2026-07-13T09:14:02+00:00", "removed_at": null,
      "first_name": "Juan", "last_name": "Dela Cruz"
    }
  ]
}
```

### `DELETE …/students/{studentId}` → `204`

`{studentId}` is the student's **user id**, not the enrollment id (§20).

The enrollment is marked `removed` and kept — `class_students` is the enrollment history (§13.2) —
and the user account is untouched, since the student may belong to other classes.

**Their live token is revoked in the same transaction** (§38, v1.2). Marking the enrollment removed
only closes the front door: a student who is already signed in holds a bearer token that would
otherwise outlive the row it was granted for. Removal means removal *now*, not whenever they next
happen to sign out. Revoking every token rather than one is deliberate — a join already replaces all
of a student's tokens, so the two sets are the same; a student enrolled elsewhere simply joins again
through that class.

A student id that is not enrolled in *this* class returns `404`, rather than revealing that the
account exists at all.

---

## Student access — `/student-access/join`

**Public.** No token, no password, no email. The only endpoint in the system a student can reach
without already being authenticated.

### `POST /student-access/join` → `200`

| Field | Rules |
|---|---|
| `class_code` | required, string, max 20 |
| `username` | required, string, max 50 |

Both are matched case-insensitively and trimmed. There is no format rule on either: a `regex:`
would answer, in a `422` and before the attempt is even charged against the rate limit, exactly
the question this endpoint is built not to answer.

```json
{
  "success": true,
  "message": "Access granted.",
  "data": {
    "user": { "id": "…", "name": "Juan Dela Cruz", "email": null, "role": "student", "status": "active" },
    "class": { "id": "…", "name": "Grade 12 STEM A", "academic_year": "2026-2027", "grade_level": "Grade 12" },
    "username": "juan.delacruz",
    "token": "7|xVb2…"
  }
}
```

The class payload here is deliberately **not** the staff `ClassResource`: it carries no
`join_code` and no `counselor_id`. The code is a shared secret and must not travel back out
through a student-facing response.

### Failure — always `401`, always identical

```json
{ "success": false, "message": "The class code or username is incorrect.", "errors": [] }
```

**Every** failure mode returns this exact response, byte for byte:

| The real reason | Recorded in `audit_logs.new_values.reason` |
|---|---|
| No class has that code | `INVALID_CODE` |
| The code has expired | `CODE_EXPIRED` |
| The class is draft or archived | `CLASS_NOT_ACTIVE` |
| No student in that class has that username | `UNKNOWN_USERNAME` |
| The student was removed from the class | `ENROLLMENT_REMOVED` |
| The account is deactivated | `ACCOUNT_INACTIVE` |

This is the §38 control that prevents the endpoint from being used to enumerate a class roster.
The API tells the caller nothing; the audit trail tells the operator everything.

### Rate limiting — `429`

10 **failed** attempts per `(class code, IP)` per 15 minutes, then that pair is frozen for 15
minutes — even for correct credentials.

```json
{
  "success": false,
  "message": "Validation failed.",
  "errors": { "class_code": ["Too many failed attempts. Try again in 900 seconds."] }
}
```

Only failures are counted, and a success clears the counter. This is not a detail: a class sitting
in one computer lab shares a single public IP, so counting *successful* joins against the same
`(code, IP)` key would lock the eleventh student out of their own class.

---

## Token lifecycle (§38, v1.2)

Everything above guards the **door**. A token that has already been issued is past it — and a bearer
token does not re-consult the roster on its way through. Three rules make a decision taken *after* a
student signed in actually reach the session they are already sitting in.

| | Staff token | Student token |
|---|---|---|
| Issued by | `POST /auth/login` | `POST /student-access/join` |
| Expires | never — until logout | after `STUDENT_TOKEN_TTL_HOURS` (default **12**) |
| Revoked when the account is deactivated | yes | yes |
| Revoked when removed from the class | n/a | yes |

**Student tokens expire; staff tokens do not.** The asymmetry is the point: a student's credential is
a code their whole class knows, typed on a machine they share, and nothing in their flow ever asks
them to re-assert who they are. The clock is the only thing that can end an abandoned session.

**A non-`active` account is refused at the middleware layer**, not merely at sign-in. The `active`
middleware sits alongside `auth:sanctum` on every authenticated route group and re-reads `status`
from the row on each request — the token being presented is exactly the thing whose authority is in
question. A rejected token is deleted on the way out, and the response is `401`. Without this,
suspending a user would take effect the next time they signed in, which is precisely the moment they
were suspended in order not to reach.

---

## Audit trail

Every join attempt writes exactly one `audit_logs` row — success and failure alike (§38) — with
the IP address, the class targeted (when the code resolved), and the real reason. The table is
append-only: the `AuditLog` model throws on any `UPDATE` or `DELETE`.

| `action` | `user_id` |
|---|---|
| `STUDENT_CLASS_ACCESS_SUCCESS` | the student |
| `STUDENT_CLASS_ACCESS_FAILED` | the student, if one was resolved; otherwise `NULL` |
| `STUDENT_CLASS_ACCESS_THROTTLED` | `NULL` |

There is no read endpoint for this yet — `GET /admin/audit-logs` (§20) is a later phase.
