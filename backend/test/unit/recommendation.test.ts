import { describe, expect, it } from 'vitest';

import {
  CAREER_WEIGHTS,
  PROGRAM_WEIGHTS,
  academicFit,
  careerAlignment,
  careerMatchScore,
  programRiasecCompatibility,
  rankTop,
  rankTopDistinct,
  riasecCompatibility,
  scoreCareer,
  scoreProgram,
  strandAlignment,
  topDimension,
  type RiasecProfile,
  type StudentSignals,
} from '@/lib/recommendation';

/**
 * The §27 engine in isolation — and above all, **§28's worked example**.
 *
 * §26 claims recommendations are deterministic and reproducible. The only way to hold that
 * claim to account is to check the engine against numbers a human computed by hand, rather
 * than against itself: FULLPLAN §28 works "Software Engineer" out to 69.1 and "BS Computer
 * Science" out of the same inputs, and those numbers are the fixed point of this whole file.
 * If a refactor moves them, the refactor is wrong — not the example.
 *
 * **The program half of the example was re-derived by hand on 2026-09-18**, when the program
 * weights changed (see `lib/recommendation.ts`'s header). §28's *inputs* are untouched — the same
 * student, the same two careers, the same program — and every intermediate below is worked out
 * the long way from those inputs rather than copied off a test run. The career half (69.1) did not
 * move at all: `CAREER_WEIGHTS` was not touched.
 *
 * The seeded catalog is built to match (§27's worked example scores UP Diliman's BSCS through
 * Software Engineer `IEC` and Data Analyst `ICE`), so these are not invented fixtures — they
 * are the rows Phase 4 will actually read.
 */

/** §28's student, exactly: RIASEC profile, SCCT index, academic average and strand. */
const WORKED_EXAMPLE_STUDENT: StudentSignals = {
  riasec: { I: 84.0, A: 71.0, S: 62.0, C: 55.0, E: 48.0, R: 30.0 },
  careerConfidenceIndex: 72.3,
  academicAverage: 88,
  strand: 'Academic',
};

/** §28's two linked careers, as `scoreProgram` now takes them: a title and a Holland code. */
const BSCS_CAREERS = [
  { title: 'Software Engineer', typicalRiasecCode: 'IEC' },
  { title: 'Data Analyst', typicalRiasecCode: 'ICE' },
];

const profile = (overrides: Partial<RiasecProfile> = {}): RiasecProfile => ({
  R: 0,
  I: 0,
  A: 0,
  S: 0,
  E: 0,
  C: 0,
  ...overrides,
});

