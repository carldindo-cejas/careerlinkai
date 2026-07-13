import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '@/db/schema';

export type Database = DrizzleD1Database<typeof schema>;

/**
 * The drizzle(env.DB) factory (FULLPLAN §16).
 *
 * Drizzle queries written inside Services are the repository layer — there is no separate
 * Repository class in v1 (§17).
 */
export function createDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema });
}
