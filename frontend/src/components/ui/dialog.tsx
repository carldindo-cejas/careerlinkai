import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { Corners } from "@/components/ui/blueprint";
import { cn } from "@/components/ui/cn";

/**
 * A centred modal (shadcn/ui's Dialog, on the same Radix primitive the Sheet uses) — focus
 * trap, escape-to-close, scroll lock and `aria-modal` come from Radix.
 *
 * Unlike a Card, this one is opaque: it floats over the page, so it carries the surface fill
 * the line-drawing cards deliberately do not have.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends Omit<
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
  "title"
> {
  /** The modal's heading — rendered, and announced as the dialog's accessible name. */
  title: string;
  /** Optional supporting line under the heading. */
  description?: string;
  /**
   * Drops the "X" in the corner.
   *
   * For the one kind of modal that is a precondition rather than a detour: the student profile
   * gate, which exists precisely because the thing it asks for cannot be skipped. A close button
   * next to a question with no "later" is a control that either does nothing or undoes the
   * screen's whole reason for existing. Escape and click-outside are the caller's to refuse too
   * (`onEscapeKeyDown`, `onInteractOutside`) — this only removes the visible affordance.
   */
  hideClose?: boolean;
  /** Retints the backdrop — the profile gate blurs the page behind it rather than dimming it. */
  overlayClassName?: string;
  children: ReactNode;
}

export function DialogContent({
  className,
  overlayClassName,
  hideClose = false,
  children,
  title,
  description,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-black/50", overlayClassName)} />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-none border border-border bg-background text-foreground outline-none",
          className,
        )}
        // Radix warns when a dialog has neither a description nor an explicit opt-out.
        {...(description ? {} : { "aria-describedby": undefined })}
        {...props}
      >
        <Corners />

        <div className="flex items-start justify-between gap-4 p-6 pb-4">
          <div className="flex flex-col gap-1">
            <DialogPrimitive.Title className="text-lg font-semibold uppercase tracking-tight">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>

          {hideClose ? null : (
            <DialogPrimitive.Close
              aria-label="Close"
              className="rounded-none p-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          )}
        </div>

        {/* The review step can be 200 rows long — the body scrolls, the header stays put. */}
        <div className="overflow-y-auto px-6 pb-6">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
