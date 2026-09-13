import { DECISION_GUIDANCE } from '@/knowledge/guidance-decisions';
import { PROGRAM_GUIDANCE } from '@/knowledge/guidance-programs';
import { RESULTS_GUIDANCE } from '@/knowledge/guidance-topics';

/**
 * **The Guidance corpus** — the school's general knowledge, written once and retrieved per turn
 * (AI-COVERAGE-PLAN.md Phase 3, 2026-09-13).
 *
 * ## Why it exists
 *
 * On 2026-09-12 the production corpus held 256 auto-generated catalog passages and two real Q&A
 * entries. Catalog passages say what a career pays and where a program is taught; nothing said what
 * *Investigative* means, how a match score is built, what a strand does to a score, which programs
 * have a board exam, or what to do when a first choice is out of reach. Those are the questions a
 * counselor answers every day, they are the same for every student, and they are the cheapest
 * knowledge in the system to write once.
 *
 * ## How it reaches the index
 *
 * A TypeScript module rather than `.md` files, because a Worker cannot read files at runtime and a
 * text-module import would need a `[[rules]]` entry in every wrangler config (the same trade the
 * prompt files made). `syncGuidanceKnowledge` writes each entry as a knowledge document with
 * `entity_type = 'guide'` and the slug as its id, re-embedding only when the text here changes.
 *
 * Admins see these on the knowledge screen. An admin's edit is kept until the text here changes —
 * the catalog-sync rule, via `content_hash` — and an admin's archive is permanent.
 *
 * ## Review before it ships
 *
 * These passages are cited to students as the school's own guidance. They were drafted for the
 * Bohol catalog and deliberately avoid figures that change (fees, dates, cut-offs); a counselor
 * should still read every one before it is synced to production.
 */

export interface GuidanceEntry {
  /** Stable id — the knowledge document's `entity_id`. Never rename one that has shipped. */
  slug: string;
  title: string;
  body: string;
}

/** An admin-style Q&A pair: Gate 1 returns the answer verbatim when a student asks exactly this. */
export interface GuidanceQa {
  slug: string;
  question: string;
  answer: string;
}

export const GUIDANCE_ENTRIES: GuidanceEntry[] = [
  ...RESULTS_GUIDANCE,
  ...PROGRAM_GUIDANCE,
  ...DECISION_GUIDANCE,
];

/**
 * The prose questions students actually repeat, answered verbatim by Gate 1 at zero cost.
 *
 * Gate 1 matches after normalisation only (case, punctuation and spacing), so a few common
 * phrasings of the same question are listed separately. Questions Gate 2 answers from data —
 * "what's my top program", "where is HNU" — are deliberately not here.
 */
export const GUIDANCE_QA: GuidanceQa[] = [
  ...[
    'How much is the tuition fee?',
    'How much is tuition?',
    'How much is the tuition?',
    'Magkano ang tuition?',
  ].map((question, index) => ({
    slug: `qa-tuition-${index + 1}`,
    question,
    answer:
      'CareerLinkAI does not hold tuition figures, because they differ by college and change every year. In general, eligible students pay no tuition for a first bachelor’s degree at Bohol Island State University and at CHED-recognised local colleges, while private colleges charge tuition but often offer scholarships. Ask your guidance counselor or the college’s admissions or accounting office for the current fees.',
  })),
  {
    slug: 'qa-nursing-stressful',
    question: 'Is nursing a stressful job?',
    answer:
      'Nursing can be demanding: nurses work long shifts, including nights and holidays, and are responsible for patients who may be very ill. Many nurses also find it deeply meaningful. It tends to suit people with strong Social interests who stay calm under pressure. If you are considering it, ask the assistant why Registered Nurse is or isn’t on your list, and talk with a nurse or your guidance counselor about what the work is really like.',
  },
  ...[
    'What are the requirements for college?',
    'What are the requirements for college admission?',
    'What are the requirements for enrollment?',
  ].map((question, index) => ({
    slug: `qa-requirements-${index + 1}`,
    question,
    answer:
      'Most colleges ask for an application form, your Grade 11 and Grade 12 report cards (Form 138), a certificate of good moral character, a birth certificate and ID photos, and many give an entrance test. Some programs add an interview or a medical check. Each college sets its own list and dates, so check its official announcements and ask your guidance counselor for the current requirements.',
  })),
  ...['Can I get a scholarship?', 'What scholarships are available?'].map(
    (question, index) => ({
      slug: `qa-scholarship-${index + 1}`,
      question,
      answer:
        'Scholarships to ask about include DOST-SEI scholarships for science, technology, engineering and math programs, CHED scholarships and grants, scholarships from your provincial or town government, and the colleges’ own scholarships. Most look at grades and family income and open during Grade 12. Your guidance counselor has the current list and deadlines.',
    }),
  ),
  ...['Can you choose for me?', 'Which one should I choose?', 'What should I choose?'].map(
    (question, index) => ({
      slug: `qa-choose-${index + 1}`,
      question,
      answer:
        'I can’t make the choice for you — it’s yours. What I can do is show you the trade-offs: ask me why a career or program is on your list, what careers a program leads to, or which colleges offer it near you. Your guidance counselor can help you weigh them.',
    }),
  ),
  {
    slug: 'qa-entrance-exam',
    question: 'Do I need to take an entrance exam?',
    answer:
      'Most colleges, including the state university, give an entrance or admission test, and some programs add an interview or a medical check. Each college sets its own. Check the college’s official announcements and ask your guidance counselor for the schedule.',
  },
  {
    slug: 'qa-improve-confidence',
    question: 'How can I improve my career confidence?',
    answer:
      'Confidence grows from experience. Try small steps in the field — a club, a short course, a project or job shadowing — and notice what you succeed at. Watching someone like you succeed, encouragement from teachers and family, and practice in the subjects the field needs all help. Your SCCT scores are a snapshot, not a limit.',
  },
  {
    slug: 'qa-shift-program',
    question: 'Can I shift to another program?',
    answer:
      'Many colleges let students shift programs, usually after the first semester or year and subject to grades and available slots. Some subjects may not credit to the new program. Ask the college’s registrar about its shifting policy before you enrol.',
  },
  {
    slug: 'qa-strand-matter',
    question: 'Does my strand matter?',
    answer:
      'Your strand counts for 15% of each program score: 100 when it matches the program’s recommended strand, 40 when it doesn’t, and 70 when it is unknown. A mismatch is advice, not a bar — colleges generally admit students from any senior high school track, though some ask for bridging subjects.',
  },
];
