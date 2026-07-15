import type { Career, College, Program } from '@/db/schema';

/**
 * Catalog response shaping (FULLPLAN §17). These are the contract: the frontend's `College`,
 * `Program` and `Career` types in `types/catalog.ts` are the mirror image of what is below.
 *
 * Allow-lists, as everywhere else in this codebase — a field is emitted because it is named
 * here, never because it happens to be on the row. A column added to `careers` next year
 * cannot leak through these.
 */

export interface SerializedCareer {
  id: string;
  title: string;
  description: string | null;
  salary_range: string | null;
  employment_outlook: string | null;
  typical_riasec_code: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

export function serializeCareer(career: Career): SerializedCareer {
  return {
    id: career.id,
    title: career.title,
    description: career.description,
    salary_range: career.salaryRange,
    employment_outlook: career.employmentOutlook,
    typical_riasec_code: career.typicalRiasecCode,
    status: career.status,
    created_at: career.createdAt,
    updated_at: career.updatedAt,
  };
}

export interface SerializedProgram {
  id: string;
  college_id: string;
  code: string;
  name: string;
  department_name: string | null;
  description: string | null;
  recommended_strand: string | null;
  status: string;
  /** Present only where the API loaded the mapping — the frontend types it optional. */
  careers?: SerializedCareer[];
  created_at: string | null;
  updated_at: string | null;
}

/**
 * `careers` is included wherever the mapping was loaded, and **archived careers are included
 * with it**, carrying their `status`.
 *
 * That is deliberate: archiving a career is not unlinking it (§20). The link survives, the
 * admin still sees the chip — struck through, "archived — not counted" — and restoring the
 * career brings its vote back rather than asking them to re-link it by hand. What archiving
 * changes is that §27 stops counting it, which is a *scoring* decision made in
 * `rankablePrograms()`, not a serialization one made here.
 */
export function serializeProgram(program: Program, careers?: Career[]): SerializedProgram {
  return {
    id: program.id,
    college_id: program.collegeId,
    code: program.code,
    name: program.name,
    department_name: program.departmentName,
    description: program.description,
    recommended_strand: program.recommendedStrand,
    status: program.status,
    ...(careers !== undefined ? { careers: careers.map(serializeCareer) } : {}),
    created_at: program.createdAt,
    updated_at: program.updatedAt,
  };
}

export interface SerializedCollege {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** On the list endpoint only — the count, never the programs themselves. */
  programs_count?: number;
  /** On `GET /admin/colleges/{id}` only, which nests them (§20). */
  programs?: SerializedProgram[];
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A college on its own. `programs_count` and `programs` are mutually exclusive in practice —
 * the list endpoint carries the count, the detail endpoint carries the programs — and neither
 * is emitted unless the caller loaded it. An absent key is honest about what was fetched; a
 * `programs: []` on a list row would be a lie about a college with three programs.
 */
export function serializeCollege(
  college: College,
  extra: { programsCount?: number; programs?: SerializedProgram[] } = {},
): SerializedCollege {
  return {
    id: college.id,
    name: college.name,
    description: college.description,
    status: college.status,
    ...(extra.programsCount !== undefined ? { programs_count: extra.programsCount } : {}),
    ...(extra.programs !== undefined ? { programs: extra.programs } : {}),
    created_at: college.createdAt,
    updated_at: college.updatedAt,
  };
}
