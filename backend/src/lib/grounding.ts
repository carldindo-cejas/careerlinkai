/**
 * The grounding contract (FULLPLAN §34 extended; AiNormalisation Phase 3) — pure string work, no
 * I/O, no bindings, unit-tested standalone like `lib/chunker.ts` and `lib/scoring.ts`.
 *
 * ## The claim this file exists to make true
 *
 * You cannot make an 8B model stop hallucinating. No prompt, no policy and no amount of admin
 * knowledge gets a generative model to zero invented facts. What you *can* guarantee is that **no
 * ungrounded claim reaches a student as fact**, and that is a property of code, not of a prompt.
 *
 * Everything here is a check applied to text the model has already produced, before a student sees
 * it. Each one costs zero neurons, which is what makes it affordable to run on every answer rather
 * than on the ones somebody remembered to check.
 *
 * ## Erring towards refusal, on purpose
 *
 * These checks reject some answers that were in fact fine — a paraphrase the overlap test cannot
 * see, a proper noun the model spelled differently. That trade is deliberate and it is cheap here,
 * because a rejected answer does not become an error message: it becomes the deterministic reply
 * built from the student's own computed results, which was true whatever the model did. A false
 * rejection costs a paragraph. A false acceptance costs a student acting on an invented tuition
 * fee.
 */

/**
 * Normalise a question for exact matching (Gate 1).
 *
 * Case, punctuation, diacritics and spacing all vary between two people asking the same thing —
 * *"How much is tuition?"*, *"how much is the tuition"*, *"Magkano ang tuition???"* — and none of
 * that variation changes which admin-written answer is correct. What survives is the sequence of
 * word characters, which is the part a human would say is "the same question".
 */
export function normaliseQuestion(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** One admin-authored pair, as stored: a single `Q: …\nA: …` passage. */
export interface QaPair {
  question: string;
  answer: string;
}

/**
 * Split a stored Q&A chunk back into its halves.
 *
 * Returns null for anything that is not one — the caller is asking "can Gate 1 answer with this?",
 * and a passage without the marker is a passage whose answer half cannot be identified, so the
 * honest answer is no rather than a guess at where the answer starts.
 */
export function parseQaChunk(content: string): QaPair | null {
  const match = /^Q:\s*([\s\S]*?)\n\s*A:\s*([\s\S]*)$/.exec(content.trim());

  if (match === null) {
    return null;
  }

  const question = match[1]!.trim();
  const answer = match[2]!.trim();

  return question === '' || answer === '' ? null : { question, answer };
}

/** The citation markers a response carries, in order of first appearance, deduplicated. */
export function citedIndexes(text: string): number[] {
  const found = new Set<number>();

  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    found.add(Number(match[1]));
  }

  return [...found];
}

export type CitationVerdict =
  | { ok: true; cited: number[] }
  | { ok: false; reason: 'NO_CITATION' | 'CITATION_OUT_OF_RANGE' };

/**
 * **Cite or refuse.** An answer generated from supplied context must point at the context it used.
 *
 * Two failures, and they are different problems. `NO_CITATION` means the model wrote from
 * somewhere other than the passages it was given — which is exactly the state the whole pipeline
 * exists to prevent, and is not distinguishable from invention by reading the text. Whereas
 * `CITATION_OUT_OF_RANGE` — a `[7]` when six passages were supplied — means it invented the
 * *evidence*, which is worse: a marker a reader can see and cannot check.
 *
 * Only applied when context was actually supplied. An answer built from the student's own computed
 * results has nothing to cite, and demanding a marker there would reject the one class of answer
 * that is arithmetic rather than retrieval.
 */
export function validateCitations(text: string, sourceCount: number): CitationVerdict {
  const cited = citedIndexes(text);

  if (cited.length === 0) {
    return { ok: false, reason: 'NO_CITATION' };
  }

  if (cited.some((index) => index < 1 || index > sourceCount)) {
    return { ok: false, reason: 'CITATION_OUT_OF_RANGE' };
  }

  return { ok: true, cited };
}

