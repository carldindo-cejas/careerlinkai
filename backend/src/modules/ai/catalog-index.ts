import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  careers,
  colleges,
  employmentOutlooks,
  programCatalog,
  provinces,
  towns,
} from '@/db/schema';
import {
  CAREER_ALIASES,
  CATALOG_GAPS,
  VAGUE_CAREER_TERMS,
  type CatalogGap,
  type VagueCareerTerm,
} from '@/knowledge/catalog-vocabulary';
import { campusName, collegeAliases, institutionName } from '@/lib/aliases';
import { normaliseQuestion } from '@/lib/grounding';
import { log } from '@/lib/logger';

/**
 * **The catalog as something a question can be matched against** (AI-COVERAGE-PLAN.md Phase 2).
 *
 * Gate 2 answers lookups — "where is HNU", "which colleges offer BSCS in Tagbilaran", "what careers
 * come after BS Accountancy" — from rows rather than from a model. That needs the names students
 * type mapped to catalog ids: full names, institution names without the campus, computed aliases
 * (`lib/aliases.ts`), program codes and short forms, career titles, their plurals and the everyday
 * names students use for them (`knowledge/catalog-vocabulary.ts`), towns and the province.
 *
 * The catalog is small (22 colleges, 41 canonical programs, 108 careers), so the whole index is
 * three D1 reads. Cached in KV for ten minutes when a namespace is given — a chat turn is budgeted
 * against the Free plan's 50 subrequests (§45), and one KV read is cheaper than three queries. A
 * stale entry for ten minutes after an admin edit is the accepted cost; the cache is optional and
 * the suite runs without it.
 */

export interface CollegeEntry {
  id: string;
  name: string;
  /** Normalised full name, institution name, campus and aliases — every form a student types. */
  forms: string[];
  campus: string | null;
  aliases: string[];
  town: string | null;
  province: string | null;
  mapLink: string | null;
}

export interface CareerEntry {
  id: string;
  title: string;
  forms: string[];
  description: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  outlook: string | null;
  riasec: string | null;
}

export interface ProgramEntry {
  /** `program_catalog.id` — the canonical program, not one college's offering. */
  id: string;
  name: string;
  forms: string[];
}

export interface PlaceEntry {
  label: string;
  kind: 'town' | 'province';
  forms: string[];
}

export interface CatalogIndex {
  colleges: CollegeEntry[];
  careers: CareerEntry[];
  programs: ProgramEntry[];
  places: PlaceEntry[];
  /** Province names the catalog covers — "Bohol". Used to say where the catalog stops. */
  provinces: string[];
}

// v2 (2026-09-13): career forms carry aliases and lose names another entry also claims.
const CACHE_KEY = 'chat:catalog-index:v2';
const CACHE_TTL_SECONDS = 600;

/** Words that never distinguish one title from another, dropped when building initials. */
const FILLER = new Set([
  'bs',
  'ab',
  'of',
  'and',
  'in',
  'the',
  'for',
  'bachelor',
  'science',
  'arts',
]);

/** Short program forms that are also ordinary words. */
const SHORT_FORM_STOP = new Set(['for', 'arts', 'fish']);

/** " civil engineer " inside " where do civil engineers work " — word-bounded containment. */
export function containsPhrase(asked: string, phrase: string): boolean {
  return phrase !== '' && ` ${asked} `.includes(` ${phrase} `);
}

/** "Certified Public Accountant" → "cpa". Null when shorter than three letters. */
export function initialsOf(name: string): string | null {
  const letters = normaliseQuestion(name)
    .split(' ')
    .filter((word) => word !== '' && !FILLER.has(word))
    .map((word) => word[0])
    .join('');

  return letters.length >= 3 ? letters : null;
}

/** `CAREER_ALIASES` by normalised title, so an admin re-capitalising a title does not orphan them. */
const ALIASES_BY_TITLE = new Map(
  Object.entries(CAREER_ALIASES).map(([title, aliases]) => [normaliseQuestion(title), aliases]),
);

