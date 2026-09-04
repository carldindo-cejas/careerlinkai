import { ChevronDown, LogOut, Menu, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { Logo } from '@/components/brand/Logo';
import { Corners } from '@/components/ui/blueprint';
import { cn } from '@/components/ui/cn';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { useLogout } from '@/features/auth/hooks/useAuth';
import { NotificationBell } from '@/features/notifications/components/NotificationBell';
import { BackButton } from '@/routes/BackButton';
import { useAuthStore } from '@/stores/authStore';

export interface AppNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Exact-match only — "Dashboard" needs it, or /admin/colleges lights it up too. */
  end?: boolean;
}

/**
 * A named set of destinations that belong to one another.
 *
 * The admin shell earned this: eleven flat links is a list you read rather than a structure you
 * navigate, and three of them were AI screens sitting between the catalog and the audit log for no
 * reason a person could infer. Grouping states the relationship the routes already had.
 *
 * The counselor and student shells stay flat, and deliberately — four destinations do not need
 * chapters, and a group of one is a worse label than no group at all.
 */
export interface AppNavGroup {
  label: string;
  icon: LucideIcon;
  items: AppNavItem[];
}

export type AppNavEntry = AppNavItem | AppNavGroup;

function isGroup(entry: AppNavEntry): entry is AppNavGroup {
  return 'items' in entry;
}

/** Every destination in a nav, groups flattened — for breadcrumbs and active-state lookups. */
function flatten(nav: AppNavEntry[]): AppNavItem[] {
  return nav.flatMap((entry) => (isGroup(entry) ? entry.items : [entry]));
}

/** Whether a route is the one being viewed, by the same rule NavLink uses. */
function matches(item: AppNavItem, pathname: string): boolean {
  return item.end ? pathname === item.to : pathname.startsWith(item.to);
}

