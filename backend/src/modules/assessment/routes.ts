import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import { assessmentDimensions } from '@/db/schema';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { clientIp, parseBody } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AssessmentAttemptService } from '@/modules/assessment/assessment-attempt-service';
import { AssessmentBuilderService } from '@/modules/assessment/assessment-builder-service';
import { seedAssessmentInstruments } from '@/modules/assessment/instruments';
import {
  createAssignmentSchema,
  saveAnswerSchema,
  updateAssignmentSchema,
  updateStudentProfileSchema,
} from '@/modules/assessment/schemas';
import {
  serializeAssignment,
  serializeAttempt,
  serializeResult,
  serializeStudentProfile,
  serializeTemplate,
} from '@/modules/assessment/serializers';
import { StudentProfileService } from '@/modules/assessment/student-profile-service';
import { eq } from 'drizzle-orm';

/**
 * The assessment engine's HTTP surface (FULLPLAN §20, §37).
 *
 * Split by **who is asking**, because the API is. Every `/student` route means *mine*, resolved
 * from the token — there is no student id in any URL here. Reading someone else's assessment data
 * (§40, the most sensitive data in the system) is only reachable through the `/counselor` routes,
 * which name a student or a class explicitly and authorize against `AssessmentPolicy`. That is a
 * structural property, not a convention: a route that means "mine" cannot be made to mean
 * "someone else's" by changing a parameter, because it has no parameter to change.
 */

// --- /student (role: student only) -----------------------------------------------------------

export const studentRoutes = new Hono<AppEnv>();

/**
 * **`student` only — an admin cannot reach these.** That is the point of the narrow role gate:
 * these routes resolve "me" from the token, so an admin calling them would either see nothing or,
 * worse, be silently treated as a student with no enrollments.
 *
 * `ensurePasswordChanged` is deliberately absent: students have no password (§38), so the flag it
 * guards can never be set for them, and mounting it here would be a gate on a door with no lock.
 */
studentRoutes.use('*', authenticate());
studentRoutes.use('*', ensureRole('student'));

studentRoutes.get('/profile', async (c) => {
  const service = new StudentProfileService(createDatabase(c.env.DB));
  const profile = await service.forStudent(requireUser(c));

  return c.json(successEnvelope(serializeStudentProfile(profile), 'Profile retrieved.'));
});

studentRoutes.patch('/profile', async (c) => {
  const input = await parseBody(c, updateStudentProfileSchema);
  const service = new StudentProfileService(createDatabase(c.env.DB));
  const profile = await service.update(requireUser(c), input);

  return c.json(successEnvelope(serializeStudentProfile(profile), 'Profile updated.'));
});

studentRoutes.get('/assignments', async (c) => {
  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);
  const views = await service.listAssignmentsForStudent(requireUser(c));

  return c.json(successEnvelope(views.map(serializeAssignment), 'Assignments retrieved.'));
});

/** Idempotent — a double-tapped Start returns the attempt you already have. */
studentRoutes.post('/assignments/:assignmentId/start', async (c) => {
  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);
  const view = await service.start(requireUser(c), c.req.param('assignmentId'));

  return c.json(successEnvelope(serializeAttempt(view), 'Attempt started.'));
});

studentRoutes.get('/attempts/:attemptId', async (c) => {
  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);
  const view = await service.viewAttempt(requireUser(c), c.req.param('attemptId'));

  return c.json(successEnvelope(serializeAttempt(view), 'Attempt retrieved.'));
});

studentRoutes.post('/attempts/:attemptId/answers', async (c) => {
  const input = await parseBody(c, saveAnswerSchema);
  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);

  await service.saveAnswer(
    requireUser(c),
    c.req.param('attemptId'),
    input.question_id,
    input.selected_option_id,
  );

  return c.json(successEnvelope(null, 'Answer saved.'));
});

/** Scores **inline** (§24) and returns the result in this response — the student is waiting. */
studentRoutes.post('/attempts/:attemptId/submit', async (c) => {
  const db = createDatabase(c.env.DB);
  const service = new AssessmentAttemptService(db, c.env);
  const view = await service.submit(requireUser(c), c.req.param('attemptId'));

  const dimensions = await db
    .select()
    .from(assessmentDimensions)
    .where(eq(assessmentDimensions.assessmentTemplateId, view.template.id));

  return c.json(successEnvelope(serializeResult(view, dimensions), 'Assessment submitted.'));
});

studentRoutes.get('/results', async (c) => {
  const db = createDatabase(c.env.DB);
  const service = new AssessmentAttemptService(db, c.env);
  const views = await service.listResultsForStudent(requireUser(c));

  const serialized = await Promise.all(
    views.map(async (view) => {
      const dimensions = await db
        .select()
        .from(assessmentDimensions)
        .where(eq(assessmentDimensions.assessmentTemplateId, view.template.id));

      return serializeResult(view, dimensions);
    }),
  );

  return c.json(successEnvelope(serialized, 'Results retrieved.'));
});

studentRoutes.get('/results/:attemptId', async (c) => {
  const db = createDatabase(c.env.DB);
  const service = new AssessmentAttemptService(db, c.env);
  const view = await service.viewResult(requireUser(c), c.req.param('attemptId'));

  const dimensions = await db
    .select()
    .from(assessmentDimensions)
    .where(eq(assessmentDimensions.assessmentTemplateId, view.template.id));

  return c.json(successEnvelope(serializeResult(view, dimensions), 'Result retrieved.'));
});

// --- /counselor (role: counselor, admin) -----------------------------------------------------