describe('§28 worked example — the fixed point', () => {
  it('scores Software Engineer (IEC) at 69.1', () => {
    // riasec_compatibility = (84.0×0.5) + (48.0×0.3) + (55.0×0.2) = 42.0 + 14.4 + 11.0 = 67.4
    // career_match_score   = (67.4×0.60) + (72.3×0.30) + (70×0.10) = 40.44 + 21.69 + 7.00 = 69.13
    const match = scoreCareer(WORKED_EXAMPLE_STUDENT, {
      id: 'career-se',
      title: 'Software Engineer',
      typicalRiasecCode: 'IEC',
    });

    expect(match.components.riasecCompatibility).toBeCloseTo(67.4, 6);
    expect(match.matchScore).toBe(69.1);
  });

  it('scores Data Analyst (ICE) with a compatibility of 68.1', () => {
    // The letters are the same three as IEC — only the *order* differs, and the order is data.
    // (84×0.5) + (55×0.3) + (48×0.2) = 42.0 + 16.5 + 9.6 = 68.1
    expect(riasecCompatibility(WORKED_EXAMPLE_STUDENT.riasec, 'ICE')).toBeCloseTo(68.1, 6);
  });

  it('scores BS Computer Science at 72.0', () => {
    // program_riasec_compat = (67.4 + 68.1) / 2 = 67.75
    //
    // career_alignment — the two careers' own career_match_scores, best first, under the
    // renormalized depth weights [0.6, 0.25] / 0.85 = [0.705882…, 0.294118…]:
    //   Data Analyst      (68.1×0.60) + (72.3×0.30) + (70×0.10) = 40.86 + 21.69 + 7.00 = 69.55
    //   Software Engineer (67.4×0.60) + (72.3×0.30) + (70×0.10) = 40.44 + 21.69 + 7.00 = 69.13
    //   = (69.55 × 0.705882…) + (69.13 × 0.294118…) = 49.0941… + 20.3324… = 69.4265…
    //
    // academic_fit          = clamp(((88-75)/(95-75))×100) = 65.0
    // strand_alignment      = 100   (Academic == Academic)
    //
    // = (67.75×0.35) + (69.4265…×0.25) + (72.3×0.20) + (65.0×0.10) + (100×0.10)
    // = 23.7125 + 17.3566… + 14.46 + 6.50 + 10.00 = 72.029… → 72.0
    const match = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'program-bscs', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      BSCS_CAREERS,
    );

    expect(match.components.riasecCompatibility).toBeCloseTo(67.75, 6);
    expect(match.components.careerAlignment).toBeCloseTo(69.42647058823529, 6);
    expect(match.components.academicFit).toBeCloseTo(65.0, 6);
    expect(match.components.strandAlignment).toBe(100);
    expect(match.matchScore).toBe(72.0);
  });

  it('ranks the program above the bare career match, which is §28’s actual point', () => {
    // 72.0 > 69.1 — the program score also rewards strand and academic alignment, which is why
    // the platform separates career-level and program-level matching rather than collapsing
    // them into one number.
    const career = scoreCareer(WORKED_EXAMPLE_STUDENT, {
      id: 'career-se',
      title: 'Software Engineer',
      typicalRiasecCode: 'IEC',
    });
    const program = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'program-bscs', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      BSCS_CAREERS,
    );

    expect(program.matchScore).toBeGreaterThan(career.matchScore);
  });

  it('does not round the intermediates before weighting them', () => {
    // §28 carries 67.75 into the composite rather than flattening it to 67.8 first. Rounding an
    // input and *then* weighting it compounds the error into the number a student is shown.
    const match = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      BSCS_CAREERS,
    );

    expect(match.components.riasecCompatibility).not.toBe(67.8);
    expect(match.components.riasecCompatibility).toBeCloseTo(67.75, 6);
  });
});

describe('riasecCompatibility', () => {
  it('weights the first letter most heavily — order is data, not formatting', () => {
    const student = profile({ I: 100, E: 0, C: 0 });

    // The dominant letter carries 0.5 of the weight; the same letters in another position do not.
    expect(riasecCompatibility(student, 'IEC')).toBeCloseTo(50, 6);
    expect(riasecCompatibility(student, 'ECI')).toBeCloseTo(20, 6);
  });

  /**
   * §27 renormalizes the weights for a code shorter than 3 letters. Without it a 1-letter
   * career could score at most 50 no matter how perfectly the student matched it, and short
   * codes would be systematically outranked by long ones for reasons unrelated to the student.
   */
  it('renormalizes the weights for a one-letter code', () => {
    const student = profile({ I: 84 });

    expect(riasecCompatibility(student, 'I')).toBeCloseTo(84, 6);
  });

  it('renormalizes the weights for a two-letter code', () => {
    // weights [0.5, 0.3] sum to 0.8 → renormalized to [0.625, 0.375]
    // (84 × 0.625) + (48 × 0.375) = 52.5 + 18.0 = 70.5
    const student = profile({ I: 84, E: 48 });

    expect(riasecCompatibility(student, 'IE')).toBeCloseTo(70.5, 6);
  });

  it('spans the full 0–100 range at both ends', () => {
    expect(riasecCompatibility(profile({ I: 100, E: 100, C: 100 }), 'IEC')).toBeCloseTo(100, 6);
    expect(riasecCompatibility(profile(), 'IEC')).toBeCloseTo(0, 6);
  });

  /**
   * SILENCE (§27 does not name this case): a career with no Holland code has no RIASEC signal,
   * so it takes the neutral 50 — the same value §27 gives a program with no linked careers.
   * Not an exclusion: a codeless career is a legitimate catalog row and must not vanish from a
   * student's list because an admin left one field blank.
   */
  it('gives a career with no Holland code the neutral 50, not a zero', () => {
    expect(riasecCompatibility(WORKED_EXAMPLE_STUDENT.riasec, null)).toBe(50);
    expect(riasecCompatibility(WORKED_EXAMPLE_STUDENT.riasec, '')).toBe(50);
  });
});

