import type {
  AssessmentAttempt,
  AssessmentTemplate,
  ClassRoom,
  ClassStudent,
  User,
} from '@/db/schema';
import { ApiError } from '@/lib/envelope';

/**
 * Assessment authorization (FULLPLAN §39, `docs/api/phase-3-assessment-engine.md`).
 *
 * Plain functions, not a class — a policy has no state and nothing to inject (§39, v1.3). The
 * methods are named for the noun they guard (`viewAttempt`, not `view`) because three different
 * models pass through here.
 *
 * |                        | student (own) | student (other) | counselor (owns class) | counselor (other) | admin |
 * |---|---|---|---|---|---|
 * | view attempt / result  | ✅ | ❌ | ✅ | ❌ | ✅ |
 * | **answer / submit**    | ✅ | ❌ | ❌ | ❌ | **❌** |
 * | start attempt          | ✅ (enrolled + open) | ❌ | ❌ | ❌ | ❌ |
 * | reset attempt          | ❌ | ❌ | ✅ | ❌ | ✅ |
 * | assign / close         | ❌ | ❌ | ✅ | ❌ | ✅ |
 * | AI-generate RIASEC/SCCT| ❌ | ❌ | ❌ | ❌ | **❌ always** |
 *
 * **The two bolded cells are the entire point of this file.** Everything else is ordinary
 * role-plus-ownership and could be reconstructed from §39 by anyone; those two cannot, and both
 * are the kind of rule a well-meaning "admins can do anything" refactor removes without noticing.
 */

/**
 * **The one authorization method in the whole system with no admin branch.**
 *
 * A counselor may *read* their student's attempt — that is their job — and may never answer on
 * their behalf; nor may an admin. An assessment result that somebody else could have filled in
 * is not an assessment result, and every recommendation downstream is computed from it.
 *
 * This is also why the reset is the counselor's and never the student's: if a student could void
 * their own attempt, a "retake" would be an undo button on a result they disliked, and the
 * instrument would end up measuring persistence rather than interest.
 */
export function canAnswerAttempt(user: User, attempt: AssessmentAttempt): boolean {
  return user.role === 'student' && attempt.studentId === user.id;
}

/** An admin sees everything; a counselor sees the attempts of students in their own classes. */
export function canViewAttempt(
  user: User,
  attempt: AssessmentAttempt,
  attemptClass: ClassRoom,
): boolean {
  if (user.role === 'student') {
    return attempt.studentId === user.id;
  }

  return user.role === 'admin' || attemptClass.counselorId === user.id;
}

/** The retake (§21). Staff only — see the note on `canAnswerAttempt`. */
export function canResetAttempt(user: User, attemptClass: ClassRoom): boolean {
  return user.role === 'admin' || (user.role === 'counselor' && attemptClass.counselorId === user.id);
}

/** Assigning an instrument to a class, and closing that assignment. */
export function canManageAssignment(user: User, classRoom: ClassRoom): boolean {
  return user.role === 'admin' || (user.role === 'counselor' && classRoom.counselorId === user.id);
}

/**
 * **RIASEC and SCCT can never be AI-generated or AI-edited** (§5) — "in v1 or any deferred
 * future scope; this is a permanent architectural rule, not a temporary limitation".
 *
 * The category check comes **first, before ownership**, and that ordering is the substance of
 * the rule rather than a stylistic preference: it is what makes the refusal apply to an admin
 * who owns the template outright. There is no principal in the system who can pass this. An
 * ownership-first version would read almost identically and would quietly grant the exception to
 * the one role that must not have it.
 *
 * The AI endpoints themselves are Phase 5b. The rule and its test land now, while the reason for
 * them is fresh — §6's success criteria include "attempting this against RIASEC/SCCT is rejected
 * by the backend, not just hidden by the UI".
 */
