import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '@/components/ui/cn';

/**
 * A slide-in panel (shadcn/ui's Sheet, on Radix Dialog) — used for the mobile sidebar
 * drawer. Radix carries the accessibility contract: focus trap, escape-to-close,
 * scroll lock, and `aria-modal` for free.
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export function SheetContent({
  side = 'left',
  className,
  children,
  title,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  side?: 'left' | 'right';
  /** Announced to screen readers; visually the panel's own content is the header. */
  title: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 z-50 flex w-72 flex-col bg-sidebar text-sidebar-foreground shadow-xl outline-none transition-transform',
          side === 'left' ? 'left-0' : 'right-0',
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        {children}
        <DialogPrimitive.Close
          aria-label="Close menu"
          className="absolute right-3 top-3 rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-active hover:text-sidebar-active-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
