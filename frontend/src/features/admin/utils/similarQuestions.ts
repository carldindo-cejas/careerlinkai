/**
 * **Which other backlog rows look like rephrasings of this one** (found testing on production).
 *
 * Students ask one thing many ways. On 2026-09-11 the live backlog carried "Where is Holy Name
 * University located?", "HNU located" and "location of HNU" as three separate rows, so answering
 * one left two behind and split the ask count three ways. This finds the likely siblings so the
 * answer form can offer them.
 *
 * ## Suggestions, never decisions
 *
 * Everything here is lexical, and lexical similarity is wrong in a way that matters: "What colleges
 * in Cebu offer BS Computer Science?" and "…in Bohol?" share every word but one and are different
 * questions. So the caller only ever *offers* these — unticked — and nothing is resolved that a
 * person did not choose. A wrong suggestion costs a glance; a wrong automatic resolution hides a
 * real gap. That asymmetry is why this is allowed to be generous.
 *
 * ## How it measures
 *
 * Content words only, each cut to its first five letters so "located"/"location" and
 * "college"/"colleges" meet, plus the initials of any run of capitalised words — which is what
 * lets "Holy Name University" meet "HNU". Scored by overlap against the *shorter* question, because
 * "HNU located" is a complete rephrasing of the long form, not a fifth of it. At least two shared
 * words are required, so one common noun cannot pair two unrelated questions.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'am', 'of', 'in', 'on', 'at', 'to', 'for',
  'from', 'by', 'with', 'about', 'and', 'or', 'if', 'what', 'whats', 'where', 'when', 'which',
  'who', 'why', 'how', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'i', 'me',
  'my', 'you', 'your', 'it', 'its', 'there', 'this', 'that', 'these', 'those', 'any', 'some',
  'tell', 'please', 'know', 'get', 'take', 'want', 'like', 'much', 'many', 'ano', 'saan', 'ang',
  'ng', 'sa', 'mga',
]);

const MIN_SHARED = 2;
const THRESHOLD = 0.6;

function initialsOf(question: string): string[] {
  const runs = question.match(/(?:\b[A-Z][a-z]+\b\s*){2,}/g) ?? [];

  return runs.map((run) =>
    run
      .trim()
      .split(/\s+/)
      .map((word) => word[0]!.toLowerCase())
      .join(''),
  );
}

export function questionTerms(question: string): Set<string> {
  const words = question
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map((word) => (word.length > 5 ? word.slice(0, 5) : word));

  return new Set([...words, ...initialsOf(question)]);
}

/** How much of the shorter question the longer one covers, 0–1, or 0 below `MIN_SHARED`. */
export function questionSimilarity(a: string, b: string): number {
  const left = questionTerms(a);
  const right = questionTerms(b);
  let shared = 0;

  for (const term of left) {
    if (right.has(term)) {
      shared += 1;
    }
  }

  if (shared < MIN_SHARED) {
    return 0;
  }

  return shared / Math.min(left.size, right.size);
}

/** The likeliest rephrasings of `target` among `candidates`, most similar first. */
export function similarQuestions(target: string, candidates: string[], limit = 5): string[] {
  return candidates
    .filter((candidate) => candidate !== target)
    .map((candidate) => ({ candidate, score: questionSimilarity(target, candidate) }))
    .filter(({ score }) => score >= THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
