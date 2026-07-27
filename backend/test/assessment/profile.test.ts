import { beforeAll, describe, expect, it } from 'vitest';

import {
  api,
  classWithStudent,
  createClass,
  createStaffUser,
  enrolStudents,
  joinClass,
  login,
  profileLookups,
} from '../helpers';

/**
 * The student profile (FULLPLAN §13.1, §37) — **the other half of Part VII's inputs.**
 *
 * It belongs to Phase 3 because §27's engine consumes `strand` and an academic signal and no
 * earlier phase owned them (§57, v1.2). This is not a settings screen: every assertion below is
 * about whether the recommendation engine can trust what it reads.
 *
 * Two things changed on 2026-07-27 and this file is where both are pinned:
 *
 *   * **GWA is gone.** The academic signal is the mean of the subject grades, so "complete for
 *     §27" now means one strand and *at least one* subject grade.
 *   * **Grade level and strand are lookups derived from the class** (migration 0017). They are
 *     sent as ids, and a student whose class supplies one is refused — with a 422, never a silent
 *     no-op — when they try to change it.
 */

let counselorToken: string;
let lookups: Awaited<ReturnType<typeof profileLookups>>;

beforeAll(async () => {
  const counselor = await createStaffUser({ role: 'counselor' });
  counselorToken = await login(counselor);
  lookups = await profileLookups();
});

describe('GET /student/profile', () => {
  it('reports what §27 still needs before it can recommend anything', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.is_complete_for_recommendations).toBe(false);
    // The two §27 cannot do without — strand gates the alignment component, and the subject-grade
    // average drives both academic fit and eligibility.
    expect(response.body.data.missing_for_recommendations).toEqual(['strand', 'subject_grades']);
  });

  it('carries the names from the counselor’s roster', async () => {
    const { studentToken } = await classWithStudent(counselorToken, 'Juan Dela Cruz');

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.first_name).toBe('Juan');
    expect(response.body.data.last_name).toBe('Dela Cruz');
  });

  /** The lookups the profile screen's two selects are built from. */
  it('serves the grade level and strand options', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('GET', '/student/profile/options', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.grade_levels.map((row: any) => row.name)).toEqual([
      'Grade 11',
      'Grade 12',
    ]);
    // Byte-identical to the §13.1 enum — `student_profiles.strand` is a mirror of this column and
    // §27 compares it directly against `programs.recommended_strand`.
    expect(response.body.data.shs_strands.map((row: any) => row.name)).toEqual([
      'Academic',
      'Technical-Professional',
    ]);
  });
});

describe('PATCH /student/profile', () => {
  it('completes the profile for §27 once a strand and a subject grade are set', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: lookups.academic, math_grade: 91 },
    });

    expect(response.status).toBe(200);
    // The id is what a client sends; the mirror is what §27 and every existing consumer read.
    expect(response.body.data.shs_strand_id).toBe(lookups.academic);
    expect(response.body.data.strand).toBe('Academic');
    // REAL in the database, a string on the wire — the shape the frontend's types pin.
    expect(response.body.data.math_grade).toBe('91.00');
    expect(response.body.data.is_complete_for_recommendations).toBe(true);
    expect(response.body.data.missing_for_recommendations).toEqual([]);
  });

  /**
   * **Real validation, not decoration.** §27 *scores* an academic average rather than
   * sanity-checking it, so a typo'd `9.2` would sail through, clamp to 0, and quietly wreck every
   * program recommendation the student ever sees — with nothing anywhere reporting an error. This
   * endpoint is the only place in the system that can catch it.
   */
  it('rejects a subject grade outside 60–100 — the typo §27 could never detect', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const typo = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { math_grade: 9.2 },
    });

    expect(typo.status).toBe(422);

    const tooHigh = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { science_grade: 105 },
    });

    expect(tooHigh.status).toBe(422);
  });

  /**
   * GWA was removed from the profile on 2026-07-27. The schema is `.strict()`, so a client still
   * sending it is **refused** rather than silently ignored — which is what stops an old build from
   * appearing to save a field that no longer exists.
   */
  it('rejects the removed gwa field outright', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { gwa: 88 },
    });

    expect(response.status).toBe(422);
  });

  /**
   * The raw strand string is not accepted at any privilege level: `student_profiles.strand` is a
   * derived mirror with exactly one writer, and a second way to set it is how a mirror becomes a
   * second opinion.
   */
  it('rejects a raw strand string — the id is the only way in', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const raw = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { strand: 'Academic' },
    });

    expect(raw.status).toBe(422);
  });

  it('rejects a lookup id that names no row', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: '00000000-0000-4000-8000-000000000000' },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.shs_strand_id).toBeDefined();
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
      body: { shs_strand_id: lookups.academic, math_grade: 88 },
    });
    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { grade_level_id: lookups.grade12 },
    });

    const profile = await api('GET', '/student/profile', { token: studentToken });

    expect(profile.body.data.grade_level).toBe('Grade 12');
    expect(profile.body.data.strand).toBe('Academic');
    expect(profile.body.data.math_grade).toBe('88.00');
  });
});

