import { cn } from '@/components/ui/cn';
import { chartColors } from '@/components/charts/colors';

export interface MeterProps {
  /** 0–100. */
  percent: number;
  /** Names the filled side, e.g. "Complete". */
  label: string;
  /** Names the remainder, e.g. "In progress". Omit to show only the fill. */
  remainderLabel?: string;
  className?: string;
}

/**
 * A single ratio against its limit (dataviz: a meter, not a two-slice pie). The track
 * is a light step of the same hue family, and both ends are named with their numbers —
 * the reading never rides on color.
 */
export function Meter({ percent, label, remainderLabel, className }: MeterProps) {
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {formatPercent(clamped)}
          <span className="ml-1.5 text-sm font-medium text-muted-foreground">{label}</span>
        </span>
        {remainderLabel ? (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatPercent(100 - clamped)} {remainderLabel}
          </span>
        ) : null}
      </div>
      <div
        className="h-2.5 rounded-none bg-secondary"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={label}
      >
        <div
          className="h-2.5 rounded-none transition-[width]"
          style={{ width: `${clamped}%`, backgroundColor: chartColors.primary }}
        />
      </div>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}
