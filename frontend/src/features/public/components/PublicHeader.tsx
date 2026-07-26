import { ArrowRight, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { Logo } from '@/components/brand/Logo';
import { cn } from '@/components/ui/cn';
import { homePathForRole, paths } from '@/routes/paths';
import { useAuthStore } from '@/stores/authStore';

/**
 * The public site's top navigation, shared by every unauthenticated page (Home, Colleges, Careers)
 * so the bar can never drift between them (prompt-driven, v1.5).
 *
 * The links are the four the prompt names — Home, How It Works, Colleges, Careers. "How it works" is
 * a section of the home page rather than a page of its own, so it is a hash link; arriving on `/` with
 * that hash scrolls to the section (see `HomePage`). On a narrow screen the links collapse behind a
 * menu button rather than competing with the sign-in actions for the row.
 */

interface NavItem {
  label: string;
  to: string;
  /** A hash link points at a section of the home page, not a route — it never shows as "active". */
  hash?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', to: paths.landing },
  { label: 'How It Works', to: `${paths.landing}#how-it-works`, hash: true },
  { label: 'Colleges', to: paths.publicColleges },
  { label: 'Careers', to: paths.publicCareers },
];

export function PublicHeader() {
  const user = useAuthStore((state) => state.user);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  function isActive(item: NavItem): boolean {
    if (item.hash) return false;

    return location.pathname === item.to;
  }

  return (
    <header className="sticky top-0 z-40 border-b border-sidebar-border bg-sidebar/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link to={paths.landing} aria-label="CareerLinkAI home">
          <Logo wordmarkClassName="text-sidebar-active-foreground" />
        </Link>

        {/* Primary nav — inline on desktop, behind the menu button on mobile. */}
        <nav className="hidden items-center gap-6 text-sm text-sidebar-foreground md:flex">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.label}
              to={item.to}
              className={cn(
                'transition-colors hover:text-sidebar-active-foreground',
                isActive(item) && 'font-medium text-sidebar-active-foreground',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {user ? (
            <Link
              to={homePathForRole(user.role)}
              className="inline-flex h-9 items-center gap-1.5 rounded-none bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#4d7196]"
            >
              Go to my dashboard
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          ) : (
            <>
              <Link
                to={paths.login}
                className="hidden h-9 items-center rounded-none px-4 text-sm font-medium text-sidebar-foreground transition-colors hover:text-sidebar-active-foreground sm:inline-flex"
              >
                Counselor Login
              </Link>
              <Link
                to={paths.studentAccess}
                className="inline-flex h-9 items-center gap-1.5 rounded-none bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#4d7196]"
              >
                Join your class
              </Link>
            </>
          )}

          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-none text-sidebar-foreground transition-colors hover:text-sidebar-active-foreground md:hidden"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Mobile menu — the same links, revealed below the bar. */}
      {menuOpen ? (
        <nav className="border-t border-sidebar-border bg-sidebar px-4 py-2 md:hidden">
          <ul className="flex flex-col">
            {NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <Link
                  to={item.to}
                  onClick={() => setMenuOpen(false)}
                  className={cn(
                    'block py-2 text-sm text-sidebar-foreground transition-colors hover:text-sidebar-active-foreground',
                    isActive(item) && 'font-medium text-sidebar-active-foreground',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            {!user ? (
              <li>
                <Link
                  to={paths.login}
                  onClick={() => setMenuOpen(false)}
                  className="block py-2 text-sm text-sidebar-foreground transition-colors hover:text-sidebar-active-foreground sm:hidden"
                >
                  Counselor Login
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
