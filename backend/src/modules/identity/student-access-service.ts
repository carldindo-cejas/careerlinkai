import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { classStudents, classes, users, type ClassRoom, type User } from '@/db/schema';
import type { AuthGuardDO } from '@/do/auth-guard';
import type { Env } from '@/env';
import {
  JOIN_THROTTLE_LIMIT,
  JOIN_THROTTLE_WINDOW_SECONDS,
  joinThrottleGuard,
} from '@/lib/auth-guard';
import { studentTokenTtlHours } from '@/lib/config';
import { isExpired } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { hasActiveToken, issueToken, revokeAllTokensForUser } from '@/lib/tokens';
import { normalizeJoinCode } from '@/modules/classes/join-code';
import type { JoinClassInput } from '@/modules/identity/schemas';
import { AuditService, type JoinFailureReason } from '@/modules/platform/audit-service';

/**
 * Passwordless student access (FULLPLAN §38).
 *
 * Deliberately separate from `StaffAuthenticationService`: the two flows share the token
 * *mechanism* and nothing else, and §38 calls that split architectural. The surest way to
 * keep it that way is that neither service imports the other.
 *
 * The defining property of this service is what it does **not** say. A student's credential
 * is a code their whole class knows plus a username that is, by design, guessable from their
 * name — so the one thing this endpoint must never become is an oracle. Every failure below
 * returns the identical 401; the real reason goes to the audit log, where an operator can see
 * it and an attacker cannot.
 */

const MODULE = 'Identity';

/**
 * What a join answers with, in two shapes (fixes 1 and 2 of the September 2026 incident).
 *
 * ## Why a join is two requests now
 *
 * A student's credential is a class code their whole class can read off the whiteboard plus a
 * username that is, by design, guessable from their name or their seat number. The production
 * trail for 18 September 2026 is what that costs: 79 joins, 18 accounts, 10 devices — and **61 of
 * those joins deleted a session somebody else was in the middle of using**, 56 of them from a
 * different device, a median 53 seconds apart. Students were signing in as each other, mostly by
 * typing a neighbour's roster number, and each one silently evicted the last.
 *
 * Nothing in the old flow could tell those apart from a legitimate sign-in, because a join *was* a
 * takeover: resolve the credentials, delete every token the account held, issue a new one. The
 * student who typed the wrong number saw somebody else's assessment and never learned it; the
 * student who owned it was bounced to this screen with no explanation and re-joined, evicting
 * whoever had just arrived.
 *
 * So the resolution and the takeover are now two separate acts. The first (`JoinPreview`) proves
 * the credentials and **says whose account this is**, which is what catches the mistyped seat
 * number — a student recognises their own name and a stranger's equally well. The second, which
 * only happens if the caller sends `confirm`, is the one that issues a token and signs other
 * devices out, and by then the person has been told that is what it does.
 *
 * ## What this does *not* fix
 *
 * A student who *means* to sign in as a classmate still can — they need only click through a
 * confirmation. The name is a check against error, not a secret, and this whole design is a
 * mitigation standing in for the real fix: a per-student credential the rest of the class does
 * not know. Until that exists the honest description of student sign-in is that it identifies a
 * seat rather than a person.
 */
export interface JoinPreview {
  confirmed: false;
  /** Shown back to the student as "signing in as …". The only field the preview discloses. */
  studentName: string;
  classRoom: ClassRoom;
  username: string;
  /** True when confirming will sign another device out, so the warning can be shown first. */
  activeSession: boolean;
}

export interface JoinResult {
  confirmed: true;
  user: User;
  classRoom: ClassRoom;
  username: string;
  token: string;
}

/** The one error this service ever returns. Identical for every failure mode. */
function accessDenied(): ApiError {
  return ApiError.unauthenticated('The class code or username is incorrect.');
}

