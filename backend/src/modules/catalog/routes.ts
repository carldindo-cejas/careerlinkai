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
  createCanonicalProgramSchema,
  createCareerSchema,
  createCollegeSchema,
  createProgramSchema,
  listCanonicalProgramQuerySchema,
  listCatalogQuerySchema,
  LIST_CATALOG_QUERY_KEYS,
  mergeCanonicalProgramSchema,
  updateCanonicalProgramSchema,
  updateCareerSchema,
  updateCollegeSchema,
  updateProgramSchema,
} from '@/modules/catalog/schemas';
import {
  serializeCanonicalProgram,
  serializeCareer,
  serializeCollege,
  serializeEmploymentOutlook,
  serializeProgram,
} from '@/modules/catalog/serializers';
import type { Career } from '@/db/schema';

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

/**
 * `per_page` over the §20 clamp of 100 is a 422, not a 500 — see `lib/validation.ts`. So is a
 * `?sort=` naming a column that is not on the allow-list, which is the point of having one.
 */
function listQuery(c: Context<AppEnv>) {
  return parseQuery(c, listCatalogQuerySchema, [...LIST_CATALOG_QUERY_KEYS]);
}

/** The same query with `code` added to the sort allow-list — see `listCanonicalProgramQuerySchema`. */
function canonicalListQuery(c: Context<AppEnv>) {
  return parseQuery(c, listCanonicalProgramQuerySchema, [...LIST_CATALOG_QUERY_KEYS]);
}

/**
 * Serialize one career with its employment-outlook name resolved (migration 0013). The lookup is
 * four rows, so fetching it whole to name one career's outlook is cheaper than a targeted join.
 */
async function serializeCareerWithOutlook(
  service: AcademicCatalogService,
  career: Career,
): Promise<ReturnType<typeof serializeCareer>> {
  const outlooks = await service.outlooksById();

  return serializeCareer(career, {
    outlook: career.employmentOutlookId
      ? (outlooks.get(career.employmentOutlookId) ?? null)
      : null,
  });
}

// --- Colleges --------------------------------------------------------------------------

adminRoutes.get('/colleges', async (c) => {
  const query = listQuery(c);
  const service = catalog(c);
  const page = await service.listColleges(query);

  // One query per address level for the whole page, not one per college (§20's N+1 rule).
  const locations = await service.resolveLocations(page.items.map((row) => row.college));

  return c.json(
    successEnvelope(
      {
        items: page.items.map((row) =>
          serializeCollege(row.college, {
            programsCount: row.programsCount,
            location: locations.get(row.college.id),
          }),
        ),
        pagination: page.pagination,
      },
      'Colleges retrieved successfully.',
    ),
  );
});

adminRoutes.post('/colleges', async (c) => {
  const input = await parseBody(c, createCollegeSchema);
  const service = catalog(c);
  const college = await service.createCollege(requireUser(c), input, clientIp(c));
  const location = await service.resolveLocation(college);

  return c.json(
    successEnvelope(serializeCollege(college, { location }), 'College created successfully.'),
    201,
  );
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
  const location = await service.resolveLocation(college);

  return c.json(
    successEnvelope(
      serializeCollege(college, {
        location,
        programs: rows.map((row) => serializeProgram(row.program, row.careers)),
      }),
      'College retrieved successfully.',
    ),
  );
});

