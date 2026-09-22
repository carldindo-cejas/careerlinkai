import type { GuidanceEntry } from '@/knowledge/guidance';
import { DEFAULT_FORMULA, type ScoringFormula } from '@/lib/scoring-formula';

/**
 * Guidance about the student's own results: how the score is built, what RIASEC and SCCT mean, and
 * how strands are treated (AI-COVERAGE-PLAN.md Phase 3, topics 1–4).
 *
 * Every entry is one retrievable passage — kept under the chunker's ~1,680-character ceiling so a
 * topic is never split across two chunks.
 *
 * ## The scoring passage is generated, not written (2026-09-21)
 *
 * It used to state the weights as literal text, with a comment asking whoever edited
 * `lib/recommendation.ts` to remember to edit it too, and a test pinning the two together. That
 * arrangement stopped being possible the moment an **administrator** could re-weight the formula:
 * there is no deploy to remember anything during, and a passage cited to a student as the school's
 * own guidance would have gone on quoting 60% at a deployment scoring on 45%.
 *
 * So `scoringGuide` takes the formula and writes the sentence. `syncGuidanceKnowledge` passes the
 * stored one, and a saved formula asks for a re-sync (`PUT /admin/recommendation-formula`), so the
 * indexed passage follows the arithmetic rather than trailing it.
 */

/** A weight as a percentage, with a decimal only where one is needed: `0.6` → `60%`. */
function percent(weight: number): string {
  return `${Math.round(weight * 1000) / 10}%`;
}

