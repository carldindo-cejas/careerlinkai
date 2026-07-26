import { asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  assessmentScorings,
  assessmentTemplateScorings,
  assessmentTypeScorings,
  assessmentTypes,
  type AssessmentScoring,
  type AssessmentType,
} from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';

/**
 * The assessment taxonomy (migration 0014) — types, scoring methods, and **which pairs are legal**.
 *
 * The compatibility matrix is the reason this file exists rather than a constant. "An Intelligence
 * test may report IQ Scores; a Learning Style inventory may not" is enforced in two places by
 * necessity — the dropdown has to filter as the administrator types, and the server has to refuse a
 * client that ignores the dropdown. Written as a TypeScript map, those two places become two
 * transcriptions of the same list and eventually disagree. Written as rows, `listTypes()` hands the
 * client the same 80 rows `assertCompatible()` validates against, so the client is *filtering by the
 * rule* rather than by a copy of it.
 *
 * Nothing here is a policy question: the taxonomy is global reference data, and the route group's
 * role gate is the whole authorization story (the same shape as the catalog and address modules).
 */

/** A type with the ids of every scoring method the matrix permits for it. */
export interface TypeWithScorings {
  type: AssessmentType;
  scoringIds: string[];
}

export class AssessmentTaxonomyService {
  constructor(private readonly db: Database) {}

  /**
   * Every type, in curated order, each carrying its allowed scoring ids.
   *
   * **Two queries, never one per type.** The client needs the whole matrix up front precisely so
   * that changing the type re-filters the scoring multi-select with no request at all; fetching
   * per-type would put a round trip in the middle of a keystroke.
   */
  async listTypes(): Promise<TypeWithScorings[]> {
    const types = await this.db
      .select()
      .from(assessmentTypes)
      .orderBy(asc(assessmentTypes.orderNumber));

    const pairs = await this.db
      .select({
        typeId: assessmentTypeScorings.assessmentTypeId,
        scoringId: assessmentTypeScorings.assessmentScoringId,
      })
      .from(assessmentTypeScorings)
      .innerJoin(
        assessmentScorings,
        eq(assessmentTypeScorings.assessmentScoringId, assessmentScorings.id),
      )
      // Ordered by the scoring's own display order, so the client can render the filtered list
      // without re-sorting it against the scoring lookup.
      .orderBy(asc(assessmentScorings.orderNumber));

    const scoringIdsByType = new Map<string, string[]>();

    for (const pair of pairs) {
      const list = scoringIdsByType.get(pair.typeId) ?? [];
      list.push(pair.scoringId);
      scoringIdsByType.set(pair.typeId, list);
    }

    return types.map((type) => ({ type, scoringIds: scoringIdsByType.get(type.id) ?? [] }));
  }

  async listScorings(): Promise<AssessmentScoring[]> {
    return this.db
      .select()
      .from(assessmentScorings)
      .orderBy(asc(assessmentScorings.orderNumber));
  }

  async findType(typeId: string): Promise<AssessmentType | undefined> {
    const [type] = await this.db
      .select()
      .from(assessmentTypes)
      .where(eq(assessmentTypes.id, typeId))
      .limit(1);

    return type;
  }

  /**
   * Resolve a seeded type by its stable `code`.
   *
   * Code rather than id at the call site, deliberately: the seeded UUIDs are fixed and could be
   * pasted in, but `'INTEREST'` says what the row *is* where `a55e7001-…-004` says only where it
   * lives. Everything that names a taxonomy row from code — the instrument seeder, the tests —
   * goes through here, so there is one place a rename would have to be reconciled.
   */
  async typeByCode(code: string): Promise<AssessmentType> {
    const [type] = await this.db
      .select()
      .from(assessmentTypes)
      .where(eq(assessmentTypes.code, code))
      .limit(1);

    if (type === undefined) {
      throw new Error(`Assessment type "${code}" is missing — migration 0014 has not been applied.`);
    }

    return type;
  }

  /** Resolve seeded scoring rows by their stable codes, in the order the codes were given. */
  async scoringIdsByCodes(codes: string[]): Promise<string[]> {
    const rows = await this.db
      .select({ id: assessmentScorings.id, code: assessmentScorings.code })
      .from(assessmentScorings)
      .where(inArray(assessmentScorings.code, codes));

    const byCode = new Map(rows.map((row) => [row.code, row.id]));

    return codes.map((code) => {
      const id = byCode.get(code);

      if (id === undefined) {
        throw new Error(
          `Assessment scoring "${code}" is missing — migration 0014 has not been applied.`,
        );
      }

      return id;
    });
  }

  /** The scoring methods the matrix allows for one type, in display order. */
  async allowedScoringsFor(typeId: string): Promise<AssessmentScoring[]> {
    return this.db
      .select({
        id: assessmentScorings.id,
        code: assessmentScorings.code,
        name: assessmentScorings.name,
        description: assessmentScorings.description,
        orderNumber: assessmentScorings.orderNumber,
        createdAt: assessmentScorings.createdAt,
        updatedAt: assessmentScorings.updatedAt,
      })
      .from(assessmentTypeScorings)
      .innerJoin(
        assessmentScorings,
        eq(assessmentTypeScorings.assessmentScoringId, assessmentScorings.id),
      )
      .where(eq(assessmentTypeScorings.assessmentTypeId, typeId))
      .orderBy(asc(assessmentScorings.orderNumber));
  }

