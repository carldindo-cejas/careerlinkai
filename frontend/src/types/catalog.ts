/**
 * Mirrors the backend's CollegeResource, ProgramResource and CareerResource
 * (FULLPLAN §13.3). Keep these in lockstep with the API Resources.
 */

/** Colleges and careers have two states. Programs have three — see ProgramStatus. */
export type CatalogStatus = 'active' | 'archived';

/** `draft` is a program the admin has entered but is not offering. §27 will not rank it. */
export type ProgramStatus = 'draft' | 'active' | 'archived';

/**
 * The two-value strand domain (§13.1, v1.1). Deliberately coarse: it is an eligibility
 * gate, and RIASEC does the fine-grained interest matching (§27).
 */
export type Strand = 'Academic' | 'Technical-Professional';

/** A resolved reference row — an address level, or an employment outlook: the id plus its label. */
export interface Place {
  id: string;
  name: string;
}

/** The employment-outlook lookup that populates the careers dropdown (backend migration 0013). */
export interface EmploymentOutlook {
  id: string;
  name: string;
  display_order: number;
}

export interface Career {
  id: string;
  title: string;
  description: string | null;
  /** Raw monthly PHP amounts (migration 0013). Both null, or both set with min < max. */
  salary_min: number | null;
  salary_max: number | null;
  employment_outlook_id: string | null;
  /**
   * The resolved outlook, or null where the API did not load the lookup.
   *
   * `display_order` travels with it because the outlook is a **curated sequence** — Low → Moderate
   * → High → Emerging — not an alphabet. The "sort by job outlook" control has no other way to know
   * that "Emerging Field" outranks "Low Demand"; sorting on the name would order them E, H, L, M,
   * which is not a ranking of anything.
   */
  employment_outlook: (Place & { display_order: number }) | null;
  /**
   * A Holland code, e.g. "IEC" — up to three distinct RIASEC letters, most dominant
   * first. Null is valid: the career is in the catalog but cannot be RIASEC-matched.
   */
  typical_riasec_code: string | null;
  status: CatalogStatus;
  created_at: string | null;
  updated_at: string | null;
}

export interface Program {
  id: string;
  college_id: string;
  code: string;
  name: string;
  department_name: string | null;
  description: string | null;
  /** Null means "no strand requirement" — §27 scores that as a full 100, not as a gap. */
  recommended_strand: Strand | null;
  status: ProgramStatus;
  /**
   * Which canonical program this offering is (migration 0018) — what makes "which colleges offer
   * this?" a join rather than a string match. NULL means nobody has decided yet, which the UI
   * states rather than hides.
   */
  program_catalog_id: string | null;
  /** Resolved where the endpoint joined it. */
  canonical?: CanonicalProgram | null;
  /** Present only where the API loaded the mapping (the nested college view). */
  careers?: LinkedCareer[];
  created_at: string | null;
  updated_at: string | null;
}

/**
 * How strongly a program leads to a career (backend migration 0041). `direct` is the natural
 * destination and counts fully; `related` and `conditional` count for less, per the formula.
 */
export type LinkRelationship = 'direct' | 'related' | 'conditional';

export const LINK_RELATIONSHIPS: { value: LinkRelationship; label: string; hint: string }[] = [
  { value: 'direct', label: 'Direct', hint: "The program's natural destination." },
  { value: 'related', label: 'Related', hint: 'A common path for its graduates.' },
  {
    value: 'conditional',
    label: 'Conditional',
    hint: 'Reachable with an extra credential or licence.',
  },
];

/**
 * A career on one college offering's mapping (backend migration 0040). `inherited` is true when the
 * link comes from the offering's canonical program — it applies to every college offering it and is
 * removed on the Canonical programs page — and false for this college's own extra. `relationship`
 * (migration 0041) is how strongly the program leads there.
 */
export type LinkedCareer = Career & { inherited?: boolean; relationship?: LinkRelationship };

/**
 * A program as a thing in the world — "BS Computer Science" — of which each `Program` is one
 * college's offering (migration 0018).
 */
