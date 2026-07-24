import { cn } from '@/components/ui/cn';
import { chartColors } from '@/components/charts/colors';

export interface BarListItem {
  label: string;
  /** The bar length. */
  value: number;
  /** What the row prints — defaults to the raw value. */
  display?: string;
  /** Override the single-hue default (e.g. emphasis on the leader). */
  color?: string;
}

export interface BarListProps {
  items: BarListItem[];
  /** Scale ceiling — defaults to the max item so the longest bar fills the track. */
  max?: number;
  className?: string;
}

/**
 * Horizontal labeled bars (dataviz: magnitude → one hue; thin marks; square data-end
 * anchored to the baseline; values in ink tokens, never the series color). The default
 * is a single-hue read — pass per-item colors only when the items are genuinely
 * distinct series.
 */
export function BarList({ items, max, className }: BarListProps) {
  const ceiling = max ?? Math.max(...items.map((item) => item.value), 1);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {items.map((item) => {
        const pct = ceiling > 0 ? Math.max(0, Math.min(100, (item.value / ceiling) * 100)) : 0;

        return (
          <div key={item.label} className="grid grid-cols-[minmax(5rem,1fr)_2fr_auto] items-center gap-3 text-sm">
            <span className="truncate text-muted-foreground" title={item.label}>
              {item.label}
            </span>
            <div className="h-2 rounded-none bg-secondary">
              <div
                className="h-2 rounded-none"
                style={{ width: `${pct}%`, backgroundColor: item.color ?? chartColors.primary }}
                title={item.display ?? String(item.value)}
              />
            </div>
            <span className="w-10 text-right font-medium tabular-nums text-foreground">
              {item.display ?? item.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}