  /**
   * **The server-side half of the dynamic validation.**
   *
   * A 422 with the offending method named, never a bare "invalid": whoever sees this is looking at
   * a form with fifteen options in it, and "Percentage Scores is not a valid scoring method for
   * Interest" is the difference between fixing it and guessing. Three failures are distinguished
   * because they have three different fixes — an unknown type, an unknown scoring, and a pair that
   * is simply not meaningful.
   *
   * Runs in **three queries regardless of how many methods were chosen**, and returns the resolved
   * rows so the caller does not re-read what this already loaded.
   */
  async assertCompatible(
    typeId: string,
    scoringIds: string[],
  ): Promise<{ type: AssessmentType; scorings: AssessmentScoring[] }> {
    const type = await this.findType(typeId);

    if (type === undefined) {
      throw ApiError.validation(
        { assessment_type_id: ['That assessment type does not exist.'] },
        'Unknown assessment type.',
      );
    }

    // A duplicate id in the payload would otherwise reach the (template, scoring) unique index as a
    // raw 500 — caught here, where the field can be named (L5's rule, as in `addDimensions`).
    const unique = [...new Set(scoringIds)];

    if (unique.length !== scoringIds.length) {
      throw ApiError.validation(
        { scoring_ids: ['The same scoring method was selected more than once.'] },
        'Duplicate scoring method.',
      );
    }

    if (unique.length === 0) {
      throw ApiError.validation(
        { scoring_ids: ['Select at least one scoring method.'] },
        'An assessment needs at least one scoring method.',
      );
    }

    const chosen = await this.db
      .select()
      .from(assessmentScorings)
      .where(inArray(assessmentScorings.id, unique));

    if (chosen.length !== unique.length) {
      throw ApiError.validation(
        { scoring_ids: ['One of the selected scoring methods does not exist.'] },
        'Unknown scoring method.',
      );
    }

    const allowed = new Set(
      (
        await this.db
          .select({ scoringId: assessmentTypeScorings.assessmentScoringId })
          .from(assessmentTypeScorings)
          .where(eq(assessmentTypeScorings.assessmentTypeId, typeId))
      ).map((row) => row.scoringId),
    );

    const rejected = chosen.filter((scoring) => !allowed.has(scoring.id));

    if (rejected.length > 0) {
      throw ApiError.validation(
        {
          scoring_ids: rejected.map(
            (scoring) => `${scoring.name} is not a valid scoring method for ${type.name}.`,
          ),
        },
        'Incompatible scoring method for this assessment type.',
      );
    }

    // Returned in the lookup's display order, not the order the client happened to send.
    const order = new Map(chosen.map((scoring) => [scoring.id, scoring]));

    return {
      type,
      scorings: [...order.values()].sort((a, b) => a.orderNumber - b.orderNumber),
    };
  }

  // --- One assessment's chosen methods -------------------------------------------------------

  /**
   * Replace an assessment's scoring methods wholesale, in **one batch**.
   *
   * Delete-then-insert rather than a diff: the set is at most fifteen rows, a diff would be three
   * statements instead of two to save nothing, and the batch is what makes "the old set is gone and
   * the new set is present" a single transition rather than a window in which the assessment has no
   * scoring at all.
   */
  async setTemplateScorings(templateId: string, scoringIds: string[]): Promise<void> {
    const rows = [...new Set(scoringIds)].map((scoringId) => ({
      id: uuid(),
      assessmentTemplateId: templateId,
      assessmentScoringId: scoringId,
      createdAt: now(),
    }));

    const remove = this.db
      .delete(assessmentTemplateScorings)
      .where(eq(assessmentTemplateScorings.assessmentTemplateId, templateId));

    if (rows.length === 0) {
      await remove;

      return;
    }

    await this.db.batch([remove, this.db.insert(assessmentTemplateScorings).values(rows)]);
  }

  /** The chosen methods for many assessments at once, keyed by template id (no per-row fan-out). */
  async scoringsForTemplates(templateIds: string[]): Promise<Map<string, AssessmentScoring[]>> {
    const byTemplate = new Map<string, AssessmentScoring[]>();

    if (templateIds.length === 0) {
      return byTemplate;
    }

    const rows = await this.db
      .select({
        templateId: assessmentTemplateScorings.assessmentTemplateId,
        scoring: assessmentScorings,
      })
      .from(assessmentTemplateScorings)
      .innerJoin(
        assessmentScorings,
        eq(assessmentTemplateScorings.assessmentScoringId, assessmentScorings.id),
      )
      .where(inArray(assessmentTemplateScorings.assessmentTemplateId, templateIds))
      .orderBy(asc(assessmentScorings.orderNumber));

    for (const row of rows) {
      const list = byTemplate.get(row.templateId) ?? [];
      list.push(row.scoring);
      byTemplate.set(row.templateId, list);
    }

    return byTemplate;
  }

  /** The types of many assessments at once, keyed by type id. */
  async typesByIds(typeIds: string[]): Promise<Map<string, AssessmentType>> {
    const byId = new Map<string, AssessmentType>();

    if (typeIds.length === 0) {
      return byId;
    }

    const types = await this.db
      .select()
      .from(assessmentTypes)
      .where(inArray(assessmentTypes.id, typeIds));

    for (const type of types) {
      byId.set(type.id, type);
    }

    return byId;
  }
}