describe('programRiasecCompatibility', () => {
  it('averages over the linked careers', () => {
    expect(
      programRiasecCompatibility(WORKED_EXAMPLE_STUDENT.riasec, ['IEC', 'ICE']),
    ).toBeCloseTo(67.75, 6);
  });

  /**
   * The empty list is not hypothetical: `scorableCareersFor()` drops archived careers, so a
   * program whose careers are *all* archived arrives here empty and must be indistinguishable
   * from an unmapped one. An average over nothing is NaN, which would silently poison the whole
   * composite rather than failing loudly.
   */
  it('takes the neutral 50 when the program has no scorable careers', () => {
    const score = programRiasecCompatibility(WORKED_EXAMPLE_STUDENT.riasec, []);

    expect(score).toBe(50);
    expect(Number.isNaN(score)).toBe(false);
  });
});

describe('academicFit', () => {
  it('maps the GWA band linearly between the 75 floor and the 95 anchor', () => {
    expect(academicFit(88)).toBeCloseTo(65, 6); // §28
    expect(academicFit(85)).toBeCloseTo(50, 6);
    expect(academicFit(75)).toBeCloseTo(0, 6);
    expect(academicFit(95)).toBeCloseTo(100, 6);
  });

  it('clamps outside the anchors rather than running negative or past 100', () => {
    expect(academicFit(60)).toBe(0);
    expect(academicFit(100)).toBe(100);
  });

  it('treats an unknown GWA as neutral, not as a failing one', () => {
    expect(academicFit(null)).toBe(60);
  });
});

describe('strandAlignment', () => {
  it('scores 100 when the program has no strand requirement to fail', () => {
    expect(strandAlignment('Technical-Professional', null)).toBe(100);
    expect(strandAlignment(null, null)).toBe(100);
  });

  it('scores 100 on an aligned track', () => {
    expect(strandAlignment('Academic', 'Academic')).toBe(100);
  });

  /**
   * §27: "reduced, never zero" — a Technical-Professional student with a strong Investigative
   * profile should still *see* BS Computer Science, just ranked lower. The platform advises; it
   * does not gatekeep.
   */
  it('reduces a mismatch to 40 rather than excluding the program', () => {
    expect(strandAlignment('Technical-Professional', 'Academic')).toBe(40);
  });

  /**
   * SILENCE (§27 does not name this case): 40 means "we know your track and it is the wrong
   * one". A student who never filled the field in has not given a wrong answer, and scoring
   * them as a mismatch would penalize a blank. §27 already maps an unknown GWA to a
   * neutral-leaning-positive 70; an unknown strand gets the same treatment.
   */
  it('treats an unfilled student strand as unknown (70), not as a mismatch (40)', () => {
    expect(strandAlignment(null, 'Academic')).toBe(70);
  });
});

