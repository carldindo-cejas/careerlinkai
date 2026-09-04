import { matchPath } from 'react-router-dom';

import { homePathForRole, paths } from '@/routes/paths';
import type { UserRole } from '@/types/user';

/** Where the back button goes, and what it calls the place it goes to. */
export interface BackTarget {
  /** A concrete path — never a history offset. See the note on `backTargetFor`. */
  to: string;
  /** How the control names the destination: "Back to {label}". Lowercase, matching the copy elsewhere. */
  label: string;
}

/**
 * What a screen may hand the next one about where it came from.
 *
 * Structurally identical to `ResultPageState` (paths.ts), and deliberately so — that interface
 * described this exact contract for one destination before there was a shell-wide control to read
 * it, and the three screens that already send it keep working unchanged.
 */
interface HandedOverState {
  from: string;
  fromLabel: string;
}

const toDashboard = (to: string): BackTarget => ({ to, label: 'dashboard' });

/**
 * One step back from every screen that has one, keyed by route pattern.
 *
 * **Stated, not inferred from history.** `navigate(-1)` would be one line, but "the entry before
 * this one" is not the same thing as "one step back": the assessment player replaces itself in the
 * stack when it submits, `ProtectedRoute` redirects with `replace`, and a student who opened a
 * bookmark has no previous entry at all — in each case the browser's answer is either wrong or
 * missing, and there is nothing to show in the label. paths.ts already made this call for the
 * results page; this is the same call, made once for the whole app.
 *
 * A screen absent from this table has no step back, and the control renders nothing rather than
 * inventing one — that is the three dashboards, which are where back would lead anyway.
 */
const parents: ReadonlyMap<string, BackTarget> = new Map<string, BackTarget>([
  /*
    The doors (§38). Each one steps back to the public site, including /admin-login — that route is
    unlinked *to*, which says nothing about linking away from it, and without this an administrator
    who typed the URL by mistake has no way out of a screen they cannot sign in to.
  */
  [paths.login, { to: paths.landing, label: 'home' }],
  [paths.adminLogin, { to: paths.landing, label: 'home' }],
  [paths.studentAccess, { to: paths.landing, label: 'home' }],
  [paths.forgotPassword, { to: paths.login, label: 'sign in' }],
  [paths.resetPassword, { to: paths.login, label: 'sign in' }],

  // Administrator. Detail routes step up to their list; everything else to the dashboard.
  [paths.adminAddresses, toDashboard(paths.adminDashboard)],
  [paths.adminColleges, toDashboard(paths.adminDashboard)],
  [paths.adminCollegeDetail, { to: paths.adminColleges, label: 'colleges' }],
  [paths.adminCareers, toDashboard(paths.adminDashboard)],
  [paths.adminCanonicalPrograms, toDashboard(paths.adminDashboard)],
  [paths.adminKnowledge, toDashboard(paths.adminDashboard)],
  [paths.adminAiInsights, toDashboard(paths.adminDashboard)],
  [paths.adminAiPolicy, toDashboard(paths.adminDashboard)],
  [paths.adminCounselors, toDashboard(paths.adminDashboard)],
  [paths.adminCounselorDetail, { to: paths.adminCounselors, label: 'counselors' }],
  [paths.adminAuditLog, toDashboard(paths.adminDashboard)],
  [paths.adminAssessmentTemplates, toDashboard(paths.adminDashboard)],
  [paths.adminAssessmentTemplate, { to: paths.adminAssessmentTemplates, label: 'assessments' }],

  /*
    Counselor. The builder pages are the same components as the admin's, but the step back is not
    the same path — a counselor sent to /admin/assessment-templates would be bounced by the route
    guard — so the two shells' entries stay separate even though the screens are shared.
  */
  [paths.counselorClasses, toDashboard(paths.counselorDashboard)],
  [paths.counselorClassDetail, { to: paths.counselorClasses, label: 'classes' }],
  [paths.counselorAssessmentTemplates, toDashboard(paths.counselorDashboard)],
  [
    paths.counselorAssessmentTemplate,
    { to: paths.counselorAssessmentTemplates, label: 'assessments' },
  ],

  /*
    Student. The player steps back to the assessment list rather than to /student/attempts, which
    is not a route — answers are saved as they are given (§21), so leaving mid-attempt loses
    nothing and the student can resume from the list.
  */
  [paths.studentProfile, toDashboard(paths.studentDashboard)],
  [paths.studentAssessments, toDashboard(paths.studentDashboard)],
  [paths.studentPlayer, { to: paths.studentAssessments, label: 'assessments' }],
  [paths.studentResults, toDashboard(paths.studentDashboard)],
  [paths.studentResult, { to: paths.studentResults, label: 'my results' }],
  [paths.studentRecommendations, toDashboard(paths.studentDashboard)],
]);

export interface BackContext {
  /** The signed-in user's role, if any — /change-password is the one route all three share. */
  role?: UserRole | null;
  /** True while staff are held on the forced password change (§38). */
  mustChangePassword?: boolean;
  /** `location.state`, read for a handed-over `{ from, fromLabel }`. Untyped on purpose — see below. */
  state?: unknown;
}

/**
 * The step back from `pathname`, or `null` where there honestly isn't one.
 *
 * A destination handed over in `state` wins over the table: a result reached from "My results" and
 * the same result reached from a finished attempt are the same URL with two different origins, and
 * the sending screen is the only thing that knows which.
 */
export function backTargetFor(pathname: string, context: BackContext = {}): BackTarget | null {
  const handedOver = readHandedOverState(context.state);

  if (handedOver) {
    return handedOver;
  }

  if (matchPath(paths.changePassword, pathname)) {
    /*
      Forced rotation admits no step back: `ProtectedRoute` sends every other route straight back
      here until the password is set, so a control offering a way out would be offering a redirect.
      Reached voluntarily, it steps back to whichever dashboard the signer-in belongs to.
    */
    if (context.mustChangePassword || !context.role) {
      return null;
    }

    return toDashboard(homePathForRole(context.role));
  }

  for (const [pattern, target] of parents) {
    if (matchPath(pattern, pathname)) {
      return target;
    }
  }

  return null;
}

/**
 * `{ from, fromLabel }` out of `location.state`, if that is what is in there.
 *
 * Both halves are checked rather than trusting the key: `ProtectedRoute` puts its own `from` in
 * location state when it bounces a signed-out visitor to a door, and that one is a Location object,
 * not a path. Rendering it would produce a link to "[object Object]" on the login screen.
 */
function readHandedOverState(state: unknown): BackTarget | null {
  if (!state || typeof state !== 'object') {
    return null;
  }

  const { from, fromLabel } = state as Partial<HandedOverState>;

  return typeof from === 'string' && typeof fromLabel === 'string'
    ? { to: from, label: fromLabel.toLowerCase() }
    : null;
}
