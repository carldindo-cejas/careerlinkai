import type { CounselorProfile, User } from '@/db/schema';

/**
 * Response shaping (FULLPLAN §17). These are the contract: the frontend's `User` type in
 * `src/types/user.ts` is the mirror image of `serializeUser()`, and the port is finished
 * when they match field for field.
 *
 * Note what is *not* here: `password`, `deleted_at`, and anything from `api_tokens`. A
 * serializer is an allow-list, never a `delete row.password` on the way out.
 */

export interface SerializedCounselorProfile {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  employee_number: string | null;
  specialization: string | null;
  bio: string | null;
}

export interface SerializedUser {
  id: string;
  name: string;
  email: string | null;
  role: string;
  status: string;
  must_change_password: boolean;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string | null;
  counselor_profile?: SerializedCounselorProfile;
}

export function serializeCounselorProfile(
  profile: CounselorProfile,
): SerializedCounselorProfile {
  return {
    id: profile.id,
    first_name: profile.firstName,
    last_name: profile.lastName,
    phone: profile.phone,
    employee_number: profile.employeeNumber,
    specialization: profile.specialization,
    bio: profile.bio,
  };
}

export function serializeUser(
  user: User,
  counselorProfile?: CounselorProfile | null,
): SerializedUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    must_change_password: user.mustChangePassword,
    email_verified_at: user.emailVerifiedAt,
    last_login_at: user.lastLoginAt,
    created_at: user.createdAt,
    ...(counselorProfile
      ? { counselor_profile: serializeCounselorProfile(counselorProfile) }
      : {}),
  };
}

// L1 (removed): a second `serializeStudentProfile` lived here that returned `gwa`/grades as
// **numbers**, while the one the API actually uses (`modules/assessment/serializers.ts`) returns
// them as `"88.00"` **strings** — the DECIMAL(5,2) wire contract the frontend types pin. Nothing
// imported this one, so it was a contract trap waiting for a future caller to grab the wrong
// import and silently break the frontend. Deleted so there is a single source of truth.
