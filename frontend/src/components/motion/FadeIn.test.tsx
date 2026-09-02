import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FadeIn } from './FadeIn';

/**
 * P4-15 replaced Framer Motion here with a CSS keyframe. The component had no tests at all
 * before that — which is why the swap was possible in the first place, and why these exist now.
 *
 * The last two are stylesheet assertions rather than DOM ones, deliberately. jsdom does not run
 * animations, so "the panel is visible" cannot be observed here; what *can* be pinned is the
 * property that makes it true — that the element's un-animated state is its finished state. That
 * fact lives in `index.css`, so that is where it is asserted.
 */

// Off `process.cwd()` (the `frontend/` project root) rather than `import.meta.url`, which under
// jsdom is the `http://` URL Vitest served this module from and not a path any fs call can take.
const stylesheet = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

const baseRule = /\.fade-in-rise\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '';
const keyframes = /@keyframes\s+fade-in-rise\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(stylesheet)?.[1];

describe('FadeIn', () => {
  it('renders its children', () => {
    render(
      <FadeIn>
        <p>Find where your strengths point.</p>
      </FadeIn>,
    );

    expect(screen.getByText('Find where your strengths point.')).toBeInTheDocument();
  });

  it('keeps the caller layout class alongside the animation class', () => {
    // Every one of the three call sites passes layout (`w-full max-w-md`, `mx-auto max-w-xl`).
    // `cn` runs both through tailwind-merge, and a helper that silently dropped the unrecognised
    // one would collapse the sign-in card to its content width on every screen.
    render(
      <FadeIn className="w-full max-w-md">
        <p>Join your class</p>
      </FadeIn>,
    );

    const wrapper = screen.getByText('Join your class').parentElement;

    expect(wrapper).toHaveClass('fade-in-rise', 'w-full', 'max-w-md');
  });

  it('ships no style attribute when it is not staggered', () => {
    render(
      <FadeIn>
        <p>No delay</p>
      </FadeIn>,
    );

    expect(screen.getByText('No delay').parentElement).not.toHaveAttribute('style');
  });

  it('reads delay in seconds, as the Framer Motion prop it replaces did', () => {
    // Both staggered call sites pass `delay={0.05}`. Read as milliseconds that is 50 µs — an
    // animation that appears un-staggered, on two screens, with nothing failing to say so.
    render(
      <FadeIn delay={0.05}>
        <p>Staggered</p>
      </FadeIn>,
    );

    expect(screen.getByText('Staggered').parentElement).toHaveStyle({ animationDelay: '0.05s' });
  });

  it('never sets an opacity of its own — the un-animated element is the finished one', () => {
    // The blank-panel guard. The obvious way to write this animation is `opacity: 0` on the base
    // class, restored by the keyframe; that spelling leaves the content permanently invisible
    // anywhere the animation does not run — reduced motion, print, a browser that skipped it.
    // Instead the keyframe declares only `from`, so the implicit `to` is the element's own
    // computed style and *not animating is the visible state*.
    expect(baseRule).not.toMatch(/opacity/);
    expect(baseRule).toMatch(/animation:[^;]*backwards/);

    expect(keyframes).toBeDefined();
    expect(keyframes).toMatch(/from\s*\{/);
    expect(keyframes).not.toMatch(/\bto\s*\{|100%\s*\{/);
  });

  it('turns the animation off for prefers-reduced-motion', () => {
    // This is what `useReducedMotion()` used to do, and the reason it is not missed.
    expect(stylesheet).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.fade-in-rise\s*\{\s*animation:\s*none/,
    );
  });
});
