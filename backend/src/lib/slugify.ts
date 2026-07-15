/**
 * Name parsing and slugging for the roster builder (FULLPLAN §16).
 *
 * Everything here produces a *proposal*. The counselor reviews and edits the result before
 * anything persists, which is the whole reason the preview step exists — so this code is
 * allowed to be a best-effort guess about human names, and must never be the authority on
 * one.
 */

/**
 * ASCII-fold and slug a name fragment: `José Peña` → `josepena`.
 *
 * NFD splits an accented character into its base letter plus a combining mark, and the
 * `\p{Diacritic}` strip then removes the mark — so the fold is a property of Unicode rather
 * than a hand-maintained character table that would be wrong for the next name it met.
 * Anything still not `[a-z0-9]` afterwards (punctuation, apostrophes in `O'Brien`, the space
 * inside `Dela Cruz`) is dropped.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface ParsedName {
  /** The pasted line, trimmed — echoed back so the counselor can see what was parsed. */
  name: string;
  firstName: string;
  /** NULL for a mononym: a one-word name is a name, not an error (§13.1, v1.2). */
  lastName: string | null;
}

/**
 * Split one pasted line into a first and last name (§16).
 *
 * The contract is deliberately blunt: the first whitespace-separated token is the first
 * name, everything after it is the last name (`"Juan Dela Cruz"` → `Juan` / `Dela Cruz`). It
 * gets compound first names and reversed orderings wrong, and that is accepted — the parser
 * proposes, the counselor's edit decides.
 */
export function parseName(line: string): ParsedName {
  const name = line.trim().replace(/\s+/g, ' ');
  const [firstName = '', ...rest] = name.split(' ');

  return {
    name,
    firstName,
    lastName: rest.length > 0 ? rest.join(' ') : null,
  };
}

/**
 * The username a parsed name proposes, before collision handling:
 * `slugify(first) + "." + slugify(last)`, or just `slugify(first)` for a mononym.
 */
export function baseUsername(parsed: ParsedName): string {
  const first = slugify(parsed.firstName);
  const last = parsed.lastName ? slugify(parsed.lastName) : '';

  return last ? `${first}.${last}` : first;
}

/**
 * Resolve `base` against names already taken, suffixing `2`, `3`, … until it is free (§16).
 *
 * `taken` is mutated: a proposal reserves its own username so the *next* line in the same
 * batch collides with it. Two `Juan Dela Cruz`es in one paste must come back as
 * `juan.delacruz` and `juan.delacruz2`, and they only do if the batch remembers itself.
 */
export function resolveUsername(base: string, taken: Set<string>): string {
  let candidate = base;
  let suffix = 2;

  while (taken.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }

  taken.add(candidate);

  return candidate;
}
