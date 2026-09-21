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

/**
 * Two calls, one endpoint (see `StudentAccessService` for why a join is two acts now).
 *
 * Without `confirm`, the response is a **confirmation request**: whose account this is, and
 * whether signing in will end somebody else's session. With it, the response is the session.
 * `confirmation_required` is the discriminator the client switches on, present in both shapes so
 * that reading it never depends on a field's absence.
 */
studentAccessRoutes.post('/join', async (c) => {
  const input = await parseBody(c, joinClassSchema);

  const result = await new StudentAccessService(createDatabase(c.env.DB), c.env).join(
    input,
    clientIp(c),
  );

  // `serializeClassSummary`, never `serializeClass`: the join code is a shared secret and does
  // not travel back out through a student-facing response (§38). True of both branches.
  const classSummary = serializeClassSummary(result.classRoom);

  if (!result.confirmed) {
    return c.json(
      successEnvelope(
        {
          confirmation_required: true,
          // The name, and deliberately not the serialized user: the caller has proved they know a
          // class code and a username, not that they are the person those belong to. Everything
          // else about the account waits until they confirm and get a token.
          student_name: result.studentName,
          class: classSummary,
          username: result.username,
          active_session: result.activeSession,
        },
        'Confirm that this is you.',
      ),
    );
  }

  return c.json(
    successEnvelope(
      {
        confirmation_required: false,
        user: serializeUser(result.user),
        class: classSummary,
        username: result.username,
        token: result.token,
      },
      'Access granted.',
    ),
  );
});
