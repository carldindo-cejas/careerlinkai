-- Migration 0039 — a staff email change has to be proven on the new address first
--
-- Prompt-driven (2026-09-21). One table, holding the half of an email change that has been asked
-- for but not yet earned.
--
-- ## What was wrong with the old flow
--
-- `POST /auth/change-email` verified the current password and wrote the new address straight into
-- `users.email`. The password check is the right control for "is this the account holder", and it
-- is the only control the endpoint had — which leaves the one question it cannot answer: **does
-- this mailbox exist and does this person read it?**
--
-- That gap is not cosmetic, because of what the address *is* here. It is the login identifier and
-- it is where a password reset is delivered (§38). A counselor who types `maria@scholl.test` for
-- `maria@school.test` has, in one submission:
--
--   * lost their login, since the old address stops working immediately;
--   * lost the reset flow, since the link now goes to a mailbox nobody owns; and
--   * handed both to whoever registers that domain's typo next.
--
-- There is no undo. The account is recoverable only by an administrator reaching into the
-- database. The suite has a test named "refuses the old address for signing in afterwards" that
-- asserts precisely the moment this becomes irreversible.
--
-- ## The shape
--
-- The change is staged here, a six-digit code is mailed **to the new address**, and `users.email`
-- moves only when that code comes back. Typing the wrong address now costs a code that never
-- arrives and a form that stays where it is — the failure mode becomes "nothing happened", which
-- is the correct failure mode for an irreversible identity change.
--
-- The code is the same instrument as the counselor-signup code in migration 0034 (six digits,
-- hashed with SHA-256, a TTL in code, a failures-only lockout on a Durable Object keyed to this
-- user), and for the same reason: a code is typed back into the form that is already open, so it
-- survives a mail client that mangles links and works when the mail is read on a phone and the
-- form is on a lab desktop. A link would also be a bearer credential that moves somebody's login
-- identifier on one click from anything that prefetches URLs.
--
-- ## Why the password is still checked at step one
--
-- It is, and it must be: the code proves the *destination*, never the requester. Without the
-- password an unattended session in a staffroom could aim a change at an address the passer-by
-- controls and complete it from their own mailbox. Step one proves who is asking; step two proves
-- where it is going. Neither substitutes for the other.

CREATE TABLE staff_email_change_requests (
    -- **One live request per user, not per address.** The primary key is what enforces that: a
    -- second submission replaces the first, so there is never a question of which of two codes is
    -- live, and there is no way to accumulate staged changes against one account. The same upsert
    -- rule `password_reset_tokens` and `counselor_signup_requests` are built on.
    --
    -- ON DELETE CASCADE because a staged change to a deleted account is not a thing to keep: it
    -- can never be completed, and it holds the one address the row exists to protect.
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- The address being moved to, already normalised (trimmed, lowercased) by the service.
    --
    -- Deliberately **not** UNIQUE. `users_email_unique` is the index that decides who owns an
    -- address, and it is checked again at commit; a unique index here would instead mean that
    -- staging a change to an address blocks everybody else from staging one to it, which turns an
    -- unverified intention into a reservation. Two people may stage the same address; the first to
    -- verify gets it, and the second is told it is taken, exactly as if they had raced at step one.
    new_email TEXT NOT NULL,

    -- SHA-256 of the six-digit code, via `hashToken` — never the code itself. A plaintext code in
    -- this table would make read access to D1 sufficient to complete somebody else's email change.
    code_hash TEXT NOT NULL,

    -- When the code was issued, and therefore what the TTL is measured from. It moves on a resend:
    -- the window belongs to the code, not to the request, and leaving it would hand somebody a new
    -- code that expires in whatever was left of the old one's fifteen minutes.
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- For the sweep of expired rows, and for "how many changes are in flight" without a table scan.
-- Same index as `counselor_signup_requests` carries, for the same reason.
CREATE INDEX staff_email_change_requests_created_at_index
    ON staff_email_change_requests(created_at);
