import { cn } from '@/components/ui/cn';
import { chartColors } from '@/components/charts/colors';

export interface ColumnChartItem {
  label: string;
  value: number;
  /** Override the single-hue default. */
  color?: string;
}

export interface ColumnChartProps {
  items: ColumnChartItem[];
  /** Scale ceiling — defaults to the max item. */
  max?: number;
  className?: string;
}

/**
 * Small vertical columns for a distribution (dataviz: magnitude → one hue, thin marks,
 * direct value labels above each column so no tooltip is required to read it). Keep it
 * to a handful of buckets — this is a widget, not an axis-and-grid chart.
 */
export function ColumnChart({ items, max, className }: ColumnChartProps) {
  const ceiling = max ?? Math.max(...items.map((item) => item.value), 1);

  return (
    <div className={cn('flex items-end justify-between gap-2', className)}>
      {items.map((item) => {
        const pct = ceiling > 0 ? Math.max(0, Math.min(100, (item.value / ceiling) * 100)) : 0;

        return (
          <div key={item.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="text-xs font-medium tabular-nums text-foreground">{item.value}</span>
            <div className="flex h-24 w-full max-w-8 items-end rounded-t bg-secondary/60">
              <div
                className="w-full rounded-t"
                style={{
                  height: `${pct}%`,
                  minHeight: item.value > 0 ? '4px' : '0',
                  backgroundColor: item.color ?? chartColors.primary,
                }}
                title={`${item.label}: ${item.value}`}
              />
            </div>
            <span className="max-w-full truncate text-[11px] text-muted-foreground" title={item.label}>
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