/**
 * The ways a model says the material in front of it does not answer the question.
 *
 * Mostly the prompt's own wording played back: the chat prompt tells the model to "say plainly
 * that you do not have that information" and that "I don't have that" beats being approximately
 * right. So these are not guesses at how an 8B model might phrase a refusal — they are the phrases
 * it was instructed to use, plus the variants it was measured producing on production.
 *
 * Two tiers, because the cost of a false match differs by caller:
 *
 *   * **First person** — *"I don't have…"*, *"I couldn't find…"*. The model talking about its own
 *     material. Almost never a plain fact about the world, so safe everywhere.
 *   * **Impersonal** — *"…is not mentioned in…"*, *"the materials do not cover…"*. Usually a gap,
 *     but *"your top interests do not include Social"* is a fact and matches too. Fine where a
 *     match only files a backlog row; not fine where it discards a paragraph.
 */
const FIRST_PERSON_GAP_PATTERN = new RegExp(
  [
    // "I don't have any information about…", "I do not have that", "we don't have details on…"
    String.raw`\b(?:i|we)\s+(?:do not|don't|dont)\s+have\s+(?:any\s+)?(?:specific\s+|more\s+|further\s+|detailed\s+|exact\s+)?(?:information|info|details|data|that)\b`,
    // "I couldn't find…", "I was unable to find…"
    String.raw`\b(?:i|we)\s+(?:could not|couldn't|was unable to|am unable to|am not able to|wasn't able to|was not able to)\s+find\b`,
    // "There is no information about…" — impersonal in grammar, but only ever said about sources.
    String.raw`\bno (?:specific |further |detailed )?information (?:about|on|regarding|is available|was provided)\b`,
  ].join('|'),
  'i',
);

const IMPERSONAL_GAP_PATTERN = new RegExp(
  [
    // "…is not mentioned in the materials", "…are not covered in…"
    String.raw`\b(?:is|are|was|were)\s+not\s+(?:mentioned|covered|included|provided|stated|specified|listed)\s+in\b`,
    // "The context does not mention…", "the materials don't cover…"
    String.raw`\b(?:does|do)(?:\s+not|n't)\s+(?:mention|cover|include|say|specify)\b`,
  ].join('|'),
  'i',
);

/**
 * **The model admitting it does not know — in an answer that otherwise passes every check.**
 *
 * Found testing the AI-gaps screen against production on 2026-09-11. Every refusal *this code*
 * makes is logged as a gap; a refusal the *model* writes was not, because it is a well-formed,
 * cited answer: *"I don't have any information about a Mechanical Engineering program at Bohol
 * Island State University. I only mentioned the BS Mechanical Engineering at University of
 * Bohol [1]."* That cites a real passage, invents nothing, and passes cite-or-refuse and the claim
 * check — so it was recorded as a success. The student's actual question never reached the
 * backlog, and they were never offered *"Request to add to knowledge"*. Three of the sixteen cited
 * answers on production at the time were this shape.
 *
 * What the caller does with a match is its own decision, and the two callers differ on purpose
 * (see `ChatService.generated` and `ExplanationService`): a chat keeps an honest "I don't have
 * that, but here is what I do have", while a paragraph attached to a computed score does not.
 * `strict` is for the second — first-person admissions only, so a plain fact phrased in the
 * negative cannot cost a student their explanation.
 *
 * Curly apostrophes are folded first: a model writes `don’t` as often as `don't`, and a pattern
 * that saw only one of them would miss half its matches for a reason nobody would guess.
 */
export function selfReportedGap(text: string, options: { strict?: boolean } = {}): boolean {
  const folded = text.replace(/[\u2018\u2019]/g, "'");

  if (FIRST_PERSON_GAP_PATTERN.test(folded)) {
    return true;
  }

  return options.strict !== true && IMPERSONAL_GAP_PATTERN.test(folded);
}

/**
 * Words that are capitalised for reasons other than being a name, plus the ones a guidance
 * conversation uses constantly. Checking these as proper nouns would reject sound answers for
 * saying "I" or starting a clause with "Your".
 */
const CAPITALISED_NON_NAMES = new Set([
  'i', 'a', 'an', 'the', 'this', 'that', 'these', 'those', 'you', 'your', 'yours', 'we', 'our',
  'they', 'their', 'it', 'its', 'if', 'and', 'but', 'or', 'so', 'because', 'since', 'while',
  'when', 'where', 'what', 'which', 'who', 'why', 'how', 'there', 'here', 'both', 'each',
  'based', 'according', 'however', 'also', 'for', 'from', 'with', 'without', 'about', 'into',
  'in', 'on', 'at', 'to', 'of', 'as', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'can', 'could', 'may', 'might', 'will', 'would', 'should', 'shall',
  'ask', 'talk', 'consider', 'remember', 'note', 'yes', 'no', 'not', 'ok', 'okay', 'many',
  'most', 'some', 'any', 'all', 'one', 'two', 'three', 'first', 'second', 'third', 'next',
  'guidance', 'counselor', 'counsellor', 'student', 'students', 'career', 'careers', 'program',
  'programs', 'college', 'colleges', 'course', 'courses', 'school', 'schools', 'strand',
]);

