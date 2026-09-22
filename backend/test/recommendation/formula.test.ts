import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { appSettings, auditLogs } from '@/db/schema';
import { DEFAULT_FORMULA } from '@/lib/scoring-formula';
import { FORMULA_SETTING_KEY } from '@/modules/recommendation/formula-service';
import { APP_SETTING_KEYS, NON_FLAG_SETTING_KEYS } from '@/modules/platform/settings-service';

import {
  answerAll,
  api,
  assignVersion,
  attachCareer,
  classWithStudent,
  createCareer,
  createCollege,
  createProgram,
  createStaffUser,
  db,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * **The §27 formula as a configuration** (2026-09-21) — `/admin/recommendation-formula`.
 *
 * The arithmetic itself is pinned in `test/unit/recommendation.test.ts`, against §28's
 * hand-computed numbers, and a custom formula is exercised there too. None of that is repeated.
 *
 * What is tested here is the part a unit test cannot see, and it is one claim in three pieces:
 *
 *   1. only an administrator can change it, and a bad formula is refused at the door;
 *   2. what was saved is what comes back, and the previous weights survive in the audit log;
 *   3. **a saved formula actually moves a student's scores.**
 *
 * The third is the whole feature. Everything else could pass while `generateFor` quietly went on
 * scoring with the shipped constants, and the only symptom would be an admin changing a number,
 * seeing it saved, and nothing whatsoever happening — the exact failure a configuration screen
 * exists to rule out. It is worth the ninety round trips its fixture costs.
 */

/** Named, because "who last changed the formula" is one of the things the screen reports. */
const ADMIN_NAME = 'Formula Administrator';

let admin: StaffUserFixture;
let adminToken: string;
let counselorToken: string;

/** A student who has completed both instruments — the only kind that has scores to move. */
let assessed: { studentId: string; studentToken: string };

const ENDPOINTS: [string, string][] = [
  ['GET', '/admin/recommendation-formula'],
  ['PUT', '/admin/recommendation-formula'],
  ['POST', '/admin/recommendation-formula/reset'],
];

/**
 * A formula that leans hard the other way: interests barely count, SCCT confidence carries the
 * career score, and a program is scored mostly on the careers it leads to.
 *
 * Chosen to be *visibly* different rather than plausibly different. A student who answered Strongly
 * Agree on Investigative and Agree throughout SCCT has a RIASEC term near 100 and a confidence term
 * near 75, so swapping which of the two dominates has to move the composite by tens of points. A
 * subtle re-weighting could round to the same number and the test would pass on a broken build.
 */
const CONFIDENCE_HEAVY = {
  ...DEFAULT_FORMULA,
  career: { riasecCompatibility: 0.1, careerConfidence: 0.8, studentPreference: 0.1 },
  program: {
    riasecCompatibility: 0.1,
    careerAlignment: 0.1,
    careerConfidence: 0.7,
    academicFit: 0.05,
    strandAlignment: 0.05,
  },
};

/** A save body: the formula plus the re-authentication every write requires. */
function saving(formula: object, currentPassword = admin.password) {
  return { ...formula, current_password: currentPassword };
}

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin', mustChangePassword: false, name: ADMIN_NAME });
  adminToken = await login(admin);
  const counselor = await createStaffUser({ role: 'counselor', mustChangePassword: false });
  counselorToken = await login(counselor);

  const seeded = await seedInstruments(admin);

  const college = await createCollege(adminToken, { name: `Formula University ${Date.now()}` });
  const program = await createProgram(adminToken, college.id, {
    code: 'BSCS',
    name: 'BS Computer Science',
    recommended_strand: 'Academic',
  });
  const career = await createCareer(adminToken, {
    title: `Formula Engineer ${Date.now()}`,
    typical_riasec_code: 'IEC',
  });
  await attachCareer(adminToken, program.id, career.id);

  const { classRoom, student, studentToken } = await classWithStudent(counselorToken);

  await completeAssessment(studentToken, classRoom.id, seeded.riasecVersionId!, investigative);
  await completeAssessment(studentToken, classRoom.id, seeded.scctVersionId!, confident);

  assessed = { studentId: student.student_id, studentToken };
});

/**
 * Back to the shipped formula after every test.
 *
 * Storage is not rolled back between tests in a file, and this one row is genuinely global — it is
 * read by every generation in the process. A test that left it re-weighted would not fail itself;
 * it would fail whichever test ran next, which is the worst kind of flake to read.
 */
afterEach(async () => {
  await db().delete(appSettings).where(eq(appSettings.key, FORMULA_SETTING_KEY));
});

async function completeAssessment(
  studentToken: string,
  classId: string,
  versionId: string,
  pick: (question: any, index: number) => number,
): Promise<void> {
  const assignment = await assignVersion(counselorToken, classId, versionId);
  const started = await api('POST', `/student/assignments/${assignment.id}/start`, {
    token: studentToken,
  });

  await answerAll(studentToken, started.body.data, pick);

  const submitted = await api('POST', `/student/attempts/${started.body.data.id}/submit`, {
    token: studentToken,
  });

  if (submitted.status !== 200) {
    throw new Error(`Fixture submit failed: ${JSON.stringify(submitted.body)}`);
  }
}

