import type { LinkRelationship, RiasecDimension, Strand } from '@/db/enums';
import { RIASEC_DIMENSIONS } from '@/db/enums';
import { DEFAULT_FORMULA, type ScoringFormula } from '@/lib/scoring-formula';

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
 * | A student with no `strand` | Strand alignment = neutral 70, not the 40 mismatch | 40 means "we know your track and it is the wrong one". An unfilled profile field is not a wrong answer, and §27 already maps an unknown academic average to a neutral-leaning-positive 70. |
 * | The eligibility clause when the academic average is below 75 | Omit the clause | §27's template hardcodes the words "meets the typical academic profile". A 72 does not meet it, and the engine must not tell a student something untrue to fill a slot in a string. |
 * | Ranking ties | Break by title/name, ascending | §26 promises reproducibility. Two careers on an identical score would otherwise rank in whatever order the catalog query happened to return. |
 *
 * All four are decisions, not defaults — if a later revision of FULLPLAN rules differently,
 * change them here and the tests will tell you what moved.
 *
 * ## The academic signal is no longer the GWA (prompt-driven, 2026-07-27)
 *
 * §27 wrote `academic_fit` and `program_eligibility` against `student_profiles.gwa`. That field has
 * been removed from the student profile, so both now read the **average of whichever of Math,
 * Science and English the student filled in**.
 *
 * The anchors are untouched (75 floor, 95 ceiling) and the neutral values for "no signal" are
 * untouched — a student who filled in none of the three lands on exactly the 60 that a NULL GWA
 * used to produce. The change is *which number* is fed in, not what is done with it.
 *
 * The average is over **present** fields only, not over three with blanks read as zero. A student
 * who knows their Math grade and not their Science grade has given one real signal, and averaging
 * it against a zero would turn that into a punishment for honesty.
 *
 * ## The program composite now follows the careers (prompt-driven, 2026-09-18)
 *
 * A student whose #1 career was Clinical Psychologist was shown BS Psychology at #7, below four
 * programs that lead nowhere near it. Nothing was broken: the old composite spent 30% of a
 * program's score on `academicFit` + `programEligibility` — two readings of the *same* subject
 * average, which is identical for every program a given student is scored against and therefore
 * discriminates between none of them — and the only term that looked at the careers a program
 * leads to was an **average** over all of them, which punishes a degree with one perfect
 * destination and several ordinary ones.
 *
 * So the program composite was re-weighted around the thing a student is actually asking about:
 *
 * | Component | Was | Now | Why |
 * |---|---|---|---|
 * | `riasecCompatibility` | 0.35 | 0.35 | Unchanged. The breadth signal: *all* the careers. |
 * | `careerAlignment` | — | **0.25** | New. The depth signal: the **best** careers, scored exactly as the student's own career list scores them. |
 * | `careerConfidence` | 0.15 | 0.20 | SCCT is a real, per-student signal and was outweighed by two readings of one grade average. |
 * | `academicFit` | 0.20 | 0.10 | Still counts — but it cannot be a fifth of a score it cannot vary. |
 * | `strandAlignment` | 0.15 | 0.10 | A 60-point mismatch penalty at 0.15 was, on its own, enough to sink a program that led to the student's #1 career. |
 * | `programEligibility` | 0.10 | **gone** | The *second* reading of the subject average, on coarser tiers. `academicFit` already says it, continuously. |
 * | `studentPreference` | 0.05 | **gone** | A constant 70 for every match in v1 — see below. |
 *
 * **Why `studentPreference` went with it.** The five weights above sum to 1.00 only without it,
 * and of everything in the composite it is the one term that can be dropped without losing a
 * signal: it is the same number for every program, so it changed no ranking, ever. `CAREER_WEIGHTS`
 * keeps it, so §63's preference input still has a home the day it ships — it just no longer takes
 * a share of the program score away from the terms that discriminate.
 */

// --- The §27 constants ---------------------------------------------------------------------

/**
 * ## The constants moved, and the engine takes them as an argument (2026-09-21)
 *
 * Every number below now lives in `lib/scoring-formula.ts` as a field of `DEFAULT_FORMULA`, and
 * every function in this file takes a `ScoringFormula` whose default **is** `DEFAULT_FORMULA`. The
 * arithmetic is untouched: a call that names no formula computes exactly what it computed before,
 * which is what keeps §28's worked example a valid check on this file.
 *
 * The names below are kept as aliases onto the defaults because they are what the rest of the
 * system reads when it wants to say "the shipped weights" — a test pinning §28, a knowledge
 * passage stating what the shipped configuration does. Code that scores a *student* must use the
 * formula it was handed, not these: an administrator may have changed them (see `FormulaService`).
 */

