import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
  {
    variants: {
      tone: {
        neutral: 'bg-slate-100 text-slate-700',
        success: 'bg-emerald-100 text-emerald-800',
        warning: 'bg-amber-100 text-amber-800',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode;
  className?: string;
}

export function Badge({ tone, className, children }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}
