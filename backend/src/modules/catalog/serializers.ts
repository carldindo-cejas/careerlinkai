import type { Career, College, EmploymentOutlook, Program } from '@/db/schema';
import type { ResolvedLocation, ResolvedPlace } from '@/modules/catalog/academic-catalog-service';

/**
 * Catalog response shaping (FULLPLAN §17). These are the contract: the frontend's `College`,
 * `Program` and `Career` types in `types/catalog.ts` are the mirror image of what is below.
 *
 * Allow-lists, as everywhere else in this codebase — a field is emitted because it is named
 * here, never because it happens to be on the row. A column added to `careers` next year
 * cannot leak through these.
 */

export interface SerializedEmploymentOutlook {
  id: string;
  name: string;
  display_order: number;
}

export function serializeEmploymentOutlook(
  outlook: EmploymentOutlook,
): SerializedEmploymentOutlook {
  return { id: outlook.id, name: outlook.name, display_order: outlook.displayOrder };
}

export interface SerializedCareer {
  id: string;
  title: string;
  description: string | null;
  /** Raw monthly PHP amounts (migration 0013); the client formats the thousands separators. */
  salary_min: number | null;
  salary_max: number | null;
  employment_outlook_id: string | null;
  /**
   * The resolved outlook `{ id, name }`, when the caller loaded the lookup. Absent (null) where it
   * did not — the recommendation module serializes careers without joining the four-row table, and a
   * card that shows a career's title and Holland code does not need its demand label.
   */
  employment_outlook: { id: string; name: string } | null;
  typical_riasec_code: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

export function serializeCareer(
  career: Career,
  extra: { outlook?: EmploymentOutlook | null } = {},
): SerializedCareer {
  return {
    id: career.id,
    title: career.title,
    description: career.description,
    salary_min: career.salaryMin,
    salary_max: career.salaryMax,
    employment_outlook_id: career.employmentOutlookId,
    employment_outlook: extra.outlook ? { id: extra.outlook.id, name: extra.outlook.name } : null,
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
    // The mapping chips show a career's title and status, not its salary or outlook, so the careers
    // here are serialized without the outlook lookup (`employment_outlook` comes out null).
    ...(careers !== undefined ? { careers: careers.map((career) => serializeCareer(career)) } : {}),
    created_at: program.createdAt,
    updated_at: program.updatedAt,
  };
}

export interface SerializedCollege {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /**
   * The school address (migration 0012). Each level is the resolved `{ id, name }` place or null,
   * present wherever the caller loaded the location; when it did not, all four are null. The raw ids
   * are carried alongside so the edit form's cascading dropdowns can prefill without a second read.
   */
  region: ResolvedPlace | null;
  province: ResolvedPlace | null;
  town: ResolvedPlace | null;
  barangay: ResolvedPlace | null;
  /** A validated Google Maps URL, or null. The details page shows the button only when present. */
  map_link: string | null;
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
  extra: {
    programsCount?: number;
    programs?: SerializedProgram[];
    location?: ResolvedLocation;
  } = {},
): SerializedCollege {
  const location = extra.location;

  return {
    id: college.id,
    name: college.name,
    description: college.description,
    status: college.status,
    region: location?.region ?? null,
    province: location?.province ?? null,
    town: location?.town ?? null,
    barangay: location?.barangay ?? null,
    map_link: college.mapLink,
    ...(extra.programsCount !== undefined ? { programs_count: extra.programsCount } : {}),
    ...(extra.programs !== undefined ? { programs: extra.programs } : {}),
    created_at: college.createdAt,
    updated_at: college.updatedAt,
  };
}