/** A 0–100 neutral value as it reads in a sentence — `70`, not `70.0`. */
function point(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * How a match score is built, in this deployment's own weights.
 *
 * The prose around the numbers is fixed, and deliberately so: it explains *what each component
 * means* and why a program can rank differently from the careers it leads to, and neither of those
 * changes when the weights do.
 */
export function scoringGuide(formula: ScoringFormula = DEFAULT_FORMULA): GuidanceEntry {
  return {
    slug: 'how-match-scores-work',
    title: 'Guide: How your match score is built',
    body: `How CareerLinkAI builds a match score. Every score on your recommendations page is arithmetic, not an AI opinion, and the same answers always give the same score.
A career match adds up three parts: how well your RIASEC interests fit the career's typical interest code (${percent(formula.career.riasecCompatibility)}), your SCCT career confidence (${percent(formula.career.careerConfidence)}), and a fixed preference term (${percent(formula.career.studentPreference)}) that is the same for everyone.
A program match adds up five parts: RIASEC fit averaged over all the careers the program leads to (${percent(formula.program.riasecCompatibility)}), career alignment with your own recommended careers (${percent(formula.program.careerAlignment)}), SCCT career confidence (${percent(formula.program.careerConfidence)}), academic fit from your Math, Science and English grades (${percent(formula.program.academicFit)}), and strand alignment (${percent(formula.program.strandAlignment)}).
Career alignment is the part that ties the two lists together: it scores the best careers a program leads to on exactly the same scale as your career list, so a program that leads to your top careers is pulled up even when its strand or its other careers do not suit you.
That is why a program can still rank differently from the careers it leads to: your grades and your strand add points that interests alone do not. It is also why two programs with the same name rank the same at different colleges.
A blank field is never a penalty. With no grades, academic fit counts as a neutral ${point(formula.neutrals.academicUnknown)}. With no strand, strand alignment counts as ${point(formula.neutrals.strandUnknown)}. Filling in your profile makes the program scores more precise.`,
  };
}

/** Every results entry but the scoring one, which is generated per formula above. */
const FIXED_RESULTS_GUIDANCE: GuidanceEntry[] = [
  {
    slug: 'riasec-overview',
    title: 'Guide: What RIASEC and your Holland code mean',
    body: `RIASEC is John Holland's model of six interest types: Realistic, Investigative, Artistic, Social, Enterprising and Conventional. The RIASEC assessment measures how much each type sounds like you, as a score from 0 to 100 with a band from Very Low to Very High.
Your Holland code is your three highest types, strongest first — for example CEI means Conventional, then Enterprising, then Investigative. Careers have codes too, and a career fits you best when its first letter is one of your strongest types.
The code describes what you enjoy, not what you are able to do. A low score in a type does not mean you would fail at that work; it means those activities appeal to you less right now. Interests can change as you try new things.
Use your code as a starting point for exploring careers, and look at your top two or three types together rather than only the first.`,
  },
  {
    slug: 'riasec-realistic',
    title: 'Guide: The Realistic type (R)',
    body: `Realistic (R) people like hands-on, practical work with tools, machines, plants, animals or the outdoors. They prefer doing and building to talking about ideas, and they like seeing a concrete result.
Typical activities: fixing and assembling things, operating equipment, farming, working on ships, building structures, working outdoors, physical and technical tasks.
Careers in this catalog that start with R include Civil Engineer, Electrical Engineer, Mechanical Engineer, Marine Engineer, Deck Officer, Agricultural and Biosystems Engineer, Agriculturist, Forester, Farm Operations Manager, Electronics Technician, Maintenance Engineer, Power Plant Engineer, Police Officer, Fire Officer and Registered Criminologist.
Programs that lead there include the engineering programs, BS Marine Engineering, BS Marine Transportation, BS Agriculture, BS Forestry, BS Industrial Technology and BS Criminology.`,
  },
  {
    slug: 'riasec-investigative',
    title: 'Guide: The Investigative type (I)',
    body: `Investigative (I) people like to observe, analyse and solve problems. They are curious, enjoy science and mathematics, and like understanding how and why things work before acting.
Typical activities: experiments, research, working with data, diagnosing problems, programming, reading and reasoning through complex questions.
Careers in this catalog that start with I include Software Developer, Data Scientist, Data Analyst, Computer Engineer, Cybersecurity Analyst, Environmental Scientist, Marine Biologist, Food Technologist, Pharmacist, Clinical Psychologist, Psychometrician, Clinical Researcher, Crime Scene Investigator and Legal Researcher.
Programs that lead there include BS Computer Science, BS Computer Engineering, BS Environmental Science, BS Marine Biology, BS Food Technology, BS Pharmacy and BS Psychology.`,
  },
  {
    slug: 'riasec-artistic',
    title: 'Guide: The Artistic type (A)',
    body: `Artistic (A) people like to create, design and express ideas. They value originality, enjoy unstructured work, and like writing, drawing, music, performance or visual design.
Typical activities: designing, drawing, writing, editing, making media, planning spaces and products, communicating ideas to an audience.
Careers in this catalog that start with A include Architect, Interior Designer, Industrial Designer, Graphic Designer, Multimedia Artist, UI/UX Designer, Journalist, Content Writer and Editor, Communications Officer and Curriculum Developer.
Programs that lead there include BS Architecture, BS Industrial Design and AB English Language. An Artistic student can also do well in programs whose careers mix creativity with another type, such as Architect (AIR) or UI/UX Designer (AIE).`,
  },
  {
    slug: 'riasec-social',
    title: 'Guide: The Social type (S)',
    body: `Social (S) people like helping, teaching, caring for and working with people. They are patient, good listeners, and find meaning in making a difference in someone's life.
Typical activities: teaching, nursing, counselling, coaching, community work, explaining things and supporting others.
Careers in this catalog that start with S include Elementary School Teacher, Secondary School Teacher, Physical Education Teacher, Guidance Counselor, School Administrator, Registered Nurse, Public Health Nurse, Nurse Administrator, Midwife, Physical Therapist, Public Health Officer, Sports Rehabilitation Specialist, Athletic Coach and Human Resources Specialist.
Programs that lead there include Bachelor of Elementary Education, Bachelor of Secondary Education, Bachelor of Physical Education, BS Nursing, BS Midwifery, BS Physical Therapy and BS Psychology.`,
  },
  {
    slug: 'riasec-enterprising',
    title: 'Guide: The Enterprising type (E)',
    body: `Enterprising (E) people like to lead, persuade, sell and start things. They are energetic, confident with people, and enjoy taking risks to reach a goal.
Typical activities: managing projects and teams, selling, negotiating, running a business, organising events, public speaking and making decisions.
Careers in this catalog that start with E include Entrepreneur, Operations Manager, Business Development Specialist, Marketing Specialist, Events Manager, Hotel Operations Manager, Tour Operations Manager, Tourism Officer, Public Administration Officer, Construction Project Manager, Port Operations Supervisor, Medical Sales Representative and Lawyer.
Programs that lead there include BS Business Administration, BS Entrepreneurship, BS Hospitality Management, BS Tourism Management, Bachelor of Public Administration, AB Political Science and Juris Doctor.`,
  },
  {
    slug: 'riasec-conventional',
    title: 'Guide: The Conventional type (C)',
    body: `Conventional (C) people like order, accuracy and clear procedures. They are organised, careful with details, and comfortable with numbers, records and systems.
Typical activities: bookkeeping and accounting, keeping records, checking for errors, organising data, following and improving procedures, office administration.
Careers in this catalog that start with C include Certified Public Accountant, Financial Analyst, Internal Auditor, Tax Advisory Specialist, Business Systems Analyst, Database Administrator, Systems Administrator, IT Support Specialist, Quality Assurance Engineer, Quantity Surveyor, Supply Chain Analyst, Bank Operations Officer, Office Administrator, Executive Assistant and Regulatory Affairs Specialist.
Programs that lead there include BS Accountancy, BS Accounting Information Systems, BS Information Systems, BS Information Technology, BS Office Administration and BS Business Administration.`,
  },
];

/**
 * What SCCT measures, and how loudly it counts — the two percentages are the live composite
 * weights, for the same reason `scoringGuide`'s are.
 */
export function scctGuide(formula: ScoringFormula = DEFAULT_FORMULA): GuidanceEntry {
  return {
    slug: 'scct-overview',
    title: 'Guide: What SCCT career confidence means',
    body: `SCCT is Social Cognitive Career Theory. The SCCT assessment measures three beliefs that research links to career choices: Self-Efficacy (believing you can succeed at the tasks a career needs), Outcome Expectations (believing that effort will lead to good results), and Goal Orientation (intending to pursue a career goal).
Each is scored from 0 to 100, and together they make your career confidence index, banded from Very Low to Very High. The index counts for ${percent(formula.career.careerConfidence)} of every career match and ${percent(formula.program.careerConfidence)} of every program match.
A low score is not a verdict on your ability. Confidence grows from experience: trying a subject or activity and succeeding at small steps, watching someone like you succeed, encouragement from teachers and family, and learning to manage worry. Joining a club, a short course, job shadowing or talking with someone who works in the field are practical ways to build it.
If your interests are high but your confidence is low for a field, that is worth discussing with your guidance counselor.`,
  };
}

/**
 * What a strand does to a program score.
 *
 * Four of this passage's numbers are configurable and all four are stated — including the mismatch
 * penalty, which is the one a student is most likely to want to argue with, and which they cannot
 * argue with if they are not told what it is.
 */
export function strandGuide(formula: ScoringFormula = DEFAULT_FORMULA): GuidanceEntry {
  return {
    slug: 'strands-and-programs',
    title: 'Guide: Senior high school strands and college programs',
    body: `CareerLinkAI records your senior high school strand as Academic or Technical-Professional, matching the two tracks of the strengthened senior high school curriculum. Some college programs list a recommended strand.
How it affects a program score: strand alignment is ${point(formula.neutrals.strandAligned)} when your strand matches the program's recommended strand, ${point(formula.neutrals.strandMismatch)} when it does not, and ${point(formula.neutrals.strandUnknown)} when your strand or the program's is unknown. A program with no recommended strand counts as aligned. Strand alignment is ${percent(formula.program.strandAlignment)} of a program score.
A mismatch is advice, not a bar. Colleges generally admit students from any senior high school track, although some may ask for bridging subjects or look closely at your grades in Math and Science for technical programs.
If a program you want does not match your strand, ask your guidance counselor and the college's admissions office what they require. Update your strand on your profile if it is wrong, then rebuild your recommendations.`,
  };
}

/**
 * The results topics, in their shipped order, written against one formula.
 *
 * Three of the ten passages state numbers the engine multiplies by; the other seven describe the
 * RIASEC types and never change. Order is fixed because `guidanceDocuments()` syncs in a stable
 * order and a reshuffle would rewrite rows that did not change.
 */
export function resultsGuidance(formula: ScoringFormula = DEFAULT_FORMULA): GuidanceEntry[] {
  return [scoringGuide(formula), ...FIXED_RESULTS_GUIDANCE, scctGuide(formula), strandGuide(formula)];
}

/**
 * The corpus as the **shipped** formula writes it.
 *
 * Kept for the callers that mean "what this release says" rather than "what this deployment is
 * configured to say" — the corpus test, and anything reading the entries without a database.
 */
export const RESULTS_GUIDANCE: GuidanceEntry[] = resultsGuidance();
