import { eq } from 'drizzle-orm';

import type { Database } from '@/db/client';
import { appSettings, type User } from '@/db/schema';
import { now } from '@/lib/datetime';
import { AuditService } from '@/modules/platform/audit-service';

/**
 * Operator-controlled flags (migration 0034).
 *
 * One table, one row per flag, and **a registry in this file that says which flags exist**. The
 * registry is what makes a generic key/value table safe to use: `get('counselor_signup_enable')`
 * is a type error rather than a read that quietly returns the default forever, and a flag's
 * meaning — its type, its default, and what turning it off actually does — is written down in one
 * place next to the code that reads it.
 *
 * ## Everything fails closed
 *
 * A missing row, an unparseable value and a D1 read that returns nothing all resolve to the flag's
 * declared default, and every default here is the **restrictive** one. That matters because the
 * only flag today decides whether strangers may create accounts that read student results: a
 * failed migration, a truncated table or a typo must leave registration shut, never open.
 */

/**
 * The flags this deployment has. Adding one is a constant here plus nothing else — the table is
 * already generic, so no migration is involved unless the flag needs to exist before its first
 * write (which none do, because a missing row reads as the default).
 */
export const APP_SETTINGS = {
  /**
   * Whether a counselor may register themselves at `/signup`.
   *
   * Off by default and seeded off (migration 0034). On the Cloudflare Free plan with a 100/day
   * Resend allowance shared with password resets, an open registration form is a lever anybody can
   * pull against a budget the whole product depends on — and a verified signup becomes an `active`
   * counselor immediately, with read access to the results of every student in a class it creates.
   */
  counselor_signup_enabled: { type: 'boolean', default: false },
} as const satisfies Record<string, { type: 'boolean'; default: boolean }>;

export type AppSettingKey = keyof typeof APP_SETTINGS;

export const APP_SETTING_KEYS = Object.keys(APP_SETTINGS) as AppSettingKey[];

const MODULE = 'Platform';

/** The stored representation. `'true'` and nothing else is true — see `get`. */
function encode(value: boolean): string {
  return value ? 'true' : 'false';
}

export class SettingsService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  /**
   * Read one flag.
   *
   * Anything that is not exactly `'true'` is false — a missing row, an empty string, `'TRUE'`,
   * `'1'`, a value some future hand-written SQL put there. That is deliberately unforgiving rather
   * than helpful: a permissive parser on a flag that gates account creation turns a typo in a
   * `wrangler d1 execute` into open registration, and the cost of being strict is that an operator
   * who edits the row by hand has to write the word exactly.
   */
  async get(key: AppSettingKey): Promise<boolean> {
    const row = await this.db.query.appSettings.findFirst({
      where: eq(appSettings.key, key),
    });

    if (row === undefined) {
      return APP_SETTINGS[key].default;
    }

    return row.value === 'true';
  }

  /** Every flag at once, for the admin screen. */
  async all(): Promise<Record<AppSettingKey, boolean>> {
    const rows = await this.db.select().from(appSettings);
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    return Object.fromEntries(
      APP_SETTING_KEYS.map((key) => [
        key,
        stored.has(key) ? stored.get(key) === 'true' : APP_SETTINGS[key].default,
      ]),
    ) as Record<AppSettingKey, boolean>;
  }

  /**
   * Write one flag, and record who wrote it.
   *
   * Upserted rather than updated: the seeded row is an optimisation, not a precondition, and a
   * deployment whose seed failed must still be settable. The audit row carries both the old and the
   * new value, because "registration was open between 2pm and 5pm" is the question this log exists
   * to answer and the current value cannot answer it.
   */
  async set(
    key: AppSettingKey,
    value: boolean,
    actor: User,
    ipAddress: string | null,
  ): Promise<boolean> {
    const previous = await this.get(key);
    const timestamp = now();

    await this.db
      .insert(appSettings)
      .values({ key, value: encode(value), updatedBy: actor.id, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: encode(value), updatedBy: actor.id, updatedAt: timestamp },
      });

    await this.audit.write({
      action: 'APP_SETTING_UPDATED',
      module: MODULE,
      userId: actor.id,
      targetType: 'app_setting',
      targetId: key,
      oldValues: { [key]: previous },
      newValues: { [key]: value },
      ipAddress,
    });

    return value;
  }
}
