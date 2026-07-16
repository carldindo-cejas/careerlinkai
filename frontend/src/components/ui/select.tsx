import type { SelectHTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * A native select, styled to match Input.
 *
 * Native rather than a custom listbox, deliberately: every select in the app so far is a
 * short, closed enum straight out of the schema (strand, status), and the browser's own
 * control is keyboard- and screen-reader-correct for free.
 */
export function Select({ className, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/60',
        className,
      )}
      {...props}
    />
  );
}
