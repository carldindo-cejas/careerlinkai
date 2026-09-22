import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import type { KnowledgeEntityType } from '@/db/enums';
import {
  careers,
  colleges,
  employmentOutlooks,
  programCareerLinks,
  programCatalog,
  programs,
  towns,
} from '@/db/schema';
import type { CatalogGap, VagueCareerTerm } from '@/knowledge/catalog-vocabulary';
import { institutionName } from '@/lib/aliases';
import { normaliseQuestion } from '@/lib/grounding';
import { DEFAULT_FORMULA, type ScoringFormula } from '@/lib/scoring-formula';
import { FormulaService } from '@/modules/recommendation/formula-service';
import {
  allMatches,
  bestMatch,
  careerForms,
  catalogGapFor,
  collegesIn,
  loadCatalogIndex,
  matchColleges,
  matchPlace,
  programForms,
  unknownPlaceIn,
  vagueTermFor,
  type CareerEntry,
  type CatalogIndex,
  type CollegeEntry,
  type PlaceEntry,
  type ProgramEntry,
} from '@/modules/ai/catalog-index';
import {
  RecommendationService,
  type CareerRecommendation,
  type ProgramRecommendation,
  type RecommendationSet,
} from '@/modules/recommendation/recommendation-service';
import {
  componentsProse,
  formatScore,
  type StudentBrief,
} from '@/modules/recommendation/student-brief-service';

/**
 * **Gate 2 — questions the student's own results and the catalog answer exactly**
 * (AI-COVERAGE-PLAN.md Phase 2; first cut 2026-09-13).
 *
 * Found on production with a real student: *"why certified public accountant?"* and *"Where to
 * study my first top program recommendation"* were answered correctly by the model and then thrown
 * away, and one discarded reply paired a college with the wrong score. Both were lookups, not
 * writing. So are most of what students ask: where a college is, which colleges offer a program,
 * what a program leads to, what a career pays, what their own Holland code is.
 *
 * Answered here, from rows, with no model call: zero neurons, complete lists (all seven colleges
 * that offer BSCS, not the six most similar passages), and no way to put a number next to the wrong
 * name.
 *
 * ## A resolver, not a classifier
 *
 * It answers only when it binds a question to an intent it recognises **and** to the entity that
 * intent needs. Anything less returns null and the turn goes to retrieval and generation. A missed
 * lookup costs a model call; a wrong one would cost a student a false answer, so every pattern here
 * errs towards returning null.
 *
 * ## Follow-ups
 *
 * *"share map location"* after an answer about Holy Name names nothing. When a question has an
 * intent but no entity, the entity is looked for in the last student message, then the last
 * answer — the transcript the turn already loaded, so this costs nothing extra.
 */

export interface ResultsAnswer {
  text: string;
  /** What to name under the answer. */
  sources: string[];
}

/** An entity the question is about, for scoping retrieval when Gate 2 does not answer. */
export interface EntityBinding {
  entity: { type: KnowledgeEntityType; id: string } | null;
  /** The name, for prefixing a follow-up's retrieval query. */
  name: string;
  /** True when the entity came from the transcript rather than the question itself. */
  fromHistory: boolean;
}

export interface HistoryMessage {
  role: string;
  content: string;
}

type Kind = 'CAREER' | 'PROGRAM';

type Target =
  | { kind: 'CAREER'; rec: CareerRecommendation | null; careerId: string; title: string }
  | {
      kind: 'PROGRAM';
      rec: ProgramRecommendation | null;
      programCatalogId: string | null;
      /** The offering, when the target came from the student's own list. */
      programId: string | null;
      title: string;
    };

/** What one piece of text names. */
interface Mentions {
  setCareer: CareerRecommendation | null;
  setProgram: ProgramRecommendation | null;
  career: CareerEntry | null;
  careers: CareerEntry[];
  program: ProgramEntry | null;
  colleges: CollegeEntry[];
  place: PlaceEntry | null;
}

const CATALOG = ['College catalog'];
const RESULTS = ['Your results'];

// --- intent patterns (on normalised text: lower case, punctuation removed) --------------------

const CAPABILITIES =
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening))$|\b(?:what can you do|what do you know|who are you|what are you|what can i ask|how can you help|are you (?:up|there|online|working|awake)|help me use)\b/;
const WHY = /\b(?:why|how come|explain|reason)\b/;
const MY_HOLLAND =
  /\b(?:holland code|my code|riasec code|my riasec type|my personality type|my interest type)\b/;
const MY_SCORES =
  /\bmy (?:riasec |interest |scct |confidence |assessment )?scores?\b|\bwhat did i (?:get|score)\b/;
// Only a question that *asks for* the top entries — "what's my top 1 program", "show my top
// careers", or the bare phrase on its own. "Will I get into my top match?" and "when does enrolment
// open for my top program?" merely mention one and must reach the model.
const MY_TOP =
  /\b(?:what(?: is| s| are)?|whats|which is|which are|show(?: me)?|give me|tell me|list) my (?:top|best|first|1st|number one|highest)\b|^(?:my )?top (?:\d+ |one |two |three |five )?(?:career|careers|program|programs|course|courses)$/;
const PAYS_BEST =
  /\b(?:pays?|paid|salary|salaries|earn|earns|income|highest paying|sweldo|sahod)\b/;
const TUITION = /\b(?:tuition|fee|fees|matrikula|cost to study|scholarship)\b/;
const SALARY =
  /\b(?:salary|salaries|pay|pays|paid|earn|earns|income|sweldo|sahod|how much (?:does|do|can|will))\b/;
const OUTLOOK = /\b(?:outlook|demand|in demand|job market|hiring|job opportunities)\b/;
const DESCRIBE =
  /\bwhat (?:does|do) (?:an? )?.+ do\b|^what is (?:an? )?[a-z ]+$|^what s (?:an? )?[a-z ]+$/;
const COMPARE = /\b(?:vs|versus|compare|compared|comparison|difference between|better|or)\b/;
const CAREERS_AFTER =
  /\b(?:careers?|jobs?|work|become|profession)\b.*\b(?:after|from|with|graduates? of|finish(?:ing)?|take|taking)\b|\bwhat can i (?:become|be|do|work as)\b|\bwhere can .* work\b/;
const PROGRAMS_FOR =
  /\b(?:programs?|courses?|degrees?)\b.*\b(?:for|to become|to be|leads? to|become)\b|\bwhat (?:should i|to|do i) (?:take|study)\b/;
/**
 * The route to a career asked without the word "program" — "how do I become a CPA", "I want to be
 * a nurse", "paano maging pulis", "unsaon pag-accountant" (2026-09-13). "Can I be…" is left out on
 * purpose: that is an eligibility question, and it belongs to the model.
 */
const BECOME =
  /\b(?:how (?:do i|can i|could i|to|would i|will i|does one|do you) (?:become|be)|(?:want|wanna|plan|planning|hope|hoping|dream|dreaming|aim|aiming) (?:to|of) (?:be|become|being|becoming)|paano (?:ba )?(?:maging|mag)|gusto (?:ko|kong) (?:maging|mahimong|mahimo)|maging|mahimong|unsaon(?: (?:pag|pagka|paghimo|pagkahimong))?)\b/;
