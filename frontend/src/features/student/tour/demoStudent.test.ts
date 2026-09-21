import { describe, expect, it } from 'vitest';

import { bandFor } from '@/features/student/reports/likertBands';
import { compositeIndex } from '@/features/student/reports/reportMath';
import { demoStudent } from '@/features/student/tour/demoStudent';

/**
 * The example student's numbers, and why they are worth a test.
 *
 * A student meets these figures *while being taught how to read them* — the card beside the
 * screen is saying "this is your Holland code", "this is out of 100", "this is not a mark". A
 * demo whose code did not follow from its own bars, or whose confidence index did not follow from
 * its own weights, would teach that reading wrongly and would do it on the one screen a student
 * has no way of checking. So the fixture is held to the rules the real screens compute by.
 */
describe('the tour example student', () => {
  const demo = demoStudent();

  const riasec = demo.results.find((result) => result.assessment?.category === 'RIASEC');
  const scct = demo.results.find((result) => result.assessment?.category === 'SCCT');

  /** Both, because the **Print results** button — a stop of its own — renders only for both. */
  it('has finished both standing instruments', () => {
    expect(riasec).toBeDefined();
    expect(scct).toBeDefined();
    expect(demo.assignments.every((one) => one.my_attempt?.status === 'SCORED')).toBe(true);
    expect(demo.assignments).toHaveLength(demo.results.length);
  });

  it('carries the Holland code its own dimensions produce', () => {
    const ranked = [...(riasec?.dimensions ?? [])].sort(
      (a, b) => Number(b.normalized_score) - Number(a.normalized_score),
    );

    expect(riasec?.result?.result_code).toBe(
      ranked
        .slice(0, 3)
        .map((dimension) => dimension.code)
        .join(''),
    );
  });

  /** §23: the card recomputes this from the report's weights, so the two must agree. */
  it('carries the confidence index its own weights produce', () => {
    const report = demo.reports.find((one) => one.attempt_id === scct?.attempt_id);
    const composite = compositeIndex(
      (scct?.dimensions ?? []).map((dimension) => ({
        code: dimension.code,
        pct: Number(dimension.normalized_score),
      })),
      report?.instrument.composite_weights ?? null,
    );

    expect(composite?.index).toBeCloseTo(82.0, 5);
    expect(scct?.result?.overall_summary).toBe(`${bandFor(82).label} Career Confidence.`);
  });

  it('bands every dimension the way the real cards band one', () => {
    for (const result of demo.results) {
      for (const dimension of result.dimensions) {
        const score = Number(dimension.normalized_score);

        expect(dimension.interpretation).toContain(bandFor(score).label);
        expect(score).toBeGreaterThanOrEqual(20);
        expect(score).toBeLessThanOrEqual(100);
      }
    }
  });

  /** §3: nothing is recommended without a reason, and the example must not teach otherwise. */
  it('gives every match a rank and a reason', () => {
    const { careers, programs } = demo.recommendations;

    expect(careers.length).toBeGreaterThan(0);
    expect(programs.length).toBeGreaterThan(0);

    for (const list of [careers, programs]) {
      expect(list.map((one) => one.ranking)).toEqual(list.map((_one, index) => index + 1));

      for (const one of list) {
        expect(one.reason).not.toHaveLength(0);
        expect(one.match_score).toBeGreaterThan(0);
        expect(one.match_score).toBeLessThanOrEqual(100);
      }
    }
  });

  /** The dashboard's four boxes count the other four datasets. Mixed, they read as a bug. */
  it('agrees with its own dashboard', () => {
    expect(demo.dashboard.results_count).toBe(demo.results.length);
    expect(demo.dashboard.assignments.completed).toBe(demo.assignments.length);
    expect(demo.dashboard.assignments.pending).toBe(0);
    expect(demo.dashboard.recommendations_ready).toBe(true);
  });

  /**
   * Nothing here can be mistaken for a real row — by the server if one ever escaped the overlay,
   * or by a developer reading a cache.
   */
  it('marks every id as the example student', () => {
    const ids = [
      ...demo.results.map((one) => one.attempt_id),
      ...demo.assignments.map((one) => one.id),
      ...demo.recommendations.careers.map((one) => one.id),
      ...demo.recommendations.careers.map((one) => one.career.id),
      ...demo.recommendations.programs.map((one) => one.id),
      ...demo.recommendations.programs.map((one) => one.program.id),
      ...demo.recommendations.programs.map((one) => one.college.id),
    ];

    for (const id of ids) {
      expect(id.startsWith('tour-demo-')).toBe(true);
    }
  });
});
