import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

// Mono scheme: success/brand read steel, warning reads deep steel. There is no second accent hue,
// so a badge's tone carries meaning through weight and fill, not through a colour wheel.
const badgeVariants = cva(
  'inline-flex items-center rounded-none px-2 py-0.5 text-xs font-medium tracking-wide',
  {
    variants: {
      tone: {
        neutral: 'bg-secondary text-muted-foreground',
        success: 'bg-primary/10 text-primary',
        warning: 'bg-accent/10 text-accent',
        brand: 'bg-primary/10 text-primary',
        accent: 'bg-accent/10 text-accent',
        outline: 'border border-border bg-transparent text-muted-foreground',
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
