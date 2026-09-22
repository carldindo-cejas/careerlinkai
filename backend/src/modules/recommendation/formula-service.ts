import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@/db/client';
import { appSettings, users, type User } from '@/db/schema';
import { now } from '@/lib/datetime';
import { log } from '@/lib/logger';
import {
  DEFAULT_FORMULA,
  WEIGHT_SUM_TOLERANCE,
  type ScoringFormula,
} from '@/lib/scoring-formula';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * **The §27 formula, as a row an administrator owns** (2026-09-21).
 *
 * `lib/scoring-formula.ts` says what a formula *is*; this says where this deployment's one lives,
 * how it is validated on the way in, and what happens when it cannot be read.
 *
 * ## Why `app_settings` and not a table of its own
 *
 * There is exactly one formula per deployment, forever — it is a configuration, not a collection —
 * and `app_settings` is already the generic key/value store with an `updated_by` and an audit
 * convention (migration 0034). A `recommendation_formulas` table would be one row with a
 * `is_active` flag nobody would ever set twice, plus a migration.
 *
 * The value is JSON, which is the one thing `SettingsService` deliberately does not do: that
 * service is the **flag registry**, every key a boolean, `'true'` and nothing else meaning true.
 * Widening it to carry a scoring formula would have made `get()` return `boolean | object` and put
 * the strictness that makes a security flag safe in the same function as a tolerance-checked weight
 * set. So the key is claimed here instead, and `NON_FLAG_SETTING_KEYS` in that file records the
 * claim so the two registries cannot collide.
 *
 * ## Everything reads through `get()`, and `get()` never throws
 *
 * A missing row, malformed JSON, a value that fails validation, or a shape written by a newer
 * version of this code all resolve to `DEFAULT_FORMULA` with a log line. Every score every student
 * sees passes through here; a configuration layer that can fail a generation has made the product
 * worse than it was before it existed. The one thing that is *not* silently tolerated is a bad
 * value on the way **in** — `set()` refuses it, which is where a mistake can still be corrected by
 * the person making it.
 */

export const FORMULA_SETTING_KEY = 'recommendation_formula';

const MODULE = 'Recommendation';

/** A composite weight: a share of a score, so 0–1. */
const weight = z.number().min(0).max(1);

/**
 * A weight in a *renormalized* set (Holland positions, career-alignment depth).
 *
 * Strictly above zero, and that is a correctness guard rather than taste: the engine divides by the
 * sum of the weights it actually used, and a set whose leading entries are zero — `[0, 0.5, 0.5]`
 * against a one-letter Holland code — divides by zero and poisons the whole composite with `NaN`.
 */
const renormalizedWeight = z.number().gt(0).max(1);

/** A point on the 0–100 scale every component of a score is expressed on. */
const point = z.number().min(0).max(100);

function sumsToOne(values: number[]): boolean {
  return (
    Math.abs(values.reduce((total, value) => total + value, 0) - 1) <= WEIGHT_SUM_TOLERANCE
  );
}

const SUM_MESSAGE =
  'These must add up to 100%. A set that sums to anything else rescales every score in the system.';

export const scoringFormulaSchema = z
  .object({
    career: z
      .object({
        riasecCompatibility: weight,
        careerConfidence: weight,
        studentPreference: weight,
      })
      .strict()
      .refine((values) => sumsToOne(Object.values(values)), { message: SUM_MESSAGE }),
    program: z
      .object({
        riasecCompatibility: weight,
        careerAlignment: weight,
        careerConfidence: weight,
        academicFit: weight,
        strandAlignment: weight,
      })
      .strict()
      .refine((values) => sumsToOne(Object.values(values)), { message: SUM_MESSAGE }),
    positionWeights: z
      .tuple([renormalizedWeight, renormalizedWeight, renormalizedWeight])
      .refine(sumsToOne, { message: SUM_MESSAGE }),
    careerAlignmentDepth: z
      .tuple([renormalizedWeight, renormalizedWeight, renormalizedWeight])
      .refine(sumsToOne, { message: SUM_MESSAGE }),
    neutrals: z
      .object({
        studentPreference: point,
        riasec: point,
        academicUnknown: point,
        strandUnknown: point,
        strandMismatch: point,
        strandAligned: point,
      })
      .strict(),
    /*
      Defaulted, not required: every formula saved before migration 0041 lacks it, and a stored row
      that failed to parse would silently fall back to the shipped weights (see `get`) — reverting an
      administrator's tuning on deploy. `direct` is pinned to 1 so it keeps meaning "counts fully",
      and the order is enforced because a related link outweighing a direct one inverts the words.
    */
    linkWeights: z
      .object({ direct: z.literal(1), related: renormalizedWeight, conditional: renormalizedWeight })
      .strict()
      .refine((values) => values.related >= values.conditional, {
        message: 'A related link cannot count for less than a conditional one.',
      })
      .default(DEFAULT_FORMULA.linkWeights),
    academic: z
      .object({ floor: point, ceiling: point })
      .strict()
      // Equal anchors divide by zero in `academicFit`; an inverted pair scores a better grade
      // lower, which is not a policy anybody means to set.
      .refine((values) => values.ceiling > values.floor, {
        message: 'The ceiling grade must be above the floor grade.',
      }),
    /*
      Three at the bottom because a list of one or two matches is not a recommendation set — a
      student with a single card has nothing to compare. Twenty at the top because each match is a
      persisted row and §27 writes both kinds in one D1 batch (see `chunkForD1`); the ceiling is the
      write budget, not an opinion about how much a student can read.
    */
    topN: z.number().int().min(3).max(20),
  })
  .strict();