/** Title, plural, initials, and the everyday names students use ("nurse", "pulis"). */
export function careerForms(title: string): string[] {
  const normalised = normaliseQuestion(title);
  const forms = [normalised];

  if (!normalised.endsWith('s')) {
    forms.push(`${normalised}s`);
  }

  const initials = initialsOf(title);

  if (initials !== null) {
    forms.push(initials);
  }

  forms.push(...(ALIASES_BY_TITLE.get(normalised) ?? []));

  return [...new Set(forms)];
}

/**
 * **Each name points to one thing** (IMPLEMENT-kb-grounding.md §6.1). A career form that another
 * career also has, or that is a program's name or code, is dropped from the career: a question
 * bound to two things gets whichever the resolver happens to prefer. In the seed, "Business Systems
 * Analyst" has the initials `bsa` — BS Accountancy's code — so "where to study BSA" answered about
 * the career. A career's own title and its plural are never dropped.
 *
 * Returns the kept forms, in the order of `careers`.
 */
export function exclusiveCareerForms(
  careers: { title: string; forms: string[] }[],
  programNames: string[],
): string[][] {
  const taken = new Set(programNames);
  const owners = new Map<string, number>();

  for (const career of careers) {
    for (const form of new Set(career.forms)) {
      owners.set(form, (owners.get(form) ?? 0) + 1);
    }
  }

  return careers.map((career) => {
    const title = normaliseQuestion(career.title);

    return career.forms.filter(
      (form) =>
        form === title || form === `${title}s` || (owners.get(form) === 1 && !taken.has(form)),
    );
  });
}

/**
 * "BS Information Technology" (BSIT) → the full name, "information technology", "bsit".
 * "BS Criminology" (BSCRIM) → also "criminology" and "crim". Single-word short names must be at
 * least six letters ("nursing", "accountancy") so a stray common word cannot bind a program.
 */
export function programForms(name: string, code: string | null): string[] {
  const normalised = normaliseQuestion(name);
  const forms = [normalised];
  const stripped = normalised.replace(
    /^(?:bachelor of science in|bachelor of arts in|bachelor of|bachelor in|bs|ab)\s+/,
    '',
  );

  if (stripped !== normalised && (stripped.includes(' ') || stripped.length >= 6)) {
    forms.push(stripped);
  }

  if (code !== null && code.trim() !== '') {
    const lower = code.trim().toLowerCase();

    if (lower.length >= 3) {
      forms.push(lower);
    }

    const short = lower.replace(/^(?:bs|ab)/, '');

    if (short.length >= 4 && !SHORT_FORM_STOP.has(short)) {
      forms.push(short);
    }
  }

  return [...new Set(forms)];
}

/** The candidate with the longest form found in the question, or null. */
export function bestMatch<T>(
  asked: string,
  candidates: { row: T; forms: string[] }[],
): T | null {
  let best: { row: T; length: number } | null = null;

  for (const candidate of candidates) {
    for (const form of candidate.forms) {
      if (containsPhrase(asked, form) && (best === null || form.length > best.length)) {
        best = { row: candidate.row, length: form.length };
      }
    }
  }

  return best?.row ?? null;
}

/** Every candidate named in the question, in order of first mention. */
export function allMatches<T>(asked: string, candidates: { row: T; forms: string[] }[]): T[] {
  const hits: { row: T; at: number }[] = [];

  for (const candidate of candidates) {
    const positions = candidate.forms
      .filter((form) => containsPhrase(asked, form))
      .map((form) => ` ${asked} `.indexOf(` ${form} `));

    if (positions.length > 0) {
      hits.push({ row: candidate.row, at: Math.min(...positions) });
    }
  }

  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.row);
}

/**
 * The colleges a question names. A student who writes "BISU" means every BISU campus; one who writes
 * "BISU Bilar" means one. So an alias or institution-name hit returns the whole group, and a campus
 * word in the same question narrows it.
 */
