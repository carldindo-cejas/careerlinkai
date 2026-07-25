import type { UserRole } from '@/types/user';

export const paths = {
  /** The public landing page (post-Phase-6 design pass) — the only unauthenticated screen beyond the two sign-ins. */
  landing: '/',
  /** Counselor login. Admin authentication does not share this route (see adminLogin). */
  login: '/login',
  /**
   * Administrator login. Deliberately unlinked: no button, menu item or navigation
   * reference anywhere in the app points here — admins reach it by typing the URL.
   */
  adminLogin: '/admin-login',
  changePassword: '/change-password',
  // Phase 6 (D7, in its honest shape): no email channel exists, so the reset code is
  // handed over out of band — these screens are where it gets used.
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',

  adminDashboard: '/admin',
  // v1.5 (backend migration 0011): the Philippine address hierarchy for cascading dropdowns.
  adminAddresses: '/admin/addresses',
  adminColleges: '/admin/colleges',
  adminCollegeDetail: '/admin/colleges/:collegeId',
  adminCareers: '/admin/careers',
  // Phase 5a (§33, §37): the knowledge base and the AI governance text.
  adminKnowledge: '/admin/knowledge',
  adminAiPolicy: '/admin/ai-policy',
  // Phase 6 (§20, §37): counselor management and the audit-log viewer.
  adminCounselors: '/admin/counselors',
  // Prompt-driven: a counselor's assigned students, with their Holland Code and top recommendations.
  adminCounselorDetail: '/admin/counselors/:counselorId',
  adminAuditLog: '/admin/audit-log',
  // Phase 5b (§31, §35): the builder + AI generator, in the admin shell.
  adminAssessmentTemplates: '/admin/assessment-templates',
  adminAssessmentTemplate: '/admin/assessment-templates/:templateId',

  counselorDashboard: '/counselor',
  counselorClasses: '/counselor/classes',
  counselorClassDetail: '/counselor/classes/:classId',
  // Phase 5b: the same builder pages, in the counselor shell — ownership is server-side.
  counselorAssessmentTemplates: '/counselor/assessment-templates',
  counselorAssessmentTemplate: '/counselor/assessment-templates/:templateId',

  /** The student's own way in — no password anywhere in this flow (§38). */
  studentAccess: '/join',
  studentDashboard: '/student',

  // Phase 3 (§37): profile completion, the assessment player, and results.
  studentProfile: '/student/profile',
  studentAssessments: '/student/assessments',
  studentPlayer: '/student/attempts/:attemptId',
  studentResults: '/student/results',
  studentResult: '/student/results/:attemptId',
  /** Phase 4 (§27). Not per-attempt: a student has one current set, drawn from RIASEC *and* SCCT. */
  studentRecommendations: '/student/recommendations',
} as const;

export function classDetailPath(classId: string): string {
  return `/counselor/classes/${classId}`;
}

/** The local-dev reset flow carries the email + token straight into the form (D7). */
export function resetPasswordPath(email: string, token: string): string {
  return `${paths.resetPassword}?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
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

export function counselorDetailPath(counselorId: string): string {
  return `/admin/counselors/${counselorId}`;
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

/**
 * Which door a role signs back in through (§38) — the inverse of homePathForRole.
 *
 * Every session that ends has to send someone somewhere, and since each role now has its own
 * door and each door refuses the other roles, sending everyone to /login strands the ones it
 * refuses. That matters most for an admin: /admin-login is deliberately unlinked, so an admin
 * dropped at the counselor door has no route back that the UI will show them.
 */
export function loginPathForRole(role: UserRole): string {
  switch (role) {
    case 'admin':
      return paths.adminLogin;
    case 'counselor':
      return paths.login;
    case 'student':
      return paths.studentAccess;
  }
}
