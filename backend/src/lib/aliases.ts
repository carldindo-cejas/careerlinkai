/**
 * The short names students actually type for a college (AI-COVERAGE-PLAN.md Phase 2, 2026-09-13).
 *
 * Measured on production: *"HNU located"* was refused as an unsupported claim, because the model
 * correctly expanded the acronym and no passage contained the string "HNU". *"location of HNU"*
 * reached no college at all. A student writes HNU, UB, BISU, TPC and BIT far more often than the
 * full name.
 *
 * **Computed, not stored.** The plan proposed an `aliases` column seeded for the 22 Bohol colleges.
 * Deriving them instead needs no migration, no admin screen, and keeps working when the Region VII
 * seed is regenerated (which deletes and re-inserts every college) — the seed generator would
 * otherwise have to learn a second list and keep it in step. What is lost is the ability to add an
 * alias no rule produces; nothing in the current catalog needs one.
 *
 * Two sources, both conservative:
 *
 *   * **All-caps words** already in the name — "BIT International College" → `BIT`.
 *   * **Initials** of the institution part — the text before " - ", so "Bohol Island State
 *     University - Bilar Campus" → `BISU`. Three letters or more, except a short list of two-letter
 *     ones that are real and unambiguous (`UB`, `BC`). Two-letter initials in general are refused:
 *     "CE" is civil engineering, "IT" is a program, "PE" is a subject.
 *
 * Pure string work; no I/O.
 */

/** Words that do not contribute an initial. */
const NON_INITIAL_WORDS = new Set(['of', 'and', 'the', 'de', 'del', 'la', 'sa', 'ng', 'e']);

/** Two-letter initials that collide with program names, subjects or common words. */
const AMBIGUOUS_SHORT = new Set([
  'ce',
  'it',
  'is',
  'hr',
  'pe',
  'me',
  'ee',
  'ba',
  'ab',
  'bs',
  'ms',
  'ma',
  'am',
  'pm',
]);

/** The institution half of a campus name: "Bohol Island State University - Bilar Campus" → its base. */
export function institutionName(name: string): string {
  return name.split(/\s+[-–—]\s+/)[0]!.trim();
}

/** The campus half, when the name has one: "Bilar Campus" → "Bilar". Null otherwise. */
export function campusName(name: string): string | null {
  const parts = name.split(/\s+[-–—]\s+/);

  if (parts.length < 2) {
    return null;
  }

  return (
    parts
      .slice(1)
      .join(' ')
      .replace(/\bcampus\b/i, '')
      .trim() || null
  );
}

/** Upper-case aliases for a college name. Empty when no rule produces a safe one. */
export function collegeAliases(name: string): string[] {
  const base = institutionName(name);
  const words = base.split(/\s+/).filter((word) => word !== '');
  const aliases = new Set<string>();

  for (const word of words) {
    if (/^[A-Z]{2,}$/.test(word)) {
      aliases.add(word);
    }
  }

  const initials = words
    .filter((word) => !NON_INITIAL_WORDS.has(word.toLowerCase()))
    .map((word) => word.replace(/[^\p{L}]/gu, '')[0] ?? '')
    .join('')
    .toUpperCase();

  const acceptable =
    initials.length >= 3 ||
    (initials.length === 2 && !AMBIGUOUS_SHORT.has(initials.toLowerCase()));

  // A name that is already one all-caps word ("BIT") would otherwise alias to itself.
  if (acceptable && initials !== base.toUpperCase().replace(/\s+/g, '')) {
    aliases.add(initials);
  }

  return [...aliases];
}