/** Split into sentences without a tokenizer: this only needs to be roughly right. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Digits with their separators stripped, so "PHP 25,000" and "25000" are the same claim. */
function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,.\s]*\d|\d/g)]
    .map((match) => match[0].replace(/[,\s]/g, '').replace(/\.$/, ''))
    .filter((value) => value.length > 0);
}

/**
 * Capitalised words that are not sentence-initial and not ordinary vocabulary — the shape of a
 * school name, a program code, a place.
 */
function properNounsIn(sentence: string): string[] {
  const words = sentence.split(/[^\p{L}\p{N}&-]+/u).filter((word) => word.length > 0);

  return words
    .slice(1) // the first word is capitalised because it starts a sentence
    .filter((word) => /^[\p{Lu}]/u.test(word) && word.length > 1)
    .filter((word) => !CAPITALISED_NON_NAMES.has(word.toLowerCase()));
}

export interface UnsupportedClaim {
  sentence: string;
  /** The token that could not be found in any source. */
  token: string;
  kind: 'NUMBER' | 'NAME';
}

/**
 * Every number in the sources, as a numeric value.
 *
 * Measured on production: the model writes `100.0%` where the computed context says `100%`. Those
 * are the same claim, and the substring test cannot see it — the characters `100.0` do not occur
 * in `100%`. Comparing as numbers is what stops a difference in *formatting* reading as a
 * difference in *fact*.
 *
 * The same defect class as migration 0027's tokenizer, arriving by a different road: two spellings
 * of one value, compared as strings.
 */
function numericValuesOf(text: string): Set<number> {
  const values = new Set<number>();

  for (const raw of numbersIn(text)) {
    const value = Number(raw);

    if (Number.isFinite(value)) {
      values.add(value);
    }
  }

  return values;
}

/**
 * Whether a written figure equals one the sources actually contain.
 *
 * Equality against the sources' own numbers, never a tolerance: this widens what counts as *the
 * same* number and never what counts as a *supported* one. The distinction is not academic — the
 * production run that motivated this also rejected `97.3` as a match score, and the highest score
 * in the database is 93.4. That refusal was correct, it stays correct, and nothing here may accept
 * a value the sources do not hold.
 */
function isNumericallyPresent(value: string, sourceNumbers: Set<number>): boolean {
  const parsed = Number(value);

  return Number.isFinite(parsed) && sourceNumbers.has(parsed);
}

/**
 * The singular of a regular English plural, or null when the word is not one.
 *
 * "Civil Engineers" is not a different entity from the "Civil Engineer" a passage names, but the
 * substring test read the plural as an unsourced name and refused the whole explanation — six of
 * the eight refusals measured on production were this one word.
 *
 * Only regular endings fold, and only ever to *find* a source. An irregular plural fails to fold
 * and is then checked exactly as written, which is the conservative direction: the cost is a
 * refusal that was already happening, never an unsupported name let through.
 */
function singularOf(word: string): string | null {
  if (word.endsWith('ies') && word.length > 4) {
    return word.slice(0, -3) + 'y';
  }

  if (word.endsWith('sses') || word.endsWith('shes') || word.endsWith('ches')) {
    return word.slice(0, -2);
  }

  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
    return word.slice(0, -1);
  }

  return null;
}

/**
 * Every sentence asserting a figure or a name whose token appears in **no** source.
 *
 * This is the check that catches the invented tuition fee, and it is deliberately mechanical: a
 * number the model wrote that appears nowhere in the material it was given did not come from that
 * material. There is no cleverness to add here — a language model cannot be asked whether it made
 * something up, and asking a second model costs neurons this system does not have to spend on
 * every answer.
 *
 * `sources` is everything the answer was allowed to draw on: the retrieved passages **and** the
 * student's own computed results, because a match score of 87% is grounded by arithmetic rather
 * than by a document, and refusing it would reject the truest sentence in the answer.
 *
 * Matching is substring, case-insensitive, on a normalised copy of the sources. Loose on purpose —
 * the goal is to catch fabrication, not to enforce quotation.
 */
