import type { RiasecDimension, Strand } from '@/db/enums';
import { RIASEC_DIMENSIONS } from '@/db/enums';

/**
 * The §27 matching engine — every number a student sees on a recommendation card.
 *
 * This file is **pure arithmetic over numbers**: no database, no I/O, no `Date.now()`. That is
 * the point of it. §26 requires recommendations to be deterministic and reproducible, and the
 * only way to *prove* that is to be able to run the formulas against §28's hand-computed
 * worked example and get §28's numbers back. `test/unit/recommendation.test.ts` does exactly
 * that. `RecommendationService` (Phase 4, once the assessment tables exist) is the shell that
 * reads the inputs and persists the outputs; the judgment lives here.
 *
 * ## Where §27 is silent, and what was decided
 *
 * Four cases arise in real catalog data that §27 does not name. Each is resolved below toward
 * §27's own stated instinct — *an absent signal is neutral, never a penalty* — and each is
 * marked `// SILENCE:` at its site:
 *
 * | Case | Resolution | Why not the alternative |
 * |---|---|---|
 * | A career with no `typical_riasec_code` | RIASEC compatibility = neutral 50 | §27's only stated no-signal default is the program's "defaults to 50 if the program has no linked careers". Excluding the career instead would silently hide a live catalog row from every student. |
 * | A student with no `strand` | Strand alignment = neutral 70, not the 40 mismatch | 40 means "we know your track and it is the wrong one". An unfilled profile field is not a wrong answer, and §27 already maps an unknown GWA to a neutral-leaning-positive 70. |
 * | The eligibility clause when GWA is below 75 | Omit the clause | §27's template hardcodes the words "meets the typical academic profile". A GWA of 72 does not meet it, and the engine must not tell a student something untrue to fill a slot in a string. |
 * | Ranking ties | Break by title/name, ascending | §26 promises reproducibility. Two careers on an identical score would otherwise rank in whatever order the catalog query happened to return. |
 *
 * All four are decisions, not defaults — if a later revision of FULLPLAN rules differently,
 * change them here and the tests will tell you what moved.
 */

// --- The §27 constants ---------------------------------------------------------------------

/**
 * Position weights for a Holland code (§27). The first letter is the dominant type, which is
 * how Holland Code interpretation itself works — `IEC` and `CEI` are different careers.
 *
 * **Renormalized for a code shorter than 3 letters**, per §27. Without it a 1-letter career
 * could score at most 50 out of 100 no matter how perfectly the student matched it, and short
 * codes would be systematically outranked by long ones for reasons that have nothing to do
 * with the student. `lib/holland.ts` guarantees 1–3 letters, so there is no 4th weight to miss.
 */
export const POSITION_WEIGHTS = [0.5, 0.3, 0.2] as const;

/** §27 career composite. Sums to 1.00, so the score lands naturally in 0–100. */
export const CAREER_WEIGHTS = {
  riasecCompatibility: 0.6,
  careerConfidence: 0.3,
  studentPreference: 0.1,
} as const;

/** §27 program composite. Sums to 1.00. */
export const PROGRAM_WEIGHTS = {
  riasecCompatibility: 0.35,
  careerConfidence: 0.15,
  academicFit: 0.2,
  strandAlignment: 0.15,
  programEligibility: 0.1,
  studentPreference: 0.05,
} as const;

/**
 * §27's student-preference component, fixed at 70 for every match in v1.
 *
 * There is no preference-capture mechanism in v1 — no "preferred program" input, no table. The
 * component stays in the formula rather than being dropped so that the weight redistribution is
 * trivial the day a real preference input ships (§63). Being a constant, it shifts every score
 * by the same amount and therefore **changes no ranking**; it is there to keep the composite on
 * a 0–100 scale, not to discriminate between options.
 */
export const STUDENT_PREFERENCE = 70;

/** §27's GWA anchors: 75 is the PH SHS passing minimum, 95 a practical high-end anchor. */
const GWA_FLOOR = 75;
const GWA_CEILING = 95;

/** §27: "defaults to 50 if the program has no linked careers yet" — the no-RIASEC-signal value. */
const NEUTRAL_RIASEC = 50;

/** §27: an unknown GWA is "neutral-leaning-positive", not a failure. */
const NEUTRAL_UNKNOWN_GWA_FIT = 60;
const NEUTRAL_UNKNOWN_GWA_ELIGIBILITY = 70;

