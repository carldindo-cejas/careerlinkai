import type { ClassRoom } from '@/db/schema';

/**
 * Class response shaping (FULLPLAN §17). These are the contract — the frontend's `ClassRoom`
 * and `StudentClassSummary` types are the mirror image of the two functions below.
 *
 * The reason there are *two* serializers for one table is the whole point of this file: a
 * class means something different depending on who is looking at it.
 */

export interface SerializedClass {
  id: string;
  counselor_id: string;
  name: string;
  academic_year: string;
  grade_level: string | null;
  join_code: string;
  join_code_expires_at: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

/** A class as its **counselor** sees it. Carries the join code. */
export function serializeClass(classRoom: ClassRoom): SerializedClass {
  return {
    id: classRoom.id,
    counselor_id: classRoom.counselorId,
    name: classRoom.name,
    academic_year: classRoom.academicYear,
    grade_level: classRoom.gradeLevel,
    join_code: classRoom.joinCode,
    join_code_expires_at: classRoom.joinCodeExpiresAt,
    status: classRoom.status,
    created_at: classRoom.createdAt,
    updated_at: classRoom.updatedAt,
  };
}

export interface SerializedClassSummary {
  id: string;
  name: string;
  academic_year: string;
  grade_level: string | null;
}

/**
 * A class as a **student** sees it, returned by the join endpoint.
 *
 * No `join_code` and no `counselor_id`. The code is a shared secret and does not travel back
 * out through a student-facing response (§38) — which is why this is a separate function and
 * not `serializeClass` with a couple of fields deleted on the way out. An allow-list cannot
 * leak a field someone adds to the table next year; a deny-list can.
 */
export function serializeClassSummary(classRoom: ClassRoom): SerializedClassSummary {
  return {
    id: classRoom.id,
    name: classRoom.name,
    academic_year: classRoom.academicYear,
    grade_level: classRoom.gradeLevel,
  };
}
