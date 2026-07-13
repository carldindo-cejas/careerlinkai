import type { Context } from 'hono';
import type { ZodType } from 'zod';

import type { AppEnv } from '@/env';
import { ApiError } from '@/lib/envelope';

/**
 * Parse a request body against its Zod schema, turning a failure into the §19 error
 * envelope: `422`, message "Validation failed.", and `errors` keyed by field name with an
 * array of messages — the shape `ApiRequestError.fieldError()` on the frontend reads.
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
    const errors: Record<string, string[]> = {};

    for (const issue of result.error.issues) {
      // A schema-level refinement with no path (rare) is reported against the whole form.
      const field = issue.path.length > 0 ? issue.path.join('.') : '_';

      (errors[field] ??= []).push(issue.message);
    }

    throw ApiError.validation(errors);
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
