/**
 * Route group: the printable results exports — `/student/results/:id/report` and
 * `/student/reports`.
 *
 * Split from `student` because a student opens it rarely and everything else constantly: the
 * sheet carries its own stylesheets (Industry and the print rules) and both report layouts, which
 * every student screen used to download in order to show a dashboard. The PDF builder behind
 * "Download PDF" is a further `import()` inside this group, fetched only on the click.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { ResultReportPage } from '@/features/student/pages/ResultReportPage';
