import { cn } from '@/components/ui/cn';

export interface DonutSegment {
  label: string;
  value: number;
  /** One of the validated chart hues (see chartColors). */
  color: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  /** Center headline — defaults to the segment total. */
  centerValue?: string;
  centerLabel?: string;
  className?: string;
}

/**
 * Part-to-whole donut (dataviz: stacked form, thin marks, 2px surface gap between
 * fills). Identity never rides on color alone: the legend beside the plot names every
 * segment with its value, and each arc carries a native tooltip.
 *
 * All-zero data renders a neutral track rather than nothing — "0 of 0" is a real state
 * on day one and the layout should not collapse around it.
 */
export function DonutChart({ segments, centerValue, centerLabel, className }: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const size = 120;
  const strokeWidth = 14;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // The 2px spacer between adjacent fills, expressed as arc length.
  const gap = total > 0 && segments.filter((s) => s.value > 0).length > 1 ? 2 : 0;

  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const fraction = s.value / total;
      const length = Math.max(fraction * circumference - gap, 1);
      const arc = { ...s, length, offset };
      offset += fraction * circumference;
      return arc;
    });

  return (
    <div className={cn('flex flex-wrap items-center gap-6', className)}>
      <div className="relative shrink-0">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--secondary)"
            strokeWidth={strokeWidth}
          />
          {arcs.map((arc) => (
            <circle
              key={arc.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
              strokeDasharray={`${arc.length} ${circumference - arc.length}`}
              strokeDashoffset={-arc.offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            >
              <title>{`${arc.label}: ${arc.value}`}</title>
            </circle>
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {centerValue ?? total}
          </span>
          {centerLabel ? (
            <span className="text-[11px] font-medium text-muted-foreground">{centerLabel}</span>
          ) : null}
        </div>
      </div>

      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-sm">
            <span
              className="size-2.5 shrink-0 rounded-none"
              style={{ backgroundColor: s.color }}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-muted-foreground">{s.label}</span>
            <span className="ml-auto font-medium tabular-nums text-foreground">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
