/**
 * Route group: the counselor shell (P3-3).
 *
 * Admins are allowed through these routes too (`ClassPolicy` passes them, §39), so this chunk is
 * reachable from either shell — which is the reason it is not folded into `groups/admin.ts`.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
// The two AI screens this shell also serves live in `groups/knowledge.ts`, because the admin
// shell serves the same two — one copy, loaded by whichever shell asks for it first.
export { CounselorLayout } from '@/layouts/CounselorLayout';
export { CounselorDashboardPage } from '@/features/counselor/pages/CounselorDashboardPage';
export { CounselorProfilePage } from '@/features/counselor/pages/CounselorProfilePage';
export { ClassListPage } from '@/features/counselor/pages/ClassListPage';
export { ClassDetailPage } from '@/features/counselor/pages/ClassDetailPage';
