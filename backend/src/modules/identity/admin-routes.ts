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
  type CounselorView,
} from '@/modules/identity/counselor-management-service';
import {
  createCounselorSchema,
  listCounselorsQuerySchema,
  updateCounselorSchema,
} from '@/modules/identity/schemas';
import { serializeUser, type SerializedUser } from '@/modules/identity/serializers';

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

adminIdentityRoutes.patch('/counselors/:id', async (c) => {
  const input = await parseBody(c, updateCounselorSchema);

  const view = await service(c).update(requireUser(c), c.req.param('id'), input, clientIp(c));

  return c.json(successEnvelope(serializeCounselor(view), 'Counselor updated successfully.'));
});

adminIdentityRoutes.delete('/counselors/:id', async (c) => {
  await service(c).remove(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});
