/**
 * Route group: the counselor shell (P3-3).
 *
 * Admins are allowed through these routes too (`ClassPolicy` passes them, §39), so this chunk is
 * reachable from either shell — which is the reason it is not folded into `groups/admin.ts`.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { CounselorLayout } from '@/layouts/CounselorLayout';
export { CounselorDashboardPage } from '@/features/counselor/pages/CounselorDashboardPage';
export { ClassListPage } from '@/features/counselor/pages/ClassListPage';
export { ClassDetailPage } from '@/features/counselor/pages/ClassDetailPage';