/** SILENCE: an unfilled strand is unknown, not mismatched. See the file header. */
const NEUTRAL_UNKNOWN_STRAND = 70;

/** §27: reduced, never zero — "the platform advises, it does not gatekeep". */
const STRAND_MISMATCH = 40;
const STRAND_ALIGNED = 100;

/** §27: only the top 10 of each type are persisted; the full catalog is rescanned each run. */
export const TOP_N = 10;

/**
 * The §22 dimension names, used by the reason string's `{top_dimension_name}`.
 *
 * These are a property of the RIASEC instrument, not of a row someone typed, which is why they
 * are a constant rather than a lookup. Step 4's RIASEC seeder should import this map so that
 * `assessment_dimensions.name` and the sentence a student reads cannot drift apart.
 */
export const RIASEC_DIMENSION_NAMES: Record<RiasecDimension, string> = {
  R: 'Realistic',
  I: 'Investigative',
  A: 'Artistic',
  S: 'Social',
  E: 'Enterprising',
  C: 'Conventional',
};

// --- Inputs --------------------------------------------------------------------------------

/** Normalized 0–100 scores, one per dimension (§22). */
export type RiasecProfile = Record<RiasecDimension, number>;

/**
 * Everything §27 knows about the student. Assembled by the caller from `dimension_scores` and
 * `student_profiles` — the engine itself reads no tables.
 */
export interface StudentSignals {
  riasec: RiasecProfile;
  /**
   * §23's Career Confidence Index, **recomputed** from the SCCT `dimension_scores` rows plus
   * the version's `scoring_config` weights. Never parsed back out of `overall_summary`, which
   * is display-only prose (§23, v1.2).
   */
  careerConfidenceIndex: number;
  gwa: number | null;
  strand: Strand | null;
}

/** The catalog side of a career match — a projection of `careers`, not the row. */
export interface CareerTarget {
  id: string;
  title: string;
  typicalRiasecCode: string | null;
}

/** The catalog side of a program match — a projection of `programs`, not the row. */
export interface ProgramTarget {
  id: string;
  name: string;
  recommendedStrand: Strand | null;
}

// --- Component formulas (§27), all on a 0–100 scale -----------------------------------------

/**
 * How well a student's profile matches a target Holland code, weighting the first letter most
 * heavily (§27).
 *
 * A `null` code yields the neutral 50 rather than a zero or an exclusion — SILENCE, see the
 * file header. Note the consequence, which is real and intended: every codeless career scores
 * identically, so they tie with each other and are then ordered by title. They are not ranked
 * *against* each other on any evidence, because there is none.
 */
export function riasecCompatibility(profile: RiasecProfile, targetCode: string | null): number {
  if (targetCode === null || targetCode === '') {
    return NEUTRAL_RIASEC; // SILENCE: no code = no signal, not a bad match.
  }

  // `lib/holland.ts` already caps a stored code at 3 letters — the same count as the position
  // weights. Truncating here too means a code that somehow evaded that validation is cut short
  // rather than read against a weight index that does not exist, which is the silent misread
  // holland.ts exists to prevent.
  const letters = targetCode.split('').slice(0, POSITION_WEIGHTS.length) as RiasecDimension[];
  const weightSum = POSITION_WEIGHTS.slice(0, letters.length).reduce(
    (sum, weight) => sum + weight,
    0,
  );

  // Renormalized (§27), so a 1- or 2-letter code still spans the full 0–100 range.
  return letters.reduce((score, letter, index) => {
    const weight = POSITION_WEIGHTS[index] ?? 0; // Unreachable: `letters` is sliced to 3.

    return score + profile[letter] * (weight / weightSum);
  }, 0);
}

/**
 * The average compatibility across a program's linked careers (§27).
 *
 * `scorableCareersFor()` in the catalog module is what decides which careers reach this — it
 * drops archived ones, so a program whose careers are all archived arrives here with an empty
 * list and takes the neutral 50, indistinguishable from an unmapped program. That is the point:
 * an average over nothing is `NaN`, which would silently poison the whole composite.
 */
export function programRiasecCompatibility(
  profile: RiasecProfile,
  linkedCareerCodes: (string | null)[],
): number {
  if (linkedCareerCodes.length === 0) {
    return NEUTRAL_RIASEC;
  }

  const total = linkedCareerCodes.reduce(
    (sum, code) => sum + riasecCompatibility(profile, code),
    0,
  );

  return total / linkedCareerCodes.length;
}

