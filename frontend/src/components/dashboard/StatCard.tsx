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
 *
 * **It has to survive a half-width column on a 320px phone** (2026-09-20), which is what the
 * student dashboard's KPI row became when it went two-across. That leaves about 84px for the
 * label, and "RECOMMENDATIONS" at `text-xs tracking-wide` is a hair over 100px — one word, so
 * nothing about ordinary wrapping saves it. Three things do, in order of how much they cost:
 * a point smaller and the letter-spacing dropped below `sm` (which buys most of it back and is
 * invisible at that size), `p-4` instead of `p-5`, and `break-words` as the floor so the very
 * narrowest phone wraps the word rather than letting it run out past the card's own border.
 */
export function StatCard({ icon, label, value, hint, to }: StatCardProps) {
  const body = (
    <Card className={to ? 'h-full transition-colors hover:border-primary' : 'h-full'}>
      <CardContent className="flex flex-col gap-1 p-4 sm:p-5">
        <span className="flex items-start gap-1.5 text-[11px] font-medium uppercase leading-tight tracking-normal text-muted-foreground max-[359px]:gap-1 max-[359px]:text-[10px] max-[359px]:tracking-tight sm:text-xs sm:tracking-wide">
          {/*
            Dropped entirely under 360px, where the last 14px of it is the difference between
            "RECOMMENDATIONS" on one line and one orphaned letter on a second. The icon is
            decorative — `aria-hidden` at every call site — and the label is the thing that says
            what the number counts, so this is the right one to spend.
          */}
          <span className="mt-px hidden shrink-0 items-center min-[360px]:flex [&>svg]:size-3.5 sm:[&>svg]:size-4">
            {icon}
          </span>
          {/*
            `hyphens-auto` with `break-words` behind it: Chrome takes the hyphenated break when
            it can, so the one label that still does not fit a 320px half-column reads
            "RECOMMEN-/DATIONS" rather than "RECOMMENDATI/ONS". `<html lang="en">` is what makes
            the dictionary available; `break-words` stays as the floor for anything it cannot
            hyphenate.
          */}
          <span className="min-w-0 hyphens-auto break-words">{label}</span>
        </span>
        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
        {hint ? <span className="text-xs leading-snug text-muted-foreground">{hint}</span> : null}
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
