import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * An inline message.
 *
 * It was danger-only through Phases 0–2, which was right while the only thing it ever had to say
 * was "that failed". Phase 3 gave it three more things to say, and each is a different *kind* of
 * claim rather than a different colour:
 *
 *   - `danger`  — something failed.
 *   - `warning` — this will succeed, and it will destroy something. Closing an assessment expires
 *                 every attempt still in progress underneath it (§21), and a counselor who reads
 *                 "Close" as "stop new starts" has been misled by the interface, not by the rule.
 *   - `success` — that worked. (Saved.)
 *   - `info`    — a statement of fact with no action attached.
 *
 * `danger` stays the default, so every existing caller keeps the behaviour it was written against.
 */
const alertVariants = cva('flex items-start gap-2 rounded-md border p-3 text-sm', {
  variants: {
    tone: {
      danger: 'border-red-200 bg-red-50 text-red-800',
      warning: 'border-amber-200 bg-amber-50 text-amber-900',
      success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      info: 'border-slate-200 bg-slate-50 text-slate-700',
    },
  },
  defaultVariants: {
    tone: 'danger',
  },
});

const icons = {
  danger: AlertCircle,
  warning: AlertTriangle,
  success: CheckCircle2,
  info: Info,
} as const;

export interface AlertProps extends VariantProps<typeof alertVariants> {
  children: ReactNode;
  className?: string;
}

export function Alert({ tone, className, children }: AlertProps) {
  const Icon = icons[tone ?? 'danger'];

  return (
    <div
      // Only a failure is an assertive interruption. A "Saved." that stole focus from a screen
      // reader mid-sentence would be worse than useless.
      role={tone === 'danger' || tone === undefined ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
