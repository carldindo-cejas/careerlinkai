import type { ClassRoom, User } from '@/db/schema';
import { ApiError } from '@/lib/envelope';

/**
 * Class authorization — the fine layer of the two-level model (FULLPLAN §39).
 *
 * `ensureRole('counselor', 'admin')` is the coarse gate and answers "may this *kind* of user
 * touch classes at all". This answers "may this user touch *this* class", which a middleware
 * cannot: it has to see the record.
 *
 * Plain functions, not a class — a policy has no state and nothing to inject (§39, v1.3).
 */

/** An admin sees every class; a counselor sees only their own. */
export function canViewClass(user: User, classRoom: ClassRoom): boolean {
  return user.role === 'admin' || classRoom.counselorId === user.id;
}

/** Same rule for writes in v1: there is no read-only-collaborator role to distinguish. */
export function canManageClass(user: User, classRoom: ClassRoom): boolean {
  return canViewClass(user, classRoom);
}

/**
 * Throw unless the caller may act on this class.
 *
 * **404, not 403** (§19, `docs/api`): a 403 would confirm the class exists, which is a fact a
 * counselor is not entitled to about a colleague's class. "Not yours" and "not real" have to
 * be indistinguishable from the outside, so they return the same thing.
 */
export function authorizeClass(user: User, classRoom: ClassRoom | undefined): ClassRoom {
  if (classRoom?.deletedAt !== null || !canManageClass(user, classRoom)) {
    throw ApiError.notFound('Class not found.');
  }

  return classRoom;
}
