import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { assessmentTemplates, type User } from '@/db/schema';
import { RIASEC_DIMENSION_NAMES } from '@/lib/recommendation';
import { AssessmentBuilderService } from '@/modules/assessment/assessment-builder-service';

/**
 * The two globally-curated instruments (FULLPLAN §22, §23, §57).
 *
 * **They are built and published through the real `AssessmentBuilderService`** — never by writing
 * `status = 'PUBLISHED'` into a row. That is the whole point of doing it this way: a seeder that
 * inserted the published state directly would appear to prove the confirmation gate works while
 * quietly demonstrating how to walk around it, and it is the *seeder* that a future AI-generation
 * feature would be most tempted to imitate. This one has to pass the same gate a counselor does.
 * If a mapping were ever left unconfirmed, seeding would fail loudly rather than shipping an
 * instrument nobody reviewed.
 *
 * Both are `MANUAL` by construction, so their mappings are confirmed at insert time and the gate
 * is satisfied honestly rather than bypassed (§25).
 *
 * **RIASEC and SCCT can never be AI-generated or AI-edited** (§5) — a permanent rule, enforced in
 * `policies/assessment.ts` as the first check. This content is therefore hand-authored, and §57
 * is right that it is the single largest content task in the project.
 */

/** §22: 5-point Likert, Strongly Disagree (1) → Strongly Agree (5). */
const LIKERT = [
  { label: 'Strongly Disagree', value: '1', score: 1, orderNumber: 1 },
  { label: 'Disagree', value: '2', score: 2, orderNumber: 2 },
  { label: 'Neutral', value: '3', score: 3, orderNumber: 3 },
  { label: 'Agree', value: '4', score: 4, orderNumber: 4 },
  { label: 'Strongly Agree', value: '5', score: 5, orderNumber: 5 },
];

/** §22's three-tier banding, verbatim. */
const INTEREST_BANDS = [
  { min: 0, max: 33.99, label: 'Low Interest' },
  { min: 34, max: 66.99, label: 'Moderate Interest' },
  { min: 67, max: 100, label: 'High Interest' },
];

const CONFIDENCE_BANDS = [
  { min: 0, max: 33.99, label: 'Low' },
  { min: 34, max: 66.99, label: 'Moderate' },
  { min: 67, max: 79.99, label: 'Moderately High' },
  { min: 80, max: 100, label: 'High' },
];

/** 10 items per dimension × 6 = 60 (§22). */
const RIASEC_ITEMS: Record<string, string[]> = {
  R: [
    'I enjoy working with tools, machines, or equipment.',
    'I like building or repairing things with my hands.',
    'I would rather work outdoors than in an office.',
    'I am good at operating mechanical or electrical equipment.',
    'I enjoy physical work that keeps me active.',
    'I like figuring out how machines and devices work.',
    'I would enjoy a job that involves driving or operating vehicles.',
    'I prefer practical tasks with a visible result over abstract discussion.',
    'I enjoy working with plants, animals, or the land.',
    'I like assembling things from a set of parts and instructions.',
  ],
  I: [
    'I enjoy solving complex problems and puzzles.',
    'I like conducting experiments to test an idea.',
    'I enjoy analyzing data to find patterns.',
    'I am curious about why things happen the way they do.',
    'I like reading about scientific discoveries.',
    'I enjoy working through a difficult mathematical problem.',
    'I prefer to understand a theory thoroughly before applying it.',
    'I like researching a topic in depth before forming an opinion.',
    'I enjoy figuring out the cause of a problem no one else can explain.',
    'I would enjoy working in a laboratory.',
  ],
  A: [
    'I enjoy expressing myself through art, music, or writing.',
    'I like coming up with original ideas.',
    'I would enjoy designing something no one has made before.',
    'I prefer work that lets me be imaginative rather than follow a routine.',
    'I enjoy performing, acting, or presenting to an audience.',
    'I like taking photographs, drawing, or making videos.',
    'I enjoy writing stories, poems, or essays.',
    'I appreciate good design and notice when something is well made.',
    'I would rather invent a new approach than follow an existing one.',
    'I enjoy playing or composing music.',
  ],
  S: [
    'I enjoy helping other people with their problems.',
    'I like teaching or explaining things to others.',
    'I find it easy to understand how other people feel.',
    'I enjoy working as part of a team.',
    'I would find it rewarding to care for people who are unwell.',
    'I like volunteering for community activities.',
    'People often come to me for advice.',
    'I enjoy meeting new people and making them feel welcome.',
    'I would enjoy a job where I help others learn and grow.',
    'I prefer cooperating with others over competing against them.',
  ],
  E: [
    'I enjoy persuading other people to see things my way.',
    'I like taking the lead on group projects.',
    'I would enjoy starting my own business.',
    'I am comfortable making decisions that affect other people.',
    'I enjoy selling ideas, products, or services.',
    'I like setting ambitious goals and working to reach them.',
    'I am comfortable speaking in front of a group.',
    'I enjoy negotiating to get a good outcome.',
    'I would enjoy managing a team of people.',
    'I am willing to take risks to achieve something worthwhile.',
  ],
  C: [
    'I enjoy organizing information so it is easy to find.',
    'I like following a clear set of procedures.',
    'I am careful and accurate with details.',
    'I enjoy keeping records and tracking numbers.',
    'I prefer work where the expectations are clearly defined.',
    'I like planning my tasks in advance and working to a schedule.',
    'I enjoy working with spreadsheets or databases.',
    'I notice small errors that other people miss.',
    'I would enjoy managing budgets or accounts.',
    'I prefer a well-ordered workplace with established routines.',
  ],
};

