import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  answerAll,
  api,
  assignVersion,
  classWithStudent,
  createStaffUser,
  login,
  seedInstruments,
} from '../helpers';

/**
 * The five-tier item-mean scale (migration 0035), on both instruments:
 *
 *   Very Low < 36 ≤ Low < 52 ≤ Moderate < 68 ≤ High < 84 ≤ Very High
 *
 * Asserted twice — once as freshly scored attempts, once as old rows re-labelled by the migration —
 * because the two must agree: a student scored yesterday and one scored today, on the same score,
 * are told the same word.
 */

let counselorToken: string;
let riasecVersionId: string;
let scctVersionId: string;

beforeAll(async () => {
  const admin = await createStaffUser({ role: 'admin' });
  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);

  riasecVersionId = seeded.riasecVersionId!;
  scctVersionId = seeded.scctVersionId!;
});

async function submit(versionId: string, pick: (question: any) => number) {
  const { classRoom, studentToken } = await classWithStudent(counselorToken);
  const assignment = await assignVersion(counselorToken, classRoom.id, versionId);

  const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
    token: studentToken,
  });

  await answerAll(studentToken, started.body.data, pick);

  const response = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
    token: studentToken,
  });

  expect(response.status).toBe(200);

  return response.body.data;
}

/** Option index → score: 0 → 1 (Strongly Disagree) … 4 → 5 (Strongly Agree). */
const RIASEC_PICKS: Record<string, number> = {
  Realistic: 0, // 10/50 = 20  → Very Low
  Investigative: 4, // 50/50 = 100 → Very High
  Artistic: 3, // 40/50 = 80  → High
  Social: 2, // 30/50 = 60  → Moderate
  Enterprising: 1, // 20/50 = 40  → Low
  Conventional: 0, // 20        → Very Low
};

const RIASEC_EXPECTED: Record<string, string> = {
  R: 'Very Low Interest',
  I: 'Very High Interest',
  A: 'High Interest',
  S: 'Moderate Interest',
  E: 'Low Interest',
  C: 'Very Low Interest',
};

/**
 * SE 100, OE 60, GO 40 → index (100 × 0.4) + (60 × 0.3) + (40 × 0.3) = 70.0 → High. The old
 * four-tier scale called 70 "Moderately High", which is what makes it the telling case.
 */
const SCCT_PICKS: Record<string, number> = {
  'Self-Efficacy': 4,
  'Outcome Expectations': 2,
  'Goal Orientation': 1,
};

const SCCT_EXPECTED: Record<string, string> = {
  SE: 'Very High Confidence',
  OE: 'Moderate Confidence',
  GO: 'Low Confidence',
};

function labelsByCode(result: any): Record<string, string> {
  return Object.fromEntries(result.dimensions.map((d: any) => [d.code, d.interpretation]));
}

