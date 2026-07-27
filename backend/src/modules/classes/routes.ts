import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import { gradeLevels, shsStrands } from '@/db/schema';
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

/**
 * `GET /counselor/class-options` — the grade-level and strand lookups the class form picks from
 * (migration 0017).
 *
 * The same two reference tables the student's `/student/profile/options` serves, exposed again
 * here because the two routers are role-gated separately and a counselor cannot call a `/student`
 * route. Duplicating the *route* rather than the data: both read the same tables, so the dropdown
 * a counselor sets a class from and the one a student sees cannot offer different values.
 *
 * These are the **source** of every enrolled student's own two fields, which is why the class form
 * gained a picker rather than keeping its free-text box: "Gr 12" typed into a text input produced
 * a profile field §27 could not read and a student could not correct.
 */
counselorRoutes.get('/class-options', async (c) => {
  const db = createDatabase(c.env.DB);
  const [levels, strands] = await Promise.all([
    db.select().from(gradeLevels).orderBy(gradeLevels.orderNumber),
    db.select().from(shsStrands).orderBy(shsStrands.orderNumber),
  ]);

  return c.json(
    successEnvelope(
      {
        grade_levels: levels.map((row) => ({ id: row.id, code: row.code, name: row.name })),
        shs_strands: strands.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
        })),
      },
      'Class options retrieved successfully.',
    ),
  );
});

// --- Classes -------------------------------------------------------------------------

counselorRoutes.get('/classes', async (c) => {
  // Through `parseQuery`, not a bare `.parse()`: an out-of-range `per_page` is a client
  // mistake and must answer 422, not 500 (see lib/validation.ts).
  const query = parseQuery(c, listClassesQuerySchema, ['page', 'per_page']);

  const page = await classService(c).list(requireUser(c), query.page, query.per_page);

  return c.json(
    successEnvelope(
      { items: page.items.map((row) => serializeClass(row)), pagination: page.pagination },
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
