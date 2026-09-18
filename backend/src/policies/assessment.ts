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
 * | **assign globally**    | ❌ | ❌ | **❌** | ❌ | ✅ |
 * | view template          | ❌ | ❌ | ✅ (global + own) | ❌ | ✅ |
 * | copy template          | ❌ | ❌ | ✅ (global + own) | ❌ | ✅ |
 * | AI-generate RIASEC/SCCT| ❌ | ❌ | ❌ | ❌ | **❌ always** |
 *
 * **The three bolded cells are the entire point of this file.** Everything else is ordinary
 * role-plus-ownership and could be reconstructed from §39 by anyone; those three cannot, and each
 * is the kind of rule a well-meaning "admins can do anything" refactor removes without noticing.
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
 * **Assigning is authorized against the class, not the template** — and this is the distinction the
 * assignment route had wrong.
 *
 * A counselor's whole job is handing their class the *curated* instruments: RIASEC and SCCT are
 * `GLOBAL` and admin-owned, so `canManageTemplate` refuses them, and the assignment endpoint gating
 * on it meant a counselor pressing Assign on RIASEC got "Assessment template not found." §39's
 * table has always said `assign → counselor (owns class) ✅`; the real check is
 * `canManageAssignment(user, classRoom)`, which `assignToClasses` already applies per class.
 *
 * What is left for this function to decide is only **visibility**: may the caller see this
 * instrument at all? That is the same rule as the list — an admin sees everything, a counselor sees
 * the global instruments plus their own — so a counselor still cannot assign another counselor's
 * private template, and still cannot reach a class that is not theirs.
 */
export function canAssignTemplate(user: User, template: AssessmentTemplate): boolean {
  return (
    user.role === 'admin' || template.ownership === 'GLOBAL' || template.creatorId === user.id
  );
}

/**
 * **May the caller assign globally?** (prompt §2 — the permission this removes.)
 *
 * A GLOBAL assignment is administrator-only, and the reason is structural rather than a matter of
 * seniority. `scope = 'GLOBAL'` is not merely "assigned to a lot of classes at once": it is a
 * standing instruction that `applyGlobalAssignmentsToClass` replays onto **every class created or
 * reactivated afterwards**, whoever creates it. So a counselor who could write a GLOBAL row would
 * be handing their own private instrument to other counselors' future classes — permanently, and
 * without any of them being able to see where it came from. The per-class filter that
 * `assignToClasses` applies protects the classes that exist *at the time of the act* and cannot
 * protect the ones that do not exist yet.
 *
 * This is checked in the Service, before any row is written, and it is checked again in the
 * top-up path itself (`applyGlobalAssignmentsToClass` reads only GLOBAL-owned templates), because a
 * rule this consequential should not have exactly one enforcement point.
 */
export function canAssignGlobally(user: User): boolean {
  return user.role === 'admin';
}

/**
 * Seeing an instrument, as opposed to authoring it.
 *
 * The same line the lists already draw — admin: everything; anyone else: the GLOBAL instruments
 * plus their own — lifted into a policy so the **detail** routes draw it too. Until now the builder
 * page was gated on `canManageTemplate`, so a counselor clicking RIASEC in their own list got
 * "Assessment template not found." for a row sitting on screen in front of them. A counselor is
 * entitled to read the curated instruments: they assign them, they answer students' questions about
 * them, and (prompt §1) they may now take their own copy — which hands them the full contents
 * anyway. What they may not do is *write* to one, and that is `canManageTemplate`'s job.
 *
 * Another counselor's private template is invisible under both, which is the rule that matters.
 */
export function canViewTemplate(user: User, template: AssessmentTemplate): boolean {
  return (
    user.role === 'admin' ||
    template.ownership === 'GLOBAL' ||
    (user.role === 'counselor' && template.creatorId === user.id)
  );
}

/**
 * **404, not 403** — the standing rule. A counselor probing template ids must not be able to tell
 * "another counselor's private instrument" apart from "no such id".
 */
export function authorizeViewTemplate(
  user: User,
  template: AssessmentTemplate | undefined,
): asserts template is AssessmentTemplate {
  if (template === undefined || !canViewTemplate(user, template)) {
    throw ApiError.notFound('Assessment template not found.');
  }
}

/**
 * Copying an instrument into one the caller owns (prompt §1).
 *
 * Deliberately the **view** rule rather than the manage rule: copying reads the source and writes a
 * new template owned by the copier, so what it needs is permission to read. Gating it on
 * `canManageTemplate` would refuse a counselor the copy of RIASEC that the whole feature is for.
 *
 * There is no category check here, and that is the same distinction `duplicateVersion` draws: §5's
 * permanent rule bars *AI* from generating or editing RIASEC/SCCT, and it lives in
 * `canGenerateWithAi`. A human copying curated content by hand and editing it is §12's prescribed
 * workflow — and the copy keeps `category = 'RIASEC'`, so the AI rule follows it.
 */
export function canCopyTemplate(user: User, template: AssessmentTemplate): boolean {
  return (
    (user.role === 'admin' || user.role === 'counselor') && canViewTemplate(user, template)
  );
}

export function authorizeCopyTemplate(
  user: User,
  template: AssessmentTemplate | undefined,
): asserts template is AssessmentTemplate {
  if (template === undefined || !canCopyTemplate(user, template)) {
    throw ApiError.notFound('Assessment template not found.');
  }
}

/**
 * **404, not 403**, for the ownership failure — the standing rule: a counselor probing another
 * counselor's private template ids must not learn which ids exist.
 */
export function authorizeAssignTemplate(
  user: User,
  template: AssessmentTemplate | undefined,
): asserts template is AssessmentTemplate {
  if (template === undefined || !canAssignTemplate(user, template)) {
    throw ApiError.notFound('Assessment template not found.');
  }
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
