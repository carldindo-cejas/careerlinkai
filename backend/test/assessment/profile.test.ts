import { beforeAll, describe, expect, it } from 'vitest';

import { api, classWithStudent, createStaffUser, login } from '../helpers';

/**
 * The student profile (FULLPLAN §13.1, §37) — **the other half of Part VII's inputs.**
 *
 * It belongs to Phase 3 because §27's engine consumes `strand` and `gwa` and no earlier phase
 * owned them (§57, v1.2). This is not a settings screen: every assertion below is about whether
 * the recommendation engine can trust what it reads.
 */

let counselorToken: string;

beforeAll(async () => {
  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);
});

describe('GET /student/profile', () => {
  it('reports what §27 still needs before it can recommend anything', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.is_complete_for_recommendations).toBe(false);
    // The two §27 cannot do without — strand gates the alignment component, GWA drives both
    // academic fit and eligibility.
    expect(response.body.data.missing_for_recommendations).toEqual(['strand', 'gwa']);
  });

  it('carries the names from the counselor’s roster', async () => {
    const { studentToken } = await classWithStudent(counselorToken, 'Juan Dela Cruz');

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.first_name).toBe('Juan');
    expect(response.body.data.last_name).toBe('Dela Cruz');
  });
});

describe('PATCH /student/profile', () => {
  it('completes the profile for §27 once strand and gwa are set', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { strand: 'Academic', gwa: 88, math_grade: 91 },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.strand).toBe('Academic');
    // REAL in the database, a string on the wire — the shape the frontend's types pin.
    expect(response.body.data.gwa).toBe('88.00');
    expect(response.body.data.is_complete_for_recommendations).toBe(true);
    expect(response.body.data.missing_for_recommendations).toEqual([]);
  });

  /**
   * **Real validation, not decoration.** §27 *scores* a GWA rather than sanity-checking it, so a
   * typo'd `9.2` would sail through, clamp to 0, and quietly wreck every program recommendation
   * the student ever sees — with nothing anywhere reporting an error. This endpoint is the only
   * place in the system that can catch it.
   */
  it('rejects a GWA outside 60–100 — the typo §27 could never detect', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const typo = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { gwa: 9.2 },
    });

    expect(typo.status).toBe(422);

    const tooHigh = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { gwa: 105 },
    });

    expect(tooHigh.status).toBe(422);
  });

  /**
   * "STEM" is a *track within* Academic. §27 is built on exactly two branches, and accepting four
   * values that silently collapse to two would be a lie about what the engine can tell apart.
   */
  it('rejects a strand outside the strict two-value enum', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { strand: 'STEM' },
    });

    expect(response.status).toBe(422);
  });

  /**
   * Names belong to the counselor's roster (§16). A student renaming themselves would break the
   * roster that was confirmed for them — and the username derived from it. The schema is
   * `.strict()`, so the attempt is *refused* rather than silently ignored.
   */
  it('refuses to let a student rename themselves', async () => {
    const { studentToken } = await classWithStudent(counselorToken, 'Juan Dela Cruz');

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { first_name: 'Somebody', last_name: 'Else' },
    });

    expect(response.status).toBe(422);

    const profile = await api('GET', '/student/profile', { token: studentToken });

    expect(profile.body.data.first_name).toBe('Juan');
  });

  it('is partial — an unmentioned field is left alone', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { strand: 'Academic', gwa: 88 },
    });
    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { grade_level: 'Grade 12' },
    });

    const profile = await api('GET', '/student/profile', { token: studentToken });

    expect(profile.body.data.grade_level).toBe('Grade 12');
    expect(profile.body.data.strand).toBe('Academic');
    expect(profile.body.data.gwa).toBe('88.00');
  });
});

/**
 * The **profiling** block (prompt-driven, v1.6) — what the student dashboard's persistent banner is
 * computed from, and deliberately a *superset* of `is_complete_for_recommendations` above.
 *
 * The two are not redundant, and collapsing them would break one of them. That flag answers a
 * question about the **engine**: strand and GWA are the two inputs §27 cannot run without. This
 * answers a question about the **student**: what is still missing from the profile they were asked
 * to fill in. Grade level is required here and not there because §27 never reads it while the
 * counselor's roster does — a profile without it is incomplete even though the engine tolerates it.
 */
describe('profiling completeness (the dashboard banner)', () => {
  it('names every missing field, with the label the banner shows', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.profiling.is_complete).toBe(false);
    expect(response.body.data.profiling.missing.map((field: any) => field.field)).toEqual([
      'strand',
      'grade_level',
      'gwa',
    ]);
    // The label travels with the field so the banner does not carry its own copy of the mapping.
    expect(response.body.data.profiling.missing[0].label).toBe('Academic track / strand');
  });

  it('is still incomplete when only the engine’s two inputs are set', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { strand: 'Academic', gwa: 88 },
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    // The engine can run…
    expect(response.body.data.is_complete_for_recommendations).toBe(true);
    // …and the profile is still missing something the student was asked for.
    expect(response.body.data.profiling.is_complete).toBe(false);
    expect(response.body.data.profiling.missing.map((field: any) => field.field)).toEqual([
      'grade_level',
    ]);
  });

  it('clears once every required field is present — the banner disappears on its own', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { strand: 'Academic', grade_level: 'Grade 12', gwa: 88 },
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.profiling.is_complete).toBe(true);
    expect(response.body.data.profiling.missing).toEqual([]);
  });

  it('returns incomplete again if a required field is cleared', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { strand: 'Academic', grade_level: 'Grade 12', gwa: 88 },
    });

    // An explicit null clears the field — "not selected" has to mean something (the endpoint is a
    // PATCH, so an absent key would leave it alone).
    await api('PATCH', '/student/profile', { token: studentToken, body: { strand: null } });

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.profiling.is_complete).toBe(false);
    expect(response.body.data.profiling.missing.map((field: any) => field.field)).toEqual([
      'strand',
    ]);
  });
});