const WHERE_IS =
  /\b(?:where is|where s|wheres|location|located|locate|address|map|how (?:do i|to) get to|directions?)\b/;
const PROGRAMS_AT =
  /\b(?:programs?|courses?|degrees?|offer|offers|offered|offering|strands?)\b/;
const WHERE_STUDY =
  /\b(?:where|which (?:school|college|university|schools|colleges|universities)|what (?:school|college|university|schools|colleges|universities)|enrol|enroll|study|offer|offers|offered|take it)\b/;
const COLLEGES_WORD = /\b(?:colleges?|schools?|universit(?:y|ies)|campus(?:es)?)\b/;
const NEAR = /\b(?:near|nearest|closest|close to|around|in)\b/;
/**
 * "What should I choose [at this college]?" — a request to rank, not a request for a list
 * (2026-09-13, from production: *"the top programs are not offered in bisu calape but i want to
 * study there, what should i choose based on my assessment results"* was answered with the campus's
 * program list, which is true and answers nothing).
 */
const CHOOSE =
  /\b(?:what|which)(?: program| course| one| degree)? (?:should i|shall i|do i|to|can i|would you) (?:choose|take|pick|study|enrol|enroll|get|recommend)\b|\bbased on my (?:results?|assessments?|assessment results|scores?|interests?|profile)\b|\b(?:best|good|right) (?:for|fit for) me\b|\b(?:suits?|fits?) me\b|\bmy best (?:option|choice|program|course)\b|\bbest (?:program|course|option|choice) for me\b/;

/**
 * A question that plausibly points back at what was just discussed ("what programs do they offer",
 * "where is it"). Only these inherit a subject from history. Without the check, any question naming
 * nothing borrowed the last subject — "what is the purpose of the career guidance program in senior
 * high school?" was answered with the previous college's program list (production, 2026-09-13).
 */
const REFERS_BACK =
  /\b(?:it|its|there|that|this|they|them|their|the program|the course|the school|the college)\b/;
const PROGRAM_WORDS = /\b(?:program|programs|course|courses|degree|degrees)\b/;
const CAREER_WORDS = /\b(?:career|careers|job|jobs|work|profession)\b/;

/** Rank words, most specific first — "top 2" must not be read as "top". */
const ORDINALS: [RegExp, number][] = [
  [/\b(?:2nd|second|top 2|top two|number 2|number two|no 2)\b/, 2],
  [/\b(?:3rd|third|top 3|number 3|number three|no 3)\b/, 3],
  [/\b(?:4th|fourth|top 4|number 4)\b/, 4],
  [/\b(?:5th|fifth|top 5|number 5)\b/, 5],
  [/\b(?:1st|first|top 1|top one|number 1|number one|no 1|best|top|highest)\b/, 1],
];

/** "top three careers" → 3. Null when no count is given. */
function countOf(asked: string): number | null {
  const match = /\btop (\d|two|three|four|five)\b/.exec(asked);

  if (match === null) return null;

  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

  return words[match[1]!] ?? Number(match[1]);
}

export class ResultsAnswerService {
  private index: Promise<CatalogIndex> | null = null;
  /**
   * The live §27 weights, read at most once per instance (and only once a question has got past
   * the cheap gates above it).
   *
   * They are **read**, not imported, because an administrator can change them (2026-09-21,
   * `FormulaService`). This gate's whole promise is that it answers "why is X on my list" with the
   * arithmetic that actually produced the number; quoting the shipped defaults at a deployment that
   * has re-weighted its formula would make the assistant the most confident liar in the system.
   *
   * One indexed read of a one-row table, per chat turn that reaches a personal answer.
   */
  private formula: Promise<ScoringFormula> | null = null;

  constructor(
    private readonly db: Database,
    private readonly cache?: KVNamespace,
  ) {}

  /**
   * An exact answer, or null when the question is not one this gate can bind with confidence.
   * Never throws: a lookup failure means the question goes to the normal pipeline.
   */
  async answer(
    question: string,
    set: RecommendationSet | null,
    brief: StudentBrief | null = null,
    history: HistoryMessage[] = [],
    /** Needed only to score programs outside the stored top ten ("what should I choose at X"). */
    studentId: string | null = null,
  ): Promise<ResultsAnswer | null> {
    try {
      const asked = normaliseQuestion(question);

      if (asked === '') return null;

      if (CAPABILITIES.test(asked)) return capabilities(brief);

      const personal = personalAnswer(asked, set, brief);

      if (personal !== null) return personal;

      if (TUITION.test(asked)) return null;

      /*
        Read here and not above it: `personalAnswer` never quotes a weight — a question that
        matches `WHY` is explicitly handed on to `catalogAnswer`, which is the only path that
        reaches `whyAnswer`. A turn answered by "what is my Holland code" should not pay a D1 read
        for a formula it will not mention.
      */
      return await this.catalogAnswer(
        asked,
        set,
        history,
        studentId,
        await this.scoringFormula(),
      );
    } catch {
      return null;
    }
  }

  /**
   * The career, program or college an open question is about — for scoping retrieval when this
   * gate does not answer (Phase 5). Null when nothing is named, here or in the last two messages.
   */
  async bindEntity(
    question: string,
    set: RecommendationSet | null,
    history: HistoryMessage[] = [],
  ): Promise<EntityBinding | null> {
    try {
      const index = await this.catalog();
      const asked = normaliseQuestion(question);
      const own = bindingFrom(this.mentions(asked, set, index), false);

      if (own !== null) return own;

      // Only a question that plausibly points back ("it", "there", "that program") inherits.
      if (!REFERS_BACK.test(asked)) return null;

      for (const text of recentTexts(history)) {
        const inherited = bindingFrom(this.mentions(normaliseQuestion(text), set, index), true);

        if (inherited !== null) return inherited;
      }

      return null;
    } catch {
      return null;
    }
  }

  // --- the catalog half -------------------------------------------------------------------

  private catalog(): Promise<CatalogIndex> {
    this.index ??= loadCatalogIndex(this.db, this.cache);

    return this.index;
  }

  /** The stored formula, memoised for the life of this instance — one request. See `formula`. */
  private scoringFormula(): Promise<ScoringFormula> {
    this.formula ??= new FormulaService(this.db).get();

    return this.formula;
  }

