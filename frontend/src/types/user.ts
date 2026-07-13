/**
 * Mirrors the backend's UserResource / CounselorProfileResource (FULLPLAN §13.1).
 *
 * Keep these in lockstep with the API Resources — if a field changes there, it
 * changes here.
 */

export type UserRole = 'admin' | 'counselor' | 'student';

export type UserStatus = 'pending' | 'active' | 'inactive' | 'suspended';

export interface CounselorProfile {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  employee_number: string | null;
  specialization: string | null;
  bio: string | null;
}

export interface User {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  must_change_password: boolean;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string | null;
  counselor_profile?: CounselorProfile;
}
