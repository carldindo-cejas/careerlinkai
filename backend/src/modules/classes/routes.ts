import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody, parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { ClassEnrollmentService } from '@/modules/classes/class-enrollment-service';
import { ClassService } from '@/modules/classes/class-service';
import {
  confirmRosterSchema,
  createClassSchema,
  listClassesQuerySchema,
  previewRosterSchema,
  updateClassSchema,
} from '@/modules/classes/schemas';
import { serializeClass } from '@/modules/classes/serializers';

/**
 * Counselor class + roster routes (FULLPLAN §20).
 *
 * The first route group mounted behind the full middleware stack: `authenticate` →
 * `ensureRole` (the coarse gate, §39) → `ensurePasswordChanged` (a temp password buys a token
 * that must open nothing but its own rotation, §38). Ownership — "is this *your* class" — is
 * the policy's job, inside the Service, because it needs to see the record.
 */
export const counselorRoutes = new Hono<AppEnv>();

counselorRoutes.use('*', authenticate());
counselorRoutes.use('*', ensureRole('counselor', 'admin'));
counselorRoutes.use('*', ensurePasswordChanged());

function classService(c: { env: AppEnv['Bindings'] }): ClassService {
  return new ClassService(createDatabase(c.env.DB), c.env);
}

function enrollmentService(c: { env: AppEnv['Bindings'] }): ClassEnrollmentService {
  const db = createDatabase(c.env.DB);

  return new ClassEnrollmentService(db, new ClassService(db, c.env));
}

// --- Classes -------------------------------------------------------------------------

counselorRoutes.get('/classes', async (c) => {
  // Through `parseQuery`, not a bare `.parse()`: an out-of-range `per_page` is a client
  // mistake and must answer 422, not 500 (see lib/validation.ts).
  const query = parseQuery(c, listClassesQuerySchema, ['page', 'per_page']);

  const page = await classService(c).list(requireUser(c), query.page, query.per_page);

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeClass), pagination: page.pagination },
      'Classes retrieved successfully.',
    ),
  );
});

counselorRoutes.post('/classes', async (c) => {
  const input = await parseBody(c, createClassSchema);
  const classRoom = await classService(c).create(requireUser(c), input, clientIp(c));

  return c.json(
    successEnvelope(serializeClass(classRoom), 'Class created successfully.'),
    201,
  );
});

counselorRoutes.get('/classes/:id', async (c) => {
  const classRoom = await classService(c).find(requireUser(c), c.req.param('id'));

  return c.json(successEnvelope(serializeClass(classRoom), 'Class retrieved successfully.'));
});

counselorRoutes.patch('/classes/:id', async (c) => {
  const input = await parseBody(c, updateClassSchema);
  const classRoom = await classService(c).update(
    requireUser(c),
    c.req.param('id'),
    input,
    clientIp(c),
  );

  return c.json(successEnvelope(serializeClass(classRoom), 'Class updated successfully.'));
});

counselorRoutes.delete('/classes/:id', async (c) => {
  await classService(c).remove(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});

counselorRoutes.post('/classes/:id/regenerate-code', async (c) => {
  const classRoom = await classService(c).regenerateCode(
    requireUser(c),
    c.req.param('id'),
    clientIp(c),
  );

  return c.json(
    successEnvelope(serializeClass(classRoom), 'Join code regenerated successfully.'),
  );
});

// --- Roster --------------------------------------------------------------------------

counselorRoutes.get('/classes/:id/students', async (c) => {
  const roster = await enrollmentService(c).roster(requireUser(c), c.req.param('id'));

  return c.json(successEnvelope(roster, 'Roster retrieved successfully.'));
});

/** Proposes usernames. Persists nothing — the counselor edits this list and sends it back. */
counselorRoutes.post('/classes/:id/students/preview', async (c) => {
  const input = await parseBody(c, previewRosterSchema);

  const students = await enrollmentService(c).previewUsernames(
    requireUser(c),
    c.req.param('id'),
    input,
  );

  return c.json(successEnvelope({ students }, 'Usernames previewed successfully.'));
});

counselorRoutes.post('/classes/:id/students/confirm', async (c) => {
  const input = await parseBody(c, confirmRosterSchema);

  const roster = await enrollmentService(c).confirmEnrollment(
    requireUser(c),
    c.req.param('id'),
    input,
    clientIp(c),
  );

  return c.json(successEnvelope(roster, 'Students enrolled successfully.'), 201);
});

/** `:studentId` is the student's **user** id, not the enrollment id (§20). */
counselorRoutes.delete('/classes/:id/students/:studentId', async (c) => {
  await enrollmentService(c).removeStudent(
    requireUser(c),
    c.req.param('id'),
    c.req.param('studentId'),
    clientIp(c),
  );

  return c.body(null, 204);
});