const investigative = (question: any) => (question.section_label === 'Investigative' ? 4 : 0);
const confident = () => 3;

describe('authorization', () => {
  it.each(ENDPOINTS)('%s %s → 403 for a counselor', async (method, path) => {
    const response = await api(method, path, {
      token: counselorToken,
      ...(method === 'PUT' ? { body: saving(DEFAULT_FORMULA) } : {}),
    });

    expect(response.status).toBe(403);
  });

  it.each(ENDPOINTS)('%s %s → 401 unauthenticated', async (method, path) => {
    const response = await api(
      method,
      path,
      method === 'PUT' ? { body: saving(DEFAULT_FORMULA) } : {},
    );

    expect(response.status).toBe(401);
  });

  it('is not reachable through the flag registry either', () => {
    // The formula lives in `app_settings` beside the boolean flags. The two registries must stay
    // disjoint or `PATCH /admin/settings` — whose body is `.strict()` over `APP_SETTING_KEYS` —
    // becomes a second, unvalidated way to write a scoring formula.
    for (const key of NON_FLAG_SETTING_KEYS) {
      expect(APP_SETTING_KEYS).not.toContain(key);
    }

    expect(NON_FLAG_SETTING_KEYS).toContain(FORMULA_SETTING_KEY);
  });
});

describe('GET /admin/recommendation-formula', () => {
  it('reports the shipped formula, and says that it is the shipped one', async () => {
    const response = await api('GET', '/admin/recommendation-formula', { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.body.data.is_default).toBe(true);
    expect(response.body.data.formula.career.riasecCompatibility).toBe(0.6);
    expect(response.body.data.updated_by_name).toBeNull();
  });

  it('carries the defaults alongside the current values', async () => {
    // The screen marks every field that differs from what shipped, and offers to restore them.
    // A frontend copy of these numbers would be a second source of truth that drifts on the first
    // release that tunes one.
    const response = await api('GET', '/admin/recommendation-formula', { token: adminToken });

    expect(response.body.data.defaults.program).toEqual(DEFAULT_FORMULA.program);
    expect(typeof response.body.data.students_with_recommendations).toBe('number');
  });
});

describe('PUT /admin/recommendation-formula', () => {
  it('refuses a weight set that does not sum to 1', async () => {
    const response = await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving({
        ...DEFAULT_FORMULA,
        career: { riasecCompatibility: 0.6, careerConfidence: 0.6, studentPreference: 0.1 },
      }),
    });

    // 1.3 would leave every career score 30% higher than every program score beside it, on the
    // same "out of 100" label.
    expect(response.status).toBe(422);
  });

  it('refuses a renormalized weight of zero', async () => {
    // `[0, 0.5, 0.5]` against a one-letter Holland code divides by zero in the engine and poisons
    // the composite with NaN. Refused at the door rather than discovered on a student's screen.
    const response = await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving({ ...DEFAULT_FORMULA, positionWeights: [0, 0.5, 0.5] }),
    });

    expect(response.status).toBe(422);
  });

  it('refuses an inverted academic band', async () => {
    const response = await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving({ ...DEFAULT_FORMULA, academic: { floor: 95, ceiling: 75 } }),
    });

    expect(response.status).toBe(422);
  });

  it('refuses a field nobody declared', async () => {
    const response = await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving({ ...DEFAULT_FORMULA, mysteryBonus: 0.5 }),
    });

    expect(response.status).toBe(422);
  });

  it('refuses a save without the admin password', async () => {
    const response = await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: CONFIDENCE_HEAVY,
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.current_password).toBeDefined();
  });

  it('refuses a save with the wrong password, and stores nothing', async () => {
    const response = await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving(CONFIDENCE_HEAVY, 'NotThePassword1'),
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.current_password).toEqual(['Your password is incorrect.']);

    const read = await api('GET', '/admin/recommendation-formula', { token: adminToken });

    expect(read.body.data.is_default).toBe(true);
  });

  it('saves, and reports who saved it', async () => {
    const saved = await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving(CONFIDENCE_HEAVY),
    });

    expect(saved.status).toBe(200);
    expect(saved.body.data.career.careerConfidence).toBe(0.8);

    const read = await api('GET', '/admin/recommendation-formula', { token: adminToken });

    expect(read.body.data.is_default).toBe(false);
    expect(read.body.data.formula.program.careerConfidence).toBe(0.7);
    expect(read.body.data.updated_by_name).toBe(ADMIN_NAME);
  });

  it('records the previous weights in the audit log', async () => {
    // Cleared first: storage is not rolled back between tests in a file, and every save above
    // wrote one of these. Asserting on "the first row with this action" would be asserting on
    // whichever test happened to run earliest.
    await db().delete(auditLogs).where(eq(auditLogs.action, 'RECOMMENDATION_FORMULA_UPDATED'));

    await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving(CONFIDENCE_HEAVY),
    });

    const [row] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'RECOMMENDATION_FORMULA_UPDATED'));

    // "Scores changed on the 14th — what were the weights before?" is the question this row exists
    // to answer, and the row that replaced them cannot answer it.
    expect((row!.oldValues as any).formula.career.riasecCompatibility).toBe(0.6);
    expect((row!.newValues as any).formula.career.careerConfidence).toBe(0.8);
  });
});

