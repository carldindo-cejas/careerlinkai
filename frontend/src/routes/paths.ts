import { DEFAULT_PAPER, type PaperSize } from '@/features/student/reports/paperSize';
import type { UserRole } from '@/types/user';

export const paths = {
  /** The public landing page (post-Phase-6 design pass) — the only unauthenticated screen beyond the two sign-ins. */
  landing: '/',
  // The public browse pages (prompt-driven, v1.5). Unauthenticated, linked from the public nav.
  publicColleges: '/colleges',
  publicCareers: '/careers',
  /** Counselor login. Admin authentication does not share this route (see adminLogin). */
  login: '/login',
  /**
   * Counselor self-registration (migration 0034) — details, then an emailed six-digit code, in two
   * steps on this one path.
   *
   * Reachable whether or not registration is open: the page renders the closure as copy rather than
   * 404ing, because the link may have been sent by somebody, bookmarked, or simply left in a tab
   * when an administrator turned the switch off. `/admin-login` never links here — an admin account
   * is not something anybody registers for.
   */
  counselorSignup: '/signup',
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
  /**
   * The canonical program catalog (backend migration 0018) — the grouping behind every student's
   * "which colleges offer this program?" list, and the only place a wrong grouping can be fixed.
   */
  adminCanonicalPrograms: '/admin/canonical-programs',
  // Phase 5a (§33, §37): the knowledge base and the AI governance text.
  adminKnowledge: '/admin/knowledge',
  adminAiInsights: '/admin/ai-insights',
  adminAiPolicy: '/admin/ai-policy',
  // Phase 6 (§20, §37): counselor management and the audit-log viewer.
  adminCounselors: '/admin/counselors',
  // Prompt-driven: a counselor's assigned students, with their Holland Code and top recommendations.
  adminCounselorDetail: '/admin/counselors/:counselorId',
  /** What this deployment is spending of the Cloudflare free plan, and what it cannot measure. */
  adminPlatformUsage: '/admin/platform-usage',
  adminAuditLog: '/admin/audit-log',
  // Phase 5b (§31, §35): the builder + AI generator, in the admin shell.
  adminAssessmentTemplates: '/admin/assessment-templates',
  adminAssessmentTemplate: '/admin/assessment-templates/:templateId',

  counselorDashboard: '/counselor',
  /**
   * The counselor's own account (2026-09-20) — their name, the address they sign in with, and
   * their password, in that order of how often it is touched.
   *
   * Not a nav row, for the same reason `studentProfile` is not one: the navigation is the things
   * a person came here to do, and an account is where they go when something about *them* is
   * wrong. It is reached from the name in the top bar and from the identity block above "Sign
   * out", which is where every other product in this shape puts it.
   */
  counselorProfile: '/counselor/profile',
  counselorClasses: '/counselor/classes',
  counselorClassDetail: '/counselor/classes/:classId',
  /**
   * The same two AI screens the admin shell serves, in the counselor shell (migration 0031).
   *
   * Separate paths rather than letting counselors into `/admin/*`: the admin shell's navigation,
   * layout and route guard are all built around a role that sees everything, and widening its
   * guard to admit counselors would put every other admin screen one URL edit away. The *pages*
   * are shared — one component, scoped by the server — while the route that reaches them is not.
   */
  counselorKnowledge: '/counselor/knowledge',
  counselorAiInsights: '/counselor/ai-insights',
  // Phase 5b: the same builder pages, in the counselor shell — ownership is server-side.
  counselorAssessmentTemplates: '/counselor/assessment-templates',
  counselorAssessmentTemplate: '/counselor/assessment-templates/:templateId',

  /** The student's own way in — no password anywhere in this flow (§38). */
  studentAccess: '/join',
  /**
   * The link a counselor shares (`/join/ABCD-2345`): the same screen with the class code already
   * filled in, so the student types only their username. The code in the URL is no more exposed
   * than the code on the projector — it is the same secret, sent the same way.
   */
  studentAccessWithCode: '/join/:classCode',
  studentDashboard: '/student',

  // Phase 3 (§37): profile completion, the assessment player, and results.
  studentProfile: '/student/profile',
  studentAssessments: '/student/assessments',
  studentPlayer: '/student/attempts/:attemptId',
  studentResults: '/student/results',
  studentResult: '/student/results/:attemptId',
  /** The printable export of one result — rendered outside the shell so the page is the document. */
  studentResultReport: '/student/results/:attemptId/report',
  /** Several exports on one sheet — "Print both" and the export dialog on My results. Also shell-less. */
  studentReports: '/student/reports',
  /** Phase 4 (§27). Not per-attempt: a student has one current set, drawn from RIASEC *and* SCCT. */
  studentRecommendations: '/student/recommendations',
} as const;

export function classDetailPath(classId: string): string {
  return `/counselor/classes/${classId}`;
}

/** The shareable class link — `/join/ABCD-2345` — which opens the join screen with the code filled in. */
export function joinLinkPath(classCode: string): string {
  return `/join/${encodeURIComponent(classCode)}`;
}

/**
 * Where the knowledge base and the AI-gaps report live for this role (migration 0031).
 *
 * The two shells serve the same components on different paths, so anything that links between
 * them — the report's "Answer this" button, most of all — has to ask rather than hard-code, or a
 * counselor following it lands on a route their guard refuses.
 */
export function knowledgePathForRole(role: UserRole): string {
  return role === 'admin' ? paths.adminKnowledge : paths.counselorKnowledge;
}

export function aiInsightsPathForRole(role: UserRole): string {
  return role === 'admin' ? paths.adminAiInsights : paths.counselorAiInsights;
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

export function resultReportPath(attemptId: string): string {
  return `/student/results/${attemptId}/report`;
}

export interface ReportsOptions {
  /** Defaults on; `false` pre-clears the "Item appendix" toggle. */
  appendix?: boolean;
  /** Defaults on; `false` pre-clears the "Top matches" toggle. */
  matches?: boolean;
  /** The paper to lay the sheet out for; A4 unless another size is named. */
  paper?: PaperSize;
  /** Open the browser's print dialog once every report has loaded. */
  print?: boolean;
}

export function reportsPath(attemptIds: string[], options: ReportsOptions = {}): string {
  const params = new URLSearchParams({ attempts: attemptIds.join(',') });

  if (options.appendix === false) params.set('appendix', '0');
  if (options.matches === false) params.set('matches', '0');
  if (options.paper !== undefined && options.paper !== DEFAULT_PAPER) {
    params.set('paper', options.paper);
  }
  if (options.print) params.set('print', '1');

  return `${paths.studentReports}?${params.toString()}`;
}

/**
 * What a screen hands the results page about where the student came from.
 *
 * The results page is reached from three places — finishing an attempt, the results list, and the
 * assessment list's "See result" — and "go back" means something different from each. Rather than
 * calling `navigate(-1)` and hoping the history stack says what we think it says (it does not,
 * after the player replaces itself), the sending screen states its own identity and the results
 * page renders a button that names it.
 *
 * Absent state is not an error: a student who typed the URL or opened a bookmark gets the
 * "Back to assessments" default and nothing broken.
 *
 * The shell-wide back control reads this same shape (`routes/back.ts`), so a screen that already
 * hands it over now names the origin in two places without being changed.
 */
export interface ResultPageState {
  from: string;
  fromLabel: string;
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
