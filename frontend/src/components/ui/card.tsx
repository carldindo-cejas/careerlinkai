import type { ComponentPropsWithRef, HTMLAttributes } from 'react';

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

export interface CardTitleProps extends ComponentPropsWithRef<'h2'> {
  /**
   * The heading level this title actually occupies.
   *
   * `h2` is the default because that is what every existing caller was written against: a card
   * sitting directly under the page's `h1`. It is a prop rather than a constant because a heading
   * level is a fact about the *page*, not about the component — a card title nested inside a
   * section that already has an `h2` is an `h3`, and a login card that is the only thing on its
   * screen is the `h1`. Hard-coding `h2` made a screen reader's outline of the recommendations
   * page read as six sibling sections when it is two sections of three cards, and left the two
   * sign-in screens with no `h1` at all on mobile.
   */
  as?: 'h1' | 'h2' | 'h3' | 'h4';
}

export function CardTitle({ as: Heading = 'h2', className, ...props }: CardTitleProps) {
  return (
    <Heading className={cn('text-lg font-semibold uppercase tracking-tight', className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}
