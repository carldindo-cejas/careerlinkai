import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/components/ui/cn';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/features/notifications/hooks/useNotifications';
import type { AppNotification } from '@/types/platform';

/**
 * The notification bell (FULLPLAN §37, §44 — Phase 6). One component for every shell:
 * a badge with the unread count, and a dropdown of the latest notifications. Clicking a
 * notification marks it read; nothing here navigates, because a v1 notification is a
 * sentence, not a deep link (§44's five messages are all self-contained).
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unread = data?.unread_count ?? 0;

  // Close on any click outside — the standard dropdown contract.
  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', onPointerDown);

    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        <Bell className="size-5" aria-hidden="true" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <span className="text-sm font-semibold text-slate-900">Notifications</span>
            {unread > 0 ? (
              <button
                type="button"
                className="text-xs font-medium text-slate-500 hover:text-slate-800"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {isLoading ? <p className="px-4 py-6 text-sm text-slate-500">Loading…</p> : null}

            {isError ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                We could not load your notifications.
              </p>
            ) : null}

            {data && data.items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                Nothing yet. You’ll hear from us when something is ready.
              </p>
            ) : null}

            {data?.items.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onRead={() => markRead.mutate(notification.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotificationRow({
  notification,
  onRead,
}: {
  notification: AppNotification;
  onRead: () => void;
}) {
  const unread = notification.read_at === null;

  return (
    <button
      type="button"
      onClick={() => {
        if (unread) {
          onRead();
        }
      }}
      className={cn(
        'block w-full border-b border-slate-50 px-4 py-3 text-left transition-colors last:border-b-0',
        unread ? 'bg-slate-50/80 hover:bg-slate-100' : 'hover:bg-slate-50',
      )}
    >
      <span className="flex items-start gap-2">
        {unread ? (
          <span
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-sky-500"
            aria-hidden="true"
          />
        ) : (
          <span className="mt-1.5 size-1.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0">
          <span
            className={cn(
              'block text-sm',
              unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700',
            )}
          >
            {notification.title}
          </span>
          <span className="mt-0.5 block text-sm text-slate-500">{notification.message}</span>
          {notification.created_at ? (
            <span className="mt-1 block text-xs text-slate-400">
              {relativeTime(notification.created_at)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** "3m ago" / "2h ago" / "5d ago" — enough precision for a notification strip. */
function relativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();

  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return '';
  }

  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}