  private mentions(
    asked: string,
    set: RecommendationSet | null,
    index: CatalogIndex,
  ): Mentions {
    // The index's forms rather than a fresh `careerForms`: names shared with another entry are gone.
    const indexForms = new Map(index.careers.map((career) => [career.id, career.forms]));
    const setCareer =
      set === null
        ? null
        : bestMatch(
            asked,
            set.careers.map((rec) => ({
              row: rec,
              forms: indexForms.get(rec.career.id) ?? careerForms(rec.career.title),
            })),
          );
    const setProgram =
      set === null
        ? null
        : bestMatch(
            asked,
            set.programs.map((rec) => ({
              row: rec,
              forms: programForms(rec.program.name, rec.program.code),
            })),
          );
    const careerCandidates = index.careers.map((row) => ({ row, forms: row.forms }));

    return {
      setCareer,
      setProgram,
      career: bestMatch(asked, careerCandidates),
      careers: allMatches(asked, careerCandidates),
      program: bestMatch(
        asked,
        index.programs.map((row) => ({ row, forms: row.forms })),
      ),
      colleges: matchColleges(asked, index),
      place: matchPlace(asked, index),
    };
  }

  private async catalogAnswer(
    asked: string,
    set: RecommendationSet | null,
    history: HistoryMessage[],
    studentId: string | null = null,
    formula: ScoringFormula = DEFAULT_FORMULA,
  ): Promise<ResultsAnswer | null> {
    const needsCatalog =
      CHOOSE.test(asked) ||
      WHY.test(asked) ||
      SALARY.test(asked) ||
      OUTLOOK.test(asked) ||
      DESCRIBE.test(asked) ||
      CAREERS_AFTER.test(asked) ||
      PROGRAMS_FOR.test(asked) ||
      BECOME.test(asked) ||
      WHERE_IS.test(asked) ||
      PROGRAMS_AT.test(asked) ||
      WHERE_STUDY.test(asked) ||
      COLLEGES_WORD.test(asked);

    if (!needsCatalog) return null;

    const index = await this.catalog();
    let m = this.mentions(asked, set, index);

    const named =
      m.setCareer !== null ||
      m.setProgram !== null ||
      m.career !== null ||
      m.program !== null ||
      m.colleges.length > 0;

    // 0. Nothing in the catalog is named. It may be a program no college offers ("I want to be a
    //    doctor") or a word that covers several careers ("engineer"). Both come before the
    //    follow-up below, which would otherwise borrow whatever the last message was about.
    if (!named) {
      const gap = catalogGapFor(asked, index);

      if (gap !== null) return this.gapAnswer(gap, index);

      const vague = vagueTermFor(asked);

      if (vague !== null) {
        const answer = await this.vagueAnswer(vague, m.place, index, asked);

        if (answer !== null) return answer;
      }
    }

    // A follow-up: the intent is here, the thing it is about was named a moment ago.
    if (!named && m.place === null && rankOf(asked) === null && REFERS_BACK.test(asked)) {
      for (const text of recentTexts(history)) {
        const earlier = this.mentions(normaliseQuestion(text), set, index);

        if (
          earlier.colleges.length > 0 ||
          earlier.career !== null ||
          earlier.program !== null
        ) {
          m = {
            ...earlier,
            careers: earlier.career === null ? [] : [earlier.career],
            place: m.place,
          };
          break;
        }
      }
    }

    // 1. Why is X on my list.
    if (WHY.test(asked)) {
      const target = targetFor(asked, set, m);

      return target === null ? null : whyAnswer(target, set, formula);
    }

    // 1b. Which program to choose at a named college, or in a named town — ranked for this student.
    if (CHOOSE.test(asked) && (m.colleges.length > 0 || m.place !== null)) {
      const targets = m.colleges.length > 0 ? m.colleges : collegesIn(m.place!, index);

      if (targets.length > 0) {
        const label =
          m.colleges.length === 0
            ? m.place!.label
            : targets.length === 1
              ? targets[0]!.name
              : institutionName(targets[0]!.name);

        return this.bestAt(studentId, targets, set, label);
      }
    }

    // 2. Which of MY programs is near a place.
    if (
      set !== null &&
      /\bmy\b/.test(asked) &&
      m.place !== null &&
      NEAR.test(asked) &&
      m.colleges.length === 0
    ) {
      return this.nearAnswer(set, m.place, index);
    }

    // 3. Career facts: compare two, or one career's salary / outlook / description.
    if (m.careers.length >= 2 && COMPARE.test(asked)) {
      return compareCareers(m.careers.slice(0, 3));
    }

    const factCareer = m.career ?? catalogCareerFor(m.setCareer, index);

    if (factCareer !== null && m.program === null && m.setProgram === null) {
      if (SALARY.test(asked)) return careerFact(factCareer, 'salary');
      if (OUTLOOK.test(asked)) return careerFact(factCareer, 'outlook');
      if (DESCRIBE.test(asked)) return careerFact(factCareer, 'describe');
    }

    // 4. What a program leads to.
    const program = programTarget(m);

    if (program !== null && CAREERS_AFTER.test(asked) && m.career === null) {
      return this.careersAfter(program);
    }

    // 5. Which programs lead to a career, or how to become one.
    const career = careerTarget(m);

    if (
      career !== null &&
      program === null &&
      (PROGRAMS_FOR.test(asked) || BECOME.test(asked))
    ) {
      return this.whereForCareer(career, m.place, index, asked);
    }

    // 6. Where a college is.
    if (m.colleges.length > 0 && WHERE_IS.test(asked) && program === null) {
      return collegeLocations(m.colleges);
    }

    // 7. What a college offers.
    if (
      m.colleges.length > 0 &&
      PROGRAMS_AT.test(asked) &&
      program === null &&
      career === null
    ) {
      return this.programsAt(m.colleges);
    }

    // 8. Where to study a program or for a career.
    if (
      WHERE_STUDY.test(asked) ||
      (COLLEGES_WORD.test(asked) && (program !== null || career !== null))
    ) {
      const target = targetFor(asked, set, m);

      if (target !== null) {
        return target.kind === 'CAREER'
          ? this.whereForCareer(target, m.place, index, asked)
          : this.whereForProgram(target, m.place, index, asked);
      }
    }

    // 9. Colleges in a place.
    if (COLLEGES_WORD.test(asked) && program === null && career === null) {
      if (m.place !== null) return collegesInPlace(m.place, index);

      const outside = unknownPlaceIn(asked, index);

      if (outside !== null) return outsideCatalog(outside, index);
    }

    return null;
  }

  // --- answers that need a query ----------------------------------------------------------

