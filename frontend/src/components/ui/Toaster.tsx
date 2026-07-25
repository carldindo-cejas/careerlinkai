import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect } from 'react';

import { Corners } from '@/components/ui/blueprint';
import { cn } from '@/components/ui/cn';
import { useToastStore, type Toast, type ToastTone } from '@/stores/toastStore';

/**
 * The toast viewport — one instance, mounted once near the app root. It reads the queue from the
 * store and renders each entry; auto-dismiss lives here (per toast) rather than in the store, so
 * the store never schedules a timer a test would have to clean up.
 *
 * The visual language matches `Alert`: a hairline frame with corner marks, tone carried by a small
 * icon and a tinted left edge rather than a saturated fill — this is a mono scheme.
 */

const TONE_ICON: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const TONE_ACCENT: Record<ToastTone, string> = {
  success: 'border-l-primary text-primary',
  error: 'border-l-destructive text-destructive',
  info: 'border-l-border text-muted-foreground',
};

const AUTO_DISMISS_MS = 5000;

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const Icon = TONE_ICON[toast.tone];

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);

    return () => window.clearTimeout(timer);
  }, [toast.id, dismiss]);

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto relative flex w-full max-w-sm items-start gap-2.5 border border-l-2 border-border bg-background p-3 text-sm shadow-sm',
        TONE_ACCENT[toast.tone],
      )}
    >
      <Corners />
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-foreground/90">{toast.message}</span>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