/** 10 items per construct × 3 = 30 (§23). */
const SCCT_ITEMS: Record<string, string[]> = {
  // Self-Efficacy — belief in one's ability to succeed in a domain.
  SE: [
    'I am confident I can succeed in the college program I choose.',
    'I believe I can master difficult subjects if I put in the effort.',
    'I can usually work out a solution when I face an academic setback.',
    'I am confident I can meet the demands of a professional career.',
    'I believe I have the skills needed to do well in my chosen field.',
    'I can keep working on a task even when it becomes difficult.',
    'I am confident I could learn a new skill my career required.',
    'I trust my ability to make good decisions about my future.',
    'I believe I can perform well under pressure.',
    'I am confident I can complete a degree even if it takes hard work.',
  ],
  // Outcome Expectations — belief that effort in a domain leads to good outcomes.
  OE: [
    'I believe working hard in school will lead to a good career.',
    'I expect the program I choose will lead to real job opportunities.',
    'I believe my education will improve my quality of life.',
    'I expect that doing well now will open doors for me later.',
    'I believe the effort I put into my studies will be rewarded.',
    'I expect to be able to support myself through the career I choose.',
    'I believe a career in my field of interest is respected by others.',
    'I expect my work will make a positive difference to other people.',
    'I believe the skills I am learning will still be valuable in the future.',
    'I expect to find my future work satisfying.',
  ],
  // Goal Orientation — intent to pursue a domain.
  GO: [
    'I have a clear idea of the career I want to pursue.',
    'I have set specific goals for my education.',
    'I actively look for information about careers that interest me.',
    'I am willing to plan several years ahead to reach my goals.',
    'I intend to enroll in a college program related to my interests.',
    'I regularly think about what I want to achieve in my career.',
    'I am prepared to work toward a goal even without immediate reward.',
    'I have taken concrete steps toward my future career.',
    'I am committed to finishing what I start.',
    'I intend to keep developing my skills after I finish school.',
  ],
};

const RIASEC_TITLE = 'RIASEC Interest Inventory';
const SCCT_TITLE = 'SCCT Career Confidence Scale';

export interface SeededInstruments {
  riasecVersionId: string | null;
  scctVersionId: string | null;
  created: boolean;
}

/**
 * Idempotent: re-running finds the existing templates and changes nothing. It is checked by
 * *title*, because these are the globally-curated instruments and there is exactly one of each —
 * a second "RIASEC Interest Inventory" would be a bug, not a variant.
 */
export async function seedAssessmentInstruments(
  db: Database,
  admin: User,
): Promise<SeededInstruments> {
  const builder = new AssessmentBuilderService(db);

  const existing = await db
    .select()
    .from(assessmentTemplates)
    .where(and(eq(assessmentTemplates.category, 'RIASEC'), isNull(assessmentTemplates.deletedAt)))
    .limit(1);

  if (existing.length > 0) {
    const riasec = existing[0];
    const [scct] = await db
      .select()
      .from(assessmentTemplates)
      .where(and(eq(assessmentTemplates.category, 'SCCT'), isNull(assessmentTemplates.deletedAt)))
      .limit(1);

    const riasecVersion = riasec === undefined ? undefined : await builder.assignableVersion(riasec.id);
    const scctVersion = scct === undefined ? undefined : await builder.assignableVersion(scct.id);

    return {
      riasecVersionId: riasecVersion?.id ?? null,
      scctVersionId: scctVersion?.id ?? null,
      created: false,
    };
  }

  const riasecVersionId = await seedRiasec(builder, admin);
  const scctVersionId = await seedScct(builder, admin);

  return { riasecVersionId, scctVersionId, created: true };
}

