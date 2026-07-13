import type { LabelHTMLAttributes } from 'react';

import { cn } from '@/components/ui/cn';

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

export function Label({ className, ...props }: LabelProps) {
  return (
    <label
      className={cn('text-sm font-medium leading-none text-slate-800', className)}
      {...props}
    />
  );
}
