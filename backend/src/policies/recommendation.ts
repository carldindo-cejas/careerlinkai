import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { classStudents, classes, type User } from '@/db/schema';
import { ApiError } from '@/lib/envelope';

/**
 * Recommendation authorization (FULLPLAN §39) — the fine layer.
 *
 * The student side needs **no policy at all**, and that is a property of the route shape rather
 * than an omission: every `/student/*` route means *mine*, resolved from the bearer token. There is
 * no student id anywhere in a student-facing URL, so a route that means "my recommendations" cannot
 * be made to mean "someone else's" by editing a parameter. The best access-control bug is the one
 * that has nowhere to live.
 *
 * The **counselor** side is where a policy is unavoidable. `GET /counselor/students/{id}/
 * recommendations` names another human being in the URL, and §4 is explicit that a counselor sees
 * "results and recommendations for their own students only". A counselor is not entitled to a
 * colleague's student's Holland Code.
 *
 * Unlike `policies/class.ts` this needs the database, because ownership is not a column on the
 * record being fetched — it is a fact about a *relationship* (does this student sit in any class
 * this counselor owns?), and that is one join away no matter how it is phrased.
 */

/**
 * Throw unless the caller may read this student's recommendations.
 *
 * **404, not 403**, for the same reason `policies/class.ts` chose 404: a 403 confirms the student
 * exists, and "that student is not in your classes" and "that student id is not real" must be
 * indistinguishable from the outside. A counselor who can enumerate student ids by watching the
 * status code has been handed a roster they were never given.
 *
 * An admin passes unconditionally (§4 — the admin's scope is the institution).
 *
 * The enrollment must be **`active`**: removing a student from a class revokes their live tokens in
 * the same act (audit F-H3), and it must also end the counselor's access to them. A counselor who
 * removed a student last term should not still be reading their recommendations this term — the
 * removal was the point.
 */
export async function authorizeStudentRecommendations(
  db: Database,
  user: User,
  studentId: string,
): Promise<void> {
  if (user.role === 'admin') {
    return;
  }

  const rows = await db
    .select({ id: classStudents.id })
    .from(classStudents)
    .innerJoin(classes, eq(classStudents.classId, classes.id))
    .where(
      and(
        eq(classStudents.studentId, studentId),
        eq(classStudents.status, 'active'),
        eq(classes.counselorId, user.id),
        // A soft-deleted class is not a class. Its roster rows survive — `class_students` *is* the
        // enrollment history and is deliberately never purged — so without this a counselor keeps
        // read access to every student who was ever in a class they later deleted.
        isNull(classes.deletedAt),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw ApiError.notFound('Student not found.');
  }
}
