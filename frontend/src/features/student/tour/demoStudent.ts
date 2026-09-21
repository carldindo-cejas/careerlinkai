import { bandFor } from '@/features/student/reports/likertBands';
import type { TourDemo } from '@/features/student/tour/demoMode';
import type {
  AssessmentAssignment,
  AssessmentReport,
  AssessmentResult,
  DimensionScore,
} from '@/types/assessment';
import type { Career, College, Place, Program } from '@/types/catalog';
import type {
  CareerRecommendation,
  ProgramRecommendation,
} from '@/types/recommendation';

/**
 * The example student the tour shows — a finished one, on purpose.
 *
 * ## What this is
 *
 * One student who has answered both instruments, has a Holland code, has a confidence index and
 * has ten matches: the state every stop of the tour describes and a first-time student has never
 * seen. `demoMode.ts` explains why the tour needs it and what keeps it honest; this file is only
 * the answers.
 *
 * ## The rules the numbers follow
 *
 * They are not decorative. A student reads these screens *while being told how to read them*, so
 * anything arbitrary here is something the tour teaches wrongly:
 *
 *   * The scores are computed from a raw total over a real maximum (ten five-point items per
 *     dimension), so the bars, the percentages and the band labels agree with each other and with
 *     `likertBands.ts` — the same function the real cards use, not a copy of its cut points.
 *   * The Holland code is the top three dimensions in order (I 92.0, A 84.0, S 74.0 → **IAS**),
 *     derived the way §22 derives it rather than asserted.
 *   * The confidence index is the §23 weighted composite of the three SCCT dimensions —
 *     82.0 × 0.4 + 88.0 × 0.3 + 76.0 × 0.3 = **82.0**, a High band — which is what the results
 *     card recomputes from the report's own weights and prints beside the bars.
 *   * The reasons are §27's template filled with this student's own top dimension and confidence.
 *     They read exactly like the sentences a real card carries because they are built the same way.
 *   * The colleges are real Bohol institutions from our own catalog (seed 0005), because "which
 *     college offers this" is the question the programs list exists to answer, and a made-up
 *     school would teach a student to distrust the one part of this that is a directory.
 *
 * Every id is prefixed `tour-demo-`. Nothing here can collide with a real row, and anything that
 * somehow reached the server would be rejected as an unknown id rather than matched to somebody
 * else's record.
 *
 * ## Why it is a function
 *
 * The dates are relative — "completed three days ago" — so the example student never ages into
 * somebody who finished their assessments two years before the student reading about them.
 */

/** Ten five-point items per dimension, for both instruments. */
const ITEMS_PER_DIMENSION = 10;
const MAX_PER_ITEM = 5;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * One dimension, scored the way the engine scores one: a raw total over the reachable maximum,
 * normalized to 0–100, banded by the shared table rather than by a label typed in by hand.
 */
function dimension(code: string, name: string, raw: number, noun: string): DimensionScore {
  const normalized = (raw / (ITEMS_PER_DIMENSION * MAX_PER_ITEM)) * 100;

  return {
    code,
    name,
    description: null,
    raw_score: raw.toFixed(2),
    normalized_score: normalized.toFixed(2),
    interpretation: `${bandFor(normalized).label} ${noun}`,
  };
}

const RIASEC_DIMENSIONS: DimensionScore[] = [
  dimension('R', 'Realistic', 20, 'Interest'),
  dimension('I', 'Investigative', 46, 'Interest'),
  dimension('A', 'Artistic', 42, 'Interest'),
  dimension('S', 'Social', 37, 'Interest'),
  dimension('E', 'Enterprising', 29, 'Interest'),
  dimension('C', 'Conventional', 27, 'Interest'),
];

const SCCT_DIMENSIONS: DimensionScore[] = [
  dimension('SE', 'Self-Efficacy', 41, 'Confidence'),
  dimension('OE', 'Outcome Expectations', 44, 'Confidence'),
  dimension('GO', 'Goal Orientation', 38, 'Confidence'),
];

const RIASEC_ATTEMPT = 'tour-demo-attempt-riasec';
const SCCT_ATTEMPT = 'tour-demo-attempt-scct';

/** The §27 opening clause, with this student's own signals in it. */
const SIGNALS = 'Your Investigative interest score (92.0%) and SCCT career confidence (82.0%)';
const ACADEMIC_CLAUSE =
  'Your subject average of 89.0 meets the typical academic profile for this path.';

const HIGH_DEMAND: Place & { display_order: number } = {
  id: 'tour-demo-outlook-high',
  name: 'High Demand',
  display_order: 3,
};
const EMERGING: Place & { display_order: number } = {
  id: 'tour-demo-outlook-emerging',
  name: 'Emerging Field',
  display_order: 4,
};

const TAGBILARAN: Place = { id: 'tour-demo-town-tagbilaran', name: 'Tagbilaran City' };
const BILAR: Place = { id: 'tour-demo-town-bilar', name: 'Bilar' };