describe('careerAlignment', () => {
  /**
   * The component exists to be the *opposite* of `programRiasecCompatibility`'s average, and this
   * is the case that produced it: a student whose top career was Clinical Psychologist saw BS
   * Psychology at #7, because the one perfect destination was averaged away against the program's
   * ordinary ones. A program that leads to the student's best career must outscore one that leads
   * to three mediocre careers, even when the two averages say otherwise.
   */
  it('rewards the best destination where the average punishes it', () => {
    // One-letter codes, so a career's compatibility *is* that dimension's score and the arithmetic
    // is readable: I 90, A 60, S 30.
    const student: StudentSignals = {
      riasec: profile({ I: 90, A: 60, S: 30 }),
      careerConfidenceIndex: 72.3,
      academicAverage: 88,
      strand: 'Academic',
    };
    const peaked = ['I', 'S', 'S']; // one excellent destination, two poor ones — average 50
    const flat = ['A', 'A', 'A']; // three middling destinations — average 60

    // The average prefers the flat program…
    expect(programRiasecCompatibility(student.riasec, peaked)).toBeCloseTo(50, 6);
    expect(programRiasecCompatibility(student.riasec, flat)).toBeCloseTo(60, 6);

    // …and career alignment reverses it: (90×0.6) + (30×0.25) + (30×0.15) = 66 against a flat 60,
    // before both are carried through the career formula, which is monotonic and preserves it.
    expect(careerAlignment(student, peaked)).toBeGreaterThan(careerAlignment(student, flat));
  });

  it('is the career composite itself when one career is linked', () => {
    expect(careerAlignment(WORKED_EXAMPLE_STUDENT, ['IEC'])).toBeCloseTo(
      careerMatchScore(WORKED_EXAMPLE_STUDENT, 'IEC'),
      6,
    );
  });

  /**
   * Renormalized below three careers, for the same reason `riasecCompatibility` renormalizes a
   * short Holland code: without it, a program with one linked career could never exceed 60% of the
   * range and breadth of mapping would quietly outrank fit.
   */
  it('renormalizes rather than capping a program with fewer than three careers', () => {
    const one = careerAlignment(WORKED_EXAMPLE_STUDENT, ['I']);
    const two = careerAlignment(WORKED_EXAMPLE_STUDENT, ['I', 'I']);
    const three = careerAlignment(WORKED_EXAMPLE_STUDENT, ['I', 'I', 'I']);

    expect(one).toBeCloseTo(three, 6);
    expect(two).toBeCloseTo(three, 6);
  });

  /** Only the best three vote, so a long tail of poor mappings cannot drag a program down. */
  it('reads only the best three careers', () => {
    const three = careerAlignment(WORKED_EXAMPLE_STUDENT, ['I', 'I', 'I']);
    const threePlusTail = careerAlignment(WORKED_EXAMPLE_STUDENT, ['I', 'I', 'I', 'R', 'R', 'R']);

    expect(threePlusTail).toBeCloseTo(three, 6);
  });

  /** Order in, order out: the catalog returns its rows in no meaningful order (§26). */
  it('does not depend on the order the careers arrive in', () => {
    expect(careerAlignment(WORKED_EXAMPLE_STUDENT, ['R', 'IEC', 'ICE'])).toBeCloseTo(
      careerAlignment(WORKED_EXAMPLE_STUDENT, ['ICE', 'R', 'IEC']),
      6,
    );
  });

  /**
   * An unmapped program is scored as one codeless career — the neutral 50 compatibility carried
   * through the *career* formula, so it lands on the same scale as every other value here. A flat
   * 50 would be a different unit, and would read as a middling career rather than as no signal.
   */
  it('puts a program with no scorable careers on the same scale, not on a flat 50', () => {
    const empty = careerAlignment(WORKED_EXAMPLE_STUDENT, []);

    expect(empty).toBeCloseTo(careerMatchScore(WORKED_EXAMPLE_STUDENT, null), 6);
    expect(Number.isNaN(empty)).toBe(false);
  });
});

describe('careerMatchScore', () => {
  /**
   * One definition of "what this career scores for this student", used by both composites. If
   * these two ever diverge, a program's career alignment is built on a number the student's own
   * career list does not show — which is the whole thing the component was added to prevent.
   */
  it('is the unrounded number behind the career match a student is shown', () => {
    const match = scoreCareer(WORKED_EXAMPLE_STUDENT, {
      id: 'career-se',
      title: 'Software Engineer',
      typicalRiasecCode: 'IEC',
    });

    expect(careerMatchScore(WORKED_EXAMPLE_STUDENT, 'IEC')).toBeCloseTo(69.13, 6);
    expect(match.matchScore).toBe(69.1);
  });
});

