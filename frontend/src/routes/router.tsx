import { Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

import { paths } from '@/routes/paths';
import { ProtectedRoute } from '@/routes/ProtectedRoute';
import { RoleHome } from '@/routes/RoleHome';
import { RouteFallback } from '@/routes/RouteFallback';
import { routeGroup } from '@/routes/routeGroup';

/**
 * Application routes (FULLPLAN §37).
 *
 * The sign-in flows are separate all the way up to the router: /login is counselors
 * only, /admin-login is administrators only (and is linked from nowhere — admins type
 * the URL), and /join is students only (§38). No page links across the flows, and no
 * route serves more than one of them.
 *
 * **Every page below is behind a dynamic `import()` (P3-3, audit P2).** Only this file,
 * `ProtectedRoute` and `RoleHome` are in the entry chunk — the two that have to run before we
 * know which shell to fetch. `ProtectedRoute` in particular must stay eager: it is the thing
 * that decides a student may not have the admin shell, and downloading it to find that out
 * would defeat the split.
 *
 * The groups are the seven below rather than the five the plan named, for two reasons that only
 * showed up against the routes as they actually are: the assessment builder is routed by *both*
 * staff shells, so it belongs to neither; and the student's door is passwordless and is not the
 * staff door, so `/join` is not part of `auth`.
 */
const publicSite = routeGroup(() => import('@/routes/groups/public'));
const auth = routeGroup(() => import('@/routes/groups/auth'));
const access = routeGroup(() => import('@/routes/groups/access'));
const admin = routeGroup(() => import('@/routes/groups/admin'));
const counselor = routeGroup(() => import('@/routes/groups/counselor'));
const builder = routeGroup(() => import('@/routes/groups/builder'));
const student = routeGroup(() => import('@/routes/groups/student'));

const PublicLayout = publicSite('PublicLayout');
const HomePage = publicSite('HomePage');
const CollegesPage = publicSite('CollegesPage');
const CareersPage = publicSite('CareersPage');

const StaffAuthLayout = auth('StaffAuthLayout');
const LoginPage = auth('LoginPage');
const AdminLoginPage = auth('AdminLoginPage');
const ForgotPasswordPage = auth('ForgotPasswordPage');
const ResetPasswordPage = auth('ResetPasswordPage');
const ChangePasswordPage = auth('ChangePasswordPage');

const StudentAccessLayout = access('StudentAccessLayout');
const StudentAccessPage = access('StudentAccessPage');

const AdminLayout = admin('AdminLayout');
const AdminDashboardPage = admin('AdminDashboardPage');
const AddressPage = admin('AddressPage');
const CollegeListPage = admin('CollegeListPage');
const CollegeDetailPage = admin('CollegeDetailPage');
const CareerListPage = admin('CareerListPage');
const CanonicalProgramPage = admin('CanonicalProgramPage');
const KnowledgeListPage = admin('KnowledgeListPage');
const AiPolicyPage = admin('AiPolicyPage');
const CounselorManagementPage = admin('CounselorManagementPage');
const CounselorDetailPage = admin('CounselorDetailPage');
const AuditLogPage = admin('AuditLogPage');

const CounselorLayout = counselor('CounselorLayout');
const CounselorDashboardPage = counselor('CounselorDashboardPage');
const ClassListPage = counselor('ClassListPage');
const ClassDetailPage = counselor('ClassDetailPage');

const AssessmentManagementPage = builder('AssessmentManagementPage');
const TemplateBuilderPage = builder('TemplateBuilderPage');

const StudentLayout = student('StudentLayout');
const StudentDashboardPage = student('StudentDashboardPage');
const StudentProfilePage = student('StudentProfilePage');
const AssessmentListPage = student('AssessmentListPage');
const AssessmentPlayerPage = student('AssessmentPlayerPage');
const ResultListPage = student('ResultListPage');
const ResultPage = student('ResultPage');
const RecommendationPage = student('RecommendationPage');

export function AppRoutes() {
  return (
    /*
      One boundary, around the whole route table, rather than one per group.
      React Router v7 navigates inside a transition, so a `<Link>` press holds the current screen
      on the page while the next group downloads instead of replacing it with this spinner — the
      fallback is therefore for the *cold* load, where there is nothing to hold. A boundary per
      group would behave identically and would have to be kept in step with the table by hand.

      A chunk that fails to download (a stale tab against a redeployed Worker is the realistic
      case) throws here, and `ErrorBoundary` — which sits between the providers and this tree,
      audit F6 — catches it and offers "Try again", which re-runs the import.
    */
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/*
          The public, unauthenticated site (prompt-driven, v1.5): Home, Colleges and Careers, all under
          one shell with the shared nav and footer. The two doors — student class code and staff sign-in
          — are stated plainly on the home page.
        */}
        <Route element={<PublicLayout />}>
          <Route path={paths.landing} element={<HomePage />} />
          <Route path={paths.publicColleges} element={<CollegesPage />} />
          <Route path={paths.publicCareers} element={<CareersPage />} />
        </Route>

        <Route element={<StaffAuthLayout />}>
          <Route path={paths.login} element={<LoginPage />} />
          {/* Unlinked on purpose: administrators reach this by typing the URL. */}
          <Route path={paths.adminLogin} element={<AdminLoginPage />} />
          {/* Phase 6 (D7): the reset flow, in its honest no-email shape. */}
          <Route path={paths.forgotPassword} element={<ForgotPasswordPage />} />
          <Route path={paths.resetPassword} element={<ResetPasswordPage />} />
        </Route>

        {/* Passwordless class access — public, and the only way a student signs in. */}
        <Route element={<StudentAccessLayout />}>
          <Route path={paths.studentAccess} element={<StudentAccessPage />} />
        </Route>

        {/* Any authenticated user. Also where a temporary password is forced (§38). */}
        <Route element={<ProtectedRoute />}>
          <Route element={<StaffAuthLayout />}>
            <Route path={paths.changePassword} element={<ChangePasswordPage />} />
          </Route>

          {/* Unknown paths resolve to the dashboard for whatever role signed in. */}
          <Route path="*" element={<RoleHome />} />
        </Route>

        {/*
          The academic catalog is admin-only, and unlike the counselor group this is not a
          coarse gate in front of a finer ownership check — a college belongs to nobody, so
          `admin` is the whole rule, here and on the server (§39).
        */}
        <Route element={<ProtectedRoute allow={['admin']} />}>
          <Route element={<AdminLayout />}>
            <Route path={paths.adminDashboard} element={<AdminDashboardPage />} />
            <Route path={paths.adminAddresses} element={<AddressPage />} />
            <Route path={paths.adminColleges} element={<CollegeListPage />} />
            <Route path={paths.adminCollegeDetail} element={<CollegeDetailPage />} />
            <Route path={paths.adminCareers} element={<CareerListPage />} />
            <Route path={paths.adminCanonicalPrograms} element={<CanonicalProgramPage />} />
            {/* Phase 5a: what the AI may know, and what it may say (§33, §13.7). */}
            <Route path={paths.adminKnowledge} element={<KnowledgeListPage />} />
            <Route path={paths.adminAiPolicy} element={<AiPolicyPage />} />
            {/* Phase 5b + v1.5: the assessment table, then the builder + AI generator (§31).
                Same pages as the counselor shell — scope is enforced server-side, not by routing. */}
            <Route path={paths.adminAssessmentTemplates} element={<AssessmentManagementPage />} />
            <Route path={paths.adminAssessmentTemplate} element={<TemplateBuilderPage />} />
            {/* Phase 6 (§20, §37): counselor accounts and the audit trail. */}
            <Route path={paths.adminCounselors} element={<CounselorManagementPage />} />
            {/* Prompt-driven: one counselor's students, Holland codes, and top recommendations. */}
            <Route path={paths.adminCounselorDetail} element={<CounselorDetailPage />} />
            <Route path={paths.adminAuditLog} element={<AuditLogPage />} />
          </Route>
        </Route>

        {/*
          Admins are allowed through the counselor shell because ClassPolicy explicitly
          passes them (§39) — the route group is the coarse gate, and the server still
          authorizes ownership on every request.
        */}
        <Route element={<ProtectedRoute allow={['counselor', 'admin']} />}>
          <Route element={<CounselorLayout />}>
            <Route path={paths.counselorDashboard} element={<CounselorDashboardPage />} />
            <Route path={paths.counselorClasses} element={<ClassListPage />} />
            <Route path={paths.counselorClassDetail} element={<ClassDetailPage />} />
            {/* Phase 5b + v1.5: the same assessment table and builder — ownership is server-side. */}
            <Route
              path={paths.counselorAssessmentTemplates}
              element={<AssessmentManagementPage />}
            />
            <Route path={paths.counselorAssessmentTemplate} element={<TemplateBuilderPage />} />
          </Route>
        </Route>

        {/*
          The student shell. Phase 3 fills it in: profile completion (which Part VII depends on),
          the assessment player, and results.
        */}
        <Route element={<ProtectedRoute allow={['student']} />}>
          <Route element={<StudentLayout />}>
            <Route path={paths.studentDashboard} element={<StudentDashboardPage />} />
            <Route path={paths.studentProfile} element={<StudentProfilePage />} />
            <Route path={paths.studentAssessments} element={<AssessmentListPage />} />
            <Route path={paths.studentPlayer} element={<AssessmentPlayerPage />} />
            <Route path={paths.studentResults} element={<ResultListPage />} />
            <Route path={paths.studentResult} element={<ResultPage />} />
            <Route path={paths.studentRecommendations} element={<RecommendationPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