/** §27 — a linear GWA fit between the passing floor and a high-end anchor. */
export function academicFit(gwa: number | null): number {
  if (gwa === null) {
    return NEUTRAL_UNKNOWN_GWA_FIT;
  }

  return clamp(((gwa - GWA_FLOOR) / (GWA_CEILING - GWA_FLOOR)) * 100, 0, 100);
}

/**
 * §27 — a coarse eligibility gate. Deliberately a tier, not a rules engine.
 *
 * A strand the student never filled in is **not** a mismatch (SILENCE, see the file header):
 * scoring it 40 would tell a student their track is wrong on the strength of a blank field.
 */
export function strandAlignment(
  studentStrand: Strand | null,
  programStrand: Strand | null,
): number {
  if (programStrand === null) {
    return STRAND_ALIGNED; // The program has no strand requirement to fail.
  }

  if (studentStrand === null) {
    return NEUTRAL_UNKNOWN_STRAND; // SILENCE: unknown, not wrong.
  }

  return studentStrand === programStrand ? STRAND_ALIGNED : STRAND_MISMATCH;
}

/** §27 — the deterministic eligibility tier. An unknown GWA leans positive, never punitive. */
export function programEligibility(gwa: number | null): number {
  if (gwa === null) {
    return NEUTRAL_UNKNOWN_GWA_ELIGIBILITY;
  }

  if (gwa >= 80) {
    return 100;
  }

  if (gwa >= GWA_FLOOR) {
    return 70;
  }

  return 40;
}

// --- Composites (§27) ----------------------------------------------------------------------

/** The per-component breakdown behind a score — what makes a match auditable rather than magic. */
export interface CareerMatchComponents {
  riasecCompatibility: number;
  careerConfidenceIndex: number;
  studentPreference: number;
}

export interface ProgramMatchComponents {
  riasecCompatibility: number;
  careerConfidenceIndex: number;
  academicFit: number;
  strandAlignment: number;
  programEligibility: number;
  studentPreference: number;
}

export interface CareerMatch {
  careerId: string;
  matchScore: number;
  reason: string;
  components: CareerMatchComponents;
}

export interface ProgramMatch {
  programId: string;
  matchScore: number;
  reason: string;
  components: ProgramMatchComponents;
}

/**
 * Score one career (§27).
 *
 * Components are carried unrounded and only the composite is rounded, which is why §28's
 * intermediate `67.75` is not first flattened to `67.8`. Rounding an input and then weighting
 * it compounds the error into the number a student is actually shown.
 */
export function scoreCareer(student: StudentSignals, career: CareerTarget): CareerMatch {
  const components: CareerMatchComponents = {
    riasecCompatibility: riasecCompatibility(student.riasec, career.typicalRiasecCode),
    careerConfidenceIndex: student.careerConfidenceIndex,
    studentPreference: STUDENT_PREFERENCE,
  };

  const matchScore = roundToTenth(
    components.riasecCompatibility * CAREER_WEIGHTS.riasecCompatibility +
      components.careerConfidenceIndex * CAREER_WEIGHTS.careerConfidence +
      components.studentPreference * CAREER_WEIGHTS.studentPreference,
  );

  return {
    careerId: career.id,
    matchScore,
    reason: buildReason(student, 'CAREER', career.title, career.typicalRiasecCode, null),
    components,
  };
}

/**
 * Score one program (§27).
 *
 * `linkedCareerCodes` comes from `AcademicCatalogService.scorableCareersFor()` — the single
 * place recommendability is decided. The engine deliberately does not re-derive it.
 */
export function scoreProgram(
  student: StudentSignals,
  program: ProgramTarget,
  linkedCareerCodes: (string | null)[],
): ProgramMatch {
  const components: ProgramMatchComponents = {
    riasecCompatibility: programRiasecCompatibility(student.riasec, linkedCareerCodes),
    careerConfidenceIndex: student.careerConfidenceIndex,
    academicFit: academicFit(student.gwa),
    strandAlignment: strandAlignment(student.strand, program.recommendedStrand),
    programEligibility: programEligibility(student.gwa),
    studentPreference: STUDENT_PREFERENCE,
  };

  const matchScore = roundToTenth(
    components.riasecCompatibility * PROGRAM_WEIGHTS.riasecCompatibility +
      components.careerConfidenceIndex * PROGRAM_WEIGHTS.careerConfidence +
      components.academicFit * PROGRAM_WEIGHTS.academicFit +
      components.strandAlignment * PROGRAM_WEIGHTS.strandAlignment +
      components.programEligibility * PROGRAM_WEIGHTS.programEligibility +
      components.studentPreference * PROGRAM_WEIGHTS.studentPreference,
  );

  return {
    programId: program.id,
    matchScore,
    reason: buildReason(student, 'PROGRAM', program.name, null, program.recommendedStrand),
    components,
  };
}

