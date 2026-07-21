import { Hono } from 'hono';
import { z } from 'zod';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import { AuditService } from '@/modules/platform/audit-service';
import { DashboardService } from '@/modules/platform/dashboard-service';
import { serializeAuditLog } from '@/modules/platform/serializers';

/**
 * The Platform module's HTTP surface beyond notifications (FULLPLAN §20, Phase 6): the
 * admin audit-log viewer and the three role dashboards — one router per prefix, same
 * one-module-one-router rule as everywhere else.
 */

// --- /admin ------------------------------------------------------------------------------

export const adminPlatformRoutes = new Hono<AppEnv>();

adminPlatformRoutes.use('*', authenticate());
adminPlatformRoutes.use('*', ensureRole('admin'));
adminPlatformRoutes.use('*', ensurePasswordChanged());

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * M7: accept **either** a full ISO-8601 datetime **or** a date-only `YYYY-MM-DD`, normalizing the
 * latter to the requested edge of that UTC day. Before this, a date-only `to=2026-07-01` 422'd, so
 * the frontend had to hand-append `T00:00:00Z` (and a naive `to` of midnight excluded the whole
 * day anyway). `created_at` is stored as an ISO-8601 UTC string compared lexically, so a `to` of
 * end-of-day is what actually includes the day's last row. Additive — a full timestamp still works.
 */
function isoOrDate(edge: 'start' | 'end') {
  return z
    .string()
    .trim()
    .refine(
      (value) => DATE_ONLY_PATTERN.test(value) || z.iso.datetime().safeParse(value).success,
      { message: 'Use an ISO-8601 date (YYYY-MM-DD) or timestamp.' },
    )
    .transform((value) =>
      DATE_ONLY_PATTERN.test(value)
        ? `${value}${edge === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`
        : value,
    )
    .optional();
}

const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().trim().max(100).optional(),
  module: z.string().trim().max(50).optional(),
  user_id: z.string().trim().max(64).optional(),
  target_id: z.string().trim().max(64).optional(),
  from: isoOrDate('start'),
  to: isoOrDate('end'),
});

/**
 * `GET /admin/audit-logs` (§20) — the append-only trail, finally readable. This is where
 * the §38 join-failure reasons and the D18 lesson's swallowed listener errors surface for
 * an operator; the API told the caller nothing, and this screen tells the admin everything.
 */
adminPlatformRoutes.get('/audit-logs', async (c) => {
  const query = parseQuery(c, listAuditLogsQuerySchema, [
    'page',
    'per_page',
    'action',
    'module',
    'user_id',
    'target_id',
    'from',
    'to',
  ]);

  const page = await new AuditService(createDatabase(c.env.DB)).list({
    page: query.page,
    perPage: query.per_page,
    action: query.action,
    module: query.module,
    userId: query.user_id,
    targetId: query.target_id,
    from: query.from,
    to: query.to,
  });

  return c.json(
    successEnvelope(
      {
        items: page.items.map((row) => serializeAuditLog(row.log, row.userName)),
        pagination: page.pagination,
      },
      'Audit logs retrieved successfully.',
    ),
  );
});

/** `GET /admin/dashboard` (§20, added v1.2) — the §54 metrics, pulled live. */
adminPlatformRoutes.get('/dashboard', async (c) => {
  const dashboard = await new DashboardService(createDatabase(c.env.DB)).adminDashboard();

  return c.json(
    successEnvelope(
      {
        ...dashboard,
        recent_activity: dashboard.recent_activity.map((row) =>
          serializeAuditLog(row.log, row.userName),
        ),
      },
      'Dashboard retrieved successfully.',
    ),
  );
});

// --- /counselor ----------------------------------------------------------------------------

export const counselorPlatformRoutes = new Hono<AppEnv>();

counselorPlatformRoutes.use('*', authenticate());
counselorPlatformRoutes.use('*', ensureRole('counselor', 'admin'));
counselorPlatformRoutes.use('*', ensurePasswordChanged());

counselorPlatformRoutes.get('/dashboard', async (c) => {
  const dashboard = await new DashboardService(createDatabase(c.env.DB)).counselorDashboard(
    requireUser(c),
  );

  return c.json(successEnvelope(dashboard, 'Dashboard retrieved successfully.'));
});

// --- /student ------------------------------------------------------------------------------

export const studentPlatformRoutes = new Hono<AppEnv>();

/** Same shape as every /student router: no password gate (§38), "me" resolved from the token. */
studentPlatformRoutes.use('*', authenticate());
studentPlatformRoutes.use('*', ensureRole('student'));

studentPlatformRoutes.get('/dashboard', async (c) => {
  const dashboard = await new DashboardService(createDatabase(c.env.DB)).studentDashboard(
    requireUser(c),
  );

  return c.json(successEnvelope(dashboard, 'Dashboard retrieved successfully.'));
});
