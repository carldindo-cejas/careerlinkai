/**
 * Route group: the public, unauthenticated site (P3-3).
 *
 * One barrel per group, dynamically imported once by `router.tsx`, so the group is **one**
 * chunk rather than one chunk per page. Navigating between Home, Colleges and Careers costs
 * no further request — they were downloaded together, because they are always reached together.
 *
 * Nothing may import this file statically. A static import anywhere pulls the whole group back
 * into the entry chunk and silently undoes the split; `test/routes/route-groups.test.ts` asserts
 * `router.tsx` is the only importer.
 */
export { PublicLayout } from '@/features/public/PublicLayout';
export { HomePage } from '@/features/public/HomePage';
export { CollegesPage } from '@/features/public/CollegesPage';
export { CareersPage } from '@/features/public/CareersPage';
