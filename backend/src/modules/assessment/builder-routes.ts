import { Hono } from 'hono';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope, ApiError } from '@/lib/envelope';
import { clientIp, parseBody, parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AssessmentAdminService } from '@/modules/assessment/assessment-admin-service';
import { AssessmentAttemptService } from '@/modules/assessment/assessment-attempt-service';
import {
  AssessmentBuilderService,
  describeBlockers,
  type CreateQuestionInput,
} from '@/modules/assessment/assessment-builder-service';
import { AssessmentTaxonomyService } from '@/modules/assessment/assessment-taxonomy-service';
import {
  addDimensionsSchema,
  addQuestionsSchema,
  assignAssessmentSchema,
  createTemplateSchema,
  createVersionSchema,
  listAssessmentsQuerySchema,
  reorderQuestionsSchema,
  updateQuestionSchema,
  updateTemplateSchema,
} from '@/modules/assessment/schemas';
import {
  serializeAssessmentRow,
  serializeAssessmentScoring,
  serializeAssessmentType,
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
  '/assessments',
  '/assessment-types',
  '/assessment-scorings',
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

// --- The taxonomy (migration 0014) -------------------------------------------------------------
//
// Reference data, so there is no per-record policy behind the role gate — the same one-layer
// authorization the catalog and address groups use (§39). Staff-only rather than public because the
// list is only ever read while authoring an assessment.

/**
 * `GET /assessment-types` — the 12 types, **each carrying the scoring ids it permits**.
 *
 * The matrix travels with the list on purpose: the create/edit form must re-filter its scoring
 * multi-select the moment the type changes, and a request per change would put a round trip inside
 * a keystroke. Two queries serve the whole thing.
 */
builderRoutes.get('/assessment-types', async (c) => {
  const taxonomy = new AssessmentTaxonomyService(createDatabase(c.env.DB));
  const types = await taxonomy.listTypes();

  return c.json(
    successEnvelope(
      types.map(({ type, scoringIds }) => serializeAssessmentType(type, scoringIds)),
      'Assessment types retrieved.',
    ),
  );
});

builderRoutes.get('/assessment-scorings', async (c) => {
  const taxonomy = new AssessmentTaxonomyService(createDatabase(c.env.DB));

  return c.json(
    successEnvelope(
      (await taxonomy.listScorings()).map(serializeAssessmentScoring),
      'Assessment scoring methods retrieved.',
    ),
  );
});

/**
 * `GET /assessments` — the administrator's list: searched, filtered, sorted and paginated on the
 * **server**, because a table that sorted only the rows it happened to have loaded would be lying
 * about the other pages.
 *
 * Visibility is the same rule as the counselor template list (admin: everything; counselor: the
 * global instruments plus their own), applied inside the query rather than after it.
 */
builderRoutes.get('/assessments', async (c) => {
  const query = parseQuery(c, listAssessmentsQuerySchema, [
    'search',
    'assessment_type_id',
    'status',
    'assignment',
    'created_from',
    'created_to',
    'updated_from',
    'updated_to',
    'published_from',
    'published_to',
    'page',
    'per_page',
    'sort',
    'direction',
  ]);

  const admin = new AssessmentAdminService(createDatabase(c.env.DB));
  const page = await admin.list(requireUser(c), query);

  return c.json(
    successEnvelope(
      { items: page.items.map(serializeAssessmentRow), pagination: page.pagination },
      'Assessments retrieved.',
    ),
  );
});

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

/**
 * The same, one link further down: question → version → template → ownership.
 *
 * Every question route needs exactly this chain, and writing it out four times is how one of them
 * eventually stops running `authorizeManageTemplate` — the check that keeps a counselor from
 * reaching another counselor's private instrument by question id.
 */
async function authorizedQuestion(
  builder: AssessmentBuilderService,
  user: ReturnType<typeof requireUser>,
  questionId: string,
) {
  const question = await builder.findQuestion(questionId);

  if (question === undefined) {
    throw ApiError.notFound('Question not found.');
  }

  await authorizedVersion(builder, user, question.assessmentVersionId);

  return question;
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
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);

  const template = await builder.createTemplate(user, {
    category: input.category,
    title: input.title,
    description: input.description ?? null,
    ownership: user.role === 'admin' ? 'GLOBAL' : 'COUNSELOR_PRIVATE',
    assessmentTypeId: input.assessment_type_id,
    scoringIds: input.scoring_ids,
  });

  const taxonomy = new AssessmentTaxonomyService(db);

  return c.json(
    successEnvelope(
      serializeTemplate(
        template,
        undefined,
        0,
        [],
        await taxonomy.findType(input.assessment_type_id),
        (await taxonomy.scoringsForTemplates([template.id])).get(template.id) ?? [],
      ),
      'Assessment created.',
    ),
    201,
  );
});

