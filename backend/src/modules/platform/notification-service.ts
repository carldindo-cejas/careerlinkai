import { and, count, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db/client';
import type { NotificationCategory } from '@/db/enums';
import { notifications, type Notification, type User } from '@/db/schema';
import { uuid } from '@/lib/crypto';
import { now } from '@/lib/datetime';
import { ApiError, paginate, type PaginatedData } from '@/lib/envelope';

/**
 * NotificationService (FULLPLAN §44) — Phase 6.
 *
 * In-app only for v1: `send()` inserts a row, and `read_at` is the only status that will ever
 * be tracked ("a notification is either created, or it isn't"). Called at the end of the §44
 * listeners — never from inside the work those listeners react to, so a notification failure
 * can never fail a scoring, a generation, or an ingestion (§11's listener rule already
 * guarantees this: `dispatch()` absorbs a throwing listener).
 */

/** D1 caps a statement at 100 bound parameters (D18). A notification row binds 7 columns. */
const NOTIFICATION_COLUMNS = 7;
const ROWS_PER_INSERT = Math.floor((100 - 10) / NOTIFICATION_COLUMNS);

export interface NotificationInput {
  userId: string;
  title: string;
  message: string;
  category: NotificationCategory;
}

export class NotificationService {
  constructor(private readonly db: Database) {}

  /** §44's delivery mechanism, in its entirety. */
  async send(input: NotificationInput): Promise<Notification> {
    const row: Notification = {
      id: uuid(),
      userId: input.userId,
      title: input.title,
      message: input.message,
      category: input.category,
      readAt: null,
      createdAt: now(),
    };

    await this.db.insert(notifications).values(row);

    return row;
  }

  /**
   * The fan-out form, for "assignment created for a class" (§44) — one insert per ≤12
   * recipients rather than one per recipient, for the same D18 reason the recommendation
   * insert is chunked: a 40-student roster would otherwise bind 280 parameters in one
   * statement, and D1 refuses anything past 100.
   */
  async sendToMany(userIds: string[], template: Omit<NotificationInput, 'userId'>): Promise<void> {
    if (userIds.length === 0) {
      return;
    }

    const timestamp = now();
    const rows = userIds.map((userId) => ({
      id: uuid(),
      userId,
      title: template.title,
      message: template.message,
      category: template.category,
      readAt: null,
      createdAt: timestamp,
    }));

    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      await this.db.insert(notifications).values(rows.slice(i, i + ROWS_PER_INSERT));
    }
  }

  /** "My notifications, newest first" — every route here means *mine*, resolved from the token. */
  async listFor(
    user: User,
    page: number,
    perPage: number,
  ): Promise<{ paginated: PaginatedData<Notification>; unread: number }> {
    const [rows, [total], [unread]] = await Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, user.id))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(perPage)
        .offset((page - 1) * perPage),
      this.db
        .select({ value: count() })
        .from(notifications)
        .where(eq(notifications.userId, user.id)),
      this.db
        .select({ value: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))),
    ]);

    return {
      paginated: paginate(rows, total?.value ?? 0, page, perPage),
      unread: unread?.value ?? 0,
    };
  }

  /**
   * Mark one of *my* notifications read. Idempotent — a second read keeps the first
   * `read_at`, because "when did they first see it" is the honest answer. Someone else's id
   * 404s identically to one that does not exist.
   */
  async markRead(user: User, notificationId: string): Promise<Notification> {
    const row = await this.db.query.notifications.findFirst({
      where: and(eq(notifications.id, notificationId), eq(notifications.userId, user.id)),
    });

    if (row === undefined) {
      throw ApiError.notFound('Notification not found.');
    }

    if (row.readAt !== null) {
      return row;
    }

    const readAt = now();

    await this.db
      .update(notifications)
      .set({ readAt })
      .where(eq(notifications.id, notificationId));

    return { ...row, readAt };
  }

  /** Mark everything unread as read, in one statement. Returns how many were affected. */
  async markAllRead(user: User): Promise<number> {
    const [unread] = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));

    const affected = unread?.value ?? 0;

    if (affected > 0) {
      await this.db
        .update(notifications)
        .set({ readAt: now() })
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
    }

    return affected;
  }
}