export function unsupportedClaims(text: string, sources: string[]): UnsupportedClaim[] {
  const haystack = sources.join('\n').toLowerCase();
  const haystackDigits = haystack.replace(/[,\s]/g, '');
  const haystackNumbers = numericValuesOf(haystack);
  const problems: UnsupportedClaim[] = [];

  for (const sentence of sentencesOf(text)) {
    // Citation markers are ours, not claims: `[2]` must not be read as the number two.
    const claim = sentence.replace(/\[\d{1,2}\]/g, ' ');

    for (const value of numbersIn(claim)) {
      // A bare small number is ordinary prose ("two options", "3 programs"), not a checkable
      // figure — and demanding a source for it would reject sentences that assert nothing.
      if (value.length < 3) {
        continue;
      }

      if (!haystackDigits.includes(value) && !isNumericallyPresent(value, haystackNumbers)) {
        problems.push({ sentence, token: value, kind: 'NUMBER' });
      }
    }

    for (const noun of properNounsIn(claim)) {
      const lower = noun.toLowerCase();
      const singular = singularOf(lower);

      if (!haystack.includes(lower) && (singular === null || !haystack.includes(singular))) {
        problems.push({ sentence, token: noun, kind: 'NAME' });
      }
    }
  }

  return problems;
}

/**
 * Questions this assistant declines by design (§34's scope, Phase 3).
 *
 * Not a content filter and not a safety classifier — a keyword heuristic, which is what is
 * affordable and what is honest about its own accuracy. It exists because the failure it prevents
 * is specific: an 8B model asked to do someone's algebra homework will happily do it wrong, and a
 * guidance assistant that answers homework has quietly become a homework tool that is bad at
 * homework.
 *
 * `PERSONAL` is separated from `HOMEWORK` for one reason. A student bringing a personal or
 * emotional problem to the only thing on the screen that talks back must not be met with a flat
 * refusal; they get pointed at a person who can actually help. Getting that wrong costs more than
 * every other check in this file put together.
 */
export type OffDomain = 'HOMEWORK' | 'PERSONAL';

/**
 * Deliberately forgiving about the words *between* a trigger and its object — "write me **an**
 * essay", "I feel **so** hopeless". The first cut required each phrase to be said one exact way,
 * which is not how anybody types, and the tests caught both.
 */
const HOMEWORK_PATTERNS =
  /\b(?:solve|compute|calculate|simplify|factor(?:ise|ize)?|derive|integrate|differentiate)\b[^.?!]{0,40}?\b(?:equation|problem|expression|answer|for x|for y)\b|\bwrite\b(?:\s+\w+){0,3}?\s+(?:essay|poem|reaction paper|reflection|code|program)\b|\bmy (?:homework|assignment|thesis|research paper|project)\b|\bgawin mo\b[^.?!]{0,30}\b(?:assignment|homework|takdang aralin)\b/i;

/**
 * How a student says they are feeling, matched **only where they are describing themselves**.
 *
 * The anchor is the whole design. "Is nursing a stressful job?" is an ordinary career question and
 * must be answered; "I am so stressed" is a person asking for help and must reach one. Both
 * contain the same root, and only the self-reference separates them — so these words are never
 * matched bare.
 */
const DISTRESS_WORDS =
  'depressed|hopeless|worthless|suicidal|stressed|stressed out|anxious|overwhelmed|scared|terrified|panicking|panicky|crying|burnt out|burned out|breaking down|falling apart|losing it';

/**
 * Questions that are really a person in difficulty (§34, Phase 3).
 *
 * Extended 2026-09-05 after a production session. The first cut caught *crisis* vocabulary —
 * self-harm, abuse, "I am hopeless" — and missed the register students in career guidance actually
 * use. A real message, *"my parents will be angry if I dont pick engineering and I am very
 * stressed"*, fell straight through to retrieval, failed the grounding contract, and answered a
 * frightened seventeen-year-old with *"I don't have anything in the school's guidance materials
 * that answers that."*
 *
 * Family pressure and fear about the future are the **ordinary** emotional content of this
 * product, not the exceptional case, so the ordinary words for them belong here. The additions
 * stay deliberately asymmetric: self-directed feeling always counts, whereas a parent merely
 * *wanting* something does not — "my parents want me to take nursing, is it a good match?" is a
 * career question with family context and answering it is the right thing to do. Only phrasing
 * that states a conflict ("will be angry", "are forcing me", "won't let me") is treated as
 * distress.
 */
