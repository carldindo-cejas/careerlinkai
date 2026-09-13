/**
 * Route group: the knowledge base and the AI-gaps report (migration 0031).
 *
 * Its own group rather than part of either shell, for exactly the reason `groups/builder.ts`
 * is: **both** staff shells route to these two pages, under different paths, and the scope is
 * enforced server-side rather than by routing. Leaving them in `groups/admin` and pointing the
 * counselor routes at them would make a counselor opening their own knowledge screen download the
 * entire admin shell — the catalog editors, counselor management, the audit-log viewer — to render
 * two pages, and would put that whole chunk in the hands of the role it was split away from.
 *
 * `KnowledgeListPage` reaches `extractText`, which is what pulls in pdf.js and mammoth. That is
 * already `import()`-ed at its call site, so it stays a separate chunk behind this one: nobody
 * downloads a PDF parser until they actually choose a file.
 *
 * Nothing may import this file statically — see `groups/public.ts`.
 */
export { KnowledgeListPage } from '@/features/admin/pages/KnowledgeListPage';
export { AiInsightsPage } from '@/features/admin/pages/AiInsightsPage';
