import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { assessmentTemplates } from '@/db/schema';
import { uuid } from '@/lib/crypto';

import {
  api,
  assessmentTaxonomy,
  createStaffUser,
  db,
  login,
  seedInstruments,
  type StaffUserFixture,
} from '../helpers';

/**
 * The assessment taxonomy and its dynamic validation (migration 0014, prompt-driven v1.5).
 *
 * **The compatibility matrix is the thing under test here**, not the two lookups around it. The
 * lookups are inert reference data; the matrix is a rule that exists in two runtimes at once — the
 * form filters its scoring multi-select by it, and the API refuses a body that ignores the filter —
 * and the entire reason it is a table rather than a constant is that those two must not be able to
 * disagree. So every test below asks the same question from one side or the other: *is the rule the
 * client is handed the same rule the server enforces?*
 */

let admin: StaffUserFixture;
let adminToken: string;
let counselorToken: string;
let taxonomyBody: { assessment_type_id: string; scoring_ids: string[] };

beforeAll(async () => {
  admin = await createStaffUser({ role: 'admin' });
  adminToken = await login(admin);
  counselorToken = await login(await createStaffUser({ role: 'counselor' }));

  const taxonomy = await assessmentTaxonomy();
  taxonomyBody = {
    assessment_type_id: taxonomy.assessmentTypeId,
    scoring_ids: taxonomy.scoringIds,
  };
});

/** The seeded row for one type code, with the scoring ids the matrix permits for it. */
async function typeByCode(code: string): Promise<any> {
  const response = await api('GET', '/assessment-types', { token: adminToken });
  const match = response.body.data.find((type: any) => type.code === code);

  expect(match, `seeded assessment type ${code}`).toBeDefined();

  return match;
}

async function scoringByCode(code: string): Promise<any> {
  const response = await api('GET', '/assessment-scorings', { token: adminToken });

  return response.body.data.find((scoring: any) => scoring.code === code);
}

