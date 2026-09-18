import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Corners } from '@/components/ui/blueprint';
import { cn } from '@/components/ui/cn';

const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 rounded-none text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
  {
    variants: {
      // The primary button is the one solid object in the system; everything else is outline.
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-[#4d7196]',
        secondary: 'border border-border bg-transparent text-foreground hover:bg-secondary',
        ghost: 'bg-transparent text-foreground hover:bg-secondary',
        // `outline` and `secondary` converge in this system — both names kept for callers.
        outline: 'border border-border bg-transparent text-foreground hover:bg-secondary',
        // Reserved for the confirming step of an action that destroys something a user cannot get
        // back — closing an assessment expires the attempts still in progress under it (§21). It
        // is deliberately not used for the button that *opens* such a confirmation, only for the
        // one that carries it out.
        danger: 'bg-destructive text-destructive-foreground hover:bg-[#9a322c]',
      },
      /**
       * **Every size is at least 44px tall on a phone, and the designed height from `sm` up.**
       *
       * WCAG 2.2 AA (Target Size, Minimum) puts the floor at 44×44 CSS px, and `h-8`/`h-10` are 32
       * and 40 — comfortably clickable with a mouse and genuinely hard to hit with a thumb, which is
       * how most students reach this product. `scripts/responsive-audit.mjs` measured sixty-odd of
       * these across the counselor and student interfaces at 320–430px.
       *
       * Raised only below `sm`, deliberately: a desktop toolbar of 44px buttons is a toolbar that
       * has lost its density for the benefit of a pointer nobody is using there. One rule, applied
       * where the pointer is actually a finger.
       */
      size: {
        sm: 'h-11 px-3 sm:h-8',
        md: 'h-11 px-4 sm:h-10',
        lg: 'h-11 px-6 text-base',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  // The primary button is the system's one solid object, so it also wears the registration marks
  // that frame every other major object. `variant` is undefined when the caller took the default.
  const marked = (variant ?? 'primary') === 'primary';

  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? loading}
      {...props}
    >
      {marked ? <Corners className="text-primary-foreground" /> : null}
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