/** The builder's working view: the template, its taxonomy, its dimensions, and every version. */
builderRoutes.get('/assessment-templates/:templateId', async (c) => {
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(requireUser(c), template);

  const dimensions = await builder.dimensionsFor(template.id);
  const versions = await builder.versionsFor(template.id);
  const taxonomy = new AssessmentTaxonomyService(db);

  return c.json(
    successEnvelope(
      {
        ...serializeTemplate(
          template,
          await builder.assignableVersion(template.id),
          0,
          dimensions,
          template.assessmentTypeId === null
            ? null
            : await taxonomy.findType(template.assessmentTypeId),
          (await taxonomy.scoringsForTemplates([template.id])).get(template.id) ?? [],
        ),
        versions: versions.map(serializeVersionSummary),
      },
      'Template retrieved.',
    ),
  );
});

/**
 * `PATCH /assessment-templates/{id}` — the title, description, type and scoring methods.
 *
 * Permitted after publication, unlike every other write in this router, and the reason is in
 * `AssessmentBuilderService.updateTemplate`: none of these four fields decides what a delivered
 * result means. The Service re-validates the type/scoring pair on every save, so an assessment
 * cannot be walked into an illegal combination one field at a time.
 */
builderRoutes.patch('/assessment-templates/:templateId', async (c) => {
  const input = await parseBody(c, updateTemplateSchema);
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);
  const user = requireUser(c);
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(user, template);

  const updated = await builder.updateTemplate(user, template, {
    title: input.title,
    description: input.description ?? null,
    assessmentTypeId: input.assessment_type_id,
    scoringIds: input.scoring_ids,
  });

  const admin = new AssessmentAdminService(db);

  return c.json(
    successEnvelope(serializeAssessmentRow(await admin.row(updated)), 'Assessment updated.'),
  );
});

/**
 * Archive / restore. **Idempotent both ways**, so a double-tapped confirmation is a no-op rather
 * than an error — and neither one touches an assignment that is already open (see the Service).
 */
builderRoutes.post('/assessment-templates/:templateId/archive', async (c) => {
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);
  const user = requireUser(c);
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(user, template);

  const archived = await builder.archiveTemplate(user, template);
  const admin = new AssessmentAdminService(db);

  return c.json(
    successEnvelope(serializeAssessmentRow(await admin.row(archived)), 'Assessment archived.'),
  );
});

builderRoutes.post('/assessment-templates/:templateId/restore', async (c) => {
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);
  const user = requireUser(c);
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(user, template);

  const restored = await builder.restoreTemplate(user, template);
  const admin = new AssessmentAdminService(db);

  return c.json(
    successEnvelope(serializeAssessmentRow(await admin.row(restored)), 'Assessment restored.'),
  );
});