export interface AppShellProps {
  title: string;
  nav: AppNavEntry[];
  /** Extra chrome next to the breadcrumb — the student shell shows the joined class here. */
  headerBadge?: ReactNode;
  /**
   * A full-width strip between the top bar and the page, on **every** route in this shell.
   *
   * The student shell puts its profiling warning here (v1.6). It belongs to the layout rather than
   * to a page because the thing it warns about — recommendations being unavailable — is reachable
   * from every destination, and a warning that only appeared on the dashboard would be invisible to
   * the student who goes straight to Assessments. Renders nothing when the banner has nothing to
   * say, so no shell pays for it in layout.
   */
  banner?: ReactNode;
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
export function AppShell({ title, nav, headerBadge, banner, onSignedOut }: AppShellProps) {
  const user = useAuthStore((state) => state.user);
  const logout = useLogout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const location = useLocation();

  // The drawer copy is always expanded: a rail that collapses on mouse-out makes no sense inside a
  // sheet the user opened deliberately and closes by tapping away.
  const sidebar = (
    <SidebarBody
      title={title}
      nav={nav}
      pathname={location.pathname}
      expanded
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
      {/*
        The skip link, first in the DOM and visible only while focused.

        The sidebar is eight or nine navigation links, and it is rendered before the page content
        on every route in this shell — so without this, a keyboard or screen-reader user tabs
        through the whole navigation again on every single screen. On the assessment player, which
        a student reaches sixty times in a row, that is the difference between the product being
        usable without a mouse and merely being operable.
      */}
      <a
        href="#main-content"
        // `fixed`, not `absolute`: nothing here establishes a containing block, so an absolutely
        // positioned link is placed against the document and scrolls away with it. The link is
        // normally the first thing Tab reaches, but it is also what Shift+Tab reaches from the
        // top of a scrolled page — and landing on an invisible focused element is the bug this
        // whole control exists to prevent.
        className="sr-only rounded-none bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to main content
      </a>

      {/*
        Desktop sidebar — a 4rem rail that grows to 16rem while pointed at.

        The rail is what sits *in flow*; the panel that grows is absolutely positioned on top of
        it. That split is the whole trick: animating the width of an in-flow sidebar reflows the
        entire page on every hover, which on a table-heavy admin screen means text rewrapping under
        the cursor. Here the content column never moves.

        `focus-within` matters as much as hover — a keyboard user tabbing into the navigation must
        see where they are, and a rail that only ever opened for a mouse would be unusable without
        one.
      */}
      <aside className="sticky top-0 hidden h-screen w-16 shrink-0 lg:block">
        <div
          onMouseEnter={() => setRailExpanded(true)}
          onMouseLeave={() => setRailExpanded(false)}
          // Focus expands it too, and through the same state rather than through a
          // `focus-within:` width. Widening in CSS alone would give a keyboard user a 16rem panel
          // still rendering its collapsed contents — a wide empty rail, which is worse than the
          // narrow one they started with.
          onFocus={() => setRailExpanded(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setRailExpanded(false);
            }
          }}
          className={cn(
            'absolute inset-y-0 left-0 z-30 flex flex-col overflow-hidden bg-sidebar',
            'transition-[width] duration-200 ease-out motion-reduce:transition-none',
            railExpanded ? 'w-64 shadow-xl shadow-black/20' : 'w-16',
          )}
        >
          <SidebarBody
            title={title}
            nav={nav}
            pathname={location.pathname}
            expanded={railExpanded}
            userName={user?.name ?? null}
            userRole={user?.role ?? null}
            signingOut={logout.isPending}
            onSignOut={() =>
              logout.mutate(undefined, onSignedOut ? { onSettled: onSignedOut } : undefined)
            }
          />
        </div>
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

        {/* Full-bleed, directly under the sticky top bar and above the content column — so it
            reads as a property of the session rather than as the first card on a page. */}
        {banner}

        {/* `tabIndex={-1}` so the skip link above can actually put focus here. A bare `#id` target
            that is not focusable moves the *scroll* position and leaves the focus ring back on the
            link, so the next Tab returns to the navigation the student just skipped. */}
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 p-4 focus-visible:outline-none sm:p-6">
          {/*
            One step back, above the page and inside the content column so it lines up with the
            page's own heading. It sits here rather than in the top bar because the top bar is
            sticky chrome that belongs to the session — where you are — and this belongs to the
            page. On a dashboard it renders nothing, margin included.

            It is deliberately *after* the skip-link target: a keyboard user who skips the
            navigation lands on the shortest way out of the screen they just skipped into.
          */}
          <BackButton className="mb-4" />
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
  nav: AppNavEntry[];
  pathname: string;
}) {
  const items = flatten(nav);
  const root = items[0];
  const match = items
    .filter((item) => matches(item, pathname))
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
  pathname,
  expanded,
  userName,
  userRole,
  signingOut,
  onSignOut,
}: {
  title: string;
  nav: AppNavEntry[];
  pathname: string;
  expanded: boolean;
  userName: string | null;
  userRole: string | null;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  /**
   * Which groups the person has opened or closed *by hand*.
   *
   * Only their explicit choices live here. A group holding the current route opens on its own, and
   * storing that as state would fight the route: navigating into a closed group has to open it,
   * and an effect writing that back would then argue with the next click. Keeping intent and
   * derivation separate means neither has to know about the other.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  return (
    <div className="flex h-full flex-col">
      <div className={cn('pb-5 pt-6', expanded ? 'px-5' : 'px-4')}>
        <Logo wordmarkClassName="text-sidebar-foreground" withWordmark={expanded} />
        {expanded ? (
          <p className="mt-1.5 pl-[2.9rem] text-xs font-medium uppercase tracking-widest text-sidebar-muted">
            {title}
          </p>
        ) : null}
      </div>

      {/*
        `no-scrollbar` hides the track, it does not remove the scrolling. Grouping makes the admin
        nav short enough to fit without one, but a shell whose content overflowed and could not be
        reached would be a worse bug than the scrollbar ever was.
      */}
      <nav aria-label="Main" className="no-scrollbar flex-1 space-y-1 overflow-y-auto px-3">
        {nav.map((entry) =>
          isGroup(entry) ? (
            <NavGroup
              key={entry.label}
              group={entry}
              pathname={pathname}
              expanded={expanded}
              open={toggled[entry.label] ?? entry.items.some((item) => matches(item, pathname))}
              onToggle={() =>
                setToggled((current) => ({
                  ...current,
                  [entry.label]: !(
                    current[entry.label] ?? entry.items.some((item) => matches(item, pathname))
                  ),
                }))
              }
            />
          ) : (
            <NavRow key={entry.to} item={entry} expanded={expanded} />
          ),
        )}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        {userName ? (
          <div className={cn('flex items-center gap-3 pb-3 pt-1', expanded ? 'px-2' : 'px-0')}>
            <span className="relative flex size-8 shrink-0 items-center justify-center border border-sidebar-border bg-sidebar-active text-sm font-semibold text-sidebar-active-foreground">
              <Corners />
              {initials(userName)}
            </span>
            {expanded ? (
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-sidebar-active-foreground">
                  {userName}
                </span>
                <span className="block text-xs capitalize text-sidebar-muted">{userRole}</span>
              </span>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          title={expanded ? undefined : 'Sign out'}
          className="flex w-full items-center gap-3 rounded-none border-l-2 border-transparent px-3 py-2.5 text-sm font-medium text-sidebar-muted transition-colors hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground disabled:opacity-50"
        >
          <LogOut className="size-4 shrink-0" aria-hidden="true" />
          {expanded ? (
            <span className="truncate">{signingOut ? 'Signing out…' : 'Sign out'}</span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

/**
 * One destination.
 *
 * `nested` insets the row so a group's children read as belonging to their heading rather than as
 * siblings of it — the only thing distinguishing them once the accent bar is spent on active
 * state.
 */
function NavRow({
  item,
  expanded,
  nested = false,
}: {
  item: AppNavItem;
  expanded: boolean;
  nested?: boolean;
}) {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      // The label is invisible in the rail, so the tooltip has to carry the name for a mouse user
      // and `aria-label` has to carry it for everyone else.
      title={expanded ? undefined : item.label}
      aria-label={item.label}
      className={({ isActive }) =>
        cn(
          // The transparent left border on the inactive state reserves the accent bar's
          // width, so lighting a link up never shifts its label sideways.
          'flex items-center gap-3 rounded-none border-l-2 px-3 py-2.5 text-sm font-medium transition-colors',
          nested && expanded && 'pl-7',
          isActive
            ? 'border-primary bg-sidebar-active text-sidebar-active-foreground'
            : 'border-transparent text-sidebar-muted hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground',
        )
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {expanded ? <span className="truncate">{item.label}</span> : null}
    </NavLink>
  );
}

/**
 * A collapsible set of destinations.
 *
 * In the rail there is no heading to press and no room for one, so the group renders as its
 * children's icons instead. The shortest path to a destination stays one click at every width,
 * which a disclosure that had to be opened first would not.
 */
function NavGroup({
  group,
  pathname,
  expanded,
  open,
  onToggle,
}: {
  group: AppNavGroup;
  pathname: string;
  expanded: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = group.icon;
  const holdsCurrent = group.items.some((item) => matches(item, pathname));

  if (!expanded) {
    return (
      <div className="space-y-1">
        {group.items.map((item) => (
          <NavRow key={item.to} item={item} expanded={false} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-3 rounded-none border-l-2 border-transparent px-3 py-2.5 text-sm font-medium transition-colors hover:bg-sidebar-active/60',
          // A closed group holding the current route still has to look like where you are.
          holdsCurrent && !open
            ? 'text-sidebar-active-foreground'
            : 'text-sidebar-muted hover:text-sidebar-active-foreground',
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate text-left">{group.label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
      </button>

      {open ? (
        <div className="space-y-1">
          {group.items.map((item) => (
            <NavRow key={item.to} item={item} expanded nested />
          ))}
        </div>
      ) : null}
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