  /** Every active offering of a program that leads to this career, grouped by program. */
  private async whereForCareer(
    target: { careerId: string; title: string },
    place: PlaceEntry | null,
    index: CatalogIndex,
    asked: string,
  ): Promise<ResultsAnswer> {
    const rows = await this.db
      .select({ programName: programs.name, collegeName: colleges.name, town: towns.name })
      .from(programCareerLinks)
      .innerJoin(programs, eq(programCareerLinks.programId, programs.id))
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .leftJoin(towns, eq(colleges.townId, towns.id))
      .where(
        and(
          eq(programCareerLinks.careerId, target.careerId),
          eq(programs.status, 'active'),
          isNull(programs.deletedAt),
          eq(colleges.status, 'active'),
          isNull(colleges.deletedAt),
        ),
      )
      .orderBy(asc(programs.name), asc(colleges.name));

    if (rows.length === 0) {
      return {
        text: `No program in the college catalog is linked to ${target.title} yet, so I can't point you to a school for it. Your guidance counselor can help you find one.`,
        sources: CATALOG,
      };
    }

    const filtered =
      place === null ? rows : rows.filter((row) => inPlace(row.town, place, index));
    const shown = filtered.length > 0 ? filtered : rows;
    const byProgram = new Map<string, string[]>();

    for (const row of shown) {
      const label = row.town === null ? row.collegeName : `${row.collegeName} (${row.town})`;
      const list = byProgram.get(row.programName) ?? [];

      if (!list.includes(label)) list.push(label);
      byProgram.set(row.programName, list);
    }

    const lines = [
      ...catalogNotes(asked, place, filtered.length, index),
      `These programs lead to ${target.title}, and these colleges offer them:`,
      ...[...byProgram.entries()].map(([name, places]) => `• ${name}: ${places.join(', ')}`),
    ];

    return { text: lines.join('\n'), sources: CATALOG };
  }

  /**
   * "How do I become an engineer?" — a word that covers several careers. Listing what it could mean,
   * with the program behind each, lets the student pick; binding one would be the matcher guessing
   * (IMPLEMENT-kb-grounding.md §6.1). A word the catalog has only one career for is just answered.
   */
  private async vagueAnswer(
    term: VagueCareerTerm,
    place: PlaceEntry | null,
    index: CatalogIndex,
    asked: string,
  ): Promise<ResultsAnswer | null> {
    const found = term.careers
      .map((title) =>
        index.careers.find(
          (career) => normaliseQuestion(career.title) === normaliseQuestion(title),
        ),
      )
      .filter((career): career is CareerEntry => career !== undefined);

    if (found.length === 0) return null;

    const first = found[0]!;

    if (found.length === 1) {
      return this.whereForCareer({ careerId: first.id, title: first.title }, place, index, asked);
    }

    const rows = await this.db
      .selectDistinct({
        careerId: programCareerLinks.careerId,
        offering: programs.name,
        canonical: programCatalog.name,
      })
      .from(programCareerLinks)
      .innerJoin(programs, eq(programCareerLinks.programId, programs.id))
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .leftJoin(programCatalog, eq(programs.programCatalogId, programCatalog.id))
      .where(
        and(
          inArray(
            programCareerLinks.careerId,
            found.map((career) => career.id),
          ),
          eq(programs.status, 'active'),
          isNull(programs.deletedAt),
          eq(colleges.status, 'active'),
          isNull(colleges.deletedAt),
        ),
      );

    const example = first.title.toLowerCase();

    return {
      text: [
        `“${term.label}” can mean several careers. Which one do you mean?`,
        ...found.map((career) => {
          const names = [
            ...new Set(
              rows
                .filter((row) => row.careerId === career.id)
                .map((row) => row.canonical ?? row.offering),
            ),
          ].sort();

          return `• ${career.title} — ${names.length === 0 ? 'no program in the catalog yet' : names.join(', ')}`;
        }),
        `Ask me about one — for example “how do I become ${/^[aeiou]/.test(example) ? 'an' : 'a'} ${example}?” — and I’ll list the colleges that offer it.`,
      ].join('\n'),
      sources: CATALOG,
    };
  }

  /**
   * A program no college in the catalog offers — "I want to be a doctor" (IMPLEMENT-kb-grounding.md
   * §5.4). Says so plainly, says the one true thing about the route, and lists the related programs
   * that *are* offered, with where. Replaces a model reply built from passages that cannot answer.
   */
  private async gapAnswer(gap: CatalogGap, index: CatalogIndex): Promise<ResultsAnswer> {
    const nearest = gap.nearest
      .map((name) =>
        index.programs.find(
          (program) => normaliseQuestion(program.name) === normaliseQuestion(name),
        ),
      )
      .filter((program): program is ProgramEntry => program !== undefined);

    const rows =
      nearest.length === 0
        ? []
        : await this.db
            .select({
              catalogId: programs.programCatalogId,
              collegeName: colleges.name,
              town: towns.name,
            })
            .from(programs)
            .innerJoin(colleges, eq(programs.collegeId, colleges.id))
            .leftJoin(towns, eq(colleges.townId, towns.id))
            .where(
              and(
                inArray(
                  programs.programCatalogId,
                  nearest.map((program) => program.id),
                ),
                eq(programs.status, 'active'),
                isNull(programs.deletedAt),
                eq(colleges.status, 'active'),
                isNull(colleges.deletedAt),
              ),
            )
            .orderBy(asc(colleges.name));

    const listed = nearest.flatMap((program) => {
      const places = rows
        .filter((row) => row.catalogId === program.id)
        .map((row) => (row.town === null ? row.collegeName : `${row.collegeName} (${row.town})`));

      return places.length === 0 ? [] : [`• ${program.name}: ${[...new Set(places)].join(', ')}`];
    });

    const coverage = index.provinces.join(' and ');

    return {
      text: [
        coverage === ''
          ? `No college in the catalog offers ${gap.name}.`
          : `None of the ${coverage} colleges in the catalog offers ${gap.name}.`,
        gap.note,
        ...(listed.length === 0 ? [] : ['Related programs you can take here:', ...listed]),
        `Your guidance counselor can help you look at schools${coverage === '' ? '' : ` outside ${coverage}`} that offer ${gap.name}.`,
      ].join('\n'),
      sources: CATALOG,
    };
  }

  /** Where one program is taught: the student's recommended college first, then every other one. */
  private async whereForProgram(
    target: Extract<Target, { kind: 'PROGRAM' }>,
    place: PlaceEntry | null,
    index: CatalogIndex,
    asked: string,
  ): Promise<ResultsAnswer> {
    const offerings = await this.offeringsOf(target);
    const byId = new Map(index.colleges.map((college) => [college.id, college]));
    const filtered =
      place === null
        ? offerings
        : offerings.filter((offering) =>
            inPlace(byId.get(offering.collegeId)?.town ?? null, place, index),
          );
    const shown = filtered.length > 0 ? filtered : offerings;
    const lines: string[] = [...catalogNotes(asked, place, filtered.length, index)];

    if (target.rec !== null) {
      const { recommendation, college } = target.rec;
      const entry = byId.get(college.id);

      lines.push(
        `Your #${recommendation.ranking} program match is ${target.rec.program.name} at ${college.name}${entry?.town ? `, in ${entry.town}` : ''} (${formatScore(recommendation.matchScore)}%).`,
      );

      if (college.mapLink) lines.push(`Map: ${college.mapLink}`);
    }

    const others = shown.filter((offering) => offering.collegeId !== target.rec?.college.id);

    if (others.length > 0) {
      lines.push(
        target.rec === null
          ? `${target.title} is offered at:`
          : `${target.title} is also offered at:`,
        ...others.map((offering) => {
          const entry = byId.get(offering.collegeId);

          return `• ${offering.collegeName}${entry?.town ? ` (${entry.town})` : ''}`;
        }),
      );
    } else if (target.rec === null) {
      lines.push(`No college in the catalog currently offers ${target.title}.`);
    }

    return { text: lines.join('\n'), sources: CATALOG };
  }

