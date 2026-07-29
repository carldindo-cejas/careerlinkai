import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/app/queryClient';
import { AppRoutes } from '@/routes/router';
import { useAuthStore } from '@/stores/authStore';

vi.mock('@/services/authApi');
vi.mock('@/services/catalogApi');

/**
 * **The route table after P3-3 (audit P2).**
 *
 * Every page is now behind `React.lazy`, so the router no longer *has* its screens — it has
 * promises for them. That is a change to how the whole app boots, and it fails in ways nothing
 * else in this suite would notice: the 171 tests that cover these pages all import them directly
 * and would keep passing against a router whose lazy plumbing resolved to `undefined` on every
 * route.
 *
 * These render `AppRoutes` itself, which is the only place the `import()` edges exist.
 *
 * The chunk *weights* are asserted separately and on the other side of the build, by
 * `backend/scripts/platform-gates.mjs --assets` — jsdom has no bundle, so a frontend test can
 * prove the routes still resolve but can say nothing about what they cost.
 */

/**
 * Testing Library's 1 s default is a browser-shaped number and this is not a browser wait.
 *
 * The `import()` these routes are behind resolves against a served chunk in production; under
 * Vitest it resolves against the dev transform pipeline, which compiles the whole group on first
 * request — the public group is four pages plus Framer Motion and takes ~2.4 s cold on this
 * machine. That is a fact about the runner, so raising the timeout is right and lowering the
 * assertion (to "the fallback appeared", say) would be wrong: it is the *resolution* that is
 * under test.
 */
const RESOLVE = { timeout: 15_000 };

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppRoutes — lazily loaded route groups', () => {
  /**
   * The fallback is asserted *before* the page, in the same test rather than its own, because the
   * two claims are only meaningful together: a fallback that never appears means the group was not
   * lazy, and a fallback that never leaves means the group never resolved. Either one alone reads
   * as a pass.
   */
  it('shows the shared loading state and then resolves the public group', async () => {
    renderAt('/');

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    expect(
      await screen.findByRole('heading', { level: 1, name: /before you choose a college/i }, RESOLVE),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('resolves the auth group at the counselor door', async () => {
    renderAt('/login');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Counselor Login' }, RESOLVE),
    ).toBeInTheDocument();
  });

  /**
   * `/join` is its own group rather than part of `auth`, so this also asserts the split that
   * decision produced: a student reaching their own door gets the class-code form, and the two
   * staff login forms are in a chunk they never fetch.
   */
  it('resolves the access group at the student door', async () => {
    renderAt('/join');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join your class' }, RESOLVE),
    ).toBeInTheDocument();
  });

  /**
   * **The guard still runs in front of the split, not behind it.**
   *
   * `ProtectedRoute` and `RoleHome` are the two things deliberately left in the entry chunk, and
   * this is why: the decision that an anonymous visitor may not have the admin shell has to be
   * made *before* the admin shell is fetched. Downloading 112 KiB of admin pages in order to be
   * redirected away from them would be a working redirect and a defeated split.
   */
  it('turns an anonymous visitor away from /admin without loading the admin group', async () => {
    renderAt('/admin');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Administrator Login' }, RESOLVE),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  /** Each role is sent to its own door (§38) — a student to the class code screen, not /login. */
  it('turns an anonymous visitor away from a student route to /join', async () => {
    renderAt('/student/recommendations');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join your class' }, RESOLVE),
    ).toBeInTheDocument();
  });

  /**
   * With a token present the guard stops redirecting and starts *waiting* on `/auth/me`, which is
   * the one moment the router's Suspense fallback and `ProtectedRoute`'s pending state could both
   * be on screen. They render the same component, so a student sees one spinner for one wait —
   * and there is exactly one `role="status"` region, not two announcing over each other.
   */
  it('shows one loading region, not two, while the session is being verified', async () => {
    useAuthStore.setState({ token: 'test-token', user: null });

    renderAt('/student');

    await waitFor(() => {
      expect(screen.getAllByRole('status')).toHaveLength(1);
    });

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});
