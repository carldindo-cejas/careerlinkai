import type { Database } from '@/db/client';
import type { Env } from '@/env';
import { dispatch, type AssessmentCompletedEvent, type Listener } from '@/events/dispatcher';
import { enqueueExplanationGeneration } from '@/events/enqueue-explanation-generation';
import { RecommendationService } from '@/modules/recommendation/recommendation-service';

/**
 * `DispatchRecommendationGeneration` — the `AssessmentCompleted` listener (FULLPLAN §11, v1.2).
 *
 * This is the seam Step 4 built and left empty on purpose: `AssessmentCompleted` has been firing
 * from `AssessmentAttemptService.submit()` since then, with **zero listeners registered**, because
 * the listener that matters is this one and it is Phase 4.
 *
 * ## Why the both-complete check lives here and not in the event (§11, v1.2)
 *
 * §24 requires `AssessmentCompleted` to fire **once per scored attempt, for every category** —
 * RIASEC, SCCT and CUSTOM alike. "The student finished something" is a fact about the assessment
 * module and is true whatever else the student has or has not done.
 *
 * "The student now has enough for a recommendation" is a fact about the *recommendation* module,
 * and §27 needs **two** results: a RIASEC interest profile and an SCCT career-confidence index.
 * Putting that condition in the event would mean the assessment module knowing what the
 * recommendation engine requires — and it would have to be re-taught every time that changed. So
 * the event says only what happened, and the listener decides whether it cares.
 *
 * The consequence is the ordinary case, not an edge case: a student who has taken RIASEC and not
 * SCCT fires this listener and it correctly does nothing. When the SCCT attempt lands, the same
 * listener fires again and *this* time both results exist. Neither order matters, and neither
 * assessment needs to know it is the second one.
 *
 * ## Why it generates inline rather than enqueueing
 *
 * §11 describes the listener as dispatching a queued `GenerateRecommendationJob`. It runs the
 * generation directly instead — deviation **D17** — and the reason is a measured one: §27 is pure
 * arithmetic over a catalog that is a few hundred rows, and the whole computation is a handful of
 * D1 reads and one batched write. A queue would add a round trip, a second invocation, and an
 * observable window in which the student's result screen exists and their recommendations do not,
 * in exchange for deferring work that takes milliseconds. `queue()` exists and is wired; the first
 * job that genuinely needs it is Phase 5a's AI explanation, which calls a model and *does* have a
 * latency budget worth escaping (§30's 8-second target).
 *
 * **A listener that throws cannot fail the submit.** `dispatch()` catches and logs, and that is
 * deliberate: the scoring is already committed and the student is sitting on the screen waiting
 * for their result. A recommendation engine that is having a bad day must not turn a completed
 * assessment into a 500 — the recommendations can be regenerated; the student's afternoon cannot.
 */
export function dispatchRecommendationGeneration(
  db: Database,
  env: Env,
): Listener<AssessmentCompletedEvent> {
  return async (event) => {
    // A CUSTOM assessment feeds nothing. §27 reads RIASEC and SCCT and nothing else, so a custom
    // instrument completing is not evidence about anything this engine ranks — and returning early
    // here means the common case does not pay for even one query.
    if (event.category !== 'RIASEC' && event.category !== 'SCCT') {
      return;
    }

    // `generateFor` returns null when the *other* result is not there yet. That is the expected
    // outcome of roughly half of all invocations of this listener, and it is not an error.
    const generated = await new RecommendationService(db).generateFor(event.studentId);

    if (generated !== null) {
      // §60's fourth-to-arrive event. Phase 5a's listener queues the explanation job (§43 —
      // the queue's first real workload); Phase 6 adds the notification listener beside it.
      await dispatch(
        {
          type: 'RecommendationGenerated',
          studentId: event.studentId,
          careers: generated.careers,
          programs: generated.programs,
        },
        [enqueueExplanationGeneration(env)],
      );
    }
  };
}
