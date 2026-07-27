import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '@/db/client';
import type { AssignmentScope } from '@/db/enums';
import {
  assessmentAssignments,
  assessmentQuestions,
  assessmentTemplates,
  assessmentTypes,
  assessmentVersions,
  type AssessmentScoring,
  type AssessmentTemplate,
  type AssessmentType,
  type AssessmentVersion,
  type User,
} from '@/db/schema';
import { paginate, type PaginatedData } from '@/lib/envelope';
import {
  AssessmentBuilderService,
  type Deletability,
} from '@/modules/assessment/assessment-builder-service';
import { AssessmentTaxonomyService } from '@/modules/assessment/assessment-taxonomy-service';
import type { ListAssessmentsQuery } from '@/modules/assessment/schemas';

/**
 * The administrator's assessment list (prompt-driven, v1.5) — one searchable, sortable, filterable,
 * paginated table over every instrument in the system.
 *
 * **The whole file is about not doing per-row work.** The list shows, for each assessment, its type,
 * its scoring methods, every version it has, whether one of them is published, and whether it is
 * assigned globally or to particular classes. Read naively that is five lookups per row, and a
 * twenty-row page becomes a hundred queries — the same fan-out the counselor template list was
 * fixed for in H5. Everything below is therefore either part of the page query or a single grouped
 * lookup keyed by the page's template ids: **five queries for a page, whatever the page size.**
 *
 * Three of the four filters ask about rows in *other* tables ("has a published version", "is
 * assigned globally"), so they are `EXISTS` subqueries inside the page query rather than a
 * post-filter in TypeScript. Filtering after the fact would page over the unfiltered set and hand
 * back short pages with wrong totals.
 */

/** How an assessment is reaching students right now — the list's `Assignment` column. */
export interface AssignmentSummary {
  /** `GLOBAL` wins over `CLASS`: an assessment every class already has is not "some classes". */
  scope: AssignmentScope | null;
  /** Distinct classes with an ACTIVE assignment, whatever the scope. */
  classCount: number;
}

export interface AssessmentListRow {
  template: AssessmentTemplate;
  type: AssessmentType | null;
  scorings: AssessmentScoring[];
  /** Every version, newest first — the list renders `v3, v2, v1` and folds the tail into "+N more". */
  versions: AssessmentVersion[];
  /** The newest PUBLISHED version, or `undefined` when there is nothing assignable yet. */
  publishedVersion: AssessmentVersion | undefined;
  /** Questions in the published version — 0 when nothing is published. */
  questionCount: number;
  assignment: AssignmentSummary;
  /**
   * Whether the Delete action is offered, and the reason when it is not (v1.6). Resolved here
   * rather than per row for the same reason everything else on this interface is: a Delete button
   * that asked the server about itself would be one request per row.
   */
  deletability: Deletability;
}

/**
 * The dates the table shows (v1.6).
 *
 * `created_at` and `updated_at` are the template's own columns. **Publication is not** — a template
 * has no publish date, because publishing happens to a *version*. So the assessment's Date Published
 * is derived from the versions the row already carries: `publishedAt` is the newest, the date it
 * last became available to students, and `firstPublishedAt` is the oldest, "in service since".
 *
 * Derived rather than denormalized onto the template, and derived **from rows already loaded**
 * rather than from a fifth query: `versionsFor` fetches every version of every template on the page
 * anyway, so this costs nothing. A denormalized column would have to be maintained by every path
 * that publishes, and the one that forgot would be silently wrong forever.
 */
export interface AssessmentDates {
  createdAt: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
  firstPublishedAt: string | null;
}

export function assessmentDates(row: AssessmentListRow): AssessmentDates {
  const published = row.versions
    .map((version) => version.publishedAt)
    .filter((date): date is string => date !== null)
    // ISO-8601 UTC strings compare lexically (§12), so this is a real chronological sort.
    .sort();

  return {
    createdAt: row.template.createdAt,
    updatedAt: row.template.updatedAt,
    publishedAt: published.at(-1) ?? null,
    firstPublishedAt: published[0] ?? null,
  };
}

export class AssessmentAdminService {
  private readonly taxonomy: AssessmentTaxonomyService;
  private readonly builder: AssessmentBuilderService;

  constructor(private readonly db: Database) {
    this.taxonomy = new AssessmentTaxonomyService(db);
    this.builder = new AssessmentBuilderService(db);
  }

