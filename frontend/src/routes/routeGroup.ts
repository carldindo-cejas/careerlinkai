import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * One chunk per route group, several routes per chunk (P3-3, audit P2).
 *
 * `React.lazy` is per *component*, so the obvious spelling — `lazy(() => import(page))` eleven
 * times for the admin shell — produces eleven chunks and eleven round trips as an admin walks
 * their own sidebar. Pages inside one shell are reached together, so they should arrive together.
 *
 * This takes the group's barrel loader once and hands back a `pick`. Every component it returns
 * shares a single in-flight promise, so a group is fetched once however many of its routes resolve
 * at the same moment — and a layout and its child always do.
 *
 * Named exports rather than defaults, deliberately: the pages predate this file and renaming
 * thirty exports to `default` to satisfy a bundler is a change to the product's shape made for
 * the build's convenience. One `await` costs less.
 */
export function routeGroup<M extends Record<string, ComponentType>>(load: () => Promise<M>) {
  let pending: Promise<M> | null = null;

  /**
   * **A failed load is deliberately not remembered.**
   *
   * The realistic failure here is a tab left open across a deploy: the hashed chunk filename the
   * page is holding no longer exists, and the `import()` rejects. `ErrorBoundary` catches that and
   * offers "Try again" — which is only worth pressing if the retry actually re-requests the
   * module. Caching the rejected promise would make every retry replay the original failure
   * instantly, turning a recoverable network error into a screen that can only be fixed by a
   * manual reload, while looking for all the world like it had tried.
   */
  const once = () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });

    return pending;
  };

  return function pick<K extends keyof M>(name: K): LazyExoticComponent<M[K]> {
    return lazy(async () => ({ default: (await once())[name] }));
  };
}
