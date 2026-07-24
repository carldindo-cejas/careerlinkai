import { Route, Routes } from 'react-router-dom';

import { AdminDashboardPage } from '@/features/admin/pages/AdminDashboardPage';
import { AiPolicyPage } from '@/features/admin/pages/AiPolicyPage';
import { AuditLogPage } from '@/features/admin/pages/AuditLogPage';
import { CareerListPage } from '@/features/admin/pages/CareerListPage';
import { CollegeDetailPage } from '@/features/admin/pages/CollegeDetailPage';
import { CollegeListPage } from '@/features/admin/pages/CollegeListPage';
import { CounselorManagementPage } from '@/features/admin/pages/CounselorManagementPage';
import { KnowledgeListPage } from '@/features/admin/pages/KnowledgeListPage';
import { AdminLoginPage } from '@/features/auth/pages/AdminLoginPage';
import { ChangePasswordPage } from '@/features/auth/pages/ChangePasswordPage';
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPasswordPage';
import { LoginPage } from '@/features/auth/pages/LoginPage';
import { LandingPage } from '@/features/landing/LandingPage';
import { ResetPasswordPage } from '@/features/auth/pages/ResetPasswordPage';
import { ClassDetailPage } from '@/features/counselor/pages/ClassDetailPage';
import { ClassListPage } from '@/features/counselor/pages/ClassListPage';
import { CounselorDashboardPage } from '@/features/counselor/pages/CounselorDashboardPage';
import { TemplateBuilderPage } from '@/features/assessment-builder/pages/TemplateBuilderPage';
import { TemplateListPage } from '@/features/assessment-builder/pages/TemplateListPage';
import { AssessmentListPage } from '@/features/student/pages/AssessmentListPage';
import { AssessmentPlayerPage } from '@/features/student/pages/AssessmentPlayerPage';
import { RecommendationPage } from '@/features/student/pages/RecommendationPage';
import { ResultListPage } from '@/features/student/pages/ResultListPage';
import { ResultPage } from '@/features/student/pages/ResultPage';
import { StudentAccessPage } from '@/features/student/pages/StudentAccessPage';
import { StudentDashboardPage } from '@/features/student/pages/StudentDashboardPage';
import { StudentProfilePage } from '@/features/student/pages/StudentProfilePage';
import { AdminLayout } from '@/layouts/AdminLayout';
import { CounselorLayout } from '@/layouts/CounselorLayout';
import { StaffAuthLayout } from '@/layouts/StaffAuthLayout';
import { StudentAccessLayout } from '@/layouts/StudentAccessLayout';
import { StudentLayout } from '@/layouts/StudentLayout';
import { paths } from '@/routes/paths';
import { ProtectedRoute } from '@/routes/ProtectedRoute';
import { RoleHome } from '@/routes/RoleHome';

/**
 * Application routes (FULLPLAN §37).
 *
 * The sign-in flows are separate all the way up to the router: /login is counselors
 * only, /admin-login is administrators only (and is linked from nowhere — admins type
 * the URL), and /join is students only (§38). No page links across the flows, and no
 * route serves more than one of them.
 */
export function AppRoutes() {
  return (
    <Routes>
      {/* The public landing page (post-Phase-6 design pass) — the two doors, stated plainly. */}
      <Route path={paths.landing} element={<LandingPage />} />

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
          <Route path={paths.adminColleges} element={<CollegeListPage />} />
          <Route path={paths.adminCollegeDetail} element={<CollegeDetailPage />} />
          <Route path={paths.adminCareers} element={<CareerListPage />} />
          {/* Phase 5a: what the AI may know, and what it may say (§33, §13.7). */}
          <Route path={paths.adminKnowledge} element={<KnowledgeListPage />} />
          <Route path={paths.adminAiPolicy} element={<AiPolicyPage />} />
          {/* Phase 5b: the builder + AI generator (§31). Same pages as the counselor shell. */}
          <Route path={paths.adminAssessmentTemplates} element={<TemplateListPage />} />
          <Route path={paths.adminAssessmentTemplate} element={<TemplateBuilderPage />} />
          {/* Phase 6 (§20, §37): counselor accounts and the audit trail. */}
          <Route path={paths.adminCounselors} element={<CounselorManagementPage />} />
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
          {/* Phase 5b: the builder + AI generator (§31) — ownership is enforced server-side. */}
          <Route path={paths.counselorAssessmentTemplates} element={<TemplateListPage />} />
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
  );
}
