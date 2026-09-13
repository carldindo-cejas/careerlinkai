import { describe, expect, it } from 'vitest';

import { backTargetFor } from '@/routes/back';
import { paths } from '@/routes/paths';

/**
 * **The back control's destination, which is the only part of it that can be wrong.**
 *
 * The rendering is four lines of JSX; the decision is a table of twenty-odd routes plus three rules
 * that override it, and every one of those rules exists because the obvious answer — `navigate(-1)`
 * — is wrong somewhere specific. Those specific places are what this file pins down.
 */
describe('backTargetFor', () => {
  it('steps a section page back to its dashboard, and a detail page back to its list', () => {
    expect(backTargetFor(paths.adminKnowledge)).toEqual({
      to: paths.adminDashboard,
      label: 'dashboard',
    });

    expect(backTargetFor('/admin/colleges/col_123')).toEqual({
      to: paths.adminColleges,
      label: 'colleges',
    });

    expect(backTargetFor('/counselor/classes/cls_9')).toEqual({
      to: paths.counselorClasses,
      label: 'classes',
    });
  });

  /** There is nowhere above a dashboard, so the control renders nothing rather than a loop. */
  it('offers no step back from the three dashboards', () => {
    expect(backTargetFor(paths.adminDashboard)).toBeNull();
    expect(backTargetFor(paths.counselorDashboard)).toBeNull();
    expect(backTargetFor(paths.studentDashboard)).toBeNull();
  });

  /**
   * `/student/attempts/:id` has no parent route — `/student/attempts` is not a screen — so the
   * generic "strip a segment" answer would be a 404. The player names its own step back.
   */
  it('steps the assessment player back to the assessment list', () => {
    expect(backTargetFor('/student/attempts/att_1')).toEqual({
      to: paths.studentAssessments,
      label: 'assessments',
    });
  });

  /**
   * A result is the same URL whether it was reached from the list or from a finished attempt, and
   * only the sending screen knows which — so what it hands over outranks the table.
   */
  it('prefers a destination handed over by the sending screen', () => {
    expect(
      backTargetFor('/student/results/att_1', {
        state: { from: paths.studentAssessments, fromLabel: 'My assessments' },
      }),
    ).toEqual({ to: paths.studentAssessments, label: 'my assessments' });

    // Nothing handed over is not an error — the table still has an answer.
    expect(backTargetFor('/student/results/att_1')).toEqual({
      to: paths.studentResults,
      label: 'my results',
    });
  });

  /**
   * **`ProtectedRoute` puts a `from` in location state too, and it is a Location, not a path.**
   *
   * Trusting the key alone would render "Back to [object Object]" on the sign-in screen every time
   * a signed-out visitor was bounced to it — which is the single most-reached state in the app.
   */
  it('ignores the redirect state that the route guard leaves behind', () => {
    const guardState = { from: { pathname: '/admin/colleges', search: '', hash: '' } };

    expect(backTargetFor(paths.adminLogin, { state: guardState })).toEqual({
      to: paths.landing,
      label: 'home',
    });
  });

  /**
   * Both doors step back to the public site — /admin-login included. Nothing links *to* that route
   * (§38) and this does not change that; it is the way out for an administrator who typed the URL.
   */
  it('steps both staff doors and the student door back to the public site', () => {
    for (const door of [paths.login, paths.adminLogin, paths.studentAccess]) {
      expect(backTargetFor(door)).toEqual({ to: paths.landing, label: 'home' });
    }

    expect(backTargetFor(paths.forgotPassword)).toEqual({ to: paths.login, label: 'sign in' });
  });

  /**
   * The forced rotation is the one screen where a way out would be a lie: the guard redirects every
   * other route back to it until the password is set. Reached voluntarily it behaves normally.
   */
  it('offers no step back out of a forced password change', () => {
    expect(
      backTargetFor(paths.changePassword, { role: 'admin', mustChangePassword: true }),
    ).toBeNull();

    expect(backTargetFor(paths.changePassword, { role: 'admin' })).toEqual({
      to: paths.adminDashboard,
      label: 'dashboard',
    });

    // No role yet (the session is still being verified) — say nothing rather than guess a door.
    expect(backTargetFor(paths.changePassword)).toBeNull();
  });
});
