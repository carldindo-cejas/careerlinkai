import { LogOut, Menu, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { Logo } from '@/components/brand/Logo';
import { Corners } from '@/components/ui/blueprint';
import { cn } from '@/components/ui/cn';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { useLogout } from '@/features/auth/hooks/useAuth';
import { NotificationBell } from '@/features/notifications/components/NotificationBell';
import { useAuthStore } from '@/stores/authStore';

export interface AppNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Exact-match only — "Dashboard" needs it, or /admin/colleges lights it up too. */
  end?: boolean;
}

export interface AppShellProps {
  title: string;
  nav: AppNavItem[];
  /** Extra chrome next to the breadcrumb — the student shell shows the joined class here. */
  headerBadge?: ReactNode;
  /**
   * Runs after sign-out settles. The student shell clears the joined-class context here
   * so the next student on a shared lab machine never sees the last one's class.
   */
  onSignedOut?: () => void;
}

/**
 * The signed-in application shell (FULLPLAN §35) — one layout system for all three
 * roles: a deep-navy sidebar (the reference layout) collapsing to a sheet drawer under
 * `lg`, and a sticky top bar with the notification bell and identity. AdminLayout,
 * CounselorLayout and StudentLayout compose this; they differ only in title, navigation
 * and the small role-specific chrome passed through props.
 */
export function AppShell({ title, nav, headerBadge, onSignedOut }: AppShellProps) {
  const user = useAuthStore((state) => state.user);
  const logout = useLogout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  const sidebar = (
    <SidebarBody
      title={title}
      nav={nav}
      userName={user?.name ?? null}
      userRole={user?.role ?? null}
      signingOut={logout.isPending}
      onSignOut={() =>
        logout.mutate(undefined, onSignedOut ? { onSettled: onSignedOut } : undefined)
      }
    />
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-sidebar lg:flex">
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: drawer trigger on mobile, bell + identity everywhere. */}
        <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                <SheetTrigger
                  aria-label="Open menu"
                  className="rounded-none p-2 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
                >
                  <Menu className="size-5" aria-hidden="true" />
                </SheetTrigger>
                <SheetContent side="left" title={`${title} navigation`}>
                  <div onClick={(event) => {
                    // Close the drawer when a nav link inside it is clicked.
                    if ((event.target as HTMLElement).closest('a')) {
                      setDrawerOpen(false);
                    }
                  }}>
                    {sidebar}
                  </div>
                </SheetContent>
              </Sheet>

              <div className="lg:hidden">
                <Logo />
              </div>

              {/* Breadcrumb trail on desktop — the sidebar already carries the brand. */}
              <Breadcrumbs title={title} nav={nav} pathname={location.pathname} />

              {headerBadge}
            </div>

            <div className="flex items-center gap-3">
              <NotificationBell />
              {user ? (
                <span className="hidden items-center gap-2 sm:flex">
                  <span className="relative flex size-8 items-center justify-center border border-border bg-primary/10 text-sm font-semibold tabular-nums text-primary">
                    <Corners />
                    {initials(user.name)}
                  </span>
                  <span className="text-sm text-foreground/80">{user.name}</span>
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );

}

/**
 * A real trail rather than a bare section label: `Admin / Colleges`, with the root linking to the
 * shell's first nav item (its dashboard). Two levels is all the route data honestly supports —
 * a detail route like /admin/colleges/:id matches its list's prefix, so it names the section it
 * sits under and does not invent a leaf label it has no source for.
 */
function Breadcrumbs({
  title,
  nav,
  pathname,
}: {
  title: string;
  nav: AppNavItem[];
  pathname: string;
}) {
  const root = nav[0];
  const match = nav
    .filter((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)))
    .sort((a, b) => b.to.length - a.to.length)[0];

  // At the root itself the trail would read "Admin / Dashboard" — the section alone is truer.
  const leaf = match && match.to !== root?.to ? match.label : null;

  return (
    <nav aria-label="Breadcrumb" className="hidden text-sm lg:block">
      <ol className="flex items-center gap-1.5">
        <li>
          {root ? (
            <NavLink
              to={root.to}
              className="uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
            >
              {title}
            </NavLink>
          ) : (
            <span className="uppercase tracking-wide text-muted-foreground">{title}</span>
          )}
        </li>
        {leaf ? (
          <>
            <li aria-hidden="true" className="text-border">
              /
            </li>
            <li className="font-medium text-foreground" aria-current="page">
              {leaf}
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}

function SidebarBody({
  title,
  nav,
  userName,
  userRole,
  signingOut,
  onSignOut,
}: {
  title: string;
  nav: AppNavItem[];
  userName: string | null;
  userRole: string | null;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pb-5 pt-6">
        <Logo wordmarkClassName="text-sidebar-foreground" />
        <p className="mt-1.5 pl-[2.9rem] text-xs font-medium uppercase tracking-widest text-sidebar-muted">
          {title}
        </p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3">
        {nav.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end ?? false}
              className={({ isActive }) =>
                cn(
                  // The transparent left border on the inactive state reserves the accent bar's
                  // width, so lighting a link up never shifts its label sideways.
                  'flex items-center gap-3 rounded-none border-l-2 px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-primary bg-sidebar-active text-sidebar-active-foreground'
                    : 'border-transparent text-sidebar-muted hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground',
                )
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        {userName ? (
          <div className="flex items-center gap-3 px-2 pb-3 pt-1">
            <span className="relative flex size-8 shrink-0 items-center justify-center border border-sidebar-border bg-sidebar-active text-sm font-semibold text-sidebar-active-foreground">
              <Corners />
              {initials(userName)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-sidebar-active-foreground">
                {userName}
              </span>
              <span className="block text-xs capitalize text-sidebar-muted">{userRole}</span>
            </span>
          </div>
        ) : null}

        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="flex w-full items-center gap-3 rounded-none border-l-2 border-transparent px-3 py-2.5 text-sm font-medium text-sidebar-muted transition-colors hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground disabled:opacity-50"
        >
          <LogOut className="size-4" aria-hidden="true" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}
