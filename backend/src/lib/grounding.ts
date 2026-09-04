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

      if (!haystackDigits.includes(value)) {
        problems.push({ sentence, token: value, kind: 'NUMBER' });
      }
    }

    for (const noun of properNounsIn(claim)) {
      if (!haystack.includes(noun.toLowerCase())) {
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

const PERSONAL_PATTERNS =
  /\bi(?:'m| am)?\s+(?:feel|feeling|felt)?\s*(?:so|really|very|super|sobrang)?\s*(?:depressed|hopeless|worthless|suicidal)\b|\b(?:kill myself|end my life|self[- ]harm|hurt myself|want to die|ayoko na mabuhay)\b|\bmy (?:parents|mom|dad|family) (?:hate|beat|hit|are divorcing)\b|\b(?:bullied|bullying) (?:me|at school)\b/i;

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
const RESULTS_VOCABULARY =
  /\b(match|matches|matched|score|scores|scoring|rank|ranked|ranking|result|results|recommend|recommended|recommendation|recommendations|top|first|second|third|best|why|riasec|scct|interest|interests|assessment|strand|percent|percentage|my list|these)\b/i;

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