/**
 * Position weights for a Holland code (§27). The first letter is the dominant type, which is
 * how Holland Code interpretation itself works — `IEC` and `CEI` are different careers.
 *
 * **Renormalized for a code shorter than 3 letters**, per §27. Without it a 1-letter career
 * could score at most 50 out of 100 no matter how perfectly the student matched it, and short
 * codes would be systematically outranked by long ones for reasons that have nothing to do
 * with the student. `lib/holland.ts` guarantees 1–3 letters, so there is no 4th weight to miss.
 */
export const POSITION_WEIGHTS = DEFAULT_FORMULA.positionWeights;

/** §27 career composite. Sums to 1.00, so the score lands naturally in 0–100. */
export const CAREER_WEIGHTS = DEFAULT_FORMULA.career;

/**
 * The program composite. Sums to 1.00 — see the file header for what moved on 2026-09-18 and why.
 */
export const PROGRAM_WEIGHTS = DEFAULT_FORMULA.program;

/**
 * How many of a program's linked careers vote on `careerAlignment`, and how loudly.
 *
 * **Three, not all of them** — the whole point of this component is to be the opposite of the
 * average `riasecCompatibility` already takes. A degree is judged by the best destinations it
 * opens, not by its weakest ones: BS Psychology leads to Clinical Psychologist *and* to a handful
 * of ordinary-fit roles, and averaging those together is exactly what buried it.
 *
 * **Three, not one.** A single `max()` would hand a whole program's 25% to one catalog row, so one
 * optimistic program→career mapping typed by an admin could carry a degree to the top of a
 * student's list on its own. Three with a decaying weight needs a *pattern*, not a row.
 *
 * Renormalized when fewer than three careers are linked, exactly as `POSITION_WEIGHTS` is, so a
 * program with one linked career is scored on that career rather than capped at 60% of the range.
 */
export const CAREER_ALIGNMENT_DEPTH = DEFAULT_FORMULA.careerAlignmentDepth;

/**
 * §27's student-preference component, fixed at 70 for every match in v1. **Career matches only**
 * since 2026-09-18 — the program composite dropped it (see `PROGRAM_WEIGHTS`).
 *
 * There is no preference-capture mechanism in v1 — no "preferred program" input, no table. The
 * component stays in the career formula rather than being dropped so that the weight
 * redistribution is trivial the day a real preference input ships (§63). Being a constant, it
 * shifts every career score by the same amount and therefore **changes no ranking**; it is there
 * to keep the composite on a 0–100 scale, not to discriminate between options.
 */
export const STUDENT_PREFERENCE = DEFAULT_FORMULA.neutrals.studentPreference;

/** §27: only the top 10 of each type are persisted; the full catalog is rescanned each run. */
export const TOP_N = DEFAULT_FORMULA.topN;

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
  /**
   * The academic average — the mean of whichever subject grades the student filled in, or NULL
   * when they filled in none. Callers build it with `academicAverage()` rather than assembling it
   * themselves, so there is one definition of "the student's academic signal" in the system.
   */
  academicAverage: number | null;
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

/**
 * One career a program leads to, as the program composite needs it.
 *
 * The title travels with the code because `careerAlignment` made the question *which* career a
 * program aligns with worth answering out loud. Before it, a program's careers were an anonymous
 * bag of Holland codes to average; now the best of them is 25% of the score, and a reason that
 * would not name it is withholding the one fact that explains the number.
 */
export interface LinkedCareer {
  title: string;
  typicalRiasecCode: string | null;
  /**
   * How strongly the program leads there (migration 0041). Absent means `direct`, which counts
   * fully — the only kind of link that existed before 0041.
   */
  relationship?: LinkRelationship;
}