export class StudentAccessService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
  ) {
    this.audit = new AuditService(db);
  }

  async join(
    input: JoinClassInput,
    ipAddress: string | null,
  ): Promise<JoinPreview | JoinResult> {
    const classCode = normalizeJoinCode(input.class_code);
    const username = input.username.trim().toLowerCase();

    // The throttle is one `AuthGuardDO` instance per (class code, IP) and counts **failures
    // only** (§38, ratified v1.2; DO-backed since v1.5 — KV's eventual consistency and the
    // Free plan's 1,000-writes/day cap disqualified it as a security counter). A whole class
    // sits in one computer lab behind one public IP: charging successful joins against the
    // same instance would lock the eleventh student out of their own class.
    const guard = joinThrottleGuard(this.env, classCode, ipAddress);
    const throttle = await guard.check(JOIN_THROTTLE_LIMIT);

    if (throttle.locked) {
      // M3: no audit write on an already-locked attempt. Once the window is locked, every further
      // attempt used to write a `STUDENT_CLASS_ACCESS_THROTTLED` row — an attacker looping the
      // endpoint could drain the D1 daily write quota (§45) from a single IP. The throttle is
      // logged exactly once, at the moment it trips, in `reject()`; a still-locked retry is
      // refused without a write.
      throw ApiError.tooManyRequests({
        class_code: [
          `Too many failed attempts. Try again in ${throttle.retryAfterSeconds} seconds.`,
        ],
      });
    }

    const classRoom = await this.db.query.classes.findFirst({
      where: and(eq(classes.joinCode, classCode), isNull(classes.deletedAt)),
    });

    if (!classRoom) {
      return this.reject('INVALID_CODE', guard, { classCode, username }, null, null, ipAddress);
    }

    if (isExpired(classRoom.joinCodeExpiresAt)) {
      return this.reject(
        'CODE_EXPIRED',
        guard,
        { classCode, username },
        classRoom.id,
        null,
        ipAddress,
      );
    }

    if (classRoom.status !== 'active') {
      return this.reject(
        'CLASS_NOT_ACTIVE',
        guard,
        { classCode, username },
        classRoom.id,
        null,
        ipAddress,
      );
    }

    const enrollment = await this.db.query.classStudents.findFirst({
      where: and(eq(classStudents.classId, classRoom.id), eq(classStudents.username, username)),
    });

    if (!enrollment) {
      return this.reject(
        'UNKNOWN_USERNAME',
        guard,
        { classCode, username },
        classRoom.id,
        null,
        ipAddress,
      );
    }

    if (enrollment.status !== 'active') {
      return this.reject(
        'ENROLLMENT_REMOVED',
        guard,
        { classCode, username },
        classRoom.id,
        enrollment.studentId,
        ipAddress,
      );
    }

    const student = await this.db.query.users.findFirst({
      where: and(eq(users.id, enrollment.studentId), isNull(users.deletedAt)),
    });

    if (student?.status !== 'active') {
      return this.reject(
        'ACCOUNT_INACTIVE',
        guard,
        { classCode, username },
        classRoom.id,
        enrollment.studentId,
        ipAddress,
      );
    }

    // The credentials were right, so the failures that preceded them were typos rather than an
    // attack. Cleared here rather than after the confirmation, so a student who stops to check the
    // name on the next screen does not leave a charged counter behind for the next person on this
    // IP — the whole class shares one (§38), which is the other half of what made September hurt.
    await guard.clear();

    /**
     * **Step one: say whose account this is, and issue nothing.**
     *
     * No token, no revocation, and no `STUDENT_CLASS_ACCESS_SUCCESS` row — nobody has signed in
     * yet, and a trail that recorded this as a sign-in would be the same lie the old flow told.
     * The audit write also stays out because this path is cheap to repeat and D1's daily write
     * quota is not (§45, audit M3).
     *
     * The name is the only thing disclosed, and it is disclosed to somebody who already holds the
     * class code and a username that resolves — that is, to a classmate, who could learn the same
     * name by confirming. It buys a student the chance to notice `1.11` was not `1.1` *before*
     * they are looking at a stranger's assessment.
     */
    if (input.confirm !== true) {
      return {
        confirmed: false,
        studentName: student.name,
        classRoom,
        username,
        activeSession: await hasActiveToken(this.db, student.id),
      };
    }

    // **Step two: the takeover, now that somebody has asked for it.** Still one active session per
    // student (ratified v1.2) — a machine left signed in at the back of the lab stops being a way
    // in the moment its owner signs in somewhere else — but the eviction is no longer silent at
    // either end: the arriving student was warned on the confirmation screen, and the count below
    // puts it in the audit trail for whoever has to explain it afterwards.
    const displaced = await revokeAllTokensForUser(this.db, student.id);

    const { plaintext } = await issueToken(this.db, student.id, studentTokenTtlHours(this.env));

    await this.audit.write({
      action: 'STUDENT_CLASS_ACCESS_SUCCESS',
      module: MODULE,
      userId: student.id,
      targetType: 'class',
      targetId: classRoom.id,
      // `displaced_session` is the field the September incident needed and did not have: a
      // sign-in that ended somebody else's session reads as one in the trail, without a join
      // against `api_tokens` that no longer holds the evidence by the time anyone looks.
      newValues: { username, displaced_session: displaced > 0 },
      ipAddress,
    });

    return { confirmed: true, user: student, classRoom, username, token: plaintext };
  }

  /**
   * Charge the failure, record *why* in the audit trail, and return the generic 401.
   *
   * Every rejection above funnels through here precisely so that no caller can accidentally
   * invent a more helpful error. The `reason` is the operator's; the response is everyone's.
   */
  private async reject(
    reason: JoinFailureReason,
    guard: DurableObjectStub<AuthGuardDO>,
    attempt: { classCode: string; username: string },
    classId: string | null,
    studentId: string | null,
    ipAddress: string | null,
  ): Promise<never> {
    const failure = await guard.recordFailure(
      JOIN_THROTTLE_LIMIT,
      JOIN_THROTTLE_WINDOW_SECONDS,
    );

    await this.audit.write({
      action: 'STUDENT_CLASS_ACCESS_FAILED',
      module: MODULE,
      userId: studentId,
      targetType: classId ? 'class' : null,
      targetId: classId,
      newValues: {
        reason,
        class_code: attempt.classCode,
        username: attempt.username,
        attempts: failure.attempts,
      },
      ipAddress,
    });

    if (failure.locked) {
      // M3: this is the failure that tripped the throttle — the first (and only) locked state in
      // this window that reaches a code path at all, since every subsequent attempt is refused at
      // the top `check()` above. Log the throttle once, here.
      await this.audit.write({
        action: 'STUDENT_CLASS_ACCESS_THROTTLED',
        module: MODULE,
        userId: studentId,
        targetType: classId ? 'class' : null,
        targetId: classId,
        newValues: { class_code: attempt.classCode, username: attempt.username },
        ipAddress,
      });

      throw ApiError.tooManyRequests({
        class_code: [
          `Too many failed attempts. Try again in ${failure.retryAfterSeconds} seconds.`,
        ],
      });
    }

    throw accessDenied();
  }
}
