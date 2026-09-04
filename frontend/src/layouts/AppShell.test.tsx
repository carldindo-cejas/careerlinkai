import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Briefcase, FileText, LayoutDashboard, Landmark, Sparkles } from 'lucide-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AppShell, type AppNavEntry } from '@/layouts/AppShell';

vi.mock('@/features/notifications/components/NotificationBell', () => ({
  NotificationBell: () => null,
}));

/**
 * Grouped navigation, and the rail that collapses when the mouse leaves it.
 *
 * Two behaviours carry the risk here. A group has to open on its own when the route inside it is
 * the one being viewed — otherwise an admin who lands on /admin/knowledge from a link sees a
 * closed drawer and no indication of where they are. And a group the person closes by hand has to
 * *stay* closed, which is the half a naive implementation gets wrong: derive open state from the
 * route alone and the toggle does nothing; store it in state alone and navigation cannot open it.
 */
const nav: AppNavEntry[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  {
    label: 'Catalog',
    icon: Landmark,
    items: [{ to: '/admin/careers', label: 'Careers', icon: Briefcase }],
  },
  {
    label: 'AI integration',
    icon: Sparkles,
    items: [{ to: '/admin/knowledge', label: 'Knowledge', icon: FileText }],
  },
];

/**
 * Expand the rail before asserting on group headings.
 *
 * The desktop sidebar is a 4rem rail until it is pointed at, so a test that queried for a group
 * heading without hovering would be asserting against the collapsed state and failing for the
 * right reason at the wrong time.
 */
function setupUser() {
  // `skipHover` matters here specifically. A click normally simulates moving the pointer onto its
  // target, and that movement leaves the rail long enough for it to collapse — so the button being
  // clicked unmounts mid-interaction and the toggle never runs. Real pointers do not teleport away
  // and back; this keeps the simulated one honest about that.
  return userEvent.setup({ skipHover: true });
}

async function expandRail(user: ReturnType<typeof userEvent.setup>) {
  await user.hover(screen.getByRole('navigation', { name: 'Main' }));
}

function renderShell(route: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/admin" element={<AppShell title="Administrator" nav={nav} />}>
            <Route index element={<p>dashboard</p>} />
            <Route path="knowledge" element={<p>knowledge</p>} />
            <Route path="careers" element={<p>careers</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell — grouped navigation', () => {
  it('opens the group holding the current route and leaves the others closed', async () => {
    const user = setupUser();
    renderShell('/admin/knowledge');
    await expandRail(user);

    // Both group headings are always present; only the open one lists its destinations.
    expect(screen.getByRole('button', { name: /AI integration/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: /Catalog/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps a group the person closed by hand closed, without the route reopening it', async () => {
    const user = setupUser();
    renderShell('/admin/knowledge');
    await expandRail(user);

    const heading = screen.getByRole('button', { name: /AI integration/ });

    await user.click(heading);

    expect(heading).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a group the person asked for even though the route is elsewhere', async () => {
    const user = setupUser();
    renderShell('/admin/knowledge');
    await expandRail(user);

    await user.click(screen.getByRole('button', { name: /Catalog/ }));

    expect(screen.getByRole('button', { name: /Catalog/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  /**
   * The destinations stay reachable at every width. In the collapsed rail there is no heading to
   * press, so the group renders its children's icons directly rather than hiding them behind a
   * disclosure nobody can see — and every one of them keeps an accessible name, because the label
   * beside the icon is what disappears, not the link's identity.
   */
  it('names every destination for assistive technology, label visible or not', () => {
    renderShell('/admin');

    expect(screen.getAllByRole('link', { name: 'Knowledge' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Careers' }).length).toBeGreaterThan(0);
  });
});
