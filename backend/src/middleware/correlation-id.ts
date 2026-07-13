import { createMiddleware } from 'hono/factory';

import type { AppEnv } from '@/env';

/**
 * A correlation id per request (FULLPLAN §52).
 *
 * An inbound `X-Correlation-Id` is honoured so a frontend or a load test can stitch its
 * own traces together; otherwise one is minted. It is echoed back on the response and put
 * in the context for structured log lines.
 */
export function correlationId() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const id = c.req.header('X-Correlation-Id') ?? crypto.randomUUID();

    c.set('correlationId', id);
    c.header('X-Correlation-Id', id);

    await next();
  });
}