  async list(user: User, query: ListAssessmentsQuery): Promise<PaginatedData<AssessmentListRow>> {
    const where = and(isNull(assessmentTemplates.deletedAt), ...this.filters(user, query));

    const [total] = await this.db
      .select({ value: count() })
      .from(assessmentTemplates)
      .where(where);

    // LEFT JOIN, not INNER: an assessment that predates the taxonomy has no type and must still
    // appear in the list — it is precisely the row an administrator needs to find and fix.
    const page = await this.db
      .select({ template: assessmentTemplates, type: assessmentTypes })
      .from(assessmentTemplates)
      .leftJoin(assessmentTypes, eq(assessmentTemplates.assessmentTypeId, assessmentTypes.id))
      .where(where)
      .orderBy(...this.ordering(query))
      .limit(query.per_page)
      .offset((query.page - 1) * query.per_page);

    const templateIds = page.map((row) => row.template.id);

    // The grouped lookups. Each is one query for the whole page, whatever the page size.
    const [versionsByTemplate, scoringsByTemplate, assignmentByTemplate, deletabilityByTemplate] =
      await Promise.all([
        this.versionsFor(templateIds),
        this.taxonomy.scoringsForTemplates(templateIds),
        this.assignmentSummaryFor(templateIds),
        this.builder.deletabilityFor(templateIds),
      ]);

    const publishedVersionIds = templateIds
      .map((id) => newestPublished(versionsByTemplate.get(id) ?? []))
      .filter((version): version is AssessmentVersion => version !== undefined)
      .map((version) => version.id);

    const questionCountByVersion = await this.questionCountsFor(publishedVersionIds);

    const items = page.map((row) => {
      const versions = versionsByTemplate.get(row.template.id) ?? [];
      const publishedVersion = newestPublished(versions);

      return {
        template: row.template,
        type: row.type,
        scorings: scoringsByTemplate.get(row.template.id) ?? [],
        versions,
        publishedVersion,
        questionCount:
          publishedVersion === undefined
            ? 0
            : (questionCountByVersion.get(publishedVersion.id) ?? 0),
        assignment: assignmentByTemplate.get(row.template.id) ?? { scope: null, classCount: 0 },
        deletability: deletabilityByTemplate.get(row.template.id) ?? {
          canDelete: true,
          blockers: [],
          attemptCount: 0,
          activeAssignmentCount: 0,
        },
      };
    });

    return paginate(items, total?.value ?? 0, query.page, query.per_page);
  }

  /**
   * One assessment's list row — the same shape the table renders, so the edit dialog and the
   * post-save refresh read one contract rather than two.
   */
  async row(template: AssessmentTemplate): Promise<AssessmentListRow> {
    const versions = (await this.versionsFor([template.id])).get(template.id) ?? [];
    const publishedVersion = newestPublished(versions);
    const type =
      template.assessmentTypeId === null
        ? null
        : ((await this.taxonomy.findType(template.assessmentTypeId)) ?? null);

    return {
      template,
      type,
      scorings: (await this.taxonomy.scoringsForTemplates([template.id])).get(template.id) ?? [],
      versions,
      publishedVersion,
      questionCount:
        publishedVersion === undefined
          ? 0
          : ((await this.questionCountsFor([publishedVersion.id])).get(publishedVersion.id) ?? 0),
      assignment: (await this.assignmentSummaryFor([template.id])).get(template.id) ?? {
        scope: null,
        classCount: 0,
      },
      deletability: await this.builder.deletability(template.id),
    };
  }

  // --- Filters, sorting ------------------------------------------------------------------------

