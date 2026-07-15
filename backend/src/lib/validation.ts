import type { Context } from 'hono';
import type { ZodError, ZodType } from 'zod';

import type { AppEnv } from '@/env';
import { ApiError } from '@/lib/envelope';

/**
 * A Zod failure, keyed by field name with an array of messages — the §19 `errors` shape, and
 * the one `ApiRequestError.fieldError()` on the frontend reads.
 */
export function zodErrors(error: ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    // A schema-level refinement with no path (rare) is reported against the whole form.
    const field = issue.path.length > 0 ? issue.path.join('.') : '_';

    (errors[field] ??= []).push(issue.message);
  }

  return errors;
}

/**
 * Parse a request body against its Zod schema, turning a failure into the §19 error
 * envelope: `422`, message "Validation failed.", and `errors` keyed by field name.
 *
 * Every write endpoint goes through here (§41): a Service never receives an unvalidated
 * payload, and `z.infer<typeof schema>` *is* the type it receives (§17).
 */
export async function parseBody<TSchema extends ZodType>(
  c: Context<AppEnv>,
  schema: TSchema,
): Promise<TSchema['_output']> {
  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    // A malformed or absent JSON body is a bad request, not a field-level failure.
    throw new ApiError(400, 'The request body must be valid JSON.');
  }

  const result = schema.safeParse(body);

  if (!result.success) {
    throw ApiError.validation(zodErrors(result.error));
  }

  return result.data;
}

/**
 * The same contract for the **query string** — `?page=2&per_page=101`.
 *
 * This exists because a bare `schema.parse()` in a route handler throws a raw `ZodError`,
 * which is not an `ApiError`, so `app.onError` cannot recognise it and the caller gets a
 * **500 for what is plainly a validation error**. `per_page=5000` is a client mistake, not a
 * server fault, and it has to answer 422 like every other bad input does.
 *
 * (`app.onError` now also catches a stray `ZodError` as a backstop, so a future `.parse()`
 * written somewhere else can never regress this into a 500 again. This helper is the intended
 * path; that is the net under it.)
 */
export function parseQuery<TSchema extends ZodType>(
  c: Context<AppEnv>,
  schema: TSchema,
  keys: string[],
): TSchema['_output'] {
  const raw: Record<string, string | undefined> = {};

  for (const key of keys) {
    // `undefined` rather than a missing key, so the schema's `.default()` applies.
    raw[key] = c.req.query(key) ?? undefined;
  }

  const result = schema.safeParse(raw);

  if (!result.success) {
    throw ApiError.validation(zodErrors(result.error));
  }

  return result.data;
}

/**
 * The client's IP, for audit entries and the `(class code, IP)` join throttle (§38).
 *
 * `CF-Connecting-IP` is set by the Cloudflare edge and cannot be spoofed by the client on
 * a request that actually reached the Worker; `X-Forwarded-For` is only consulted so local
 * `wrangler dev` and tests have something to assert on.
 */
export function clientIp(c: Context<AppEnv>): string | null {
  return (
    c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? null
  );
}