function college(id: string, name: string, town: Place): College {
  return {
    id,
    name,
    description: null,
    status: 'active',
    region: { id: 'tour-demo-region', name: 'Region VII (Central Visayas)' },
    province: { id: 'tour-demo-province', name: 'Bohol' },
    town,
    barangay: null,
    map_link: null,
    created_at: null,
    updated_at: null,
  };
}

const BISU_MAIN = college(
  'tour-demo-college-bisu-main',
  'Bohol Island State University - Main Campus',
  TAGBILARAN,
);
const BISU_BILAR = college(
  'tour-demo-college-bisu-bilar',
  'Bohol Island State University - Bilar Campus',
  BILAR,
);
const HNU = college('tour-demo-college-hnu', 'Holy Name University', TAGBILARAN);
const UB = college('tour-demo-college-ub', 'University of Bohol', TAGBILARAN);

function career(options: {
  id: string;
  title: string;
  description: string;
  code: string;
  salary: [number, number];
  outlook: Place & { display_order: number };
}): Career {
  return {
    id: options.id,
    title: options.title,
    description: options.description,
    salary_min: options.salary[0],
    salary_max: options.salary[1],
    employment_outlook_id: options.outlook.id,
    employment_outlook: options.outlook,
    typical_riasec_code: options.code,
    status: 'active',
    created_at: null,
    updated_at: null,
  };
}

const CAREERS: { career: Career; score: number }[] = [
  {
    score: 94.2,
    career: career({
      id: 'tour-demo-career-software',
      title: 'Software Developer',
      description:
        'Designs, writes and maintains the programs behind websites, phone apps and the systems businesses run on.',
      code: 'IRC',
      salary: [35_000, 70_000],
      outlook: HIGH_DEMAND,
    }),
  },
  {
    score: 91.0,
    career: career({
      id: 'tour-demo-career-medtech',
      title: 'Medical Laboratory Scientist',
      description:
        'Runs and interprets the laboratory tests doctors diagnose from, in hospitals and public health laboratories.',
      code: 'IRS',
      salary: [25_000, 45_000],
      outlook: HIGH_DEMAND,
    }),
  },
  {
    score: 88.4,
    career: career({
      id: 'tour-demo-career-architect',
      title: 'Architect',
      description:
        'Plans buildings and the spaces between them, balancing how they will be used against what they cost to build.',
      code: 'AIR',
      salary: [30_000, 60_000],
      outlook: EMERGING,
    }),
  },
  {
    score: 85.7,
    career: career({
      id: 'tour-demo-career-psychologist',
      title: 'Psychologist',
      description:
        'Studies how people think and behave, and works with them directly in schools, clinics and workplaces.',
      code: 'SIA',
      salary: [28_000, 55_000],
      outlook: HIGH_DEMAND,
    }),
  },
  {
    score: 81.3,
    career: career({
      id: 'tour-demo-career-data-analyst',
      title: 'Data Analyst',
      description:
        'Turns the records an organisation already keeps into the numbers it makes its decisions from.',
      code: 'ICE',
      salary: [30_000, 62_000],
      outlook: EMERGING,
    }),
  },
];

function program(options: {
  id: string;
  code: string;
  name: string;
  department: string;
  college: College;
}): Program {
  return {
    id: options.id,
    college_id: options.college.id,
    code: options.code,
    name: options.name,
    department_name: options.department,
    description: null,
    recommended_strand: 'Academic',
    status: 'active',
    program_catalog_id: null,
    created_at: null,
    updated_at: null,
  };
}

const PROGRAMS: { program: Program; college: College; score: number; bestCareer: string }[] = [
  {
    score: 92.5,
    bestCareer: 'Software Developer',
    college: BISU_MAIN,
    program: program({
      id: 'tour-demo-program-cs',
      code: 'BSCS',
      name: 'BS Computer Science',
      department: 'College of Technology and Allied Sciences',
      college: BISU_MAIN,
    }),
  },
  {
    score: 89.8,
    bestCareer: 'Medical Laboratory Scientist',
    college: HNU,
    program: program({
      id: 'tour-demo-program-medtech',
      code: 'BSMLS',
      name: 'BS Medical Laboratory Science',
      department: 'College of Health Sciences',
      college: HNU,
    }),
  },
  {
    score: 86.1,
    bestCareer: 'Architect',
    college: BISU_MAIN,
    program: program({
      id: 'tour-demo-program-architecture',
      code: 'BSARCH',
      name: 'BS Architecture',
      department: 'College of Engineering and Architecture',
      college: BISU_MAIN,
    }),
  },
  {
    score: 83.4,
    bestCareer: 'Psychologist',
    college: UB,
    program: program({
      id: 'tour-demo-program-psychology',
      code: 'BSPSY',
      name: 'BS Psychology',
      department: 'College of Arts and Sciences',
      college: UB,
    }),
  },
  {
    score: 80.2,
    bestCareer: 'Medical Laboratory Scientist',
    college: BISU_BILAR,
    program: program({
      id: 'tour-demo-program-biology',
      code: 'BSBIO',
      name: 'BS Biology',
      department: 'College of Arts and Sciences',
      college: BISU_BILAR,
    }),
  },
];

