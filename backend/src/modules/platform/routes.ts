import { Hono } from 'hono';
import { z } from 'zod';

import { createDatabase } from '@/db/client';
import type { AppEnv } from '@/env';
import { successEnvelope } from '@/lib/envelope';
import { parseQuery } from '@/lib/validation';
import { authenticate, requireUser } from '@/middleware/authenticate';
import { ensurePasswordChanged } from '@/middleware/ensure-password-changed';
import { ensureRole } from '@/middleware/ensure-role';
import {
  actionTypeOf,
  AuditService,
  AUDIT_ACTION_TYPES,
  AUDIT_ACTORS,
  AUDIT_EXPORT_LIMIT,
  AUDIT_SORTS,
  type AuditLogView,
} from '@/modules/platform/audit-service';
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

/** Everything both the viewer and the export accept. Pagination is layered on top for the viewer. */
const auditFilterSchema = z.object({
  action: z.string().trim().max(100).optional(),
  action_type: z.enum(AUDIT_ACTION_TYPES).optional(),
  module: z.string().trim().max(50).optional(),
  user_id: z.string().trim().max(64).optional(),
  actor: z.enum(AUDIT_ACTORS).optional(),
  target_id: z.string().trim().max(64).optional(),
  search: z.string().trim().max(200).optional(),
  from: isoOrDate('start'),
  to: isoOrDate('end'),
  sort: z.enum(AUDIT_SORTS).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

/** The query params both endpoints read — one array, so the two cannot drift apart. */
const AUDIT_FILTER_PARAMS = [
  'action',
  'action_type',
  'module',
  'user_id',
  'actor',
  'target_id',
  'search',
  'from',
  'to',
  'sort',
  'direction',
] as const;

const listAuditLogsQuerySchema = auditFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

type AuditQuery = z.infer<typeof auditFilterSchema>;

/** snake_case query → the Service's filter shape, in one place for both endpoints. */
function auditFilters(query: AuditQuery) {
  return {
    action: query.action,
    actionType: query.action_type,
    module: query.module,
    userId: query.user_id,
    actor: query.actor,
    targetId: query.target_id,
    search: query.search,
    from: query.from,
    to: query.to,
    sort: query.sort,
    direction: query.direction,
  };
}

/**
 * `GET /admin/audit-logs` (§20) — the append-only trail, finally readable. This is where
 * the §38 join-failure reasons and the D18 lesson's swallowed listener errors surface for
 * an operator; the API told the caller nothing, and this screen tells the admin everything.
 */
adminPlatformRoutes.get('/audit-logs', async (c) => {
  const query = parseQuery(c, listAuditLogsQuerySchema, [
    ...AUDIT_FILTER_PARAMS,
    'page',
    'per_page',
  ]);

  const page = await new AuditService(createDatabase(c.env.DB)).list({
    ...auditFilters(query),
    page: query.page,
    perPage: query.per_page,
  });

  return c.json(
    successEnvelope(
      {
        items: page.items.map((row) => serializeAuditLog(row.log, row.userName, row.userRole)),
        pagination: page.pagination,
      },
      'Audit logs retrieved successfully.',
    ),
  );
});

/**
 * `GET /admin/audit-logs/filter-options` — the vocabulary this deployment has actually recorded.
 *
 * Separate from the list rather than embedded in every page of it: the option set changes only when
 * a kind of action happens for the first time, so shipping it alongside 25 rows would be the same
 * two `DISTINCT` scans on every keystroke of the search box.
 */
adminPlatformRoutes.get('/audit-logs/filter-options', async (c) => {
  const options = await new AuditService(createDatabase(c.env.DB)).filterOptions();

  return c.json(
    successEnvelope(
      { ...options, action_types: AUDIT_ACTION_TYPES, actors: AUDIT_ACTORS },
      'Audit log filter options retrieved successfully.',
    ),
  );
});

/**
 * `GET /admin/audit-logs/export` — the **currently filtered** set as CSV.
 *
 * It reuses the viewer's filter schema exactly, so "export what I am looking at" is literally the
 * same query with the pagination taken off — an export that quietly applied different filters from
 * the screen above it would be worse than no export at all.
 *
 * Capped at `AUDIT_EXPORT_LIMIT`. When the cap bites, the response says so in a header **and** in a
 * final CSV row, because a spreadsheet opened three days later has no headers left to read.
 */
adminPlatformRoutes.get('/audit-logs/export', async (c) => {
  const query = parseQuery(c, auditFilterSchema, [...AUDIT_FILTER_PARAMS]);
  const { rows, truncated } = await new AuditService(createDatabase(c.env.DB)).export(
    auditFilters(query),
  );

  const csv = toCsv(rows, truncated);
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log-${stamp}.csv"`,
      'X-Export-Truncated': truncated ? 'true' : 'false',
      'X-Export-Row-Count': String(rows.length),
    },
  });
});

const CSV_COLUMNS = [
  'timestamp',
  'action',
  'action_type',
  'module',
  'actor',
  'actor_role',
  'target_type',
  'target_id',
  'ip_address',
  'old_values',
  'new_values',
] as const;

function toCsv(rows: AuditLogView[], truncated: boolean): string {
  const lines = [CSV_COLUMNS.join(',')];

  for (const { log, userName, userRole } of rows) {
    lines.push(
      [
        log.createdAt,
        log.action,
        actionTypeOf(log.action),
        log.module,
        userName ?? 'system / unresolved',
        userRole ?? '',
        log.targetType,
        log.targetId,
        log.ipAddress,
        log.oldValues === null ? '' : JSON.stringify(log.oldValues),
        log.newValues === null ? '' : JSON.stringify(log.newValues),
      ]
        .map(csvCell)
        .join(','),
    );
  }

  if (truncated) {
    lines.push(
      csvCell(
        `Export truncated at ${AUDIT_EXPORT_LIMIT} rows — narrow the date range for the rest.`,
      ),
    );
  }

  return lines.join('\r\n');
}

/**
 * One CSV cell, RFC 4180.
 *
 * The leading `'` on a cell starting with `=`, `+`, `-` or `@` is **not cosmetic**: without it a
 * spreadsheet treats the cell as a formula, and this file is full of attacker-influenced strings —
 * `target_id`, `ip_address`, and the JSON blobs, which carry names and titles a user typed. A
 * `new_values` beginning `=HYPERLINK(...)` would execute on open. This is the one place in the
 * system where user text is handed to a program that will run it, so it is escaped here rather than
 * trusted to whatever opens the file.
 */
function csvCell(value: string | null): string {
  const text = value ?? '';
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return `"${guarded.replaceAll('"', '""')}"`;
}

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
