import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/app/ErrorBoundary';

/**
 * The application error boundary (audit F6, P1-4).
 *
 * Shipped in Phase 0 with no test, which is a poor fit for this component in particular: it is the
 * one piece of the app whose whole job is to run when everything else has already gone wrong, so
 * it is never exercised by any other test, never seen in a normal session, and a regression in it
 * would surface for the first time as the blank white page it exists to prevent.
 *
 * Four claims are asserted, and the second is the one that carries the component:
 *
 *   1. It is invisible when nothing throws.
 *   2. **"Try again" genuinely re-renders the same subtree.** A fallback that clears its own state
 *      but leaves the child unmounted, or one that re-throws the captured error, would look
 *      identical on screen the moment it appears — the difference only shows on the click.
 *   3. The component stack reaches the console, since a minified message alone rarely identifies
 *      the screen and there is no error-reporting service in v1 (§5).
 *   4. The stack never reaches the *screen*.
 *
 * `console.error` is silenced throughout: React logs every caught error itself, on top of this
 * component's own deliberate log, and a suite that prints a stack trace per passing test trains
 * you to ignore the output. The spy is what the log assertion reads, so nothing is lost.
 */

/**
 * A child that throws on demand. The flag is module-level rather than a prop because "Try again"
 * re-renders the *same* React element — a prop could not change between the throw and the retry,
 * so a prop-driven child could only ever prove that the fallback is sticky.
 */
let shouldThrow = true;

function Fragile() {
  if (shouldThrow) {
    throw new Error('Cannot read properties of undefined (reading "careers")');
  }

  return <p>The screen, working.</p>;
}

let consoleError: ReturnType<typeof vi.spyOn>;

function renderBoundary() {
  render(
    <ErrorBoundary>
      <Fragile />
    </ErrorBoundary>,
  );

  return userEvent.setup();
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders its children untouched when nothing throws', () => {
    shouldThrow = false;

    renderBoundary();

    expect(screen.getByText('The screen, working.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('replaces a throwing subtree with a contained, recoverable error state', () => {
    renderBoundary();

    const alert = screen.getByRole('alert');

    expect(
      screen.getByRole('heading', { name: /something went wrong on this screen/i }),
    ).toBeInTheDocument();
    expect(alert).toHaveTextContent(/nothing you had already saved has been lost/i);

    // Both routes out are offered — a fallback with no way forward is the white page with prose.
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go home/i })).toBeInTheDocument();
  });

  /** The claim the component is named for: recovery, not just a nicer-looking dead end. */
  it('recovers the screen when "Try again" is pressed and the cause was transient', async () => {
    const user = renderBoundary();

    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('The screen, working.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('returns to the fallback, rather than to a blank page, when the cause has not gone away', async () => {
    const user = renderBoundary();

    // Still throwing. The retry must be catchable a second time: `getDerivedStateFromError` runs
    // again on the re-render, so the boundary catches its own retry instead of letting the throw
    // escape to the root and unmount the app — which is exactly what it was added to prevent.
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('logs the error with its component stack, which is the part that identifies the screen', () => {
    renderBoundary();

    // React logs its own caught-error notice through the same spy, so the component's line is
    // found by its message rather than by position.
    const logged = consoleError.mock.calls.find(
      (call: unknown[]) => call[0] === 'Unhandled render error.',
    );

    expect(logged).toBeDefined();
    expect((logged?.[1] as Error).message).toContain('reading "careers"');
    // React hands the stack as a string of `at <Component>` lines; the failing child must be in it.
    expect(String(logged?.[2])).toContain('Fragile');
  });

  it('shows the message but never the stack', () => {
    renderBoundary();

    // Under Vitest `import.meta.env.DEV` is true, so this is the developer-facing branch — the one
    // that shows the most. Even here the stack stays in the console: it is noise for a student and
    // a disclosure for everyone else.
    expect(screen.getByText(/reading "careers"/)).toBeInTheDocument();
    expect(screen.queryByText(/at Fragile/)).not.toBeInTheDocument();
  });

  /**
   * "Go home" is a document navigation on purpose. If the router is what threw, a client-side push
   * would re-enter the broken tree and fail identically — so this asserts the mechanism, not just
   * that something happened.
   */
  it('leaves by full document navigation rather than a router push', async () => {
    const assign = vi.fn();
    const original = window.location;

    Object.defineProperty(window, 'location', {
      value: { ...original, assign },
      writable: true,
      configurable: true,
    });

    try {
      const user = renderBoundary();

      await user.click(screen.getByRole('button', { name: /go home/i }));

      expect(assign).toHaveBeenCalledExactlyOnceWith('/');
    } finally {
      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });
});