  private async offeringsOf(
    target: Extract<Target, { kind: 'PROGRAM' }>,
  ): Promise<{ programId: string; collegeId: string; collegeName: string }[]> {
    const condition =
      target.programCatalogId !== null
        ? eq(programs.programCatalogId, target.programCatalogId)
        : target.programId !== null
          ? eq(programs.id, target.programId)
          : null;

    if (condition === null) return [];

    return this.db
      .select({ programId: programs.id, collegeId: colleges.id, collegeName: colleges.name })
      .from(programs)
      .innerJoin(colleges, eq(programs.collegeId, colleges.id))
      .where(
        and(
          condition,
          eq(programs.status, 'active'),
          isNull(programs.deletedAt),
          eq(colleges.status, 'active'),
          isNull(colleges.deletedAt),
        ),
      )
      .orderBy(asc(colleges.name));
  }

  /** The careers a program leads to, with pay and outlook. */
  private async careersAfter(
    target: Extract<Target, { kind: 'PROGRAM' }>,
  ): Promise<ResultsAnswer> {
    const offerings = await this.offeringsOf(target);

    if (offerings.length === 0) {
      return {
        text: `No college in the catalog currently offers ${target.title}, so I have no career links for it.`,
        sources: CATALOG,
      };
    }

    const rows = await this.db
      .selectDistinct({
        title: careers.title,
        salaryMin: careers.salaryMin,
        salaryMax: careers.salaryMax,
        outlook: employmentOutlooks.name,
      })
      .from(programCareerLinks)
      .innerJoin(careers, eq(programCareerLinks.careerId, careers.id))
      .leftJoin(employmentOutlooks, eq(careers.employmentOutlookId, employmentOutlooks.id))
      .where(
        and(
          inArray(
            programCareerLinks.programId,
            offerings.map((offering) => offering.programId),
          ),
          eq(careers.status, 'active'),
          isNull(careers.deletedAt),
        ),
      )
      .orderBy(asc(careers.title));

    if (rows.length === 0) {
      return {
        text: `The catalog does not link ${target.title} to any career yet. Your guidance counselor can tell you where its graduates usually work.`,
        sources: CATALOG,
      };
    }

    return {
      text: [
        `Graduates of ${target.title} commonly go into these careers:`,
        ...rows.map((row) => {
          const facts = [salaryText(row.salaryMin, row.salaryMax), row.outlook].filter(
            (fact): fact is string => fact !== null,
          );

          return `• ${row.title}${facts.length === 0 ? '' : ` — ${facts.join(', ')}`}`;
        }),
      ].join('\n'),
      sources: CATALOG,
    };
  }

  /** What each named college offers. */
  private async programsAt(list: CollegeEntry[]): Promise<ResultsAnswer> {
    const rows = await this.db
      .select({ collegeId: programs.collegeId, name: programs.name })
      .from(programs)
      .where(
        and(
          inArray(
            programs.collegeId,
            list.map((college) => college.id),
          ),
          eq(programs.status, 'active'),
          isNull(programs.deletedAt),
        ),
      )
      .orderBy(asc(programs.name));

    const lines = list.flatMap((college) => {
      const names = rows.filter((row) => row.collegeId === college.id).map((row) => row.name);

      return names.length === 0
        ? [`${college.name} has no programs listed in the catalog yet.`]
        : [
            `${college.name}${college.town ? ` (${college.town})` : ''} offers:`,
            ...names.map((name) => `• ${name}`),
          ];
    });

    return { text: lines.join('\n'), sources: CATALOG };
  }

  /**
   * The programs at one college (or a campus group, or a town), **scored for this student** with
   * the §27 formula and ranked — the answer to "what should I choose if I want to study there?".
   *
   * The stored recommendations are the top ten of the whole catalog, so a campus the student is
   * set on can easily have none of them. Every program still has a score; this computes it rather
   * than listing names. Nothing is stored and no model is called.
   */
  private async bestAt(
    studentId: string | null,
    targets: CollegeEntry[],
    set: RecommendationSet | null,
    label: string,
  ): Promise<ResultsAnswer> {
    const offerings = await this.db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(
        and(
          inArray(
            programs.collegeId,
            targets.map((college) => college.id),
          ),
          eq(programs.status, 'active'),
          isNull(programs.deletedAt),
        ),
      )
      .orderBy(asc(programs.name));

    if (offerings.length === 0) {
      return { text: `${label} has no programs listed in the catalog yet.`, sources: CATALOG };
    }

    const scored =
      studentId === null
        ? null
        : await new RecommendationService(this.db).scoreProgramsFor(
            studentId,
            offerings.map((offering) => offering.id),
          );

    if (scored === null || scored.length === 0) {
      return {
        text: [
          `${label} offers:`,
          ...[...new Set(offerings.map((offering) => offering.name))].map(
            (name) => `• ${name}`,
          ),
          'Finish both the RIASEC and SCCT assessments and I can rank these for you.',
        ].join('\n'),
        sources: CATALOG,
      };
    }

    const targetIds = new Set(targets.map((college) => college.id));
    const onList = set?.programs.filter((rec) => targetIds.has(rec.college.id)) ?? [];
    const several = new Set(scored.map((program) => program.collegeId)).size > 1;
    const shown = scored.slice(0, 6);
    const best = scored[0]!;
    const lines: string[] = [];

    if (set !== null) {
      lines.push(
        onList.length === 0
          ? `None of your top ${set.programs.length} program matches is offered at ${label}, but every program there still has a score for you.`
          : `On your recommendation list from ${label}: ${onList
              .map((rec) => `#${rec.recommendation.ranking} ${rec.program.name}`)
              .join(', ')}.`,
      );
    }

    lines.push(
      `The programs at ${label}, scored for you with the same formula as your recommendations:`,
      ...shown.map((program) => {
        const leadsTo =
          program.careers.length === 0
            ? ''
            : ` · leads to ${program.careers.slice(0, 3).join(', ')}${program.careers.length > 3 ? ' and more' : ''}`;

        return `• ${program.name}${several ? ` at ${program.collegeName}` : ''} — ${formatScore(program.matchScore)}%${leadsTo}`;
      }),
    );

    if (scored.length > shown.length) {
      lines.push(`…and ${scored.length - shown.length} more.`);
    }

    lines.push(
      `Your strongest fit there is ${best.name} (${formatScore(best.matchScore)}%). ${best.reason}`,
    );

    const overall = set?.programs[0];

    if (overall !== undefined && !targetIds.has(overall.college.id)) {
      lines.push(
        `For comparison, your #1 program overall, ${overall.program.name} at ${overall.college.name}, scores ${formatScore(overall.recommendation.matchScore)}%.`,
      );
    }

    lines.push(
      'The choice is yours. Ask me why any of these fits you, or what careers it leads to.',
    );

