import { useId } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * A two-thumb range slider — one window, dragged from either end.
 *
 * Built from two stacked native `<input type="range">` elements rather than a custom pointer
 * handler: the natives come with keyboard support, `aria-valuenow` announcements and touch targets
 * for free, and the only thing they cannot do alone is share a track. The stack does that — the
 * track and the filled segment are drawn underneath, both inputs sit transparent on top with
 * `pointer-events: none`, and only the thumbs take the pointer back.
 *
 * The thumbs are *clamped, not swapped*: dragging the low end past the high end parks it on the
 * high end's value instead of the two trading places under the reader's finger.
 */
export interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  /** `[low, high]` — always within `[min, max]`, low never above high. */
  value: [number, number];
  onChange: (value: [number, number]) => void;
  /** Renders each end for the readout above the track — e.g. a peso formatter. */
  format?: (value: number) => string;
  /** Accessible names for the two thumbs, since neither carries a visible label of its own. */
  minLabel: string;
  maxLabel: string;
  disabled?: boolean;
  className?: string;
}

/** Shared by both inputs: transparent, full-bleed, inert except for the thumb itself. */
const INPUT_CLASSES = [
  'pointer-events-none absolute inset-x-0 top-1/2 m-0 h-5 w-full -translate-y-1/2 appearance-none bg-transparent',
  'focus-visible:outline-none disabled:cursor-not-allowed',
  // WebKit / Blink thumb.
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-4',
  '[&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:rounded-none [&::-webkit-slider-thumb]:border-2',
  '[&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background',
  'focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring',
  'focus-visible:[&::-webkit-slider-thumb]:ring-offset-1',
  // Firefox thumb.
  '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-4',
  '[&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:appearance-none',
  '[&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-2',
  '[&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background',
  'focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-ring',
  '[&::-moz-range-track]:bg-transparent',
].join(' ');

export function RangeSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  minLabel,
  maxLabel,
  disabled = false,
  className,
}: RangeSliderProps) {
  const id = useId();

  const [low, high] = value;
  const span = max - min;

  // A zero-width range (one career, one salary) would divide by zero — pin it to a full track.
  const toPercent = (n: number) => (span <= 0 ? 0 : ((n - min) / span) * 100);
  const lowPercent = toPercent(low);
  const highPercent = span <= 0 ? 100 : toPercent(high);

  const render = format ?? ((n: number) => String(n));

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between text-sm tabular-nums">
        <span>{render(low)}</span>
        <span>{render(high)}</span>
      </div>

      <div className={cn('relative h-5', disabled && 'opacity-50')}>
        {/* The track, and the selected window drawn over it. */}
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-muted" aria-hidden="true">
          <div
            className="absolute inset-y-0 bg-primary"
            style={{ left: `${lowPercent}%`, right: `${100 - highPercent}%` }}
          />
        </div>

        <input
          id={`${id}-low`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={low}
          disabled={disabled}
          aria-label={minLabel}
          onChange={(event) => onChange([Math.min(Number(event.target.value), high), high])}
          // With both thumbs parked on the same value the upper input would sit on top and trap the
          // low thumb; lifting it once it passes the midpoint keeps it reachable at either extreme.
          style={{ zIndex: lowPercent >= 50 ? 4 : 2 }}
          className={INPUT_CLASSES}
        />
        <input
          id={`${id}-high`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={high}
          disabled={disabled}
          aria-label={maxLabel}
          onChange={(event) => onChange([low, Math.max(Number(event.target.value), low)])}
          style={{ zIndex: 3 }}
          className={INPUT_CLASSES}
        />
      </div>
    </div>
  );
}
