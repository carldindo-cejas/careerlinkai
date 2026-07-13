import type { User } from '@/db/schema';

/**
 * The Worker's bindings and vars (FULLPLAN §48).
 *
 * There are no connection strings or credentials anywhere in the application — every
 * Cloudflare service is reached through a binding.
 */
export interface Env {
  // Bindings
  DB: D1Database;
  STORAGE: R2Bucket;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  KV: KVNamespace;
  QUEUE_DEFAULT: Queue;
  QUEUE_AI: Queue;

  // Vars — TOML has no number type for [vars], so numeric config arrives as strings and is
  // parsed at the point of use (see src/lib/config.ts).
  APP_ENV: string;
  FRONTEND_URL: string;
  WORKERS_AI_TEXT_MODEL: string;
  WORKERS_AI_EMBEDDING_MODEL: string;
  STUDENT_JOIN_CODE_TTL_DAYS: string;
  STUDENT_TOKEN_TTL_HOURS: string;
  ASSESSMENT_GENERATION_MAX_QUESTIONS: string;
}

/**
 * Request-scoped values set by middleware and read by handlers.
 *
 * `user` is only ever populated by the `authenticate` middleware, so any handler mounted
 * behind it can read it without a null check via `requireUser()`.
 */
export interface Variables {
  correlationId: string;
  user?: User;
  /** The `api_tokens` row the request authenticated with — logout revokes exactly this one. */
  tokenId?: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: Variables;
}
