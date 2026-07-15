import { Hono, type Context } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody, parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AcademicCatalogService } from '@/modules/catalog/academic-catalog-service';
import {
  attachCareerSchema,
  createCareerSchema,
  createCollegeSchema,
  createProgramSchema,
  listCatalogQuerySchema,
  updateCareerSchema,
  updateCollegeSchema,
  updateProgramSchema,
} from '@/modules/catalog/schemas';
import {
  serializeCareer,
  serializeCollege,
  serializeProgram,
} from '@/modules/catalog/serializers';

/**
 * The `/admin` route group (FULLPLAN §20) — its first mount, and for now the academic catalog
 * is all of it.
 *
 * **Authorization is one layer here, not two.** In the counselor group, `ensureRole` is the
 * coarse gate in front of `ClassPolicy`'s ownership check — a counselor may touch only their
 * own classes. The catalog has no such dimension: a college belongs to nobody. It is global
 * reference data and `admin` is the entire rule, which is why §39 names no catalog policy.
 *
 * The consequence is that **this route group is the only thing standing between a new catalog
 * endpoint and a counselor who can edit the catalog.** There is no second net inside the
 * Service. A counselor gets a flat 403 on every endpoint below — not a 404, not a filtered
 * list: the catalog is admin-managed (§5), and a counselor editing the college list would be
 * editing what every other counselor's students get recommended.
 *
 * `test/catalog/authorization.test.ts` is load-bearing for exactly that reason. It is not
 * belt-and-braces; it is the net.
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', authenticate());
adminRoutes.use('*', ensureRole('admin'));
adminRoutes.use('*', ensurePasswordChanged());

function catalog(c: { env: AppEnv['Bindings'] }): AcademicCatalogService {
  return new AcademicCatalogService(createDatabase(c.env.DB));
}

/** `per_page` over the §20 clamp of 100 is a 422, not a 500 — see `lib/validation.ts`. */
function listQuery(c: Context<AppEnv>) {
  return parseQuery(c, listCatalogQuerySchema, ['page', 'per_page']);
}

// --- Colleges --------------------------------------------------------------------------

adminRoutes.get('/colleges', async (c) => {
  const query = listQuery(c);
  const page = await catalog(c).listColleges(query.page, query.per_page);

  return c.json(
    successEnvelope(
      {
        items: page.items.map((row) =>
          serializeCollege(row.college, { programsCount: row.programsCount }),
        ),
        pagination: page.pagination,
      },
      'Colleges retrieved successfully.',
    ),
  );
});

adminRoutes.post('/colleges', async (c) => {
  const input = await parseBody(c, createCollegeSchema);
  const college = await catalog(c).createCollege(requireUser(c), input, clientIp(c));

  return c.json(successEnvelope(serializeCollege(college), 'College created successfully.'), 201);
});

/**
 * The nested view: one institution and everything it offers — **including each program's
 * linked careers**. The mapping is what makes a program scoreable at all (§27), so a view
 * that stopped at the program name would hide the only field that decides whether the program
 * can be recommended.
 */
adminRoutes.get('/colleges/:id', async (c) => {
  const service = catalog(c);
  const college = await service.findCollege(c.req.param('id'));
  const rows = await service.listPrograms(college.id);

  return c.json(
    successEnvelope(
      serializeCollege(college, {
        programs: rows.map((row) => serializeProgram(row.program, row.careers)),
      }),
      'College retrieved successfully.',
    ),
  );
});

adminRoutes.patch('/colleges/:id', async (c) => {
  const input = await parseBody(c, updateCollegeSchema);
  const college = await catalog(c).updateCollege(
    requireUser(c),
    c.req.param('id'),
    input,
    clientIp(c),
  );

  return c.json(successEnvelope(serializeCollege(college), 'College updated successfully.'));
});

/** Soft delete, cascading to the college's programs (§20). 204. */
adminRoutes.delete('/colleges/:id', async (c) => {
  await catalog(c).removeCollege(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});

// --- Programs --------------------------------------------------------------------------
//
// Created and listed **under their college**, edited and deleted **by their own id**. That
// asymmetry is §20's, and it is right: a program cannot exist without a college, but once it
// does, it has an identity of its own. Mirror the contract rather than tidying it.

adminRoutes.get('/colleges/:collegeId/programs', async (c) => {
  const rows = await catalog(c).listPrograms(c.req.param('collegeId'));

  return c.json(
    successEnvelope(
      rows.map((row) => serializeProgram(row.program, row.careers)),
      'Programs retrieved successfully.',
    ),
  );
});

adminRoutes.post('/colleges/:collegeId/programs', async (c) => {
  const input = await parseBody(c, createProgramSchema);

  const program = await catalog(c).createProgram(
    requireUser(c),
    c.req.param('collegeId'),
    input,
    clientIp(c),
  );

  return c.json(successEnvelope(serializeProgram(program, []), 'Program created successfully.'), 201);
});

adminRoutes.patch('/programs/:id', async (c) => {
  const input = await parseBody(c, updateProgramSchema);
  const program = await catalog(c).updateProgram(
    requireUser(c),
    c.req.param('id'),
    input,
    clientIp(c),
  );

  return c.json(successEnvelope(serializeProgram(program), 'Program updated successfully.'));
});

adminRoutes.delete('/programs/:id', async (c) => {
  await catalog(c).removeProgram(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});

// --- Careers ---------------------------------------------------------------------------
//
// Global, not nested under a college — the same "Software Engineer" is the destination of
// programs at many institutions, which is exactly what `program_careers` exists to express.

adminRoutes.get('/careers', async (c) => {
  const query = listQuery(c);
  const page = await catalog(c).listCareers(query.page, query.per_page);

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeCareer), pagination: page.pagination },
      'Careers retrieved successfully.',
    ),
  );
});

adminRoutes.post('/careers', async (c) => {
  const input = await parseBody(c, createCareerSchema);
  const career = await catalog(c).createCareer(requireUser(c), input, clientIp(c));

  return c.json(successEnvelope(serializeCareer(career), 'Career created successfully.'), 201);
});

adminRoutes.patch('/careers/:id', async (c) => {
  const input = await parseBody(c, updateCareerSchema);
  const career = await catalog(c).updateCareer(
    requireUser(c),
    c.req.param('id'),
    input,
    clientIp(c),
  );

  return c.json(successEnvelope(serializeCareer(career), 'Career updated successfully.'));
});

adminRoutes.delete('/careers/:id', async (c) => {
  await catalog(c).removeCareer(requireUser(c), c.req.param('id'), clientIp(c));

  return c.body(null, 204);
});

// --- The mapping -----------------------------------------------------------------------
//
// Both calls return the **updated program with its careers**, so the caller never has to
// refetch to redraw the mapping (the frontend's `attachCareer`/`detachCareer` rely on it).

adminRoutes.post('/programs/:id/careers', async (c) => {
  const input = await parseBody(c, attachCareerSchema);

  const { program, careers } = await catalog(c).attachCareer(
    requireUser(c),
    c.req.param('id'),
    input.career_id,
    clientIp(c),
  );

  return c.json(
    successEnvelope(serializeProgram(program, careers), 'Career linked successfully.'),
    201,
  );
});

/** A **real** delete, not a soft one — and a 200 with the updated program, not a 204 (§20). */
adminRoutes.delete('/programs/:id/careers/:careerId', async (c) => {
  const { program, careers } = await catalog(c).detachCareer(
    requireUser(c),
    c.req.param('id'),
    c.req.param('careerId'),
    clientIp(c),
  );

  return c.json(successEnvelope(serializeProgram(program, careers), 'Career unlinked successfully.'));
});
