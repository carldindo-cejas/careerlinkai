import { render, screen } from '@testing-library/react';
import { Component, Suspense, type ComponentType, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { routeGroup } from '@/routes/routeGroup';

/**
 * **The one piece of P3-3 that TypeScript cannot check for us.**
 *
 * `routeGroup` turns a named export into a `React.lazy` component through a string key. The key
 * itself is safe — `K extends keyof M` means a typo is a compile error — but the resolution is
 * runtime plumbing: `lazy` wants `{ default }` and these modules export names, so if the `.then`
 * shape were wrong every route in the app would resolve to `undefined` and render nothing. That
 * failure is silent in the exact places you would look first: the build succeeds, `tsc` succeeds,
 * and every page's own test imports the page directly and passes.
 */

function Fallback() {
  return <p>loading</p>;
}

class Catch extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    return this.state.error ? <p>caught: {this.state.error.message}</p> : this.props.children;
  }
}

describe('routeGroup', () => {
  it('resolves a named export into a rendering component', async () => {
    const pick = routeGroup(async () => ({ Page: () => <h1>Dashboard</h1> }));
    const Page = pick('Page');

    render(
      <Suspense fallback={<Fallback />}>
        <Page />
      </Suspense>,
    );

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  /**
   * The reason a *group* takes one loader instead of one `import()` per page: several routes of a
   * group resolve on a single navigation — a layout and its child always do — and they must come
   * from one module, so the bundler emits one chunk and the browser makes one request.
   */
  it('serves several routes of a group from a single module load', async () => {
    const load = vi.fn(async () => ({
      Layout: () => <h1>Shell</h1>,
      Page: () => <h2>Inside</h2>,
    }));

    const pick = routeGroup(load);
    const Layout = pick('Layout');
    const Page = pick('Page');

    render(
      <Suspense fallback={<Fallback />}>
        <Layout />
        <Page />
      </Suspense>,
    );

    await screen.findByRole('heading', { name: 'Shell' });
    expect(screen.getByRole('heading', { name: 'Inside' })).toBeInTheDocument();

    // Both components share one in-flight promise, so the group is loaded once however many of
    // its routes resolve together. Written before the memoisation existed, and it failed —
    // `routeGroup` was invoking the loader once per component. Harmless in a browser, where the
    // module registry dedupes the second `import()` of the same specifier, and not harmless in
    // general: the loader is an argument, and a caller passing anything but a bare `import()`
    // would have had it run N times.
    expect(load).toHaveBeenCalledTimes(1);
  });

  /**
   * A chunk that fails to download — a tab left open across a redeploy is the realistic case, since
   * the hashed filename it remembers is gone. `lazy` rejects, and the rejection has to reach an
   * error boundary; `ErrorBoundary` is what offers "Try again", and retrying re-runs the import.
   * A `routeGroup` that swallowed the failure would leave the fallback spinner on screen forever.
   */
  it('propagates a failed module load to the nearest error boundary', async () => {
    const pick = routeGroup<{ Page: ComponentType }>(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });

    const Page = pick('Page');

    render(
      <Catch>
        <Suspense fallback={<Fallback />}>
          <Page />
        </Suspense>
      </Catch>,
    );

    expect(await screen.findByText(/caught: Failed to fetch/)).toBeInTheDocument();
  });

  /**
   * The other half of the memoisation: the shared promise is **dropped when it rejects**, so the
   * next route of that group to mount asks the network again rather than replaying a cached
   * failure. A stale tab against a redeployed Worker is the realistic cause — the hashed filename
   * the page is holding no longer exists — and it is genuinely transient, since the chunk is there
   * under a new name the moment the document is reloaded.
   */
  it('does not cache a failure — the next route of the group loads it again', async () => {
    const load = vi
      .fn<() => Promise<{ Dashboard: ComponentType; Profile: ComponentType }>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({
        Dashboard: () => <h1>Dashboard</h1>,
        Profile: () => <h1>Profile</h1>,
      });

    const pick = routeGroup(load);
    const Dashboard = pick('Dashboard');
    const Profile = pick('Profile');

    const { rerender } = render(
      <Catch>
        <Suspense fallback={<Fallback />}>
          <Dashboard />
        </Suspense>
      </Catch>,
    );

    await screen.findByText(/caught: Failed to fetch/);

    rerender(
      <Catch key="next">
        <Suspense fallback={<Fallback />}>
          <Profile />
        </Suspense>
      </Catch>,
    );

    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  /**
   * **And the limit of that, stated as a test rather than left to be rediscovered.**
   *
   * `React.lazy` keeps its *own* cache, on the component object: once the initialiser rejects, the
   * lazy component is permanently Rejected and re-throws the stored error on every subsequent
   * render without calling the initialiser again. So dropping the promise inside `routeGroup`
   * cannot make the **same** route retry, however the boundary above it is reset — which means
   * `ErrorBoundary`'s "Try again" does not recover a failed chunk load.
   *
   * "Go home" does, and not by accident: it is `window.location.assign('/')`, a full document
   * navigation, so the browser fetches a fresh `index.html` naming the chunks that actually exist.
   * That was written for a different reason (a router that has itself thrown) and happens to be
   * exactly right for this one.
   *
   * Recorded here because the behaviour is invisible from either file on its own — `routeGroup`
   * looks like it retries and `ErrorBoundary` looks like its button works.
   */
  it('cannot retry the same route — React.lazy caches its own rejection (why "Go home" is the recovery)', async () => {
    const load = vi
      .fn<() => Promise<{ Page: ComponentType }>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ Page: () => <h1>Recovered</h1> });

    const Page = routeGroup(load)('Page');

    const { rerender } = render(
      <Catch>
        <Suspense fallback={<Fallback />}>
          <Page />
        </Suspense>
      </Catch>,
    );

    await screen.findByText(/caught: Failed to fetch/);

    // Exactly what "Try again" amounts to: the boundary resets and the same element re-renders.
    rerender(
      <Catch key="retry">
        <Suspense fallback={<Fallback />}>
          <Page />
        </Suspense>
      </Catch>,
    );

    expect(await screen.findByText(/caught: Failed to fetch/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recovered' })).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