/**
 * **The derivation** (migration 0017) — grade level and SHS strand come from the class a counselor
 * enrolled the student in, and the student may not overrule them.
 */
describe('grade level and strand derived from the class', () => {
  /** A class that carries both values, with one student in it. */
  async function studentInClassWith(fields: {
    grade_level_id?: string | null;
    shs_strand_id?: string | null;
  }) {
    const classRoom = await createClass(counselorToken, fields);
    const roster = await enrolStudents(counselorToken, classRoom.id, ['Ana Reyes']);
    const studentToken = await joinClass(classRoom.join_code, roster[0].username);

    return { classRoom, studentToken };
  }

  it('assigns both fields at enrollment, with their text mirrors', async () => {
    const { studentToken } = await studentInClassWith({
      grade_level_id: lookups.grade11,
      shs_strand_id: lookups.technical,
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.grade_level_id).toBe(lookups.grade11);
    expect(response.body.data.grade_level).toBe('Grade 11');
    expect(response.body.data.shs_strand_id).toBe(lookups.technical);
    // The mirror §27 actually reads.
    expect(response.body.data.strand).toBe('Technical-Professional');
  });

  /**
   * The flags the profile screen locks its selects on. Computed on the server because the rule is
   * a server rule — a UI that guessed would offer a control whose submission always fails.
   */
  it('marks the derived fields, and names the class that set them', async () => {
    const { classRoom, studentToken } = await studentInClassWith({
      grade_level_id: lookups.grade12,
      shs_strand_id: lookups.academic,
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.derived).toEqual({
      grade_level: true,
      shs_strand: true,
      class_name: classRoom.name,
    });
  });

  /**
   * **Refused, not ignored.** Silently discarding an edit a student watched themselves make is the
   * data-loss bug the profile screen's own comments warn about — and the version of it nobody ever
   * reports, because the form says "saved".
   */
  it('refuses a student’s attempt to change a derived field', async () => {
    const { studentToken } = await studentInClassWith({
      grade_level_id: lookups.grade12,
      shs_strand_id: lookups.academic,
    });

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: lookups.technical },
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.shs_strand_id[0]).toMatch(/set by your class/i);

    // And nothing moved.
    const profile = await api('GET', '/student/profile', { token: studentToken });

    expect(profile.body.data.strand).toBe('Academic');
  });

  /**
   * The whole payload is refused, not half-applied: a body touching one locked field and one free
   * one must not save the free half and report an error about the other.
   */
  it('refuses the whole patch when one field is derived', async () => {
    const { studentToken } = await studentInClassWith({ shs_strand_id: lookups.academic });

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: lookups.technical, math_grade: 95 },
    });

    expect(response.status).toBe(422);

    const profile = await api('GET', '/student/profile', { token: studentToken });

    expect(profile.body.data.math_grade).toBeNull();
  });

  /**
   * A derivation, not a lockout. A student whose class carries no strand — because their counselor
   * has not set one yet — keeps the field editable, which is what makes joining before the class is
   * finished a workable state rather than a dead end.
   */
  it('leaves a field editable when the class does not supply it', async () => {
    const { studentToken } = await studentInClassWith({ grade_level_id: lookups.grade12 });

    const before = await api('GET', '/student/profile', { token: studentToken });

    expect(before.body.data.derived.grade_level).toBe(true);
    expect(before.body.data.derived.shs_strand).toBe(false);

    const response = await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: lookups.technical },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.strand).toBe('Technical-Professional');
  });

  /**
   * Rule 1: editing the class pushes the new value onto everyone already in it. Without this the
   * derivation would only hold for students enrolled after the counselor got round to setting it.
   */
  it('re-syncs every enrolled student when the class changes', async () => {
    const { classRoom, studentToken } = await studentInClassWith({
      grade_level_id: lookups.grade11,
      shs_strand_id: lookups.academic,
    });

    const patched = await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token: counselorToken,
      body: { grade_level_id: lookups.grade12, shs_strand_id: lookups.technical },
    });

    expect(patched.status).toBe(200);

    const profile = await api('GET', '/student/profile', { token: studentToken });

    expect(profile.body.data.grade_level).toBe('Grade 12');
    expect(profile.body.data.strand).toBe('Technical-Professional');
  });

  /**
   * A counselor clearing the class's strand is stating that the class no longer has one. Leaving
   * the last value behind on every profile would make that statement quietly false — and would
   * leave §27 scoring a strand nobody claims.
   */
  it('clears the students’ value when the class clears its own', async () => {
    const { classRoom, studentToken } = await studentInClassWith({
      shs_strand_id: lookups.academic,
    });

    await api('PATCH', `/counselor/classes/${classRoom.id}`, {
      token: counselorToken,
      body: { shs_strand_id: null },
    });

    const profile = await api('GET', '/student/profile', { token: studentToken });

    expect(profile.body.data.shs_strand_id).toBeNull();
    expect(profile.body.data.strand).toBeNull();
    // …and the student may now set it themselves, because nothing supplies it any more.
    expect(profile.body.data.derived.shs_strand).toBe(false);
  });
});

