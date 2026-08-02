import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * The one entrance animation the app uses (design brief: subtle, never showy) — a short
 * fade-and-rise on mount. `delay` staggers siblings.
 *
 * The animation itself is `.fade-in-rise` in `src/index.css`; this component is the seam that
 * names it. It was Framer Motion until P4-15 — 121 KiB of animation runtime to fade a div, on
 * a screen a student opens before they have signed in to anything. See the stylesheet for why
 * the keyframes declare only `from`.
 *
 * Reduced motion is handled by the stylesheet's media query rather than by
 * `useReducedMotion()`. That is a small correctness gain on top of the size one: the hook
 * returned `null` on the first render and the real answer on the second, so a user who asked
 * their OS for less movement got the animation anyway on a fast paint, and a user who changed
 * the setting saw no effect until the component remounted. CSS re-evaluates on both.
 */
export function FadeIn({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** Seconds, matching the Framer Motion prop this replaces. */
  delay?: number;
  className?: string;
}) {
  // Inline only when it is not the default, so the common case ships no style attribute at all.
  // An inline declaration beats the class's `animation` shorthand on specificity, which is what
  // lets the shorthand keep owning duration, easing and fill mode.
  const style: CSSProperties | undefined = delay > 0 ? { animationDelay: `${delay}s` } : undefined;

  return (
    <div className={cn('fade-in-rise', className)} style={style}>
      {children}
    </div>
  );
}