/**
 * `DELETE /assessment-templates/{id}` — the soft delete (prompt-driven, v1.6).
 *
 * **The two guards are re-checked inside the Service**, not here, and the route is thin on purpose:
 * the list ships a `can_delete` flag so the confirmation dialog can explain itself, but that flag is
 * a snapshot and a student can start an attempt between the page load and the click. A refusal is a
 * **422 carrying the reason**, not a 403 — the caller is entirely permitted to delete assessments;
 * this particular one has responses or open assignments, which is a fact about the data.
 *
 * The client-side "type the assessment's name to enable the button" gate is deliberately **not**
 * mirrored as a server-side requirement. It is a speed bump against a misplaced click, not an
 * authorization check, and turning it into one would mean the API's contract included a string the
 * caller already sent as a URL parameter.
 */
builderRoutes.delete('/assessment-templates/:templateId', async (c) => {
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);
  const user = requireUser(c);
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(user, template);

  const deleted = await builder.deleteTemplate(user, template);

  return c.json(
    successEnvelope(
      { id: deleted.id, title: deleted.title, deleted_at: deleted.deletedAt },
      `Deleted “${deleted.title}”.`,
    ),
  );
});

/**
 * `GET /assessment-templates/{id}/deletability` — "may this be deleted, and if not, why?"
 *
 * The list already carries this per row, so the dialog does not need a request to open. This exists
 * for the one case the list cannot cover: **re-checking at the moment of confirmation**, after the
 * administrator has typed the name, so a dialog that has been open while a class started the
 * assessment says so before the delete rather than after it.
 */
builderRoutes.get('/assessment-templates/:templateId/deletability', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(requireUser(c), template);

  const deletability = await builder.deletability(template.id);

  return c.json(
    successEnvelope(
      {
        can_delete: deletability.canDelete,
        blockers: deletability.blockers,
        reason: deletability.canDelete ? null : describeBlockers(deletability),
        response_count: deletability.attemptCount,
        active_assignment_count: deletability.activeAssignmentCount,
      },
      'Delete eligibility retrieved.',
    ),
  );
});

/**
 * `POST /assessment-templates/{id}/assignments` — assign globally, or to chosen classes.
 *
 * The version is optional and defaults to the newest published one: the list offers one Assign
 * button per assessment, and asking which version at that point would be asking a question whose
 * only sensible answer the server already holds. A template with nothing published is a **422**,
 * not a 403 — the caller is permitted to do this, the assessment simply is not ready (the same
 * distinction `createAssignment` has always drawn).
 */
builderRoutes.post('/assessment-templates/:templateId/assignments', async (c) => {
  const input = await parseBody(c, assignAssessmentSchema);
  const db = createDatabase(c.env.DB);
  const builder = new AssessmentBuilderService(db);
  const user = requireUser(c);
  const template = await builder.findTemplate(c.req.param('templateId'));

  authorizeManageTemplate(user, template);

  const version =
    input.assessment_version_id === undefined
      ? await builder.assignableVersion(template.id)
      : await builder.findVersion(input.assessment_version_id);

  if (version?.assessmentTemplateId !== template.id) {
    throw ApiError.validation(
      {
        assessment_version_id: [
          'This assessment has no published version to assign. Publish one first.',
        ],
      },
      'Nothing to assign.',
    );
  }

  const attempts = new AssessmentAttemptService(db, c.env);
  const result = await attempts.assignToClasses(
    user,
    {
      versionId: version.id,
      scope: input.scope,
      classIds: input.scope === 'CLASS' ? input.class_ids : [],
      deadline: input.deadline ?? null,
    },
    clientIp(c),
  );

  const admin = new AssessmentAdminService(db);

  return c.json(
    successEnvelope(
      {
        assessment: serializeAssessmentRow(await admin.row(template)),
        assigned_classes: result.assigned,
        skipped_classes: result.skipped,
        version_number: result.version.versionNumber,
      },
      assignmentMessage(result.assigned, result.skipped, input.scope === 'GLOBAL'),
    ),
    201,
  );
});

