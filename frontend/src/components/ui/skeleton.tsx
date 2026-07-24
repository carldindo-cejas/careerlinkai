import type { HTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * A loading placeholder that holds the shape of what it stands in for. Prefer it to a bare
 * "Loading…" line wherever the final layout is known — a page that keeps its silhouette
 * while data arrives reads as fast; one that reflows reads as broken.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-none bg-secondary', className)} {...props} />;
}
