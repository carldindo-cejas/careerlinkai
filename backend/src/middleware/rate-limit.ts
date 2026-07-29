import type { User } from '@/db/schema';
import type { Env } from '@/env';
import { API_RATE_LIMIT_WINDOW_SECONDS, apiRateLimitGuard } from '@/lib/auth-guard';
import { apiRateLimitPerMinute } from '@/lib/config';
import { ApiError } from '@/lib/envelope';

/**
 * The general per-user API budget (audit S2, plan P3-4).
 *
 * ## Why this exists when five limiters already do
 *
 * `/auth/login`, `/student-access/join`, the AI endpoints, forgot-password and recommendation
 * regeneration are each throttled by their own `AuthGuardDO` counter. Between them they cover a
 * dozen endpoints out of roughly a hundred. **Everything else had no counter at all** — and the
 * unguarded surface is the cheap, boring, fast one: `/student/assignments`, `/counselor/classes`,
 * `/notifications`, the three dashboards. One signed-in student holding down a refresh key on a
 * screen that costs two D1 reads can spend the account's entire Free-plan day (100,000 requests)
 * while every other endpoint in the system reports itself perfectly healthy.
 *
 * ## Why it is charged inside `authenticate()` rather than mounted as middleware
 *
 * Hono's global `app.use('*', …)` runs **before** the sub-router that owns `authenticate()`, so a
 * global middleware cannot see the user and would have to charge after `next()` — that is, after
 * the request it was supposed to refuse has already run its queries. Mounting a `rateLimit()`
 * middleware on each of the twelve routers instead puts the guarantee in twelve places, which is
 * precisely the shape of the F1/F2 defect class this plan opens by naming: the thirteenth router
 * forgets, nothing fails, and the gap is invisible.
 *
 * `authenticate()` is the single point where a bearer token becomes a `User`. Every authenticated
 * route in the system passes through it, and a route that does not is a route with no user to
 * charge — a much louder bug than a missing limiter.
 *
 * ## What is deliberately *not* covered
 *
 * **Unauthenticated traffic.** A request that fails auth is never charged, so nobody can burn a
 * user's budget without their token, and an anonymous flood is not something a per-user counter can
 * express in the first place. That surface belongs at the edge — Cloudflare WAF rate-limiting
 * rules, which cost no Worker CPU and reject before the Worker is invoked at all. The two are
 * complementary rather than alternatives, and only one of them is in this repository, testable,
 * and reviewable in a pull request. The WAF half is documented as an operational step in
 * DEPLOYMENT.md instead of being asserted here as if it had been done.
 *
 * ## The cost, stated plainly
 *
 * One Durable Object round trip per authenticated request — a subrequest against the free Worker's
 * budget of 50, on top of the two D1 reads `authenticate()` already makes. It is charged even on
 * the request that gets refused, which is the structural disadvantage of limiting inside the Worker
 * instead of in front of it. The alternative is unmeasured, unbounded traffic, and 3 subrequests
 * out of 50 is the cheaper of the two problems.
 */
export async function enforceApiRateLimit(env: Env, user: User): Promise<void> {
  const limit = apiRateLimitPerMinute(env);

  // One atomic check-and-charge (M1's lesson): reading the count and then charging it as two round
  // trips lets concurrent requests both observe `attempts < limit` and both slip through.
  const state = await apiRateLimitGuard(env, user.id).charge(
    limit,
    API_RATE_LIMIT_WINDOW_SECONDS,
  );

  if (state.locked) {
    throw ApiError.tooManyRequests(
      {
        request: [
          `Too many requests. Try again in ${state.retryAfterSeconds} seconds.`,
        ],
      },
      'Too many requests.',
      state.retryAfterSeconds,
    );
  }
}