async function storedLabels(attemptId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT d.code AS code, ds.interpretation AS interpretation
       FROM dimension_scores ds
       JOIN assessment_dimensions d ON d.id = ds.dimension_id
      WHERE ds.attempt_id = ?`,
  )
    .bind(attemptId)
    .all<{ code: string; interpretation: string }>();

  return Object.fromEntries(results.map((row) => [row.code, row.interpretation]));
}

async function storedSummary(attemptId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT overall_summary AS summary FROM assessment_results WHERE attempt_id = ?',
  )
    .bind(attemptId)
    .first<{ summary: string | null }>();

  return row?.summary ?? null;
}

describe('the five-tier scale on a freshly scored attempt', () => {
  it('bands every RIASEC dimension on the item-mean cut points', async () => {
    const result = await submit(riasecVersionId, (q) => RIASEC_PICKS[q.section_label] ?? 0);

    expect(labelsByCode(result)).toEqual(RIASEC_EXPECTED);
  });

  it('bands the SCCT constructs and the composite on the same cut points', async () => {
    const result = await submit(scctVersionId, (q) => SCCT_PICKS[q.section_label] ?? 0);

    expect(labelsByCode(result)).toEqual(SCCT_EXPECTED);
    expect(result.result.overall_summary).toBe('High Career Confidence.');
  });
});

describe('migration 0035 — results scored on the old scales', () => {
  /**
   * Runs the **real** migration file against rows put back into their pre-0035 shape: the old
   * bands on the instruments and the old labels on stored results. `setup.ts` applies migrations to
   * an empty database, so without this the re-labelling would only ever be tested against nothing.
   *
   * Last in the file on purpose: it rewrites every RIASEC/SCCT row in this file's storage.
   */
  it('re-labels stored results from their own scores and re-bands the instruments', async () => {
    const riasec = await submit(riasecVersionId, (q) => RIASEC_PICKS[q.section_label] ?? 0);
    const scct = await submit(scctVersionId, (q) => SCCT_PICKS[q.section_label] ?? 0);

    // Back to the shape the pre-0035 seed and engine left behind.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE assessment_dimensions SET interpretation_ranges = ?
          WHERE assessment_template_id IN (SELECT id FROM assessment_templates WHERE category = 'RIASEC')`,
      ).bind(
        '[{"min":0,"max":33.99,"label":"Low Interest"},{"min":34,"max":66.99,"label":"Moderate Interest"},{"min":67,"max":100,"label":"High Interest"}]',
      ),
      env.DB.prepare(
        `UPDATE assessment_versions
            SET scoring_config = json_set(scoring_config, '$.composite_ranges', json(?))
          WHERE id = ?`,
      ).bind(
        '[{"min":0,"max":33.99,"label":"Low"},{"min":34,"max":66.99,"label":"Moderate"},{"min":67,"max":79.99,"label":"Moderately High"},{"min":80,"max":100,"label":"High"}]',
        scctVersionId,
      ),
      env.DB.prepare(
        `UPDATE dimension_scores SET interpretation = 'High Interest' WHERE attempt_id = ?`,
      ).bind(riasec.attempt_id),
      env.DB.prepare(
        `UPDATE dimension_scores SET interpretation = 'Moderately High Confidence' WHERE attempt_id = ?`,
      ).bind(scct.attempt_id),
      env.DB.prepare(
        `UPDATE assessment_results SET overall_summary = 'Moderately High Career Confidence.'
          WHERE attempt_id = ?`,
      ).bind(scct.attempt_id),
    ]);

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0035'));

    expect(migration).toBeDefined();

    // Twice: a migration that is not idempotent is one bad retry away from a wrong label.
    for (let run = 0; run < 2; run += 1) {
      for (const statement of migration!.queries) {
        await env.DB.prepare(statement).run();
      }
    }

    expect(await storedLabels(riasec.attempt_id)).toEqual(RIASEC_EXPECTED);
    expect(await storedLabels(scct.attempt_id)).toEqual(SCCT_EXPECTED);
    expect(await storedSummary(scct.attempt_id)).toBe('High Career Confidence.');

    // The instruments themselves, so the next attempt is scored on the same scale.
    const version = await env.DB.prepare(
      'SELECT scoring_config AS config FROM assessment_versions WHERE id = ?',
    )
      .bind(scctVersionId)
      .first<{ config: string }>();
    const config = JSON.parse(version!.config);

    expect(config.composite_weights).toEqual({ SE: 0.4, OE: 0.3, GO: 0.3 });
    expect(config.composite_ranges.map((band: any) => band.label)).toEqual([
      'Very High',
      'High',
      'Moderate',
      'Low',
      'Very Low',
    ]);

    // And the API agrees with the rows — a fresh attempt scored after the migration.
    const after = await submit(riasecVersionId, (q) => RIASEC_PICKS[q.section_label] ?? 0);

    expect(labelsByCode(after)).toEqual(RIASEC_EXPECTED);
  });
});
