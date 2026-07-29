/**
 * Route group: the assessment builder (P3-3).
 *
 * Its own group rather than part of either shell, because **both** shells route to these two
 * pages under different paths (§31) — scope is enforced server-side, not by routing. Duplicating
 * them into `admin` and `counselor` would ship the builder twice and grow whichever shell you
 * happened to open first.
 *
 * It is also the heaviest group by a distance: `QuestionWorkspace` is ~1,000 lines and
 * `BulkImportPanel` reaches `extractText`, which is what pulls in pdf.js and mammoth. Those two
 * are already `import()`-ed at their call site, so they stay separate chunks behind this one —
 * a counselor who opens the builder still downloads no PDF parser until they import a file.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { AssessmentManagementPage } from '@/features/assessment-builder/pages/AssessmentManagementPage';
export { TemplateBuilderPage } from '@/features/assessment-builder/pages/TemplateBuilderPage';
