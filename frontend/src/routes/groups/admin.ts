/**
 * Route group: the administrator shell (P3-3).
 *
 * The catalog, the knowledge base, counselor accounts and the audit trail. The two assessment
 * screens the admin shell also serves live in `groups/builder.ts`, because the counselor shell
 * serves the same two — one copy, loaded by whichever shell asks for it first.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { AdminLayout } from '@/layouts/AdminLayout';
export { AdminDashboardPage } from '@/features/admin/pages/AdminDashboardPage';
export { AddressPage } from '@/features/admin/pages/AddressPage';
export { CollegeListPage } from '@/features/admin/pages/CollegeListPage';
export { CollegeDetailPage } from '@/features/admin/pages/CollegeDetailPage';
export { CareerListPage } from '@/features/admin/pages/CareerListPage';
export { CanonicalProgramPage } from '@/features/admin/pages/CanonicalProgramPage';
export { KnowledgeListPage } from '@/features/admin/pages/KnowledgeListPage';
export { AiPolicyPage } from '@/features/admin/pages/AiPolicyPage';
export { CounselorManagementPage } from '@/features/admin/pages/CounselorManagementPage';
export { CounselorDetailPage } from '@/features/admin/pages/CounselorDetailPage';
export { AuditLogPage } from '@/features/admin/pages/AuditLogPage';
