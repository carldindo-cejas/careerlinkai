import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { parseBody } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import {
  AssessmentBuilderService,
  type CreateQuestionInput,
} from '@/modules/assessment/assessment-builder-service';
import {
  addDimensionsSchema,
  addQuestionsSchema,
  createTemplateSchema,
  createVersionSchema,
  updateQuestionSchema,
} from '@/modules/assessment/schemas';
import {
  serializeAuthorQuestion,
  serializeTemplate,
  serializeVersionSummary,
} from '@/modules/assessment/serializers';
import { authorizeManageTemplate } from '@/policies/assessment';

/**
 * The assessment builder's HTTP surface (Phase 5b — §20's template/version group, flattened
 * the way §20 itself flattens: templates by id, versions by their own id, questions and
 * mappings by theirs).
 *
 * **Shared, not split by prefix**: §20 lists this group under both `/admin` and `/counselor`
 * with identical shapes, differing only in whose templates are reachable — which is an
 * *ownership* question, answered per record by `authorizeManageTemplate` (admin: any;
 * counselor: their own; the failure is a 404, so private template ids cannot be probed).
 * Mounting one router twice would create two URLs for one resource; this router mounts once
 * at the API root, and the role gate plus the per-record policy are the whole rule.
 *
 * The player-facing routes live in `routes.ts` and serialize questions WITHOUT scores or
 * dimensions; everything here is the author's view and includes both. The role gate on this
 * router is what keeps those two disclosures pointed at different audiences.
 */
export const builderRoutes = new Hono<AppEnv>();

/**
 * Scoped to this router's own prefixes, NOT `'*'` — the router mounts at the API root, and a
 * `use('*')` here would run `authenticate` for every path under /api/v1 that matches no
 * route at all, turning the API's 404 for an unknown path into a 401 (caught by
 * `test/app.test.ts` the first time it happened).
 */
for (const prefix of [
  '/assessment-templates',
  '/assessment-templates/*',
  '/assessment-versions/*',
  '/assessment-questions/*',
  '/question-dimensions/*',
]) {
  builderRoutes.use(prefix, authenticate());
  builderRoutes.use(prefix, ensureRole('counselor', 'admin'));
  builderRoutes.use(prefix, ensurePasswordChanged());
}

/** Load a version and its template, authorizing the caller against the template. 404 first. */
async function authorizedVersion(
  builder: AssessmentBuilderService,
  user: ReturnType<typeof requireUser>,
  versionId: string,
) {
  const version = await builder.findVersion(versionId);

  if (version === undefined) {
    throw ApiError.notFound('Assessment version not found.');
  }

  const template = await builder.findTemplate(version.assessmentTemplateId);
  authorizeManageTemplate(user, template);

  return { version, template };
}

// --- Templates -------------------------------------------------------------------------------

/**
 * `POST /assessment-templates` — CUSTOM only (the schema pins the literal; RIASEC/SCCT are
 * seeded instruments, not creatable content). Ownership follows the creator's role (§13.4):
 * an admin authors global content, a counselor authors their own.
 */
builderRoutes.post('/assessment-templates', async (c) => {
  const input = await parseBody(c, createTemplateSchema);
  const user = requireUser(c);
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));

  const template = await builder.createTemplate(user, {
    category: input.category,
    title: input.title,
    description: input.description ?? null,
    ownership: user.role === 'admin' ? 'GLOBAL' : 'COUNSELOR_PRIVATE',
  });

  return c.json(successEnvelope(serializeTemplate(template, undefined, 0, []), 'Template created.'), 201);
});

/** The builder's working view: the template, its dimensions, and every version. */
builderRoutes.get('/assessment-templates/:templateId', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(requireUser(c), template);

  const dimensions = await builder.dimensionsFor(template.id);
  const versions = await builder.versionsFor(template.id);

  return c.json(
    successEnvelope(
      {
        ...serializeTemplate(template, await builder.assignableVersion(template.id), 0, dimensions),
        versions: versions.map(serializeVersionSummary),
      },
      'Template retrieved.',
    ),
  );
});

/**
 * `POST /assessment-templates/{id}/dimensions` — the §31 Mode B prerequisite: the creator
 * names the dimensions up front, and generation maps onto exactly these. Refused once any
 * version of the template has published (invariant 2 — the service enforces it).
 */
builderRoutes.post('/assessment-templates/:templateId/dimensions', async (c) => {
  const input = await parseBody(c, addDimensionsSchema);
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(requireUser(c), template);

  const existing = await builder.dimensionsFor(template.id);
  const nextOrder = existing.length + 1;

  const created = await builder.addDimensions(
    template.id,
    input.dimensions.map((dimension, index) => ({
      code: dimension.code,
      name: dimension.name,
      description: dimension.description ?? null,
      orderNumber: nextOrder + index,
    })),
  );

  return c.json(
    successEnvelope(
      created.map((dimension) => ({
        code: dimension.code,
        name: dimension.name,
        description: dimension.description,
      })),
      'Dimensions added.',
    ),
    201,
  );
});