describe('POST /admin/recommendation-formula/reset', () => {
  it('refuses a reset with the wrong password, and keeps the custom formula', async () => {
    await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving(CONFIDENCE_HEAVY),
    });

    const reset = await api('POST', '/admin/recommendation-formula/reset', {
      token: adminToken,
      body: { current_password: 'NotThePassword1' },
    });

    expect(reset.status).toBe(422);
    expect(reset.body.errors.current_password).toEqual(['Your password is incorrect.']);

    const read = await api('GET', '/admin/recommendation-formula', { token: adminToken });

    expect(read.body.data.is_default).toBe(false);
  });

  it('deletes the row rather than writing the defaults into it', async () => {
    await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving(CONFIDENCE_HEAVY),
    });

    const reset = await api('POST', '/admin/recommendation-formula/reset', {
      token: adminToken,
      body: { current_password: admin.password },
    });

    expect(reset.status).toBe(200);
    expect(reset.body.data.career.riasecCompatibility).toBe(0.6);

    // `is_default` going back to true is the point: a deployment that had rewritten the row with
    // the defaults would claim a custom configuration forever, and would be pinned to these
    // numbers even if a later release tuned them.
    const read = await api('GET', '/admin/recommendation-formula', { token: adminToken });

    expect(read.body.data.is_default).toBe(true);

    const rows = await db()
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, FORMULA_SETTING_KEY));

    expect(rows).toHaveLength(0);
  });
});

/**
 * One test, three regenerations, and that is a budget rather than a style choice:
 * `recommendationRegenerateGuard` allows five per student per ten minutes and is keyed on the
 * student, so a file that spent a rebuild per assertion would start 429ing partway down and read
 * as a scoring bug.
 */
describe('a saved formula reaches the engine', () => {
  it('moves the scores, and the reset puts them back exactly', async () => {
    const before = await api('POST', '/student/recommendations/regenerate', {
      token: assessed.studentToken,
    });
    const baseline = before.body.data.careers[0].match_score;

    await api('PUT', '/admin/recommendation-formula', {
      token: adminToken,
      body: saving(CONFIDENCE_HEAVY),
    });

    const after = await api('POST', '/student/recommendations/regenerate', {
      token: assessed.studentToken,
    });
    const reweighted = after.body.data.careers[0].match_score;

    // The same student, the same answers, the same catalog. §26 promises identical inputs give an
    // identical ranking — and the formula is now one of the inputs.
    expect(reweighted).not.toBe(baseline);

    /*
      Direction, not just difference — a test that only asserted "it changed" would pass on an
      engine that applied the new weights to the wrong components.

      The direction is a property of this fixture and can be read off §27. The student answered
      Strongly Agree on every Investigative item and Strongly Disagree on everything else, so their
      profile is I=100 and the rest 0, and the best career's Holland code merely *leads* with I —
      position-weighted, that is a RIASEC compatibility around 50. Their SCCT answers put the
      confidence index at the top of its scale. Moving half the career composite's weight from the
      first term to the second therefore has to raise the score, by roughly half the gap between
      them.
    */
    expect(reweighted).toBeGreaterThan(baseline);

    await api('POST', '/admin/recommendation-formula/reset', {
      token: adminToken,
      body: { current_password: admin.password },
    });

    const restored = await api('POST', '/student/recommendations/regenerate', {
      token: assessed.studentToken,
    });

    expect(restored.body.data.careers[0].match_score).toBe(baseline);
  });
});

/**
 * `linkWeights` arrived with migration 0041, after formulas could already be saved. A row saved
 * before it must still read as the administrator's formula — a parse failure would fall back to the
 * shipped weights and silently undo their tuning on deploy.
 */
describe('a formula saved before link weights existed', () => {
  it('still loads as the saved formula, with the default link weights filled in', async () => {
    const { linkWeights: _omitted, ...legacy } = { ...DEFAULT_FORMULA, topN: 8 };

    await db()
      .insert(appSettings)
      .values({ key: FORMULA_SETTING_KEY, value: JSON.stringify(legacy) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(legacy) } });

    const response = await api('GET', '/admin/recommendation-formula', { token: adminToken });

    expect(response.body.data.is_default).toBe(false);
    expect(response.body.data.formula.topN).toBe(8);
    expect(response.body.data.formula.linkWeights).toEqual(DEFAULT_FORMULA.linkWeights);
  });
});