export function matchColleges(asked: string, index: CatalogIndex): CollegeEntry[] {
  let bestScore = 0;
  let best: CollegeEntry[] = [];

  for (const college of index.colleges) {
    const full = normaliseQuestion(college.name);
    let score = 0;

    if (containsPhrase(asked, full)) {
      score = 4;
    } else if (college.forms.some((form) => form !== full && containsPhrase(asked, form))) {
      score = 2;

      if (college.campus !== null && containsPhrase(asked, college.campus)) {
        score = 3;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = [college];
    } else if (score > 0 && score === bestScore) {
      best.push(college);
    }
  }

  return best;
}

export function matchPlace(asked: string, index: CatalogIndex): PlaceEntry | null {
  return bestMatch(
    asked,
    index.places.map((place) => ({ row: place, forms: place.forms })),
  );
}

export function collegesIn(place: PlaceEntry, index: CatalogIndex): CollegeEntry[] {
  return index.colleges.filter((college) =>
    place.kind === 'town' ? college.town === place.label : college.province === place.label,
  );
}

/** Words after "in"/"near" that are not places. */
const NOT_A_PLACE = new Set([
  'my',
  'the',
  'a',
  'an',
  'this',
  'that',
  'your',
  'our',
  'college',
  'colleges',
  'school',
  'schools',
  'demand',
  'general',
  'order',
  'terms',
  'english',
  'math',
  'science',
  'high',
  // "…program in senior high school" named a place called "senior" (production, 2026-09-13).
  'senior',
  'junior',
  'shs',
  'grade',
  'public',
  'private',
  'region',
  'it',
  'is',
  'there',
  'here',
  'what',
  'which',
  'any',
  'all',
  'same',
  'future',
  'addition',
  'case',
  'life',
  'person',
  'campus',
  'town',
  'city',
  'province',
  'area',
  'me',
]);

/**
 * The place a question names that the catalog does not cover — "Cebu" in "what colleges in Cebu
 * offer BSCS". Used only to add one true sentence ("this catalog lists colleges in Bohol only"),
 * never to decide an answer, so a false positive costs a redundant sentence.
 */
export function unknownPlaceIn(asked: string, index: CatalogIndex): string | null {
  const match = /\b(?:in|near|around|within|sa)\s+([a-z]{3,})\b/.exec(asked);

  if (match === null) {
    return null;
  }

  const word = match[1]!;

  if (NOT_A_PLACE.has(word) || matchPlace(word, index) !== null) {
    return null;
  }

  const named = [
    ...index.colleges.flatMap((college) => college.forms),
    ...index.programs.flatMap((program) => program.forms),
    ...index.careers.flatMap((career) => career.forms),
  ];

  return named.some((form) => form.split(' ').includes(word)) ? null : word;
}

/**
 * The not-offered program a question names ("I want to be a doctor"), unless the live catalog now
 * offers it — then the ordinary lookup answers. Null on an empty index: a failed load must never
 * reach a student as "no college offers this".
 */
export function catalogGapFor(asked: string, index: CatalogIndex): CatalogGap | null {
  if (index.programs.length === 0) return null;

  const gap = bestMatch(
    asked,
    CATALOG_GAPS.map((row) => ({ row, forms: [...row.forms] })),
  );

  if (gap === null) return null;

  const offered = index.programs.some((program) =>
    program.forms.some((form) => gap.offeredAs.some((phrase) => containsPhrase(form, phrase))),
  );

  return offered ? null : gap;
}

/** "Engineer", "teacher", "seaman" — a word that covers several careers. */
export function vagueTermFor(asked: string): VagueCareerTerm | null {
  return bestMatch(
    asked,
    VAGUE_CAREER_TERMS.map((row) => ({ row, forms: [...row.forms] })),
  );
}

/** Load the index, from KV when it is there. Never throws: a failure returns an empty index. */
export async function loadCatalogIndex(
  db: Database,
  cache?: KVNamespace,
): Promise<CatalogIndex> {
  if (cache !== undefined) {
    try {
      const cached = await cache.get<CatalogIndex>(CACHE_KEY, 'json');

      if (cached !== null && Array.isArray(cached.colleges)) {
        return cached;
      }
    } catch {
      // A cache that cannot be read is a slower lookup, not a failed one.
    }
  }

  try {
    const index = await buildIndex(db);

    if (cache !== undefined) {
      try {
        await cache.put(CACHE_KEY, JSON.stringify(index), { expirationTtl: CACHE_TTL_SECONDS });
      } catch {
        // Same: an unwritable cache must not fail the turn.
      }
    }

    return index;
  } catch (error) {
    log('error', 'catalog_index.load_failed', {
      pipeline: 'chat',
      error: error instanceof Error ? error.message : String(error),
    });

    return { colleges: [], careers: [], programs: [], places: [], provinces: [] };
  }
}

async function buildIndex(db: Database): Promise<CatalogIndex> {
  const collegeRows = await db
    .select({
      id: colleges.id,
      name: colleges.name,
      mapLink: colleges.mapLink,
      town: towns.name,
      province: provinces.name,
    })
    .from(colleges)
    .leftJoin(towns, eq(colleges.townId, towns.id))
    .leftJoin(provinces, eq(colleges.provinceId, provinces.id))
    .where(and(eq(colleges.status, 'active'), isNull(colleges.deletedAt)));

  const careerRows = await db
    .select({
      id: careers.id,
      title: careers.title,
      description: careers.description,
      salaryMin: careers.salaryMin,
      salaryMax: careers.salaryMax,
      riasec: careers.typicalRiasecCode,
      outlook: employmentOutlooks.name,
    })
    .from(careers)
    .leftJoin(employmentOutlooks, eq(careers.employmentOutlookId, employmentOutlooks.id))
    .where(and(eq(careers.status, 'active'), isNull(careers.deletedAt)));

  const programRows = await db
    .select({ id: programCatalog.id, name: programCatalog.name, code: programCatalog.code })
    .from(programCatalog)
    .where(and(eq(programCatalog.status, 'active'), isNull(programCatalog.deletedAt)));

  const collegeEntries: CollegeEntry[] = collegeRows.map((row) => {
    const aliases = collegeAliases(row.name).map((alias) => alias.toLowerCase());
    const campus = campusName(row.name);

    return {
      id: row.id,
      name: row.name,
      forms: [
        ...new Set([
          normaliseQuestion(row.name),
          normaliseQuestion(institutionName(row.name)),
          ...aliases,
        ]),
      ],
      campus: campus === null ? null : normaliseQuestion(campus),
      aliases: collegeAliases(row.name),
      town: row.town,
      province: row.province,
      mapLink: row.mapLink,
    };
  });

  const places = new Map<string, PlaceEntry>();

  for (const row of collegeRows) {
    if (row.town !== null) {
      const town = normaliseQuestion(row.town);
      places.set(`town:${row.town}`, {
        label: row.town,
        kind: 'town',
        forms: [...new Set([town, town.replace(/\s+city$/, '')])],
      });
    }

    if (row.province !== null) {
      places.set(`province:${row.province}`, {
        label: row.province,
        kind: 'province',
        forms: [normaliseQuestion(row.province)],
      });
    }
  }

  const programEntries: ProgramEntry[] = programRows.map((row) => ({
    id: row.id,
    name: row.name,
    forms: programForms(row.name, row.code),
  }));
  const careerEntries = careerRows.map((row) => ({ ...row, forms: careerForms(row.title) }));
  const kept = exclusiveCareerForms(
    careerEntries,
    programEntries.flatMap((program) => program.forms),
  );

  return {
    colleges: collegeEntries,
    careers: careerEntries.map((career, i) => ({ ...career, forms: kept[i]! })),
    programs: programEntries,
    places: [...places.values()],
    provinces: [
      ...new Set(collegeRows.map((row) => row.province).filter((p): p is string => p !== null)),
    ],
  };
}
