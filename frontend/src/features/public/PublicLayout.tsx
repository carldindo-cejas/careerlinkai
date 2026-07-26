import { Outlet } from 'react-router-dom';

import { PublicFooter } from '@/features/public/components/PublicFooter';
import { PublicHeader } from '@/features/public/components/PublicHeader';

/**
 * The shell every public, unauthenticated page renders inside (prompt-driven, v1.5): the shared nav,
 * the page content, and the shared footer, on the sidebar canvas the landing page established. Pages
 * set their own section backgrounds within `<main>`, so the steel canvas shows through the gaps
 * exactly as it does on the home hero.
 */
export function PublicLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-sidebar text-sidebar-active-foreground">
      <PublicHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <PublicFooter />
    </div>
  );
}
