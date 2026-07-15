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
import { issueToken, revokeAllTokensForUser } from '@/lib/tokens';
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

export interface JoinResult {
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

  async join(input: JoinClassInput, ipAddress: string | null): Promise<JoinResult> {
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
      await this.audit.write({
        action: 'STUDENT_CLASS_ACCESS_THROTTLED',
        module: MODULE,
        userId: null,
        newValues: { class_code: classCode, username },
        ipAddress,
      });

      throw ApiError.tooManyRequests({
        class_code: [`Too many failed attempts. Try again in ${throttle.retryAfterSeconds} seconds.`],
      });
    }

    const classRoom = await this.db.query.classes.findFirst({
      where: and(eq(classes.joinCode, classCode), isNull(classes.deletedAt)),
    });

    if (!classRoom) {
      return this.reject('INVALID_CODE', guard, { classCode, username }, null, null, ipAddress);
    }

    if (isExpired(classRoom.joinCodeExpiresAt)) {
      return this.reject('CODE_EXPIRED', guard, { classCode, username }, classRoom.id, null, ipAddress);
    }

    if (classRoom.status !== 'active') {
      return this.reject('CLASS_NOT_ACTIVE', guard, { classCode, username }, classRoom.id, null, ipAddress);
    }

    const enrollment = await this.db.query.classStudents.findFirst({
      where: and(eq(classStudents.classId, classRoom.id), eq(classStudents.username, username)),
    });

    if (!enrollment) {
      return this.reject('UNKNOWN_USERNAME', guard, { classCode, username }, classRoom.id, null, ipAddress);
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

    // A join replaces the student's prior token (ratified v1.2): one active session, so a
    // machine left signed in at the back of the lab stops being a way in the moment its owner
    // signs in somewhere else.
    await revokeAllTokensForUser(this.db, student.id);

    const { plaintext } = await issueToken(this.db, student.id, studentTokenTtlHours(this.env));

    await guard.clear();

    await this.audit.write({
      action: 'STUDENT_CLASS_ACCESS_SUCCESS',
      module: MODULE,
      userId: student.id,
      targetType: 'class',
      targetId: classRoom.id,
      newValues: { username },
      ipAddress,
    });

    return { user: student, classRoom, username, token: plaintext };
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
      throw ApiError.tooManyRequests({
        class_code: [`Too many failed attempts. Try again in ${failure.retryAfterSeconds} seconds.`],
      });
    }

    throw accessDenied();
  }
}
