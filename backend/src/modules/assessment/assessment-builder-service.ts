import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Database } from '@/db/client';
import type {
  AssessmentCategory,
  AssessmentOwnership,
  QuestionSource,
  QuestionType,
} from '@/db/enums';
import {
  assessmentAssignments,
  assessmentAttempts,
  assessmentDimensions,
  assessmentQuestions,
  assessmentTemplates,
  assessmentVersions,
  questionDimensions,
  questionOptions,
  type AssessmentDimension,
  type AssessmentQuestion,
  type AssessmentTemplate,
  type AssessmentVersion,
  type InterpretationRange,
  type QuestionOption,
  type ScoringConfig,
  type User,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { chunkForInsert } from '@/lib/d1-batching';
import { now } from '@/lib/datetime';
import { translateUniqueViolation } from '@/lib/db-errors';
import { ApiError } from '@/lib/envelope';
import { AssessmentTaxonomyService } from '@/modules/assessment/assessment-taxonomy-service';
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

// D1's 100-parameter ceiling and the chunking it forces live in `lib/d1-batching.ts`. The widths
// used to be written out here as literals; `chunkForInsert` derives them from the table instead,
// because the one place that hand-counted a width had it wrong (see that file).

export interface CreateTemplateInput {
  category: AssessmentCategory;
  title: string;
  description?: string | null;
  ownership?: AssessmentOwnership;
  /** Migration 0014 — required by the API on every create; the column is nullable only for history. */
  assessmentTypeId: string;
  /** Validated against the type before anything is written. At least one. */
  scoringIds: string[];
}

/** Every field of an assessment's *description of itself* is editable; its content is not. */
export interface UpdateTemplateInput {
  title: string;
  description?: string | null;
  assessmentTypeId: string;
  scoringIds: string[];
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

/**
 * One question to write. **There is no `orderNumber` here, and that is the point**
 * (ASSESSMENT-FIX §4): every caller used to compute the position itself, and they did not agree —
 * the bulk-add route used `COUNT + 1`, `duplicateQuestion` used `MAX + 1`, and the §31 generation
 * job numbered from 1 regardless of what the version already held, which silently gave two
 * questions the same position whenever an author drafted with AI into a version they had started by
 * hand. `addQuestions` appends, in array order, from `MAX + 1`; there is now one rule and no way for
 * a caller to hold it wrong.
 */
export interface CreateQuestionInput {
  questionText: string;
  questionType: QuestionType;
  sectionLabel?: string | null;
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

/**
 * Whether an assessment may be removed, and — when it may not — **why**, in the words the
 * confirmation dialog shows (prompt-driven, v1.6).
 *
 * Two blockers, and they are refusals for genuinely different reasons:
 *
 *   * `HAS_RESPONSES` — a student has answered this instrument. §12 makes the attempt → answer →
 *     result chain permanent historical evidence with no soft delete anywhere in it; removing the
 *     instrument those rows describe would leave every one of them pointing at a title nobody can
 *     read. This one can never be worked around, only outlived by archiving instead.
 *   * `HAS_ACTIVE_ASSIGNMENTS` — a class is sitting for it right now. Recoverable: close the
 *     assignments (which is the explicit act that expires the in-flight attempts, §21) and the
 *     delete is permitted — though by then the first blocker usually applies, which is the point.
 */
export type DeleteBlocker = 'HAS_RESPONSES' | 'HAS_ACTIVE_ASSIGNMENTS';

export interface Deletability {
  canDelete: boolean;
  blockers: DeleteBlocker[];
  /** How many attempts exist against any version — the number the dialog quotes back. */
  attemptCount: number;
  /** Distinct classes holding an ACTIVE assignment for any version. */
  activeAssignmentCount: number;
}

/** Nothing found: the shape a template with no versions, attempts or assignments resolves to. */
const DELETABLE: Deletability = {
  canDelete: true,
  blockers: [],
  attemptCount: 0,
  activeAssignmentCount: 0,
};

/**
 * "Question 3", "Questions 3 and 7", "Questions 3, 7 and 9" — the offending items, **named**.
 *
 * The publish gate's refusals are read by someone who now has to go and fix them, and a count alone
 * ("2 questions are incomplete") sends them scrolling through sixty items to find which two.
 */
function questionList(orderNumbers: number[]): string {
  const label = orderNumbers.length === 1 ? 'Question' : 'Questions';
  const numbers =
    orderNumbers.length <= 1
      ? orderNumbers.join('')
      : `${orderNumbers.slice(0, -1).join(', ')} and ${orderNumbers.at(-1)}`;

  return `${label} ${numbers}`;
}

export class AssessmentBuilderService {
  private readonly audit: AuditService;
  private readonly taxonomy: AssessmentTaxonomyService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
    this.taxonomy = new AssessmentTaxonomyService(db);
  }

  // --- Templates ---------------------------------------------------------------------------

  /**
   * **The type/scoring combination is validated before the template row is written**, not after.
   *
   * The order matters: validating afterwards would leave a template with no scoring methods behind
   * every rejected save, and the list would fill up with half-created assessments that an
   * administrator has to clean out by hand. D1 has no interactive transaction spanning the two, so
   * "check first" is what stands in for one.
   */
  async createTemplate(user: User, input: CreateTemplateInput): Promise<AssessmentTemplate> {
    await this.taxonomy.assertCompatible(input.assessmentTypeId, input.scoringIds);
    await this.assertTitleAvailable(input.title);

    const template: AssessmentTemplate = {
      id: uuid(),
      creatorId: user.id,
      category: input.category,
      title: input.title,
      description: input.description ?? null,
      assessmentTypeId: input.assessmentTypeId,
      ownership: input.ownership ?? 'GLOBAL',
      status: 'DRAFT',
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      deletedBy: null,
    };

    await this.db.insert(assessmentTemplates).values(template);
    await this.taxonomy.setTemplateScorings(template.id, input.scoringIds);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_TEMPLATE_CREATED',
      module: MODULE,
      targetType: 'assessment_template',
      targetId: template.id,
      newValues: {
        category: template.category,
        title: template.title,
        assessment_type_id: template.assessmentTypeId,
        scoring_ids: input.scoringIds,
      },
    });

    return template;
  }

  /**
   * Edit what an assessment *says about itself* — its title, description, type and scoring methods.
   *
   * Deliberately **not** gated on publication, unlike everything in §12's freeze rules, and the
   * distinction is worth stating: the freeze exists because a published version's *content* decides
   * what a delivered result means, and none of these four fields does. Correcting a typo'd title, or
   * classifying an instrument that predates the taxonomy, changes how the assessment is described,
   * never how an attempt was scored.
   *
   * Changing the type re-validates the scoring set against the new type in the same call, so an
   * assessment cannot be walked into an illegal combination by editing one field at a time.
   */
  async updateTemplate(
    user: User,
    template: AssessmentTemplate,
    input: UpdateTemplateInput,
  ): Promise<AssessmentTemplate> {
    await this.taxonomy.assertCompatible(input.assessmentTypeId, input.scoringIds);
    await this.assertTitleAvailable(input.title, template.id);

    const updated: AssessmentTemplate = {
      ...template,
      title: input.title,
      description: input.description ?? null,
      assessmentTypeId: input.assessmentTypeId,
      updatedAt: now(),
    };

    await this.db
      .update(assessmentTemplates)
      .set({
        title: updated.title,
        description: updated.description,
        assessmentTypeId: updated.assessmentTypeId,
        updatedAt: updated.updatedAt,
      })
      .where(eq(assessmentTemplates.id, template.id));

    await this.taxonomy.setTemplateScorings(template.id, input.scoringIds);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_TEMPLATE_UPDATED',
      module: MODULE,
      targetType: 'assessment_template',
      targetId: template.id,
      oldValues: { title: template.title, assessment_type_id: template.assessmentTypeId },
      newValues: {
        title: updated.title,
        assessment_type_id: updated.assessmentTypeId,
        scoring_ids: input.scoringIds,
      },
    });

    return updated;
  }

  /**
   * Archive an assessment: it disappears from the assignable list and can no longer be assigned.
   *
   * **Existing active assignments are left alone, on purpose.** Closing an assignment is not a
   * status flip — §21 expires every attempt still in progress underneath it — so archiving an
   * instrument must not quietly end the assessment a class is sitting for this afternoon. Ending
   * that work stays an explicit act on the assignment itself. Draft versions are archived with the
   * template, because an editable draft under a retired instrument is a way back in.
   */
  async archiveTemplate(user: User, template: AssessmentTemplate): Promise<AssessmentTemplate> {
    if (template.status === 'ARCHIVED') {
      return template; // Idempotent — archiving an archived assessment is not an error.
    }

    const timestamp = now();

    await this.db.batch([
      this.db
        .update(assessmentTemplates)
        .set({ status: 'ARCHIVED', updatedAt: timestamp })
        .where(eq(assessmentTemplates.id, template.id)),
      this.db
        .update(assessmentVersions)
        .set({ status: 'ARCHIVED' })
        .where(
          and(
            eq(assessmentVersions.assessmentTemplateId, template.id),
            eq(assessmentVersions.status, 'DRAFT'),
          ),
        ),
    ]);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_TEMPLATE_ARCHIVED',
      module: MODULE,
      targetType: 'assessment_template',
      targetId: template.id,
      oldValues: { status: template.status },
      newValues: { status: 'ARCHIVED' },
    });

    return { ...template, status: 'ARCHIVED', updatedAt: timestamp };
  }

  /**
   * Bring an archived assessment back.
   *
   * It returns to `ACTIVE` if it still has a published version and `DRAFT` if it does not — the same
   * two states `publish()` maintains, so restore lands the row where publishing would have left it
   * rather than inventing a third condition. Versions archived by `archiveTemplate` are **not**
   * un-archived: a version's status is its own history (§12), and a draft that was retired is
   * reopened by creating the next version, which is the rule everywhere else in this file.
   */
  async restoreTemplate(user: User, template: AssessmentTemplate): Promise<AssessmentTemplate> {
    if (template.status !== 'ARCHIVED') {
      return template;
    }

    const published = await this.assignableVersion(template.id);
    const status = published === undefined ? 'DRAFT' : 'ACTIVE';
    const timestamp = now();

    await this.db
      .update(assessmentTemplates)
      .set({ status, updatedAt: timestamp })
      .where(eq(assessmentTemplates.id, template.id));

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_TEMPLATE_RESTORED',
      module: MODULE,
      targetType: 'assessment_template',
      targetId: template.id,
      oldValues: { status: template.status },
      newValues: { status },
    });

    return { ...template, status, updatedAt: timestamp };
  }

  // --- Delete (prompt-driven, v1.6) ---------------------------------------------------------

  /**
   * **A soft delete, and deliberately not a hard one** (§12).
   *
   * `assessment_templates` is on §12's soft-delete list, and the reason is visible from here: the
   * template is the parent of versions → questions → options → mappings, and every FK beneath it
   * cascades. A hard `DELETE` would therefore be a silent, unrecoverable cascade through the
   * authoring history of an instrument — and, if the guards below were ever wrong, through rows the
   * attempt chain still references. Setting `deleted_at` removes it from every list in the system
   * (each one opens with `deleted_at IS NULL`) while leaving the rows for a restore or an audit.
   *
   * **The two guards are re-checked here, not only at the route.** The list ships a `can_delete`
   * flag so the UI can explain itself, but that flag is a snapshot: a student can start an attempt
   * between the page load and the click. The authoritative check is this one, inside the act.
   *
   * Archived is not a precondition. Delete is a *stronger* act than archive, not a later step in a
   * workflow, and forcing an administrator to archive first would only mean two confirmations for
   * one decision.
   */
  async deleteTemplate(user: User, template: AssessmentTemplate): Promise<AssessmentTemplate> {
    const deletability = await this.deletability(template.id);

    if (!deletability.canDelete) {
      throw ApiError.validation(
        { assessment: [describeBlockers(deletability)] },
        'This assessment cannot be deleted.',
      );
    }

    const timestamp = now();

    /**
     * The template is soft-deleted and its versions are archived in one batch. Leaving a DRAFT
     * version editable under a deleted template is the same back door `archiveTemplate` closes —
     * only worse, because nothing lists the template any more to notice it.
     */
    await this.db.batch([
      this.db
        .update(assessmentTemplates)
        .set({
          deletedAt: timestamp,
          deletedBy: user.id,
          status: 'ARCHIVED',
          updatedAt: timestamp,
        })
        .where(eq(assessmentTemplates.id, template.id)),
      this.db
        .update(assessmentVersions)
        .set({ status: 'ARCHIVED' })
        .where(
          and(
            eq(assessmentVersions.assessmentTemplateId, template.id),
            eq(assessmentVersions.status, 'DRAFT'),
          ),
        ),
    ]);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_TEMPLATE_DELETED',
      module: MODULE,
      targetType: 'assessment_template',
      targetId: template.id,
      oldValues: { status: template.status, title: template.title },
      newValues: {
        deleted_at: timestamp,
        soft_delete: true,
        /** Recorded because the guards passing is itself the fact someone will audit later. */
        attempts_at_deletion: deletability.attemptCount,
        active_assignments_at_deletion: deletability.activeAssignmentCount,
      },
    });

    return {
      ...template,
      status: 'ARCHIVED',
      deletedAt: timestamp,
      deletedBy: user.id,
      updatedAt: timestamp,
    };
  }

  /** One template's delete eligibility — the authoritative check, and the detail view's answer. */
  async deletability(templateId: string): Promise<Deletability> {
    return (await this.deletabilityFor([templateId])).get(templateId) ?? DELETABLE;
  }

  /**
   * Delete eligibility for a whole page of templates, in **two queries regardless of page size**.
   *
   * The administrator's table renders a Delete button per row and has to know whether each one is
   * permitted; asking per row is the same N+1 the rest of `AssessmentAdminService` was written to
   * avoid. Both queries group by template id through the version join, so a template with nine
   * versions still contributes one row to each result.
   */
  async deletabilityFor(templateIds: string[]): Promise<Map<string, Deletability>> {
    const byTemplate = new Map<string, Deletability>();

    if (templateIds.length === 0) {
      return byTemplate;
    }

    const [attemptRows, assignmentRows] = await Promise.all([
      this.db
        .select({ templateId: assessmentVersions.assessmentTemplateId, total: count() })
        .from(assessmentAttempts)
        .innerJoin(
          assessmentVersions,
          eq(assessmentAttempts.assessmentVersionId, assessmentVersions.id),
        )
        .where(inArray(assessmentVersions.assessmentTemplateId, templateIds))
        .groupBy(assessmentVersions.assessmentTemplateId),
      this.db
        .select({
          templateId: assessmentVersions.assessmentTemplateId,
          total: sql<number>`COUNT(DISTINCT ${assessmentAssignments.classId})`,
        })
        .from(assessmentAssignments)
        .innerJoin(
          assessmentVersions,
          eq(assessmentAssignments.assessmentVersionId, assessmentVersions.id),
        )
        .where(
          and(
            inArray(assessmentVersions.assessmentTemplateId, templateIds),
            eq(assessmentAssignments.status, 'ACTIVE'),
          ),
        )
        .groupBy(assessmentVersions.assessmentTemplateId),
    ]);

    const attemptsByTemplate = new Map(attemptRows.map((row) => [row.templateId, row.total]));
    const assignmentsByTemplate = new Map(
      assignmentRows.map((row) => [row.templateId, Number(row.total)]),
    );

    for (const templateId of templateIds) {
      const attemptCount = attemptsByTemplate.get(templateId) ?? 0;
      const activeAssignmentCount = assignmentsByTemplate.get(templateId) ?? 0;
      const blockers: DeleteBlocker[] = [];

      /**
       * **Every attempt counts, including an EXPIRED one.** An expired attempt is still a record
       * of a student having sat this instrument (§21 — it is history, never deleted), and its
       * answers still point at these questions.
       */
      if (attemptCount > 0) {
        blockers.push('HAS_RESPONSES');
      }

      if (activeAssignmentCount > 0) {
        blockers.push('HAS_ACTIVE_ASSIGNMENTS');
      }

      byTemplate.set(templateId, {
        canDelete: blockers.length === 0,
        blockers,
        attemptCount,
        activeAssignmentCount,
      });
    }

    return byTemplate;
  }

  /**
   * Two live assessments must not share a title (case-insensitively).
   *
   * A Service pre-check rather than a unique index, exactly as in the catalog (§39): templates are
   * soft-deleted, and a deleted "Study Habits Survey" keeping its name forever would otherwise block
   * the real one permanently. The narrow race this leaves — two simultaneous creates of the same
   * title — produces two rows rather than an error, which is the failure the catalog already accepts
   * and is visible and fixable in the list, unlike a name nobody can reuse.
   */
  private async assertTitleAvailable(title: string, exceptTemplateId?: string): Promise<void> {
    const clash = await this.db
      .select({ id: assessmentTemplates.id })
      .from(assessmentTemplates)
      .where(
        and(
          isNull(assessmentTemplates.deletedAt),
          sql`LOWER(${assessmentTemplates.title}) = LOWER(${title})`,
          exceptTemplateId === undefined
            ? undefined
            : sql`${assessmentTemplates.id} <> ${exceptTemplateId}`,
        ),
      )
      .limit(1);

    if (clash.length > 0) {
      throw ApiError.validation(
        { title: ['An assessment with that title already exists.'] },
        'Duplicate assessment title.',
      );
    }
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

  // --- Batched lookups for the template list (H5) ------------------------------------------
  //
  // The counselor `GET /assessment-templates` screen used to call `assignableVersion`,
  // `questionCount` and `dimensionsFor` **once per template** — the same per-row fan-out class as
  // C1, at a smaller N. These three return the whole list in one query each, so the route costs a
  // fixed handful of reads regardless of how many instruments the counselor can see.

  /** The newest PUBLISHED version for each template id, keyed by template id. */
  async assignableVersionsFor(templateIds: string[]): Promise<Map<string, AssessmentVersion>> {
    const byTemplate = new Map<string, AssessmentVersion>();

    if (templateIds.length === 0) {
      return byTemplate;
    }

    const versions = await this.db
      .select()
      .from(assessmentVersions)
      .where(
        and(
          inArray(assessmentVersions.assessmentTemplateId, templateIds),
          eq(assessmentVersions.status, 'PUBLISHED'),
        ),
      )
      .orderBy(sql`${assessmentVersions.versionNumber} DESC`);

    // DESC order means the first version seen for a template is its newest — keep that one.
    for (const version of versions) {
      if (!byTemplate.has(version.assessmentTemplateId)) {
        byTemplate.set(version.assessmentTemplateId, version);
      }
    }

    return byTemplate;
  }

  /** Question counts for many versions at once, keyed by version id. */
  async questionCountsFor(versionIds: string[]): Promise<Map<string, number>> {
    const byVersion = new Map<string, number>();

    if (versionIds.length === 0) {
      return byVersion;
    }

    const counts = await this.db
      .select({ versionId: assessmentQuestions.assessmentVersionId, total: count() })
      .from(assessmentQuestions)
      .where(inArray(assessmentQuestions.assessmentVersionId, versionIds))
      .groupBy(assessmentQuestions.assessmentVersionId);

    for (const row of counts) {
      byVersion.set(row.versionId, row.total);
    }

    return byVersion;
  }

  /** Dimensions for many templates at once, keyed by template id, each list in order_number order. */
  async dimensionsForTemplates(
    templateIds: string[],
  ): Promise<Map<string, AssessmentDimension[]>> {
    const byTemplate = new Map<string, AssessmentDimension[]>();

    if (templateIds.length === 0) {
      return byTemplate;
    }

    const dimensions = await this.db
      .select()
      .from(assessmentDimensions)
      .where(inArray(assessmentDimensions.assessmentTemplateId, templateIds))
      .orderBy(asc(assessmentDimensions.orderNumber));

    for (const dimension of dimensions) {
      const list = byTemplate.get(dimension.assessmentTemplateId) ?? [];
      list.push(dimension);
      byTemplate.set(dimension.assessmentTemplateId, list);
    }

    return byTemplate;
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

    // L5: a duplicate code *within the payload* would otherwise reach the unique index
    // (template_id, code) as a raw 500. Catch it here where the field can be named precisely.
    const seen = new Set<string>();
    for (const input of inputs) {
      if (seen.has(input.code)) {
        throw ApiError.validation(
          { code: [`Dimension code "${input.code}" appears more than once in this request.`] },
          'Duplicate dimension code.',
        );
      }
      seen.add(input.code);
    }

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
      try {
        await this.db.insert(assessmentDimensions).values(rows);
      } catch (error) {
        // A code already on this template (or a concurrent add of the same code) loses at the
        // (template_id, code) unique index — surface it as a 422, not a 500 (L5/H4).
        translateUniqueViolation(
          error,
          'code',
          'A dimension with that code already exists on this template.',
        );
      }
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
        {
          dimensions: ['This template has a published version, so its dimensions are frozen.'],
        },
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
      /** Never at creation — a draft has not published, and 0016's NULL says exactly that. */
      publishedAt: null,
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
  ): Promise<typeof assessmentQuestions.$inferSelect | undefined> {
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
  async addQuestion(
    user: User,
    versionId: string,
    input: CreateQuestionInput,
  ): Promise<string> {
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
    /**
     * The positions, resolved **once for the batch** rather than per caller (see
     * `CreateQuestionInput`). Read before the insert and written by it, so two concurrent adds can
     * still read the same base — which is why migration 0021 puts a unique index underneath: the
     * loser of that race gets a 422 telling it to try again instead of a second question quietly
     * claiming position 7.
     */
    const firstOrderNumber = await this.nextOrderNumber(versionId);

    const questionRows: (typeof assessmentQuestions.$inferInsert)[] = [];
    const optionRows: (typeof questionOptions.$inferInsert)[] = [];
    const mappingRows: (typeof questionDimensions.$inferInsert)[] = [];

    for (const [index, input] of inputs.entries()) {
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
        orderNumber: firstOrderNumber + index,
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
      ...chunkForInsert(questionRows, assessmentQuestions).map((rows) =>
        this.db.insert(assessmentQuestions).values(rows),
      ),
      ...chunkForInsert(optionRows, questionOptions).map((rows) =>
        this.db.insert(questionOptions).values(rows),
      ),
      ...chunkForInsert(mappingRows, questionDimensions).map((rows) =>
        this.db.insert(questionDimensions).values(rows),
      ),
    ];

    try {
      await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    } catch (error) {
      /**
       * The only unique index these inserts can lose at is `(assessment_version_id, order_number)`
       * — the option rows all belong to question ids minted a few lines above, so nothing else in
       * the database can be holding one of their keys. Losing it means another add landed between
       * this batch's `nextOrderNumber` read and its write, which is ordinary concurrency (two tabs,
       * a double-click) rather than a server fault, so it gets the 422 H4 asks for.
       */
      translateUniqueViolation(
        error,
        'questions',
        'Another question was added to this version a moment ago. Reload and try again.',
      );
    }

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

    const questions = await this.db
      .select({
        id: assessmentQuestions.id,
        orderNumber: assessmentQuestions.orderNumber,
        questionText: assessmentQuestions.questionText,
      })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, versionId))
      .orderBy(asc(assessmentQuestions.orderNumber));

    if (questions.length === 0) {
      throw ApiError.validation(
        {
          questions: ['A version must have at least one question before it can be published.'],
        },
        'This version has no questions.',
      );
    }

    await this.assertEveryQuestionIsFinished(version, questions);

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

    /**
     * **One timestamp for both writes** (migration 0016). Publishing is a single act, so the date
     * the version records and the date the template's `updated_at` moves to have to be the same
     * instant — two `now()` calls would differ by a millisecond and make "published today, last
     * edited today" render as two different times for one event.
     */
    const publishedAt = now();

    await this.db.batch([
      this.db
        .update(assessmentVersions)
        .set({ status: 'PUBLISHED', publishedAt })
        .where(eq(assessmentVersions.id, versionId)),
      // The template becomes ACTIVE the moment it has something assignable.
      this.db
        .update(assessmentTemplates)
        .set({ status: 'ACTIVE', updatedAt: publishedAt })
        .where(eq(assessmentTemplates.id, version.assessmentTemplateId)),
    ]);

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
        published_at: publishedAt,
      },
    });

    return { ...version, status: 'PUBLISHED', publishedAt };
  }

  /**
   * The two states a **draft** may legitimately be in and a published instrument may not: an item
   * with no text, and an item that measures nothing (ASSESSMENT-FIX §1, §3).
   *
   * Both are deliberate while authoring. The builder creates a question blank and unmapped on
   * purpose — guessing text, or guessing which dimension an item loads onto, would be worse than
   * asking — and nothing downstream ever revisited that decision before publish. Neither state is
   * survivable afterwards, because publishing is irreversible (invariant 1) and *nothing reports the
   * damage*: a version that goes out with an unmapped item scores it into nothing forever, and the
   * student sees a normal question and a normal-looking result that quietly did not count it.
   *
   * The mapping check is skipped when the template has **no dimensions at all**, and that is not a
   * loophole — it is the distinction the old gate could not make. An assessment with no dimensions
   * is an ungraded survey, which the builder offers in as many words ("This assessment has no
   * dimensions, so it will publish as an ungraded survey"). The defect is an author who *has*
   * dimensions and forgot to map an item to one; before this, a reflection instrument and a
   * forgotten mapping produced the identical empty result and were indistinguishable from outside.
   */
  private async assertEveryQuestionIsFinished(
    version: AssessmentVersion,
    questions: { id: string; orderNumber: number; questionText: string }[],
  ): Promise<void> {
    const blank = questions
      .filter((question) => question.questionText.trim() === '')
      .map((question) => question.orderNumber);

    if (blank.length > 0) {
      throw ApiError.validation(
        {
          questions: [
            `${questionList(blank)} ${blank.length === 1 ? 'has' : 'have'} no text yet.`,
          ],
        },
        'Every question must have text before this version can be published.',
      );
    }

    const dimensions = await this.dimensionsFor(version.assessmentTemplateId);

    if (dimensions.length === 0) {
      return;
    }

    const mapped = await this.db
      .select({ questionId: questionDimensions.questionId })
      .from(questionDimensions)
      .innerJoin(assessmentQuestions, eq(questionDimensions.questionId, assessmentQuestions.id))
      .where(eq(assessmentQuestions.assessmentVersionId, version.id));

    const mappedIds = new Set(mapped.map((row) => row.questionId));
    const unmapped = questions
      .filter((question) => !mappedIds.has(question.id))
      .map((question) => question.orderNumber);

    if (unmapped.length > 0) {
      throw ApiError.validation(
        {
          question_dimensions: [
            `${questionList(unmapped)} ${unmapped.length === 1 ? 'measures' : 'measure'} nothing — every question must map to at least one dimension.`,
          ],
        },
        'Some questions are not mapped to a dimension, so nothing they measure would be scored.',
      );
    }
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
      (typeof questionDimensions.$inferSelect & {
        dimensionCode: string;
        dimensionName: string;
      })[]
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
      .innerJoin(
        assessmentDimensions,
        eq(questionDimensions.dimensionId, assessmentDimensions.id),
      )
      .where(eq(assessmentQuestions.assessmentVersionId, versionId));

    const optionsByQuestion = new Map<string, (typeof questionOptions.$inferSelect)[]>();

    for (const { option } of options) {
      const list = optionsByQuestion.get(option.questionId) ?? [];
      list.push(option);
      optionsByQuestion.set(option.questionId, list);
    }

    const mappingsByQuestion = new Map<
      string,
      (typeof questionDimensions.$inferSelect & {
        dimensionCode: string;
        dimensionName: string;
      })[]
    >();

    for (const { mapping, dimensionCode, dimensionName } of mappings) {
      const list = mappingsByQuestion.get(mapping.questionId) ?? [];
      list.push({ ...mapping, dimensionCode, dimensionName });
      mappingsByQuestion.set(mapping.questionId, list);
    }

    return { questions, optionsByQuestion, mappingsByQuestion };
  }

  /**
   * Edit one question in place (§31: "review/edit text and options"; extended by the v1.6 builder
   * to the whole item — type, section, options and mappings, not only the text). DRAFT versions
   * only: invariant 1 reaches every row beneath a published version, this one included.
   *
   * Rewording deliberately does **not** clear the mappings' `confirmed_at`: the mapping is a claim
   * about *what the question measures*, and rewording is exactly what the reviewer is expected to
   * do while confirming that claim. **Replacing the mapping set is different** — a mapping that did
   * not exist a moment ago has not been confirmed by anyone, so the rows written below carry the
   * editing user's confirmation precisely because a human is the one typing them (§25's rule, the
   * same one `addQuestions` applies to a MANUAL question). An AI-proposed mapping that the author
   * leaves alone keeps its unconfirmed state, because it is not touched.
   *
   * Options and mappings are **replaced wholesale rather than diffed**, in one batch with the
   * question row. A diff would have to decide what a "changed" option is — the label? the score? —
   * and get it wrong for the one case that matters: an author reordering two options with different
   * scores. Delete-then-insert has no such ambiguity, and `assessment_answers.selected_option_id`
   * cannot be orphaned by it because a DRAFT version has no attempts (invariant 1 is what
   * guarantees that, and it is checked two lines up).
   */
  async updateQuestion(
    user: User,
    questionId: string,
    changes: {
      questionText?: string;
      questionType?: QuestionType;
      sectionLabel?: string | null;
      required?: boolean;
      options?: { label: string; value: string; score: number }[];
      dimensionCodes?: string[];
    },
  ): Promise<AssessmentQuestion> {
    const { question, version } = await this.editableQuestion(questionId);

    const updated: AssessmentQuestion = {
      ...question,
      questionText: changes.questionText ?? question.questionText,
      questionType: changes.questionType ?? question.questionType,
      sectionLabel: changes.sectionLabel === undefined ? question.sectionLabel : changes.sectionLabel,
      required: changes.required ?? question.required,
    };

    const statements: BatchItem<'sqlite'>[] = [
      this.db
        .update(assessmentQuestions)
        .set({
          questionText: updated.questionText,
          questionType: updated.questionType,
          sectionLabel: updated.sectionLabel,
          required: updated.required,
        })
        .where(eq(assessmentQuestions.id, questionId)),
    ];

    if (changes.options !== undefined) {
      statements.push(
        this.db.delete(questionOptions).where(eq(questionOptions.questionId, questionId)),
        ...chunkForInsert(
          changes.options.map((option, index) => ({
            id: uuid(),
            questionId,
            label: option.label,
            value: option.value,
            score: option.score,
            orderNumber: index + 1,
          })),
          questionOptions,
        ).map((rows) => this.db.insert(questionOptions).values(rows)),
      );
    }

    if (changes.dimensionCodes !== undefined) {
      const dimensions = await this.dimensionsFor(version.assessmentTemplateId);
      const dimensionByCode = new Map(dimensions.map((dimension) => [dimension.code, dimension]));
      const timestamp = now();

      const mappingRows = changes.dimensionCodes.map((code) => {
        const dimension = dimensionByCode.get(code);

        if (dimension === undefined) {
          throw ApiError.validation(
            { dimension_codes: [`Unknown dimension code "${code}" for this template.`] },
            'A question cannot map to a dimension that does not exist on its template.',
          );
        }

        return {
          id: uuid(),
          questionId,
          dimensionId: dimension.id,
          weight: 1,
          confirmedAt: timestamp,
          confirmedBy: user.id,
        };
      });

      statements.push(
        this.db.delete(questionDimensions).where(eq(questionDimensions.questionId, questionId)),
        ...chunkForInsert(mappingRows, questionDimensions).map((rows) =>
          this.db.insert(questionDimensions).values(rows),
        ),
      );
    }

    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    return updated;
  }

  /**
   * Copy a question — text, type, options and mappings — as the next item in its version.
   *
   * The copy is **MANUAL and confirmed even when the original was AI-generated**, and that is the
   * only interesting decision here. Duplicating is an authoring act: a human looked at an item and
   * decided to make another one like it. Inheriting `AI_GENERATED` would misattribute the author's
   * own work to the model, and inheriting an unconfirmed mapping would let a copy sit in the publish
   * gate as though nobody had seen it — when the person who made the copy plainly had.
   */
  async duplicateQuestion(user: User, questionId: string): Promise<string> {
    const { question, version } = await this.editableQuestion(questionId);

    const [options, mappings] = await Promise.all([
      this.db
        .select()
        .from(questionOptions)
        .where(eq(questionOptions.questionId, questionId))
        .orderBy(asc(questionOptions.orderNumber)),
      this.db
        .select({ code: assessmentDimensions.code, weight: questionDimensions.weight })
        .from(questionDimensions)
        .innerJoin(
          assessmentDimensions,
          eq(questionDimensions.dimensionId, assessmentDimensions.id),
        )
        .where(eq(questionDimensions.questionId, questionId)),
    ]);

    const [newId] = await this.addQuestions(user, version.id, [
      {
        questionText: question.questionText,
        questionType: question.questionType,
        sectionLabel: question.sectionLabel,
        // Appended, not inserted beside the original — an author who wants it elsewhere drags it.
        // `addQuestions` is what positions it; this method no longer has an opinion.
        required: question.required,
        source: 'MANUAL',
        options: options.map((option, index) => ({
          label: option.label,
          value: option.value,
          score: option.score,
          orderNumber: index + 1,
        })),
        dimensions: mappings.map((mapping) => ({ code: mapping.code, weight: mapping.weight })),
      },
    ]);

    if (newId === undefined) {
      throw ApiError.notFound('Question not found.');
    }

    return newId;
  }

  /**
   * Remove one question from a DRAFT version, **closing the gap it leaves in the numbering**.
   *
   * `order_number` is what the player renders items in and what every author-facing list sorts by,
   * so leaving a hole would work until someone inserted a question and found two items claiming
   * position 7. The renumber is folded into the same batch as the delete: the two must not be
   * separately observable. Options and mappings go with the row through their FK cascades.
   *
   * **The shift is two statements rather than one, because of migration 0021.** SQLite enforces a
   * unique index *per row as it is written*, and a single `order_number = order_number - 1` over
   * the tail collides with itself the moment the engine happens to update a row before the one
   * below it — an order this file does not get to choose, since `UPDATE` has no defined row order.
   * Parking the tail on negative numbers first vacates the whole positive range, so the second pass
   * lands every row on a position nothing can be holding. Both are inside the batch, so the
   * negative interlude is never observable.
   *
   * It takes a `user` for the audit row (ASSESSMENT-FIX §7). Removing an item from a draft is a
   * real authoring act by an identifiable person, and it was the one mutator here leaving no trace.
   */
  async deleteQuestion(user: User, questionId: string): Promise<void> {
    const { question, version } = await this.editableQuestion(questionId);

    await this.db.batch([
      this.db.delete(assessmentQuestions).where(eq(assessmentQuestions.id, questionId)),
      this.db
        .update(assessmentQuestions)
        .set({ orderNumber: sql`-(${assessmentQuestions.orderNumber} - 1)` })
        .where(
          and(
            eq(assessmentQuestions.assessmentVersionId, version.id),
            sql`${assessmentQuestions.orderNumber} > ${question.orderNumber}`,
          ),
        ),
      this.db
        .update(assessmentQuestions)
        .set({ orderNumber: sql`-${assessmentQuestions.orderNumber}` })
        .where(
          and(
            eq(assessmentQuestions.assessmentVersionId, version.id),
            sql`${assessmentQuestions.orderNumber} < 0`,
          ),
        ),
    ]);

    await this.audit.write({
      userId: user.id,
      action: 'ASSESSMENT_QUESTION_DELETED',
      module: MODULE,
      targetType: 'assessment_question',
      targetId: questionId,
      oldValues: {
        assessment_version_id: version.id,
        order_number: question.orderNumber,
        question_text: question.questionText,
        source: question.source,
      },
    });
  }

  /**
   * Reorder a DRAFT version's questions — the drag-and-drop save.
   *
   * The payload must name **every** question in the version exactly once. A partial list would be a
   * request whose meaning depends on where the unlisted items are supposed to end up, and there is
   * no honest default: silently appending them changes an order the author did not touch. So a
   * mismatch is a 422 naming the discrepancy rather than a best-effort write.
   *
   * Every row is renumbered in one batch, and the numbering is rewritten from 1 rather than patched,
   * so a version whose numbering had drifted comes out consistent.
   */
  async reorderQuestions(versionId: string, questionIds: string[]): Promise<void> {
    const version = await this.findVersion(versionId);

    if (version === undefined) {
      throw ApiError.notFound('Assessment version not found.');
    }

    this.assertVersionEditable(version);

    const existing = await this.db
      .select({ id: assessmentQuestions.id })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, versionId));

    const existingIds = new Set(existing.map((row) => row.id));
    const submitted = new Set(questionIds);

    if (
      submitted.size !== questionIds.length ||
      submitted.size !== existingIds.size ||
      questionIds.some((id) => !existingIds.has(id))
    ) {
      throw ApiError.validation(
        {
          question_ids: [
            `Send every question in this version exactly once — ${existingIds.size} expected, ${questionIds.length} received.`,
          ],
        },
        'The new order must list every question in this version.',
      );
    }

    if (questionIds.length === 0) {
      return;
    }

    /**
     * **Two passes, and the negative interlude is the load-bearing part.**
     *
     * Migration 0021 makes `(assessment_version_id, order_number)` unique, and SQLite has no
     * deferred mode for a unique index — it is enforced as each row is written. Every real
     * reordering passes through a state where two rows would claim the same position (the simplest
     * possible drag, swapping two items, does it on the first statement), so writing the final
     * numbers directly would fail on every drag that actually changed something. Parking each row
     * at `-(position)` vacates the entire positive range first; the flip back is then a single
     * statement whose targets are all free. One batch, so nothing observes the negatives.
     */
    const statements: BatchItem<'sqlite'>[] = [
      ...questionIds.map((id, index) =>
        this.db
          .update(assessmentQuestions)
          .set({ orderNumber: -(index + 1) })
          .where(eq(assessmentQuestions.id, id)),
      ),
      this.db
        .update(assessmentQuestions)
        .set({ orderNumber: sql`-${assessmentQuestions.orderNumber}` })
        .where(
          and(
            eq(assessmentQuestions.assessmentVersionId, versionId),
            sql`${assessmentQuestions.orderNumber} < 0`,
          ),
        ),
    ];

    await this.db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  }

  /**
   * The position an appended question takes: `MAX(order_number) + 1`.
   *
   * `MAX + 1` rather than `COUNT + 1`, which are the same number only while the numbering is
   * gapless. `deleteQuestion` keeps it gapless today, so the two agree — but a count would produce
   * a *collision* the day anything did leave a hole, and two items claiming the same position is a
   * bug that surfaces as an arbitrary render order rather than as an error. The bulk-add route did
   * use a count, against this comment, until ASSESSMENT-FIX §4; positioning now lives in
   * `addQuestions` alone, which is the only way the two cannot drift again.
   */
  private async nextOrderNumber(versionId: string): Promise<number> {
    const [row] = await this.db
      .select({ highest: sql<number | null>`MAX(${assessmentQuestions.orderNumber})` })
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentVersionId, versionId));

    return (row?.highest ?? 0) + 1;
  }

  /**
   * One question plus its version, refusing anything the freeze rules put out of reach.
   *
   * Every mutating question path starts here rather than repeating the two lookups and the
   * `assertVersionEditable` call — which is what stops one of them from quietly not making it.
   */
  private async editableQuestion(
    questionId: string,
  ): Promise<{ question: AssessmentQuestion; version: AssessmentVersion }> {
    const [row] = await this.db
      .select({ question: assessmentQuestions, version: assessmentVersions })
      .from(assessmentQuestions)
      .innerJoin(
        assessmentVersions,
        eq(assessmentQuestions.assessmentVersionId, assessmentVersions.id),
      )
      .where(eq(assessmentQuestions.id, questionId))
      .limit(1);

    if (row === undefined) {
      throw ApiError.notFound('Question not found.');
    }

    this.assertVersionEditable(row.version);

    return row;
  }

  /** One question's options and mappings, for the builder's optimistic per-question refresh. */
  async questionContent(questionId: string): Promise<{
    options: QuestionOption[];
    mappings: (typeof questionDimensions.$inferSelect & {
      dimensionCode: string;
      dimensionName: string;
    })[];
  }> {
    const [options, mappings] = await Promise.all([
      this.db
        .select()
        .from(questionOptions)
        .where(eq(questionOptions.questionId, questionId))
        .orderBy(asc(questionOptions.orderNumber)),
      this.db
        .select({
          mapping: questionDimensions,
          dimensionCode: assessmentDimensions.code,
          dimensionName: assessmentDimensions.name,
        })
        .from(questionDimensions)
        .innerJoin(
          assessmentDimensions,
          eq(questionDimensions.dimensionId, assessmentDimensions.id),
        )
        .where(eq(questionDimensions.questionId, questionId)),
    ]);

    return {
      options,
      mappings: mappings.map((row) => ({
        ...row.mapping,
        dimensionCode: row.dimensionCode,
        dimensionName: row.dimensionName,
      })),
    };
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
      newValues: {
        question_id: found.mapping.questionId,
        dimension_id: found.mapping.dimensionId,
      },
    });

    return confirmed;
  }
}

/**
 * The refusal, in the sentence the confirmation dialog prints (prompt-driven, v1.6).
 *
 * The message is built here rather than in the frontend so the API's 422 and the disabled button's
 * tooltip say the same thing — a dialog that explains "there are responses" while the server
 * answers something else is how a user learns to distrust both. It names *numbers*, because
 * "cannot be deleted" with no quantity is a dead end for whoever has to decide what to do next.
 */
export function describeBlockers(deletability: Deletability): string {
  const reasons: string[] = [];

  if (deletability.blockers.includes('HAS_RESPONSES')) {
    reasons.push(
      `${deletability.attemptCount} student ${
        deletability.attemptCount === 1 ? 'response' : 'responses'
      } exist for it, and assessment history is never deleted — archive it instead`,
    );
  }

  if (deletability.blockers.includes('HAS_ACTIVE_ASSIGNMENTS')) {
    reasons.push(
      `it is currently assigned to ${deletability.activeAssignmentCount} ${
        deletability.activeAssignmentCount === 1 ? 'class' : 'classes'
      } — close those assignments first`,
    );
  }

  if (reasons.length === 0) {
    return 'This assessment can be deleted.';
  }

  return `This assessment cannot be deleted: ${reasons.join('; and ')}.`;
}
