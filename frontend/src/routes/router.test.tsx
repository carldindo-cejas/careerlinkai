import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
 * **Compile the route groups before anything is timed.**
 *
 * These tests used to carry a 15 s `RESOLVE` budget on every `findByRole`, because under Vitest the
 * `import()` behind each route resolves against the dev transform pipeline rather than a served
 * chunk — so the *first* render of a group compiles it. Measured with a cleared cache, that is the
 * whole cost: the public group (four pages plus Framer Motion) took **1,153 ms**, auth and access
 * ~325 ms each, and the three tests reaching already-compiled routes took **33, 32 and 8 ms**. The
 * assertion was spending ~97% of its time measuring Vite, which is not what it is asserting, and
 * that is the term that inflates under CPU contention — enough to blow a 15 s budget on run 14 of a
 * 20-run load campaign.
 *
 * Importing the groups here pays that cost once, in a hook. **A hook may be generous precisely
 * because it asserts nothing**: it is buying a known, bounded, one-time compile, not waiting on a
 * condition that might never arrive.
 *
 * **What this actually bought, measured rather than predicted — and it was less than predicted.**
 * The first test went 1,153 ms → **392 ms**, not to the ~30 ms the warm tests suggested. Auth and
 * access barely moved (327→341, 323→333). So ~760 ms of the first test was compilation and ~330 ms
 * per group is something warming cannot touch: React.lazy's own suspend-and-resolve cycle, which
 * happens once per lazy component however fast the module arrives. The three "fast" tests are fast
 * because earlier tests already resolved their groups, not because their routes are cheaper.
 *
 * **This does not soften the fallback assertion**, and the suite proves it rather than assuming it:
 * `routeGroup` hands back `lazy(...)` components built at module scope (`router.tsx`), none of which
 * has rendered yet, so React still suspends and still paints `Loading…`. If warming had collapsed
 * that, the synchronous `getByRole('status')` below would throw on the first test — it passes, which
 * is the assertion doing its job.
 */
beforeAll(async () => {
  await Promise.all([
    import('@/routes/groups/public'),
    import('@/routes/groups/auth'),
    import('@/routes/groups/access'),
  ]);
}, 60_000);

/**
 * **10 s, and deleting it was tried first and was wrong.**
 *
 * The plan for this change was to drop the old per-call budget entirely and let these assertions
 * inherit the suite's 5 s (`setupTests.ts`), on the reasoning that warming had made them trivial.
 * The measurement above says otherwise, and the arithmetic is the point: **before**, 1,153 ms inside
 * a 15 s budget needed ~13× inflation to fail — which is exactly what run 14 delivered. **Warmed but
 * inheriting 5 s**, 392 ms needs ~12.8×. That is the same test, no more robust, failing marginally
 * sooner. Halving the cost while cutting the budget by two thirds buys nothing.
 *
 * 10 s restores the margin the warming earned — 392 ms is **~25×** under it — and stays below the
 * suite's 15 s `testTimeout`, which is the constraint run 14 taught: an assertion budget at or above
 * the test budget can never fire, so the failure arrives as a runner stack naming nothing instead of
 * `Unable to find role="heading" …` with the DOM. Fast enough to be a useful signal, slow enough not
 * to be a coin toss, and reportable when it does lose.
 */
const RESOLVE = { timeout: 10_000 };

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