    return { text: lines.join('\n'), sources: [...RESULTS, ...CATALOG] };
  }

  /** The student's recommended programs taught in or near a place. */
  private nearAnswer(
    set: RecommendationSet,
    place: PlaceEntry,
    index: CatalogIndex,
  ): ResultsAnswer {
    const byId = new Map(index.colleges.map((college) => [college.id, college]));
    const near = set.programs.filter((rec) =>
      inPlace(byId.get(rec.college.id)?.town ?? null, place, index),
    );

    if (near.length > 0) {
      return {
        text: [
          `Of your program matches, these are taught in ${place.label}:`,
          ...near.map(
            (rec) =>
              `• #${rec.recommendation.ranking} ${rec.program.name} at ${rec.college.name} (${formatScore(rec.recommendation.matchScore)}%)`,
          ),
        ].join('\n'),
        sources: RESULTS,
      };
    }

    const local = collegesIn(place, index);

    return {
      text: [
        `None of your top ${set.programs.length} program matches is taught in ${place.label}.`,
        local.length === 0
          ? `The catalog has no college in ${place.label}.`
          : `Colleges in ${place.label}: ${local.map((college) => college.name).join(', ')}. Ask me what any of them offers.`,
      ].join(' '),
      sources: [...RESULTS, ...CATALOG],
    };
  }
}

// --- pure helpers ----------------------------------------------------------------------------

function recentTexts(history: HistoryMessage[]): string[] {
  const reversed = [...history].reverse();
  const lastStudent = reversed.find((message) => message.role === 'user');
  const lastAnswer = reversed.find((message) => message.role === 'assistant');

  return [lastStudent?.content, lastAnswer?.content].filter(
    (text): text is string => text !== undefined,
  );
}

function rankOf(asked: string): number | null {
  for (const [pattern, rank] of ORDINALS) {
    if (pattern.test(asked)) return rank;
  }

  return null;
}

function kindOf(asked: string): Kind | null {
  if (PROGRAM_WORDS.test(asked)) return 'PROGRAM';
  if (CAREER_WORDS.test(asked)) return 'CAREER';

  return null;
}

function programTarget(m: Mentions): Extract<Target, { kind: 'PROGRAM' }> | null {
  if (m.setProgram !== null) {
    return {
      kind: 'PROGRAM',
      rec: m.setProgram,
      programCatalogId: m.setProgram.program.programCatalogId,
      programId: m.setProgram.program.id,
      title: m.setProgram.program.name,
    };
  }

  return m.program === null
    ? null
    : {
        kind: 'PROGRAM',
        rec: null,
        programCatalogId: m.program.id,
        programId: null,
        title: m.program.name,
      };
}

function careerTarget(m: Mentions): Extract<Target, { kind: 'CAREER' }> | null {
  if (m.setCareer !== null) {
    return {
      kind: 'CAREER',
      rec: m.setCareer,
      careerId: m.setCareer.career.id,
      title: m.setCareer.career.title,
    };
  }

  return m.career === null
    ? null
    : { kind: 'CAREER', rec: null, careerId: m.career.id, title: m.career.title };
}

/**
 * The career or program a "why" or "where" question is about: a name the student typed beats a
 * rank word ("why CPA, not my top one?" is about CPA), and a rank word needs a kind word with it.
 */
function targetFor(asked: string, set: RecommendationSet | null, m: Mentions): Target | null {
  const program = programTarget(m);
  const career = careerTarget(m);

  if (program !== null && (career === null || PROGRAM_WORDS.test(asked))) return program;
  if (career !== null) return career;

  const kind = kindOf(asked);
  const rank = rankOf(asked);

  if (set === null || rank === null || kind === null) return null;

  if (kind === 'CAREER') {
    const rec = set.careers.find((entry) => entry.recommendation.ranking === rank);

    return rec === undefined
      ? null
      : { kind: 'CAREER', rec, careerId: rec.career.id, title: rec.career.title };
  }

  const rec = set.programs.find((entry) => entry.recommendation.ranking === rank);

  return rec === undefined
    ? null
    : {
        kind: 'PROGRAM',
        rec,
        programCatalogId: rec.program.programCatalogId,
        programId: rec.program.id,
        title: rec.program.name,
      };
}

function catalogCareerFor(
  rec: CareerRecommendation | null,
  index: CatalogIndex,
): CareerEntry | null {
  return rec === null
    ? null
    : (index.careers.find((career) => career.id === rec.career.id) ?? null);
}

function bindingFrom(m: Mentions, fromHistory: boolean): EntityBinding | null {
  if (m.colleges.length === 1) {
    return {
      entity: { type: 'college', id: m.colleges[0]!.id },
      name: m.colleges[0]!.name,
      fromHistory,
    };
  }

  if (m.setProgram !== null) {
    return {
      entity: { type: 'program', id: m.setProgram.program.id },
      name: m.setProgram.program.name,
      fromHistory,
    };
  }

  if (m.setCareer !== null) {
    return {
      entity: { type: 'career', id: m.setCareer.career.id },
      name: m.setCareer.career.title,
      fromHistory,
    };
  }

  if (m.career !== null) {
    return { entity: { type: 'career', id: m.career.id }, name: m.career.title, fromHistory };
  }

  // A canonical program has no single offering to scope to; its name still helps a follow-up query.
  if (m.program !== null) {
    return { entity: null, name: m.program.name, fromHistory };
  }

  return null;
}

function inPlace(town: string | null, place: PlaceEntry, index: CatalogIndex): boolean {
  if (town === null) return false;
  if (place.kind === 'town') return town === place.label;

  return index.colleges.some(
    (college) => college.town === town && college.province === place.label,
  );
}

/** The sentences that go above a list when the question asked about somewhere the list is not. */
function catalogNotes(
  asked: string,
  place: PlaceEntry | null,
  matchesInPlace: number,
  index: CatalogIndex,
): string[] {
  const coverage = index.provinces.length === 0 ? null : index.provinces.join(' and ');

  if (place !== null && matchesInPlace === 0) {
    return [
      `None of these colleges is in ${place.label}. Here is where it is offered instead:`,
    ];
  }

  const outside = unknownPlaceIn(asked, index);

  if (outside === null) {
    return [];
  }

  return [
    coverage === null
      ? `This catalog only lists the colleges shown here, so I can't tell you about ${outside}.`
      : `This catalog lists colleges in ${coverage} only, so I can't tell you about ${outside}.`,
  ];
}

function money(amount: number): string {
  return `₱${amount.toLocaleString('en-PH')}`;
}

function salaryText(min: number | null, max: number | null): string | null {
  return min !== null && max !== null ? `${money(min)} – ${money(max)} a month` : null;
}

// --- answers from rows already in hand -------------------------------------------------------

