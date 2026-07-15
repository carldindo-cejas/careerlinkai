import { describe, expect, it } from 'vitest';

import {
  CAREER_WEIGHTS,
  PROGRAM_WEIGHTS,
  academicFit,
  programEligibility,
  programRiasecCompatibility,
  rankTop,
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
 * Science" to 76.1, and those two numbers are the fixed point of this whole file. If a refactor
 * moves them, the refactor is wrong — not the example.
 *
 * The seeded catalog is built to match (§27's worked example scores UP Diliman's BSCS through
 * Software Engineer `IEC` and Data Analyst `ICE`), so these are not invented fixtures — they
 * are the rows Phase 4 will actually read.
 */

/** §28's student, exactly: RIASEC profile, SCCT index, GWA and strand. */
const WORKED_EXAMPLE_STUDENT: StudentSignals = {
  riasec: { I: 84.0, A: 71.0, S: 62.0, C: 55.0, E: 48.0, R: 30.0 },
  careerConfidenceIndex: 72.3,
  gwa: 88,
  strand: 'Academic',
};

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

  it('scores BS Computer Science at 76.1', () => {
    // program_riasec_compat = (67.4 + 68.1) / 2 = 67.75
    // academic_fit          = clamp(((88-75)/(95-75))×100) = 65.0
    // strand_alignment      = 100   (Academic == Academic)
    // program_eligibility   = 100   (gwa 88 >= 80)
    // = (67.75×0.35) + (72.3×0.15) + (65.0×0.20) + (100×0.15) + (100×0.10) + (70×0.05)
    // = 23.71 + 10.85 + 13.00 + 15.00 + 10.00 + 3.50 = 76.06
    const match = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'program-bscs', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      ['IEC', 'ICE'],
    );

    expect(match.components.riasecCompatibility).toBeCloseTo(67.75, 6);
    expect(match.components.academicFit).toBeCloseTo(65.0, 6);
    expect(match.components.strandAlignment).toBe(100);
    expect(match.components.programEligibility).toBe(100);
    expect(match.matchScore).toBe(76.1);
  });

  it('ranks the program above the bare career match, which is §28’s actual point', () => {
    // 76.1 > 69.1 — the program score also rewards strand and academic alignment, which is why
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
      ['IEC', 'ICE'],
    );

    expect(program.matchScore).toBeGreaterThan(career.matchScore);
  });

  it('does not round the intermediates before weighting them', () => {
    // §28 carries 67.75 into the composite rather than flattening it to 67.8 first. Rounding an
    // input and *then* weighting it compounds the error into the number a student is shown.
    const match = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      ['IEC', 'ICE'],
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

describe('programEligibility', () => {
  it('applies the §27 tiers at their exact boundaries', () => {
    expect(programEligibility(88)).toBe(100); // §28
    expect(programEligibility(80)).toBe(100);
    expect(programEligibility(79.99)).toBe(70);
    expect(programEligibility(75)).toBe(70);
    expect(programEligibility(74.99)).toBe(40);
  });

  it('leans positive on an unknown GWA', () => {
    expect(programEligibility(null)).toBe(70);
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
    expect(reason).not.toMatch(/GWA/);
  });

  it('adds both clauses on an aligned program match', () => {
    const { reason } = scoreProgram(
      WORKED_EXAMPLE_STUDENT,
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      ['IEC', 'ICE'],
    );

    expect(reason).toContain('Matches your Academic track.');
    expect(reason).toContain('Your GWA of 88 meets the typical academic profile for this path.');
  });

  it('states no track match when the strands differ', () => {
    const { reason } = scoreProgram(
      { ...WORKED_EXAMPLE_STUDENT, strand: 'Technical-Professional' },
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      ['IEC'],
    );

    expect(reason).not.toMatch(/track/);
  });

  /**
   * SILENCE: §27's template hardcodes the words "meets the typical academic profile". At a GWA
   * of 72 that is simply false — the engine must not tell a student something untrue in order to
   * fill a slot in a string.
   */
  it('omits the eligibility clause when the GWA does not actually meet the bar', () => {
    const { reason } = scoreProgram(
      { ...WORKED_EXAMPLE_STUDENT, gwa: 72 },
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      ['IEC'],
    );

    expect(reason).not.toMatch(/GWA/);
    expect(reason).toContain('Matches your Academic track.');
  });

  it('omits the eligibility clause when the GWA is unknown', () => {
    const { reason } = scoreProgram(
      { ...WORKED_EXAMPLE_STUDENT, gwa: null },
      { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' },
      ['IEC'],
    );

    expect(reason).not.toMatch(/GWA/);
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

    expect(reason).not.toMatch(/GWA/);
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
      gwa: 100,
      strand: 'Academic',
    };
    const empty: StudentSignals = {
      riasec: profile(),
      careerConfidenceIndex: 0,
      gwa: 0,
      strand: null,
    };
    const program = { id: 'p', name: 'BS Computer Science', recommendedStrand: 'Academic' as const };

    expect(scoreProgram(perfect, program, ['IEC']).matchScore).toBeLessThanOrEqual(100);
    expect(scoreProgram(empty, program, ['IEC']).matchScore).toBeGreaterThanOrEqual(0);
    expect(
      scoreCareer(perfect, { id: 'c', title: 'X', typicalRiasecCode: 'IEC' }).matchScore,
    ).toBeLessThanOrEqual(100);
    expect(
      scoreCareer(empty, { id: 'c', title: 'X', typicalRiasecCode: 'IEC' }).matchScore,
    ).toBeGreaterThanOrEqual(0);
  });
});
