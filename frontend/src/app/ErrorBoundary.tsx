import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

/**
 * The application error boundary (audit F6).
 *
 * React unmounts the **entire tree** when a render throws and nothing catches it — not the
 * failing component, the whole app. Without a boundary the result is a blank white page with no
 * navigation, no message and no way back except a manual reload, from any single unhandled throw
 * in any of the ~50 screens. That is the worst possible failure mode for a live demo and a poor
 * one for a school, so this exists to convert it into a contained, recoverable error state.
 *
 * **A class component on purpose.** There is no hook equivalent — `componentDidCatch` and
 * `getDerivedStateFromError` are the only React APIs that catch a descendant's render error, and
 * both are class-only. This is the one place in the codebase that is not a function component.
 *
 * ## What it does and does not catch
 *
 * It catches errors thrown during **render, in lifecycle methods, and in constructors** of the
 * tree below it. It does **not** catch errors in event handlers, in `setTimeout`, or in rejected
 * promises — those never enter React's rendering path. That is not a gap to work around here:
 * async failures in this app are TanStack Query's business and surface as `isError` on the screen
 * that asked, which is a better-placed message than a full-page fallback would be.
 *
 * ## Recovery
 *
 * "Try again" clears the error state and re-renders the same route, which is the right first move
 * for a transient failure (a bad response shape, a race). "Go home" performs a **full document
 * navigation** rather than a router push: if the router itself is what threw, a client-side
 * navigation would re-enter the broken tree and fail identically. A hard load rebuilds everything.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the part that makes a production error report actionable — a
    // minified message alone rarely identifies the screen. Left as console.error deliberately:
    // there is no error-reporting service in v1 (§5), and inventing a fetch to nowhere here
    // would fail inside the handler that exists to handle failures.
    console.error('Unhandled render error.', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  private readonly goHome = (): void => {
    window.location.assign('/');
  };

  override render(): ReactNode {
    const { error } = this.state;

    if (error === null) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Something went wrong on this screen.
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The rest of CareerLinkAI is unaffected. Try this screen again, or go back to your
          dashboard — nothing you had already saved has been lost.
        </p>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={this.reset}>Try again</Button>
          <Button variant="outline" onClick={this.goHome}>
            Go home
          </Button>
        </div>

        {/*
          The message, but never the stack. A stack in the UI is noise for a student and a
          disclosure for everyone else; `componentDidCatch` has already put both in the console
          for whoever is actually debugging.
        */}
        {import.meta.env.DEV ? (
          <pre className="mt-4 max-w-full overflow-x-auto rounded-none border border-border p-3 text-left font-mono text-xs text-muted-foreground">
            {error.message}
          </pre>
        ) : null}
      </div>
    );
  }
}
