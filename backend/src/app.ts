import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type { AppEnv } from '@/env';
import { errorEnvelope, successEnvelope, ApiError } from '@/lib/envelope';
import { correlationId } from '@/middleware/correlation-id';
import { authRoutes } from '@/modules/identity/routes';

/**
 * Hono app assembly (FULLPLAN §16, §17): the /api/v1 mount, global middleware, and the one
 * place an error becomes the §19 error envelope.
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', correlationId());

  // CORS is restricted to the known frontend origin for this environment (§41). The origin
  // comes from FRONTEND_URL rather than a wildcard because the bearer token is held by the
  // frontend and every endpoint here is credentialed.
  app.use('*', (c, next) =>
    cors({
      origin: c.env.FRONTEND_URL,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Correlation-Id'],
      exposeHeaders: ['X-Correlation-Id'],
      maxAge: 600,
    })(c, next),
  );

  const api = new Hono<AppEnv>();

  /** §53 — the CI smoke test and the Cloudflare health check both hit this. */
  api.get('/health', (c) =>
    c.json(
      successEnvelope(
        { status: 'ok', environment: c.env.APP_ENV, version: 'v1' },
        'Service is healthy.',
      ),
    ),
  );

  api.route('/auth', authRoutes);

  app.route('/api/v1', api);

  app.notFound((c) => c.json(errorEnvelope('Resource not found.'), 404));

  /**
   * Every failure leaves through here in the §19 error envelope — a Service throws
   * `ApiError` and never has to know it is being called over HTTP (§17).
   *
   * An unexpected throw becomes a bare 500: the message of an unplanned error is an
   * implementation detail (a SQL string, a stack frame) and belongs in the log, not in a
   * response body. The correlation id is what ties the two together (§52).
   */
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(errorEnvelope(error.message, error.errors), error.status);
    }

    if (error instanceof HTTPException) {
      return c.json(errorEnvelope(error.message), error.status);
    }

    console.error(
      JSON.stringify({
        level: 'error',
        correlation_id: c.get('correlationId'),
        path: c.req.path,
        method: c.req.method,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );

    return c.json(errorEnvelope('An unexpected error occurred.'), 500);
  });

  return app;
}
