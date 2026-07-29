/**
 * Route group: the student shell (P3-3).
 *
 * The group audit finding P2 was really about: before this split a student downloaded every admin
 * page, the counselor shell and the assessment builder in order to answer sixty questions.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { StudentLayout } from '@/layouts/StudentLayout';
export { StudentDashboardPage } from '@/features/student/pages/StudentDashboardPage';
export { StudentProfilePage } from '@/features/student/pages/StudentProfilePage';
export { AssessmentListPage } from '@/features/student/pages/AssessmentListPage';
export { AssessmentPlayerPage } from '@/features/student/pages/AssessmentPlayerPage';
export { ResultListPage } from '@/features/student/pages/ResultListPage';
export { ResultPage } from '@/features/student/pages/ResultPage';
export { RecommendationPage } from '@/features/student/pages/RecommendationPage';
