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

export interface Career {
  id: string;
  title: string;
  description: string | null;
  salary_range: string | null;
  employment_outlook: string | null;
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
  /** Present only where the API loaded the mapping (the nested college view). */
  careers?: Career[];
  created_at: string | null;
  updated_at: string | null;
}

export interface College {
  id: string;
  name: string;
  description: string | null;
  status: CatalogStatus;
  /** On the list endpoint. */
  programs_count?: number;
  /** On GET /colleges/{id}, which nests the programs (§20). */
  programs?: Program[];
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateCollegePayload {
  name: string;
  description?: string | undefined;
}

export interface UpdateCollegePayload {
  name?: string | undefined;
  description?: string | undefined;
  status?: CatalogStatus | undefined;
}

export interface CreateProgramPayload {
  code: string;
  name: string;
  department_name?: string | undefined;
  description?: string | undefined;
  /** Explicitly nullable, not optional: null is the "no requirement" claim. */
  recommended_strand: Strand | null;
  status?: ProgramStatus | undefined;
}

export type UpdateProgramPayload = Partial<CreateProgramPayload>;

export interface CreateCareerPayload {
  title: string;
  description?: string | undefined;
  salary_range?: string | undefined;
  employment_outlook?: string | undefined;
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