  private filters(user: User, query: ListAssessmentsQuery): SQL[] {
    const clauses: SQL[] = [];

    /**
     * The same visibility rule as the counselor template list: an admin sees everything, anyone
     * else sees the GLOBAL instruments plus their own. It lives here rather than in a policy for
     * the reason `listTemplatesFor` gives — this is a query shape ("which rows exist for you"), and
     * a policy answering it would mean loading every template and filtering in memory.
     */
    if (user.role !== 'admin') {
      clauses.push(
        sql`(${assessmentTemplates.ownership} = 'GLOBAL' OR ${assessmentTemplates.creatorId} = ${user.id})`,
      );
    }

    const search = query.search?.trim();

    if (search !== undefined && search.length > 0) {
      const term = `%${search}%`;
      const matches = or(
        like(assessmentTemplates.title, term),
        like(assessmentTemplates.description, term),
      );

      if (matches !== undefined) {
        clauses.push(matches);
      }
    }

    if (query.assessment_type_id !== undefined) {
      clauses.push(eq(assessmentTemplates.assessmentTypeId, query.assessment_type_id));
    }

    if (query.status === 'ARCHIVED') {
      clauses.push(eq(assessmentTemplates.status, 'ARCHIVED'));
    }

    if (query.status === 'PUBLISHED') {
      clauses.push(sql`${assessmentTemplates.status} <> 'ARCHIVED'`);
      clauses.push(this.hasPublishedVersion());
    }

    if (query.status === 'UNPUBLISHED') {
      clauses.push(sql`${assessmentTemplates.status} <> 'ARCHIVED'`);
      clauses.push(sql`NOT ${this.hasPublishedVersion()}`);
    }

    if (query.assignment === 'GLOBAL') {
      clauses.push(this.hasActiveAssignment('GLOBAL'));
    }

    if (query.assignment === 'CLASS') {
      // "Specific class(es)" means *only* class-scoped: an assessment that is also global belongs
      // under Global, or the two filters would return overlapping sets and neither would mean much.
      clauses.push(this.hasActiveAssignment('CLASS'));
      clauses.push(sql`NOT ${this.hasActiveAssignment('GLOBAL')}`);
    }

    if (query.assignment === 'UNASSIGNED') {
      clauses.push(sql`NOT ${this.hasActiveAssignment()}`);
    }

    /**
     * The three date ranges (v1.6). Two are plain column comparisons; the third is not.
     *
     * `created_at` and `updated_at` live on the template, so `>= from` / `<= to` is exactly right —
     * and correct as *string* comparison, because §12 stores ISO-8601 UTC, which sorts lexically.
     *
     * **Date Published has no column to compare.** Publishing happens to a version, so the filter
     * asks a question about a *related row*: does this template have a version published inside the
     * window? That is an `EXISTS`, for the same reason the status and assignment filters are — a
     * post-filter in TypeScript would page over the unfiltered set and hand back short pages with
     * wrong totals. It also gives the right answer to the subtle case: a template with three
     * versions matches if *any* of them published in the window, which is what someone asking
     * "what went live in March" means.
     */
    if (query.created_from !== undefined) {
      clauses.push(gte(assessmentTemplates.createdAt, query.created_from));
    }

    if (query.created_to !== undefined) {
      clauses.push(lte(assessmentTemplates.createdAt, query.created_to));
    }

    if (query.updated_from !== undefined) {
      clauses.push(gte(assessmentTemplates.updatedAt, query.updated_from));
    }

    if (query.updated_to !== undefined) {
      clauses.push(lte(assessmentTemplates.updatedAt, query.updated_to));
    }

    if (query.published_from !== undefined || query.published_to !== undefined) {
      clauses.push(this.publishedWithin(query.published_from, query.published_to));
    }

    return clauses;
  }

  /**
   * `EXISTS` a version of this template published inside the window.
   *
   * **`published_at IS NOT NULL` is the whole test, and the version's current status is
   * deliberately not part of it.** A version only ever receives that stamp by publishing, so the
   * column *is* the record that publication happened — and a version that published in March and
   * was archived in June still published in March. Adding `status = 'PUBLISHED'` here would answer
   * a different question ("is it published *now*"), and it would answer it inconsistently with the
   * `published_at` this same row displays, which is derived from the stamp alone. The filter, the
   * sort and the value shown are one definition; that is what stops a row from being visible under
   * a date range it does not appear to match.
   */
  private publishedWithin(from: string | undefined, to: string | undefined): SQL {
    const lowerBound =
      from === undefined ? sql`` : sql` AND ${assessmentVersions.publishedAt} >= ${from}`;
    const upperBound =
      to === undefined ? sql`` : sql` AND ${assessmentVersions.publishedAt} <= ${to}`;

    return sql`EXISTS (
      SELECT 1 FROM ${assessmentVersions}
       WHERE ${assessmentVersions.assessmentTemplateId} = ${assessmentTemplates.id}
         AND ${assessmentVersions.publishedAt} IS NOT NULL${lowerBound}${upperBound}
    )`;
  }

  private hasPublishedVersion(): SQL {
    return sql`EXISTS (
      SELECT 1 FROM ${assessmentVersions}
       WHERE ${assessmentVersions.assessmentTemplateId} = ${assessmentTemplates.id}
         AND ${assessmentVersions.status} = 'PUBLISHED'
    )`;
  }

  /** `EXISTS` an ACTIVE assignment on any version of this template, optionally of one scope. */
  private hasActiveAssignment(scope?: AssignmentScope): SQL {
    const scopeClause =
      scope === undefined ? sql`` : sql` AND ${assessmentAssignments.scope} = ${scope}`;

    return sql`EXISTS (
      SELECT 1
        FROM ${assessmentAssignments}
        JOIN ${assessmentVersions}
          ON ${assessmentVersions.id} = ${assessmentAssignments.assessmentVersionId}
       WHERE ${assessmentVersions.assessmentTemplateId} = ${assessmentTemplates.id}
         AND ${assessmentAssignments.status} = 'ACTIVE'${scopeClause}
    )`;
  }

