import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody } from '@/lib/validation';
import { serializeClassSummary } from '@/modules/classes/serializers';
import { joinClassSchema } from '@/modules/identity/schemas';
import { serializeUser } from '@/modules/identity/serializers';
import { StudentAccessService } from '@/modules/identity/student-access-service';

/**
 * `POST /student-access/join` (FULLPLAN §38) — its own router, not a branch inside
 * `/auth` (§16).
 *
 * The only endpoint in the system reachable without a token. The split from staff auth is
 * architectural: these two flows should never grow a shared code path, because the moment
 * they do, a change made for one of them starts silently applying to the other.
 */
export const studentAccessRoutes = new Hono<AppEnv>();

studentAccessRoutes.post('/join', async (c) => {
  const input = await parseBody(c, joinClassSchema);

  const { user, classRoom, username, token } = await new StudentAccessService(
    createDatabase(c.env.DB),
    c.env,
  ).join(input, clientIp(c));

  return c.json(
    successEnvelope(
      {
        user: serializeUser(user),
        // `serializeClassSummary`, never `serializeClass`: the join code is a shared secret
        // and does not travel back out through a student-facing response (§38).
        class: serializeClassSummary(classRoom),
        username,
        token,
      },
      'Access granted.',
    ),
  );
});
