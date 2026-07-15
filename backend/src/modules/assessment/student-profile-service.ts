import { eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { studentProfiles, type StudentProfile, type User } from '@/db/schema';
import { now } from '@/lib/datetime';
import { ApiError } from '@/lib/envelope';
import type { UpdateStudentProfileInput } from '@/modules/assessment/schemas';

/**
 * The student profile (FULLPLAN §13.1, §37) — **the input to Part VII.**
 *
 * It lives in Phase 3 because §27's engine consumes `strand` and `gwa` and no earlier phase owned
 * them (§57, v1.2). That is the whole reason this exists: it is not a settings screen, it is the
 * other half of the recommendation engine's inputs.
 *
 * `first_name` / `last_name` are **not editable here.** They belong to the counselor's roster
 * (§16) — a student renaming themselves would break the roster the counselor confirmed, and the
 * username derived from it. The Zod schema does not accept them; this is not enforced by
 * omission alone.
 */
export class StudentProfileService {
  constructor(private readonly db: Database) {}

  async forStudent(student: User): Promise<StudentProfile> {
    const [profile] = await this.db
      .select()
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, student.id))
      .limit(1);

    if (profile === undefined) {
      // Roster provisioning is the only thing that creates a student (§16), and it always writes
      // the profile row in the same batch — so a student without one is a broken invariant, not a
      // first-time visitor to be lazily initialized.
      throw ApiError.notFound('Student profile not found.');
    }

    return profile;
  }

  /** Partial. Every field is optional; an explicit `null` clears it. */
  async update(student: User, input: UpdateStudentProfileInput): Promise<StudentProfile> {
    const profile = await this.forStudent(student);

    const patch: Partial<StudentProfile> = { updatedAt: now() };

    // Written out rather than spread, so a field can only be updated if it is *named here*. A
    // blanket spread of the parsed body would silently start accepting any field a future schema
    // change added — including `first_name`, which must never be student-editable.
    if (input.birthdate !== undefined) patch.birthdate = input.birthdate;
    if (input.gender !== undefined) patch.gender = input.gender;
    if (input.grade_level !== undefined) patch.gradeLevel = input.grade_level;
    if (input.strand !== undefined) patch.strand = input.strand;
    if (input.gwa !== undefined) patch.gwa = input.gwa;
    if (input.math_grade !== undefined) patch.mathGrade = input.math_grade;
    if (input.science_grade !== undefined) patch.scienceGrade = input.science_grade;
    if (input.english_grade !== undefined) patch.englishGrade = input.english_grade;
    if (input.guardian_name !== undefined) patch.guardianName = input.guardian_name;
    if (input.guardian_contact !== undefined) patch.guardianContact = input.guardian_contact;

    await this.db
      .update(studentProfiles)
      .set(patch)
      .where(eq(studentProfiles.id, profile.id));

    return this.forStudent(student);
  }
}