/** Each linked career's weight under the formula's `linkWeights`, in the same order. */
export function linkWeightsOf(linked: LinkedCareer[], formula: ScoringFormula = DEFAULT_FORMULA): number[] {
  return linked.map((career) => formula.linkWeights[career.relationship ?? 'direct']);
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
export function riasecCompatibility(
  profile: RiasecProfile,
  targetCode: string | null,
  formula: ScoringFormula = DEFAULT_FORMULA,
): number {
  if (targetCode === null || targetCode === '') {
    return formula.neutrals.riasec; // SILENCE: no code = no signal, not a bad match.
  }

  const positions = formula.positionWeights;

  // `lib/holland.ts` already caps a stored code at 3 letters — the same count as the position
  // weights. Truncating here too means a code that somehow evaded that validation is cut short
  // rather than read against a weight index that does not exist, which is the silent misread
  // holland.ts exists to prevent.
  const letters = targetCode.split('').slice(0, positions.length) as RiasecDimension[];
  const weightSum = positions.slice(0, letters.length).reduce((sum, weight) => sum + weight, 0);

  // Renormalized (§27), so a 1- or 2-letter code still spans the full 0–100 range.
  return letters.reduce((score, letter, index) => {
    const weight = positions[index] ?? 0; // Unreachable: `letters` is sliced to 3.

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
  formula: ScoringFormula = DEFAULT_FORMULA,
  linkWeights?: number[],
): number {
  if (linkedCareerCodes.length === 0) {
    return formula.neutrals.riasec;
  }

  // A **weighted** average since migration 0041: a related or conditional career is weaker evidence
  // about what the program is, so it has a smaller say in the average. With every link `direct`
  // (weight 1) this is exactly the plain average §28's worked example checks.
  const weights = linkWeights ?? linkedCareerCodes.map(() => 1);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  const total = linkedCareerCodes.reduce(
    (sum, code, index) => sum + riasecCompatibility(profile, code, formula) * (weights[index] ?? 1),
    0,
  );

  return total / weightSum;
}

/**
 * One career's composite, **unrounded** — the single definition of "what this career scores for
 * this student".
 *
 * `scoreCareer` rounds it for display; `careerAlignment` blends several of them and lets the
 * program composite do the rounding. Neither re-derives the formula, which is the point: the
 * number a program's career alignment is built from is the *same* number the student reads on
 * their career list, not a parallel opinion that can drift from it.
 */
export function careerMatchScore(
  student: StudentSignals,
  targetCode: string | null,
  formula: ScoringFormula = DEFAULT_FORMULA,
): number {
  return (
    riasecCompatibility(student.riasec, targetCode, formula) * formula.career.riasecCompatibility +
    student.careerConfidenceIndex * formula.career.careerConfidence +
    formula.neutrals.studentPreference * formula.career.studentPreference
  );
}

/**
 * A linked career's score for this student, **discounted toward neutral** by its link weight
 * (migration 0041) — what `careerAlignment` ranks and `bestLinkedCareer` names.
 *
 * Toward the score of a career with no Holland code (the neutral point of this scale), not toward
 * zero: a program that only *relates* to a student's best career is weaker evidence of fit, not
 * evidence against it. A student whose best career scores below neutral is likewise pulled up
 * rather than punished further, which is the same symmetry. Weight 1 returns the score unchanged.
 */
export function weightedCareerScore(
  student: StudentSignals,
  targetCode: string | null,
  weight: number,
  formula: ScoringFormula = DEFAULT_FORMULA,
): number {
  const score = careerMatchScore(student, targetCode, formula);

  if (weight === 1) {
    return score;
  }

  const neutral = careerMatchScore(student, null, formula);

  return neutral + (score - neutral) * weight;
}

/**
 * How strongly a program leads to the careers this student was actually recommended
 * (2026-09-18) — the component that makes the two lists answer to each other.
 *
 * It scores the program's linked careers with `careerMatchScore` and keeps the best few under
 * `CAREER_ALIGNMENT_DEPTH`. Because those are the same scores that rank the student's career list,
 * "this program's alignment is high" and "this program leads to careers near the top of your list"
 * are the same statement — which is what a student means when they ask why their #1 career and
 * their #1 program point in different directions.
 *
 * A program with no linked careers is scored as though it linked to one career with no Holland
 * code: the neutral 50 compatibility, carried through the career formula. That keeps an unmapped
 * program on the **same scale** as a mapped one — a flat 50 here would be a different unit from
 * every other value this function returns, and would read as a middling career rather than as no
 * information.
 */
export function careerAlignment(
  student: StudentSignals,
  linkedCareerCodes: (string | null)[],
  formula: ScoringFormula = DEFAULT_FORMULA,
  linkWeights?: number[],
): number {
  const depth = formula.careerAlignmentDepth;
  const codes = linkedCareerCodes.length === 0 ? [null] : linkedCareerCodes;
  const weights = linkedCareerCodes.length === 0 ? [1] : (linkWeights ?? codes.map(() => 1));
  const best = codes
    .map((code, index) => weightedCareerScore(student, code, weights[index] ?? 1, formula))
    .sort((a, b) => b - a)
    .slice(0, depth.length);
  const weightSum = depth.slice(0, best.length).reduce((sum, weight) => sum + weight, 0);

  // Renormalized for fewer than three careers, for the same reason `riasecCompatibility` does it:
  // otherwise a program with one linked career could never score above 60% of the range, and
  // breadth of mapping would outrank fit.
  return best.reduce((score, value, index) => {
    const weight = depth[index] ?? 0; // Unreachable: `best` is sliced to 3.

    return score + value * (weight / weightSum);
  }, 0);
}

/**
 * The student's academic signal: the mean of whichever subject grades are present, or NULL.
 *
 * **Present fields only.** A blank is not a zero — a student who knows their Math grade and not
 * their Science grade has given one real signal, and averaging it against a zero would convert
 * honesty about a gap into a penalty. All-blank returns NULL, which the two formulas below map to
 * their neutral values, exactly as a NULL GWA used to.
 */
export function academicAverage(grades: {
  mathGrade: number | null;
  scienceGrade: number | null;
  englishGrade: number | null;
}): number | null {
  const present = [grades.mathGrade, grades.scienceGrade, grades.englishGrade].filter(
    (grade): grade is number => grade !== null && Number.isFinite(grade),
  );

  if (present.length === 0) {
    return null;
  }

  return present.reduce((sum, grade) => sum + grade, 0) / present.length;
}

/** §27 — a linear academic fit between the passing floor and a high-end anchor. */
export function academicFit(
  average: number | null,
  formula: ScoringFormula = DEFAULT_FORMULA,
): number {
  if (average === null) {
    return formula.neutrals.academicUnknown;
  }

  const { floor, ceiling } = formula.academic;

  return clamp(((average - floor) / (ceiling - floor)) * 100, 0, 100);
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
  formula: ScoringFormula = DEFAULT_FORMULA,
): number {
  const { strandAligned, strandUnknown, strandMismatch } = formula.neutrals;

  if (programStrand === null) {
    return strandAligned; // The program has no strand requirement to fail.
  }

  if (studentStrand === null) {
    return strandUnknown; // SILENCE: unknown, not wrong.
  }

  return studentStrand === programStrand ? strandAligned : strandMismatch;
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
  careerAlignment: number;
  careerConfidenceIndex: number;
  academicFit: number;
  strandAlignment: number;
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
export function scoreCareer(
  student: StudentSignals,
  career: CareerTarget,
  formula: ScoringFormula = DEFAULT_FORMULA,
): CareerMatch {
  const components: CareerMatchComponents = {
    riasecCompatibility: riasecCompatibility(student.riasec, career.typicalRiasecCode, formula),
    careerConfidenceIndex: student.careerConfidenceIndex,
    studentPreference: formula.neutrals.studentPreference,
  };

  const matchScore = roundToTenth(careerMatchScore(student, career.typicalRiasecCode, formula));

  return {
    careerId: career.id,
    matchScore,
    reason: buildReason(student, 'CAREER', career.title, career.typicalRiasecCode, null, null, formula),
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
  linkedCareers: LinkedCareer[],
  formula: ScoringFormula = DEFAULT_FORMULA,
): ProgramMatch {
  const linkedCareerCodes = linkedCareers.map((career) => career.typicalRiasecCode);
  const weights = linkWeightsOf(linkedCareers, formula);
  const components: ProgramMatchComponents = {
    riasecCompatibility: programRiasecCompatibility(
      student.riasec,
      linkedCareerCodes,
      formula,
      weights,
    ),
    careerAlignment: careerAlignment(student, linkedCareerCodes, formula, weights),
    careerConfidenceIndex: student.careerConfidenceIndex,
    academicFit: academicFit(student.academicAverage, formula),
    strandAlignment: strandAlignment(student.strand, program.recommendedStrand, formula),
  };

  const matchScore = roundToTenth(
    components.riasecCompatibility * formula.program.riasecCompatibility +
      components.careerAlignment * formula.program.careerAlignment +
      components.careerConfidenceIndex * formula.program.careerConfidence +
      components.academicFit * formula.program.academicFit +
      components.strandAlignment * formula.program.strandAlignment,
  );

  return {
    programId: program.id,
    matchScore,
    reason: buildReason(
      student,
      'PROGRAM',
      program.name,
      null,
      program.recommendedStrand,
      bestLinkedCareer(student, linkedCareers, formula),
      formula,
    ),
    components,
  };
}

/**
 * The linked career this student scores highest on — the one `careerAlignment` leans on hardest,
 * and the one the reason string names.
 *
 * Tie-broken by title for the same reason the rankings are (§26): two careers on an identical
 * score would otherwise be named in whatever order the catalog query returned that day, and the
 * reason is persisted text a student can screenshot.
 */
function bestLinkedCareer(
  student: StudentSignals,
  linked: LinkedCareer[],
  formula: ScoringFormula,
): string | null {
  // Ranked on the link-weighted score (migration 0041), so the career the sentence names is the one
  // `careerAlignment` actually leaned on — a related link does not get named over a direct one it
  // only narrowly beats on raw fit.
  const score = (career: LinkedCareer) =>
    weightedCareerScore(
      student,
      career.typicalRiasecCode,
      formula.linkWeights[career.relationship ?? 'direct'],
      formula,
    );
  const ranked = [...linked].sort(
    (a, b) => score(b) - score(a) || a.title.localeCompare(b.title),
  );

  return ranked[0]?.title ?? null;
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

/**
 * `rankTop`, but at most one match per `key` — the top *things*, not the top rows.
 *
 * A `programs` row is one college's offering, so "BS Nursing" is not one candidate but one per
 * college that offers it. Every one of those rows scores **identically**: §27 scores a program on
 * its name-independent inputs — the RIASEC average of its linked careers, its recommended strand,
 * the student's own academic average — none of which vary by institution. So a plain top-10 of
 * rows returned ten copies of the same degree and buried BS Computer Science and BS Civil
 * Engineering below the cut, telling a student whose top careers were nurse, web developer and
 * civil engineer that every program for them was nursing.
 *
 * The key is the canonical program where the offering has been matched to one, and its name where
 * it has not — an unmapped row is still the same degree as its unmapped twin, and keying those by
 * `id` would let the duplicates straight back in.
 *
 * Which offering survives is decided by the same sort as the ranking, so it is the highest-scoring
 * one and, on the ties that are the norm here, the alphabetically first — reproducible, per §26,
 * rather than whatever the catalog query returned that day. The others are not lost: the card's
 * "colleges offering this program" disclosure is the answer to *where*, and this list is the
 * answer to *what*.
 */
export function rankTopDistinct<T>(
  matches: T[],
  score: (match: T) => number,
  label: (match: T) => string,
  key: (match: T) => string,
  limit: number = TOP_N,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];

  for (const match of [...matches].sort(
    (a, b) => score(b) - score(a) || label(a).localeCompare(label(b)),
  )) {
    const identity = key(match);

    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    kept.push(match);

    if (kept.length === limit) {
      break;
    }
  }

  return kept;
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
  bestCareer: string | null = null,
  formula: ScoringFormula = DEFAULT_FORMULA,
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

  // The career-alignment clause (2026-09-18). `careerAlignment` is 25% of a program score and is
  // driven hardest by this one career, so naming it turns the largest single reason a program
  // ranks where it does from a number into a sentence. It is also the answer to the question this
  // component was added for — "my top career is X, so why is the program that leads to X not at
  // the top?" — which a student can now read off the card without asking the assistant at all.
  //
  // Omitted for an unmapped program rather than hedged: there is no career to name, and a program
  // that leads nowhere in the catalog should not be given a sentence implying it leads somewhere.
  if (bestCareer !== null) {
    clauses.push(`Its strongest career match for you is ${bestCareer}.`);
  }

  // §27: the clause states a *match*, so it appears only when there is one to state.
  if (student.strand !== null && programStrand !== null && student.strand === programStrand) {
    clauses.push(`Matches your ${student.strand} track.`);
  }

  // SILENCE: §27 hardcodes "meets the typical academic profile". Below the passing floor that
  // is simply false, so the clause is omitted rather than made to lie.
  //
  // The sentence names "subject average" rather than "GWA" because that is now what the number
  // is. Telling a student their GWA is 88 when they never gave one — and when 88 is the mean of
  // the three subjects they did give — would be a small, avoidable lie in the one paragraph the
  // system promises is reproducible from its inputs (§26).
  if (student.academicAverage !== null && student.academicAverage >= formula.academic.floor) {
    clauses.push(
      `Your subject average of ${formatNumber(student.academicAverage)} meets the typical academic profile for this path.`,
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