export interface StoredFormula {
  formula: ScoringFormula;
  /** True when nothing has been saved — the screen says "the shipped formula", not "custom". */
  isDefault: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}

export class FormulaService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  /**
   * The formula to score with. Never throws, never returns something the engine cannot use.
   *
   * One indexed read of a one-row table, per generation run. `RecommendationService` calls it once
   * and hands the result down rather than letting the engine reach for it per career — §27 ranks
   * the entire catalog, and a read per candidate would be the N+1 that `scorableCareersForMany`
   * exists to remember.
   */
  async get(): Promise<ScoringFormula> {
    const row = await this.db.query.appSettings.findFirst({
      where: eq(appSettings.key, FORMULA_SETTING_KEY),
    });

    if (row === undefined) {
      return DEFAULT_FORMULA;
    }

    return this.parse(row.value) ?? DEFAULT_FORMULA;
  }

  /** The formula plus who last touched it — what the admin screen renders. */
  async stored(): Promise<StoredFormula> {
    const row = await this.db.query.appSettings.findFirst({
      where: eq(appSettings.key, FORMULA_SETTING_KEY),
    });
    const parsed = row === undefined ? null : this.parse(row.value);

    if (row === undefined || parsed === null) {
      return {
        formula: DEFAULT_FORMULA,
        isDefault: true,
        updatedAt: null,
        updatedByName: null,
      };
    }

    const author =
      row.updatedBy === null
        ? undefined
        : await this.db.query.users.findFirst({ where: eq(users.id, row.updatedBy) });

    return {
      formula: parsed,
      isDefault: false,
      updatedAt: row.updatedAt,
      updatedByName: author?.name ?? null,
    };
  }

  /**
   * Replace the formula, whole.
   *
   * Whole rather than patched, because the fields are not independent: a PATCH that moved
   * `program.academicFit` from 0.10 to 0.15 would leave the five program weights summing to 1.05
   * and every program score five percent higher than the career scores beside it. The screen edits
   * a complete object and sends a complete object, and the sum rule is checked against what will
   * actually be stored.
   *
   * The audit row carries the **previous** formula as well as the new one. "Scores changed on the
   * 14th — what were the weights before?" is the question this log exists to answer, and the row
   * that replaced them cannot answer it.
   */
  async set(
    formula: ScoringFormula,
    actor: User,
    ipAddress: string | null,
  ): Promise<ScoringFormula> {
    const previous = await this.stored();
    const timestamp = now();

    await this.db
      .insert(appSettings)
      .values({
        key: FORMULA_SETTING_KEY,
        value: JSON.stringify(formula),
        updatedBy: actor.id,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: JSON.stringify(formula), updatedBy: actor.id, updatedAt: timestamp },
      });

    await this.audit.write({
      action: 'RECOMMENDATION_FORMULA_UPDATED',
      module: MODULE,
      userId: actor.id,
      targetType: 'app_setting',
      targetId: FORMULA_SETTING_KEY,
      oldValues: { formula: previous.formula, was_default: previous.isDefault },
      newValues: { formula },
      ipAddress,
    });

    return formula;
  }

  /**
   * Back to the shipped formula.
   *
   * The row is **deleted** rather than rewritten with the defaults, so `isDefault` goes back to
   * being true and the screen says "the shipped formula" again. Writing the defaults into the row
   * would leave the deployment permanently claiming a custom configuration that happens to match —
   * and would pin these numbers even if a later release changed them.
   */
  async reset(actor: User, ipAddress: string | null): Promise<ScoringFormula> {
    const previous = await this.stored();

    await this.db.delete(appSettings).where(eq(appSettings.key, FORMULA_SETTING_KEY));

    await this.audit.write({
      action: 'RECOMMENDATION_FORMULA_UPDATED',
      module: MODULE,
      userId: actor.id,
      targetType: 'app_setting',
      targetId: FORMULA_SETTING_KEY,
      oldValues: { formula: previous.formula, was_default: previous.isDefault },
      newValues: { formula: DEFAULT_FORMULA, reset_to_default: true },
      ipAddress,
    });

    return DEFAULT_FORMULA;
  }

  /** Stored text → a formula, or `null` with a log line. See the class docblock. */
  private parse(value: string): ScoringFormula | null {
    try {
      const parsed = scoringFormulaSchema.safeParse(JSON.parse(value));

      if (parsed.success) {
        return parsed.data;
      }

      log('error', 'recommendation.formula_invalid', {
        pipeline: 'recommendation',
        issues: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
    } catch (error) {
      log('error', 'recommendation.formula_unreadable', {
        pipeline: 'recommendation',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }
}
