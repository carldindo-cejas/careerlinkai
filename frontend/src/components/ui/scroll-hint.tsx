import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * Three faint chevrons at the bottom of a phone screen that still has content below the fold
 * (prompt-driven, 2026-09-20).
 *
 * **The problem it solves is a specific one and it has bitten this app before.** The student
 * access screen shipped with its two buttons below the fold on a 320x568 phone: the page scrolled
 * perfectly well and nothing on screen said so, so students sat looking at a question they could
 * not answer. That was fixed by making the card shorter, which works for one card. The dashboard,
 * the results page and the recommendation brief are all genuinely longer than a phone, and the
 * only honest fix for those is to say that they are.
 *
 * Four properties, each of which is the difference between a hint and an annoyance:
 *
 *   * **It appears only when it is true.** The distance to the bottom is measured, not assumed,
 *     and re-measured when the content or the viewport changes — a `ResizeObserver` on
 *     `document.body`, because a page that grows when a query resolves grows without any scroll
 *     or resize event firing.
 *   * **It disappears as soon as the student scrolls.** Not on reaching the bottom — on the
 *     *first* scroll, because by then they know the page moves and the hint has done its job.
 *   * **It is phone-only.** `md:hidden`, since the point is a viewport too short for its content,
 *     and a laptop's scrollbar already says this.
 *   * **It cannot be tapped.** `pointer-events-none`, and it sits below the chat launcher, so it
 *     never intercepts a press meant for something real.
 */
export function ScrollHint({ className }: { className?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // The floor is deliberately larger than a rounding error and smaller than a card: below this
    // the "more" is a few pixels of padding, and pointing at it would be noise.
    const THRESHOLD = 120;

    let scrolled = false;

    const measure = () => {
      if (scrolled) return;

      const { scrollHeight, clientHeight } = document.documentElement;
      const offset = window.scrollY;

      setVisible(scrollHeight - clientHeight - offset > THRESHOLD);
    };

    const onScroll = () => {
      // One scroll of any size is the whole signal. The student now knows the page moves.
      if (window.scrollY > 8) {
        scrolled = true;
        setVisible(false);
        return;
      }

      measure();
    };

    measure();

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);

    /*
      The case neither event covers: content arriving after the first paint. Every student screen
      renders its skeleton before its data, so the page is short when this mounts and tall a few
      hundred milliseconds later — with no scroll and no resize in between.
    */
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());

    observer?.observe(document.body);

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      // Decorative and duplicative: a screen reader already knows the document continues, and the
      // scroll position is not something it needs prompting about.
      aria-hidden="true"
      data-testid="scroll-hint"
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-0 z-30 flex flex-col items-center justify-end md:hidden',
        // A short scrim under the arrows, so they read as chrome over the page rather than as
        // three marks drawn on whatever happens to be at the bottom of it. Without it the
        // chevrons landed on the middle of a chart legend and looked like a rendering fault.
        'h-16 bg-gradient-to-t from-background via-background/75 to-transparent',
        // `env(safe-area-inset-bottom)` keeps them clear of the iOS home indicator, which
        // otherwise sits directly on top of the lowest chevron.
        'pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        className,
      )}
    >
      {[0, 1, 2].map((index) => (
        <ChevronDown
          key={index}
          className="scroll-hint-arrow -my-1.5 size-5 text-foreground/45"
          // The stagger, in time rather than in three keyframe sets — see `index.css`.
          style={{ animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </div>
  );
}
