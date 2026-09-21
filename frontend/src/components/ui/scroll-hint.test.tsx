import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ScrollHint } from '@/components/ui/scroll-hint';

/**
 * The hint has exactly one job and one way to fail it: appearing when the page does not in fact
 * continue, or staying up after the student already knows that it does. jsdom lays nothing out,
 * so the scroll geometry is stated here rather than measured — which is the right level anyway,
 * since what is under test is the rule, not the browser's box model.
 */

const original = {
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
};

function page({ content, viewport }: { content: number; viewport: number }) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: content,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: viewport,
    configurable: true,
  });
}

function scrollTo(offset: number) {
  window.scrollY = offset;
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

afterEach(() => {
  window.scrollY = 0;

  for (const [name, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
    else Reflect.deleteProperty(document.documentElement, name);
  }
});

describe('the "more below" hint', () => {
  it('points down when the page runs past the bottom of the screen', async () => {
    page({ content: 2000, viewport: 640 });

    render(<ScrollHint />);

    const hint = await screen.findByTestId('scroll-hint');
    // Decorative: the student is being nudged, not told something a screen reader needs.
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    // Three arrows, and nothing tappable.
    expect(hint.querySelectorAll('svg')).toHaveLength(3);
    expect(hint.className).toContain('pointer-events-none');
    // Phones only — a laptop's own scrollbar already says this.
    expect(hint.className).toContain('md:hidden');
  });

  it('says nothing when everything already fits', () => {
    page({ content: 640, viewport: 640 });

    render(<ScrollHint />);

    expect(screen.queryByTestId('scroll-hint')).not.toBeInTheDocument();
  });

  /** A sliver of padding below the fold is not "more content", and pointing at it is noise. */
  it('says nothing when what is below the fold is under the threshold', () => {
    page({ content: 750, viewport: 640 });

    render(<ScrollHint />);

    expect(screen.queryByTestId('scroll-hint')).not.toBeInTheDocument();
  });

  it('retires the moment the student scrolls, and does not come back', async () => {
    page({ content: 2000, viewport: 640 });

    render(<ScrollHint />);
    await screen.findByTestId('scroll-hint');

    scrollTo(120);
    await waitFor(() => expect(screen.queryByTestId('scroll-hint')).not.toBeInTheDocument());

    // Back at the top with plenty still below — but they have already learnt the page moves.
    scrollTo(0);
    expect(screen.queryByTestId('scroll-hint')).not.toBeInTheDocument();
  });

  /**
   * The case no scroll or resize event covers: every student screen renders short and then grows
   * when its query resolves.
   */
  it('appears when the content arrives after the first paint', async () => {
    page({ content: 600, viewport: 640 });

    render(<ScrollHint />);
    expect(screen.queryByTestId('scroll-hint')).not.toBeInTheDocument();

    page({ content: 2400, viewport: 640 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(await screen.findByTestId('scroll-hint')).toBeInTheDocument();
  });
});