/**
 * The **profiling** block (prompt-driven, v1.6) — what the student dashboard's persistent banner is
 * computed from, and deliberately a *superset* of `is_complete_for_recommendations` above.
 *
 * The two are not redundant, and collapsing them would break one of them. That flag answers a
 * question about the **engine**: a strand and an academic signal are the two inputs §27 cannot run
 * without. This answers a question about the **student**: what is still missing from the profile
 * they were asked to fill in. Grade level is required here and not there because §27 never reads it
 * while the counselor's roster does — a profile without it is incomplete even though the engine
 * tolerates it.
 */
describe('profiling completeness (the dashboard banner)', () => {
  it('names every missing field, with the label the banner shows', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.status).toBe(200);
    expect(response.body.data.profiling.is_complete).toBe(false);
    expect(response.body.data.profiling.missing.map((field: any) => field.field)).toEqual([
      'shs_strand_id',
      'grade_level_id',
      'subject_grades',
    ]);
    // The label travels with the field so the banner does not carry its own copy of the mapping.
    expect(response.body.data.profiling.missing[0].label).toBe('Academic track / strand');
  });

  it('is still incomplete when only the engine’s two inputs are set', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: lookups.academic, math_grade: 88 },
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    // The engine can run…
    expect(response.body.data.is_complete_for_recommendations).toBe(true);
    // …and the profile is still missing something the student was asked for.
    expect(response.body.data.profiling.is_complete).toBe(false);
    expect(response.body.data.profiling.missing.map((field: any) => field.field)).toEqual([
      'grade_level_id',
    ]);
  });

  it('clears once every required field is present — the banner disappears on its own', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: {
        shs_strand_id: lookups.academic,
        grade_level_id: lookups.grade12,
        math_grade: 88,
      },
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.profiling.is_complete).toBe(true);
    expect(response.body.data.profiling.missing).toEqual([]);
  });

  it('returns incomplete again if a required field is cleared', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: {
        shs_strand_id: lookups.academic,
        grade_level_id: lookups.grade12,
        math_grade: 88,
      },
    });

    // An explicit null clears the field — "not selected" has to mean something (the endpoint is a
    // PATCH, so an absent key would leave it alone).
    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: null },
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.profiling.is_complete).toBe(false);
    expect(response.body.data.profiling.missing.map((field: any) => field.field)).toEqual([
      'shs_strand_id',
    ]);
  });

  /**
   * One subject grade is enough. Demanding all three would be asking a student for numbers they
   * may not have, to satisfy an engine that averages whatever it is given.
   */
  it('counts a single subject grade as an academic signal', async () => {
    const { studentToken } = await classWithStudent(counselorToken);

    await api('PATCH', '/student/profile', {
      token: studentToken,
      body: { shs_strand_id: lookups.academic, english_grade: 79 },
    });

    const response = await api('GET', '/student/profile', { token: studentToken });

    expect(response.body.data.is_complete_for_recommendations).toBe(true);
  });
});