/**
 * Mounted at `/counselor` **alongside** the Class module's own router. Two routers on one prefix
 * is deliberate: each module owns its own routes file (§10), and the alternative — a single
 * counselor router importing services from three modules — is exactly the flat pile §7 rejects.
 *
 * Admins are admitted here because `ClassPolicy` and `AssessmentPolicy` explicitly pass them
 * (§39). The route group is the coarse gate; ownership is still checked per record, inside the
 * service.
 */
export const counselorAssessmentRoutes = new Hono<AppEnv>();

counselorAssessmentRoutes.use('*', authenticate());
counselorAssessmentRoutes.use('*', ensureRole('counselor', 'admin'));
counselorAssessmentRoutes.use('*', ensurePasswordChanged());

/** The instruments this counselor may assign: the GLOBAL ones, plus their own private ones. */
counselorAssessmentRoutes.get('/assessment-templates', async (c) => {
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);
  const user = requireUser(c);

  const templates = await builder.listTemplatesFor(user);

  const serialized = await Promise.all(
    templates.map(async (template) => {
      const version = await builder.assignableVersion(template.id);
      const questionCount = version === undefined ? 0 : await builder.questionCount(version.id);
      const dimensions = await builder.dimensionsFor(template.id);

      return serializeTemplate(template, version, questionCount, dimensions);
    }),
  );

  return c.json(successEnvelope(serialized, 'Assessment templates retrieved.'));
});

counselorAssessmentRoutes.get('/classes/:classId/assignments', async (c) => {
  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);
  const views = await service.listAssignmentsForClass(requireUser(c), c.req.param('classId'));

  return c.json(successEnvelope(views.map(serializeAssignment), 'Assignments retrieved.'));
});

counselorAssessmentRoutes.post('/classes/:classId/assignments', async (c) => {
  const input = await parseBody(c, createAssignmentSchema);
  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);

  const view = await service.createAssignment(
    requireUser(c),
    c.req.param('classId'),
    input.assessment_version_id,
    input.deadline ?? null,
    clientIp(c),
  );

  return c.json(successEnvelope(serializeAssignment(view), 'Assessment assigned.'), 201);
});

/** In practice: **closing** it — which expires every attempt still in progress underneath (§21). */
counselorAssessmentRoutes.patch('/assignments/:assignmentId', async (c) => {
  await parseBody(c, updateAssignmentSchema);

  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);
  const view = await service.closeAssignment(
    requireUser(c),
    c.req.param('assignmentId'),
    clientIp(c),
  );

  return c.json(successEnvelope(serializeAssignment(view), 'Assignment closed.'));
});

counselorAssessmentRoutes.get('/classes/:classId/results', async (c) => {
  const db = createDatabase(c.env.DB);
  const service = new AssessmentAttemptService(db, c.env);
  const views = await service.listResultsForClass(requireUser(c), c.req.param('classId'));

  const serialized = await Promise.all(
    views.map(async (view) => {
      const dimensions = await db
        .select()
        .from(assessmentDimensions)
        .where(eq(assessmentDimensions.assessmentTemplateId, view.template.id));

      return serializeResult(view, dimensions);
    }),
  );

  return c.json(successEnvelope(serialized, 'Class results retrieved.'));
});

/** The retake (§21) — **the counselor's, never the student's.** */
counselorAssessmentRoutes.post('/attempts/:attemptId/reset', async (c) => {
  const service = new AssessmentAttemptService(createDatabase(c.env.DB), c.env);

  await service.resetAttempt(requireUser(c), c.req.param('attemptId'), clientIp(c));

  return c.json(successEnvelope(null, 'Attempt reset. The student may now start a new one.'));
});

// --- /admin ----------------------------------------------------------------------------------

export const adminAssessmentRoutes = new Hono<AppEnv>();

adminAssessmentRoutes.use('*', authenticate());
adminAssessmentRoutes.use('*', ensureRole('admin'));
adminAssessmentRoutes.use('*', ensurePasswordChanged());

/**
 * Install the two globally-curated instruments (§22, §23). **Idempotent** — re-running is a no-op.
 *
 * This endpoint exists because of a genuine platform constraint rather than a design preference.
 * §57 requires the RIASEC/SCCT seeders to publish **through the real `AssessmentBuilderService`**,
 * so that they pass the same confirmation gate a counselor does — a `.sql` seed file that wrote
 * `status = 'PUBLISHED'` directly would appear to prove the gate works while demonstrating exactly
 * how to bypass it. But a D1 binding only exists *inside* the Worker: there is no offline Node
 * script that can call a Worker service against the real database, the way `php artisan db:seed`
 * could. So the seeder is reached the only way a Worker's own code can be reached — over HTTP.
 *
 * It is **admin-authenticated, not environment-gated**, and that is the safer of the two: an
 * `APP_ENV === 'local'` guard fails open if the variable is ever misconfigured in production,
 * whereas this one still requires an admin token. And it is a defensible thing for an admin to be
 * able to do — RIASEC and SCCT are globally-curated content the admin owns (§4).
 *
 * Recorded as a deviation in PROGRESS.md: it is not in §20's endpoint catalog.
 */
adminAssessmentRoutes.post('/assessment-templates/seed-instruments', async (c) => {
  const result = await seedAssessmentInstruments(createDatabase(c.env.DB), requireUser(c));

  return c.json(
    successEnvelope(
      result,
      result.created
        ? 'RIASEC and SCCT installed and published.'
        : 'RIASEC and SCCT are already installed.',
    ),
  );
});
