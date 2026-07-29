/**
 * Route group: the student's door (P3-3).
 *
 * Separate from `auth` on purpose. `/join` is passwordless (§38) and is where an unauthenticated
 * student is *sent* by `ProtectedRoute`, so it is the first screen on the student path — bundling
 * it with the staff login forms would put two forms a student can never submit in front of the
 * one they can.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { StudentAccessLayout } from '@/layouts/StudentAccessLayout';
export { StudentAccessPage } from '@/features/student/pages/StudentAccessPage';