describe('topDimension', () => {
  it('picks the strongest dimension', () => {
    expect(topDimension(WORKED_EXAMPLE_STUDENT.riasec)).toBe('I');
  });

  /**
   * The canonical R > I > A > S > E > C order (§22) is the same sequence the Holland code
   * derivation tie-breaks on, so the reason string can never name a different dimension than
   * the result code leads with.
   */
  it('tie-breaks on the canonical R > I > A > S > E > C order', () => {
    expect(topDimension(profile({ I: 80, A: 80, C: 80 }))).toBe('I');
    expect(topDimension(profile({ S: 80, E: 80 }))).toBe('S');
    expect(topDimension(profile({ R: 50, C: 50 }))).toBe('R');
  });

  it('is defined even for an all-zero profile', () => {
    expect(topDimension(profile())).toBe('R');
  });
});

describe('rankTop', () => {
  const score = (m: { score: number; name: string }) => m.score;
  const label = (m: { score: number; name: string }) => m.name;

  it('sorts descending', () => {
    const ranked = rankTop(
      [
        { score: 40, name: 'c' },
        { score: 90, name: 'a' },
        { score: 60, name: 'b' },
      ],
      score,
      label,
    );

    expect(ranked.map((m) => m.name)).toEqual(['a', 'b', 'c']);
  });

  /**
   * §26 promises a reproducible ranking, and ties are not hypothetical — every codeless career
   * scores identically to every other. Without a tie-break they would rank in whatever order the
   * catalog query happened to return that day.
   */
  it('breaks ties by name so the ranking is reproducible', () => {
    const ranked = rankTop(
      [
        { score: 70, name: 'Zoologist' },
        { score: 70, name: 'Architect' },
        { score: 70, name: 'Machinist' },
      ],
      score,
      label,
    );

    expect(ranked.map((m) => m.name)).toEqual(['Architect', 'Machinist', 'Zoologist']);
  });

  it('keeps only the top 10 by default (§27 persists 10 of each type)', () => {
    const matches = Array.from({ length: 25 }, (_, i) => ({ score: i, name: `career-${i}` }));

    const ranked = rankTop(matches, score, label);

    expect(ranked.map((m) => m.score)).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15]);
  });

  it('does not mutate the caller’s array', () => {
    const matches = [
      { score: 10, name: 'a' },
      { score: 90, name: 'b' },
    ];

    rankTop(matches, score, label);

    expect(matches.map((m) => m.name)).toEqual(['a', 'b']);
  });
});

