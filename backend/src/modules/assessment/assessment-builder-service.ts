import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import type {
  AssessmentCategory,
  AssessmentOwnership,
  QuestionSource,
  QuestionType,
} from '@/db/enums';
import {
  assessmentDimensions,
  assessmentQuestions,
  assessmentTemplates,
  assessmentVersions,
  questionDimensions,
  questionOptions,
  type AssessmentDimension,
  type AssessmentTemplate,
  type AssessmentVersion,
  type InterpretationRange,
  type ScoringConfig,
  type User,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * Assessment authoring (FULLPLAN §12, §21, §25) — the three invariants the whole module rests on.
 *
 * None of them can be a database constraint, which is why they are all here and why this file is
 * the one that has to be right:
 *
 * 1. **A PUBLISHED version is frozen forever** — it, and every question, option and mapping
 *    beneath it. SQLite cannot express "reject an UPDATE when a parent column has a given value".
 *    An attempt taken under version *N* must keep meaning what it meant; a mistake is fixed by
 *    publishing *N+1*, and only new assignments point at it.
 * 2. **Dimensions freeze once ANY version of their template has published** (§12, v1.2).
 *    Dimensions hang off the *template*, so invariant 1 does not reach them — and renaming
 *    "Investigative", or sliding a band from 67 to 60, would rewrite results already delivered.
 * 3. **No version publishes while any `question_dimensions.confirmed_at IS NULL`** (§25). This is
 *    a cross-row aggregate; a CHECK sees one row at a time.
 *
 * Invariants 2 and 3 are load-bearing on each other, and it is worth saying why: a confirmation
 * is only meaningful if the thing confirmed cannot be redefined afterwards. Without the freeze,
 * a human could confirm "this item measures Investigative", and someone could then edit what
 * Investigative *is* — leaving `confirmed_at` set on a fact that no longer holds.
 */

const MODULE = 'Assessment';

/**
 * **D1 binds at most 100 parameters per statement.** A multi-row INSERT binds one parameter per
 * column *per row*, so the limit is not a row count — it is a row count divided by the width of
 * the table. RIASEC's 300 option rows in one INSERT is ~1,800 parameters and fails with
 * `too many SQL variables`, which is a fact about the statement's shape and says nothing at all
 * about the data.
 *
 * Hence `chunk(rows, columns)` rather than a fixed `CHUNK_SIZE`: a 10-column table gets 10 rows
 * per statement, a 6-column table gets 16. Hard-coding one number would work until someone added
 * a column, and then it would fail on the widest table only.
 */
const D1_MAX_BOUND_PARAMS = 100;

function chunk<T>(rows: T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnsPerRow));
  const chunks: T[][] = [];

  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }

  return chunks;
}

export interface CreateTemplateInput {
  category: AssessmentCategory;
  title: string;
  description?: string | null;
  ownership?: AssessmentOwnership;
}

export interface CreateDimensionInput {
  code: string;
  name: string;
  description?: string | null;
  interpretationRanges?: InterpretationRange[] | null;
  orderNumber: number;
}

export interface CreateVersionInput {
  instructions?: string | null;
  durationMinutes?: number | null;
  scoringConfig: ScoringConfig;
}

export interface CreateQuestionInput {
  questionText: string;
  questionType: QuestionType;
  sectionLabel?: string | null;
  orderNumber: number;
  required?: boolean;
  source?: QuestionSource;
  /** §13.4 provenance — set only by the §31 generation job, back-pointing into `ai_requests`. */
  sourceAiRequestId?: string | null;
  options: { label: string; value: string; score: number; orderNumber: number }[];
  /** Keyed by dimension **code**, which is what an instrument author actually thinks in. */
  dimensions: { code: string; weight?: number }[];
}

export interface PublishReadiness {
  total: number;
  confirmed: number;
  remaining: number;
}

