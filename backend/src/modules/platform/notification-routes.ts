import { Hono } from 'hono';
import { z } from 'zod';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { NotificationService } from '@/modules/platform/notification-service';
import { serializeNotification } from '@/modules/platform/serializers';

/**
 * The §20 notification group (`/api/v1/notifications`) — Phase 6.
 *
 * Every role receives notifications (§44 addresses students, counselors and admins alike), so
 * this is the one authenticated router with **no role gate**: `authenticate` alone decides who
 * you are, and every query is scoped to the token's user. There is no user id in any URL, so a
 * route that means "my notifications" cannot be bent toward someone else's.
 *
 * `ensurePasswordChanged` is a no-op for students (they have no password, §38) and keeps a
 * staff account on a temporary password inside the same everything-but-auth gate it faces on
 * every other router.
 */

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.use('*', authenticate());
notificationRoutes.use('*', ensurePasswordChanged());

const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
});

/** `GET /notifications` — newest first, with the unread badge count in the same response. */
notificationRoutes.get('/', async (c) => {
  const query = parseQuery(c, listNotificationsQuerySchema, ['page', 'per_page']);
  const service = new NotificationService(createDatabase(c.env.DB));

  const { paginated, unread } = await service.listFor(requireUser(c), query.page, query.per_page);

  return c.json(
    successEnvelope(
      {
        items: paginated.items.map(serializeNotification),
        pagination: paginated.pagination,
        unread_count: unread,
      },
      'Notifications retrieved successfully.',
    ),
  );
});

/** `PATCH /notifications/read-all` — one statement, returns how many it touched. */
notificationRoutes.patch('/read-all', async (c) => {
  const service = new NotificationService(createDatabase(c.env.DB));
  const updated = await service.markAllRead(requireUser(c));

  return c.json(successEnvelope({ updated }, 'All notifications marked as read.'));
});

/** `PATCH /notifications/{id}/read` — idempotent; someone else's id 404s. */
notificationRoutes.patch('/:id/read', async (c) => {
  const service = new NotificationService(createDatabase(c.env.DB));
  const notification = await service.markRead(requireUser(c), c.req.param('id'));

  return c.json(successEnvelope(serializeNotification(notification), 'Notification marked as read.'));
});