describe('rankTopDistinct', () => {
  const score = (m: { score: number; name: string; key: string }) => m.score;
  const label = (m: { score: number; name: string; key: string }) => m.name;
  const key = (m: { score: number; name: string; key: string }) => m.key;

  /**
   * The bug this exists for. A `programs` row is one college's offering and §27 scores a program
   * on inputs that do not vary by institution, so every college's BS Nursing tied on the same
   * score — and a top-10 of *rows* was ten copies of it, with the student's other matching degrees
   * pushed below the cut.
   */
  it('keeps one offering per canonical program, not one per college', () => {
    const ranked = rankTopDistinct(
      [
        { score: 88, name: 'BS Nursing', key: 'cat-nursing' },
        { score: 88, name: 'BS Nursing', key: 'cat-nursing' },
        { score: 88, name: 'BS Nursing', key: 'cat-nursing' },
        { score: 84, name: 'BS Computer Science', key: 'cat-cs' },
        { score: 84, name: 'BS Computer Science', key: 'cat-cs' },
        { score: 80, name: 'BS Civil Engineering', key: 'cat-ce' },
      ],
      score,
      label,
      key,
    );

    expect(ranked.map((m) => m.name)).toEqual([
      'BS Nursing',
      'BS Computer Science',
      'BS Civil Engineering',
    ]);
  });

  it('collapses unmapped offerings keyed by name', () => {
    const ranked = rankTopDistinct(
      [
        { score: 70, name: 'BS Nursing', key: 'name:bs nursing' },
        { score: 70, name: 'BS Nursing', key: 'name:bs nursing' },
        { score: 60, name: 'BS Biology', key: 'name:bs biology' },
      ],
      score,
      label,
      key,
    );

    expect(ranked.map((m) => m.name)).toEqual(['BS Nursing', 'BS Biology']);
  });

  /** Same order as `rankTop`, so which offering represents a degree is reproducible (§26). */
  it('keeps the highest-scoring offering, and on a tie the alphabetically first', () => {
    const ranked = rankTopDistinct(
      [
        { score: 70, name: 'Zeta College BSN', key: 'cat-nursing' },
        { score: 90, name: 'Alpha College BSN', key: 'cat-nursing' },
      ],
      score,
      label,
      key,
    );

    expect(ranked.map((m) => m.name)).toEqual(['Alpha College BSN']);

    const tied = rankTopDistinct(
      [
        { score: 90, name: 'Zeta College BSN', key: 'cat-nursing' },
        { score: 90, name: 'Alpha College BSN', key: 'cat-nursing' },
      ],
      score,
      label,
      key,
    );

    expect(tied.map((m) => m.name)).toEqual(['Alpha College BSN']);
  });

  it('still keeps only the top 10 by default', () => {
    const matches = Array.from({ length: 25 }, (_, i) => ({
      score: i,
      name: `program-${i}`,
      key: `cat-${i}`,
    }));

    expect(rankTopDistinct(matches, score, label, key)).toHaveLength(10);
  });

  it('does not mutate the caller’s array', () => {
    const matches = [
      { score: 10, name: 'a', key: 'k1' },
      { score: 90, name: 'b', key: 'k2' },
    ];

    rankTopDistinct(matches, score, label, key);

    expect(matches.map((m) => m.name)).toEqual(['a', 'b']);
  });
});

