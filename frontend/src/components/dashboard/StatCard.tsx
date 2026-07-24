import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Card, CardContent } from '@/components/ui/card';

export interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: number | string;
  /** A sub-line under the number — "3 in progress", "2 waiting". */
  hint?: string | undefined;
  /** Renders the tile as a link. */
  to?: string | undefined;
}

/**
 * The KPI stat tile every dashboard leads with (dataviz: a handful of headline numbers
 * is a KPI row, not a chart). Shared by the admin, counselor and student dashboards.
 */
export function StatCard({ icon, label, value, hint, to }: StatCardProps) {
  const body = (
    <Card className={to ? 'h-full transition-colors hover:border-primary' : 'h-full'}>
      <CardContent className="flex flex-col gap-1 p-5">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </CardContent>
    </Card>
  );

  return to ? (
    <Link to={to} className="focus-visible:outline-none">
      {body}
    </Link>
  ) : (
    body
  );
}
