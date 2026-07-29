import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The two standard envelopes (FULLPLAN §19). Every response the API emits — including
 * errors thrown deep inside a Service — leaves through one of these.
 */

export interface SuccessEnvelope<TData> {
  success: true;
  message: string;
  data: TData;
  meta: { timestamp: string };
}

export interface ErrorEnvelope {
  success: false;
  message: string;
  errors: Record<string, string[]>;
}

export interface Pagination {
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
}

/**
 * A list payload (§19, corrected in v1.4): pagination travels *inside* `data`, alongside
 * the items it describes, while the envelope's `meta` stays reserved for request-level
 * metadata. The frontend's `Paginated<T>` type pins this shape.
 */
export interface PaginatedData<TItem> {
  items: TItem[];
  pagination: Pagination;
}

export function successEnvelope<TData>(data: TData, message: string): SuccessEnvelope<TData> {
  return {
    success: true,
    message,
    data,
    meta: { timestamp: new Date().toISOString() },
  };
}

export function errorEnvelope(
  message: string,
  errors: Record<string, string[]> = {},
): ErrorEnvelope {
  return { success: false, message, errors };
}

export function paginate<TItem>(
  items: TItem[],
  total: number,
  page: number,
  perPage: number,
): PaginatedData<TItem> {
  return {
    items,
    pagination: {
      current_page: page,
      per_page: perPage,
      total,
      last_page: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

/**
 * The one error type Services throw. `app.onError` turns it into the §19 error envelope,
 * so a Service never has to know it is being called over HTTP.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly errors: Record<string, string[]> = {},
    /**
     * Seconds until the caller may retry — rendered as the `Retry-After` response header by
     * `app.onError`, which is the only place in the system that turns an `ApiError` into HTTP.
     *
     * A 429 without it is a 429 the client has to guess at, and clients guess by retrying
     * immediately: the standard header is what lets a caller back off instead of hammering the
     * limiter that just refused it. Carried on the error rather than set at each throw site so
     * every 429 in the system answers the same way (P3-4).
     */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 401 — no token, an invalid token, or rejected credentials. */
  static unauthenticated(message = 'Unauthenticated.'): ApiError {
    return new ApiError(401, message);
  }

  /** 403 — authenticated, but the role, ownership, or category check refused it (§19). */
  static forbidden(message = 'This action is unauthorized.'): ApiError {
    return new ApiError(403, message);
  }

  /** 404 — the record does not exist, *or* exists but is not yours to see (docs/api §19). */
  static notFound(message = 'Resource not found.'): ApiError {
    return new ApiError(404, message);
  }

  /** 422 — validation failed; `errors` is keyed by field name. */
  static validation(errors: Record<string, string[]>, message = 'Validation failed.'): ApiError {
    return new ApiError(422, message, errors);
  }

  /** 429 — rate limited (§41). `retryAfterSeconds` becomes the `Retry-After` header. */
  static tooManyRequests(
    errors: Record<string, string[]>,
    message = 'Validation failed.',
    retryAfterSeconds?: number,
  ): ApiError {
    return new ApiError(429, message, errors, retryAfterSeconds);
  }

  /**
   * 502 — a Cloudflare service the request depends on refused it (the Queues producer, so far).
   *
   * Distinct from the bare 500 `app.onError` produces for an unplanned throw: this one is
   * *expected* in the sense that the code anticipated it, cleaned up after itself, and can
   * honestly promise the caller that nothing was half-written. "Try again" is sound advice here
   * and is not sound advice for an unknown 500.
   */
  static badGateway(message = 'An upstream service is unavailable.'): ApiError {
    return new ApiError(502, message);
  }
}
