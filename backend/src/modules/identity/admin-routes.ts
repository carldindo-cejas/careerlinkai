import { Hono, type Context } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody, parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import {
  CounselorManagementService,
  type CounselorStudentView,
  type CounselorView,
} from '@/modules/identity/counselor-management-service';
import {
  createCounselorSchema,
  listCounselorsQuerySchema,
  updateCounselorSchema,
} from '@/modules/identity/schemas';
import { serializeUser, type SerializedUser } from '@/modules/identity/serializers';
import {
  serializeCareerRecommendation,
  serializeProgramRecommendation,
} from '@/modules/recommendation/serializers';

/** The top five is what the table expands to; the engine ranks ten, so slice here (§27). */
const TOP_RECOMMENDATIONS = 5;

/**
 * One student row of the counselor detail page: the profile signals the table columns show, the
 * latest Holland Code, and the top-five career/program recommendations the row expands to reveal.
 * The catalog rows inside are serialized by the recommendation module's own serializers — the same
 * "borrow the shape of the thing being recommended" rule (§10).
 */
function serializeCounselorStudent(student: CounselorStudentView) {
  const set = student.recommendations;

  return {
    id: student.id,
    name: student.name,
    grade_level: student.gradeLevel,
    strand: student.strand,
    holland_code: student.hollandCode,
    top_careers: (set?.careers ?? []).slice(0, TOP_RECOMMENDATIONS).map(serializeCareerRecommendation),
    top_programs: (set?.programs ?? [])
      .slice(0, TOP_RECOMMENDATIONS)
      .map(serializeProgramRecommendation),
  };
}

/**
 * The Identity module's `/admin` router (FULLPLAN §20 "Counselor management", Phase 6) —
 * the same one-module-one-router rule as every other `/admin` mount.
 *
 * No policy runs inside the service, same reasoning as the catalog (§39 names no policy for
 * this group): "admin manages counselors" is the entire rule, and the route gate *is* it.
 */

export const adminIdentityRoutes = new Hono<AppEnv>();

adminIdentityRoutes.use('*', authenticate());
adminIdentityRoutes.use('*', ensureRole('admin'));
adminIdentityRoutes.use('*', ensurePasswordChanged());

function service(c: Context<AppEnv>): CounselorManagementService {
  return new CounselorManagementService(createDatabase(c.env.DB), c.env);
}

/** The list row: the standard user shape plus the counselor's operational footprint. */
function serializeCounselor(view: CounselorView): SerializedUser & {
  classes_count: number;
  students_count: number;
} {
  return {
    ...serializeUser(view.user, view.profile),
    classes_count: view.classesCount,
    students_count: view.studentsCount,
  };
}

adminIdentityRoutes.get('/counselors', async (c) => {
  const query = parseQuery(c, listCounselorsQuerySchema, ['page', 'per_page', 'search', 'status']);

  const page = await service(c).list({
    page: query.page,
    perPage: query.per_page,
    search: query.search,
    status: query.status,
  });

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeCounselor), pagination: page.pagination },
      'Counselors retrieved successfully.',
    ),
  );
});

/**
 * `POST /admin/counselors` — the one response in the system that carries a plaintext
 * password. It is generated, shown exactly once, already flagged `must_change_password`,
 * and dies at the counselor's first login (§13.1). It is never logged and never retrievable.
 */
adminIdentityRoutes.post('/counselors', async (c) => {
  const input = await parseBody(c, createCounselorSchema);

  const { view, temporaryPassword } = await service(c).create(requireUser(c), input, clientIp(c));

  return c.json(
    successEnvelope(
      { ...serializeCounselor(view), temporary_password: temporaryPassword },
      'Counselor account created. Share the temporary password securely — it is shown only once.',
    ),
    201,
  );
});

/**
 * `GET /admin/counselors/{id}/students` (prompt-driven) — the counselor detail page: every student
 * enrolled in one of this counselor's classes, with their Holland Code and top recommendations.
 *
 * Admin-only like the rest of this group; a non-counselor id 404s (the service's `find`). Unlike the
 * counselor's *own* `/counselor/students/{id}/recommendations`, no per-student ownership check is
 * needed here — an admin may see every student, and the roster is scoped to *this counselor's*
 * classes by the query itself.
 */
adminIdentityRoutes.get('/counselors/:id/students', async (c) => {
  const { user, profile, students } = await service(c).studentsFor(c.req.param('id'));

  return c.json(
    successEnvelope(
      {
        counselor: {
          id: user.id,
          name: user.name,
          email: user.email,
          specialization: profile.specialization,
        },
        students: students.map(serializeCounselorStudent),
      },
      'Counselor students retrieved successfully.',
    ),
  );
});

adminIdentityRoutes.patch('/counselors/:id', async (c) => {
  const input = await parseBody(c, updateCounselorSchema);

  const view = await service(c).update(requireUser(c), c.req.param('id'), input, clientIp(c));

  return c.json(successEnvelope(serializeCounselor(view), 'Counselor updated successfully.'));
});

/**
 * `POST /admin/counselors/{id}/reset-password` (audit C2) — **the staff account recovery path.**
 *
 * The second and last response in the system that carries a plaintext password, and it exists
 * because there was previously no way at all for a counselor who forgot theirs to get back in:
 * `/auth/forgot-password` withholds its token outside `local`, the token is stored only as a hash
 * so nobody can read it out, and v1 has no email channel to send it through (deviation D7). The
 * failure was total and silent — the forgot-password screen promised an administrator could supply
 * a code that no administrator could obtain.
 *
 * Same contract as `POST /counselors`: generated, shown once, never logged, never retrievable,
 * and already flagged `must_change_password` so it dies at first use. See the service method for
 * why every session is revoked and both DO counters are cleared.
 */
adminIdentityRoutes.post('/counselors/:id/reset-password', async (c) => {
  const { view, temporaryPassword } = await service(c).resetPassword(
    requireUser(c),
    c.req.param('id'),
    clientIp(c),
  );

  return c.json(
    successEnvelope(
      { ...serializeCounselor(view), temporary_password: temporaryPassword },
      'Password reset. Share the temporary password securely — it is shown only once, and they must change it at next sign-in.',
    ),
  );
});

adminIdentityRoutes.delete('/counselors/:id', async (c) => {
  await service(c).remove(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});
