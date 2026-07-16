import { httpClient, unwrap } from '@/services/httpClient';
import type { ApiSuccess } from '@/types/api';
import type { AppNotification, NotificationList } from '@/types/platform';

/**
 * Notifications (FULLPLAN §20, §44 — Phase 6).
 *
 * Every endpoint means *mine* — there is no user id anywhere in this module, on purpose:
 * the recipient is always the bearer of the token.
 */
export const notificationApi = {
  list(page = 1, perPage = 20): Promise<NotificationList> {
    return unwrap(
      httpClient.get<ApiSuccess<NotificationList>>('/notifications', {
        params: { page, per_page: perPage },
      }),
    );
  },

  /** Idempotent: a second call keeps the first read timestamp. */
  markRead(id: string): Promise<AppNotification> {
    return unwrap(httpClient.patch<ApiSuccess<AppNotification>>(`/notifications/${id}/read`));
  },

  markAllRead(): Promise<{ updated: number }> {
    return unwrap(httpClient.patch<ApiSuccess<{ updated: number }>>('/notifications/read-all'));
  },
};