describe('the deterministic reason string', () => {
  it('names the top dimension, its score, and the target profile', () => {
    const { reason } = scoreCareer(WORKED_EXAMPLE_STUDENT, {
      id: 'career-se',
      title: 'Software Engineer',
      typicalRiasecCode: 'IEC',
    });

    expect(reason).toBe(
      "Your Investigative interest score (84%) and SCCT career confidence (72.3%) align with Software Engineer's typical profile (IEC).",
    );
  });

  /** §27: the strand and eligibility clauses are *program*-match clauses. */
  it('omits the strand and GWA clauses on a career match', () => {
    const { reason } = scoreCareer(WORKED_EXAMPLE_STUDENT, {
      id: 'career-se',
      title: 'Software Engineer',
      typicalRiasecCode: 'IEC',
    });

    expect(reason).not.toMatch(/track/);
    expect(reason).not.toMatch(/subject average/);
  });

  it('adds every clause on an aligned program match', () => {
    const { reason } = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      BSCS_CAREERS,
    );

    // Data Analyst (ICE, 69.55) outscores Software Engineer (IEC, 69.13) for this student, so the
    // clause names it — the reason must not name whichever career the catalog listed first.
    expect(reason).toContain('Its strongest career match for you is Data Analyst.');
    expect(reason).toContain('Matches your Academic track.');
    expect(reason).toContain('Your subject average of 88 meets the typical academic profile for this path.');
  });

  /**
   * The career-alignment clause is 25% of the score put into words, so it must name the career
   * the component actually leaned on — not the first row, and not a tie broken by luck.
   */
  it('names no career when the program leads nowhere in the catalog', () => {
    const { reason } = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      [],
    );

    expect(reason).not.toMatch(/strongest career match/);
  });

  it('breaks a tie between equally-matched careers by title, so the reason is reproducible', () => {
    const { reason } = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      [
        { title: 'Zoologist', typicalRiasecCode: 'IEC' },
        { title: 'Archivist', typicalRiasecCode: 'IEC' },
      ],
    );

    expect(reason).toContain('Its strongest career match for you is Archivist.');
  });

  it('states no track match when the strands differ', () => {
    const { reason } = scoreProgram(
      { ...WORKED_EXAMPLE_STUDENT, strand: 'Technical-Professional' },
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      [{ title: 'Software Engineer', typicalRiasecCode: 'IEC' }],
    );

    expect(reason).not.toMatch(/track/);
  });

  /**
   * SILENCE: §27's template hardcodes the words "meets the typical academic profile". At an average
   * of 72 that is simply false — the engine must not tell a student something untrue in order to
   * fill a slot in a string.
   */
  it('omits the eligibility clause when the subject average does not actually meet the bar', () => {
    const { reason } = scoreProgram(
      { ...WORKED_EXAMPLE_STUDENT, academicAverage: 72 },
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      [{ title: 'Software Engineer', typicalRiasecCode: 'IEC' }],
    );

    expect(reason).not.toMatch(/subject average/);
    expect(reason).toContain('Matches your Academic track.');
  });

  it('omits the eligibility clause when no subject grade was given', () => {
    const { reason } = scoreProgram(
      { ...WORKED_EXAMPLE_STUDENT, academicAverage: null },
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      [{ title: 'Software Engineer', typicalRiasecCode: 'IEC' }],
    );

    expect(reason).not.toMatch(/subject average/);
  });

  /**
   * The regression this pins: a codeless career has a null code and no strand — the same
   * argument shape as a program — so a reason builder that *inferred* the match type from which
   * fields were null handed it the program-only GWA clause.
   */
  it('never gives a codeless career the program-only GWA clause', () => {
    const { reason } = scoreCareer(WORKED_EXAMPLE_STUDENT, {
      id: 'career-x',
      title: 'Park Ranger',
      typicalRiasecCode: null,
    });

    expect(reason).not.toMatch(/subject average/);
    expect(reason).not.toMatch(/track/);
    // And it claims no alignment with a "typical profile" that is not there.
    expect(reason).not.toMatch(/typical profile/);
    expect(reason).toContain('Park Ranger');
  });
});

describe('the composite weights', () => {
  /**
   * §27: "Both weight sets sum to 1.00, so both composite scores land naturally in 0–100." A
   * weight edited without its counterpart would silently rescale every score in the system,
   * and nothing else in the codebase would notice.
   */
  it('each sum to 1.00', () => {
    const sum = (weights: Record<string, number>) =>
      Object.values(weights).reduce((total, weight) => total + weight, 0);

    expect(sum(CAREER_WEIGHTS)).toBeCloseTo(1.0, 10);
    expect(sum(PROGRAM_WEIGHTS)).toBeCloseTo(1.0, 10);
  });

  it('keeps a perfect and an empty profile inside 0–100', () => {
    const perfect: StudentSignals = {
      riasec: profile({ R: 100, I: 100, A: 100, S: 100, E: 100, C: 100 }),
      careerConfidenceIndex: 100,
      academicAverage: 100,
      strand: 'Academic',
    };
    const empty: StudentSignals = {
      riasec: profile(),
      careerConfidenceIndex: 0,
      academicAverage: 0,
      strand: null,
    };
    const program = { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' as const };

    const linked = [{ title: 'Software Engineer', typicalRiasecCode: 'IEC' }];

    expect(scoreProgram(perfect, program, linked).matchScore).toBeLessThanOrEqual(100);
    expect(scoreProgram(empty, program, linked).matchScore).toBeGreaterThanOrEqual(0);
    expect(
      scoreCareer(perfect, { id: 'c', title: 'X', typicalRiasecCode: 'IEC' }).matchScore,
    ).toBeLessThanOrEqual(100);
    expect(
      scoreCareer(empty, { id: 'c', title: 'X', typicalRiasecCode: 'IEC' }).matchScore,
    ).toBeGreaterThanOrEqual(0);
  });
});