export class AssessmentBuilderService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  // --- Templates ---------------------------------------------------------------------------

  async createTemplate(user: User, input: CreateTemplateInput): Promise<AssessmentTemplate> {
    const template: AssessmentTemplate = {
      id: uuid(),
      creatorId: user.id,
      category: input.category,
      title: input.title,
      description: input.description ?? null,
      ownership: input.ownership ?? 'GLOBAL',
      status: 'DRAFT',
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    };

    await this.db.insert(assessmentTemplates).values(template);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_TEMPLATE_CREATED',
      module: MODULE,
      targetType: 'assessment_template',
      targetId: template.id,
      newValues: { category: template.category, title: template.title },
    });

    return template;
  }

  /**
   * The instruments a counselor may assign: every `GLOBAL` one, plus their own private ones.
   *
   * **Scoped in the service, not the policy** (`docs/api`). A policy answers yes/no about one
   * record; this is a *query* shape — "which rows exist for you" — and expressing it as a policy
   * would mean loading every template in the system and filtering in memory.
   */
  async listTemplatesFor(user: User): Promise<AssessmentTemplate[]> {
    const visible =
      user.role === 'admin'
        ? isNull(assessmentTemplates.deletedAt)
        : and(
            isNull(assessmentTemplates.deletedAt),
            sql`(${assessmentTemplates.ownership} = 'GLOBAL' OR ${assessmentTemplates.creatorId} = ${user.id})`,
          );

    return this.db
      .select()
      .from(assessmentTemplates)
      .where(visible)
      .orderBy(asc(assessmentTemplates.title));
  }

  async findTemplate(templateId: string): Promise<AssessmentTemplate | undefined> {
    const [template] = await this.db
      .select()
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.id, templateId), isNull(assessmentTemplates.deletedAt)))
      .limit(1);

    return template;
  }

  /**
   * The version a counselor may actually assign: the newest `PUBLISHED` one.
   *
   * A template with no published version is not assignable, and the UI is told so with a `null`
   * rather than being handed a draft it would then fail to assign.
   */
  async assignableVersion(templateId: string): Promise<AssessmentVersion | undefined> {
    const [version] = await this.db
      .select()
      .from(assessmentVersions)
      .where(
        and(
          eq(assessmentVersions.assessmentTemplateId, templateId),
          eq(assessmentVersions.status, 'PUBLISHED'),
        ),
      )
      .orderBy(sql`${assessmentVersions.versionNumber} DESC`)
      .limit(1);

    return version;
  }

  // --- Dimensions --------------------------------------------------------------------------

  /**
   * Add the instrument's dimensions. **Refused once any version of this template has published**
   * — invariant 2.
   */
  async addDimensions(
    templateId: string,
    inputs: CreateDimensionInput[],
  ): Promise<AssessmentDimension[]> {
    await this.assertDimensionsNotFrozen(templateId);

    const rows: AssessmentDimension[] = inputs.map((input) => ({
      id: uuid(),
      assessmentTemplateId: templateId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      interpretationRanges: input.interpretationRanges ?? null,
      orderNumber: input.orderNumber,
      createdAt: now(),
    }));

    if (rows.length > 0) {
      await this.db.insert(assessmentDimensions).values(rows);
    }

    return rows;
  }

  async dimensionsFor(templateId: string): Promise<AssessmentDimension[]> {
    return this.db
      .select()
      .from(assessmentDimensions)
      .where(eq(assessmentDimensions.assessmentTemplateId, templateId))
      .orderBy(asc(assessmentDimensions.orderNumber));
  }

  /**
   * Invariant 2 (§12, v1.2). The check is "has *any* version of this template ever published",
   * not "is the current version published" — because a dimension is shared by every version, so
   * one published version anywhere is enough to make an edit here rewrite delivered results.
   */
  private async assertDimensionsNotFrozen(templateId: string): Promise<void> {
    const [published] = await this.db
      .select({ total: count() })
      .from(assessmentVersions)
      .where(
        and(
          eq(assessmentVersions.assessmentTemplateId, templateId),
          eq(assessmentVersions.status, 'PUBLISHED'),
        ),
      );

    if ((published?.total ?? 0) > 0) {
      throw ApiError.validation(
        { dimensions: ['This template has a published version, so its dimensions are frozen.'] },
        'Dimensions cannot be changed once a version of their template has been published.',
      );
    }
  }

  // --- Versions ----------------------------------------------------------------------------

  /** Version numbers start at 1 and increment per template (§13.4). */
  async createVersion(
    user: User,
    templateId: string,
    input: CreateVersionInput,
  ): Promise<AssessmentVersion> {
    const [latest] = await this.db
      .select({ highest: sql<number | null>`MAX(${assessmentVersions.versionNumber})` })
      .from(assessmentVersions)
      .where(eq(assessmentVersions.assessmentTemplateId, templateId));

    const version: AssessmentVersion = {
      id: uuid(),
      assessmentTemplateId: templateId,
      versionNumber: (latest?.highest ?? 0) + 1,
      instructions: input.instructions ?? null,
      durationMinutes: input.durationMinutes ?? null,
      scoringConfig: input.scoringConfig,
      status: 'DRAFT',
      createdBy: user.id,
      createdAt: now(),
    };

    await this.db.insert(assessmentVersions).values(version);

    return version;
  }

  async findVersion(versionId: string): Promise<AssessmentVersion | undefined> {
    const [version] = await this.db
      .select()
      .from(assessmentVersions)
      .where(eq(assessmentVersions.id, versionId))
      .limit(1);

    return version;
  }

  /** Every version of one template, newest first — the builder's version list. */
  async versionsFor(templateId: string): Promise<AssessmentVersion[]> {
    return this.db
      .select()
      .from(assessmentVersions)
      .where(eq(assessmentVersions.assessmentTemplateId, templateId))
      .orderBy(sql`${assessmentVersions.versionNumber} DESC`);
  }

  async findQuestion(
    questionId: string,
  ): Promise<(typeof assessmentQuestions.$inferSelect) | undefined> {
    const [question] = await this.db
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.id, questionId))
      .limit(1);

    return question;
  }

  /**
   * Invariant 1. Every write path beneath a version goes through this — adding a question,
   * an option, a mapping. A `PUBLISHED` *or* `ARCHIVED` version is closed: archiving is how an
   * instrument is retired, and reopening it for edits would resurrect it by the back door.
   */
  private assertVersionEditable(version: AssessmentVersion): void {
    if (version.status !== 'DRAFT') {
      throw ApiError.validation(
        { version: [`This version is ${version.status} and can no longer be edited.`] },
        'A published version is immutable — create a new version instead.',
      );
    }
  }

  // --- Questions ---------------------------------------------------------------------------

  /**
   * Add one question with its options and its dimension mappings, **in a single `db.batch()`**.
   *
   * D1 has no interactive transactions; `batch()` runs the statements in one implicit
   * transaction. It matters here for the same reason it matters in `confirmEnrollment()`: a
   * question that landed without its dimension mapping would be an item that measures nothing —
   * silently excluded from every dimension's `raw`/`max`, and impossible to spot by looking at
   * the question list.
   */
  async addQuestion(user: User, versionId: string, input: CreateQuestionInput): Promise<string> {
    const [questionId] = await this.addQuestions(user, versionId, [input]);

    if (questionId === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    return questionId;
  }

  /**
   * The bulk form — and the one the seeders use, because the difference is not cosmetic.
   *
   * Adding RIASEC's 60 items one at a time re-reads the version and its dimensions 60 times and
   * issues 60 separate batches: ~270 round trips to write 60 questions. This loads the version
   * and its dimensions **once** and writes everything in one batch. The validation, the
   * `confirmed_at` semantics and the immutability check are identical — the singular form above
   * now delegates here, so there is exactly one write path and no chance of the two drifting.
   *
   * Inserts are chunked (`INSERT_CHUNK`) because SQLite binds one parameter per column per row
   * and refuses a statement past its variable limit — 300 option rows in one INSERT is ~1,800
   * parameters, comfortably over it.
   */
  async addQuestions(
    user: User,
    versionId: string,
    inputs: CreateQuestionInput[],
  ): Promise<string[]> {
    const version = await this.findVersion(versionId);

    if (version === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    this.assertVersionEditable(version);

    if (inputs.length === 0) {
      return [];
    }

    const dimensions = await this.dimensionsFor(version.assessmentTemplateId);
    const dimensionByCode = new Map(dimensions.map((d) => [d.code, d]));

    const timestamp = now();

    const questionRows: (typeof assessmentQuestions.$inferInsert)[] = [];
    const optionRows: (typeof questionOptions.$inferInsert)[] = [];
    const mappingRows: (typeof questionDimensions.$inferInsert)[] = [];

    for (const input of inputs) {
      const questionId = uuid();
      const source: QuestionSource = input.source ?? 'MANUAL';

      /**
       * **A human typed this, so there is nothing to review later** (§25): a MANUAL mapping is
       * confirmed at insert time. `NULL` is reachable only for an AI-proposed mapping, and it is
       * exactly what blocks publish until someone has looked at it.
       */
      const confirmedAt = source === 'MANUAL' ? timestamp : null;
      const confirmedBy = source === 'MANUAL' ? user.id : null;

      questionRows.push({
        id: questionId,
        assessmentVersionId: versionId,
        questionText: input.questionText,
        questionType: input.questionType,
        sectionLabel: input.sectionLabel ?? null,
        orderNumber: input.orderNumber,
        required: input.required ?? true,
        source,
        sourceAiRequestId: input.sourceAiRequestId ?? null,
        createdAt: timestamp,
      });

      for (const option of input.options) {
        optionRows.push({
          id: uuid(),
          questionId,
          label: option.label,
          value: option.value,
          score: option.score,
          orderNumber: option.orderNumber,
        });
      }

      for (const mapping of input.dimensions) {
        const dimension = dimensionByCode.get(mapping.code);

        if (dimension === undefined) {
          throw ApiError.validation(
            { dimensions: [`Unknown dimension code "${mapping.code}" for this template.`] },
            'A question cannot map to a dimension that does not exist on its template.',
          );
        }

        mappingRows.push({
          id: uuid(),
          questionId,
          dimensionId: dimension.id,
          weight: mapping.weight ?? 1,
          confirmedAt,
          confirmedBy,
        });
      }
    }

    /**
     * One batch — D1 has no interactive transactions, and `batch()` runs its statements in one
     * implicit transaction. It matters here for the same reason it matters in
     * `confirmEnrollment()`: a question that landed without its dimension mapping would be an
     * item that measures nothing, silently excluded from every dimension's `raw`/`max` and
     * impossible to spot by reading the question list.
     */
    // The column counts are the tables' widths in `schema.ts` — see `chunk`'s note on why this is
    // a parameter budget rather than a row budget.
    const statements: BatchItem<'sqlite'>[] = [
      ...chunk(questionRows, 10).map((rows) => this.db.insert(assessmentQuestions).values(rows)),
      ...chunk(optionRows, 6).map((rows) => this.db.insert(questionOptions).values(rows)),
      ...chunk(mappingRows, 6).map((rows) => this.db.insert(questionDimensions).values(rows)),
    ];

    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    return questionRows.map((row) => row.id);
  }

  // --- The confirmation gate (§25) ----------------------------------------------------------

  /**
   * `{ total, confirmed, remaining }` for one version — so the UI can show honest progress and
   * block its publish button with a *reason* rather than letting the request fail (§25).
   */
  async publishReadiness(versionId: string): Promise<PublishReadiness> {
    const [totals] = await this.db
      .select({
        total: count(),
        confirmed: sql<number>`SUM(CASE WHEN ${questionDimensions.confirmedAt} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(questionDimensions)
      .innerJoin(assessmentQuestions, eq(questionDimensions.questionId, assessmentQuestions.id))
      .where(eq(assessmentQuestions.assessmentVersionId, versionId));

    const total = totals?.total ?? 0;
    const confirmed = Number(totals?.confirmed ?? 0);

    return { total, confirmed, remaining: total - confirmed };
  }

  /**
   * **Invariant 3 — the confirmation gate** (§25).
   *
   * The risk this guards is not AI writing awkward question text; that is a UX problem. It is AI
   * silently deciding *what a question measures and how strongly*, because that decision is
   * invisible in the finished product: the student sees a normal Likert item and a normal result,
   * with no sign that the thing connecting them was never read by a human.
   *
   * A **422**, not a 403: the caller is permitted to publish this version, it simply is not ready
   * — and the response says exactly how many mappings are outstanding, because "publish failed"
   * with no number is a dead end for whoever has to fix it.
   *
   * Note the gate applies uniformly to every category, with no RIASEC/SCCT exception. It does not
   * need one: those instruments are manually authored, so their mappings are confirmed at
   * creation and the gate is trivially satisfied. The right behaviour falls out of what is
   * upstream of the rule rather than out of a special case inside it.
   */
  async publish(user: User, versionId: string): Promise<AssessmentVersion> {
    const version = await this.findVersion(versionId);

    if (version === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    if (version.status === 'PUBLISHED') {
      return version; // Idempotent: publishing a published version is not an error.
    }

    this.assertVersionEditable(version);

    const [questions] = await this.db
      .select({ total: count() })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, versionId));

    if ((questions?.total ?? 0) === 0) {
      throw ApiError.validation(
        { questions: ['A version must have at least one question before it can be published.'] },
        'This version has no questions.',
      );
    }

    const readiness = await this.publishReadiness(versionId);

    if (readiness.remaining > 0) {
      throw ApiError.validation(
        {
          question_dimensions: [
            `${readiness.remaining} of ${readiness.total} dimension mappings are still unconfirmed.`,
          ],
        },
        'Every question-dimension mapping must be confirmed by a human before this version can be published.',
      );
    }

    await this.db
      .update(assessmentVersions)
      .set({ status: 'PUBLISHED' })
      .where(eq(assessmentVersions.id, versionId));

    // The template becomes ACTIVE the moment it has something assignable.
    await this.db
      .update(assessmentTemplates)
      .set({ status: 'ACTIVE', updatedAt: now() })
      .where(eq(assessmentTemplates.id, version.assessmentTemplateId));

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_PUBLISHED',
      module: MODULE,
      targetType: 'assessment_version',
      targetId: versionId,
      oldValues: { status: version.status },
      newValues: {
        status: 'PUBLISHED',
        version_number: version.versionNumber,
        confirmed_mappings: readiness.confirmed,
      },
    });

    return { ...version, status: 'PUBLISHED' };
  }

  /** How many questions a version has — the counselor's template list shows it. */
  async questionCount(versionId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, versionId));

    return row?.total ?? 0;
  }

  // --- The author's view (Phase 5b — the §31 review step) -----------------------------------

  /**
   * Everything the review screen needs about one version, in three queries: the questions in
   * order, every option **with its score**, and every mapping with its dimension and its
   * confirmation state.
   *
   * This is the *author's* payload, deliberately unlike the player's (`serializeQuestion`
   * omits scores and dimensions so a student cannot answer the Holland Code they want). The
   * §31 review step is the exact opposite situation: a human being asked to confirm what a
   * question measures **must** see the mapping and the scores, or the confirmation is
   * theater.
   */
  async versionContent(versionId: string): Promise<{
    questions: (typeof assessmentQuestions.$inferSelect)[];
    optionsByQuestion: Map<string, (typeof questionOptions.$inferSelect)[]>;
    mappingsByQuestion: Map<
      string,
      ((typeof questionDimensions.$inferSelect) & { dimensionCode: string; dimensionName: string })[]
    >;
  }> {
    const questions = await this.db
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, versionId))
      .orderBy(asc(assessmentQuestions.orderNumber));

    const options = await this.db
      .select({ option: questionOptions })
      .from(questionOptions)
      .innerJoin(assessmentQuestions, eq(questionOptions.questionId, assessmentQuestions.id))
      .where(eq(assessmentQuestions.assessmentVersionId, versionId))
      .orderBy(asc(questionOptions.orderNumber));

    const mappings = await this.db
      .select({
        mapping: questionDimensions,
        dimensionCode: assessmentDimensions.code,
        dimensionName: assessmentDimensions.name,
      })
      .from(questionDimensions)
      .innerJoin(assessmentQuestions, eq(questionDimensions.questionId, assessmentQuestions.id))
      .innerJoin(assessmentDimensions, eq(questionDimensions.dimensionId, assessmentDimensions.id))
      .where(eq(assessmentQuestions.assessmentVersionId, versionId));

    const optionsByQuestion = new Map<string, (typeof questionOptions.$inferSelect)[]>();

    for (const { option } of options) {
      const list = optionsByQuestion.get(option.questionId) ?? [];
      list.push(option);
      optionsByQuestion.set(option.questionId, list);
    }

    const mappingsByQuestion = new Map<
      string,
      ((typeof questionDimensions.$inferSelect) & { dimensionCode: string; dimensionName: string })[]
    >();

    for (const { mapping, dimensionCode, dimensionName } of mappings) {
      const list = mappingsByQuestion.get(mapping.questionId) ?? [];
      list.push({ ...mapping, dimensionCode, dimensionName });
      mappingsByQuestion.set(mapping.questionId, list);
    }

    return { questions, optionsByQuestion, mappingsByQuestion };
  }

  /**
   * Edit one question's text/required flag during review (§31: "review/edit text and
   * options"). DRAFT versions only — invariant 1 reaches every row beneath a published
   * version, this one included.
   *
   * Editing deliberately does **not** clear the mappings' `confirmed_at`: the mapping is a
   * claim about *what the question measures*, and rewording the question is exactly what the
   * reviewer is expected to do while confirming that claim. A reword so radical it changes
   * the construct is the reviewer's own act, made while looking straight at the mapping.
   */
  async updateQuestion(
    questionId: string,
    changes: { questionText?: string; required?: boolean },
  ): Promise<typeof assessmentQuestions.$inferSelect> {
    const [question] = await this.db
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.id, questionId))
      .limit(1);

    if (question === undefined) {
      throw ApiError.notFound('Question not found.');
    }

    const version = await this.findVersion(question.assessmentVersionId);

    if (version === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    this.assertVersionEditable(version);

    const updated = {
      ...question,
      questionText: changes.questionText ?? question.questionText,
      required: changes.required ?? question.required,
    };

    await this.db
      .update(assessmentQuestions)
      .set({ questionText: updated.questionText, required: updated.required })
      .where(eq(assessmentQuestions.id, questionId));

    return updated;
  }

  /** The mapping row + its version/template ids, for authorization before a confirm. */
  async findMapping(mappingId: string): Promise<
    | {
        mapping: typeof questionDimensions.$inferSelect;
        versionId: string;
        templateId: string;
      }
    | undefined
  > {
    const [row] = await this.db
      .select({
        mapping: questionDimensions,
        versionId: assessmentQuestions.assessmentVersionId,
        templateId: assessmentVersions.assessmentTemplateId,
      })
      .from(questionDimensions)
      .innerJoin(assessmentQuestions, eq(questionDimensions.questionId, assessmentQuestions.id))
      .innerJoin(
        assessmentVersions,
        eq(assessmentQuestions.assessmentVersionId, assessmentVersions.id),
      )
      .where(eq(questionDimensions.id, mappingId))
      .limit(1);

    return row;
  }

  /**
   * **The §25 confirmation, one mapping at a time.** Sets `confirmed_at` + `confirmed_by` —
   * the pair the publish gate counts. Idempotent: confirming a confirmed mapping keeps the
   * original reviewer, because "who looked at this" is provenance and the first look is the
   * one that admitted it past the gate.
   *
   * There is deliberately **no bulk form** (§31: "no 'approve all' shortcut … the entire
   * point of the gate is that a human actually looked at each dimension assignment"). §20's
   * endpoint list sketches a `confirm-all-mappings` helper; §31 forbids exactly that, and the
   * contradiction is resolved toward §31 — deviation recorded in PROGRESS.md.
   */
  async confirmMapping(
    user: User,
    mappingId: string,
  ): Promise<typeof questionDimensions.$inferSelect> {
    const found = await this.findMapping(mappingId);

    if (found === undefined) {
      throw ApiError.notFound('Question-dimension mapping not found.');
    }

    const version = await this.findVersion(found.versionId);

    if (version === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    // A published version's mappings are frozen — and necessarily all confirmed already.
    this.assertVersionEditable(version);

    if (found.mapping.confirmedAt !== null) {
      return found.mapping;
    }

    const confirmed = { ...found.mapping, confirmedAt: now(), confirmedBy: user.id };

    await this.db
      .update(questionDimensions)
      .set({ confirmedAt: confirmed.confirmedAt, confirmedBy: confirmed.confirmedBy })
      .where(eq(questionDimensions.id, mappingId));

    await this.audit.write({
      userId: user.id,
      action: 'QUESTION_DIMENSION_CONFIRMED',
      module: MODULE,
      targetType: 'question_dimension',
      targetId: mappingId,
      newValues: { question_id: found.mapping.questionId, dimension_id: found.mapping.dimensionId },
    });

    return confirmed;
  }
}