function capabilities(brief: StudentBrief | null): ResultsAnswer {
  const lines = [
    'I can help you with:',
    '• Your results — your Holland code, your RIASEC and SCCT scores, and why each career or program is on your list.',
    '• The college catalog — where a college is, what it offers, which colleges offer a program, and which careers a program leads to.',
    '• Careers — typical monthly salary, job outlook, and what the work involves.',
    '• Guidance — how your scores are built, strands, program families, and how to choose.',
    // Migration 0038. It is listed because a student has no way to guess that an assistant which
    // talks about careers will also walk them to a screen — and "where is…" is the question they
    // were already asking, in the dark, before the gate existed.
    '• Finding your way around — ask me where something is (“where do I download my results?”) and I can take you straight to it.',
    'I can’t see tuition fees, admission dates or entrance requirements unless your school has added them. Your guidance counselor can help with those.',
  ];

  if (brief !== null && (!brief.riasec.complete || !brief.scct.complete)) {
    lines.push('Finish both the RIASEC and SCCT assessments to get your recommendations.');
  }

  return { text: lines.join('\n'), sources: [] };
}

/** Questions about the student's own results that the brief answers directly. */
function personalAnswer(
  asked: string,
  set: RecommendationSet | null,
  brief: StudentBrief | null,
): ResultsAnswer | null {
  if (WHY.test(asked)) return null;

  if (MY_HOLLAND.test(asked) && brief !== null) {
    if (!brief.riasec.complete || brief.riasec.hollandCode === null) {
      return {
        text: 'You haven’t finished the RIASEC assessment yet, so you don’t have a Holland code. Once you do, it will be your three strongest interest types.',
        sources: RESULTS,
      };
    }

    const top = [...brief.riasec.dimensions]
      .filter((d) => brief.riasec.hollandCode!.includes(d.code))
      .sort(
        (a, b) =>
          brief.riasec.hollandCode!.indexOf(a.code) - brief.riasec.hollandCode!.indexOf(b.code),
      );

    return {
      text: `Your Holland code is ${brief.riasec.hollandCode}: your three strongest interest types, strongest first — ${top
        .map((d) => `${d.name} ${formatScore(d.score)}${d.band ? ` (${d.band})` : ''}`)
        .join(', ')}.`,
      sources: RESULTS,
    };
  }

  if (MY_SCORES.test(asked) && brief !== null) {
    const lines: string[] = [];

    if (brief.riasec.dimensions.length > 0) {
      lines.push(
        'Your RIASEC interest scores (out of 100):',
        ...brief.riasec.dimensions.map(
          (d) => `• ${d.name}: ${formatScore(d.score)}${d.band ? ` — ${d.band}` : ''}`,
        ),
      );
    }

    if (brief.scct.dimensions.length > 0) {
      lines.push(
        'Your SCCT confidence scores (out of 100):',
        ...brief.scct.dimensions.map(
          (d) => `• ${d.name}: ${formatScore(d.score)}${d.band ? ` — ${d.band}` : ''}`,
        ),
      );
    }

    if (brief.scct.confidenceIndex !== null) {
      lines.push(
        `Career confidence index: ${formatScore(brief.scct.confidenceIndex)} (${brief.scct.band}).`,
      );
    }

    return lines.length === 0
      ? {
          text: 'You haven’t finished an assessment yet, so there are no scores to show. Start with the RIASEC assessment on your Assessments page.',
          sources: RESULTS,
        }
      : { text: lines.join('\n'), sources: RESULTS };
  }

  if (MY_TOP.test(asked)) {
    const kind = kindOf(asked);

    if (kind === null) return null;

    if (set === null) {
      return {
        text: 'You don’t have recommendations yet. Once you finish both the RIASEC and SCCT assessments, your top careers and programs will appear here.',
        sources: RESULTS,
      };
    }

    const explicitRank =
      /\b(?:top|number|no) (?:1|one|2|two|3|three|4|5)\b|\b(?:1st|2nd|3rd|4th|5th|first|second|third)\b/.test(
        asked,
      ) &&
      !/\btop (?:two|three|four|five|[2-5]) (?:careers|programs|courses|jobs|matches)\b/.test(
        asked,
      );
    const rank = explicitRank ? rankOf(asked) : null;
    const count = countOf(asked) ?? 5;

    if (kind === 'CAREER') {
      const list =
        rank === null
          ? set.careers.slice(0, count)
          : set.careers.filter((c) => c.recommendation.ranking === rank);

      if (list.length === 0) return null;

      return {
        text: [
          rank === null
            ? `Your top ${list.length} career matches:`
            : `Your #${rank} career match:`,
          ...list.map(
            ({ recommendation, career }) =>
              `• #${recommendation.ranking} ${career.title} — ${formatScore(recommendation.matchScore)}%`,
          ),
        ].join('\n'),
        sources: RESULTS,
      };
    }

    const list =
      rank === null
        ? set.programs.slice(0, count)
        : set.programs.filter((p) => p.recommendation.ranking === rank);

    if (list.length === 0) return null;

    return {
      text: [
        rank === null
          ? `Your top ${list.length} program matches:`
          : `Your #${rank} program match:`,
        ...list.map(
          ({ recommendation, program, college }) =>
            `• #${recommendation.ranking} ${program.name} at ${college.name} — ${formatScore(recommendation.matchScore)}%`,
        ),
      ].join('\n'),
      sources: RESULTS,
    };
  }

  // "Which of my top three careers pays best?" — only when no specific career is named.
  if (
    set !== null &&
    /\bmy\b/.test(asked) &&
    PAYS_BEST.test(asked) &&
    /\b(?:best|most|highest|more|better)\b/.test(asked)
  ) {
    const pool = set.careers
      .slice(0, countOf(asked) ?? 5)
      .filter((c) => c.career.salaryMax !== null);

    if (pool.length === 0) return null;

    const sorted = [...pool].sort(
      (a, b) => (b.career.salaryMax ?? 0) - (a.career.salaryMax ?? 0),
    );
    const best = sorted[0]!;

    return {
      text: [
        `Of your top ${pool.length} career matches, ${best.career.title} has the highest listed pay: ${salaryText(best.career.salaryMin, best.career.salaryMax)}.`,
        ...sorted.map(
          ({ career }) =>
            `• ${career.title}: ${salaryText(career.salaryMin, career.salaryMax) ?? 'no salary on file'}`,
        ),
        'These are typical monthly ranges from entry level to senior. Pay depends on where and for whom you work.',
      ].join('\n'),
      sources: [...RESULTS, ...CATALOG],
    };
  }

  return null;
}

/**
 * A weight as a percentage, without trailing-zero noise: `0.6` reads `60%`, `0.155` reads `15.5%`.
 *
 * One decimal rather than none, because the weights are operator-set now and rounding `0.615` to
 * "62%" in a sentence that claims to state the arithmetic is a small, avoidable lie.
 */
function weightPercent(weight: number): string {
  return `${Math.round(weight * 1000) / 10}%`;
}

/** What a career score is made of, in the deployment's own weights. */
function careerWeightSentence(formula: ScoringFormula): string {
  return `Career matches weigh RIASEC fit ${weightPercent(formula.career.riasecCompatibility)} and career confidence ${weightPercent(formula.career.careerConfidence)}.`;
}

