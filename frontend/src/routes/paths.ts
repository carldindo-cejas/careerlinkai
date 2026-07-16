import type { UserRole } from '@/types/user';

export const paths = {
  login: '/login',
  changePassword: '/change-password',

  adminDashboard: '/admin',
  adminColleges: '/admin/colleges',
  adminCollegeDetail: '/admin/colleges/:collegeId',
  adminCareers: '/admin/careers',
  // Phase 5a (§33, §37): the knowledge base and the AI governance text.
  adminKnowledge: '/admin/knowledge',
  adminAiPolicy: '/admin/ai-policy',
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
