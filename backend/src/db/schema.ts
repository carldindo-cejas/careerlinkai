import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { Strand, UserRole, UserStatus } from '@/db/enums';

/**
 * The single typed definition of every table (FULLPLAN §16) — there are no per-model
 * classes; Drizzle's inferred row types (`typeof users.$inferSelect`) are what Eloquent
 * models used to be.
 *
 * This file must stay a faithful mirror of `migrations/` — Drizzle is used as a query
 * builder here, never as a migration generator, because §57 requires the schema be
 * written once as plain SQL.
 *
 * Timestamps are ISO-8601 UTC strings rather than Drizzle's `timestamp` mode: D1 stores
 * them as TEXT either way, and keeping them as strings means what the API serializes is
 * exactly what the database holds, with no timezone reinterpretation in between.
 */

const timestamp = (column: string) => text(column);

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);

const updatedAt = () =>
  text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);

// --- Identity & Access (§13.1) -------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    email: text('email'),
    /** PBKDF2-SHA256 hash (§38). Always NULL for students — passwordless by design. */
    password: text('password'),
    role: text('role').$type<UserRole>().notNull(),
    status: text('status').$type<UserStatus>().notNull().default('pending'),
    mustChangePassword: integer('must_change_password', { mode: 'boolean' })
      .notNull()
      .default(false),
    emailVerifiedAt: timestamp('email_verified_at'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_role_index').on(table.role),
    index('users_status_index').on(table.status),
  ],
);

export const counselorProfiles = sqliteTable(
  'counselor_profiles',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    phone: text('phone'),
    employeeNumber: text('employee_number'),
    specialization: text('specialization'),
    bio: text('bio'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('counselor_profiles_user_id_unique').on(table.userId)],
);

export const studentProfiles = sqliteTable(
  'student_profiles',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    firstName: text('first_name').notNull(),
    /** Nullable (v1.2): a mononym is a legitimate name, not a validation error (§16). */
    lastName: text('last_name'),
    birthdate: text('birthdate'),
    gender: text('gender'),
    gradeLevel: text('grade_level'),
    strand: text('strand').$type<Strand>(),
    gwa: real('gwa'),
    mathGrade: real('math_grade'),
    scienceGrade: real('science_grade'),
    englishGrade: real('english_grade'),
    guardianName: text('guardian_name'),
    guardianContact: text('guardian_contact'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('student_profiles_user_id_unique').on(table.userId)],
);

// --- Infrastructure (§13.1 — not part of the 28-table domain count) ------------------

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque bearer token. The plaintext is never stored (§38). */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at'),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('api_tokens_token_hash_unique').on(table.tokenHash),
    index('api_tokens_user_id_index').on(table.userId),
  ],
);

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  email: text('email').primaryKey().notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: createdAt(),
});

// --- Platform (§13.8) ----------------------------------------------------------------

/**
 * Append-only (§13.8). `AuditService` is the sole writer and nothing anywhere issues an
 * UPDATE or DELETE against this table — the immutability is a code rule, since SQLite
 * cannot express it.
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey().notNull(),
    /** Nullable: system actions, and failed joins where no user was ever resolved. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    module: text('module').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    oldValues: text('old_values', { mode: 'json' }).$type<Record<string, unknown>>(),
    newValues: text('new_values', { mode: 'json' }).$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_logs_user_id_index').on(table.userId),
    index('audit_logs_action_index').on(table.action),
    index('audit_logs_created_at_index').on(table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type CounselorProfile = typeof counselorProfiles.$inferSelect;
export type StudentProfile = typeof studentProfiles.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