// ═════════════════════════════════════════════════════════════════════════════════════
describe('the taxonomy lookups', () => {
  it('serves all 12 types in curated order, each carrying its allowed scoring ids', async () => {
    const response = await api('GET', '/assessment-types', { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(12);

    // Curated order, not alphabetical — Aptitude first, Learning Style last, as specified.
    expect(response.body.data[0].code).toBe('APTITUDE');
    expect(response.body.data[11].code).toBe('LEARNING_STYLE');

    // The matrix travels with the list, which is what lets the form filter without a request.
    for (const type of response.body.data) {
      expect(type.allowed_scoring_ids.length).toBeGreaterThan(0);
    }
  });

  it('serves all 15 scoring methods', async () => {
    const response = await api('GET', '/assessment-scorings', { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(15);
    expect(response.body.data.map((scoring: any) => scoring.code)).toContain('IQ_SCORES');
  });

  it('matches the specified matrix exactly for the two ends of it', async () => {
    const scorings = await api('GET', '/assessment-scorings', { token: adminToken });
    const nameById = new Map<string, string>(
      scorings.body.data.map((scoring: any) => [scoring.id, scoring.name]),
    );

    const intelligence = await typeByCode('INTELLIGENCE');
    const names = intelligence.allowed_scoring_ids.map((id: string) => nameById.get(id));

    expect(names.sort()).toEqual(
      [
        'IQ Scores',
        'Standard Scores',
        'Scaled Scores',
        'Percentile Ranks',
        'T-Scores',
        'Z-Scores',
        'Norm-Referenced Scores',
      ].sort(),
    );

    // The shortest row in the table, and the one that most easily gains a method by accident.
    const learningStyle = await typeByCode('LEARNING_STYLE');

    expect(learningStyle.allowed_scoring_ids).toHaveLength(5);
    expect(learningStyle.allowed_scoring_ids.map((id: string) => nameById.get(id))).not.toContain(
      'IQ Scores',
    );
  });

  it('is staff-only — an unauthenticated caller gets a 401', async () => {
    expect((await api('GET', '/assessment-types')).status).toBe(401);
    expect((await api('GET', '/assessment-scorings')).status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('dynamic scoring validation on create and edit', () => {
  it('accepts a legal type/scoring pair and stores both', async () => {
    const response = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Legal ${uuid().slice(0, 8)}`,
        ...taxonomyBody,
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.type.code).toBe('INTEREST');
    expect(response.body.data.scorings.map((scoring: any) => scoring.code).sort()).toEqual([
      'LIKERT_SCALES',
      'RAW_SCORES',
    ]);
  });

  /**
   * **The rule the whole join table exists for.** Percentage Scores is legal for Academic and
   * illegal for Interest, so a client that ignores the filtered dropdown is refused by the server —
   * and the message names the method and the type, because a form with fifteen checkboxes and a
   * bare "invalid" is a puzzle rather than an error.
   */
  it('refuses a scoring method the chosen type does not allow, naming both', async () => {
    const interest = await typeByCode('INTEREST');
    const percentage = await scoringByCode('PERCENTAGE_SCORES');

    expect(interest.allowed_scoring_ids).not.toContain(percentage.id);

    const response = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Illegal ${uuid().slice(0, 8)}`,
        assessment_type_id: interest.id,
        scoring_ids: [percentage.id],
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.scoring_ids[0]).toContain('Percentage Scores');
    expect(response.body.errors.scoring_ids[0]).toContain('Interest');
  });

  it('accepts that same method under a type that does allow it', async () => {
    const academic = await typeByCode('ACADEMIC');
    const percentage = await scoringByCode('PERCENTAGE_SCORES');

    expect(academic.allowed_scoring_ids).toContain(percentage.id);

    const response = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Academic ${uuid().slice(0, 8)}`,
        assessment_type_id: academic.id,
        scoring_ids: [percentage.id],
      },
    });

    expect(response.status).toBe(201);
  });

  it('requires a type and at least one scoring method', async () => {
    const missing = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: { category: 'CUSTOM', title: `Bare ${uuid().slice(0, 8)}` },
    });

    expect(missing.status).toBe(422);

    const empty = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Empty ${uuid().slice(0, 8)}`,
        assessment_type_id: taxonomyBody.assessment_type_id,
        scoring_ids: [],
      },
    });

    expect(empty.status).toBe(422);
    expect(empty.body.errors.scoring_ids).toBeDefined();
  });

  it('rejects an unknown type and an unknown scoring method separately', async () => {
    const unknownType = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Ghost ${uuid().slice(0, 8)}`,
        assessment_type_id: uuid(),
        scoring_ids: taxonomyBody.scoring_ids,
      },
    });

    expect(unknownType.status).toBe(422);
    expect(unknownType.body.errors.assessment_type_id).toBeDefined();

    const unknownScoring = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Ghost ${uuid().slice(0, 8)}`,
        assessment_type_id: taxonomyBody.assessment_type_id,
        scoring_ids: [uuid()],
      },
    });

    expect(unknownScoring.status).toBe(422);
    expect(unknownScoring.body.errors.scoring_ids).toBeDefined();
  });

  /**
   * The rule has to survive an edit as well as a create, or an assessment could be walked into an
   * illegal combination one field at a time: save as Academic + Percentage, then change the type to
   * Interest and leave the scoring where it is.
   */
  it('re-validates the pair when the type changes on an edit', async () => {
    const academic = await typeByCode('ACADEMIC');
    const interest = await typeByCode('INTEREST');
    const percentage = await scoringByCode('PERCENTAGE_SCORES');

    const created = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Walkable ${uuid().slice(0, 8)}`,
        assessment_type_id: academic.id,
        scoring_ids: [percentage.id],
      },
    });

    expect(created.status).toBe(201);

    const walked = await api('PATCH', `/assessment-templates/${created.body.data.id}`, {
      token: adminToken,
      body: {
        title: created.body.data.title,
        assessment_type_id: interest.id,
        scoring_ids: [percentage.id],
      },
    });

    expect(walked.status).toBe(422);
    expect(walked.body.errors.scoring_ids).toBeDefined();
  });

  it('refuses the same scoring method twice in one payload', async () => {
    const [first] = taxonomyBody.scoring_ids;

    const response = await api('POST', '/assessment-templates', {
      token: adminToken,
      body: {
        category: 'CUSTOM',
        title: `Doubled ${uuid().slice(0, 8)}`,
        assessment_type_id: taxonomyBody.assessment_type_id,
        scoring_ids: [first, first],
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.scoring_ids).toBeDefined();
  });

  it('refuses a duplicate title against a live assessment', async () => {
    const title = `Twice ${uuid().slice(0, 8)}`;

    expect(
      (
        await api('POST', '/assessment-templates', {
          token: adminToken,
          body: { category: 'CUSTOM', title, ...taxonomyBody },
        })
      ).status,
    ).toBe(201);

    const again = await api('POST', '/assessment-templates', {
      token: adminToken,
      // Case-insensitively the same title — "study habits" and "Study Habits" are one instrument.
      body: { category: 'CUSTOM', title: title.toUpperCase(), ...taxonomyBody },
    });

    expect(again.status).toBe(422);
    expect(again.body.errors.title).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
describe('the data migration', () => {
  /**
   * The seeded instruments predate the taxonomy, so migration 0014 backfills them. This asserts the
   * backfill landed on a *legal* pair — a backfill that wrote a combination the validation it just
   * introduced would reject is worse than no backfill at all.
   */
  it('classified the curated instruments, and legally', async () => {
    await seedInstruments(admin);

    const [riasec] = await db()
      .select()
      .from(assessmentTemplates)
      .where(eq(assessmentTemplates.category, 'RIASEC'))
      .limit(1);

    expect(riasec?.assessmentTypeId).not.toBeNull();

    const interest = await typeByCode('INTEREST');
    expect(riasec?.assessmentTypeId).toBe(interest.id);

    const list = await api('GET', '/counselor/assessment-templates', { token: counselorToken });
    const served = list.body.data.find((template: any) => template.id === riasec?.id);

    expect(served.type.name).toBe('Interest');
    expect(served.scorings.length).toBeGreaterThan(0);

    // Every backfilled method must be one the matrix permits for the backfilled type.
    for (const scoring of served.scorings) {
      expect(interest.allowed_scoring_ids).toContain(scoring.id);
    }
  });
});