builderRoutes.post('/assessment-templates/:templateId/versions', async (c) => {
  const input = await parseBody(c, createVersionSchema);
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const template = await builder.findTemplate(c.req.param('templateId'));
  const user = requireUser(c);

  authorizeManageTemplate(user, template);

  const version = await builder.createVersion(user, template.id, {
    instructions: input.instructions ?? null,
    durationMinutes: input.duration_minutes ?? null,
    scoringConfig: { algorithm: input.scoring_algorithm },
  });

  return c.json(successEnvelope(serializeVersionSummary(version), 'Version created.'), 201);
});

// --- Versions: the review payload, questions, the gate, publish -------------------------------

/** The §31 review screen's payload — questions WITH scores and mappings (author's view). */
builderRoutes.get('/assessment-versions/:versionId', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const { version, template } = await authorizedVersion(builder, requireUser(c), c.req.param('versionId'));

  const content = await builder.versionContent(version.id);
  const readiness = await builder.publishReadiness(version.id);

  return c.json(
    successEnvelope(
      {
        ...serializeVersionSummary(version),
        template: {
          id: template.id,
          title: template.title,
          category: template.category,
        },
        publish_readiness: readiness,
        questions: content.questions.map((question) =>
          serializeAuthorQuestion(
            question,
            content.optionsByQuestion.get(question.id) ?? [],
            content.mappingsByQuestion.get(question.id) ?? [],
          ),
        ),
      },
      'Version retrieved.',
    ),
  );
});

/** The manual editor (§31: "the same editor used for manual creation"). MANUAL = confirmed. */
builderRoutes.post('/assessment-versions/:versionId/questions', async (c) => {
  const input = await parseBody(c, addQuestionsSchema);
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const user = requireUser(c);
  const { version } = await authorizedVersion(builder, user, c.req.param('versionId'));

  const existingCount = await builder.questionCount(version.id);

  const questions: CreateQuestionInput[] = input.questions.map((question, index) => ({
    questionText: question.question_text,
    questionType: question.question_type,
    sectionLabel: question.section_label ?? null,
    orderNumber: existingCount + index + 1,
    required: question.required ?? true,
    source: 'MANUAL',
    options: question.options.map((option, optionIndex) => ({
      label: option.label,
      value: option.value,
      score: option.score,
      orderNumber: optionIndex + 1,
    })),
    dimensions: question.dimension_codes.map((code) => ({ code })),
  }));

  const ids = await builder.addQuestions(user, version.id, questions);

  return c.json(successEnvelope({ question_ids: ids }, `${ids.length} question(s) added.`), 201);
});

builderRoutes.get('/assessment-versions/:versionId/publish-readiness', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const { version } = await authorizedVersion(builder, requireUser(c), c.req.param('versionId'));

  return c.json(successEnvelope(await builder.publishReadiness(version.id), 'Publish readiness retrieved.'));
});

/** §25's gate lives in the service; a 422 here carries the outstanding-mapping count. */
builderRoutes.post('/assessment-versions/:versionId/publish', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const user = requireUser(c);
  const { version } = await authorizedVersion(builder, user, c.req.param('versionId'));

  const published = await builder.publish(user, version.id);

  return c.json(successEnvelope(serializeVersionSummary(published), 'Version published.'));
});

// --- Questions + mappings (the review acts) ----------------------------------------------------

builderRoutes.patch('/assessment-questions/:questionId', async (c) => {
  const input = await parseBody(c, updateQuestionSchema);
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const user = requireUser(c);

  // Authorize via the question's own chain: question → version → template → ownership.
  const question = await builder.findQuestion(c.req.param('questionId'));

  if (question === undefined) {
    throw ApiError.notFound('Question not found.');
  }

  await authorizedVersion(builder, user, question.assessmentVersionId);

  const updated = await builder.updateQuestion(question.id, {
    questionText: input.question_text,
    required: input.required,
  });

  return c.json(
    successEnvelope(
      { id: updated.id, question_text: updated.questionText, required: updated.required },
      'Question updated.',
    ),
  );
});

/**
 * `POST /question-dimensions/{id}/confirm` — the §25 act itself, one mapping at a time.
 * There is deliberately no bulk form (§31; deviation from §20's sketched
 * `confirm-all-mappings`, recorded in PROGRESS.md). The response carries the updated
 * readiness so the review screen's progress bar moves without a second request.
 */
builderRoutes.post('/question-dimensions/:mappingId/confirm', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const user = requireUser(c);

  const found = await builder.findMapping(c.req.param('mappingId'));

  if (found === undefined) {
    throw ApiError.notFound('Question-dimension mapping not found.');
  }

  const template = await builder.findTemplate(found.templateId);
  authorizeManageTemplate(user, template);

  const confirmed = await builder.confirmMapping(user, found.mapping.id);
  const readiness = await builder.publishReadiness(found.versionId);

  return c.json(
    successEnvelope(
      {
        mapping_id: confirmed.id,
        confirmed: confirmed.confirmedAt !== null,
        confirmed_at: confirmed.confirmedAt,
        publish_readiness: readiness,
      },
      'Mapping confirmed.',
    ),
  );
});
