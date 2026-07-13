import type { UserRole } from '@/types/user';

export const paths = {
  login: '/login',
  changePassword: '/change-password',

  adminDashboard: '/admin',
  adminColleges: '/admin/colleges',
  adminCollegeDetail: '/admin/colleges/:collegeId',
  adminCareers: '/admin/careers',

  counselorDashboard: '/counselor',
  counselorClasses: '/counselor/classes',
  counselorClassDetail: '/counselor/classes/:classId',

  /** The student's own way in — no password anywhere in this flow (§38). */
  studentAccess: '/join',
  studentDashboard: '/student',

  // Phase 3 (§37): profile completion, the assessment player, and results.
  studentProfile: '/student/profile',
  studentAssessments: '/student/assessments',
  studentPlayer: '/student/attempts/:attemptId',
  studentResults: '/student/results',
  studentResult: '/student/results/:attemptId',
} as const;

export function classDetailPath(classId: string): string {
  return `/counselor/classes/${classId}`;
}

/** The assessment player, for one attempt (§37). */
export function playerPath(attemptId: string): string {
  return `/student/attempts/${attemptId}`;
}

export function resultPath(attemptId: string): string {
  return `/student/results/${attemptId}`;
}

export function collegeDetailPath(collegeId: string): string {
  return `/admin/colleges/${collegeId}`;
}

/**
 * Where a role lands after signing in (FULLPLAN §37).
 *
 * Students never reach this from the staff login screen — they come in through the
 * separate class-code flow at /join.
 */
export function homePathForRole(role: UserRole): string {
  switch (role) {
    case 'admin':
      return paths.adminDashboard;
    case 'counselor':
      return paths.counselorDashboard;
    case 'student':
      return paths.studentDashboard;
  }
}
