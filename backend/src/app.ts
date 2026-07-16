import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

import type { AppEnv } from '@/env';
import { errorEnvelope, successEnvelope, ApiError } from '@/lib/envelope';
import { zodErrors } from '@/lib/validation';
import { correlationId } from '@/middleware/correlation-id';
import {
  adminAssessmentRoutes,
  counselorAssessmentRoutes,
  studentRoutes,
} from '@/modules/assessment/routes';
import { generationRoutes } from '@/modules/ai/generation-routes';
import { adminAiRoutes } from '@/modules/ai/routes';
import { builderRoutes } from '@/modules/assessment/builder-routes';
import { adminRoutes } from '@/modules/catalog/routes';
import { counselorRoutes } from '@/modules/classes/routes';
import { authRoutes } from '@/modules/identity/routes';
import { studentAccessRoutes } from '@/modules/identity/student-access-routes';
import {
  counselorRecommendationRoutes,
  studentRecommendationRoutes,
} from '@/modules/recommendation/routes';

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
  //
  // `origin` is given as a callback because the value lives on the per-request `env`, which
  // a Worker only has inside a request — there is no module-scope config to read it from.
  app.use(
    '*',
    cors({
      // Hono types the callback's context as `Context<any>`, so it is annotated back to the
      // app's own env — otherwise `c.env` is `any` and FRONTEND_URL could be misspelled here
      // without anything noticing.
      origin: (_origin, c: Context<AppEnv>) => c.env.FRONTEND_URL,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Correlation-Id'],
      exposeHeaders: ['X-Correlation-Id'],
      maxAge: 600,
    }),
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
  api.route('/student-access', studentAccessRoutes);
  api.route('/student', studentRoutes);
  api.route('/counselor', counselorRoutes);
  // A second router on the same prefix, on purpose: each module owns its own routes file (§10),
  // so the Assessment module brings its own counselor endpoints rather than the Class module's
  // router growing to import three modules' services.
  api.route('/counselor', counselorAssessmentRoutes);
  // …and a third. Phase 4's Recommendation module brings its own routes on both prefixes, for the
  // same reason: the alternative is one god-router that imports every service in the system.
  api.route('/student', studentRecommendationRoutes);
  api.route('/counselor', counselorRecommendationRoutes);
  api.route('/admin', adminRoutes);
  api.route('/admin', adminAssessmentRoutes);
  // Phase 5a: the AI/Knowledge module's own /admin router — same one-module-one-router rule.
  api.route('/admin', adminAiRoutes);
  // Phase 5b: the builder + generation group mounts at the API root — §20 lists it under both
  // /admin and /counselor with identical shapes, so it is shared surface with a per-record
  // ownership policy, not two prefixed copies of one resource.
  api.route('/', builderRoutes);
  api.route('/', generationRoutes);

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

    /**
     * A `ZodError` that reached here escaped a bare `schema.parse()` rather than going
     * through `parseBody`/`parseQuery`. It is still a *validation* failure, and answering
     * 500 to `?per_page=5000` would blame the server for the client's typo — so it is
     * translated into the same 422 envelope the intended path produces.
     *
     * This is a net, not the path: new code should use the helpers in `lib/validation.ts`.
     */
    if (error instanceof ZodError) {
      return c.json(errorEnvelope('Validation failed.', zodErrors(error)), 422);
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