adminRoutes.patch('/colleges/:id', async (c) => {
  const input = await parseBody(c, updateCollegeSchema);
  const service = catalog(c);
  const college = await service.updateCollege(requireUser(c), c.req.param('id'), input, clientIp(c));
  const location = await service.resolveLocation(college);

  return c.json(
    successEnvelope(serializeCollege(college, { location }), 'College updated successfully.'),
  );
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

/**
 * The employment-outlook lookup that populates the careers dropdown (migration 0013). Read-only:
 * the four values are seeded reference data, not something the admin edits one at a time.
 */
adminRoutes.get('/employment-outlooks', async (c) => {
  const outlooks = await catalog(c).listEmploymentOutlooks();

  return c.json(
    successEnvelope(
      outlooks.map(serializeEmploymentOutlook),
      'Employment outlooks retrieved successfully.',
    ),
  );
});

adminRoutes.get('/careers', async (c) => {
  const query = listQuery(c);
  const service = catalog(c);
  const page = await service.listCareers(query);

  // The four-row outlook lookup, fetched once, names every career's outlook without a per-row query.
  const outlooks = await service.outlooksById();

  return c.json(
    successEnvelope(
      {
        items: page.items.map((career) =>
          serializeCareer(career, {
            outlook: career.employmentOutlookId
              ? (outlooks.get(career.employmentOutlookId) ?? null)
              : null,
          }),
        ),
        pagination: page.pagination,
      },
      'Careers retrieved successfully.',
    ),
  );
});

adminRoutes.post('/careers', async (c) => {
  const input = await parseBody(c, createCareerSchema);
  const service = catalog(c);
  const career = await service.createCareer(requireUser(c), input, clientIp(c));

  return c.json(
    successEnvelope(await serializeCareerWithOutlook(service, career), 'Career created successfully.'),
    201,
  );
});

adminRoutes.patch('/careers/:id', async (c) => {
  const input = await parseBody(c, updateCareerSchema);
  const service = catalog(c);
  const career = await service.updateCareer(requireUser(c), c.req.param('id'), input, clientIp(c));

  return c.json(
    successEnvelope(await serializeCareerWithOutlook(service, career), 'Career updated successfully.'),
  );
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

// --- The canonical program catalog (migration 0018) ---------------------------------------
//
// `/admin/canonical-programs` — the screen that owns the grouping the 0018 backfill guessed at.
// It exists because the backfill *is* a guess: it groups on the normalized code, and where two
// colleges use one code for different programs (or two codes for one), an admin needs somewhere to
// say so. Without this page the FK would be a column nobody could correct.

adminRoutes.get('/canonical-programs', async (c) => {
  const query = canonicalListQuery(c);
  const service = catalog(c);
  const page = await service.listCanonicalPrograms(query);

  // The offering counts, in one query for the whole page rather than one per row — the same
  // N+1 rule the college list follows (§45's subrequest budget counts every D1 call).
  const counts = await service.offeringCountsFor(page.items.map((entry) => entry.id));

  return c.json(
    successEnvelope(
      {
        items: page.items.map((entry) =>
          serializeCanonicalProgram(entry, { offeringsCount: counts.get(entry.id) ?? 0 }),
        ),
        pagination: page.pagination,
      },
      'Canonical programs retrieved successfully.',
    ),
  );
});

/**
 * The canonical-entry typeahead — `?search=`, capped at `CANONICAL_OPTION_LIMIT`.
 *
 * It was "the unpaginated picker for the program form's combobox", which was untrue twice over:
 * the program form never called it (this endpoint had **no frontend caller at all** — the F1/F2
 * defect class the plan opens with), and unpaginated over a table the 0018 backfill grows on every
 * unseen programme code is a response with no ceiling. It now has one caller, the merge target
 * picker, and a bound.
 *
 * The offerings count comes with it, in one query for the whole page rather than one per row (§20's
 * N+1 rule). It is not decoration here: the picker sits in front of a **merge**, and "12 offerings"
 * against a candidate is the difference between absorbing a stub and absorbing a live entry.
 */
adminRoutes.get('/canonical-programs/options', async (c) => {
  const service = catalog(c);
  const search = c.req.query('search')?.trim();
  const entries = await service.canonicalProgramOptions(
    search === undefined || search === '' ? undefined : search,
  );
  const counts = await service.offeringCountsFor(entries.map((entry) => entry.id));

  return c.json(
    successEnvelope(
      entries.map((entry) =>
        serializeCanonicalProgram(entry, { offeringsCount: counts.get(entry.id) ?? 0 }),
      ),
      'Canonical programs retrieved successfully.',
    ),
  );
});

/** Which colleges offer this canonical program — the admin's view of the student-facing answer. */
adminRoutes.get('/canonical-programs/:id/colleges', async (c) => {
  const service = catalog(c);
  const entry = await service.findCanonicalProgram(c.req.param('id'));
  const rows = await service.collegesOfferingCanonical(entry.id);

  return c.json(
    successEnvelope(
      {
        canonical: serializeCanonicalProgram(entry),
        offerings: rows.map(({ college, program }) => ({
          college: serializeCollege(college),
          program: serializeProgram(program),
        })),
      },
      'Colleges retrieved successfully.',
    ),
  );
});

adminRoutes.post('/canonical-programs', async (c) => {
  const input = await parseBody(c, createCanonicalProgramSchema);
  const entry = await catalog(c).createCanonicalProgram(requireUser(c), input, clientIp(c));

  return c.json(
    successEnvelope(serializeCanonicalProgram(entry), 'Canonical program created successfully.'),
    201,
  );
});

adminRoutes.patch('/canonical-programs/:id', async (c) => {
  const input = await parseBody(c, updateCanonicalProgramSchema);
  const entry = await catalog(c).updateCanonicalProgram(
    requireUser(c),
    c.req.param('id'),
    input,
    clientIp(c),
  );

  return c.json(
    successEnvelope(serializeCanonicalProgram(entry), 'Canonical program updated successfully.'),
  );
});

/**
 * Merge the entry named in the URL **into** `target_id`, re-pointing every offering and retiring
 * the source. The correction for a grouping the backfill got wrong, and the reason this ships as a
 * page rather than only a column.
 */
adminRoutes.post('/canonical-programs/:id/merge', async (c) => {
  const input = await parseBody(c, mergeCanonicalProgramSchema);
  const { moved, target } = await catalog(c).mergeCanonicalPrograms(
    requireUser(c),
    c.req.param('id'),
    input.target_id,
    clientIp(c),
  );

  return c.json(
    successEnvelope(
      { target: serializeCanonicalProgram(target), offerings_moved: moved },
      `Merged. ${moved} college ${moved === 1 ? 'offering' : 'offerings'} now point at ${target.name}.`,
    ),
  );
});

// --- Public (§20 "Public / Health") ------------------------------------------------------

/**
 * `GET /programs/public` (§20, Phase 6) — the unauthenticated catalog browse, for the
 * landing page. Read-only, `active` chains only (the same recommendability rule as §27:
 * an active program under an archived college is not offered), and deliberately thin:
 * no descriptions of careers, no pagination, no query surface to abuse. It exposes exactly
 * what a school's own prospectus would.
 */
export const publicCatalogRoutes = new Hono<AppEnv>();

/** How many programs a public college card previews before it collapses the rest into "+N more". */
const PUBLIC_PROGRAM_PREVIEW = 3;

publicCatalogRoutes.get('/programs/public', async (c) => {
  const collegesWithPrograms = await catalog(c).publicCatalog();

  return c.json(
    successEnvelope(
      {
        colleges: collegesWithPrograms.map(({ college, programs: items }) => ({
          id: college.id,
          name: college.name,
          programs: items.map((program) => ({
            id: program.id,
            code: program.code,
            name: program.name,
            recommended_strand: program.recommendedStrand,
          })),
        })),
      },
      'Programs retrieved successfully.',
    ),
  );
});

/**
 * `GET /colleges/public` (prompt-driven, v1.5) — the public Colleges page. Every active college with
 * its resolved school address, its Google Maps link (null when none), and a **capped** preview of its
 * programs alongside the true total, so the card can render "2–3 programs, +N more" without shipping
 * the whole list. `?region_id=` scopes the list to one region (the page's filter). Reuses the same
 * `serializeCollege`/`serializeProgram` allow-lists as the admin surface — the frontend's `College`
 * type already mirrors them — so a public college is just a `College` with a trimmed program list.
 */
publicCatalogRoutes.get('/colleges/public', async (c) => {
  const rawRegion = c.req.query('region_id')?.trim();
  const regionId = rawRegion === undefined || rawRegion === '' ? undefined : rawRegion;
  const rows = await catalog(c).publicColleges(regionId);

  return c.json(
    successEnvelope(
      {
        colleges: rows.map(({ college, location, programs: items, programsCount }) =>
          serializeCollege(college, {
            location,
            programsCount,
            programs: items.slice(0, PUBLIC_PROGRAM_PREVIEW).map((program) => serializeProgram(program)),
          }),
        ),
      },
      'Colleges retrieved successfully.',
    ),
  );
});

/** The region options for the public Colleges filter — only regions that actually have a college. */
publicCatalogRoutes.get('/regions/public', async (c) => {
  const regions = await catalog(c).publicCollegeRegions();

  return c.json(successEnvelope({ regions }, 'Regions retrieved successfully.'));
});

/**
 * `GET /careers/public` (prompt-driven, v1.5) — the public Careers page. Every active career with its
 * employment-outlook name resolved and its raw salary bounds (the client formats the separators). The
 * outlook and salary filters the page offers run client-side over this list; the server just hands
 * over the whole thin set.
 */
publicCatalogRoutes.get('/careers/public', async (c) => {
  const service = catalog(c);
  const careerRows = await service.publicCareers();
  const outlooks = await service.outlooksById();

  return c.json(
    successEnvelope(
      {
        careers: careerRows.map((career) =>
          serializeCareer(career, {
            outlook: career.employmentOutlookId
              ? (outlooks.get(career.employmentOutlookId) ?? null)
              : null,
          }),
        ),
      },
      'Careers retrieved successfully.',
    ),
  );
});

/** The employment-outlook options for the public Careers filter (the same four-row lookup). */
publicCatalogRoutes.get('/employment-outlooks/public', async (c) => {
  const outlooks = await catalog(c).listEmploymentOutlooks();

  return c.json(
    successEnvelope(
      outlooks.map(serializeEmploymentOutlook),
      'Employment outlooks retrieved successfully.',
    ),
  );
});