// --- Ranking (§27) -------------------------------------------------------------------------

/**
 * Sort descending and keep the top `limit` (§27 persists 10 of each type).
 *
 * The tie-break is not decoration. §26 promises a reproducible ranking, and two careers on an
 * identical score — which is not hypothetical: every codeless career ties with every other —
 * would otherwise be ordered by whatever the catalog query happened to return that day. SILENCE,
 * see the file header.
 */
export function rankTop<T>(
  matches: T[],
  score: (match: T) => number,
  label: (match: T) => string,
  limit: number = TOP_N,
): T[] {
  return [...matches]
    .sort((a, b) => score(b) - score(a) || label(a).localeCompare(label(b)))
    .slice(0, limit);
}

// --- The deterministic reason string (§27) --------------------------------------------------

/**
 * §27's reason template. String formatting over numbers already computed — not a model call.
 * It is fast, free, and reproducible from the same inputs, which is the whole claim of §26.
 *
 * `matchType` is passed rather than inferred from which arguments happen to be null. The two
 * are *not* equivalent: a career with no Holland code has a null code and no strand, which is
 * indistinguishable from a program's argument shape — and it would have picked up the
 * program-only GWA clause. The strand and eligibility clauses are program clauses (§27), so
 * what decides they appear is the kind of match, not a coincidence of empty fields.
 */
function buildReason(
  student: StudentSignals,
  matchType: 'CAREER' | 'PROGRAM',
  target: string,
  targetCode: string | null,
  programStrand: Strand | null,
): string {
  const top = topDimension(student.riasec);
  const topName = RIASEC_DIMENSION_NAMES[top];
  const topPct = formatNumber(student.riasec[top]);
  const confidencePct = formatNumber(student.careerConfidenceIndex);

  // A program has no Holland code of its own — it is scored on the average of its careers — and
  // neither does a codeless career. Claiming alignment with a "typical profile" that is not
  // there would be a sentence about a missing value.
  const opening =
    targetCode === null
      ? `Your ${topName} interest score (${topPct}%) and SCCT career confidence (${confidencePct}%) are the strongest signals in your profile for ${target}.`
      : `Your ${topName} interest score (${topPct}%) and SCCT career confidence (${confidencePct}%) align with ${target}'s typical profile (${targetCode}).`;

  if (matchType === 'CAREER') {
    return opening;
  }

  const clauses = [opening];

  // §27: the clause states a *match*, so it appears only when there is one to state.
  if (student.strand !== null && programStrand !== null && student.strand === programStrand) {
    clauses.push(`Matches your ${student.strand} track.`);
  }

  // SILENCE: §27 hardcodes "meets the typical academic profile". Below the passing floor that
  // is simply false, so the clause is omitted rather than made to lie.
  if (student.gwa !== null && student.gwa >= GWA_FLOOR) {
    clauses.push(
      `Your GWA of ${formatNumber(student.gwa)} meets the typical academic profile for this path.`,
    );
  }

  return clauses.join(' ');
}

/**
 * The student's strongest dimension, tie-broken on the canonical `R > I > A > S > E > C` order
 * (§22) — the same sequence the Holland code derivation uses, so the reason string can never
 * name a different dimension than the result code leads with.
 */
export function topDimension(profile: RiasecProfile): RiasecDimension {
  return RIASEC_DIMENSIONS.reduce((best, dimension) =>
    profile[dimension] > profile[best] ? dimension : best,
  );
}

// --- Numeric helpers ------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** §28 presents match scores to one decimal (`76.06 → 76.1`). */
function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `84.0` reads as `84`, `72.3` stays `72.3`. Trailing-zero noise in a sentence a student reads. */
function formatNumber(value: number): string {
  return String(roundToTenth(value));
}
