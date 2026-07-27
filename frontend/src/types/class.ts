/**
 * Mirrors the backend's ClassResource, ClassStudentResource and ClassSummaryResource
 * (FULLPLAN §13.2). Keep these in lockstep with the API Resources.
 */

export type ClassStatus = 'draft' | 'active' | 'archived';

export type EnrollmentStatus = 'active' | 'removed';

/**
 * A class as its counselor sees it. Carries the join code — this shape must never be
 * rendered on a student-facing screen (§38).
 */
export interface ClassRoom {
  id: string;
  counselor_id: string;
  name: string;
  academic_year: string;
  /**
   * The §13.1 lookup FKs (migration 0017), and **the source of every enrolled student's own grade
   * level and strand**. That is why the class form gained pickers: "Gr 12" typed into a text box
   * produced a profile field §27 could not read and a student could not correct.
   */
  grade_level_id: string | null;
  shs_strand_id: string | null;
  /** The derived text mirror, kept so existing consumers read what they always did. */
  grade_level: string | null;
  /** Resolved for display where the endpoint joined it. */
  shs_strand: string | null;
  join_code: string;
  join_code_expires_at: string | null;
  status: ClassStatus;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A class as a *student* sees it, returned by the join endpoint. Deliberately has no
 * `join_code` and no `counselor_id`: the code is a shared secret and does not travel back
 * out through a student-facing response (§38).
 */
export interface StudentClassSummary {
  id: string;
  name: string;
  academic_year: string;
  grade_level: string | null;
}

/** One row of the current roster. */
export interface RosterEntry {
  id: string;
  class_id: string;
  student_id: string;
  username: string;
  status: EnrollmentStatus;
  joined_at: string | null;
  removed_at: string | null;
  first_name: string | null;
  /** Null for a mononym — a student with one name (§13.1, v1.2). */
  last_name: string | null;
}

/**
 * A proposed student, returned by preview. Nothing has been persisted at this point: the
 * counselor edits this list and sends it back to confirm (§16, §57).
 */
export interface PreviewedStudent {
  /** The pasted line this proposal came from, echoed back. */
  name: string;
  first_name: string;
  last_name: string | null;
  username: string;
}

/** What confirm actually accepts — the reviewed, possibly edited list. */
export interface ConfirmedStudent {
  first_name: string;
  last_name: string | null;
  username: string;
}

export interface Paginated<TItem> {
  items: TItem[];
  pagination: {
    current_page: number;
    per_page: number;
    total: number;
    last_page: number;
  };
}

export interface CreateClassPayload {
  name: string;
  academic_year: string;
  /** Both nullable: a counselor who has not decided yet gets a class whose students stay editable. */
  grade_level_id?: string | null;
  shs_strand_id?: string | null;
}

export interface UpdateClassPayload {
  name?: string | undefined;
  academic_year?: string | undefined;
  grade_level_id?: string | null;
  shs_strand_id?: string | null;
  status?: ClassStatus | undefined;
}

/** The two §13.1 lookups the class form picks from (migration 0017). */
export interface ClassOptions {
  grade_levels: { id: string; code: string; name: string }[];
  shs_strands: { id: string; code: string; name: string; description: string | null }[];
}

/** A student's display name, which for a mononym is just the one name they have. */
export function fullName(person: { first_name: string | null; last_name: string | null }): string {
  return [person.first_name, person.last_name].filter(Boolean).join(' ');
}