/** "Nothing changed" is a real outcome here, and saying so beats a success message that lies. */
function assignmentMessage(assigned: number, skipped: number, global: boolean): string {
  const target = global ? 'every active class' : 'the selected classes';

  if (assigned === 0) {
    return `Already assigned to ${target} — nothing to add.`;
  }

  const plural = assigned === 1 ? 'class' : 'classes';

  return skipped === 0
    ? `Assigned to ${assigned} ${plural}.`
    : `Assigned to ${assigned} ${plural}; ${skipped} already had it.`;
}

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

/**
 * `PATCH /assessment-questions/{id}` — the builder's auto-save.
 *
 * Every field is optional, so the editor sends only what changed; the response carries the whole
 * question back in the author's shape (`serializeAuthorQuestion`) so an optimistic UI can reconcile
 * against the server's answer rather than against what it hoped it wrote. DRAFT-only — enforced in
 * the Service, where invariant 1 lives.
 */
builderRoutes.patch('/assessment-questions/:questionId', async (c) => {
  const input = await parseBody(c, updateQuestionSchema);
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const user = requireUser(c);

  // Authorize via the question's own chain: question → version → template → ownership.
  const question = await authorizedQuestion(builder, user, c.req.param('questionId'));

  const updated = await builder.updateQuestion(user, question.id, {
    ...(input.question_text !== undefined ? { questionText: input.question_text } : {}),
    ...(input.question_type !== undefined ? { questionType: input.question_type } : {}),
    ...(input.section_label !== undefined ? { sectionLabel: input.section_label } : {}),
    ...(input.required !== undefined ? { required: input.required } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.dimension_codes !== undefined ? { dimensionCodes: input.dimension_codes } : {}),
  });

  const content = await builder.questionContent(updated.id);

  return c.json(
    successEnvelope(
      serializeAuthorQuestion(updated, content.options, content.mappings),
      'Question updated.',
    ),
  );
});

/**
 * `POST /assessment-questions/{id}/duplicate` — copy an item, appended at the end of its version.
 *
 * The copy is MANUAL and its mappings are confirmed even when the original was AI-generated: making
 * a copy is an authoring act by the person doing it, and inheriting `AI_GENERATED` would attribute
 * their work to the model (see the Service).
 */
builderRoutes.post('/assessment-questions/:questionId/duplicate', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const user = requireUser(c);
  const question = await authorizedQuestion(builder, user, c.req.param('questionId'));

  const duplicateId = await builder.duplicateQuestion(user, question.id);
  const duplicate = await builder.findQuestion(duplicateId);

  if (duplicate === undefined) {
    throw ApiError.notFound('Question not found.');
  }

  const content = await builder.questionContent(duplicateId);

  return c.json(
    successEnvelope(
      serializeAuthorQuestion(duplicate, content.options, content.mappings),
      'Question duplicated.',
    ),
    201,
  );
});

/** `DELETE /assessment-questions/{id}` — DRAFT only; the remaining items are renumbered with it. */
builderRoutes.delete('/assessment-questions/:questionId', async (c) => {
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const user = requireUser(c);
  const question = await authorizedQuestion(builder, user, c.req.param('questionId'));

  await builder.deleteQuestion(question.id);

  return c.json(successEnvelope({ id: question.id }, 'Question removed.'));
});

/**
 * `PUT /assessment-versions/{id}/question-order` — the drag-and-drop save.
 *
 * A `PUT` rather than a `PATCH`, because the body is the complete order rather than a change to it:
 * the request replaces the sequence, and sending it twice is the same as sending it once.
 */
builderRoutes.put('/assessment-versions/:versionId/question-order', async (c) => {
  const input = await parseBody(c, reorderQuestionsSchema);
  const builder = new AssessmentBuilderService(createDatabase(c.env.DB));
  const { version } = await authorizedVersion(builder, requireUser(c), c.req.param('versionId'));

  await builder.reorderQuestions(version.id, input.question_ids);

  return c.json(successEnvelope({ question_ids: input.question_ids }, 'Question order saved.'));
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