async function seedRiasec(builder: AssessmentBuilderService, admin: User): Promise<string> {
  const template = await builder.createTemplate(admin, {
    category: 'RIASEC',
    title: RIASEC_TITLE,
    description:
      "Holland's six vocational interest types. Your three strongest types form your Holland Code.",
    ownership: 'GLOBAL',
  });

  // `order_number` is **scoring data**: it is the R > I > A > S > E > C tie-break for the Holland
  // Code (§22). The names come from `lib/recommendation.ts` so that the dimension a student is
  // shown and the dimension named in a §27 reason string cannot drift apart.
  await builder.addDimensions(
    template.id,
    Object.entries(RIASEC_DIMENSION_NAMES).map(([code, name], index) => ({
      code,
      name,
      description: `${name} interests (${code}).`,
      interpretationRanges: INTEREST_BANDS,
      orderNumber: index + 1,
    })),
  );

  const version = await builder.createVersion(admin, template.id, {
    instructions:
      'Rate how much each statement sounds like you. There are no right or wrong answers — answer honestly rather than how you think you should.',
    durationMinutes: 15,
    scoringConfig: { algorithm: 'HOLLAND_CODE_TOP3' },
  });

  let orderNumber = 1;

  await builder.addQuestions(
    admin,
    version.id,
    Object.entries(RIASEC_ITEMS).flatMap(([code, items]) =>
      items.map((questionText) => ({
        questionText,
        questionType: 'LIKERT' as const,
        // The section label groups sixty items into legible chunks. It is a deliberate, limited
        // disclosure — it never reveals what any *single* item scores (§37).
        sectionLabel: RIASEC_DIMENSION_NAMES[code as keyof typeof RIASEC_DIMENSION_NAMES],
        orderNumber: orderNumber++,
        required: true,
        options: LIKERT,
        dimensions: [{ code, weight: 1 }],
      })),
    ),
  );

  // Through the real gate. If any mapping were unconfirmed, this throws and seeding fails loudly.
  const published = await builder.publish(admin, version.id);

  return published.id;
}

async function seedScct(builder: AssessmentBuilderService, admin: User): Promise<string> {
  const template = await builder.createTemplate(admin, {
    category: 'SCCT',
    title: SCCT_TITLE,
    description:
      'Social Cognitive Career Theory: self-efficacy, outcome expectations, and goal orientation.',
    ownership: 'GLOBAL',
  });

  await builder.addDimensions(template.id, [
    {
      code: 'SE',
      name: 'Self-Efficacy',
      description: 'Belief in your ability to succeed in a domain.',
      interpretationRanges: INTEREST_BANDS,
      orderNumber: 1,
    },
    {
      code: 'OE',
      name: 'Outcome Expectations',
      description: 'Belief that effort in a domain leads to good outcomes.',
      interpretationRanges: INTEREST_BANDS,
      orderNumber: 2,
    },
    {
      code: 'GO',
      name: 'Goal Orientation',
      description: 'Your intent to pursue a domain.',
      interpretationRanges: INTEREST_BANDS,
      orderNumber: 3,
    },
  ]);

  const version = await builder.createVersion(admin, template.id, {
    instructions:
      'Rate how strongly you agree with each statement about your confidence, expectations, and goals.',
    durationMinutes: 10,
    // §23's weights. They live on the *version* rather than in the scorer, which is what makes
    // §24 "one engine with two configurations" true rather than aspirational.
    scoringConfig: {
      algorithm: 'WEIGHTED_COMPOSITE',
      composite_weights: { SE: 0.4, OE: 0.3, GO: 0.3 },
      composite_ranges: CONFIDENCE_BANDS,
    },
  });

  let orderNumber = 1;

  const sectionNames: Record<string, string> = {
    SE: 'Self-Efficacy',
    OE: 'Outcome Expectations',
    GO: 'Goal Orientation',
  };

  await builder.addQuestions(
    admin,
    version.id,
    Object.entries(SCCT_ITEMS).flatMap(([code, items]) =>
      items.map((questionText) => ({
        questionText,
        questionType: 'LIKERT' as const,
        sectionLabel: sectionNames[code] ?? code,
        orderNumber: orderNumber++,
        required: true,
        options: LIKERT,
        dimensions: [{ code, weight: 1 }],
      })),
    ),
  );

  const published = await builder.publish(admin, version.id);

  return published.id;
}
