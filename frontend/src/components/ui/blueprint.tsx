import type { HTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * The "Industry" wireframe frame: a square, hairline-bordered, transparent object with four
 * "+" registration marks at its corners. Wraps cards, KPI tiles, figures and the primary button.
 * The marks are decorative (aria-hidden); the border provides the actual boundary.
 */
export function Blueprint({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('relative border border-border', className)} {...props}>
      <Corners />
      {children}
    </div>
  );
}

/**
 * The four corner marks on their own — for elements that already have their own border/box.
 *
 * `className` lands after the base so a caller can retint the marks: on the filled steel primary
 * button they have to be paper, since steel-on-steel would be invisible.
 */
export function Corners({ className }: { className?: string }) {
  const base = cn('pointer-events-none absolute size-[7px] text-primary', className);
  return (
    <span aria-hidden="true">
      <Mark className={cn(base, '-left-px -top-px border-l border-t')} />
      <Mark className={cn(base, '-right-px -top-px border-r border-t')} />
      <Mark className={cn(base, '-bottom-px -left-px border-b border-l')} />
      <Mark className={cn(base, '-bottom-px -right-px border-b border-r')} />
    </span>
  );
}

function Mark({ className }: { className: string }) {
  return <span className={className} style={{ borderColor: 'currentColor' }} />;
}
