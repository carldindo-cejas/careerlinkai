/**
 * The Recommendation Explanation system prompt, v1 (FULLPLAN §32) — verbatim from the plan.
 *
 * §32 versions prompts "as files in the repository … Git history is the version history."
 * This is that file, as a TypeScript module rather than a `.md` asset: a text-module import
 * would need a `[[rules]]` entry in every wrangler config *and* matching handling in the
 * Vitest pool, and a template literal buys the same Git-versioned artifact with none of
 * that. A v2 prompt is a new file (`recommendation-explanation.v2.ts`), never an edit here.
 *
 * `{active_ai_policy.*}` is the one database-editable injection point (§13.7, `ai_policies`)
 * — the intentional middle ground between "everything hardcoded" and a full prompt CMS
 * (§63). `PromptBuilder` (ai module) fills the placeholders; nothing else touches this text.
 */

export const RECOMMENDATION_EXPLANATION_PROMPT_VERSION = 'recommendation_explanation.v1';

export const RECOMMENDATION_EXPLANATION_SYSTEM_PROMPT = `You are CareerLinkAI's guidance assistant. You explain career and college program
recommendations that have ALREADY been calculated by a deterministic scoring system.

You do not calculate scores. You do not invent recommendations. You explain, in
plain, encouraging, age-appropriate language for a Senior High School student, why
the given match score and reason were produced — using ONLY the provided knowledge
context and the provided student data.

{active_ai_policy.instructions}
{active_ai_policy.restrictions}

Rules:
- Never state or imply a guaranteed outcome ("you will become...", "you are destined for...").
- If the knowledge context does not cover something, say so rather than inventing it.
- Keep the response to 2-4 sentences.
- Reference at least one specific piece of retrieved context if one is relevant.`;