export function canGenerateWithAi(user: User, template: AssessmentTemplate): boolean {
  if (template.category !== 'CUSTOM') {
    return false; // First. Before ownership. Even for an admin.
  }

  if (user.role === 'admin') {
    return true;
  }

  return user.role === 'counselor' && template.creatorId === user.id;
}

/**
 * Starting an attempt is authorized against **live enrollment, not the token**.
 *
 * A student removed from a class (§13.2 — the row survives with status `removed`) cannot keep
 * working through its assessments. Their tokens are revoked on removal, but a token is a
 * *session* and enrollment is a *fact*, and the fact is what gets authorized against: a session
 * that somehow outlived the removal must still not be able to start anything.
 */
export function canStartAttempt(user: User, enrollment: ClassStudent | undefined): boolean {
  return user.role === 'student' && enrollment?.status === 'active';
}

// --- The throwing wrappers ------------------------------------------------------------------

/**
 * **404, not 403** — the same reasoning as `policies/class.ts`: a 403 confirms the attempt
 * exists, which is a fact about another student that the caller is not entitled to. "Not yours"
 * and "not real" must be indistinguishable from outside.
 */
export function authorizeViewAttempt(
  user: User,
  attempt: AssessmentAttempt | undefined,
  attemptClass: ClassRoom | undefined,
): asserts attempt is AssessmentAttempt {
  if (
    attempt === undefined ||
    attemptClass === undefined ||
    !canViewAttempt(user, attempt, attemptClass)
  ) {
    throw ApiError.notFound('Attempt not found.');
  }
}

/**
 * A **403**, not a 404 — and deliberately unlike the rule above.
 *
 * By the time this runs the caller has already been allowed to *see* the attempt, so hiding its
 * existence would protect nothing. What is being refused is the act, and the honest answer to a
 * counselor trying to answer on a student's behalf is "you may not do this", not "it isn't
 * there". A silent 404 would read as a bug and invite a workaround.
 */
export function authorizeAnswerAttempt(user: User, attempt: AssessmentAttempt): void {
  if (!canAnswerAttempt(user, attempt)) {
    throw ApiError.forbidden('Only the student who owns this attempt may answer it.');
  }
}

/**
 * Authoring a template (Phase 5b — the builder endpoints): an admin manages any template, a
 * counselor manages their own. Ordinary role-plus-ownership, unlike `canGenerateWithAi`.
 */
export function canManageTemplate(user: User, template: AssessmentTemplate): boolean {
  return user.role === 'admin' || (user.role === 'counselor' && template.creatorId === user.id);
}

/**
 * **404, not 403**, for the ownership failure — the standing rule: a counselor probing another
 * counselor's private template ids must not learn which ids exist.
 */
export function authorizeManageTemplate(
  user: User,
  template: AssessmentTemplate | undefined,
): asserts template is AssessmentTemplate {
  if (template === undefined || !canManageTemplate(user, template)) {
    throw ApiError.notFound('Assessment template not found.');
  }
}

/**
 * The throwing form of `canGenerateWithAi`, keeping its category-before-ownership order and
 * splitting the two refusals by their honest status code:
 *
 *   - **Category (RIASEC/SCCT) → 403.** §6: "rejected by the backend, not just hidden by the
 *     UI." The caller may well be allowed to see this template; what is refused is the act,
 *     permanently and for every principal — hiding the template's existence would protect
 *     nothing and disguise a permanent rule as a lookup failure.
 *   - **Ownership → 404**, same as everywhere else.
 */
export function authorizeGenerateWithAi(
  user: User,
  template: AssessmentTemplate | undefined,
): asserts template is AssessmentTemplate {
  if (template === undefined) {
    throw ApiError.notFound('Assessment template not found.');
  }

  if (template.category !== 'CUSTOM') {
    // First. Before ownership. Even for an admin (§5).
    throw ApiError.forbidden(
      'RIASEC and SCCT are curated instruments and can never be AI-generated or AI-edited.',
    );
  }

  if (!canGenerateWithAi(user, template)) {
    throw ApiError.notFound('Assessment template not found.');
  }
}