/**
 * The finished student, built fresh so the dates on the cards are always recent.
 *
 * Called once per tour, by the overlay. Nothing else should import this module — see the note in
 * `demoMode.ts` about keeping it out of the student route's static bundle.
 */
export function demoStudent(): TourDemo {
  const finishedAt = daysAgo(3);

  const riasec: AssessmentResult = {
    attempt_id: RIASEC_ATTEMPT,
    submitted_at: finishedAt,
    assessment: { title: 'RIASEC Interest Inventory', category: 'RIASEC' },
    result: { result_code: 'IAS', overall_summary: null, generated_at: finishedAt },
    dimensions: RIASEC_DIMENSIONS,
  };

  const scct: AssessmentResult = {
    attempt_id: SCCT_ATTEMPT,
    submitted_at: finishedAt,
    assessment: { title: 'SCCT Career Confidence Scale', category: 'SCCT' },
    result: {
      result_code: null,
      overall_summary: 'High Career Confidence.',
      generated_at: finishedAt,
    },
    dimensions: SCCT_DIMENSIONS,
  };

  return {
    assignments: [assignment(riasec, 60, 20), assignment(scct, 30, 15)],
    results: [riasec, scct],
    reports: [
      report(riasec, { questionCount: 60, weights: null }),
      report(scct, { questionCount: 30, weights: { SE: 0.4, OE: 0.3, GO: 0.3 } }),
    ],
    recommendations: {
      assessment_result_id: RIASEC_ATTEMPT,
      generated_at: finishedAt,
      careers: CAREERS.map(
        ({ career: entry, score }, index): CareerRecommendation => ({
          id: `tour-demo-rec-${entry.id}`,
          match_type: 'CAREER',
          match_score: score,
          ranking: index + 1,
          reason: `${SIGNALS} align with ${entry.title}'s typical profile (${entry.typical_riasec_code}).`,
          created_at: finishedAt,
          career: entry,
        }),
      ),
      programs: PROGRAMS.map(
        ({ program: entry, college: school, score, bestCareer }, index): ProgramRecommendation => ({
          id: `tour-demo-rec-${entry.id}`,
          match_type: 'PROGRAM',
          match_score: score,
          ranking: index + 1,
          reason: [
            `${SIGNALS} are the strongest signals in your profile for ${entry.name}.`,
            `Its strongest career match for you is ${bestCareer}.`,
            'Matches your Academic track.',
            ACADEMIC_CLAUSE,
          ].join(' '),
          created_at: finishedAt,
          program: entry,
          college: school,
        }),
      ),
    },
    dashboard: {
      assignments: { active: 2, completed: 2, pending: 0 },
      results_count: 2,
      recommendations_ready: true,
      // Nothing on a student screen reads this — the bell has its own query — so it says the
      // honest thing about an example student rather than inventing unread mail for them.
      unread_notifications: 0,
      profile_complete: true,
    },
  };
}

/** The assignment behind a finished result — both of the example student's are scored. */
function assignment(
  result: AssessmentResult,
  questionCount: number,
  minutes: number,
): AssessmentAssignment {
  return {
    id: `tour-demo-assignment-${result.attempt_id}`,
    class_id: 'tour-demo-class',
    status: 'ACTIVE',
    deadline: null,
    created_at: daysAgo(10),
    assessment: {
      version_id: `tour-demo-version-${result.attempt_id}`,
      version_number: 1,
      title: result.assessment?.title ?? 'Assessment',
      category: result.assessment?.category ?? 'CUSTOM',
      description: null,
      duration_minutes: minutes,
      question_count: questionCount,
    },
    my_attempt: {
      id: result.attempt_id,
      status: 'SCORED',
      submitted_at: result.submitted_at,
    },
  };
}

/**
 * The report behind a result — the item count the results card prints beside the date, and the
 * §23 composite weights the SCCT card recomputes its index from.
 *
 * `items` is empty rather than sixty invented questions. The appendix is only ever read from the
 * printable sheet, which is a route the tour does not visit and which nothing under a dimmed
 * screen can reach — and sixty fabricated items would be a lot of bytes for a page nobody opens.
 */
function report(
  result: AssessmentResult,
  instrument: { questionCount: number; weights: Record<string, number> | null },
): AssessmentReport {
  return {
    attempt_id: result.attempt_id,
    submitted_at: result.submitted_at,
    // Spread rather than assigned: `assessment` is an optional field, and under
    // `exactOptionalPropertyTypes` writing `undefined` into one is not the same as omitting it.
    ...(result.assessment === undefined ? {} : { assessment: result.assessment }),
    result: result.result,
    dimensions: result.dimensions,
    instrument: {
      version_number: 1,
      question_count: instrument.questionCount,
      composite_weights: instrument.weights,
    },
    student: {
      name: 'Example student',
      grade_level: 'Grade 12',
      strand: 'Academic',
      username: null,
    },
    class: { name: 'Example class', academic_year: '2026-2027' },
    counselor: null,
    items: [],
  };
}
