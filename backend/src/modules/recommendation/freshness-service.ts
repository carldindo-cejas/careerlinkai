import { asc, count, eq, isNull, lt, max } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { appSettings, recommendations, users } from '@/db/schema';
import { now } from '@/lib/datetime';

/**
 * **Is a student's recommendation set still what the system would say today?** (2026-09-22)
 *
 * Recommendations are persisted snapshots (§26 — reproducible, not recomputed on every read). That
 * was fine while the catalog and the formula were fixed; since admins can re-link what a program
 * leads to (migration 0040) and re-weight the formula, a set can quietly describe a catalog that no
 * longer exists. Nothing on any screen said so.
 *
 * This keeps one timestamp — the last time anything §27 scores against changed — and calls a set
 * **stale** when it was generated before it. One row, written by the routes that change scoring
 * inputs; read by the admin Matching page (how many are stale, recompute them) and by the set
 * serializers (so a counselor can see a card was scored against an older configuration).
 *
 * A timestamp rather than a revision counter because the comparison it serves is against
 * `recommendations.created_at`, which is already a timestamp: "generated before the last change" is
 * the whole question, and a counter would need a second column on every recommendation to answer it.
 *
 * It is deliberately coarse. Editing a career's salary marks every set stale although no score
 * moves — the alternative is a list of which fields are "scoring" fields, maintained forever in
 * step with `lib/recommendation.ts`, to save an admin one unnecessary recompute.
 */

export const INPUTS_CHANGED_KEY = 'recommendation_inputs_changed_at';

export interface FreshnessSummary {
  /** When scoring inputs last changed; null if never (every set is then current). */
  inputsChangedAt: string | null;
  studentsWithSets: number;
  staleSets: number;
}

export class RecommendationFreshnessService {
  constructor(private readonly db: Database) {}

  /** Record that something §27 scores against just changed. One upsert; never throws past D1. */
  async touch(actorId: string | null = null): Promise<void> {
    const timestamp = now();

    await this.db
      .insert(appSettings)
      .values({
        key: INPUTS_CHANGED_KEY,
        value: timestamp,
        updatedBy: actorId,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: timestamp, updatedBy: actorId, updatedAt: timestamp },
      });
  }

  async changedAt(): Promise<string | null> {
    const row = await this.db.query.appSettings.findFirst({
      where: eq(appSettings.key, INPUTS_CHANGED_KEY),
    });

    return row?.value ?? null;
  }

  /** Whether a set generated at `generatedAt` predates the last change. */
  static isStale(generatedAt: string, inputsChangedAt: string | null): boolean {
    return inputsChangedAt !== null && generatedAt < inputsChangedAt;
  }

  async summary(): Promise<FreshnessSummary> {
    const inputsChangedAt = await this.changedAt();
    const latest = this.latestSets();

    const [total] = await this.db.select({ value: count() }).from(latest);
    const [stale] =
      inputsChangedAt === null
        ? [{ value: 0 }]
        : await this.db
            .select({ value: count() })
            .from(latest)
            .where(lt(latest.generatedAt, inputsChangedAt));

    return {
      inputsChangedAt,
      studentsWithSets: total?.value ?? 0,
      staleSets: stale?.value ?? 0,
    };
  }

  /**
   * The students whose sets are stale, **oldest first**, at most `limit`.
   *
   * Regenerating a set moves its `created_at` past the change, so it drops out of this list on its
   * own: the list is its own cursor, and a recompute interrupted halfway resumes exactly where it
   * stopped without anyone having to remember where that was.
   */
  async staleStudents(inputsChangedAt: string, limit: number): Promise<string[]> {
    const latest = this.latestSets();

    const rows = await this.db
      .select({ studentId: latest.studentId })
      .from(latest)
      .where(lt(latest.generatedAt, inputsChangedAt))
      .orderBy(asc(latest.generatedAt), asc(latest.studentId))
      .limit(limit);

    return rows.map((row) => row.studentId);
  }

  /** Each live student's newest set — deleted accounts are not anyone's stale results. */
  private latestSets() {
    return this.db
      .select({
        studentId: recommendations.studentId,
        generatedAt: max(recommendations.createdAt).as('generated_at'),
      })
      .from(recommendations)
      .innerJoin(users, eq(users.id, recommendations.studentId))
      .where(isNull(users.deletedAt))
      .groupBy(recommendations.studentId)
      .as('latest_sets');
  }
}