  private ordering(query: ListAssessmentsQuery): SQL[] {
    const direction = query.direction === 'desc' ? desc : asc;

    switch (query.sort) {
      case 'type':
        // NULLs sort last in both directions — an untyped assessment is missing data, not a value
        // that belongs at the top of an A–Z list.
        return [
          sql`${assessmentTypes.orderNumber} IS NULL`,
          direction(assessmentTypes.orderNumber),
          asc(assessmentTemplates.title),
        ];
      case 'created_at':
        return [direction(assessmentTemplates.createdAt), asc(assessmentTemplates.title)];
      case 'updated_at':
        return [direction(assessmentTemplates.updatedAt), asc(assessmentTemplates.title)];
      case 'published_at':
        /**
         * A correlated `MAX()` rather than a column, because the date is a fact about the
         * template's *versions* (see `assessmentDates`). Never-published rows sort last in both
         * directions, for the same reason an untyped assessment does above: NULL is missing data,
         * not a value that belongs at the top of a chronological list.
         */
        return [
          sql`${this.newestPublishedAt()} IS NULL`,
          direction(sql`${this.newestPublishedAt()}`),
          asc(assessmentTemplates.title),
        ];
      case 'status':
        return [direction(assessmentTemplates.status), asc(assessmentTemplates.title)];
      case 'title':
      default:
        return [direction(assessmentTemplates.title)];
    }
  }

  /**
   * The newest publication date across a template's versions, as a scalar subquery.
   *
   * `MAX()` skips NULLs, so no status filter is needed — and none is wanted, for the reason
   * `publishedWithin` gives: this has to agree exactly with the `published_at` the row displays,
   * which is derived from the same stamps. A version status clause here and not there is how a
   * sorted column ends up disagreeing with the values printed in it.
   */
  private newestPublishedAt(): SQL {
    return sql`(
      SELECT MAX(${assessmentVersions.publishedAt}) FROM ${assessmentVersions}
       WHERE ${assessmentVersions.assessmentTemplateId} = ${assessmentTemplates.id}
    )`;
  }

  // --- The grouped lookups ---------------------------------------------------------------------

  /** Every version of every template on the page, newest first, in one query. */
  private async versionsFor(templateIds: string[]): Promise<Map<string, AssessmentVersion[]>> {
    const byTemplate = new Map<string, AssessmentVersion[]>();

    if (templateIds.length === 0) {
      return byTemplate;
    }

    const versions = await this.db
      .select()
      .from(assessmentVersions)
      .where(inArray(assessmentVersions.assessmentTemplateId, templateIds))
      .orderBy(desc(assessmentVersions.versionNumber));

    for (const version of versions) {
      const list = byTemplate.get(version.assessmentTemplateId) ?? [];
      list.push(version);
      byTemplate.set(version.assessmentTemplateId, list);
    }

    return byTemplate;
  }

  private async questionCountsFor(versionIds: string[]): Promise<Map<string, number>> {
    const byVersion = new Map<string, number>();

    if (versionIds.length === 0) {
      return byVersion;
    }

    const rows = await this.db
      .select({ versionId: assessmentQuestions.assessmentVersionId, total: count() })
      .from(assessmentQuestions)
      .where(inArray(assessmentQuestions.assessmentVersionId, versionIds))
      .groupBy(assessmentQuestions.assessmentVersionId);

    for (const row of rows) {
      byVersion.set(row.versionId, row.total);
    }

    return byVersion;
  }

  /**
   * Scope + distinct class count per template, in one grouped query.
   *
   * `GLOBAL` wins when both kinds of row exist: an assessment that already reaches every class is
   * not honestly described as reaching "specific classes", even if someone also assigned it to one
   * by hand beforehand.
   */
  private async assignmentSummaryFor(
    templateIds: string[],
  ): Promise<Map<string, AssignmentSummary>> {
    const byTemplate = new Map<string, AssignmentSummary>();

    if (templateIds.length === 0) {
      return byTemplate;
    }

    // Conditional aggregation rather than one group per scope: grouping by scope too would count a
    // class that holds both a global and a hand-made assignment twice, and `COUNT(DISTINCT …)`
    // across the whole template is the number the column actually claims to show.
    const rows = await this.db
      .select({
        templateId: assessmentVersions.assessmentTemplateId,
        classes: sql<number>`COUNT(DISTINCT ${assessmentAssignments.classId})`,
        anyGlobal: sql<number>`MAX(CASE WHEN ${assessmentAssignments.scope} = 'GLOBAL' THEN 1 ELSE 0 END)`,
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
      .groupBy(assessmentVersions.assessmentTemplateId);

    for (const row of rows) {
      byTemplate.set(row.templateId, {
        scope: Number(row.anyGlobal) === 1 ? 'GLOBAL' : 'CLASS',
        classCount: Number(row.classes),
      });
    }

    return byTemplate;
  }
}

/** Versions arrive newest-first, so the first PUBLISHED one is the newest PUBLISHED one. */
function newestPublished(versions: AssessmentVersion[]): AssessmentVersion | undefined {
  return versions.find((version) => version.status === 'PUBLISHED');
}
