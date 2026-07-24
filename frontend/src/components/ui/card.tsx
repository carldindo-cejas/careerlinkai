import type { HTMLAttributes } from 'react';

import { Corners } from '@/components/ui/blueprint';
import { cn } from '@/components/ui/cn';

/**
 * A card in the Industry system is a transparent line-drawing: a hairline border and four corner
 * registration marks, no surface fill and no shadow. The frame does the work the fill used to.
 */
export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative rounded-none border border-border bg-transparent text-card-foreground',
        className,
      )}
      {...props}
    >
      <Corners />
      {children}
    </div>
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-6 pb-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn('text-lg font-semibold uppercase tracking-tight', className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}