export interface CanonicalProgram {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: CatalogStatus;
  /**
   * The strand its offerings default to (migration 0040). Changing it writes the new value to every
   * offering; a campus may still differ afterwards. Null means "no strand requirement".
   */
  recommended_strand: Strand | null;
  /** On the admin list only: how many live college offerings point here. */
  offerings_count?: number;
  /** What it leads to (migration 0040) — on the admin list and the link responses. */
  careers?: LinkedCareer[];
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateCanonicalProgramPayload {
  code: string;
  name: string;
  description?: string | null;
  recommended_strand?: Strand | null;
}

export type UpdateCanonicalProgramPayload = Partial<
  CreateCanonicalProgramPayload & { status: CatalogStatus }
>;

/** One college's offering of a canonical program, as the student-facing lists return it. */
export interface ProgramOffering {
  college: College;
  program: Program;
}

export interface College {
  id: string;
  name: string;
  description: string | null;
  status: CatalogStatus;
  /** The school address (migration 0012) — each level resolved to `{ id, name }`, or null. */
  region: Place | null;
  province: Place | null;
  town: Place | null;
  barangay: Place | null;
  /** A validated Google Maps URL, or null ("No map available"). */
  map_link: string | null;
  /** On the list endpoint. */
  programs_count?: number;
  /** On GET /colleges/{id}, which nests the programs (§20). */
  programs?: Program[];
  created_at: string | null;
  updated_at: string | null;
}

/** The four address ids sent on create/update — null clears a level, undefined leaves it. */
export interface CollegeAddressPayload {
  region_id?: string | null;
  province_id?: string | null;
  town_id?: string | null;
  barangay_id?: string | null;
}

export interface CreateCollegePayload extends CollegeAddressPayload {
  name: string;
  description?: string | undefined;
  map_link?: string | null;
}

export interface UpdateCollegePayload extends CollegeAddressPayload {
  name?: string | undefined;
  description?: string | undefined;
  status?: CatalogStatus | undefined;
  map_link?: string | null;
}

export interface CreateProgramPayload {
  code: string;
  name: string;
  department_name?: string | undefined;
  description?: string | undefined;
  /** Explicitly nullable, not optional: null is the "no requirement" claim. */
  recommended_strand: Strand | null;
  status?: ProgramStatus | undefined;
  /**
   * **Omitted** means "work it out from the code" — the normal path, and why adding a program
   * never requires visiting the canonical page first. An explicit `null` means "not yet decided",
   * which is a different and legitimate state.
   */
  program_catalog_id?: string | null;
}

export type UpdateProgramPayload = Partial<CreateProgramPayload>;

export interface CreateCareerPayload {
  title: string;
  description?: string | undefined;
  /** Raw numbers, not formatted strings — the form strips the separators before sending. */
  salary_min?: number | null;
  salary_max?: number | null;
  employment_outlook_id?: string | null;
  typical_riasec_code: string | null;
}

export interface UpdateCareerPayload extends Partial<CreateCareerPayload> {
  status?: CatalogStatus | undefined;
}

export const STRANDS: Strand[] = ['Academic', 'Technical-Professional'];

/** The six RIASEC dimensions, in their canonical order. */
export const RIASEC_LETTERS = ['R', 'I', 'A', 'S', 'E', 'C'] as const;

export const RIASEC_NAMES: Record<string, string> = {
  R: 'Realistic',
  I: 'Investigative',
  A: 'Artistic',
  S: 'Social',
  E: 'Enterprising',
  C: 'Conventional',
};

/** "IEC" → "Investigative · Enterprising · Conventional", for anyone who does not read codes. */
export function describeHollandCode(code: string | null): string | null {
  if (!code) return null;

  return code
    .split('')
    .map((letter) => RIASEC_NAMES[letter] ?? letter)
    .join(' · ');
}

/** `40000` → `"40,000"`. The thousands-separated view of a raw amount, for display and inputs. */
export function formatThousands(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The two salary columns rendered as one line — `"₱40,000 – ₱120,000 / mo"` — or null when the
 * career has no salary on file. The database stores raw numbers (migration 0013); this is the only
 * place the peso sign and separators live.
 */
export function formatSalaryRange(
  min: number | null,
  max: number | null,
): string | null {
  if (min === null || max === null) return null;

  return `₱${formatThousands(min)} – ₱${formatThousands(max)} / mo`;
}

// --- The mapping as a spreadsheet (backend 2026-09-22) ---------------------------------------

/** One canonical link, as exported. */
export interface MappingExportRow {
  program_code: string;
  program_name: string;
  career_title: string;
  career_riasec_code: string | null;
  relationship: LinkRelationship;
}

/** One spreadsheet line, as imported. Extra columns are ignored; blanks are meaningful. */
export interface MappingImportRow {
  program_code: string;
  career_title: string;
  relationship: string;
}

export interface PlannedLink {
  program_code: string;
  career_title: string;
  relationship: LinkRelationship;
}

/** What an import would do (preview) or did (apply) — to the programs the file names, only. */
export interface MappingImportPlan {
  programs_in_file: number;
  adds: PlannedLink[];
  removes: PlannedLink[];
  regrades: (PlannedLink & { from: LinkRelationship })[];
  unchanged: number;
  /** `line` is the spreadsheet line — 1 is the header. */
  errors: { line: number; message: string }[];
}