/** The same for a program score. Both are generated, never written out — see `ResultsAnswerService.formula`. */
function programWeightSentence(formula: ScoringFormula): string {
  return `Program matches weigh RIASEC fit ${weightPercent(formula.program.riasecCompatibility)}, career alignment with your recommended careers ${weightPercent(formula.program.careerAlignment)}, career confidence ${weightPercent(formula.program.careerConfidence)}, academic fit ${weightPercent(formula.program.academicFit)} and strand alignment ${weightPercent(formula.program.strandAlignment)}.`;
}

function weightProse(
  components: Record<string, number> | null,
  kind: Kind,
  formula: ScoringFormula,
): string | null {
  const parts = componentsProse(components);

  if (parts === null) return null;

  return kind === 'CAREER'
    ? `Its components: ${parts}. ${careerWeightSentence(formula)}`
    : `Its components: ${parts}. ${programWeightSentence(formula)}`;
}

/** The stored §27 reason, with the rank, score and components it came from. Never a new opinion. */
function whyAnswer(
  target: Target,
  set: RecommendationSet | null,
  formula: ScoringFormula = DEFAULT_FORMULA,
): ResultsAnswer {
  if (target.rec === null) {
    const list = target.kind === 'CAREER' ? set?.careers : set?.programs;

    return {
      text:
        set === null
          ? `You don't have recommendations yet, so there is no computed reason for ${target.title}. Once you finish both the RIASEC and SCCT assessments, I can explain every match.`
          : `${target.title} is not among your top ${list?.length ?? 0} ${target.kind === 'CAREER' ? 'career' : 'program'} matches, so there is no computed reason for it. I can explain any of the matches on your list.`,
      sources: RESULTS,
    };
  }

  if (target.kind === 'CAREER') {
    const { recommendation, career, outlook } = target.rec;
    const facts = [
      salaryText(career.salaryMin, career.salaryMax) === null
        ? null
        : `pays ${salaryText(career.salaryMin, career.salaryMax)}`,
      outlook?.name ? `has a ${outlook.name} outlook` : null,
    ].filter((fact): fact is string => fact !== null);

    return {
      text: [
        `${career.title} is your #${recommendation.ranking} career match at ${formatScore(recommendation.matchScore)}%.`,
        recommendation.reason,
        // The fallback is the same sentence without the per-component breakdown: a row generated
        // before migration 0036 has no `components`, but the weights it was scored under are still
        // the ones to state.
        weightProse(recommendation.components ?? null, 'CAREER', formula) ??
          careerWeightSentence(formula),
        facts.length === 0 ? null : `In the catalog it ${facts.join(' and ')}.`,
      ]
        .filter((line): line is string => line !== null)
        .join(' '),
      sources: RESULTS,
    };
  }

  const { recommendation, program, college } = target.rec;

  return {
    text: [
      `${program.name} at ${college.name} is your #${recommendation.ranking} program match at ${formatScore(recommendation.matchScore)}%.`,
      recommendation.reason,
      weightProse(recommendation.components ?? null, 'PROGRAM', formula) ??
        programWeightSentence(formula),
    ].join(' '),
    sources: RESULTS,
  };
}

function careerFact(
  career: CareerEntry,
  fact: 'salary' | 'outlook' | 'describe',
): ResultsAnswer {
  const salary = salaryText(career.salaryMin, career.salaryMax);

  if (fact === 'salary') {
    return {
      text:
        salary === null
          ? `The catalog has no salary on file for ${career.title}.`
          : `A ${career.title} typically earns ${salary} in the Philippines, from entry level to senior.${career.outlook ? ` Employment outlook: ${career.outlook}.` : ''}`,
      sources: CATALOG,
    };
  }

  if (fact === 'outlook') {
    return {
      text:
        career.outlook === null
          ? `The catalog has no employment outlook on file for ${career.title}.`
          : `${career.title}: ${career.outlook}.${salary === null ? '' : ` Typical pay is ${salary}.`}`,
      sources: CATALOG,
    };
  }

  return {
    text: [
      `${career.title}${career.description ? `: ${career.description}` : '.'}`,
      salary === null ? null : `Typical pay: ${salary}.`,
      career.outlook === null ? null : `Outlook: ${career.outlook}.`,
      career.riasec === null ? null : `It suits the RIASEC code ${career.riasec}.`,
    ]
      .filter((line): line is string => line !== null)
      .join(' '),
    sources: CATALOG,
  };
}

function compareCareers(list: CareerEntry[]): ResultsAnswer {
  return {
    text: [
      'From the catalog:',
      ...list.map((career) => {
        const facts = [
          salaryText(career.salaryMin, career.salaryMax),
          career.outlook,
          career.riasec === null ? null : `RIASEC ${career.riasec}`,
        ].filter((fact): fact is string => fact !== null);

        return `• ${career.title}: ${facts.length === 0 ? 'no details on file' : facts.join(' · ')}`;
      }),
      'Which fits you better depends on your interests and confidence. Ask me why either one is or isn’t on your list.',
    ].join('\n'),
    sources: CATALOG,
  };
}

function collegeLocations(list: CollegeEntry[]): ResultsAnswer {
  return {
    text: list
      .map((college) => {
        const where = [college.town, college.province].filter(
          (part): part is string => part !== null,
        );

        return [
          `${college.name} is ${where.length === 0 ? 'in the catalog with no address on file' : `in ${where.join(', ')}`}.`,
          college.mapLink ? `Map: ${college.mapLink}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join('\n');
      })
      .join('\n'),
    sources: CATALOG,
  };
}

function collegesInPlace(place: PlaceEntry, index: CatalogIndex): ResultsAnswer {
  const list = collegesIn(place, index);

  if (list.length === 0) {
    return { text: `The catalog has no college in ${place.label}.`, sources: CATALOG };
  }

  if (place.kind === 'town') {
    return {
      text: [`Colleges in ${place.label}:`, ...list.map((college) => `• ${college.name}`)].join(
        '\n',
      ),
      sources: CATALOG,
    };
  }

  const byTown = new Map<string, string[]>();

  for (const college of list) {
    const town = college.town ?? 'Town not on file';
    byTown.set(town, [...(byTown.get(town) ?? []), college.name]);
  }

  return {
    text: [
      `The catalog lists ${list.length} colleges in ${place.label}:`,
      ...[...byTown.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([town, names]) => `• ${town}: ${names.join(', ')}`),
    ].join('\n'),
    sources: CATALOG,
  };
}

function outsideCatalog(place: string, index: CatalogIndex): ResultsAnswer {
  if (index.provinces.length === 0) {
    return {
      text: `The catalog has no colleges listed in ${place}. Your guidance counselor can help with schools elsewhere.`,
      sources: CATALOG,
    };
  }

  const coverage = index.provinces.join(' and ');

  return {
    text: `This catalog lists colleges in ${coverage} only, so I can't tell you about colleges in ${place}. Ask me about colleges in ${coverage}, or ask your guidance counselor about schools elsewhere.`,
    sources: CATALOG,
  };
}