const PERSONAL_PATTERNS = new RegExp(
  [
    // "I am so stressed", "I feel hopeless", "I'm really scared"
    String.raw`\bi(?:'m| am)?\s+(?:feel|feeling|felt|get|got)?\s*(?:so|really|very|super|sobrang|too|always)?\s*(?:${DISTRESS_WORDS})\b`,
    // Crisis language, unchanged.
    String.raw`\b(?:kill myself|end my life|self[- ]harm|hurt myself|want to die|ayoko na mabuhay)\b`,
    // Home, where it states a conflict rather than a preference.
    String.raw`\bmy (?:parents|mom|dad|mother|father|family) (?:hate|beat|hit|are divorcing)\b`,
    String.raw`\bmy (?:parents|mom|dad|mother|father|family) (?:will |are |would )?(?:be |get |getting )?(?:angry|mad|furious|disappointed|upset)\b`,
    String.raw`\bmy (?:parents|mom|dad|mother|father|family) (?:are |is )?(?:forcing|pressuring|pushing)\b`,
    String.raw`\bmy (?:parents|mom|dad|mother|father|family) (?:wo|do|does)n(?:'|)t (?:let|approve|allow|support)\b`,
    String.raw`\b(?:forcing|pressuring|pressured) me\b`,
    String.raw`\b(?:bullied|bullying) (?:me|at school)\b`,
    // Filipino, in the same two registers.
    String.raw`\b(?:takot ako|natatakot ako|pagod na ako|stress(?:ed)? ako|nag-?aalala ako|iyak)\b`,
  ].join('|'),
  'i',
);

export function offDomainKind(question: string): OffDomain | null {
  if (PERSONAL_PATTERNS.test(question)) {
    return 'PERSONAL';
  }

  return HOMEWORK_PATTERNS.test(question) ? 'HOMEWORK' : null;
}

/** What a declined question is answered with. Never a bare refusal — always a route to a person. */
export function offDomainReply(kind: OffDomain): string {
  return kind === 'PERSONAL'
    ? 'That sounds like something worth talking through with someone who can really help — please reach out to your guidance counselor, or to a teacher or family member you trust. They can support you far better than I can. I am here whenever you want to talk about your assessment results, careers or programs.'
    : 'I can only help with your assessment results, careers, and college programs — I am not able to help with schoolwork or assignments. Your teacher or guidance counselor is the right person for that. Is there anything about your recommendations I can explain?';
}

/**
 * Whether a question can plausibly be answered from the student's own results alone (Gate 2).
 *
 * Used for the one case where the chat pipeline generates with **no** retrieved passages. That
 * path is right for *"which of my top three pays best?"* — the recommendation data is grounding in
 * its own right — and wrong for *"how much is tuition at that college?"*, where the only thing
 * between the student and an invented figure is a prompt rule an 8B model obeys perhaps four times
 * in five.
 *
 * So the test is lexical and conservative: either the question uses the vocabulary of results, or
 * it names something that is actually in the student's recommendation set. Anything else, with no
 * retrieval behind it, is refused rather than answered.
 */
// Widened 2026-09-13 (AI-COVERAGE-PLAN.md Phase 1): the prompt now carries the Student Brief —
// grades, SCCT constructs, the Holland code and band labels — so questions about those are
// answerable from the student's own data too.
const RESULTS_VOCABULARY =
  /\b(match|matches|matched|score|scores|scoring|rank|ranked|ranking|result|results|recommend|recommended|recommendation|recommendations|top|first|second|third|best|why|riasec|scct|interest|interests|assessment|strand|percent|percentage|my list|these|grade|grades|subject|subjects|math|science|english|average|confidence|efficacy|self efficacy|outcome|outcomes|goal|goals|holland|code|realistic|investigative|artistic|social|enterprising|conventional|band|profile|strength|strengths|weakness|weaknesses)\b/i;

export function answerableFromResults(question: string, resultsContext: string): boolean {
  if (RESULTS_VOCABULARY.test(question)) {
    return true;
  }

  const context = normaliseQuestion(resultsContext);
  const words = normaliseQuestion(question)
    .split(' ')
    .filter((word) => word.length > 3);

  return words.some((word) => context.includes(word));
}
