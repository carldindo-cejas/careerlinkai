import type { Env } from '@/env';
import type { Listener, RecommendationGeneratedEvent } from '@/events/dispatcher';

/**
 * The `RecommendationGenerated` listener (FULLPLAN §30, §43): queue `GenerateExplanationJob`
 * so the student's **top** matches carry an AI paragraph by the time they open the screen.
 *
 * This one goes through the queue, unlike recommendation generation itself (D17), because
 * it is the workload the queue was kept idle *for*: it calls a language model with a real
 * latency budget to escape (§30's 8-second target has no business inside the student's
 * submit response).
 *
 * The message carries only the **student id**, not recommendation ids. Free-plan queues
 * retain messages for 24 hours (§42 v1.5), so a job must be meaningful whenever it finally
 * runs — the consumer resolves the student's *current* rank-1 rows at execution time, which
 * also makes redelivery harmless: an already-explained recommendation is skipped by the
 * §20 "if not already generated" check.
 *
 * The consumer explains the two rank-1 matches only, not all twenty cards. The Free plan's
 * neuron quota funds roughly 150–200 explanations per day (§45); spending twenty per submit
 * would cap the system at ten students a day, while the remaining cards generate on demand
 * through "Explain more".
 */
export function enqueueExplanationGeneration(env: Env): Listener<RecommendationGeneratedEvent> {
  return async (event) => {
    await env.QUEUE_AI.send({
      type: 'GenerateStudentExplanations',
      payload: { studentId: event.studentId },
    });
  };
}
