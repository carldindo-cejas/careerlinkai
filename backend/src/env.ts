import type { User } from '@/db/schema';
import type { AuthGuardDO } from '@/do/auth-guard';

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
  /**
   * v1.5: caching only. **Nothing security-relevant reads or writes KV any more** — the
   * lockout and join throttle moved into `AUTH_DO` (Phase 4.5, deviation D19), because KV
   * is eventually consistent, allows 1 write/s/key, and the Free plan caps it at 1,000
   * writes/day account-wide.
   */
  KV: KVNamespace;
  /** §38 v1.5 — password derivation and security counters. See `src/do/auth-guard.ts`. */
  AUTH_DO: DurableObjectNamespace<AuthGuardDO>;
  QUEUE_DEFAULT: Queue;
  QUEUE_AI: Queue;
  // Secrets — set with `wrangler secret put`, never in a [vars] block (a platform gate enforces
  // that). This is the **only** credential in the system, and its existence is the one exception
  // to the "no secrets, only bindings" rule the file below used to state without qualification.
  /**
   * Transactional email via Resend (plan P4-2, deviation D7) — **optional, and optional on
   * purpose.**
   *
   * Undefined in local development and throughout the test suite, which is what keeps the suite
   * hermetic: with no key the sender returns `not_configured` before it can reach for the network,
   * so no test can accidentally dial `api.resend.com` even if a stub fails to install.
   *
   * Nothing in the product may branch a *response* on whether this key exists. Its absence degrades
   * password reset to the admin-relay path (C2). See `modules/platform/email-service.ts`.
   */
  RESEND_API_KEY?: string;
  /**
   * The built React app (`frontend/dist`), served by this same Worker.
   *
   * Nothing in `src/` calls it in the normal path and that is by design: `[assets]` in
   * wrangler.toml routes asset requests and the SPA fallback *before* the Worker is invoked, so
   * the fast path for a hashed chunk never runs a line of this code. The binding is declared
   * because the config declares it, and because it is the only way to reach an asset from inside
   * a handler if a future route ever needs to (server-rendering a shell, gating a file behind
   * auth). Absent under `wrangler.test.toml`, which binds no assets — do not reach for it in a
   * code path the suite covers without binding it there first.
   */
  ASSETS: Fetcher;

  // Vars — TOML has no number type for [vars], so numeric config arrives as strings and is
  // parsed at the point of use (see src/lib/config.ts).
  APP_ENV: string;
  FRONTEND_URL: string;
  /**
   * The `from` address on transactional mail (P4-2). A var rather than a constant because the
   * sending domain and the *serving* domain are not the same thing: staging is served from a
   * `workers.dev` subdomain, which Resend cannot verify, so every scope sends from the one domain
   * that is verified — `careerlinkai.online`. Resend's free tier allows exactly one domain, which
   * makes that a hard constraint rather than a convention.
   */
  EMAIL_FROM: string;
  WORKERS_AI_TEXT_MODEL: string;
  WORKERS_AI_EMBEDDING_MODEL: string;
  STUDENT_JOIN_CODE_TTL_DAYS: string;
  STUDENT_TOKEN_TTL_HOURS: string;
  STAFF_TOKEN_TTL_HOURS: string;
  ASSESSMENT_GENERATION_MAX_QUESTIONS: string;
  /** Audit S2 / plan P3-4 — the coarse per-user request budget. See `lib/config.ts`. */
  API_RATE_LIMIT_PER_MINUTE: string;
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
